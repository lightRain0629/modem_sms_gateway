const { test } = require('node:test');
const assert = require('node:assert');
const { createZteModem, API_PATHS } = require('../utils/zte-http');

test('defaults to the goform api', () => {
  const modem = createZteModem({ id: 'zte', host: '192.168.0.1' });
  assert.strictEqual(modem.driver, 'zte-http');
});

test('accepts api "reqproc" (case-insensitive)', () => {
  assert.ok(createZteModem({ id: 'olax', host: '172.16.0.1', api: 'reqproc' }));
  assert.ok(createZteModem({ id: 'olax', host: '172.16.0.1', api: 'ReqProc' }));
});

test('a blank password does not drag a goform modem into the login flow', () => {
  // empty string is treated as "unset" — goform needs no login, so this must
  // not throw at construction or flip on auth
  assert.ok(createZteModem({ id: 'zte', host: '192.168.0.1', password: '' }));
});

test('rejects an unknown api', () => {
  assert.throws(
    () => createZteModem({ id: 'x', api: 'webcgi' }),
    /Modem "x": unknown zte-http api "webcgi" — use "goform" or "reqproc"/
  );
});

test('both api layouts define get and set paths', () => {
  assert.deepStrictEqual(Object.keys(API_PATHS).sort(), ['goform', 'reqproc']);
  assert.strictEqual(API_PATHS.goform.get, '/goform/goform_get_cmd_process');
  assert.strictEqual(API_PATHS.goform.set, '/goform/goform_set_cmd_process');
  assert.strictEqual(API_PATHS.reqproc.get, '/reqproc/proc_get');
  assert.strictEqual(API_PATHS.reqproc.set, '/reqproc/proc_post');
});
