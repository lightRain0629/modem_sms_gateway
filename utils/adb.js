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

function createAdbModem(config = {}) {
  const id = config.id || 'adb';
  const serial = config.serial || null;
  const adbPath = config.adbPath || process.env.ADB_PATH || 'adb';
  const callingPkg = config.callingPackage || DEFAULT_CALLING_PKG;
  const smsTxn = parseInt(config.smsTxnCode, 10) || DEFAULT_SMS_TXN;

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

    // Inbox reading needs READ_SMS (the adb shell lacks it) — no-op so the
    // multi-modem /sms/messages sweep still works for the other modems.
    getMessages: async () => [],

    // No headless USSD over adb.
    checkBalance: async () => null,

    close: async () => {
      closing = true;
      clearInterval(stateTimer);
    },
  };
}

module.exports = { createAdbModem };
