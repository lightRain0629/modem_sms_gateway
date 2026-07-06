// Selects the modem driver. Only the chosen module is require()d — the serial
// driver opens its port at load time, so it must not load in HTTP mode.
const name = (process.env.MODEM_DRIVER || 'serial').toLowerCase();

if (name === 'zte-http') {
  module.exports = require('./zte-http');
} else if (name === 'serial') {
  module.exports = require('./modem');
} else {
  console.error(`Unknown MODEM_DRIVER "${name}" — use "serial" or "zte-http".`);
  process.exit(1);
}
