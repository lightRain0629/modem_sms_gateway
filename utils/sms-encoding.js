// Single source of truth for the recipient format — used by the router (400
// response) and both drivers (defensive re-check before touching the modem).
exports.PHONE_RE = /^\+?[0-9]{7,15}$/;

// GSM 03.38 basic charset + extension table (extension chars cost 2 septets)
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€';
const GSM7_BASIC_SET = new Set(GSM7_BASIC);
const GSM7_EXT_SET = new Set(GSM7_EXT);

/**
 * Decide how a message must be encoded and whether it fits in a single SMS:
 * 160 septets for GSM7, 70 UTF-16 code units for UCS2.
 */
exports.analyzeMessage = function analyzeMessage(message) {
  let septets = 0;
  let gsm7 = true;
  for (const ch of message) {
    if (GSM7_BASIC_SET.has(ch)) septets += 1;
    else if (GSM7_EXT_SET.has(ch)) septets += 2;
    else { gsm7 = false; break; }
  }
  if (gsm7) {
    return { encoding: 'GSM', length: septets, maxLength: 160, ok: septets <= 160 };
  }
  const length = message.length;
  return { encoding: 'UCS2', length, maxLength: 70, ok: length <= 70 };
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
