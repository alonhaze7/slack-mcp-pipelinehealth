'use strict';

/**
 * messageHandlers.js
 * Handles all incoming Slack messages — @mentions, DMs, and channel messages.
 * Routes to the AI agent for natural language Q&A.
 */

const { chat, clearHistory } = require('../agent/anthropicAgent');
const mciClient = require('../api/mciClient');
const { buildFullReportModal, buildMorningSummaryBlocks } = require('./blockBuilders');
const { generateMorningSummaryNarrative } = require('../agent/anthropicAgent');
const logger = require('../services/logger');

function registerMessageHandlers(app) {

  // ── Handle @mentions in channels ──────────────────────────────────────────
  app.event('app_mention', async ({ event, client, say }) => {
    const userId = event.user;
    const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

    logger.info(`App mention from ${userId}: "${text}"`);

    // Show typing indicator
    await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: 'thinking_face' });

    try {
      if (!text || text.toLowerCase() === 'help') {
        await say({
          thread_ts: event.ts,
          blocks: buildHelpBlocks(),
          text: 'MCI Pipeline Agent help',
        });
        return;
      }

      if (text.toLowerCase() === 'status' || text.toLowerCase() === 'health') {
        const summary = await mciClient.getHealthSummary();
        const narrative = await generateMorningSummaryNarrative(summary);
        await say({
          thread_ts: event.ts,
          blocks: buildMorningSummaryBlocks(summary, narrative),
          text: `Health score: ${summary.healthScore}/100`,
        });
        return;
      }

      if (text.toLowerCase().startsWith('reset')) {
        clearHistory(userId);
        await say({ thread_ts: event.ts, text: 'Conversation history cleared. Ask me anything!' });
        return;
      }

      // Default: AI chat response
      const response = await chat(userId, text);
      await say({ thread_ts: event.ts, text: response.text });

    } catch (err) {
      logger.error('Message handler error', err);
      await say({
        thread_ts: event.ts,
        text: `Sorry, I hit an error processing that. Error: ${err.message}`,
      });
    } finally {
      await client.reactions.remove({ channel: event.channel, timestamp: event.ts, name: 'thinking_face' }).catch(() => {});
    }
  });

  // ── Handle direct messages ────────────────────────────────────────────────
  app.message(async ({ message, client, say }) => {
    // Only handle DMs (channel_type = 'im')
    if (message.channel_type !== 'im' || message.bot_id) return;

    const userId = message.user;
    const text = (message.text || '').trim();

    if (!text) return;

    logger.info(`DM from ${userId}: "${text}"`);

    try {
      if (text.toLowerCase() === 'help') {
        await say({ blocks: buildHelpBlocks(), text: 'Help' });
        return;
      }

      if (text.toLowerCase() === 'reset') {
        clearHistory(userId);
        await say({ text: 'Conversation reset. Ask me anything about your MCI pipelines.' });
        return;
      }

      if (text.toLowerCase() === 'status') {
        const summary = await mciClient.getHealthSummary();
        const narrative = await generateMorningSummaryNarrative(summary);
        await say({
          blocks: buildMorningSummaryBlocks(summary, narrative),
          text: `Health: ${summary.healthScore}/100`,
        });
        return;
      }

      const response = await chat(userId, text);
      await say({ text: response.text });

    } catch (err) {
      logger.error('DM handler error', err);
      await say({ text: `Error: ${err.message}` });
    }
  });
}

// ─── Help blocks ──────────────────────────────────────────────────────────────
function buildHelpBlocks() {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*MCI Pipeline Agent — Commands*\n\nYou can ask me anything in plain English, or use these shortcuts:`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '`@mci-agent status`\nFull pipeline health summary' },
        { type: 'mrkdwn', text: '`@mci-agent reset`\nClear conversation history' },
        { type: 'mrkdwn', text: '`@mci-agent help`\nShow this message' },
        { type: 'mrkdwn', text: '`@mci-agent <any question>`\nAI-powered pipeline Q&A' },
      ],
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: 'Example: _"Why did Meta EMEA fail?"_ · _"How many pipelines ran this week?"_ · _"What tokens are expiring?"_',
      }],
    },
  ];
}

module.exports = { registerMessageHandlers };
