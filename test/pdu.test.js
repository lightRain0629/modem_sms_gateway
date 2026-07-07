const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildConcatPdus, _encodeAddress, _gsm7Septets, _packSeptets } = require('../utils/pdu');

// reverse of _packSeptets, for round-trip checks
function unpackSeptets(bytes, count, fillBits = 0) {
  const bits = [];
  for (const b of bytes) {
    for (let i = 0; i < 8; i++) bits.push((b >> i) & 1);
  }
  const out = [];
  for (let s = 0; s < count; s++) {
    let v = 0;
    for (let i = 0; i < 7; i++) v |= bits[fillBits + s * 7 + i] << i;
    out.push(v);
  }
  return out;
}

const toHex = (bytes) =>
  bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');

test('septet packing matches the classic "hellohello" reference vector', () => {
  // from the well-known SMS PDU example (to +46708251358)
  assert.equal(toHex(_packSeptets(_gsm7Septets('hellohello'))), 'E8329BFD4697D9EC37');
});

test('address encoding: international, nibble-swapped, F-padded', () => {
  assert.deepEqual(_encodeAddress('+46708251358'), {
    toa: 0x91,
    digits: '6407281553F8',
    digitCount: 11,
  });
  assert.deepEqual(_encodeAddress('12345678'), {
    toa: 0x81, // no '+' → unknown numbering plan
    digits: '21436587',
    digitCount: 8,
  });
});

test('septet packing round-trips with the 1 fill bit used after a UDH', () => {
  const septets = _gsm7Septets('The quick brown fox jumps over the lazy dog €[]');
  for (const fillBits of [0, 1]) {
    const packed = _packSeptets(septets, fillBits);
    assert.deepEqual(unpackSeptets(packed, septets.length, fillBits), septets);
  }
});

test('GSM-7 concatenated PDU has the exact expected layout', () => {
  const [first, second] = buildConcatPdus({
    to: '+99361234567',
    parts: ['abc', 'def'],
    encoding: 'GSM',
    ref: 0x2a,
    smsc: null,
  });
  assert.equal(
    first.pdu,
    '00' + // SMSC: use SIM default
      '51' + // SMS-SUBMIT | UDHI | relative VP
      '00' + // MR assigned by modem
      '0B91' + '9963214365F7' + // DA: 11 digits, international
      '00' + '00' + 'A7' + // PID, DCS=GSM7, VP=24h
      '0A' + // UDL: 7 septets UDH + 3 septets text
      '0500032A0201' + // UDH: concat ref 0x2A, part 1 of 2
      'C2E231' // 'abc' packed with 1 fill bit
  );
  assert.equal(first.length, 23); // TPDU octets, SMSC field excluded
  assert.ok(second.pdu.includes('0500032A0202')); // part 2 of 2, same ref
});

test('UCS2 concatenated PDU uses DCS 08 and UTF-16BE body', () => {
  const [pdu] = buildConcatPdus({
    to: '+99361234567',
    parts: ['ыы'],
    encoding: 'UCS2',
    ref: 1,
    smsc: null,
  });
  assert.equal(
    pdu.pdu,
    '0051000B919963214365F70008A70A050003010101044B044B'
  );
});

test('an explicit SMSC is encoded into the PDU but excluded from the length', () => {
  const [withSmsc] = buildConcatPdus({
    to: '+99361234567',
    parts: ['hi', 'ho'],
    encoding: 'GSM',
    ref: 5,
    smsc: '+99365000501',
  });
  assert.ok(withSmsc.pdu.startsWith('0791' + '9963050005F1'));
  const [without] = buildConcatPdus({
    to: '+99361234567',
    parts: ['hi', 'ho'],
    encoding: 'GSM',
    ref: 5,
    smsc: null,
  });
  assert.equal(withSmsc.length, without.length);
});

test('a full 153-septet part fills UDL to 160 and stays a valid PDU', () => {
  const [pdu] = buildConcatPdus({
    to: '+99361234567',
    parts: ['a'.repeat(153), 'b'.repeat(10)],
    encoding: 'GSM',
    ref: 9,
    smsc: null,
  });
  // octets before UDL: SMSC(1) + first octet(1) + MR(1) + DA len/toa/digits(8) + PID(1) + DCS(1) + VP(1)
  const udlHex = pdu.pdu.slice(2 * 14, 2 * 14 + 2);
  assert.equal(parseInt(udlHex, 16), 160); // 7 (UDH) + 153
  assert.equal(pdu.pdu.length % 2, 0);
});
