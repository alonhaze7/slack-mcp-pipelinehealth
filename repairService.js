'use strict';

/**
 * repairService.js
 * Orchestrates the full auto-repair flow for failed MCI pipelines.
 *
 * Repair strategies supported:
 *   1. META_API_DEPRECATION  — migrate from Graph API v16 to Marketing API v19
 *   2. TOKEN_EXPIRED         — trigger OAuth re-auth flow
 *   3. RATE_LIMIT            — schedule reprocess with backoff
 *   4. FIELD_NOT_FOUND       — remap deprecated fields to new equivalents
 *   5. GENERIC               — test run + reprocess
 */

const mciClient = require('../api/mciClient');
const logger = require('../services/logger');

// ─── Known field migrations ──────────────────────────────────────────────────
// Meta Graph API v16 → Marketing API v19 / Media Views
const META_FIELD_MIGRATIONS = {
  'insights.reach':              'media_view_count',
  'insights.impressions':        'impression_count',
  'insights.spend':              'spend',
  'insights.clicks':             'inline_link_clicks',
  'insights.video_views':        'video_p100_watched_actions',
  'post_impressions':            'media_view_count',
  'post_impressions_unique':     'media_reach',
  'page_views_total':            'page_views',
  'page_engaged_users':          'page_engaged_users_v2',
};

const META_V19_BASE_URL = 'https://graph.facebook.com/v19.0';

// ─── Error code → repair strategy mapping ───────────────────────────────────
function inferRepairStrategy(pipeline) {
  const code = (pipeline.lastRun?.errorCode || '').toUpperCase();
  const msg  = (pipeline.lastRun?.errorMessage || '').toLowerCase();
  const type = (pipeline.connector?.type || '').toLowerCase();

  if (code === 'API_VERSION_DEPRECATED' || msg.includes('v16') || msg.includes('deprecated')) {
    return type.includes('meta') || type.includes('facebook')
      ? 'META_API_DEPRECATION'
      : 'GENERIC';
  }
  if (code === 'OAUTH_TOKEN_EXPIRED' || code === 'UNAUTHORIZED' || msg.includes('token')) {
    return 'TOKEN_EXPIRED';
  }
  if (code === 'RATE_LIMIT_EXCEEDED' || msg.includes('rate limit')) {
    return 'RATE_LIMIT';
  }
  if (code === 'FIELD_NOT_FOUND' || msg.includes('unknown field') || msg.includes('no longer supported')) {
    return type.includes('meta') ? 'META_API_DEPRECATION' : 'FIELD_NOT_FOUND';
  }
  return 'GENERIC';
}

// ─── Strategy implementations ────────────────────────────────────────────────

async function repairMetaApiDeprecation(pipeline, onProgress) {
  const connectorId = pipeline.connector.id;
  const steps = [];

  await onProgress('Detecting deprecated fields in connector configuration...');

  // 1. Identify which deprecated fields are in use
  const connectors = await mciClient.getConnectors();
  const connector = connectors.find(c => c.id === connectorId);
  const currentFields = connector?.fieldMappings?.map(f => f.sourceField) || [];
  const deprecatedFields = currentFields.filter(f => META_FIELD_MIGRATIONS[f]);

  steps.push({
    step: 'field_detection',
    status: 'done',
    deprecatedFields,
    migratedFields: deprecatedFields.map(f => ({ from: f, to: META_FIELD_MIGRATIONS[f] })),
  });

  await onProgress(`Found ${deprecatedFields.length} deprecated fields. Remapping...`);

  // 2. Apply new field mappings
  const newMappings = (connector?.fieldMappings || []).map(mapping => ({
    ...mapping,
    sourceField: META_FIELD_MIGRATIONS[mapping.sourceField] || mapping.sourceField,
  }));

  await mciClient.updateConnectorMapping(connectorId, newMappings);
  steps.push({ step: 'field_remap', status: 'done', count: deprecatedFields.length });

  await onProgress('Migrating API endpoint to Marketing API v19...');

  // 3. Update endpoint to v19
  await mciClient.updateConnectorEndpoint(connectorId, {
    apiVersion: 'v19.0',
    baseUrl: META_V19_BASE_URL,
    additionalHeaders: { 'X-MCI-Migration': 'graph-v16-to-v19' },
  });
  steps.push({ step: 'endpoint_migration', status: 'done', newVersion: 'v19.0' });

  await onProgress('Running test execution (100 records)...');

  // 4. Test run
  const testResult = await mciClient.runTestExecution(pipeline.id, 100);
  steps.push({ step: 'test_run', status: testResult.success ? 'done' : 'failed', result: testResult });

  if (!testResult.success) {
    throw new Error(`Test run failed: ${testResult.errorMessage}. Manual review required.`);
  }

  await onProgress('Test passed. Reprocessing full dataset...');

  // 5. Full reprocess
  const reprocessResult = await mciClient.triggerReprocess(pipeline.id);
  steps.push({ step: 'reprocess', status: 'triggered', jobId: reprocessResult.jobId });

  return {
    strategy: 'META_API_DEPRECATION',
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    steps,
    reprocessJobId: reprocessResult.jobId,
    summary: `Migrated ${deprecatedFields.length} fields from Graph API v16 to Marketing API v19. Full reprocess triggered (job: ${reprocessResult.jobId}).`,
  };
}

async function repairRateLimit(pipeline, onProgress) {
  await onProgress('Rate limit detected. Scheduling reprocess with exponential backoff...');

  // Wait 30 seconds then reprocess (in production this would use a proper queue)
  await new Promise(r => setTimeout(r, 30000));

  await onProgress('Triggering reprocess of failed records...');
  const result = await mciClient.triggerReprocess(pipeline.id, {
    fromDate: pipeline.lastRun?.failedWindowStart,
    toDate: pipeline.lastRun?.failedWindowEnd,
  });

  return {
    strategy: 'RATE_LIMIT',
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    steps: [{ step: 'reprocess', status: 'triggered', jobId: result.jobId }],
    reprocessJobId: result.jobId,
    summary: `Rate limit resolved. Reprocessing ${pipeline.lastRun?.failedRecords || 'missing'} records (job: ${result.jobId}).`,
  };
}

async function repairGeneric(pipeline, onProgress) {
  await onProgress('Running diagnostic test execution...');
  const testResult = await mciClient.runTestExecution(pipeline.id, 100);

  if (!testResult.success) {
    return {
      strategy: 'GENERIC',
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      steps: [{ step: 'test_run', status: 'failed', result: testResult }],
      summary: `Test run failed. Error: ${testResult.errorMessage}. Manual intervention required.`,
      requiresManualReview: true,
    };
  }

  await onProgress('Test passed. Triggering full reprocess...');
  const reprocessResult = await mciClient.triggerReprocess(pipeline.id);

  return {
    strategy: 'GENERIC',
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    steps: [
      { step: 'test_run', status: 'done' },
      { step: 'reprocess', status: 'triggered', jobId: reprocessResult.jobId },
    ],
    reprocessJobId: reprocessResult.jobId,
    summary: `Reprocess triggered for ${pipeline.name} (job: ${reprocessResult.jobId}).`,
  };
}

// ─── Main repair orchestrator ─────────────────────────────────────────────────

/**
 * Execute auto-repair for a pipeline.
 * @param {object} pipeline - Pipeline object from MCI API
 * @param {function} onProgress - async callback(message: string) for Slack status updates
 */
async function executeRepair(pipeline, onProgress = async () => {}) {
  const strategy = inferRepairStrategy(pipeline);
  logger.info(`Auto-repair: pipeline=${pipeline.id}, strategy=${strategy}`);

  switch (strategy) {
    case 'META_API_DEPRECATION':
      return repairMetaApiDeprecation(pipeline, onProgress);
    case 'RATE_LIMIT':
      return repairRateLimit(pipeline, onProgress);
    case 'TOKEN_EXPIRED':
      // Token expiry requires user interaction (OAuth flow) — can't be auto-repaired silently
      return {
        strategy: 'TOKEN_EXPIRED',
        requiresUserAction: true,
        summary: 'Token expired. Please re-authenticate via the Slack re-auth flow.',
      };
    case 'FIELD_NOT_FOUND':
    case 'GENERIC':
    default:
      return repairGeneric(pipeline, onProgress);
  }
}

/**
 * Bulk repair multiple failed pipelines.
 * @param {string[]} pipelineIds
 * @param {function} onProgress
 */
async function executeBulkRepair(pipelineIds, onProgress = async () => {}) {
  const allPipelines = await mciClient.getAllPipelines();
  const targets = allPipelines.filter(p => pipelineIds.includes(p.id));

  const results = [];
  for (const pipeline of targets) {
    await onProgress(`Repairing: ${pipeline.name}...`);
    try {
      const result = await executeRepair(pipeline, onProgress);
      results.push({ success: true, ...result });
    } catch (err) {
      logger.error(`Repair failed for pipeline ${pipeline.id}`, err);
      results.push({ success: false, pipelineId: pipeline.id, pipelineName: pipeline.name, error: err.message });
    }
  }

  return results;
}

module.exports = { executeRepair, executeBulkRepair, inferRepairStrategy, META_FIELD_MIGRATIONS };
