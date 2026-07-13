const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const { sendSMSQueue } = require('./bull.config');
const { ussdQueue } = require('./ussd.config');
const { webhookQueue } = require('./webhook.config');

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [
    new BullMQAdapter(sendSMSQueue),
    new BullMQAdapter(ussdQueue),
    new BullMQAdapter(webhookQueue),
  ],
  serverAdapter,
});

module.exports = { serverAdapter };
