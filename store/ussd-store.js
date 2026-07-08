const db = require('./db');

const insertStmt = db.prepare(`
  INSERT INTO ussd_requests
    (id, modem_id, kind, code, status, reply, error, requested_at, completed_at)
  VALUES
    (@id, @modemId, @kind, @code, @status, @reply, @error, @requestedAt, @completedAt)
`);

const getStmt = db.prepare('SELECT * FROM ussd_requests WHERE id = ?');

function toEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    modemId: row.modem_id,
    kind: row.kind,
    code: row.code,
    status: row.status,
    reply: row.reply,
    error: row.error,
    requestedAt: row.requested_at,
    completedAt: row.completed_at,
  };
}

// better-sqlite3 is synchronous; the async signatures match the other stores.

exports.createRequest = async (entry) => {
  insertStmt.run({
    id: entry.id,
    modemId: entry.modemId,
    kind: entry.kind,
    code: entry.code,
    status: entry.status || 'pending',
    reply: entry.reply ?? null,
    error: entry.error ?? null,
    requestedAt: entry.requestedAt,
    completedAt: entry.completedAt ?? null,
  });
  return entry;
};

/** Settle a request as done/failed; stamps completed_at. Null if the id is unknown. */
exports.completeRequest = async (id, { status, reply, error }) => {
  const result = db
    .prepare(
      `UPDATE ussd_requests
       SET status = @status, reply = @reply, error = @error, completed_at = @completedAt
       WHERE id = @id`
    )
    .run({
      id,
      status,
      reply: reply ?? null,
      error: error ?? null,
      completedAt: new Date().toISOString(),
    });
  if (result.changes === 0) return null;
  return toEntry(getStmt.get(id));
};

exports.getRequest = async (id) => toEntry(getStmt.get(id));

/** Newest successfully-completed request of a kind for one modem, or null. */
exports.latestDone = async (modemId, kind) =>
  toEntry(
    db
      .prepare(
        `SELECT * FROM ussd_requests
         WHERE modem_id = ? AND kind = ? AND status = 'done'
         ORDER BY requested_at DESC, rowid DESC LIMIT 1`
      )
      .get(modemId, kind)
  );

/** List requests, newest first, with optional kind/modem equality filters. */
exports.listRequests = async ({ limit = 50, offset = 0, kind, modemId } = {}) => {
  const clauses = [];
  const params = {};
  if (typeof kind === 'string' && kind !== '') {
    clauses.push('kind = @kind');
    params.kind = kind;
  }
  if (typeof modemId === 'string' && modemId !== '') {
    clauses.push('modem_id = @modemId');
    params.modemId = modemId;
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM ussd_requests${where}
       ORDER BY requested_at DESC, rowid DESC LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset });
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ussd_requests${where}`).get(params).n;
  return { requests: rows.map(toEntry), total };
};
