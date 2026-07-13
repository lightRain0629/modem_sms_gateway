# Handoff — Delivery-Status Webhooks + Caller Correlation

> **For:** whoever implements delivery-status reporting in this gateway.
> **Goal:** let a caller (GSR-API) learn an SMS's status **without polling** — the gateway
> POSTs each status transition to a caller-supplied URL — and correlate that callback back to
> the caller's own record via a passthrough id.
> **Consumer:** GSR-API's repair-recommendation distribution feature (per-recipient delivery
> timeline). See `DailyReports/docs/repair-recommendation-distribution-analysis.md`.

---

## 0. TL;DR

Add three things, all additive and backward-compatible:

1. **`clientRef`** — an optional passthrough id on `POST /sms/send`, stored on the message row
   and echoed back in every callback. Lets the caller map a callback to its own recipient row
   without a lookup table.
2. **`callbackUrl`** — an optional per-send URL the gateway POSTs to on **every status
   transition** (`sent`, `failed`, `unconfirmed`; optionally `retrying`).
3. **A reliable webhook sender** — signed (HMAC), retried with backoff, idempotent from the
   receiver's side. Reuse BullMQ (already a dependency) so callbacks survive restarts.

**Nothing about the actual send path changes.** Polling (`GET /sms/status/:id`) stays as a
fallback. The status vocabulary is unchanged — see §5 for the hard truth about what each value
means.

---

## 1. What exists today (ground truth)

| Piece | File | Note |
|---|---|---|
| Send endpoint | `router/router.js` `POST /sms/send` (`validateSend` + handler ~line 72) | Builds `logEntry = { id: crypto.randomUUID(), status: 'pending', … }`, `appendLog(logEntry)`, then `sendSMSQueue.add('send-sms', { to, message, projectName, modem, logId })`. Returns `{ data: { logId } }`. |
| Status transitions | `config/bull.config.js` | `worker.on('completed')` → `updateLog(logId, { status:'sent', sentAt, reference, modemId })`. `worker.on('failed')` → `updateLog(logId, { status: unconfirmed ? 'unconfirmed' : isFinal ? 'failed' : 'retrying', error })`. **These two sites are the only places status changes.** |
| DB write chokepoint | `store/log-store.js` `updateLog(id, patch)` | Single function that persists any status change. `PATCHABLE = { status, error, sentAt, reference, modemId }`. |
| Schema | `store/db.js` `sent_messages` | `id, timestamp, to_number, message, project_name, ip, status, error, sent_at, reference, modem_id`. Migrations via `addColumnIfMissing(table, column, ddl)`. |
| Auth | `index.js` | `x-api-key` header **or** `Authorization: Bearer <API_KEY>`, `timingSafeEqual`. |
| Status poll | `router.js` `GET /sms/status/:id` | Returns the `sent_messages` row. Stays as fallback. |

Retries: `attempts: 3`, exponential backoff 10s base (`bull.config.js`). Job retention
`removeOnComplete: 200 / removeOnFail: 500` — **BullMQ jobs are pruned; SQLite is the durable
truth.** The webhook sender must therefore not depend on the send-job still existing.

---

## 2. Change 1 — `clientRef` passthrough

**Why:** the caller wants "this callback is for *my* recipient row #12345" with zero server-side
join. The gateway just stores and echoes it; it never interprets it.

- **`router/router.js` `validateSend`:** accept optional `clientRef` (string, ≤200 chars, trim).
  Reject only if present-and-not-a-string.
- **`/send` handler:** put `clientRef` into `logEntry` and into the job data
  `sendSMSQueue.add('send-sms', { …, logId, clientRef, callbackUrl })`.
- **`store/db.js`:** `addColumnIfMissing('sent_messages', 'client_ref', 'client_ref TEXT')`.
- **`store/log-store.js`:** add `clientRef → client_ref` to the INSERT column list, to `toEntry`,
  and (optionally) to `FILTERS` so `GET /sms/sent?clientRef=…` works for reconciliation.
- **Response unchanged** (still returns `logId`); `clientRef` also surfaces in `GET /status/:id`.

## 3. Change 2 — `callbackUrl`

**Why:** push status to the caller instead of being polled.

- **`validateSend`:** accept optional `callbackUrl` (string). Validate it's a well-formed
  `http(s)` URL. **Recommended:** enforce an allowlist of hosts via env
  (`WEBHOOK_ALLOWED_HOSTS`) so the gateway can't be turned into an SSRF relay.
- **Persist it** so a callback can still be sent after a restart: store on the row
  (`addColumnIfMissing('sent_messages', 'callback_url', 'callback_url TEXT')`) and/or carry it in
  job data. Storing on the row is safer (survives job pruning).
- **Fallback:** if `callbackUrl` is omitted, fall back to a global `WEBHOOK_DEFAULT_URL` env (if
  set), else no webhook for that message.

## 4. Change 3 — the webhook sender (reliable, signed, idempotent)

**Fire on every status transition.** The clean insertion point is a single helper called from
`store/log-store.js:updateLog` right after a successful status write (so you catch all
transitions in one place), **or** from the two `bull.config.js` handlers. Prefer wrapping it so
the webhook is **enqueued, not sent inline** — never block or fail an SMS send because a
caller's endpoint is down.

### 4.1 Use a BullMQ webhook queue (recommended)
Add a second queue `webhookQueue` (BullMQ is already used). On each transition, enqueue
`{ callbackUrl, payload }`. A `webhookWorker` POSTs it with:
- `attempts: 5`, exponential backoff (e.g. base 15s → ~15s/30s/60s/120s/240s).
- `removeOnComplete: true`, `removeOnFail: 1000` (keep failures for inspection).
- 5s HTTP timeout. Treat non-2xx as a retryable failure; treat a 4xx from the receiver as
  permanent (drop) except 408/429.

This gives at-least-once delivery that survives gateway restarts. The receiver must be
idempotent (it will be — GSR-API MERGEs on `logId`+`status`).

### 4.2 Callback payload
POST JSON to `callbackUrl`:
```json
{
  "event": "sms.status",
  "logId": "7edf5906-55c5-4b57-b437-1502167c3ed6",
  "clientRef": "distributionRecipient:12345",
  "to": "+99360123456",
  "projectName": "GSR-API",
  "status": "sent",              // pending|retrying|sent|failed|unconfirmed
  "reference": "+CMGS: 12",       // when available (modem ack)
  "modemId": "zte",
  "error": null,                  // populated on failed/unconfirmed
  "sentAt": "2026-07-13T10:00:04.000Z",
  "occurredAt": "2026-07-13T10:00:04.120Z",
  "attempt": 1
}
```
Fields mirror the `sent_messages` row + `clientRef`. Keep it flat and stable; version via the
`event` name if it ever changes.

### 4.3 Signing (auth from the receiver's side)
The receiver must be able to trust the callback. Sign it:
- Add header `X-Gateway-Signature: sha256=<hex HMAC of the raw request body>` using a shared
  secret `WEBHOOK_SIGNING_SECRET` (env).
- Add `X-Gateway-Timestamp` and include it in the signed material (`"<timestamp>.<body>"`) so
  the receiver can reject replays (> a few minutes old).
- The receiver (GSR-API) recomputes the HMAC and rejects on mismatch. Document the exact signing
  string in this file once chosen so both sides agree.

### 4.4 Which transitions to send
- **Always:** `sent`, `failed`, `unconfirmed` (terminal-ish states the caller acts on).
- **Optional:** `retrying` (intermediate; useful for a live timeline but noisier). Gate behind a
  per-send flag or a global env `WEBHOOK_SEND_INTERMEDIATE=false`.
- **Not** `pending` (the `/send` 202 already told the caller that).

---

## 5. The hard truth about status semantics (put this in the API docs)

The webhook does **not** raise the delivery-truth ceiling — it just delivers the existing
statuses in real time. Be explicit with consumers:

| Status | Real meaning | Do NOT interpret as |
|---|---|---|
| `pending` | Row created, queued | — |
| `retrying` | An attempt failed; another scheduled | failure |
| `sent` | **A modem accepted the message** (`+CMGS` ack) | delivered to the handset |
| `failed` | All 3 attempts exhausted (`error` set; empty SIM balance is common) | — |
| `unconfirmed` | Modem ack timed out — **may already be with the network** | failed — **do NOT auto-resend** |

There is **no handset delivery receipt (DLR)** on any driver — the serial driver sets
`AT+CSMP=17,167,…` (first octet `17` = no status-report request). So `delivered`/`read` are
**out of scope for SMS**; the caller's UI must cap SMS at `sent`.

---

## 6. Contract for the caller (GSR-API)

**Send:**
```
POST {GATEWAY}/sms/send
x-api-key: <API_KEY>
Content-Type: application/json

{ "to": "+99360123456", "message": "…", "projectName": "GSR-API",
  "clientRef": "distributionRecipient:12345",
  "callbackUrl": "https://daily.gsr.net/api/sms/callback" }
```
→ `202 { "success": true, "data": { "logId": "<uuid>" } }`  (store `logId` on the recipient row)

**Then:** the gateway POSTs §4.2 to `callbackUrl` on each transition. GSR-API maps by `clientRef`
(preferred) or `logId`, verifies the HMAC (§4.3), and MERGEs the status onto the recipient row.
Polling `GET /sms/status/:logId` remains available as a reconciliation fallback (e.g. a sweep for
rows stuck non-terminal).

---

## 7. Implementation checklist

- [ ] `validateSend`: accept + validate `clientRef`, `callbackUrl` (URL + host allowlist).
- [ ] `/send` handler: thread `clientRef`, `callbackUrl` into `logEntry` + job data.
- [ ] `store/db.js`: `addColumnIfMissing` for `client_ref`, `callback_url`.
- [ ] `store/log-store.js`: include new columns in INSERT / `toEntry` / (optional) `FILTERS`.
- [ ] New `utils/webhook.js` + `webhookQueue`/`webhookWorker` (BullMQ), signing, retries.
- [ ] Hook the enqueue into `updateLog` (or the two `bull.config.js` handlers) — **enqueue, never
      inline**.
- [ ] Env: `WEBHOOK_SIGNING_SECRET`, `WEBHOOK_ALLOWED_HOSTS`, `WEBHOOK_DEFAULT_URL?`,
      `WEBHOOK_SEND_INTERMEDIATE?`.
- [ ] Update `openapi.json`: `SendRequest` gains `clientRef`/`callbackUrl`; document the callback
      payload + signing under a "Webhooks" section; document `SentMessage.clientRef`.
- [ ] Update `README.md` with the callback contract + the status-semantics table (§5).

## 8. Test checklist

- [ ] Send with `callbackUrl` → assert a signed POST arrives on `sent` with correct `clientRef`.
- [ ] Force a `failed` (bad number / no balance) → callback carries `status:"failed"` + `error`.
- [ ] Force `unconfirmed` (modem ack timeout) → callback fires; **no auto-resend** happens.
- [ ] Receiver returns 500 a few times → webhook retries with backoff, then succeeds (idempotent
      on the receiver).
- [ ] Restart the gateway mid-flight → persisted `callback_url` still produces a callback.
- [ ] Bad/HMAC-tampered body → receiver rejects (manual/unit check on the signing helper).
- [ ] Backward-compat: send **without** `clientRef`/`callbackUrl` → behaves exactly as today.

## 9. Open questions (confirm with GSR-API side)

- Signing scheme final shape: HMAC-SHA256 over `"<timestamp>.<rawBody>"`, header
  `X-Gateway-Signature: sha256=<hex>` — agree and freeze it here.
- Do we want `retrying` callbacks in v1, or only terminal states?
- Callback for the **inbound** SMS case (`received_messages`) too, or SMS-send only for now?
- Retention: how long to keep failed webhook jobs for debugging.
