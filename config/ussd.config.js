/**
 * USSD queue: balance/tariff codes run asynchronously so a 20-30s (or
 * never-replying) USSD session doesn't live inside an HTTP request. Kept
 * separate from the send queue because the retry rules differ — re-running
 * a silent USSD session is always safe, re-sending an unconfirmed SMS is not.
 *
 * Every session is persisted to ussd_requests (pending → done/failed), so
 * balance history and failure diagnostics survive the console log.
 */
const crypto = require('crypto');
const { Queue, Worker, UnrecoverableError } = require('bullmq');
const { USSDQUEUE } = require('../constants/queue.const');
const { connection } = require('./redis.config');
const pool = require('../utils/pool');
const { fetchAndStore } = require('../utils/inbox-sync');
const { createRequest, completeRequest } = require('../store/ussd-store');

const MODEM_READY_TIMEOUT_MS = 30000;
// A tariff USSD only acknowledges; the actual plan details arrive minutes
// later as SMS (TMCell: from 0801, one per active tariff). Sweep the inbox a
// few times afterwards so they land in the DB without a manual /sms/messages.
const TARIFF_INBOX_POLL_DELAYS_MS = [30000, 90000, 180000];

const ussdQueue = new Queue(USSDQUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 15000 },
    removeOnComplete: 200,
    removeOnFail: 500,
  },
});

ussdQueue.on('error', (err) => {
  console.error('[ussd] redis/queue error:', err.message);
});

async function waitForModem(modem) {
  const deadline = Date.now() + MODEM_READY_TIMEOUT_MS;
  while (!modem.isConnected() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Persist a pending request row and queue the USSD session for it. */
async function enqueueUssd(modem, kind) {
  const request = {
    id: crypto.randomUUID(),
    modemId: modem.id,
    kind,
    code: modem.ussdCodes[kind],
    status: 'pending',
    requestedAt: new Date().toISOString(),
  };
  await createRequest(request);
  try {
    await ussdQueue.add('ussd', {
      requestId: request.id,
      modemId: modem.id,
      kind,
      code: request.code,
    });
  } catch (err) {
    // don't leave a pending row that no job will ever settle
    await completeRequest(request.id, { status: 'failed', error: err.message }).catch(() => {});
    throw err;
  }
  return request;
}

const ussdWorker = new Worker(
  USSDQUEUE,
  async (job) => {
    // delayed follow-up after a tariff session: pull the carrier's SMS reply
    // off the modem into the inbox table
    if (job.name === 'poll-inbox') {
      const modem = pool.get(job.data.modemId);
      if (!modem) return { fetched: 0 };
      const messages = await fetchAndStore(modem);
      return { fetched: messages.length };
    }

    const { requestId, modemId, kind, code } = job.data;
    const modem = pool.get(modemId);
    if (!modem) {
      throw new UnrecoverableError(`Unknown modem "${modemId}"`);
    }
    if (!modem.supportsUssd) {
      throw new UnrecoverableError(
        `USSD is not supported on modem "${modemId}" (${modem.driver} driver)`
      );
    }
    await waitForModem(modem);

    const reply = await modem.runUssd(code);
    // unlike an SMS send, retrying a silent USSD session cannot double-deliver
    if (!reply) throw new Error('No USSD reply');

    await completeRequest(requestId, { status: 'done', reply });

    if (kind === 'tariff') {
      // best effort — the session itself already succeeded
      try {
        for (const delay of TARIFF_INBOX_POLL_DELAYS_MS) {
          await ussdQueue.add('poll-inbox', { modemId }, { delay, attempts: 1 });
        }
      } catch (e) {
        console.error('[ussd] could not schedule inbox polls:', e.message);
      }
    }
    return { requestId, reply };
  },
  { connection, concurrency: Math.max(1, pool.size()) }
);

ussdWorker.on('error', (err) => {
  console.error('[ussd] worker error:', err.message);
});

ussdWorker.on('failed', async (job, err) => {
  if (!job) {
    console.error('[ussd] job failed:', err.message);
    return;
  }
  console.error(`[ussd] ${job.name} job ${job.id} failed: ${err.message}`);
  if (job.name === 'poll-inbox') return;

  const attempts = job.opts.attempts || 1;
  const isFinal = err instanceof UnrecoverableError || job.attemptsMade >= attempts;
  if (isFinal) {
    try {
      await completeRequest(job.data.requestId, { status: 'failed', error: err.message });
    } catch (e) {
      console.error('[ussd] could not update request:', e.message);
    }
  }
});

module.exports = { ussdQueue, ussdWorker, enqueueUssd };
