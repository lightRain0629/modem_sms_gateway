/**
 * SMS-SUBMIT PDU builder for concatenated (multipart) messages, used by the
 * serial driver: AT text mode cannot attach the UDH concatenation header, so
 * multipart sends switch the modem to PDU mode (AT+CMGF=0).
 */
const { GSM7_CODES, GSM7_EXT_CODES } = require('./sms-encoding');

function hex(n) {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

/** Phone number → { toa, digits } with nibble-swapped, F-padded digits. */
function encodeAddress(number) {
  const international = number.startsWith('+');
  const raw = international ? number.slice(1) : number;
  let swapped = '';
  for (let i = 0; i < raw.length; i += 2) {
    swapped += (raw[i + 1] || 'F') + raw[i];
  }
  return { toa: international ? 0x91 : 0x81, digits: swapped, digitCount: raw.length };
}

/** Text → array of septet codes (extension chars become ESC + code). */
function gsm7Septets(text) {
  const out = [];
  for (const ch of text) {
    if (GSM7_CODES.has(ch)) {
      out.push(GSM7_CODES.get(ch));
    } else if (GSM7_EXT_CODES.has(ch)) {
      out.push(0x1b, GSM7_EXT_CODES.get(ch));
    } else {
      throw new Error(`Character not representable in GSM-7: "${ch}"`);
    }
  }
  return out;
}

/** Pack 7-bit septets into octets (LSB first), skipping `fillBits` bits. */
function packSeptets(septets, fillBits = 0) {
  const out = [];
  let acc = 0;
  let accBits = fillBits;
  for (const s of septets) {
    acc |= s << accBits;
    accBits += 7;
    while (accBits >= 8) {
      out.push(acc & 0xff);
      acc >>= 8;
      accBits -= 8;
    }
  }
  if (accBits > 0) out.push(acc & 0xff);
  return out;
}

function buildSubmitPdu({ to, text, encoding, ref, part, total, smsc }) {
  // SMSC field: 00 = use the SIM's service center
  let smscHex = '00';
  if (smsc) {
    const a = encodeAddress(smsc);
    smscHex = hex(1 + a.digits.length / 2) + hex(a.toa) + a.digits;
  }

  const da = encodeAddress(to);
  // UDH: concatenation IE — reference, total parts, this part (1-based)
  const udhHex = ['05', '00', '03', hex(ref & 0xff), hex(total), hex(part)].join('');

  let udl;
  let udHex;
  if (encoding === 'GSM') {
    const septets = gsm7Septets(text);
    // the 6-octet UDH occupies 7 septets (48 bits + 1 fill bit)
    udl = 7 + septets.length;
    udHex = packSeptets(septets, 1).map(hex).join('');
  } else {
    const body = Buffer.from(text, 'utf16le').swap16();
    udl = 6 + body.length;
    udHex = body.toString('hex').toUpperCase();
  }

  const tpduHex =
    '51' + // SMS-SUBMIT | UDHI | relative validity period
    '00' + // message reference: assigned by the modem
    hex(da.digitCount) +
    hex(da.toa) +
    da.digits +
    '00' + // PID: standard SMS
    (encoding === 'GSM' ? '00' : '08') + // DCS
    'A7' + // validity 24h — matches the text-mode CSMP value 167
    hex(udl) +
    udhHex +
    udHex;

  return { pdu: smscHex + tpduHex, length: tpduHex.length / 2 };
}

/**
 * Build one SMS-SUBMIT PDU per part of a concatenated message.
 * Returns [{ pdu, length }] where `length` is the TPDU octet count for
 * AT+CMGS=<length> (the SMSC field is excluded per spec).
 */
exports.buildConcatPdus = function buildConcatPdus({ to, parts, encoding, ref, smsc }) {
  return parts.map((text, i) =>
    buildSubmitPdu({ to, text, encoding, ref, part: i + 1, total: parts.length, smsc })
  );
};

// exposed for unit tests
exports._encodeAddress = encodeAddress;
exports._gsm7Septets = gsm7Septets;
exports._packSeptets = packSeptets;
