'use strict';

/**
 * shortcuts.js
 * Registers Slack slash commands:
 *   /mci-status    — quick health summary
 *   /mci-repair    — repair a specific pipeline by name
 *   /mci-ask       — ask the AI agent a question
 *   /mci-summary   — force post a morning summary now
 */

const mciClient = require('../api/mciClient');
const { chat } = require('../agent/anthropicAgent');
const { executeRepair } = require('../services/repairService');
const { buildMorningSummaryBlocks, buildFailureAlertBlocks } = require('./blockBuilders');
const { generateMorningSummaryNarrative } = require('../agent/anthropicAgent');
const { postMorningSummary } = require('../services/scheduler');
const logger = require('../services/logger');

function registerShortcuts(app) {

  // /mci-status — full health overview
  app.command('/mci-status', async ({ command, ack, respond }) => {
    await ack();
    try {
      const summary = await mciClient.getHealthSummary();
      const narrative = await generateMorningSummaryNarrative(summary);
      await respond({
        blocks: buildMorningSummaryBlocks(summary, narrative),
        text: `Health: ${summary.healthScore}/100`,
        response_type: 'in_channel',
      });
    } catch (err) {
      await respond({ text: `Error: ${err.message}` });
    }
  });

  // /mci-repair <pipeline name or ID>
  app.command('/mci-repair', async ({ command, ack, respond }) => {
    await ack();

    const query = command.text?.trim();
    if (!query) {
      await respond({ text: 'Usage: `/mci-repair <pipeline name or ID>`' });
      return;
    }

    try {
      const allPipelines = await mciClient.getAllPipelines();
      const pipeline = allPipelines.find(p =>
        p.id === query ||
        p.name.toLowerCase().includes(query.toLowerCase())
      );

      if (!pipeline) {
        await respond({ text: `No pipeline found matching "${query}". Use \`/mci-status\` to see all pipelines.` });
        return;
      }

      if (pipeline.lastRun?.status !== 'FAILED') {
        await respond({ text: `Pipeline *${pipeline.name}* is not in a failed state (status: ${pipeline.lastRun?.status}). No repair needed.` });
        return;
      }

      await respond({ text: `🔧 Starting repair for *${pipeline.name}*...` });

      const result = await executeRepair(pipeline, async (msg) => {
        await respond({ text: `⏳ ${msg}`, replace_original: false });
      });

      await respond({ text: `✅ ${result.summary}`, replace_original: false });

    } catch (err) {
      logger.error('/mci-repair error', err);
      await respond({ text: `Repair failed: ${err.message}` });
    }
  });

  // /mci-ask <question>
  app.command('/mci-ask', async ({ command, ack, respond }) => {
    await ack();

    const question = command.text?.trim();
    if (!question) {
      await respond({ text: 'Usage: `/mci-ask <your question about pipelines>`' });
      return;
    }

    try {
      const response = await chat(command.user_id, question);
      await respond({
        text: response.text,
        response_type: 'ephemeral', // Only visible to the user who asked
      });
    } catch (err) {
      await respond({ text: `Error: ${err.message}` });
    }
  });

  // /mci-summary — force a morning summary post now
  app.command('/mci-summary', async ({ command, ack, respond, client }) => {
    await ack();
    try {
      await respond({ text: '📊 Generating and posting pipeline summary...' });
      await postMorningSummary(client);
    } catch (err) {
      await respond({ text: `Failed to post summary: ${err.message}` });
    }
  });
}

module.exports = { registerShortcuts };
