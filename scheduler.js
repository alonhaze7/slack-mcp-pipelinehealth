'use strict';

/**
 * scheduler.js
 * Runs on a cron schedule to:
 *   1. Post the morning pipeline health summary to Slack
 *   2. Alert on expiring tokens (also run every 6 hours)
 *   3. Alert on newly failed pipelines (runs every 15 minutes)
 */

const { CronJob } = require('cron');
const mciClient = require('../api/mciClient');
const { generateMorningSummaryNarrative } = require('../agent/anthropicAgent');
const { buildMorningSummaryBlocks, buildTokenExpiryBlock, buildFailureAlertBlocks } = require('../slack/blockBuilders');
const logger = require('./logger');

let lastKnownFailures = new Set();

/**
 * Post the full morning health summary to Slack.
 */
async function postMorningSummary(slackClient) {
  try {
    logger.info('Running morning summary job');
    const summary = await mciClient.getHealthSummary();
    const narrative = await generateMorningSummaryNarrative(summary);
    const blocks = buildMorningSummaryBlocks(summary, narrative);

    await slackClient.chat.postMessage({
      channel: process.env.SLACK_PIPELINE_CHANNEL,
      text: `MCI Pipeline Morning Summary — Health: ${summary.healthScore}/100`,
      blocks,
      unfurl_links: false,
    });

    // If there are token expiry warnings, post them as follow-ups
    for (const token of summary.expiringTokens) {
      await slackClient.chat.postMessage({
        channel: process.env.SLACK_PIPELINE_CHANNEL,
        text: `Token expiry warning: ${token.connectorName}`,
        blocks: buildTokenExpiryBlock(token),
        unfurl_links: false,
      });
    }

    // Post individual alerts for any failed pipelines
    const failed = summary.pipelines.filter(p => p.lastRun?.status === 'FAILED');
    for (const pipeline of failed) {
      await slackClient.chat.postMessage({
        channel: process.env.SLACK_PIPELINE_CHANNEL,
        text: `Pipeline failure: ${pipeline.name}`,
        blocks: buildFailureAlertBlocks(pipeline),
        unfurl_links: false,
      });
    }

    logger.info(`Morning summary posted. Health: ${summary.healthScore}/100, Failures: ${failed.length}`);
  } catch (err) {
    logger.error('Morning summary job failed', err);
  }
}

/**
 * Poll for new pipeline failures and alert immediately.
 * Only alerts on pipelines that weren't already known to be failed.
 */
async function pollForNewFailures(slackClient) {
  try {
    const summary = await mciClient.getHealthSummary();
    const currentFailures = new Set(
      summary.pipelines
        .filter(p => p.lastRun?.status === 'FAILED')
        .map(p => p.id)
    );

    // Find newly failed pipelines
    const newFailures = [...currentFailures].filter(id => !lastKnownFailures.has(id));

    for (const pipelineId of newFailures) {
      const pipeline = summary.pipelines.find(p => p.id === pipelineId);
      if (!pipeline) continue;

      logger.warn(`New pipeline failure detected: ${pipeline.name}`);

      await slackClient.chat.postMessage({
        channel: process.env.SLACK_ALERTS_CHANNEL,
        text: `🚨 Pipeline failure: ${pipeline.name}`,
        blocks: buildFailureAlertBlocks(pipeline),
      });
    }

    lastKnownFailures = currentFailures;
  } catch (err) {
    logger.error('Failure polling job error', err);
  }
}

/**
 * Check token expiry and alert on any newly approaching deadlines.
 */
async function pollTokenExpiry(slackClient) {
  try {
    const summary = await mciClient.getHealthSummary();

    // Alert on tokens expiring within 2 days (urgent)
    const urgent = summary.expiringTokens.filter(t => t.daysUntilExpiry <= 2);
    for (const token of urgent) {
      await slackClient.chat.postMessage({
        channel: process.env.SLACK_PIPELINE_CHANNEL,
        text: `🔑 Urgent: ${token.connectorName} token expires in ${token.daysUntilExpiry} day(s)`,
        blocks: buildTokenExpiryBlock(token, true),
      });
    }
  } catch (err) {
    logger.error('Token expiry polling error', err);
  }
}

/**
 * Start all scheduled jobs.
 * @param {object} slackClient - Slack WebClient instance from Bolt
 */
function startScheduler(slackClient) {
  const tz = process.env.TIMEZONE || 'UTC';

  // Morning summary: weekdays at 8 AM (configurable)
  new CronJob(
    process.env.MORNING_SUMMARY_CRON || '0 8 * * 1-5',
    () => postMorningSummary(slackClient),
    null, true, tz
  );

  // Pipeline failure polling: every 15 minutes
  new CronJob(
    '*/15 * * * *',
    () => pollForNewFailures(slackClient),
    null, true, tz
  );

  // Token expiry check: every 6 hours
  new CronJob(
    '0 */6 * * *',
    () => pollTokenExpiry(slackClient),
    null, true, tz
  );

  logger.info('All scheduler jobs started', { tz });
}

module.exports = { startScheduler, postMorningSummary };
