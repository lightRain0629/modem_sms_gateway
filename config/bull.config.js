const { Queue, Worker, UnrecoverableError } = require('bullmq');
const { SENDMESSAGEQUEUE } = require('../constants/queue.const');
const { connection } = require('./redis.config');
const { enqueueUssd } = require('./ussd.config');
const pool = require('../utils/pool');
const { updateLog } = require('../store/log-store');
const { enqueueWebhook } = require('./webhook.config');

const MODEM_READY_TIMEOUT_MS = 30000;
const BALANCE_CHECK_MIN_INTERVAL_MS = 10 * 60 * 1000;

const sendSMSQueue = new Queue(SENDMESSAGEQUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: 200,
    removeOnFail: 500,
  },
});

sendSMSQueue.on('error', (err) => {
  console.error('[queue] redis/queue error:', err.message);
});

// The serial driver connects asynchronously; jobs persisted in Redis across a
// reboot would otherwise burn all their attempts before the port opens.
async function waitForModem(modem) {
  const deadline = Date.now() + MODEM_READY_TIMEOUT_MS;
  while (!modem.isConnected() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Each modem can only handle one send at a time (per-modem serializer inside
// the drivers); worker concurrency matches the pool size so different modems
// can transmit simultaneously.
// Throwing here is intentional: it marks the job failed so BullMQ retries it.
const worker = new Worker(
  SENDMESSAGEQUEUE,
  async (job) => {
    const { to, message, logId, modem: modemId } = job.data;

    let modem;
    if (modemId) {
      modem = pool.get(modemId);
      if (!modem) {
        // retrying can't fix a modem that isn't configured
        throw new UnrecoverableError(`Unknown modem "${modemId}"`);
      }
    } else {
      modem = pool.pick();
    }
    await waitForModem(modem);

    let result;
    try {
      result = await modem.sendSMS(to, message);
    } catch (err) {
      err.modemId = modem.id; // lets the failed handler check the right SIM's balance
      if (err.confirmTimeout) {
        // the message may already be with the network — retrying could
        // double-send, so fail permanently instead
        throw new UnrecoverableError(`Send unconfirmed via "${modem.id}": ${err.message}`);
      }
      throw err;
    }

    try {
      const entry = await updateLog(logId, {
        status: 'sent',
        sentAt: new Date().toISOString(),
        reference: result.reference,
        modemId: modem.id,
        error: null,
      });
      // enqueueWebhook never throws — a callback problem must not re-send the SMS
      await enqueueWebhook(entry, { attempt: job.attemptsMade });
    } catch (e) {
      // never fail (and re-send) a delivered SMS over a log write error
      console.error('[queue] log update failed after send:', e.message);
    }
    return { logId, reference: result.reference, modemId: modem.id };
  },
  { connection, concurrency: Math.max(1, pool.size()) }
);

worker.on('error', (err) => {
  console.error('[worker] error:', err.message);
});

worker.on('completed', (job, result) => {
  console.log(`[queue] job ${job.id} sent via "${result.modemId}" (log ${job.data.logId})`);
});

const lastBalanceCheckAt = new Map(); // modem id -> timestamp
async function maybeCheckBalance(modemId) {
  const modem = modemId ? pool.get(modemId) : null;
  if (!modem || !modem.supportsUssd) return;
  // a failing backlog would otherwise queue a 20-30s USSD session on the
  // modem mutex for every failed job
  const last = lastBalanceCheckAt.get(modem.id) || 0;
  if (Date.now() - last < BALANCE_CHECK_MIN_INTERVAL_MS) return;
  lastBalanceCheckAt.set(modem.id, Date.now());
  try {
    // through the USSD queue so the result lands in ussd_requests instead
    // of vanishing into the console log
    await enqueueUssd(modem, 'balance');
  } catch (e) {
    console.error(`[queue] balance check failed on "${modem.id}":`, e.message);
  }
}

worker.on('failed', async (job, err) => {
  if (!job) {
    console.error('[queue] job failed:', err.message);
    return;
  }
  const attempts = job.opts.attempts || 1;
  const unconfirmed = err instanceof UnrecoverableError;
  const isFinal = unconfirmed || job.attemptsMade >= attempts;
  console.error(
    `[queue] job ${job.id} attempt ${job.attemptsMade}/${attempts} failed: ${err.message}`
  );

  try {
    const entry = await updateLog(job.data.logId, {
      status: unconfirmed ? 'unconfirmed' : isFinal ? 'failed' : 'retrying',
      error: err.message,
      ...(err.modemId ? { modemId: err.modemId } : {}),
    });
    // `retrying` only fires a callback when WEBHOOK_SEND_INTERMEDIATE is set
    await enqueueWebhook(entry, { attempt: job.attemptsMade });
  } catch (e) {
    console.error('[queue] could not update log:', e.message);
  }

  if (isFinal && !unconfirmed) {
    // a common cause of definite send failures is an empty SIM balance
    await maybeCheckBalance(err.modemId);
  }
});

module.exports = { sendSMSQueue, worker };
