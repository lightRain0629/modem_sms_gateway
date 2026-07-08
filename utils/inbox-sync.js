const { saveReceived } = require('../store/inbox-store');

/**
 * Read one modem's stored messages, persisting them (tagged with the modem
 * id) BEFORE the driver deletes them from the modem. Shared by the
 * /sms/messages endpoint and the post-tariff inbox polls in the USSD worker.
 */
exports.fetchAndStore = async (modem) => {
  const messages = await modem.getMessages((msgs) =>
    saveReceived(msgs.map((x) => ({ ...x, modemId: modem.id })))
  );
  return messages.map((x) => ({ ...x, modemId: modem.id }));
};
