const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../utils/pool');
const { PHONE_RE } = require('../utils/sms-encoding');
const { appendLog, updateLog, getLog, listSent, getMetrics } = require('../store/log-store');
const { saveReceived, listReceived } = require('../store/inbox-store');
const { sendSMSQueue } = require('../config/bull.config');

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
        // saved to the DB (tagged with the modem id) before the driver
        // deletes them from the modem
        const messages = await m.getMessages((msgs) =>
          saveReceived(msgs.map((x) => ({ ...x, modemId: m.id })))
        );
        return { modem: m.id, messages: messages.map((x) => ({ ...x, modemId: m.id })) };
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
    const messages = await listReceived({ limit, offset, modemId: filter(req.query.modem) });
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

// On-demand USSD balance check. Slow: a USSD session takes 20-30s per modem
// (they run in parallel), and it holds the modem mutex — sends queue behind it.
router.get('/balance', async (req, res) => {
  const modemId = filter(req.query.modem);
  if (modemId && !pool.get(modemId)) {
    return res.status(400).json({
      success: false,
      message: `Unknown modem "${modemId}" — available: ${pool.ids().join(', ')}`,
    });
  }
  const targets = modemId ? [pool.get(modemId)] : pool.all();

  const entries = await Promise.all(
    targets.map(async (m) => {
      try {
        const balance = await m.checkBalance();
        return [m.id, balance ? { balance } : { balance: null, error: 'No USSD reply' }];
      } catch (err) {
        return [m.id, { balance: null, error: err.message }];
      }
    })
  );
  return res.json({ success: true, data: { balances: Object.fromEntries(entries) } });
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
