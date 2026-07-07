const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// point the store at a throwaway DB before it is loaded
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-gateway-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const { appendLog, updateLog, getLog, listSent, getMetrics } = require('../store/log-store');
const { saveReceived, listReceived, countReceived } = require('../store/inbox-store');

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function entry(id, overrides = {}) {
  return {
    id,
    timestamp: new Date().toISOString(),
    to: '+99361234567',
    message: 'hello',
    projectName: 'E-Center',
    ip: '::1',
    status: 'pending',
    error: null,
    ...overrides,
  };
}

test('appendLog / getLog round-trip', async () => {
  await appendLog(entry('a1'));
  const got = await getLog('a1');
  assert.equal(got.to, '+99361234567');
  assert.equal(got.status, 'pending');
  assert.equal(got.projectName, 'E-Center');
  assert.equal(await getLog('missing'), null);
});

test('updateLog patches only whitelisted fields', async () => {
  await appendLog(entry('a2'));
  const updated = await updateLog('a2', {
    status: 'sent',
    sentAt: '2026-07-07T10:00:00.000Z',
    reference: '+CMGS: 12',
    message: 'HACKED', // not patchable — must be ignored
  });
  assert.equal(updated.status, 'sent');
  assert.equal(updated.reference, '+CMGS: 12');
  assert.equal(updated.message, 'hello');
  assert.equal(await updateLog('missing', { status: 'sent' }), null);
});

test('listSent: pagination, ordering, filters and total', async () => {
  const base = Date.parse('2026-07-07T00:00:00Z');
  for (let i = 0; i < 5; i++) {
    await appendLog(
      entry(`list-${i}`, {
        timestamp: new Date(base + i * 1000).toISOString(),
        status: i % 2 === 0 ? 'sent' : 'failed',
        projectName: i < 3 ? 'alpha' : 'beta',
        to: '+99360000000',
      })
    );
  }

  const page = await listSent({ limit: 2, offset: 0, to: '+99360000000' });
  assert.equal(page.total, 5);
  assert.equal(page.messages.length, 2);
  assert.equal(page.messages[0].id, 'list-4'); // newest first

  const failed = await listSent({ status: 'failed', to: '+99360000000' });
  assert.equal(failed.total, 2);
  assert.ok(failed.messages.every((m) => m.status === 'failed'));

  const alphaSent = await listSent({ status: 'sent', projectName: 'alpha', to: '+99360000000' });
  assert.equal(alphaSent.total, 2); // list-0, list-2

  const offsetPage = await listSent({ limit: 2, offset: 4, to: '+99360000000' });
  assert.equal(offsetPage.messages.length, 1);
  assert.equal(offsetPage.messages[0].id, 'list-0');
});

test('getMetrics counts by status, all-time and last 24h', async () => {
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  await appendLog(entry('m-old', { timestamp: old, status: 'failed' }));
  await appendLog(entry('m-new', { status: 'sent' }));

  const metrics = await getMetrics();
  assert.ok(metrics.total >= 2);
  assert.ok(metrics.byStatus.failed >= 1);
  assert.ok(metrics.last24h.total < metrics.total); // m-old excluded
  assert.ok((metrics.last24h.byStatus.sent || 0) >= 1);
  // m-old is 48h old, so it counts all-time but not in the last 24h
  assert.ok((metrics.last24h.byStatus.failed || 0) < metrics.byStatus.failed);
});

test('inbox: saveReceived / listReceived / countReceived', async () => {
  await saveReceived([
    { from: '+99361111111', date: '26/07/07,10:00:00+20', text: 'first' },
    { from: '+99362222222', date: '26/07/07,10:01:00+20', text: 'второй' },
  ]);
  assert.equal(await countReceived(), 2);

  const { length } = await listReceived({ limit: 50 });
  assert.equal(length, 2);
  const [newest] = await listReceived({ limit: 1 });
  assert.equal(newest.text, 'второй'); // newest first
  assert.equal(newest.from, '+99362222222');

  await saveReceived([]); // no-op, must not throw
  assert.equal(await countReceived(), 2);
});
