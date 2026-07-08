/**
 * Driver for Android-based USB modems reached over ADB (e.g. the UFI003S,
 * a Qualcomm MSM8916 running Android 4.4.4). Same interface as ./modem.js.
 *
 * These sticks expose no AT serial port and no SMS in their web API, but the
 * ADB shell holds SEND_SMS, so we send through Android's telephony service:
 *   service call isms <txn> s16 <pkg> s16 <dest> s16 <smsc> s16 <text> i32 0 i32 0
 *
 * createAdbModem(config) returns an independent instance; config:
 *   { id, serial, adbPath, callingPackage, smsTxnCode }
 *
 * Limitations (shell lacks READ_SMS and has no headless USSD):
 *   - getMessages() cannot read the inbox → returns [] (a no-op for the pool).
 *   - checkBalance() is unsupported → returns null.
 *   - Delivery is confirmed only to the telephony framework (the binder call
 *     returns cleanly), not end-to-end like the +CMGS / status-poll drivers.
 *   - Multipart is sent as independent messages (no concatenation header), so
 *     a long body arrives as several separate SMS on the handset.
 */
const { execFile } = require('child_process');
const { analyzeMessage, splitMessage, PHONE_RE } = require('./sms-encoding');
const createSerializer = require('./serialize');

const STATE_POLL_MS = 4000;
const ADB_TIMEOUT_MS = 15000;
// KitKat's ISms.sendText takes a leading callingPackage checked by AppOps
// against the caller's UID; com.android.shell owns the adb shell uid (2000).
const DEFAULT_CALLING_PKG = 'com.android.shell';
// ISms$Stub.TRANSACTION_sendText. Stock AOSP 4.4 is 5, but vendor builds that
// insert sendTextWithOptions shift it — the UFI003S uses 6. Override per device.
const DEFAULT_SMS_TXN = 6;

// wrap a value for the device shell in single quotes, escaping embedded quotes
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Optional companion app (android-smsbridge) that grants the inbox capability
// the bare adb shell lacks: it holds READ_SMS/RECEIVE_SMS and appends incoming
// SMS to a file the shell can read. Disabled with `smsBridge: false`.
const DEFAULT_BRIDGE_PKG = 'com.gateway.smsbridge';
const BRIDGE_DIR = '/sdcard/smsbridge';

function createAdbModem(config = {}) {
  const id = config.id || 'adb';
  const serial = config.serial || null;
  const adbPath = config.adbPath || process.env.ADB_PATH || 'adb';
  const callingPkg = config.callingPackage || DEFAULT_CALLING_PKG;
  const smsTxn = parseInt(config.smsTxnCode, 10) || DEFAULT_SMS_TXN;
  const bridgePkg =
    config.smsBridge === false ? null : config.smsBridgePackage || DEFAULT_BRIDGE_PKG;

  function log(...args) {
    console.log(`[adb ${id}]`, ...args);
  }

  // base args always target this specific device when a serial is given
  const baseArgs = serial ? ['-s', serial] : [];

  function adb(args, timeoutMs = ADB_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      execFile(adbPath, [...baseArgs, ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
        if (err) {
          err.message = `adb ${args[0]} failed: ${(stderr || err.message).trim()}`;
          return reject(err);
        }
        resolve(stdout.toString());
      });
    });
  }

  // Reachability is polled in the background so the hot path (worker loop) can
  // read a cached boolean instead of spawning adb on every check.
  let connected = false;
  let closing = false;

  async function refreshState() {
    try {
      const state = (await adb(['get-state'], 5000)).trim();
      connected = state === 'device';
    } catch (_) {
      connected = false;
    }
  }
  refreshState();
  const stateTimer = setInterval(() => {
    if (!closing) refreshState();
  }, STATE_POLL_MS);
  if (stateTimer.unref) stateTimer.unref();

  // one send at a time per device
  const enqueue = createSerializer();

  async function sendOne(to, text) {
    const remote =
      `service call isms ${smsTxn} ` +
      `s16 ${shQuote(callingPkg)} s16 ${shQuote(to)} s16 'null' s16 ${shQuote(text)} ` +
      `i32 0 i32 0`;
    const out = await adb(['shell', remote]);
    // a clean void reply is "Result: Parcel(00000000 '....')"; anything else
    // (an exception parcel, e.g. ffffffff..) means the framework rejected it
    if (!/Parcel\(0+\b/.test(out.replace(/\s+/g, ''))) {
      throw new Error(`SMS not accepted by device (isms reply: ${out.trim().slice(0, 120)})`);
    }
  }

  log(`using ADB driver${serial ? ` for device ${serial}` : ''} (isms txn ${smsTxn})`);

  return {
    id,
    driver: 'adb',

    analyzeMessage,

    isConnected: () => connected,

    ping: async () => {
      await refreshState();
      return connected;
    },

    sendSMS: (to, message) =>
      enqueue(async () => {
        if (!PHONE_RE.test(to)) {
          throw new Error(`Invalid recipient number: ${to}`);
        }
        const info = analyzeMessage(message);
        if (!info.ok) {
          throw new Error(
            `Message too long: ${info.length}/${info.maxLength} (${info.encoding}, max 3 SMS parts)`
          );
        }
        // Android's ISms.sendText takes one segment; a long body is sent as
        // separate standalone messages (splitMessage sizes each ≤ one SMS).
        const parts = info.segments === 1 ? [message] : splitMessage(message);
        for (const part of parts) {
          await sendOne(to, part);
        }
        return { reference: `adb:sent${parts.length > 1 ? `:${parts.length}parts` : ''}` };
      }),

    // Inbox: the bare adb shell lacks READ_SMS, but the optional smsbridge
    // companion app captures incoming SMS (SMS_RECEIVED reaches any RECEIVE_SMS
    // holder on KitKat) into a file the shell can drain. Without the app this
    // is a no-op ([]), so the multi-modem sweep still serves the other modems.
    getMessages: (persist) =>
      enqueue(async () => {
        if (!bridgePkg || !connected) return [];

        // Fold the live-capture log into a "reading" file (new SMS then start a
        // fresh log) and emit it in one shot. The reading file is deleted only
        // after persist succeeds, so a failed DB write keeps the messages.
        const drain =
          `cd ${BRIDGE_DIR} 2>/dev/null || exit 0; ` +
          `[ -f incoming.jsonl ] && cat incoming.jsonl >> incoming.reading.jsonl && rm -f incoming.jsonl; ` +
          `cat incoming.reading.jsonl 2>/dev/null`;
        const out = await adb(['shell', drain]).catch((e) => {
          log('inbox drain failed:', e.message);
          return '';
        });

        const messages = [];
        for (const line of out.split('\n')) {
          const s = line.trim();
          if (!s) continue;
          try {
            const m = JSON.parse(s);
            messages.push({
              status: 'REC UNREAD',
              from: m.from || '',
              date: m.date ? new Date(m.date).toISOString() : '',
              text: m.text || '',
            });
          } catch (_) {
            /* skip a partially-written line */
          }
        }

        if (messages.length > 0 && persist) {
          await persist(messages); // throws → reading file kept for next drain
        }
        await adb(['shell', `rm -f ${BRIDGE_DIR}/incoming.reading.jsonl`]).catch(() => {});
        return messages;
      }),

    // USSD: the smsbridge app can dial and screen-scrape the reply, but this
    // device registers LTE-only with "CSS not supported", so the network
    // releases every USSD session (UNSOL_ON_USSD mode 2) — it fails at the
    // radio, not in software. Left unsupported so the pool never waits on it.
    supportsUssd: false,
    runUssd: async () => {
      throw new Error('USSD is not supported on the adb driver (this modem has no CS USSD)');
    },
    checkBalance: async () => null,

    close: async () => {
      closing = true;
      clearInterval(stateTimer);
    },
  };
}

module.exports = { createAdbModem };
