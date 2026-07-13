/**
 * Delivery-status webhook sender.
 *
 * On every acted-on status transition the gateway POSTs a signed JSON callback
 * to the caller-supplied URL so a caller (e.g. GSR-API) learns an SMS's status
 * without polling. Callbacks go through their own BullMQ queue so a slow or
 * down receiver never blocks — or fails — an SMS send, and so at-least-once
 * delivery survives a gateway restart.
 *
 * The webhook only relays the existing statuses (sent/failed/unconfirmed, and
 * optionally retrying) in real time — it does NOT add handset delivery truth;
 * no driver produces a DLR. See DELIVERY_STATUS_WEBHOOK_HANDOFF.md §5.
 */
const { Queue, Worker } = require('bullmq');
const { WEBHOOKQUEUE } = require('../constants/queue.const');
const { connection } = require('./redis.config');
const {
  shouldNotify,
  buildPayload,
  sign,
  parseAllowedHosts,
  isAllowedUrl,
} = require('../utils/webhook');

const SIGNING_SECRET = process.env.WEBHOOK_SIGNING_SECRET || '';
const DEFAULT_URL = process.env.WEBHOOK_DEFAULT_URL || '';
const SEND_INTERMEDIATE = process.env.WEBHOOK_SEND_INTERMEDIATE === 'true';
const TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS, 10) || 5000;
const ALLOWED_HOSTS = parseAllowedHosts(process.env.WEBHOOK_ALLOWED_HOSTS);

// Warn once at startup about weakened security postures, rather than silently.
if (ALLOWED_HOSTS.size === 0) {
  console.warn(
    '[webhook] WEBHOOK_ALLOWED_HOSTS is empty — callback URLs to any host are ' +
      'accepted (SSRF risk). Set it to a comma-separated allowlist in production.'
  );
}
if (!SIGNING_SECRET) {
  console.warn(
    '[webhook] WEBHOOK_SIGNING_SECRET is not set — callbacks are sent UNSIGNED. ' +
      'Set it so receivers can verify authenticity.'
  );
}

const webhookQueue = new Queue(WEBHOOKQUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 15000 }, // ~15s/30s/60s/120s
    removeOnComplete: true,
    removeOnFail: 1000, // keep failures for inspection in the dashboard
  },
});

webhookQueue.on('error', (err) => {
  console.error('[webhook] redis/queue error:', err.message);
});

/**
 * Enqueue a callback for a status transition. Never throws — a webhook problem
 * must not fail (and re-send) an SMS. Call it AFTER the status row is written,
 * passing the persisted entry (from updateLog's return value) so callback_url
 * and client_ref are present even for a post-restart transition.
 */
async function enqueueWebhook(entry, { attempt = null } = {}) {
  try {
    if (!entry || !entry.status) return;
    if (!shouldNotify(entry.status, { sendIntermediate: SEND_INTERMEDIATE })) return;

    const callbackUrl = entry.callbackUrl || DEFAULT_URL;
    if (!callbackUrl) return; // no per-send URL and no global default → nothing to do

    // Re-check the allowlist at enqueue time too: a URL persisted before the
    // allowlist tightened must not slip through.
    if (!isAllowedUrl(callbackUrl, ALLOWED_HOSTS)) {
      console.warn(
        `[webhook] skipping callback for log ${entry.id}: URL not allowed (${callbackUrl})`
      );
      return;
    }

    const occurredAt = new Date().toISOString();
    const payload = buildPayload(entry, { occurredAt, attempt });
    await webhookQueue.add('deliver', { callbackUrl, payload });
  } catch (err) {
    console.error('[webhook] could not enqueue callback:', err.message);
  }
}

// 4xx from the receiver is a permanent reject (bad request) — dropping it is
// correct; 408/429 are transient and should be retried.
function isPermanent(statusCode) {
  return statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429;
}

const webhookWorker = new Worker(
  WEBHOOKQUEUE,
  async (job) => {
    const { callbackUrl, payload } = job.data;
    const body = JSON.stringify(payload);

    const headers = { 'content-type': 'application/json' };
    if (SIGNING_SECRET) {
      // Sign per attempt so the timestamp stays inside the receiver's replay
      // window even after backoff. The body is stable, so each POST is
      // independently valid.
      const timestamp = Date.now();
      headers['x-gateway-timestamp'] = String(timestamp);
      headers['x-gateway-signature'] = `sha256=${sign(SIGNING_SECRET, timestamp, body)}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(callbackUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      // network error / timeout — retryable
      throw new Error(`callback POST to ${callbackUrl} failed: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      return { status: res.status, logId: payload.logId, event: payload.status };
    }
    if (isPermanent(res.status)) {
      // permanent: log and swallow so BullMQ marks the job completed (not a
      // retryable failure that would churn the backoff)
      console.error(
        `[webhook] callback for log ${payload.logId} rejected ${res.status} (permanent, dropping)`
      );
      return { status: res.status, dropped: true, logId: payload.logId };
    }
    throw new Error(`callback for log ${payload.logId} got ${res.status} (retryable)`);
  },
  { connection, concurrency: 5 }
);

webhookWorker.on('error', (err) => {
  console.error('[webhook] worker error:', err.message);
});

webhookWorker.on('failed', (job, err) => {
  if (!job) {
    console.error('[webhook] job failed:', err.message);
    return;
  }
  console.error(
    `[webhook] job ${job.id} attempt ${job.attemptsMade}/${job.opts.attempts} failed: ${err.message}`
  );
});

module.exports = { webhookQueue, webhookWorker, enqueueWebhook };
