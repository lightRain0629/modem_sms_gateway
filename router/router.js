const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../utils/pool');
const { PHONE_RE } = require('../utils/sms-encoding');
const { fetchAndStore } = require('../utils/inbox-sync');
const { appendLog, updateLog, getLog, listSent, getMetrics } = require('../store/log-store');
const { listReceived } = require('../store/inbox-store');
const {
  createRequest,
  completeRequest,
  getRequest,
  latestDone,
  listRequests,
} = require('../store/ussd-store');
const { sendSMSQueue } = require('../config/bull.config');
const { enqueueUssd } = require('../config/ussd.config');

const router = Router();

// control chars other than \n and \r would corrupt the AT dialogue
const CONTROL_CHARS_RE = /[\x00-\x09\x0B\x0C\x0E-\x1F]/;

function validateSend(req, res, next) {
  const body = req.body || {};
  const to = typeof body.to === 'string' ? body.to.trim() : '';
  const { message, projectName, modem: modemId } = body;

  if (!PHONE_RE.test(to)) {
    return res.status(400).json({
      success: false,
      message: 'to must be a phone number in international format, e.g. +99361234567',
    });
  }
  if (typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ success: false, message: 'Message content is required' });
  }
  if (CONTROL_CHARS_RE.test(message)) {
    return res
      .status(400)
      .json({ success: false, message: 'Message contains unsupported control characters' });
  }
  if (typeof projectName !== 'string' || projectName.trim().length === 0) {
    return res.status(400).json({ success: false, message: 'Project name is required' });
  }
  if (modemId !== undefined && (typeof modemId !== 'string' || !pool.get(modemId))) {
    return res.status(400).json({
      success: false,
      message: `Unknown modem "${modemId}" — available: ${pool.ids().join(', ')}`,
    });
  }

  // Without a pinned modem the job goes round-robin, so the message must fit
  // every modem's limits (drivers differ: zte-http is UCS2-only, 70/67 chars).
  const candidates = modemId ? [pool.get(modemId)] : pool.all();
  const rejected = candidates
    .map((m) => ({ modem: m, info: m.analyzeMessage(message) }))
    .find(({ info }) => !info.ok);
  if (rejected) {
    const { modem, info } = rejected;
    return res.status(400).json({
      success: false,
      message:
        `Message too long for modem "${modem.id}": ${info.length} of max ${info.maxLength} ` +
        `characters (${info.encoding} encoding, up to 3 concatenated SMS)`,
    });
  }

  req.body.to = to;
  next();
}

router.post('/send', validateSend, async (req, res) => {
  const { to, message, projectName, modem } = req.body;
  const logEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    to,
    message,
    projectName,
    ip: req.ip,
    status: 'pending',
    error: null,
    // recorded when actually sent; pinned sends know their modem up front
    modemId: modem ?? null,
  };

  try {
    await appendLog(logEntry);
    await sendSMSQueue.add('send-sms', { to, message, projectName, modem, logId: logEntry.id });
    return res.status(202).json({
      success: true,
      data: { message: 'SMS queued for sending', logId: logEntry.id },
    });
  } catch (err) {
    // the entry may already be persisted as 'pending' — don't leave it
    // claiming an in-flight send that was never enqueued
    await updateLog(logEntry.id, { status: 'failed', error: err.message }).catch(() => {});
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/status/:id', async (req, res) => {
  try {
    const entry = await getLog(req.params.id);
    if (!entry) {
      return res.status(404).json({ success: false, message: 'Log entry not found' });
    }
    return res.json({ success: true, data: entry });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// only plain strings — a repeated query param arrives as an array
const filter = (v) => (typeof v === 'string' ? v : undefined);

router.get('/messages', async (req, res) => {
  const modemId = filter(req.query.modem);
  if (modemId && !pool.get(modemId)) {
    return res.status(400).json({
      success: false,
      message: `Unknown modem "${modemId}" — available: ${pool.ids().join(', ')}`,
    });
  }
  const targets = modemId ? [pool.get(modemId)] : pool.all();

  // Poll every modem even if one fails; a dead stick must not hide the
  // others' inbound messages.
  const results = await Promise.all(
    targets.map(async (m) => {
      try {
        return { modem: m.id, messages: await fetchAndStore(m) };
      } catch (err) {
        return { modem: m.id, error: err.message };
      }
    })
  );

  const messages = results.flatMap((r) => r.messages || []);
  const errors = results.filter((r) => r.error).map(({ modem, error }) => ({ modem, error }));
  if (errors.length === targets.length) {
    // every modem failed — keep the old single-modem error semantics
    return res.status(500).json({ success: false, message: errors[0].error, errors });
  }
  return res.json({ success: true, data: { messages, ...(errors.length ? { errors } : {}) } });
});

// clamp to 1..500 — a negative LIMIT means "unlimited" to SQLite
const parseLimit = (v) => Math.min(Math.max(parseInt(v, 10) || 50, 1), 500);
const parseOffset = (v) => Math.max(parseInt(v, 10) || 0, 0);

router.get('/inbox', async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);
    const messages = await listReceived({
      limit,
      offset,
      modemId: filter(req.query.modem),
      from: filter(req.query.from),
    });
    return res.json({ success: true, data: { messages } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/sent', async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);
    const { messages, total } = await listSent({
      limit,
      offset,
      status: filter(req.query.status),
      projectName: filter(req.query.projectName),
      to: filter(req.query.to),
      modemId: filter(req.query.modem),
    });
    return res.json({ success: true, data: { messages, total, limit, offset } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

function unknownModem(res, modemId) {
  return res.status(400).json({
    success: false,
    message: `Unknown modem "${modemId}" — available: ${pool.ids().join(', ')}`,
  });
}

// Run one USSD session right now (holding the modem mutex), persisting the
// outcome to ussd_requests like the queued path does.
async function runUssdNow(modem, kind) {
  const request = {
    id: crypto.randomUUID(),
    modemId: modem.id,
    kind,
    code: modem.ussdCodes[kind],
    status: 'pending',
    requestedAt: new Date().toISOString(),
  };
  await createRequest(request);
  try {
    const reply = await modem.runUssd(request.code);
    if (!reply) {
      await completeRequest(request.id, { status: 'failed', error: 'No USSD reply' });
      return { balance: null, error: 'No USSD reply', requestId: request.id };
    }
    const done = await completeRequest(request.id, { status: 'done', reply });
    return { balance: reply, checkedAt: done.completedAt, requestId: request.id };
  } catch (err) {
    await completeRequest(request.id, { status: 'failed', error: err.message }).catch(() => {});
    return { balance: null, error: err.message, requestId: request.id };
  }
}

// Last known balance per modem, from the persisted USSD history. ?live=true
// runs the USSD session now instead — slow (20-30s per modem, in parallel)
// and it holds the modem mutex, so queued sends wait behind it.
router.get('/balance', async (req, res) => {
  const modemId = filter(req.query.modem);
  if (modemId && !pool.get(modemId)) return unknownModem(res, modemId);
  const targets = modemId ? [pool.get(modemId)] : pool.all();
  const live = req.query.live === 'true' || req.query.live === '1';

  const entries = await Promise.all(
    targets.map(async (m) => {
      if (!m.supportsUssd) {
        return [m.id, { balance: null, error: `USSD is not supported on the ${m.driver} driver` }];
      }
      if (live) return [m.id, await runUssdNow(m, 'balance')];
      const last = await latestDone(m.id, 'balance');
      return [
        m.id,
        last
          ? { balance: last.reply, checkedAt: last.completedAt, requestId: last.id }
          : {
              balance: null,
              error: 'No stored balance yet — POST /sms/balance/refresh or use ?live=true',
            },
      ];
    })
  );
  return res.json({ success: true, data: { balances: Object.fromEntries(entries) } });
});

// Queue a USSD session per modem and return immediately; poll
// GET /sms/ussd/:id for the outcome.
function queueUssdRefresh(kind) {
  return async (req, res) => {
    const modemId = filter(req.query.modem);
    if (modemId && !pool.get(modemId)) return unknownModem(res, modemId);
    if (modemId && !pool.get(modemId).supportsUssd) {
      return res.status(400).json({
        success: false,
        message: `USSD is not supported on modem "${modemId}" (${pool.get(modemId).driver} driver)`,
      });
    }
    const targets = (modemId ? [pool.get(modemId)] : pool.all()).filter((m) => m.supportsUssd);
    if (targets.length === 0) {
      return res.status(400).json({ success: false, message: 'No USSD-capable modems configured' });
    }

    try {
      const requests = await Promise.all(targets.map((m) => enqueueUssd(m, kind)));
      return res.status(202).json({
        success: true,
        data: {
          message: `${kind} USSD queued`,
          requests: Object.fromEntries(requests.map((r) => [r.modemId, r.id])),
        },
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  };
}

router.post('/balance/refresh', queueUssdRefresh('balance'));
// The tariff reply arrives as SMS (e.g. from 0801, one per active tariff)
// minutes later; the worker sweeps the inbox afterwards, so check
// GET /sms/inbox?from=0801 for the actual plan details.
router.post('/tariff/refresh', queueUssdRefresh('tariff'));

router.get('/ussd', async (req, res) => {
  try {
    const { requests, total } = await listRequests({
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset),
      kind: filter(req.query.kind),
      modemId: filter(req.query.modem),
    });
    return res.json({ success: true, data: { requests, total } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/ussd/:id', async (req, res) => {
  try {
    const request = await getRequest(req.params.id);
    if (!request) {
      return res.status(404).json({ success: false, message: 'USSD request not found' });
    }
    return res.json({ success: true, data: request });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/metrics', async (req, res) => {
  try {
    return res.json({ success: true, data: await getMetrics() });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/health', async (req, res) => {
  const statuses = await Promise.all(
    pool.all().map(async (m) => {
      const ok = m.isConnected() && (await m.ping().catch(() => false));
      return [m.id, ok ? 'connected' : 'unavailable'];
    })
  );
  const modems = Object.fromEntries(statuses);
  const upCount = statuses.filter(([, s]) => s === 'connected').length;
  // Always 200: the API can queue (and later retry) sends while a modem
  // reconnects, so a non-200 would make a load balancer pull a working
  // instance. Monitors that care about the modems should read data.modems.
  return res.json({
    success: true,
    data: {
      status: upCount === statuses.length ? 'ok' : 'degraded',
      // kept for pre-multi-modem monitors that read data.modem
      modem: upCount > 0 ? 'connected' : 'unavailable',
      modems,
    },
  });
});

module.exports = router;
