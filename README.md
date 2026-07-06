# SMS Gateway (USB GSM Modem)

A small HTTP API that sends and receives SMS through a USB GSM modem.

- **Express** — HTTP API with API-key auth
- **BullMQ + Redis** — send queue with automatic retries (3 attempts, exponential backoff)
- **Bull Board** — web dashboard for the queue at `/admin/queues`
- Two modem drivers (`MODEM_DRIVER` env):
  - **serial** — classic AT-command modems on `/dev/ttyUSB*` (serialport, auto-reconnect)
  - **zte-http** — ZTE HiLink/RNDIS sticks (MF823 / M100-3 ...) that expose a web API at `192.168.0.1` instead of a serial port
- All modem access is serialized — the queue worker and API requests never talk to the modem at the same time
- Delivery log in `sent.json` with per-message status: `pending → sent` or `pending → retrying → failed`
- Messages that don't fit the GSM-7 charset (e.g. Cyrillic) are sent as UCS2 automatically
- After a message finally fails, the gateway checks the SIM balance via USSD (a common failure cause)

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
   | `MODEM_DRIVER` | `serial` | `serial` or `zte-http` |
   | `USB_PORT` | `/dev/ttyUSB0` | serial driver: modem port (`ls /dev/ttyUSB*`) |
   | `BAUD_RATE` | `115200` | serial driver: baud rate |
   | `ZTE_HOST` | `192.168.0.1` | zte-http driver: the stick's web interface address |
   | `SMSC` | (empty) | SMS center number; leave empty to use the SIM's |
   | `USSD_BALANCE_CODE` | `*0800#` | USSD code for the balance check |
   | `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | `127.0.0.1` / `6379` / — | Redis connection |

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
  "to": "+99361234567",
  "message": "Hello, this is a test SMS.",
  "projectName": "E-Center"
}
```

- `to` — international format, 7–15 digits, optional leading `+`
- `message` — serial driver: max 160 chars for plain GSM text, 70 if it contains non-Latin characters (sent as UCS2); zte-http driver: max 70 chars always (this firmware family sends everything as UCS2)
- `projectName` — required, stored in the delivery log

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
    "to": "+99361234567",
    "message": "Hello",
    "projectName": "E-Center",
    "ip": "::1",
    "status": "sent",
    "sentAt": "2026-07-06T10:00:04.000Z",
    "reference": "+CMGS: 12",
    "error": null
  }
}
```

`status` is one of `pending`, `retrying`, `sent`, `failed`, `unconfirmed`. On `retrying`/`failed`, `error` contains the last modem error. `unconfirmed` means the message was handed to the modem but the confirmation timed out — it is **not retried** (a retry could deliver the SMS twice); check the recipient or the modem before re-sending manually.

### GET `/sms/messages` — read inbox

Reads all SMS stored on the SIM and deletes **only the messages that were read** (a message arriving during the read is kept for next time).

```json
{
  "success": true,
  "data": {
    "messages": [
      { "status": "REC UNREAD", "from": "+99361234567", "date": "26/07/06,12:30:00+20", "text": "Hi" }
    ]
  }
}
```

### Queue dashboard — `/admin/queues`

Bull Board UI showing waiting/active/delayed/failed jobs, with retry and inspection controls. Open it in a browser and log in with **any username** and the **`API_KEY` as password** (HTTP Basic Auth).

### GET `/sms/health` — health check

Probes the modem (an `AT` command on serial, a status query on zte-http). Always returns `200` — the API can still queue sends while the modem reconnects — with the modem state in the body:

```json
{ "success": true, "data": { "status": "ok", "modem": "connected" } }
```

`status` is `degraded` and `modem` is `unavailable` while the modem is down; monitors that care about the modem should key on `data.modem`, not the HTTP code.

## Example

```bash
curl -X POST http://localhost:3000/sms/send \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"to": "+99361234567", "message": "Hello from the gateway", "projectName": "E-Center"}'

# then check delivery:
curl http://localhost:3000/sms/status/<logId> -H "x-api-key: YOUR_API_KEY"
```

## How sending works

1. `POST /sms/send` validates the request, writes a `pending` entry to `sent.json`, and adds a job to the BullMQ queue.
2. The worker takes jobs one at a time (the modem can only do one thing at once) and runs the AT dialogue: `AT+CMGF=1` → charset/encoding setup → `AT+CMGS` → message body + Ctrl+Z → waits for the modem's `+CMGS`/`OK` confirmation.
3. On success the log entry becomes `sent`. On error the job is retried up to 3 times with exponential backoff (10s, 20s, 40s); after the last failure the entry becomes `failed` and the gateway runs the USSD balance check.

## Running in production

Use a process manager so the gateway restarts on crashes and boots with the machine, e.g.:

```bash
pm2 start index.js --name sms-gateway
pm2 save
```

Notes:

- Run a single instance only (no pm2 `-i`/cluster mode) — the delivery log and the modem are single-process resources.
- `sent.json` grows over time; rotate or archive it periodically if you send a lot.
- The gateway shuts down cleanly on `SIGINT`/`SIGTERM` (closes the queue and the serial port).
- If a send confirmation times out, the job is **not retried** (the message may already be delivered); the log entry is marked `unconfirmed` for manual follow-up.
- After a definitive send failure the SIM balance is checked via USSD, at most once per 10 minutes.

## Known limitations

- Serial driver: an inbound SMS containing a line that is exactly `OK` or `ERROR` can end an inbox listing early (AT text mode makes these indistinguishable from response terminators).
- No multipart/concatenated SMS — messages are limited to a single SMS (see length limits above).
