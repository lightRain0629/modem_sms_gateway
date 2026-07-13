const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  shouldNotify,
  buildPayload,
  sign,
  parseAllowedHosts,
  isAllowedUrl,
} = require('../utils/webhook');

test('shouldNotify: terminal states always fire, retrying is gated, pending never', () => {
  for (const s of ['sent', 'failed', 'unconfirmed']) {
    assert.equal(shouldNotify(s), true);
    assert.equal(shouldNotify(s, { sendIntermediate: false }), true);
  }
  assert.equal(shouldNotify('retrying'), false);
  assert.equal(shouldNotify('retrying', { sendIntermediate: true }), true);
  assert.equal(shouldNotify('pending'), false);
  assert.equal(shouldNotify('pending', { sendIntermediate: true }), false);
});

test('buildPayload mirrors the row + clientRef, flat and null-safe', () => {
  const entry = {
    id: 'log-1',
    to: '+99360123456',
    projectName: 'GSR-API',
    status: 'sent',
    reference: '+CMGS: 12',
    modemId: 'zte',
    error: null,
    sentAt: '2026-07-13T10:00:04.000Z',
    clientRef: 'distributionRecipient:12345',
  };
  const payload = buildPayload(entry, { occurredAt: '2026-07-13T10:00:04.120Z', attempt: 1 });
  assert.equal(payload.event, 'sms.status');
  assert.equal(payload.logId, 'log-1');
  assert.equal(payload.clientRef, 'distributionRecipient:12345');
  assert.equal(payload.status, 'sent');
  assert.equal(payload.reference, '+CMGS: 12');
  assert.equal(payload.occurredAt, '2026-07-13T10:00:04.120Z');
  assert.equal(payload.attempt, 1);

  // missing optional fields collapse to null, never undefined (stable JSON)
  const bare = buildPayload({ id: 'x', to: '+1', status: 'failed' }, { occurredAt: 't' });
  assert.equal(bare.clientRef, null);
  assert.equal(bare.reference, null);
  assert.equal(bare.attempt, null);
  assert.ok(!Object.values(bare).includes(undefined));
});

test('sign: HMAC-SHA256 over "<timestamp>.<body>", matches an independent recompute', () => {
  const secret = 'topsecret';
  const ts = 1752400000000;
  const body = JSON.stringify({ event: 'sms.status', logId: 'log-1' });
  const sig = sign(secret, ts, body);

  const expected = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  assert.equal(sig, expected);

  // tampering with the body changes the signature
  assert.notEqual(sig, sign(secret, ts, body + ' '));
  // so does a different timestamp (replay window)
  assert.notEqual(sig, sign(secret, ts + 1, body));
});

test('parseAllowedHosts: trims, lowercases, drops blanks', () => {
  const hosts = parseAllowedHosts(' Daily.GSR.net , hooks.example.com ,, ');
  assert.deepEqual([...hosts].sort(), ['daily.gsr.net', 'hooks.example.com']);
  assert.equal(parseAllowedHosts('').size, 0);
  assert.equal(parseAllowedHosts(undefined).size, 0);
});

test('isAllowedUrl: http(s) only, allowlist enforced when non-empty', () => {
  const allow = parseAllowedHosts('daily.gsr.net');
  assert.equal(isAllowedUrl('https://daily.gsr.net/api/sms/callback', allow), true);
  assert.equal(isAllowedUrl('https://DAILY.gsr.net/x', allow), true); // case-insensitive host
  assert.equal(isAllowedUrl('https://evil.example.com/x', allow), false);
  assert.equal(isAllowedUrl('ftp://daily.gsr.net/x', allow), false);
  assert.equal(isAllowedUrl('not a url', allow), false);

  // empty allowlist → any http(s) host, but still protocol-restricted
  const any = parseAllowedHosts('');
  assert.equal(isAllowedUrl('http://anywhere.test/x', any), true);
  assert.equal(isAllowedUrl('file:///etc/passwd', any), false);
  assert.equal(isAllowedUrl('javascript:alert(1)', any), false);
});
