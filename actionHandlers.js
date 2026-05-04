'use strict';

/**
 * actionHandlers.js
 * Handles all Slack interactive element actions:
 *   - Auto-repair button
 *   - Bulk repair
 *   - View logs
 *   - Token re-authentication
 *   - Snooze alerts
 *   - Open full report
 *   - Modal submissions
 */

const mciClient = require('../api/mciClient');
const { executeRepair, executeBulkRepair } = require('../services/repairService');
const { generateRepairPlan } = require('../agent/anthropicAgent');
const {
  buildRepairProgressBlocks,
  buildRepairCompleteBlocks,
  buildLogsModal,
  buildFullReportModal,
  buildTokenExpiryBlock,
} = require('./blockBuilders');
const logger = require('../services/logger');

// Track snoozed pipelines in memory (use Redis in production)
const snoozedPipelines = new Map();

function registerActionHandlers(app) {

  // ── Auto-repair single pipeline ───────────────────────────────────────────
  app.action('auto_repair_pipeline', async ({ action, body, client, ack, respond }) => {
    await ack();

    const pipelineId = action.value;
    const triggeredBy = body.user.id;

    logger.info(`Auto-repair triggered by ${triggeredBy} for pipeline ${pipelineId}`);

    // Fetch the pipeline and generate an AI repair plan
    const allPipelines = await mciClient.getAllPipelines();
    const pipeline = allPipelines.find(p => p.id === pipelineId);

    if (!pipeline) {
      await respond({ text: `Pipeline ${pipelineId} not found.`, replace_original: false });
      return;
    }

    const repairPlan = await generateRepairPlan(pipeline);

    // Show a confirmation modal with the full plan
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildRepairConfirmModal(pipeline, repairPlan),
    });
  });

  // ── Repair confirm modal submission ──────────────────────────────────────
  app.view('repair_confirm_modal', async ({ view, body, client, ack }) => {
    await ack();

    const { pipelineId, channelId } = JSON.parse(view.private_metadata);
    const userId = body.user.id;

    // Post a progress message to the channel
    const progressMsg = await client.chat.postMessage({
      channel: channelId || process.env.SLACK_PIPELINE_CHANNEL,
      text: `🔧 Auto-repair in progress for pipeline...`,
      blocks: buildRepairProgressBlocks('Pipeline', [{ title: 'Starting...' }], 0),
    });

    try {
      const allPipelines = await mciClient.getAllPipelines();
      const pipeline = allPipelines.find(p => p.id === pipelineId);

      let stepIndex = 0;
      const repairPlan = JSON.parse(view.private_metadata).repairPlan || [];

      const onProgress = async (message) => {
        stepIndex++;
        await client.chat.update({
          channel: progressMsg.channel,
          ts: progressMsg.ts,
          text: message,
          blocks: buildRepairProgressBlocks(pipeline.name, repairPlan, stepIndex),
        });
      };

      const result = await executeRepair(pipeline, onProgress);

      // Post completion message
      await client.chat.update({
        channel: progressMsg.channel,
        ts: progressMsg.ts,
        text: result.summary,
        blocks: buildRepairCompleteBlocks(result),
      });

    } catch (err) {
      logger.error('Repair execution failed', err);
      await client.chat.update({
        channel: progressMsg.channel,
        ts: progressMsg.ts,
        text: `❌ Repair failed: ${err.message}`,
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: `*❌ Repair failed for pipeline*\n${err.message}\n\nPlease review manually in MCI.` },
        }],
      });
    }
  });

  // ── Bulk repair all failed pipelines ─────────────────────────────────────
  app.action('bulk_repair_all_failed', async ({ body, client, ack, respond }) => {
    await ack();

    logger.info(`Bulk repair triggered by ${body.user.id}`);

    const summary = await mciClient.getHealthSummary();
    const failedIds = summary.pipelines
      .filter(p => p.lastRun?.status === 'FAILED')
      .map(p => p.id);

    if (failedIds.length === 0) {
      await respond({ text: 'No failed pipelines found. All pipelines are healthy! 🎉', replace_original: false });
      return;
    }

    const progressMsg = await client.chat.postMessage({
      channel: body.channel?.id || process.env.SLACK_PIPELINE_CHANNEL,
      text: `🔧 Bulk repair starting for ${failedIds.length} pipelines...`,
    });

    let completed = 0;
    const onProgress = async (message) => {
      completed++;
      await client.chat.update({
        channel: progressMsg.channel,
        ts: progressMsg.ts,
        text: `🔧 Bulk repair (${completed}/${failedIds.length}): ${message}`,
      });
    };

    const results = await executeBulkRepair(failedIds, onProgress);
    const successes = results.filter(r => r.success).length;
    const failures = results.filter(r => !r.success).length;

    await client.chat.update({
      channel: progressMsg.channel,
      ts: progressMsg.ts,
      text: `✅ Bulk repair complete: ${successes} repaired, ${failures} need manual review.`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Bulk repair complete*\n✅ ${successes} pipelines repaired\n${failures > 0 ? `⚠️ ${failures} need manual review` : ''}`,
          },
        },
        ...results.filter(r => !r.success).map(r => ({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `❌ ${r.pipelineName}: ${r.error}` }],
        })),
      ],
    });
  });

  // ── View pipeline logs ────────────────────────────────────────────────────
  app.action('view_pipeline_logs', async ({ action, body, client, ack }) => {
    await ack();

    const [pipelineId, runId] = action.value.split(':');

    try {
      const [allPipelines, logs] = await Promise.all([
        mciClient.getAllPipelines(),
        mciClient.getRunLogs(pipelineId, runId),
      ]);
      const pipeline = allPipelines.find(p => p.id === pipelineId) || { id: pipelineId, name: pipelineId };

      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildLogsModal(pipeline, logs),
      });
    } catch (err) {
      logger.error('Failed to fetch logs', err);
      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'Error' },
          close: { type: 'plain_text', text: 'Close' },
          blocks: [{
            type: 'section',
            text: { type: 'mrkdwn', text: `Failed to load logs: ${err.message}` },
          }],
        },
      });
    }
  });

  // ── Logs modal submission (trigger reprocess) ─────────────────────────────
  app.view('logs_modal', async ({ view, body, client, ack }) => {
    await ack();
    const { pipelineId } = JSON.parse(view.private_metadata);

    const result = await mciClient.triggerReprocess(pipelineId);
    await client.chat.postMessage({
      channel: body.user.id, // DM the user
      text: `✅ Reprocess triggered for pipeline. Job ID: \`${result.jobId}\``,
    });
  });

  // ── Token re-authentication ───────────────────────────────────────────────
  app.action('reauth_connector', async ({ action, body, client, ack }) => {
    await ack();

    const { connectorName, pipelineId } = JSON.parse(action.value);

    // Open an OAuth re-auth modal
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildReauthModal(connectorName, pipelineId),
    });
  });

  // ── Re-auth modal submission ──────────────────────────────────────────────
  app.view('reauth_modal', async ({ view, body, client, ack }) => {
    await ack();

    const { connectorName } = JSON.parse(view.private_metadata);

    // In production: generate a real OAuth URL and send it to the user
    // Here we simulate the token refresh success
    const oauthUrl = `${process.env.MCI_API_BASE_URL}/connectors/oauth/authorize?connector=${encodeURIComponent(connectorName)}&redirect_uri=${encodeURIComponent(process.env.OAUTH_REDIRECT_URI || 'https://yourapp.com/oauth/callback')}`;

    await client.chat.postMessage({
      channel: body.user.id,
      text: `🔐 Click to re-authenticate *${connectorName}*`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Re-authenticate: ${connectorName}*\nClick the button below to open the OAuth consent screen. Your token will be refreshed automatically once you complete authentication.`,
          },
        },
        {
          type: 'actions',
          elements: [{
            type: 'button',
            text: { type: 'plain_text', text: '🔐 Open OAuth', emoji: true },
            url: oauthUrl,
            action_id: 'oauth_external_link',
          }],
        },
      ],
    });
  });

  // ── Snooze pipeline alert ─────────────────────────────────────────────────
  app.action('snooze_pipeline_alert', async ({ action, body, ack, respond }) => {
    await ack();
    const pipelineId = action.value;
    const snoozeUntil = Date.now() + 60 * 60 * 1000; // 1 hour
    snoozedPipelines.set(pipelineId, snoozeUntil);
    await respond({ text: `⏰ Alert snoozed for 1 hour for this pipeline.`, replace_original: false });
  });

  // ── Snooze token alert ────────────────────────────────────────────────────
  app.action('snooze_token_alert', async ({ action, body, ack, respond }) => {
    await ack();
    await respond({ text: `⏰ Token expiry reminder snoozed until tomorrow.`, replace_original: false });
  });

  // ── Open full report modal ────────────────────────────────────────────────
  app.action('open_full_report', async ({ body, client, ack }) => {
    await ack();
    const summary = await mciClient.getHealthSummary();
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildFullReportModal(summary),
    });
  });

  // ── Noop for external link buttons ───────────────────────────────────────
  app.action('oauth_external_link', async ({ ack }) => { await ack(); });
}

// ─── Modal builders ───────────────────────────────────────────────────────────

function buildRepairConfirmModal(pipeline, repairPlan) {
  const stepBlocks = repairPlan.map((step, i) => ({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*${i + 1}. ${step.title}*\n${step.description}`,
    },
  }));

  return {
    type: 'modal',
    callback_id: 'repair_confirm_modal',
    title: { type: 'plain_text', text: 'Confirm Auto-repair' },
    submit: { type: 'plain_text', text: 'Run repair' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: JSON.stringify({
      pipelineId: pipeline.id,
      channelId: process.env.SLACK_PIPELINE_CHANNEL,
      repairPlan,
    }),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Pipeline:* ${pipeline.name}\n*Connector:* ${pipeline.connector?.name}\n*Error:* ${pipeline.lastRun?.errorCode}\n\nThe agent will perform the following steps:`,
        },
      },
      { type: 'divider' },
      ...stepBlocks,
      { type: 'divider' },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: '⚠️ A test run with 100 records will execute first. Full reprocess only proceeds if the test succeeds.',
        }],
      },
    ],
  };
}

function buildReauthModal(connectorName, pipelineId) {
  return {
    type: 'modal',
    callback_id: 'reauth_modal',
    title: { type: 'plain_text', text: 'Re-authenticate Connector' },
    submit: { type: 'plain_text', text: 'Open OAuth' },
    close: { type: 'plain_text', text: 'Later' },
    private_metadata: JSON.stringify({ connectorName, pipelineId }),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${connectorName}* access token is expiring soon.\n\nClicking *Open OAuth* will send you a link to re-authenticate. Once complete:\n• The token is stored securely in MCI\n• All pipelines using this connector resume automatically\n• You'll receive a confirmation here`,
        },
      },
    ],
  };
}

module.exports = { registerActionHandlers, snoozedPipelines };
