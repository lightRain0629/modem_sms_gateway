const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const crypto = require('crypto');

if (!process.env.API_KEY) {
  console.error('API_KEY is not set. Copy .env.example to .env and set a strong key.');
  process.exit(1);
}

const router = require('./router/router');
const modem = require('./utils/driver');
const { sendSMSQueue, worker } = require('./config/bull.config');
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

// Bull Board dashboard — basic auth so it works from a browser.
// Login: any username, password = API_KEY.
const checkBasicAuth = (req, res, next) => {
  const auth = req.get('authorization') || '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const password = sep >= 0 ? decoded.slice(sep + 1) : '';
    if (password && timingSafeEqual(password, process.env.API_KEY)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Queue Dashboard"');
  return res.status(401).send('Authentication required');
};

app.use('/admin/queues', checkBasicAuth, serverAdapter.getRouter());

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
    await sendSMSQueue.close();
  } catch (e) {
    console.error('error closing queue:', e.message);
  }
  try {
    await modem.close();
  } catch (e) {
    console.error('error closing modem:', e.message);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
