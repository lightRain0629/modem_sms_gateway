const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// point the store at a throwaway DB before it is loaded
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-gateway-ussd-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const {
  createRequest,
  completeRequest,
  getRequest,
  latestDone,
  listRequests,
} = require('../store/ussd-store');

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function request(id, overrides = {}) {
  return {
    id,
    modemId: 'zte',
    kind: 'balance',
    code: '*0800#',
    status: 'pending',
    requestedAt: new Date().toISOString(),
    ...overrides,
  };
}

test('createRequest / getRequest round-trip', async () => {
  await createRequest(request('u1'));
  const got = await getRequest('u1');
  assert.equal(got.modemId, 'zte');
  assert.equal(got.kind, 'balance');
  assert.equal(got.code, '*0800#');
  assert.equal(got.status, 'pending');
  assert.equal(got.reply, null);
  assert.equal(got.completedAt, null);
  assert.equal(await getRequest('missing'), null);
});

test('completeRequest settles done and failed, stamping completedAt', async () => {
  await createRequest(request('u2'));
  const done = await completeRequest('u2', { status: 'done', reply: 'Balans: 5.20 TMT' });
  assert.equal(done.status, 'done');
  assert.equal(done.reply, 'Balans: 5.20 TMT');
  assert.ok(done.completedAt);

  await createRequest(request('u3'));
  const failed = await completeRequest('u3', { status: 'failed', error: 'No USSD reply' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'No USSD reply');

  assert.equal(await completeRequest('missing', { status: 'done', reply: 'x' }), null);
});

test('latestDone: newest done request of the kind, per modem', async () => {
  const base = Date.parse('2026-07-08T00:00:00Z');
  const at = (i) => new Date(base + i * 1000).toISOString();
  // own modem id so requests from the other tests can't win the "newest" race
  const modemId = 'lat';

  await createRequest(request('l1', { modemId, requestedAt: at(1) }));
  await completeRequest('l1', { status: 'done', reply: 'old balance' });
  await createRequest(request('l2', { modemId, requestedAt: at(2) }));
  await completeRequest('l2', { status: 'done', reply: 'new balance' });
  await createRequest(request('l3', { modemId, requestedAt: at(3) })); // still pending
  await createRequest(request('l4', { modemId, requestedAt: at(4) }));
  await completeRequest('l4', { status: 'failed', error: 'boom' });

  const latest = await latestDone(modemId, 'balance');
  assert.equal(latest.id, 'l2'); // pending/failed never win
  assert.equal(latest.reply, 'new balance');

  assert.equal(await latestDone(modemId, 'tariff'), null);
  assert.equal(await latestDone('other-modem', 'balance'), null);
});

test('listRequests: newest first, kind/modem filters and total', async () => {
  const base = Date.parse('2026-07-08T01:00:00Z');
  await createRequest(
    request('t1', { kind: 'tariff', code: '*0805#', requestedAt: new Date(base).toISOString() })
  );
  await createRequest(
    request('t2', {
      kind: 'tariff',
      code: '*0805#',
      modemId: 'ufi',
      requestedAt: new Date(base + 1000).toISOString(),
    })
  );

  const tariffs = await listRequests({ kind: 'tariff' });
  assert.equal(tariffs.total, 2);
  assert.equal(tariffs.requests[0].id, 't2'); // newest first

  const zteTariffs = await listRequests({ kind: 'tariff', modemId: 'zte' });
  assert.equal(zteTariffs.total, 1);
  assert.equal(zteTariffs.requests[0].id, 't1');

  const page = await listRequests({ kind: 'tariff', limit: 1, offset: 1 });
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].id, 't1');
});
