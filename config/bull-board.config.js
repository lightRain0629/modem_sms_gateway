const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const { sendSMSQueue } = require('./bull.config');
const { ussdQueue } = require('./ussd.config');

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [new BullMQAdapter(sendSMSQueue), new BullMQAdapter(ussdQueue)],
  serverAdapter,
});

module.exports = { serverAdapter };
