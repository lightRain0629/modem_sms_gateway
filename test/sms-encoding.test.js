const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeMessage,
  splitMessage,
  ucs2Hex,
  ucs2Decode,
  GSM7_CODES,
  GSM7_EXT_CODES,
  PHONE_RE,
  MAX_SEGMENTS,
} = require('../utils/sms-encoding');

test('GSM7 code table is complete and correctly offset around ESC', () => {
  assert.equal(GSM7_CODES.size, 127); // 128 codes minus ESC (0x1B)
  assert.equal(GSM7_CODES.get('@'), 0x00);
  assert.equal(GSM7_CODES.get('\n'), 0x0a);
  assert.equal(GSM7_CODES.get('\r'), 0x0d);
  assert.equal(GSM7_CODES.get('Æ'), 0x1c); // first code after the ESC gap
  assert.equal(GSM7_CODES.get(' '), 0x20);
  assert.equal(GSM7_CODES.get('0'), 0x30);
  assert.equal(GSM7_CODES.get('A'), 0x41);
  assert.equal(GSM7_CODES.get('a'), 0x61);
  assert.equal(GSM7_CODES.get('à'), 0x7f);
  assert.equal(GSM7_EXT_CODES.get('€'), 0x65);
});

test('phone regex accepts international numbers and rejects junk', () => {
  assert.ok(PHONE_RE.test('+99361234567'));
  assert.ok(PHONE_RE.test('99361234567'));
  assert.ok(!PHONE_RE.test('+123'));
  assert.ok(!PHONE_RE.test('+9936 1234567'));
  assert.ok(!PHONE_RE.test('abc'));
});

test('GSM7: single-segment boundaries', () => {
  const at160 = analyzeMessage('a'.repeat(160));
  assert.deepEqual(
    { encoding: at160.encoding, segments: at160.segments, ok: at160.ok },
    { encoding: 'GSM', segments: 1, ok: true }
  );
  const at161 = analyzeMessage('a'.repeat(161));
  assert.equal(at161.segments, 2);
  assert.ok(at161.ok);
});

test('GSM7: extension chars cost 2 septets', () => {
  const info = analyzeMessage('€'.repeat(80)); // 160 septets → still one SMS
  assert.equal(info.encoding, 'GSM');
  assert.equal(info.length, 160);
  assert.equal(info.segments, 1);
  const over = analyzeMessage('€'.repeat(81)); // 162 septets
  assert.equal(over.segments, 2);
});

test('GSM7: 3-segment limit', () => {
  assert.ok(analyzeMessage('a'.repeat(459)).ok); // 3 × 153
  assert.equal(analyzeMessage('a'.repeat(459)).segments, 3);
  assert.ok(!analyzeMessage('a'.repeat(460)).ok);
});

test('UCS2: single-segment and 3-segment boundaries', () => {
  const single = analyzeMessage('ы'.repeat(70));
  assert.deepEqual(
    { encoding: single.encoding, segments: single.segments, ok: single.ok },
    { encoding: 'UCS2', segments: 1, ok: true }
  );
  assert.equal(analyzeMessage('ы'.repeat(71)).segments, 2);
  assert.ok(analyzeMessage('ы'.repeat(201)).ok); // 3 × 67
  assert.equal(analyzeMessage('ы'.repeat(201)).segments, 3);
  assert.ok(!analyzeMessage('ы'.repeat(202)).ok);
});

test('splitMessage: single-segment message is returned whole', () => {
  assert.deepEqual(splitMessage('hello'), ['hello']);
  assert.deepEqual(splitMessage('ы'.repeat(70)), ['ы'.repeat(70)]);
});

test('splitMessage: GSM parts stay ≤153 septets and reassemble', () => {
  const msg = 'The quick brown fox jumps over the lazy dog. '.repeat(9); // 414 septets
  const parts = splitMessage(msg);
  assert.equal(parts.join(''), msg);
  assert.ok(parts.length <= MAX_SEGMENTS);
  for (const part of parts) {
    assert.ok(analyzeMessage(part).length <= 153, `part has ${analyzeMessage(part).length} septets`);
  }
});

test('splitMessage: an extension char never straddles a part boundary', () => {
  // 152 single-septet chars, then a 2-septet char right at the boundary
  const msg = 'a'.repeat(152) + '€' + 'b'.repeat(160);
  const parts = splitMessage(msg);
  assert.equal(parts.join(''), msg);
  assert.equal(parts[0], 'a'.repeat(152)); // € pushed to the next part
  for (const part of parts) {
    assert.ok(analyzeMessage(part).length <= 153);
  }
});

test('splitMessage: UCS2 parts stay ≤67 code units and reassemble', () => {
  const msg = 'привет мир '.repeat(15); // 165 code units
  const parts = splitMessage(msg);
  assert.equal(parts.join(''), msg);
  for (const part of parts) {
    assert.ok(part.length <= 67);
  }
});

test('splitMessage: a surrogate pair never splits across parts', () => {
  // 66 chars then an emoji (2 code units) straddling the 67-unit boundary
  const msg = 'ы'.repeat(66) + '😀' + 'ы'.repeat(66);
  const parts = splitMessage(msg);
  assert.equal(parts.join(''), msg);
  assert.equal(parts[0], 'ы'.repeat(66)); // pair pushed whole to part 2
  assert.ok(parts[1].startsWith('😀'));
});

test('ucs2Hex / ucs2Decode round-trip', () => {
  for (const s of ['hello', 'привет', 'Änderung', '']) {
    assert.equal(ucs2Decode(ucs2Hex(s)), s);
  }
  assert.equal(ucs2Hex('пр'), '043F0440'); // UTF-16BE
  assert.equal(ucs2Decode('zznotahex'), '');
  assert.equal(ucs2Decode('04'), ''); // not a multiple of 4 hex digits
});
