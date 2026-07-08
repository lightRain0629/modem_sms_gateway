const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const crypto = require('crypto');
const path = require('path');

if (!process.env.API_KEY) {
  console.error('API_KEY is not set. Copy .env.example to .env and set a strong key.');
  process.exit(1);
}

const router = require('./router/router');
const pool = require('./utils/pool');
const { sendSMSQueue, worker } = require('./config/bull.config');
const { ussdQueue, ussdWorker } = require('./config/ussd.config');
const { serverAdapter } = require('./config/bull-board.config');

const port = process.env.PORT || 3000;

const app = express();
app.use(express.json());

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// accepts the key via 'x-api-key' or 'Authorization: Bearer <key>'
const checkApiKey = (req, res, next) => {
  let apiKey = req.get('x-api-key');
  if (!apiKey) {
    const auth = req.get('authorization') || '';
    if (auth.toLowerCase().startsWith('bearer ')) {
      apiKey = auth.slice(7).trim();
    }
  }

  if (!apiKey || !timingSafeEqual(apiKey, process.env.API_KEY)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
};

app.use('/sms', checkApiKey, router);

// Bull Board dashboard — basic auth so it works from a browser, with its
// own credentials so the machine-to-machine API_KEY never gets typed into
// a browser. Falls back to the legacy login (any username, API_KEY as
// password) when the dashboard credentials aren't configured.
const { DASHBOARD_USER, DASHBOARD_PASSWORD } = process.env;
if (!!DASHBOARD_USER !== !!DASHBOARD_PASSWORD) {
  console.error('DASHBOARD_USER and DASHBOARD_PASSWORD must be set together.');
  process.exit(1);
}
if (!DASHBOARD_PASSWORD) {
  console.warn(
    '[dashboard] DASHBOARD_USER/DASHBOARD_PASSWORD not set — ' +
      '/admin/queues accepts the API_KEY as password (any username)'
  );
}

const checkBasicAuth = (req, res, next) => {
  const auth = req.get('authorization') || '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const username = sep >= 0 ? decoded.slice(0, sep) : decoded;
    const password = sep >= 0 ? decoded.slice(sep + 1) : '';
    let ok;
    if (DASHBOARD_PASSWORD) {
      // no && short-circuit: a username miss must cost the same as a hit
      const userOk = timingSafeEqual(username, DASHBOARD_USER);
      const passOk = timingSafeEqual(password, DASHBOARD_PASSWORD);
      ok = userOk & passOk;
    } else {
      ok = password && timingSafeEqual(password, process.env.API_KEY);
    }
    if (ok) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Queue Dashboard"');
  return res.status(401).send('Authentication required');
};

app.use('/admin/queues', checkBasicAuth, serverAdapter.getRouter());

// API reference — Scalar UI (loaded from its CDN) over the checked-in
// OpenAPI spec. Public: the spec holds no secrets, only endpoint shapes.
const DOCS_HTML = `<!doctype html>
<html>
  <head>
    <title>SMS Gateway — API Reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1"></script>
    <script>
      Scalar.createApiReference('#app', { url: '/openapi.json' });
    </script>
  </body>
</html>`;

app.get('/openapi.json', (req, res) => res.sendFile(path.join(__dirname, 'openapi.json')));
app.get('/docs', (req, res) => res.type('html').send(DOCS_HTML));

const server = app.listen(port, () => {
  console.log(`SMS API server running at http://localhost:${port}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down...`);
  server.close();
  try {
    await worker.close();
    await ussdWorker.close();
    await sendSMSQueue.close();
    await ussdQueue.close();
  } catch (e) {
    console.error('error closing queue:', e.message);
  }
  try {
    await pool.closeAll();
  } catch (e) {
    console.error('error closing modems:', e.message);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
