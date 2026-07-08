/**
 * Serial AT-command modem driver.
 *
 * createSerialModem(config) returns an independent instance so several sticks
 * can run in one process; config:
 *   { id, port, baudRate, smsc, ussdBalanceCode, ussdTariffCode }
 */
const { SerialPort } = require('serialport');
const crypto = require('crypto');
const { analyzeMessage, splitMessage, ucs2Hex, PHONE_RE } = require('./sms-encoding');
const { buildConcatPdus } = require('./pdu');
const createSerializer = require('./serialize');

const RECONNECT_DELAY_MS = 5000;
const CMD_TIMEOUT_MS = 10000;
const SMS_SEND_TIMEOUT_MS = 30000;
const USSD_TIMEOUT_MS = 20000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isTerminalLine(line) {
  return (
    line === 'OK' ||
    line === 'ERROR' ||
    line === 'NO CARRIER' ||
    line.startsWith('+CMS ERROR') ||
    line.startsWith('+CME ERROR')
  );
}

function isErrorLine(line) {
  return line !== 'OK' && isTerminalLine(line);
}

function createSerialModem(config = {}) {
  const id = config.id || 'serial';
  const PORT_PATH = config.port || '/dev/ttyUSB0';
  const BAUD_RATE = parseInt(config.baudRate, 10) || 115200;
  const SMSC = (config.smsc || '').trim();
  const USSD_BALANCE_CODE = config.ussdBalanceCode || '*0800#';
  const USSD_TARIFF_CODE = config.ussdTariffCode || '*0805#';

  // -------------------------------------------------------------------------
  // Connection state
  // -------------------------------------------------------------------------

  let port = null;
  let connected = false;
  let closing = false;
  let reconnectTimer = null;
  let rxBuffer = '';
  let currentCommand = null; // { label, lines, expectPrompt, resolve, reject, timer }
  let urcWaiters = []; // [{ prefix, resolve, timer }]
  let quietUntil = 0; // after a timeout, let the late reply drain before the next command

  function log(...args) {
    console.log(`[modem ${id}]`, ...args);
  }

  function connect() {
    if (closing) return;
    rxBuffer = '';
    port = new SerialPort({ path: PORT_PATH, baudRate: BAUD_RATE, autoOpen: false });

    port.on('data', handleData);
    port.on('error', (err) => log('serial error:', err.message));
    port.on('close', () => {
      connected = false;
      failCurrentCommand(new Error('Serial port closed'));
      log('port closed');
      scheduleReconnect();
    });

    port.open((err) => {
      if (err) {
        log(`cannot open ${PORT_PATH}: ${err.message}`);
        scheduleReconnect();
        return;
      }
      connected = true;
      log(`connected to ${PORT_PATH} @ ${BAUD_RATE}`);
      initModem().catch((e) => log('init failed:', e.message));
    });
  }

  function scheduleReconnect() {
    if (closing || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      log('trying to reconnect...');
      connect();
    }, RECONNECT_DELAY_MS);
  }

  function initModem() {
    return enqueue(async () => {
      await transact({ write: 'AT\r', label: 'AT' });
      await transact({ write: 'ATE0\r', label: 'ATE0' }); // echo off, simplifies parsing
      await transact({ write: 'AT+CMGF=1\r', label: 'CMGF' }); // text mode
      log('initialized (text mode, echo off)');
    });
  }

  // -------------------------------------------------------------------------
  // Low-level response handling
  // -------------------------------------------------------------------------

  function handleData(chunk) {
    rxBuffer += chunk.toString('utf8');

    let idx;
    while ((idx = rxBuffer.search(/\r\n|\n/)) !== -1) {
      const line = rxBuffer.slice(0, idx).trim();
      rxBuffer = rxBuffer.slice(idx).replace(/^\r?\n/, '');
      if (!line) continue;
      handleLine(line);
    }

    // The "> " prompt after AT+CMGS arrives without a newline
    if (currentCommand && currentCommand.expectPrompt && rxBuffer.trimStart().startsWith('>')) {
      rxBuffer = '';
      settleCurrent(null);
    }
  }

  function handleLine(line) {
    // unsolicited result codes someone is explicitly waiting for (e.g. +CUSD)
    for (let i = 0; i < urcWaiters.length; i++) {
      if (line.startsWith(urcWaiters[i].prefix)) {
        const waiter = urcWaiters.splice(i, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(line);
        return;
      }
    }

    if (!currentCommand) {
      log('unsolicited:', line);
      return;
    }

    currentCommand.lines.push(line);
    if (isTerminalLine(line)) {
      if (isErrorLine(line)) {
        settleCurrent(new Error(`Modem responded "${line}" to ${currentCommand.label}`));
      } else {
        settleCurrent(null);
      }
    }
  }

  function settleCurrent(err) {
    const cmd = currentCommand;
    if (!cmd) return;
    currentCommand = null;
    clearTimeout(cmd.timer);
    if (err) cmd.reject(err);
    else cmd.resolve(cmd.lines);
  }

  function failCurrentCommand(err) {
    settleCurrent(err);
    for (const waiter of urcWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
  }

  /**
   * Write to the modem and wait for a terminal response (OK / ERROR / +CMS ERROR)
   * or, when expectPrompt is set, for the "> " SMS body prompt.
   * Must only be called while holding the mutex (via enqueue).
   */
  async function transact({ write, label, timeoutMs = CMD_TIMEOUT_MS, expectPrompt = false }) {
    // After a timeout the previous command's reply may still be in flight; wait
    // it out so the stale lines land as "unsolicited" instead of settling us.
    const quietWait = quietUntil - Date.now();
    if (quietWait > 0) await sleep(quietWait);

    return new Promise((resolve, reject) => {
      if (!connected || !port) {
        return reject(new Error('Modem is not connected'));
      }
      rxBuffer = '';
      currentCommand = {
        label,
        lines: [],
        expectPrompt,
        resolve,
        reject,
        timer: setTimeout(() => {
          currentCommand = null;
          quietUntil = Date.now() + 2000;
          const err = new Error(`Timed out waiting for modem response to ${label}`);
          err.code = 'TIMEOUT';
          reject(err);
        }, timeoutMs),
      };
      port.write(write, (err) => {
        if (err) settleCurrent(new Error(`Serial write failed: ${err.message}`));
      });
    });
  }

  function waitForUrc(prefix, timeoutMs) {
    return new Promise((resolve) => {
      const waiter = {
        prefix,
        resolve,
        timer: setTimeout(() => {
          urcWaiters = urcWaiters.filter((w) => w !== waiter);
          resolve(null);
        }, timeoutMs),
      };
      urcWaiters.push(waiter);
    });
  }

  // The modem is a single shared resource: serialize every AT interaction so
  // queue jobs and HTTP requests never interleave commands on the port.
  const enqueue = createSerializer();

  // -------------------------------------------------------------------------
  // Send / read / USSD
  // -------------------------------------------------------------------------

  /** Submit one message body at the "> " prompt and wait for +CMGS/OK. */
  async function submitBody(atCommand, label, body) {
    try {
      await transact({ write: atCommand, label, expectPrompt: true });
    } catch (err) {
      // ESC cancels a possibly still-open body prompt so the modem
      // doesn't swallow the next AT command as message text
      try { port && port.write('\x1B'); } catch (_) { /* port already gone */ }
      throw err;
    }
    try {
      const lines = await transact({
        write: body + '\x1A', // Ctrl+Z terminates the body
        label: `${label} body`,
        timeoutMs: SMS_SEND_TIMEOUT_MS,
      });
      return lines.find((l) => l.startsWith('+CMGS')) || null;
    } catch (err) {
      // the body was already handed to the modem: a timeout here means the
      // network may still deliver it, so a retry could double-send
      if (err.code === 'TIMEOUT') err.confirmTimeout = true;
      throw err;
    }
  }

  // Single SMS: AT text mode, as before.
  async function sendSingle(to, message, info) {
    await transact({ write: 'AT+CMGF=1\r', label: 'CMGF' });
    if (SMSC) {
      await transact({ write: `AT+CSCA="${SMSC}"\r`, label: 'CSCA' });
    }

    let address = to;
    let body = message;
    if (info.encoding === 'UCS2') {
      await transact({ write: 'AT+CSCS="UCS2"\r', label: 'CSCS' });
      await transact({ write: 'AT+CSMP=17,167,0,8\r', label: 'CSMP' });
      address = ucs2Hex(to);
      body = ucs2Hex(message);
    } else {
      await transact({ write: 'AT+CSCS="GSM"\r', label: 'CSCS' });
      await transact({ write: 'AT+CSMP=17,167,0,0\r', label: 'CSMP' });
    }

    const ref = await submitBody(`AT+CMGS="${address}"\r`, 'CMGS', body);
    return { reference: ref };
  }

  // Concatenated SMS: text mode has no way to attach the UDH concatenation
  // header, so multipart goes through PDU mode. A mid-message failure leaves
  // the parts already sent unassembled on the recipient's phone (they are
  // discarded there); a retry re-sends all parts under a fresh reference.
  async function sendMultipart(to, message, info) {
    const pdus = buildConcatPdus({
      to,
      parts: splitMessage(message),
      encoding: info.encoding,
      ref: crypto.randomInt(256),
      smsc: SMSC || null,
    });

    await transact({ write: 'AT+CMGF=0\r', label: 'CMGF=0' });
    try {
      const refs = [];
      for (const { pdu, length } of pdus) {
        refs.push(await submitBody(`AT+CMGS=${length}\r`, 'CMGS (PDU)', pdu));
      }
      return { reference: refs.filter(Boolean).join('; ') || null };
    } finally {
      // restore text mode for the inbox reader; best effort
      await transact({ write: 'AT+CMGF=1\r', label: 'CMGF=1' }).catch(() => {});
    }
  }

  function runUssd(code) {
    return enqueue(async () => {
      await transact({ write: 'AT+CSCS="GSM"\r', label: 'CSCS' });
      const urc = waitForUrc('+CUSD', USSD_TIMEOUT_MS);
      await transact({ write: `AT+CUSD=1,"${code}",15\r`, label: 'CUSD' });
      const line = await urc;
      log(`ussd ${code} response:`, line || '(no +CUSD reply)');
      return line;
    });
  }

  connect();

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    id,
    driver: 'serial',

    analyzeMessage,

    isConnected: () => connected,

    /** Health probe: plain AT, short timeout. */
    ping: () =>
      enqueue(async () => {
        await transact({ write: 'AT\r', label: 'AT (ping)', timeoutMs: 3000 });
        return true;
      }),

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
        return info.segments === 1
          ? sendSingle(to, message, info)
          : sendMultipart(to, message, info);
      }),

    /**
     * Read all stored messages. If `persist` is given it is awaited with the
     * parsed messages BEFORE they are deleted from the modem — if it throws,
     * nothing is deleted and the messages stay on the SIM for the next read.
     */
    getMessages: (persist) =>
      enqueue(async () => {
        await transact({ write: 'AT+CMGF=1\r', label: 'CMGF' });
        await transact({ write: 'AT+CSCS="GSM"\r', label: 'CSCS' });
        await transact({ write: 'AT+CPMS="SM","SM","SM"\r', label: 'CPMS' });
        const lines = await transact({ write: 'AT+CMGL="ALL"\r', label: 'CMGL', timeoutMs: 15000 });

        // Known limitation: a message body line that is exactly "OK"/"ERROR" is
        // indistinguishable from an AT terminal line and ends the listing early.
        const messages = [];
        const headerRe = /^\+CMGL:\s*(\d+),"([^"]*)","([^"]*)",[^,]*,"?([^"]*)"?/;
        let current = null;
        for (const line of lines) {
          const m = line.match(headerRe);
          if (m) {
            current = {
              index: parseInt(m[1], 10),
              status: m[2],
              from: m[3],
              date: m[4],
              text: '',
            };
            messages.push(current);
          } else if (current && !isTerminalLine(line)) {
            current.text += (current.text ? '\n' : '') + line;
          }
        }

        const result = messages.map(({ index, ...rest }) => rest);
        if (result.length > 0 && persist) {
          await persist(result);
        }

        // Delete only the messages we actually read — never wipe the whole
        // storage, an SMS arriving mid-read would be lost otherwise.
        for (const msg of messages) {
          await transact({ write: `AT+CMGD=${msg.index},0\r`, label: `CMGD ${msg.index}` });
        }

        return result;
      }),

    supportsUssd: true,
    ussdCodes: { balance: USSD_BALANCE_CODE, tariff: USSD_TARIFF_CODE },

    /** Run a USSD session; returns the raw +CUSD line (or null on no reply). */
    runUssd,

    /** Query balance via USSD; returns the raw +CUSD line (or null on no reply). */
    checkBalance: () => runUssd(USSD_BALANCE_CODE),

    close: () =>
      new Promise((resolve) => {
        closing = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        failCurrentCommand(new Error('Shutting down'));
        if (port && port.isOpen) port.close(() => resolve());
        else resolve();
      }),
  };
}

module.exports = { createSerialModem };
