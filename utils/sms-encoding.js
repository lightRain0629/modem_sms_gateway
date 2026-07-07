// Single source of truth for the recipient format — used by the router (400
// response) and both drivers (defensive re-check before touching the modem).
exports.PHONE_RE = /^\+?[0-9]{7,15}$/;

// A message may span up to this many concatenated SMS parts.
const MAX_SEGMENTS = 3;
exports.MAX_SEGMENTS = MAX_SEGMENTS;

// Single-SMS and concatenated-part capacities. Concatenated parts lose room
// to the 6-octet UDH concatenation header: 7 septets in GSM-7, 3 UTF-16
// code units in UCS2.
const GSM7_SINGLE = 160;
const GSM7_PER_SEGMENT = 153;
const UCS2_SINGLE = 70;
const UCS2_PER_SEGMENT = 67;
exports.LIMITS = { GSM7_SINGLE, GSM7_PER_SEGMENT, UCS2_SINGLE, UCS2_PER_SEGMENT };

// GSM 03.38 basic charset laid out by septet code, with ESC (0x1B) omitted —
// codes below 0x1B match the string index, codes above are index + 1.
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

// char → septet code (0x00–0x7F, ESC excluded)
const GSM7_CODES = new Map();
for (let i = 0; i < GSM7_BASIC.length; i++) {
  GSM7_CODES.set(GSM7_BASIC[i], i < 0x1b ? i : i + 1);
}

// extension table: sent as ESC + code, so these chars cost 2 septets
const GSM7_EXT_CODES = new Map([
  ['^', 0x14],
  ['{', 0x28],
  ['}', 0x29],
  ['\\', 0x2f],
  ['[', 0x3c],
  ['~', 0x3d],
  [']', 0x3e],
  ['|', 0x40],
  ['€', 0x65],
]);

exports.GSM7_CODES = GSM7_CODES;
exports.GSM7_EXT_CODES = GSM7_EXT_CODES;

/** Septet cost of one char in GSM-7, or null if it doesn't fit the charset. */
function gsm7Cost(ch) {
  if (GSM7_CODES.has(ch)) return 1;
  if (GSM7_EXT_CODES.has(ch)) return 2;
  return null;
}

/** Greedy split into GSM-7 parts of ≤153 septets, never straddling an
 *  extension char (which costs 2 septets). */
function splitGsm7(message) {
  const parts = [];
  let part = '';
  let septets = 0;
  for (const ch of message) {
    const cost = gsm7Cost(ch);
    if (septets + cost > GSM7_PER_SEGMENT) {
      parts.push(part);
      part = '';
      septets = 0;
    }
    part += ch;
    septets += cost;
  }
  if (part) parts.push(part);
  return parts;
}

/** Split into UCS2 parts of ≤67 UTF-16 code units, never splitting a
 *  surrogate pair. */
function splitUcs2(message) {
  const parts = [];
  let i = 0;
  while (i < message.length) {
    let end = Math.min(i + UCS2_PER_SEGMENT, message.length);
    const code = message.charCodeAt(end - 1);
    if (end < message.length && code >= 0xd800 && code <= 0xdbff) {
      end--; // high surrogate at the boundary — keep the pair together
    }
    parts.push(message.slice(i, end));
    i = end;
  }
  return parts;
}

/**
 * Decide how a message must be encoded and how many SMS parts it needs:
 * GSM-7 — 160 septets single / 153 per concatenated part;
 * UCS2  — 70 UTF-16 code units single / 67 per part. Max 3 parts.
 */
exports.analyzeMessage = function analyzeMessage(message) {
  let septets = 0;
  let gsm7 = true;
  for (const ch of message) {
    const cost = gsm7Cost(ch);
    if (cost === null) {
      gsm7 = false;
      break;
    }
    septets += cost;
  }
  if (gsm7) {
    const segments = septets <= GSM7_SINGLE ? 1 : splitGsm7(message).length;
    return {
      encoding: 'GSM',
      length: septets,
      segments,
      maxLength: GSM7_PER_SEGMENT * MAX_SEGMENTS,
      ok: segments <= MAX_SEGMENTS,
    };
  }
  const length = message.length;
  const segments = length <= UCS2_SINGLE ? 1 : splitUcs2(message).length;
  return {
    encoding: 'UCS2',
    length,
    segments,
    maxLength: UCS2_PER_SEGMENT * MAX_SEGMENTS,
    ok: segments <= MAX_SEGMENTS,
  };
};

/**
 * Split a message into the concatenated-SMS parts analyzeMessage counted.
 * Returns [message] when it fits a single SMS.
 */
exports.splitMessage = function splitMessage(message) {
  const info = exports.analyzeMessage(message);
  if (info.segments === 1) return [message];
  return info.encoding === 'GSM' ? splitGsm7(message) : splitUcs2(message);
};

/** Encode a string as UCS2 (UTF-16BE) hex, as used in AT UCS2 mode and the ZTE HTTP API. */
exports.ucs2Hex = function ucs2Hex(str) {
  return Buffer.from(str, 'utf16le').swap16().toString('hex').toUpperCase();
};

/** Decode a UCS2 (UTF-16BE) hex string; returns '' for empty/invalid input. */
exports.ucs2Decode = function ucs2Decode(hex) {
  if (!hex || typeof hex !== 'string' || hex.length % 4 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    return '';
  }
  return Buffer.from(hex, 'hex').swap16().toString('utf16le');
};
