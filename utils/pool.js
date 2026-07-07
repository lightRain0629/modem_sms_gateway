/**
 * The modem pool: instantiates every configured modem and routes work to
 * them. Sends without an explicit modem id are spread round-robin across
 * the modems that currently report a connection.
 */
const { parseModemConfigs } = require('./modem-config');
const { createSerialModem } = require('./modem');
const { createZteModem } = require('./zte-http');
const { createAdbModem } = require('./adb');

const FACTORIES = {
  'zte-http': createZteModem,
  adb: createAdbModem,
  serial: createSerialModem,
};

let modems;
try {
  modems = new Map(
    parseModemConfigs().map((cfg) => [cfg.id, (FACTORIES[cfg.driver] || createSerialModem)(cfg)])
  );
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

let rr = 0;

exports.get = (id) => modems.get(id) || null;

exports.all = () => [...modems.values()];

exports.ids = () => [...modems.keys()];

exports.size = () => modems.size;

/** Round-robin over connected modems; falls back to the full pool so a job
 * can still wait for a reconnect when nothing is currently up. */
exports.pick = () => {
  const list = [...modems.values()];
  const connected = list.filter((m) => m.isConnected());
  const candidates = connected.length > 0 ? connected : list;
  return candidates[rr++ % candidates.length];
};

exports.closeAll = () =>
  Promise.all([...modems.values()].map((m) => m.close().catch(() => {})));
