const db = require('./db');

const insertStmt = db.prepare(`
  INSERT INTO received_messages (from_number, modem_date, text, received_at, modem_id)
  VALUES (@from, @date, @text, @receivedAt, @modemId)
`);

const insertAll = db.transaction((messages, receivedAt) => {
  for (const m of messages) {
    insertStmt.run({
      from: m.from ?? null,
      date: m.date ?? null,
      text: m.text ?? '',
      receivedAt,
      modemId: m.modemId ?? null,
    });
  }
});

/**
 * Persist inbound messages. Called by the drivers BEFORE they delete the
 * messages from the modem, so a failed write keeps them on the SIM.
 */
exports.saveReceived = async (messages) => {
  if (!messages || messages.length === 0) return;
  insertAll(messages, new Date().toISOString());
};

exports.listReceived = async ({ limit = 50, offset = 0, modemId } = {}) => {
  const where = typeof modemId === 'string' && modemId !== '' ? ' WHERE modem_id = @modemId' : '';
  return db
    .prepare(
      `SELECT id, from_number AS "from", modem_date AS date, text,
              received_at AS receivedAt, modem_id AS modemId
       FROM received_messages${where} ORDER BY id DESC LIMIT @limit OFFSET @offset`
    )
    .all({ limit, offset, ...(where ? { modemId } : {}) });
};

exports.countReceived = async () =>
  db.prepare('SELECT COUNT(*) AS n FROM received_messages').get().n;
