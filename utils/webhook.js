/**
 * Pure helpers for the delivery-status webhook sender. No I/O, no queue — kept
 * separate from config/webhook.config.js so the signing and validation logic is
 * unit-testable without Redis or a live HTTP server.
 */
const crypto = require('crypto');

// Status transitions the caller acts on. `pending` is never sent (the /send 202
// already told the caller); `retrying` is intermediate and gated behind
// WEBHOOK_SEND_INTERMEDIATE — see shouldNotify.
const TERMINAL_STATUSES = new Set(['sent', 'failed', 'unconfirmed']);

/** Decide whether a status transition should produce a callback. */
function shouldNotify(status, { sendIntermediate = false } = {}) {
  if (TERMINAL_STATUSES.has(status)) return true;
  if (status === 'retrying') return sendIntermediate;
  return false;
}

/**
 * The callback body. Mirrors the sent_messages row + clientRef, kept flat and
 * stable; version via the `event` name if it ever changes.
 * `occurredAt` is stamped at transition time (enqueue), not at POST time.
 */
function buildPayload(entry, { occurredAt, attempt = null } = {}) {
  return {
    event: 'sms.status',
    logId: entry.id,
    clientRef: entry.clientRef ?? null,
    to: entry.to,
    projectName: entry.projectName ?? null,
    status: entry.status,
    reference: entry.reference ?? null,
    modemId: entry.modemId ?? null,
    error: entry.error ?? null,
    sentAt: entry.sentAt ?? null,
    occurredAt,
    attempt,
  };
}

/**
 * HMAC-SHA256 over "<timestamp>.<rawBody>" (hex). The receiver recomputes this
 * over the raw request bytes and the X-Gateway-Timestamp header, and rejects on
 * mismatch or on a stale timestamp (replay protection).
 */
function sign(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/** Parse WEBHOOK_ALLOWED_HOSTS ("a.com, b.com") into a lowercased host set. */
function parseAllowedHosts(env) {
  return new Set(
    String(env || '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Validate a caller-supplied callback URL. Only http(s), and — when an
 * allowlist is configured — the host must be on it, so the gateway can't be
 * turned into an SSRF relay. An empty allowlist means "any host" (logged as a
 * warning at startup).
 */
function isAllowedUrl(url, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (allowedHosts && allowedHosts.size > 0) {
    return allowedHosts.has(parsed.hostname.toLowerCase());
  }
  return true;
}

module.exports = {
  TERMINAL_STATUSES,
  shouldNotify,
  buildPayload,
  sign,
  parseAllowedHosts,
  isAllowedUrl,
};
