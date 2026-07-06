const fs = require('fs').promises;
const path = require('path');
const createSerializer = require('../utils/serialize');

const LOG_PATH = path.join(__dirname, '..', 'sent.json');

// All access goes through this lock so concurrent requests and the queue
// worker never interleave reads with a rewrite. Single-process by design.
const withLock = createSerializer();

// The file is read once per process; afterwards this array is the source of
// truth and writes just persist it, so status polls cost no disk I/O.
let cache = null;

async function ensureLoaded() {
  if (!cache) {
    try {
      const logs = JSON.parse(await fs.readFile(LOG_PATH, 'utf8'));
      cache = Array.isArray(logs) ? logs : [];
    } catch (e) {
      cache = []; // missing or invalid file -> start fresh
    }
  }
  return cache;
}

async function persist(logs) {
  // temp file + rename so a crash mid-write can't corrupt the log
  const tmpPath = LOG_PATH + '.tmp';
  await fs.writeFile(tmpPath, JSON.stringify(logs, null, 2), 'utf8');
  await fs.rename(tmpPath, LOG_PATH);
}

exports.appendLog = (entry) =>
  withLock(async () => {
    const logs = await ensureLoaded();
    logs.push(entry);
    await persist(logs);
    return entry;
  });

exports.updateLog = (id, patch) =>
  withLock(async () => {
    const logs = await ensureLoaded();
    const entry = logs.find((l) => l.id === id);
    if (!entry) return null;
    Object.assign(entry, patch);
    await persist(logs);
    return entry;
  });

exports.getLog = (id) =>
  withLock(async () => {
    const logs = await ensureLoaded();
    return logs.find((l) => l.id === id) || null;
  });
