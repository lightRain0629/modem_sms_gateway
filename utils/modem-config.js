/**
 * Parses the modem fleet configuration out of the environment.
 *
 * Preferred form — MODEMS as a JSON array:
 *   MODEMS=[{"id":"zte","driver":"zte-http","host":"192.168.0.1"},
 *           {"id":"ufi","driver":"serial","port":"/dev/ttyUSB0","baudRate":115200}]
 *
 * When MODEMS is not set, the legacy single-modem variables
 * (MODEM_DRIVER, USB_PORT, BAUD_RATE, ZTE_HOST) are used, producing one
 * modem with id "default" — existing .env files keep working unchanged.
 *
 * SMSC and USSD_BALANCE_CODE act as global defaults for entries that don't
 * set their own smsc / ussdBalanceCode.
 */
const DRIVERS = ['serial', 'zte-http', 'adb'];

function parseModemConfigs(env = process.env) {
  const raw = (env.MODEMS || '').trim();
  let list;

  if (raw) {
    try {
      list = JSON.parse(raw);
    } catch (e) {
      throw new Error(`MODEMS is not valid JSON: ${e.message}`);
    }
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('MODEMS must be a non-empty JSON array');
    }
  } else {
    list = [
      {
        id: 'default',
        driver: (env.MODEM_DRIVER || 'serial').toLowerCase(),
        port: env.USB_PORT,
        baudRate: env.BAUD_RATE,
        host: env.ZTE_HOST,
      },
    ];
  }

  const seen = new Set();
  return list.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Each MODEMS entry must be a JSON object');
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id) {
      throw new Error('Each MODEMS entry needs a non-empty string "id"');
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate modem id "${id}" in MODEMS`);
    }
    seen.add(id);

    const driver = String(entry.driver || '').toLowerCase();
    if (!DRIVERS.includes(driver)) {
      throw new Error(
        `Modem "${id}": unknown driver "${entry.driver}" — use ${DRIVERS.map((d) => `"${d}"`).join(' or ')}`
      );
    }

    return {
      ...entry,
      id,
      driver,
      smsc: entry.smsc !== undefined ? entry.smsc : env.SMSC,
      ussdBalanceCode:
        entry.ussdBalanceCode !== undefined ? entry.ussdBalanceCode : env.USSD_BALANCE_CODE,
    };
  });
}

module.exports = { parseModemConfigs, DRIVERS };
