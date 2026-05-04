'use strict';

/**
 * blockBuilders.js
 * Builds all Slack Block Kit message layouts used by the agent.
 *
 * Block Kit reference: https://api.slack.com/block-kit
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

const statusEmoji = (status) => ({
  SUCCESS: '🟢', FAILED: '🔴', PARTIAL: '🟡', RUNNING: '🔵', UNKNOWN: '⚪',
}[status] || '⚪');

const healthColor = (score) =>
  score >= 80 ? 'good' : score >= 60 ? 'warning' : 'danger';

/**
 * Render a 7-run history as colored emoji dots.
 */
function runHistoryDots(runs = []) {
  return runs.slice(-7).map(r => ({
    SUCCESS: '🟩', FAILED: '🟥', PARTIAL: '🟨',
  }[r.status] || '⬜').join('');
}

// ─── Morning Summary ──────────────────────────────────────────────────────────

function buildMorningSummaryBlocks(summary, narrative) {
  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: process.env.TIMEZONE || 'UTC',
  });

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📊 MCI Pipeline Morning Summary`, emoji: true },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*${date}* · ${summary.total} pipelines monitored · Health score: *${summary.healthScore}/100*` }],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: narrative },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*🟢 Successful*\n${summary.successful} pipelines` },
        { type: 'mrkdwn', text: `*🔴 Failed*\n${summary.failed} pipelines` },
        { type: 'mrkdwn', text: `*🟡 Warnings*\n${summary.warnings} pipelines` },
        { type: 'mrkdwn', text: `*🔑 Expiring tokens*\n${summary.expiringTokens.length} connectors` },
      ],
    },
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '📋 Full report', emoji: true },
          action_id: 'open_full_report',
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔧 Repair all failed', emoji: true },
          action_id: 'bulk_repair_all_failed',
          style: 'danger',
          confirm: {
            title: { type: 'plain_text', text: 'Repair all failed pipelines?' },
            text: { type: 'mrkdwn', text: `This will attempt to auto-repair *${summary.failed} failed pipelines*. A test run will be executed before any reprocessing.` },
            confirm: { type: 'plain_text', text: 'Yes, repair all' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
      ],
    },
  ];
}

// ─── Failure Alert ────────────────────────────────────────────────────────────

function buildFailureAlertBlocks(pipeline) {
  const run = pipeline.lastRun || {};
  const dots = runHistoryDots(pipeline.runHistory || []);

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🔴 Pipeline failure: ${pipeline.name}*\n${pipeline.connector?.name || 'Unknown connector'} · Workspace: ${pipeline.workspaceName || pipeline.workspaceId}`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Status*\n${statusEmoji(run.status)} ${run.status || 'FAILED'}` },
        { type: 'mrkdwn', text: `*Last run*\n${run.startedAt ? new Date(run.startedAt).toLocaleTimeString() : 'Unknown'}` },
        { type: 'mrkdwn', text: `*Records*\n0 / ${run.expectedRecords?.toLocaleString() || 'Unknown'} loaded` },
        { type: 'mrkdwn', text: `*7-day history*\n${dots || '(no history)'}` },
      ],
    },
  ];

  if (run.errorMessage) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error*\n\`${run.errorCode || 'ERROR'}\` — ${run.errorMessage}`,
      },
    });
  }

  if (run.suggestedFix) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `💡 *Suggested fix:* ${run.suggestedFix}` }],
    });
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '🔧 Auto-repair', emoji: true },
        action_id: 'auto_repair_pipeline',
        value: pipeline.id,
        style: 'primary',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '📄 View logs', emoji: true },
        action_id: 'view_pipeline_logs',
        value: `${pipeline.id}:${run.id}`,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '⏰ Snooze 1h', emoji: true },
        action_id: 'snooze_pipeline_alert',
        value: pipeline.id,
      },
    ],
  });

  return blocks;
}

// ─── Token Expiry ─────────────────────────────────────────────────────────────

function buildTokenExpiryBlock(token, urgent = false) {
  const expiryDate = new Date(token.expiresAt).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    timeZone: process.env.TIMEZONE || 'UTC',
  });

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${urgent ? '🚨' : '🔑'} *Token expiry ${urgent ? 'imminent' : 'warning'}: ${token.connectorName}*\nExpires *${expiryDate}* (${token.daysUntilExpiry} day${token.daysUntilExpiry !== 1 ? 's' : ''} remaining). Pipeline: _${token.pipelineName}_`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔐 Re-authenticate now', emoji: true },
          action_id: 'reauth_connector',
          value: JSON.stringify({ connectorName: token.connectorName, pipelineId: token.pipelineId }),
          style: urgent ? 'danger' : 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Remind me tomorrow', emoji: true },
          action_id: 'snooze_token_alert',
          value: token.pipelineId,
        },
      ],
    },
  ];
}

// ─── Repair Progress ──────────────────────────────────────────────────────────

function buildRepairProgressBlocks(pipelineName, steps, currentStep) {
  const stepBlocks = steps.map((step, i) => {
    const icon = i < currentStep ? '✅' : i === currentStep ? '⏳' : '⬜';
    return `${icon} *${step.title}*\n${step.description}`;
  });

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🔧 Auto-repairing: ${pipelineName}*\n\n${stepBlocks.join('\n\n')}`,
      },
    },
  ];
}

function buildRepairCompleteBlocks(result) {
  const success = !result.requiresManualReview;

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: success
          ? `*✅ Repair complete: ${result.pipelineName}*\n${result.summary}`
          : `*⚠️ Repair needs manual review: ${result.pipelineName}*\n${result.summary}`,
      },
    },
    ...(result.reprocessJobId ? [{
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Reprocess job ID: \`${result.reprocessJobId}\`` }],
    }] : []),
  ];
}

// ─── Logs Modal ───────────────────────────────────────────────────────────────

function buildLogsModal(pipeline, logs) {
  const logLines = (logs.entries || [])
    .slice(-20)
    .map(e => `\`${new Date(e.timestamp).toLocaleTimeString()}\` [${e.level}] ${e.message}`)
    .join('\n');

  return {
    type: 'modal',
    callback_id: 'logs_modal',
    title: { type: 'plain_text', text: 'Pipeline Logs' },
    close: { type: 'plain_text', text: 'Close' },
    submit: { type: 'plain_text', text: 'Reprocess' },
    private_metadata: JSON.stringify({ pipelineId: pipeline.id }),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${pipeline.name}* · Last run: ${pipeline.lastRun?.startedAt ? new Date(pipeline.lastRun.startedAt).toLocaleString() : 'Unknown'}`,
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: logLines || '_No log entries found_',
        },
      },
    ],
  };
}

// ─── Full Report ──────────────────────────────────────────────────────────────

function buildFullReportModal(summary) {
  const pipelineLines = summary.pipelines.map(p => {
    const emoji = statusEmoji(p.lastRun?.status);
    const dots = runHistoryDots(p.runHistory || []);
    return `${emoji} *${p.name}* — ${p.connector?.name || '?'}\n   ${dots}  ${p.lastRun?.status || 'UNKNOWN'}`;
  }).join('\n\n');

  return {
    type: 'modal',
    callback_id: 'full_report_modal',
    title: { type: 'plain_text', text: 'Pipeline Health Report' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Health score*\n${summary.healthScore}/100` },
          { type: 'mrkdwn', text: `*Total pipelines*\n${summary.total}` },
          { type: 'mrkdwn', text: `*🟢 Successful*\n${summary.successful}` },
          { type: 'mrkdwn', text: `*🔴 Failed*\n${summary.failed}` },
        ],
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: pipelineLines || '_No pipeline data available_' },
      },
    ],
  };
}

module.exports = {
  buildMorningSummaryBlocks,
  buildFailureAlertBlocks,
  buildTokenExpiryBlock,
  buildRepairProgressBlocks,
  buildRepairCompleteBlocks,
  buildLogsModal,
  buildFullReportModal,
  runHistoryDots,
  statusEmoji,
};
