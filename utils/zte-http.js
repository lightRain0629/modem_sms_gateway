/**
 * Driver for ZTE HiLink/RNDIS sticks (MF823 / MF831 / M100-3 ...) that expose
 * a goform HTTP API instead of an AT serial port. Same interface as ./modem.js.
 *
 * createZteModem(config) returns an independent instance; config:
 *   { id, host, ussdBalanceCode, ussdTariffCode }
 */
const http = require('http');
const { ucs2Hex, ucs2Decode, PHONE_RE, MAX_SEGMENTS, LIMITS } = require('./sms-encoding');
const createSerializer = require('./serialize');

const HTTP_TIMEOUT_MS = 5000;
const SEND_POLL_TIMEOUT_MS = 60000;
const USSD_POLL_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 1500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// yy;MM;dd;hh;mm;ss;+tz — the timestamp format the goform SMS API expects
function smsTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  // integer only: half-hour zones (+5:30) would otherwise emit '+5.5'
  const tz = Math.round(-d.getTimezoneOffset() / 60);
  return [
    p(d.getFullYear() % 100), p(d.getMonth() + 1), p(d.getDate()),
    p(d.getHours()), p(d.getMinutes()), p(d.getSeconds()),
  ].join(';') + `;${tz >= 0 ? '+' : ''}${tz}`;
}

// This driver always transmits UCS2 (see sendSMS), so the limits are 70 chars
// for a single SMS and 67 per concatenated part regardless of charset —
// expose that to the validation layer instead of the shared 160-char GSM
// limit this driver can't honor. The firmware splits long bodies into
// concatenated parts itself (same as the stick's own web UI).
function analyzeUcs2(message) {
  const length = message.length;
  const segments =
    length <= LIMITS.UCS2_SINGLE ? 1 : Math.ceil(length / LIMITS.UCS2_PER_SEGMENT);
  return {
    encoding: 'UCS2',
    length,
    segments,
    maxLength: LIMITS.UCS2_PER_SEGMENT * MAX_SEGMENTS,
    ok: segments <= MAX_SEGMENTS,
  };
}

function createZteModem(config = {}) {
  const id = config.id || 'zte';
  const HOST = config.host || '192.168.0.1';
  const BASE = `http://${HOST}`;
  // the goform API rejects requests without a same-origin Referer
  const HEADERS = { Referer: `${BASE}/index.html` };
  const USSD_BALANCE_CODE = config.ussdBalanceCode || '*0800#';
  const USSD_TARIFF_CODE = config.ussdTariffCode || '*0805#';
  const USSD_NUMBER_CODE = config.ussdNumberCode || '*222#';

  function log(...args) {
    console.log(`[zte-http ${id}]`, ...args);
  }

  // The modem's embedded HTTP server sends bare-LF line endings, which Node's
  // fetch (undici) rejects — use http.request with the lenient parser instead.
  function request(method, url, body) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        url,
        {
          method,
          insecureHTTPParser: true,
          headers: {
            ...HEADERS,
            ...(body
              ? {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'Content-Length': Buffer.byteLength(body),
                }
              : {}),
          },
          timeout: HTTP_TIMEOUT_MS,
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode !== 200) {
              return reject(new Error(`Modem HTTP error ${res.statusCode}`));
            }
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Invalid JSON from modem: ${data.slice(0, 100)}`));
            }
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('Modem HTTP request timed out')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  function getCmd(cmds, extra = '') {
    const multi = cmds.includes(',') ? 'multi_data=1&' : '';
    const url = `${BASE}/goform/goform_get_cmd_process?isTest=false&${multi}cmd=${encodeURIComponent(cmds)}${extra}`;
    return request('GET', url);
  }

  async function setCmd(params) {
    const body = new URLSearchParams(params).toString();
    const json = await request('POST', `${BASE}/goform/goform_set_cmd_process`, body);
    if (json.result !== 'success') {
      throw new Error(`Modem rejected ${params.goformId}: ${JSON.stringify(json)}`);
    }
    return json;
  }

  // SMS is a single shared resource on the modem: serialize operations so a
  // queue job and an HTTP request never interleave send/read/delete calls.
  const enqueue = createSerializer();

  function runUssd(code) {
    return enqueue(async () => {
      // clear any stuck session first; the modem answers with empty data otherwise
      try {
        await setCmd({ goformId: 'USSD_PROCESS', USSD_operator: 'ussd_cancel' });
        await sleep(1000);
      } catch (e) { /* no session to cancel */ }

      await setCmd({
        goformId: 'USSD_PROCESS',
        USSD_operator: 'ussd_send',
        USSD_send_number: code,
      });

      const deadline = Date.now() + USSD_POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        // ussd_data is NOT cleared between sessions — it serves the previous
        // reply until the new one lands. ussd_write_flag says which is which:
        // 15 = session in progress, 16 = fresh reply ready, 13 = idle after
        // cancel (flag values observed on the M100-3).
        const { ussd_write_flag: flag } = await getCmd('ussd_write_flag', '');
        if (String(flag) !== '16') continue;
        const info = await getCmd('ussd_data_info', '');
        if (info.ussd_data) {
          const text = ucs2Decode(info.ussd_data) || info.ussd_data;
          log(`ussd ${code} response:`, text);
          return text;
        }
      }
      log(`ussd ${code} response: (no reply)`);
      return null;
    });
  }

  log(`using ZTE HTTP driver at ${BASE}`);

  return {
    id,
    driver: 'zte-http',

    analyzeMessage: analyzeUcs2,

    // reachability is checked per-request; there is no persistent connection
    isConnected: () => true,

    ping: async () => {
      const info = await getCmd('modem_model,sim_status', '');
      return Boolean(info && info.modem_model);
    },

    sendSMS: (to, message) =>
      enqueue(async () => {
        if (!PHONE_RE.test(to)) {
          throw new Error(`Invalid recipient number: ${to}`);
        }
        const info = analyzeUcs2(message);
        if (!info.ok) {
          throw new Error(
            `Message too long: ${info.length}/${info.maxLength} (${info.encoding}, max ${MAX_SEGMENTS} SMS parts)`
          );
        }

        await setCmd({
          goformId: 'SEND_SMS',
          notCallback: 'true',
          Number: to,
          sms_time: smsTime(),
          MessageBody: ucs2Hex(message),
          ID: '-1',
          encode_type: 'UNICODE', // this firmware rejects mixed-case 'Unicode'
        });

        // poll delivery status: 1 = sending, 3 = sent, 2 = failed.
        // A multipart message transmits one SMS per segment — scale the wait.
        const deadline = Date.now() + SEND_POLL_TIMEOUT_MS * info.segments;
        while (Date.now() < deadline) {
          await sleep(POLL_INTERVAL_MS);
          const st = await getCmd('sms_cmd_status_info', '&sms_cmd=4');
          const result = st.sms_cmd_status_result ?? st.sms_cmd_status_info;
          if (result === '3') return { reference: 'zte-http:sent' };
          if (result === '2') throw new Error('Modem reported SMS send failure');
        }
        // SEND_SMS was accepted — the modem may still deliver it, so a retry
        // could double-send
        const err = new Error('Timed out waiting for SMS send confirmation');
        err.confirmTimeout = true;
        throw err;
      }),

    /**
     * Read all inbox messages. If `persist` is given it is awaited with the
     * parsed messages BEFORE they are deleted from the modem — if it throws,
     * nothing is deleted and the messages stay on the device for the next read.
     */
    getMessages: (persist) =>
      enqueue(async () => {
        const data = await getCmd(
          'sms_data_total',
          '&page=0&data_per_page=500&mem_store=1&tags=10&order_by=order+by+id+desc'
        );
        const raw = Array.isArray(data.messages) ? data.messages : [];
        // tag 1 = unread inbox, 0 = read inbox; everything else (2/3 = sent/outbox)
        // stays on the modem. String() because some firmwares return numeric tags.
        const inbox = raw.filter((m) => String(m.tag) === '0' || String(m.tag) === '1');

        const messages = inbox.map((m) => ({
          status: String(m.tag) === '1' ? 'REC UNREAD' : 'REC READ',
          from: m.number,
          date: (m.date || '').replace(/,/g, '/'),
          // fall back to the raw content so an undecodable message is never
          // returned empty and then deleted below
          text: ucs2Decode(m.content) || String(m.content ?? ''),
        }));

        if (messages.length > 0 && persist) {
          await persist(messages);
        }

        // delete only what we actually read
        if (inbox.length > 0) {
          await setCmd({
            goformId: 'DELETE_SMS',
            msg_id: inbox.map((m) => String(m.id)).join(';') + ';',
            notCallback: 'true',
          });
        }

        return messages;
      }),

    supportsUssd: true,
    ussdCodes: { balance: USSD_BALANCE_CODE, tariff: USSD_TARIFF_CODE, number: USSD_NUMBER_CODE },

    /** Run a USSD session; returns the decoded reply text (or null on no reply). */
    runUssd,

    /** Query balance via USSD; returns the decoded reply text (or null on no reply). */
    checkBalance: () => runUssd(USSD_BALANCE_CODE),

    close: async () => {},
  };
}

module.exports = { createZteModem };
