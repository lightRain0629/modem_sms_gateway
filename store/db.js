const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'gateway.db');
const LEGACY_LOG_PATH = path.join(__dirname, '..', 'sent.json');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // readers never block the writer

db.exec(`
  CREATE TABLE IF NOT EXISTS sent_messages (
    id           TEXT PRIMARY KEY,
    timestamp    TEXT NOT NULL,
    to_number    TEXT NOT NULL,
    message      TEXT NOT NULL,
    project_name TEXT,
    ip           TEXT,
    status       TEXT NOT NULL,
    error        TEXT,
    sent_at      TEXT,
    reference    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sent_status    ON sent_messages(status);
  CREATE INDEX IF NOT EXISTS idx_sent_timestamp ON sent_messages(timestamp);
  CREATE INDEX IF NOT EXISTS idx_sent_to        ON sent_messages(to_number);

  CREATE TABLE IF NOT EXISTS received_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    from_number TEXT,
    modem_date  TEXT,
    text        TEXT,
    received_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_recv_from        ON received_messages(from_number);
  CREATE INDEX IF NOT EXISTS idx_recv_received_at ON received_messages(received_at);
`);

// One-time migration from the old sent.json log. Runs only when the table is
// empty; the file is renamed afterwards so it never imports twice.
function migrateLegacyLog() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM sent_messages').get().n;
  if (count > 0 || !fs.existsSync(LEGACY_LOG_PATH)) return;

  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(LEGACY_LOG_PATH, 'utf8'));
  } catch (e) {
    console.error('[db] cannot parse legacy sent.json, skipping import:', e.message);
    return;
  }
  if (!Array.isArray(entries) || entries.length === 0) return;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO sent_messages
      (id, timestamp, to_number, message, project_name, ip, status, error, sent_at, reference)
    VALUES
      (@id, @timestamp, @to, @message, @projectName, @ip, @status, @error, @sentAt, @reference)
  `);
  const importAll = db.transaction((rows) => {
    for (const row of rows) {
      if (!row || !row.id) continue;
      insert.run({
        id: row.id,
        timestamp: row.timestamp || new Date().toISOString(),
        to: row.to || '',
        message: row.message || '',
        projectName: row.projectName ?? null,
        ip: row.ip ?? null,
        status: row.status || 'unknown',
        error: row.error ?? null,
        sentAt: row.sentAt ?? null,
        reference: row.reference ?? null,
      });
    }
  });
  importAll(entries);
  fs.renameSync(LEGACY_LOG_PATH, LEGACY_LOG_PATH + '.imported');
  console.log(`[db] imported ${entries.length} entries from sent.json (renamed to sent.json.imported)`);
}

migrateLegacyLog();

module.exports = db;
