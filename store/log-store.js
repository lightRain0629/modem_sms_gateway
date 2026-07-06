const db = require('./db');

// Columns a caller is allowed to change after creation, mapped to their
// JS-side field names.
const PATCHABLE = {
  status: 'status',
  error: 'error',
  sentAt: 'sent_at',
  reference: 'reference',
};

const insertStmt = db.prepare(`
  INSERT INTO sent_messages
    (id, timestamp, to_number, message, project_name, ip, status, error, sent_at, reference)
  VALUES
    (@id, @timestamp, @to, @message, @projectName, @ip, @status, @error, @sentAt, @reference)
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
