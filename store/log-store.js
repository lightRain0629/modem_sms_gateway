const db = require('./db');

// Columns a caller is allowed to change after creation, mapped to their
// JS-side field names.
const PATCHABLE = {
  status: 'status',
  error: 'error',
  sentAt: 'sent_at',
  reference: 'reference',
  modemId: 'modem_id',
};

const insertStmt = db.prepare(`
  INSERT INTO sent_messages
    (id, timestamp, to_number, message, project_name, ip, status, error, sent_at, reference, modem_id)
  VALUES
    (@id, @timestamp, @to, @message, @projectName, @ip, @status, @error, @sentAt, @reference, @modemId)
`);

const getStmt = db.prepare('SELECT * FROM sent_messages WHERE id = ?');

function toEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    timestamp: row.timestamp,
    to: row.to_number,
    message: row.message,
    projectName: row.project_name,
    ip: row.ip,
    status: row.status,
    error: row.error,
    sentAt: row.sent_at,
    reference: row.reference,
    modemId: row.modem_id,
  };
}

// better-sqlite3 is synchronous; the async signatures are kept so existing
// callers (router, queue worker) stay unchanged.

exports.appendLog = async (entry) => {
  insertStmt.run({
    id: entry.id,
    timestamp: entry.timestamp,
    to: entry.to,
    message: entry.message,
    projectName: entry.projectName ?? null,
    ip: entry.ip ?? null,
    status: entry.status,
    error: entry.error ?? null,
    sentAt: entry.sentAt ?? null,
    reference: entry.reference ?? null,
    modemId: entry.modemId ?? null,
  });
  return entry;
};

exports.updateLog = async (id, patch) => {
  const sets = [];
  const params = { id };
  for (const [field, column] of Object.entries(PATCHABLE)) {
    if (field in patch) {
      sets.push(`${column} = @${field}`);
      params[field] = patch[field] ?? null;
    }
  }
  if (sets.length === 0) return toEntry(getStmt.get(id));
  const result = db.prepare(`UPDATE sent_messages SET ${sets.join(', ')} WHERE id = @id`).run(params);
  if (result.changes === 0) return null;
  return toEntry(getStmt.get(id));
};

exports.getLog = async (id) => toEntry(getStmt.get(id));

// Optional equality filters for the listing endpoint, mapped to columns.
const FILTERS = {
  status: 'status',
  projectName: 'project_name',
  to: 'to_number',
  modemId: 'modem_id',
};

function buildWhere(filters) {
  const clauses = [];
  const params = {};
  for (const [field, column] of Object.entries(FILTERS)) {
    if (typeof filters[field] === 'string' && filters[field] !== '') {
      clauses.push(`${column} = @${field}`);
      params[field] = filters[field];
    }
  }
  return { where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

/** List sent messages, newest first, with optional status/projectName/to filters. */
exports.listSent = async ({ limit = 50, offset = 0, ...filters } = {}) => {
  const { where, params } = buildWhere(filters);
  const rows = db
    .prepare(
      `SELECT * FROM sent_messages${where} ORDER BY timestamp DESC LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset });
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM sent_messages${where}`)
    .get(params).n;
  return { messages: rows.map(toEntry), total };
};

function countByStatus(where = '', params = {}) {
  const byStatus = {};
  let total = 0;
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM sent_messages${where} GROUP BY status`)
    .all(params);
  for (const row of rows) {
    byStatus[row.status] = row.n;
    total += row.n;
  }
  return { total, byStatus };
}

/** Basic delivery metrics: all-time and last-24h counts per status. */
exports.getMetrics = async () => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return {
    ...countByStatus(),
    last24h: countByStatus(' WHERE timestamp >= @cutoff', { cutoff }),
  };
};
