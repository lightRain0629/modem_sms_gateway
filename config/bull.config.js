const { Queue, Worker, UnrecoverableError } = require('bullmq');
const { SENDMESSAGEQUEUE } = require('../constants/queue.const');
const modem = require('../utils/driver');
const { updateLog } = require('../store/log-store');

const connection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null, // required by BullMQ workers
};

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
async function waitForModem() {
  const deadline = Date.now() + MODEM_READY_TIMEOUT_MS;
  while (!modem.isConnected() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

// concurrency stays 1: the modem can only handle one send at a time.
// Throwing here is intentional: it marks the job failed so BullMQ retries it.
const worker = new Worker(
  SENDMESSAGEQUEUE,
  async (job) => {
    const { to, message, logId } = job.data;
    await waitForModem();

    let result;
    try {
      result = await modem.sendSMS(to, message);
    } catch (err) {
      if (err.confirmTimeout) {
        // the message may already be with the network — retrying could
        // double-send, so fail permanently instead
        throw new UnrecoverableError(`Send unconfirmed: ${err.message}`);
      }
      throw err;
    }

    try {
      await updateLog(logId, {
        status: 'sent',
        sentAt: new Date().toISOString(),
        reference: result.reference,
        error: null,
      });
    } catch (e) {
      // never fail (and re-send) a delivered SMS over a log write error
      console.error('[queue] log update failed after send:', e.message);
    }
    return { logId, reference: result.reference };
  },
  { connection, concurrency: 1 }
);

worker.on('error', (err) => {
  console.error('[worker] error:', err.message);
});

worker.on('completed', (job) => {
  console.log(`[queue] job ${job.id} sent (log ${job.data.logId})`);
});

let lastBalanceCheckAt = 0;
async function maybeCheckBalance() {
  // a failing backlog would otherwise queue a 20-30s USSD session on the
  // modem mutex for every failed job
  if (Date.now() - lastBalanceCheckAt < BALANCE_CHECK_MIN_INTERVAL_MS) return;
  lastBalanceCheckAt = Date.now();
  try {
    await modem.checkBalance();
  } catch (e) {
    console.error('[queue] balance check failed:', e.message);
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
    await updateLog(job.data.logId, {
      status: unconfirmed ? 'unconfirmed' : isFinal ? 'failed' : 'retrying',
      error: err.message,
    });
  } catch (e) {
    console.error('[queue] could not update log:', e.message);
  }

  if (isFinal && !unconfirmed) {
    // a common cause of definite send failures is an empty SIM balance
    await maybeCheckBalance();
  }
});

module.exports = { sendSMSQueue, worker };
