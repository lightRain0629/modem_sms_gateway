const { Router } = require('express');
const crypto = require('crypto');
const modem = require('../utils/driver');
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
  const { message, projectName } = body;

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

  const info = modem.analyzeMessage(message);
  if (!info.ok) {
    return res.status(400).json({
      success: false,
      message: `Message too long: ${info.length} of max ${info.maxLength} characters (${info.encoding} encoding, up to 3 concatenated SMS)`,
    });
  }

  req.body.to = to;
  next();
}

router.post('/send', validateSend, async (req, res) => {
  const { to, message, projectName } = req.body;
  const logEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    to,
    message,
    projectName,
    ip: req.ip,
    status: 'pending',
    error: null,
  };

  try {
    await appendLog(logEntry);
    await sendSMSQueue.add('send-sms', { to, message, projectName, logId: logEntry.id });
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

router.get('/messages', async (req, res) => {
  try {
    // saved to the DB before the driver deletes them from the modem
    const messages = await modem.getMessages(saveReceived);
    return res.json({ success: true, data: { messages } });
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.get('/inbox', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const messages = await listReceived({ limit, offset });
    return res.json({ success: true, data: { messages } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/sent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    // only plain strings — a repeated query param arrives as an array
    const filter = (v) => (typeof v === 'string' ? v : undefined);
    const { messages, total } = await listSent({
      limit,
      offset,
      status: filter(req.query.status),
      projectName: filter(req.query.projectName),
      to: filter(req.query.to),
    });
    return res.json({ success: true, data: { messages, total, limit, offset } });
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
  const modemOk = modem.isConnected() && (await modem.ping().catch(() => false));
  // Always 200: the API can queue (and later retry) sends while the modem
  // reconnects, so a non-200 would make a load balancer pull a working
  // instance. Monitors that care about the modem should read data.modem.
  return res.json({
    success: true,
    data: {
      status: modemOk ? 'ok' : 'degraded',
      modem: modemOk ? 'connected' : 'unavailable',
    },
  });
});

module.exports = router;
