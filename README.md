# SMS Gateway (USB GSM Modem)

A small HTTP API that sends and receives SMS through one or more USB GSM modems.

- **Express** — HTTP API with API-key auth
- **BullMQ + Redis** — send queue with automatic retries (3 attempts, exponential backoff)
- **Bull Board** — web dashboard for the queue at `/admin/queues`
- **Multiple modems** in one process (`MODEMS` env): sends are spread round-robin across connected modems, or pinned to one with the `modem` field on `/sms/send`. Three drivers:
  - **serial** — classic AT-command modems on `/dev/ttyUSB*` (serialport, auto-reconnect)
  - **zte-http** — ZTE HiLink/RNDIS sticks (MF823 / M100-3 ...) that expose a web API at `192.168.0.1` instead of a serial port
  - **adb** — Android-based sticks reached over ADB (e.g. UFI003S: a Qualcomm MSM8916 running Android 4.4.4 with no AT port and no SMS in its web API); sends through Android's own SMS service. Inbox reading and USSD balance are unsupported on this driver (the adb shell lacks READ_SMS and there's no headless USSD)
- All modem access is serialized per modem — the queue worker and API requests never talk to the same modem at the same time, while different modems work in parallel
- **SQLite storage** (`gateway.db`, via better-sqlite3): every outbound SMS with its delivery status and the modem that sent it, and every inbound SMS (persisted *before* it is deleted from the modem)
- Per-message delivery status: `pending → sent` or `pending → retrying → failed`
- Messages that don't fit the GSM-7 charset (e.g. Cyrillic) are sent as UCS2 automatically
- Long messages are sent as **concatenated SMS** (up to 3 parts, recipient sees one message): serial driver via PDU mode, zte-http via the firmware's own segmentation
- **USSD subsystem**: balance and tariff codes run through their own queue (a USSD session takes 20–30 s and sometimes never replies), and every session is persisted to the database — `/sms/balance` answers instantly from the last known value, `/sms/ussd` is the full history
- After a message finally fails, the gateway checks the SIM balance via USSD (a common failure cause); the result lands in the USSD history

## Requirements

- Node.js 18+
- Redis running locally (or reachable via env config)
- A USB GSM modem with a SIM card:
  - AT/serial modem (e.g. Huawei E-series) → `MODEM_DRIVER=serial`
  - ZTE HiLink stick (MF823 / M100-3 ...) → `MODEM_DRIVER=zte-http`. If unsure: when the stick creates a network interface (you get a `192.168.0.x` IP) instead of a `/dev/ttyUSB*` device, it's HiLink.

## Setup

1. **Configure environment**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and set at least `API_KEY` (generate with `openssl rand -hex 32`) and `USB_PORT`.

   | Variable | Default | Description |
   |---|---|---|
   | `PORT` | `3000` | HTTP server port |
   | `API_KEY` | — (required) | Key clients must send on every request |
   | `DASHBOARD_USER` / `DASHBOARD_PASSWORD` | (empty) | Login for the queue dashboard at `/admin/queues`; set both or neither. Unset: the dashboard falls back to any username + `API_KEY` as password |
   | `MODEMS` | (empty) | JSON array describing the modem fleet (see below); when set, the four single-modem variables that follow are ignored |
   | `MODEM_DRIVER` | `serial` | single-modem mode: `serial` or `zte-http` |
   | `USB_PORT` | `/dev/ttyUSB0` | serial driver: modem port (`ls /dev/ttyUSB*`) |
   | `BAUD_RATE` | `115200` | serial driver: baud rate |
   | `ZTE_HOST` | `192.168.0.1` | zte-http driver: the stick's web interface address |
   | `SMSC` | (empty) | SMS center number; leave empty to use the SIM's |
   | `USSD_BALANCE_CODE` | `*0800#` | USSD code for the balance check |
   | `USSD_TARIFF_CODE` | `*0805#` | USSD code that makes the carrier SMS back the current tariff plan(s) |
   | `USSD_NUMBER_CODE` | `*222#` | USSD code that returns the SIM's own phone number |
   | `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` / `REDIS_DB` | `127.0.0.1` / `6379` / — / `0` | Redis connection; `REDIS_DB` isolates the queues on a shared Redis |
   | `DB_PATH` | `./gateway.db` | SQLite database file |

   **Multiple modems** — set `MODEMS` to a JSON array; each entry needs a unique `id` and a `driver`, plus the driver's connection settings:

   | Driver | Required | Optional |
   |---|---|---|
   | `serial` | `port` | `baudRate` |
   | `zte-http` | `host` | |
   | `adb` | `serial` (adb device id from `adb devices`) | `adbPath`, `callingPackage`, `smsTxnCode`, `smsBridge` (`false` to disable the inbox companion app), `smsBridgePackage` |

   `smsc`, `ussdBalanceCode`, `ussdTariffCode` and `ussdNumberCode` can be set per modem and default to the global `SMSC`/`USSD_BALANCE_CODE`/`USSD_TARIFF_CODE`/`USSD_NUMBER_CODE`.

   ```bash
   MODEMS=[{"id":"zte","driver":"zte-http","host":"192.168.0.1"},{"id":"ufi","driver":"adb","serial":"32f32221","smsTxnCode":6}]
   ```

   With `MODEMS` unset the gateway runs exactly as before: one modem, built from `MODEM_DRIVER`/`USB_PORT`/`ZTE_HOST`, with the id `default`.

   **adb driver notes:** `adb` must be reachable (on `PATH` or via `ADB_PATH`/`adbPath`) and the device must be USB-debugging-authorized. `smsTxnCode` is the `ISms.sendText` binder transaction code — it varies by build (stock AOSP 4.4 is `5`; the UFI003S is `6` because its firmware inserts extra telephony methods). Find it by disassembling `/system/framework/framework2.jar` (`dexdump -d classes.dex`, look up `ISms$Stub.TRANSACTION_sendText`). The driver sends via `service call isms <code> s16 <callingPackage> s16 <dest> s16 null s16 <text> i32 0 i32 0`.

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Serial port permissions (Linux)** — don't run as root; add your user to the `dialout` group instead:

   ```bash
   sudo usermod -aG dialout $USER
   # log out and back in for it to take effect
   ```

4. **Start**

   ```bash
   npm start
   ```

   On startup you should see `[modem] connected to /dev/ttyUSB0 @ 115200` followed by `[modem] initialized`. If the modem is unplugged the server keeps running and retries the connection every 5 seconds.

## Authentication

Every endpoint requires the API key, sent either way:

```
x-api-key: <API_KEY>
# or
Authorization: Bearer <API_KEY>
```

Requests without a valid key get `401`.

## API

### POST `/sms/send` — queue an SMS

Request body:

```json
{
  "to": "+99360123456",
  "message": "Hello, this is a test SMS.",
  "projectName": "E-Center"
}
```

- `to` — international format, 7–15 digits, optional leading `+`
- `message` — a message longer than one SMS is sent as a concatenated SMS of up to **3 parts** (the recipient sees a single message; the carrier bills one SMS per part). Limits:

  | Driver | Charset | 1 part | max (3 parts) |
  |---|---|---|---|
  | serial | GSM-7 (plain Latin) | 160 | 459 (153/part) |
  | serial | UCS2 (e.g. Cyrillic) | 70 | 201 (67/part) |
  | zte-http | always UCS2 | 70 | 201 (67/part) |
  | adb | GSM-7 / UCS2 (auto) | 160 / 70 | 459 / 201 |

  Concatenated parts are shorter than a single SMS because each part carries a 6-byte concatenation header. Without a pinned `modem`, the message must fit **every** configured modem's limits (round-robin can pick any of them). The **adb** driver sends a multi-part body as several *independent* messages (it has no way to attach the concatenation header), so the recipient sees separate SMS rather than one merged message.
- `projectName` — required, stored in the delivery log
- `modem` — optional modem id; pins the send to that modem instead of round-robin

> **Carrier content filtering:** some operators (observed with TMCell) silently reject messages containing `http` — the send fails at the network with no error detail. Avoid URLs in message bodies.

Response `202 Accepted` (the SMS is queued, not yet sent — poll `/sms/status/:id` for the result):

```json
{
  "success": true,
  "data": { "message": "SMS queued for sending", "logId": "7edf5906-55c5-4b57-b437-1502167c3ed6" }
}
```

Validation errors return `400` with `{ "success": false, "message": "..." }`.

### GET `/sms/status/:logId` — delivery status

```json
{
  "success": true,
  "data": {
    "id": "7edf5906-...",
    "timestamp": "2026-07-06T10:00:00.000Z",
    "to": "+99360123456",
    "message": "Hello",
    "projectName": "E-Center",
    "ip": "::1",
    "status": "sent",
    "sentAt": "2026-07-06T10:00:04.000Z",
    "reference": "+CMGS: 12",
    "modemId": "zte",
    "error": null
  }
}
```

`modemId` is the modem that carried (or last attempted) the message; `null` while the send is still pending on a round-robin job. `status` is one of `pending`, `retrying`, `sent`, `failed`, `unconfirmed`. On `retrying`/`failed`, `error` contains the last modem error. `unconfirmed` means the message was handed to the modem but the confirmation timed out — it is **not retried** (a retry could deliver the SMS twice); check the recipient or the modem before re-sending manually.

### GET `/sms/messages` — fetch new messages from the modems

Reads all SMS stored on every modem's SIM/device (or one modem with `?modem=<id>`), **saves them to the database**, then deletes only the messages that were read (a message arriving during the read is kept for next time; if the DB write fails, nothing is deleted).

```json
{
  "success": true,
  "data": {
    "messages": [
      { "status": "REC UNREAD", "from": "+99360123456", "date": "26/07/06,12:30:00+20", "text": "Hi", "modemId": "zte" }
    ]
  }
}
```

If some (but not all) modems fail to answer, the reply additionally carries `data.errors` (`[{ "modem": "ufi", "error": "..." }]`) alongside the messages from the healthy ones; when every modem fails, the endpoint returns `500`.

### GET `/sms/sent` — browse the delivery log

Query params: `limit` (default 50, max 500), `offset`, and optional equality filters `status`, `projectName`, `to`, `modem`. Newest first; `total` is the count matching the filters. Each entry carries `modemId`.

```json
{
  "success": true,
  "data": {
    "messages": [
      { "id": "7edf5906-...", "timestamp": "2026-07-06T10:00:00.000Z", "to": "+99360123456", "message": "Hello", "projectName": "E-Center", "ip": "::1", "status": "sent", "sentAt": "2026-07-06T10:00:04.000Z", "reference": "+CMGS: 12", "error": null }
    ],
    "total": 128,
    "limit": 50,
    "offset": 0
  }
}
```

### GET `/sms/metrics` — delivery counters

All-time and last-24h totals, broken down by status:

```json
{
  "success": true,
  "data": {
    "total": 128,
    "byStatus": { "sent": 120, "failed": 5, "unconfirmed": 1, "pending": 2 },
    "last24h": { "total": 12, "byStatus": { "sent": 11, "failed": 1 } }
  }
}
```

### GET `/sms/inbox` — browse stored received messages

Query params: `limit` (default 50, max 500), `offset`, optional `modem` and `from` (exact sender number) filters. Newest first.

```json
{
  "success": true,
  "data": {
    "messages": [
      { "id": 3, "from": "+99360123456", "date": "26/07/06/12/30/00/+20", "text": "Hi", "receivedAt": "2026-07-06T12:30:05.000Z", "modemId": "zte" }
    ]
  }
}
```

### GET `/sms/balance` — SIM balance

Returns the newest **persisted** balance per modem (or one modem with `?modem=<id>`) — instant, no modem interaction. `checkedAt` says how fresh it is; queue a refresh when it's too old. With `?live=true` the USSD session runs right now instead (still persisted): **slow** — 20–30 s per modem (queried in parallel) — and it holds the modem lock, so queued sends wait until it finishes.

```json
{
  "success": true,
  "data": {
    "balances": {
      "zte": { "balance": "Balans: 5.20 TMT", "checkedAt": "2026-07-08T10:00:30.000Z", "requestId": "b2f0a1de-..." },
      "ufi": { "balance": null, "error": "USSD is not supported on the adb driver" }
    }
  }
}
```

### POST `/sms/balance/refresh` — queue a balance check

Queues the `USSD_BALANCE_CODE` session on every USSD-capable modem (or one with `?modem=<id>`) and returns `202` immediately with one request id per modem:

```json
{
  "success": true,
  "data": { "message": "balance USSD queued", "requests": { "zte": "b2f0a1de-..." } }
}
```

Poll `GET /sms/ussd/:id` for the outcome; once `done`, `GET /sms/balance` serves the new value. A silent session is retried once after 15 s — safe for USSD, unlike re-sending an SMS.

### POST `/sms/tariff/refresh` — queue a tariff request

Queues the `USSD_TARIFF_CODE` session (default `*0805#`). The USSD reply is only an acknowledgment — the carrier sends the actual plan details **as SMS** a little later (TMCell: from `0801`, one SMS per active tariff). After the session completes, the gateway sweeps that modem's inbox at +30 s / +90 s / +180 s so the SMS land in the database without a manual `/sms/messages` call. Read them with:

```bash
curl "http://localhost:3000/sms/inbox?from=0801" -H "x-api-key: YOUR_API_KEY"
```

### GET `/sms/number` / POST `/sms/number/refresh` — the SIM's own phone number

Same pattern as balance: `GET /sms/number` serves the last persisted `*222#` reply per modem (`?live=true` to run it now), `POST /sms/number/refresh` queues it. Useful when the SIM in a modem is unlabeled.

```json
{
  "success": true,
  "data": {
    "numbers": {
      "zte": { "number": "993XXXXXXXX", "checkedAt": "2026-07-08T10:05:00.000Z", "requestId": "..." },
      "ufi": { "number": null, "error": "USSD is not supported on the adb driver" }
    }
  }
}
```

### GET `/sms/ussd` — USSD request history

Every USSD session ever run — queued refreshes, `?live=true` checks and the automatic post-failure balance checks — newest first. Query params: `limit` (default 50, max 500), `offset`, optional `kind` (`balance`/`tariff`) and `modem` filters. Balance history over time lives here.

### GET `/sms/ussd/:id` — status of one USSD request

```json
{
  "success": true,
  "data": {
    "id": "b2f0a1de-...",
    "modemId": "zte",
    "kind": "balance",
    "code": "*0800#",
    "status": "done",
    "reply": "Balans: 5.20 TMT",
    "error": null,
    "requestedAt": "2026-07-08T10:00:00.000Z",
    "completedAt": "2026-07-08T10:00:30.000Z"
  }
}
```

`status` is `pending` until the session completes, then `done` or `failed`.

### Queue dashboard — `/admin/queues`

Bull Board UI showing waiting/active/delayed/failed jobs, with retry and inspection controls. Open it in a browser and log in with **`DASHBOARD_USER` / `DASHBOARD_PASSWORD`** (HTTP Basic Auth). Keeping these separate from `API_KEY` means dashboard access can be shared or revoked without rotating the key across every client project. When they are unset the dashboard falls back to the legacy login — any username, `API_KEY` as password — and logs a warning on startup.

### API reference — `/docs`

Interactive [Scalar](https://scalar.com) reference for every endpoint, with request/response schemas and a built-in "try it" client (enter the `API_KEY` once under Auth). The docs pages are public — the spec contains no secrets; actual API calls still require the key.

The underlying OpenAPI 3.1 spec is the checked-in [`openapi.json`](openapi.json), also served at `/openapi.json` — import it into Postman/Insomnia or use it for client codegen. The docs page loads the Scalar bundle from its CDN, so the browser viewing it needs internet access; the spec itself is served locally. `npm test` checks the spec stays in sync with the router's routes.

### GET `/sms/health` — health check

Probes every modem (an `AT` command on serial, a status query on zte-http). Always returns `200` — the API can still queue sends while modems reconnect — with the per-modem state in the body:

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "modem": "connected",
    "modems": { "zte": "connected", "ufi": "connected" }
  }
}
```

`status` is `ok` only when every modem is up, `degraded` otherwise. The legacy `data.modem` field stays for older monitors: `connected` while at least one modem is up. Monitors should key on `data.modems`, not the HTTP code.

## Example

```bash
curl -X POST http://localhost:3000/sms/send \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"to": "+99360123456", "message": "Hello from the gateway", "projectName": "E-Center"}'

# then check delivery:
curl http://localhost:3000/sms/status/<logId> -H "x-api-key: YOUR_API_KEY"
```

## How sending works

1. `POST /sms/send` validates the request, writes a `pending` entry to the database, and adds a job to the BullMQ queue.
2. The worker picks a modem for each job — the pinned one if the request set `modem`, otherwise round-robin over connected modems — and runs one send at a time per modem (worker concurrency equals the pool size, so different modems transmit in parallel). On serial that is the AT dialogue: `AT+CMGF=1` → charset/encoding setup → `AT+CMGS` → message body + Ctrl+Z → waits for the modem's `+CMGS`/`OK` confirmation. A multipart message switches to PDU mode (`AT+CMGF=0`) and submits one SMS-SUBMIT PDU per part, all sharing a concatenation reference; the zte-http driver instead hands the full body to the firmware, which segments it itself.
3. On success the log entry becomes `sent` (with the modem's id in `modemId`). On error the job is retried up to 3 times with exponential backoff (10s, 20s, 40s) — an unpinned retry may land on a different modem; after the last failure the entry becomes `failed` and the gateway runs the USSD balance check on the modem that failed.

## Running in production

Use a process manager so the gateway restarts on crashes and boots with the machine, e.g.:

```bash
pm2 start index.js --name sms-gateway
pm2 save
```

Notes:

- Run a single instance only (no pm2 `-i`/cluster mode) — the database and the modems are single-process resources; add modems via `MODEMS`, not extra processes.
- All message history lives in `gateway.db` (SQLite, WAL mode) — back it up by copying the file. A legacy `sent.json` is imported automatically on first start and renamed to `sent.json.imported`.
- The gateway shuts down cleanly on `SIGINT`/`SIGTERM` (closes the queues and the serial port).
- If a send confirmation times out, the job is **not retried** (the message may already be delivered); the log entry is marked `unconfirmed` for manual follow-up.
- After a definitive send failure the SIM balance is checked via USSD, at most once per 10 minutes; the result is persisted in the USSD history (`GET /sms/ussd?kind=balance`).

## Tests

```bash
npm test
```

Unit tests (Node's built-in `node:test`, no extra dependencies) cover the GSM-7/UCS2 encoding analysis and message splitting, the PDU builder (including the classic `hellohello` reference vector), and the SQLite stores against a throwaway database.

## Known limitations

- Serial driver: an inbound SMS containing a line that is exactly `OK` or `ERROR` can end an inbox listing early (AT text mode makes these indistinguishable from response terminators).
- Concatenated SMS is capped at 3 parts (see length limits above).
- Serial driver, multipart: if a part fails mid-message, the parts already sent are never assembled by the recipient's phone (they are eventually discarded); a retry re-sends all parts under a fresh concatenation reference.
- zte-http driver, multipart: relies on the firmware segmenting long bodies (the same mechanism its own web UI uses); verified message-level status comes from the same send-status poll as single SMS.
- adb driver: send-only by default. The delivery status reflects that Android's telephony service *accepted* the message (the binder call returned cleanly), not end-to-end network delivery — there is no `+CMGS`/status poll like the other drivers. Multipart bodies go out as separate, non-concatenated messages. The `smsTxnCode` is build-specific — a wrong value makes every send fail. `/sms/balance` and the other USSD endpoints stay no-ops for adb modems.
  - **Inbox via the companion app**: installing [`android-smsbridge`](android-smsbridge/) gives an adb modem an inbox — it captures incoming SMS (which reach any `RECEIVE_SMS` holder on KitKat) to a file the driver drains in `/sms/messages`. Enabled automatically when the app is present; disable with `"smsBridge": false` on the modem's `MODEMS` entry. See that folder's README for build/install.
  - **USSD stays unsupported on the UFI003S even with the app**: its SIM registers LTE-only with "CSS not supported", so the network releases every USSD session at the radio level. The app's dial-and-screen-scrape mechanism works, but there's nothing for it to capture. Balance/tariff/number are ZTE-only in practice.
