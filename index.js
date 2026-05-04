'use strict';

require('dotenv').config();
const { App } = require('@slack/bolt');
const logger = require('./services/logger');
const { registerMessageHandlers } = require('./slack/messageHandlers');
const { registerActionHandlers } = require('./slack/actionHandlers');
const { registerShortcuts } = require('./slack/shortcuts');
const { startScheduler } = require('./services/scheduler');

// ─── Boot Slack App (Socket Mode) ───────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  logLevel: process.env.LOG_LEVEL || 'info',
});

// ─── Register all handlers ───────────────────────────────────────────────────
registerMessageHandlers(app);
registerActionHandlers(app);
registerShortcuts(app);

// ─── Start ───────────────────────────────────────────────────────────────────
(async () => {
  try {
    await app.start();
    logger.info('⚡ MCI Pipeline Agent is running');

    // Start the morning summary cron scheduler
    startScheduler(app.client);
    logger.info(`📅 Morning summary scheduler started (${process.env.MORNING_SUMMARY_CRON})`);
  } catch (err) {
    logger.error('Failed to start agent', err);
    process.exit(1);
  }
})();

module.exports = { app };
