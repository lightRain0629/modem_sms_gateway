const { test } = require('node:test');
const assert = require('node:assert');
const { parseModemConfigs } = require('../utils/modem-config');

test('falls back to legacy single-modem env when MODEMS is unset', () => {
  const configs = parseModemConfigs({
    MODEM_DRIVER: 'zte-http',
    ZTE_HOST: '192.168.0.1',
    SMSC: '+99361000000',
    USSD_BALANCE_CODE: '*0800#',
  });
  assert.strictEqual(configs.length, 1);
  assert.strictEqual(configs[0].id, 'default');
  assert.strictEqual(configs[0].driver, 'zte-http');
  assert.strictEqual(configs[0].host, '192.168.0.1');
  assert.strictEqual(configs[0].smsc, '+99361000000');
  assert.strictEqual(configs[0].ussdBalanceCode, '*0800#');
});

test('legacy fallback defaults to the serial driver', () => {
  const configs = parseModemConfigs({ USB_PORT: '/dev/ttyUSB1' });
  assert.strictEqual(configs[0].driver, 'serial');
  assert.strictEqual(configs[0].port, '/dev/ttyUSB1');
});

test('parses a MODEMS JSON array', () => {
  const configs = parseModemConfigs({
    MODEMS: JSON.stringify([
      { id: 'zte', driver: 'zte-http', host: '192.168.0.1' },
      { id: 'ufi', driver: 'serial', port: '/dev/ttyUSB0', baudRate: 115200 },
    ]),
  });
  assert.strictEqual(configs.length, 2);
  assert.deepStrictEqual(configs.map((c) => c.id), ['zte', 'ufi']);
  assert.strictEqual(configs[1].baudRate, 115200);
});

test('driver name is case-insensitive', () => {
  const configs = parseModemConfigs({
    MODEMS: JSON.stringify([{ id: 'a', driver: 'ZTE-HTTP' }]),
  });
  assert.strictEqual(configs[0].driver, 'zte-http');
});

test('global SMSC/USSD apply only when the entry has none', () => {
  const configs = parseModemConfigs({
    MODEMS: JSON.stringify([
      { id: 'a', driver: 'serial', smsc: '+99361111111' },
      { id: 'b', driver: 'serial' },
    ]),
    SMSC: '+99362222222',
    USSD_BALANCE_CODE: '*100#',
  });
  assert.strictEqual(configs[0].smsc, '+99361111111');
  assert.strictEqual(configs[1].smsc, '+99362222222');
  assert.strictEqual(configs[0].ussdBalanceCode, '*100#');
});

test('rejects invalid JSON', () => {
  assert.throws(() => parseModemConfigs({ MODEMS: '[{"id":' }), /not valid JSON/);
});

test('rejects an empty array', () => {
  assert.throws(() => parseModemConfigs({ MODEMS: '[]' }), /non-empty/);
});

test('rejects duplicate ids', () => {
  assert.throws(
    () =>
      parseModemConfigs({
        MODEMS: JSON.stringify([
          { id: 'a', driver: 'serial' },
          { id: 'a', driver: 'zte-http' },
        ]),
      }),
    /Duplicate modem id "a"/
  );
});

test('rejects a missing or empty id', () => {
  assert.throws(
    () => parseModemConfigs({ MODEMS: JSON.stringify([{ driver: 'serial' }]) }),
    /needs a non-empty string "id"/
  );
});

test('rejects an unknown driver', () => {
  assert.throws(
    () => parseModemConfigs({ MODEMS: JSON.stringify([{ id: 'x', driver: 'huawei' }]) }),
    /unknown driver "huawei"/
  );
});

test('accepts the adb driver and keeps its device fields', () => {
  const configs = parseModemConfigs({
    MODEMS: JSON.stringify([
      { id: 'ufi', driver: 'adb', serial: '32f32221', smsTxnCode: 6 },
    ]),
  });
  assert.strictEqual(configs[0].driver, 'adb');
  assert.strictEqual(configs[0].serial, '32f32221');
  assert.strictEqual(configs[0].smsTxnCode, 6);
});
