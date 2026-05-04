'use strict';

/**
 * mciClient.js
 * Wrapper around the MCI (Marketing Cloud Intelligence / Datorama) REST API.
 * All pipeline health data, connector stats, and run histories come through here.
 *
 * Docs: https://developer.salesforce.com/docs/marketing/marketing-cloud-intelligence
 */

const axios = require('axios');
const NodeCache = require('node-cache');
const logger = require('../services/logger');

const cache = new NodeCache({ stdTTL: parseInt(process.env.CACHE_TTL) || 300 });

const mciHttp = axios.create({
  baseURL: process.env.MCI_API_BASE_URL,
  headers: {
    'Authorization': `Bearer ${process.env.MCI_API_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

// ─── Request / response interceptors ────────────────────────────────────────
mciHttp.interceptors.response.use(
  (res) => res,
  (err) => {
    logger.error('MCI API error', {
      status: err.response?.status,
      url: err.config?.url,
      message: err.response?.data?.message || err.message,
    });
    return Promise.reject(err);
  }
);

// ─── Helper ─────────────────────────────────────────────────────────────────
async function cachedGet(key, fn) {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const data = await fn();
  cache.set(key, data);
  return data;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch all pipelines across all configured workspaces.
 * Returns an array of pipeline objects with run history.
 */
async function getAllPipelines() {
  return cachedGet('all_pipelines', async () => {
    const workspaceIds = process.env.MCI_WORKSPACE_IDS
      ? process.env.MCI_WORKSPACE_IDS.split(',').map(s => s.trim())
      : [process.env.MCI_WORKSPACE_ID];

    const results = await Promise.all(
      workspaceIds.map(wsId =>
        mciHttp.get(`/workspaces/${wsId}/pipelines`, {
          params: { includeRunHistory: true, runHistoryDays: 7 },
        }).then(r => r.data.pipelines.map(p => ({ ...p, workspaceId: wsId })))
      )
    );

    return results.flat();
  });
}

/**
 * Get health summary for all pipelines.
 * Returns counts + a 0-100 health score.
 */
async function getHealthSummary() {
  return cachedGet('health_summary', async () => {
    const pipelines = await getAllPipelines();

    const summary = {
      total: pipelines.length,
      successful: 0,
      failed: 0,
      warnings: 0,
      healthScore: 0,
      expiringTokens: [],
      failureReasons: {},
      pipelines,
    };

    for (const pipeline of pipelines) {
      const lastRun = pipeline.lastRun;
      if (!lastRun) continue;

      if (lastRun.status === 'SUCCESS') {
        summary.successful++;
      } else if (lastRun.status === 'FAILED') {
        summary.failed++;
        const reason = lastRun.errorCode || 'UNKNOWN';
        summary.failureReasons[reason] = (summary.failureReasons[reason] || 0) + 1;
      } else if (lastRun.status === 'PARTIAL') {
        summary.warnings++;
      }

      // Check token expiry on the connector
      if (pipeline.connector?.tokenExpiresAt) {
        const expiresAt = new Date(pipeline.connector.tokenExpiresAt);
        const daysUntilExpiry = Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24));
        if (daysUntilExpiry <= 7) {
          summary.expiringTokens.push({
            pipelineId: pipeline.id,
            pipelineName: pipeline.name,
            connectorName: pipeline.connector.name,
            expiresAt: pipeline.connector.tokenExpiresAt,
            daysUntilExpiry,
          });
        }
      }
    }

    // Health score: 100 - (failed * 10) - (warnings * 4) - (expiring_tokens * 3)
    summary.healthScore = Math.max(
      0,
      100 -
        summary.failed * 10 -
        summary.warnings * 4 -
        summary.expiringTokens.length * 3
    );

    return summary;
  });
}

/**
 * Get detailed run history for a single pipeline (default: last 30 runs).
 */
async function getPipelineRunHistory(pipelineId, limit = 30) {
  return cachedGet(`run_history_${pipelineId}`, async () => {
    const res = await mciHttp.get(`/pipelines/${pipelineId}/runs`, {
      params: { limit },
    });
    return res.data.runs;
  });
}

/**
 * Get full error logs for a specific run.
 */
async function getRunLogs(pipelineId, runId) {
  const res = await mciHttp.get(`/pipelines/${pipelineId}/runs/${runId}/logs`);
  return res.data;
}

/**
 * Get all connectors with their auth status.
 */
async function getConnectors() {
  return cachedGet('connectors', async () => {
    const res = await mciHttp.get(`/workspaces/${process.env.MCI_WORKSPACE_ID}/connectors`);
    return res.data.connectors;
  });
}

/**
 * Trigger a pipeline reprocess for a specific time window.
 * Used by auto-repair after field remapping.
 */
async function triggerReprocess(pipelineId, { fromDate, toDate } = {}) {
  logger.info(`Triggering reprocess for pipeline ${pipelineId}`, { fromDate, toDate });
  const res = await mciHttp.post(`/pipelines/${pipelineId}/reprocess`, {
    fromDate: fromDate || new Date(Date.now() - 86400000).toISOString(),
    toDate: toDate || new Date().toISOString(),
  });
  cache.del('all_pipelines');
  cache.del('health_summary');
  return res.data;
}

/**
 * Update connector field mappings (used by auto-repair for API migrations).
 */
async function updateConnectorMapping(connectorId, mappings) {
  logger.info(`Updating field mappings for connector ${connectorId}`, { mappings });
  const res = await mciHttp.put(`/connectors/${connectorId}/mappings`, { mappings });
  cache.del('all_pipelines');
  cache.del('connectors');
  return res.data;
}

/**
 * Update connector API version / endpoint (e.g. Graph API v16 → Marketing API v19).
 */
async function updateConnectorEndpoint(connectorId, { apiVersion, baseUrl, additionalHeaders }) {
  logger.info(`Migrating connector ${connectorId} to new endpoint`, { apiVersion, baseUrl });
  const res = await mciHttp.patch(`/connectors/${connectorId}/endpoint`, {
    apiVersion,
    baseUrl,
    additionalHeaders,
  });
  cache.del('connectors');
  return res.data;
}

/**
 * Refresh OAuth token for a connector (used after user re-authenticates).
 */
async function refreshConnectorToken(connectorId, oauthCode) {
  logger.info(`Refreshing OAuth token for connector ${connectorId}`);
  const res = await mciHttp.post(`/connectors/${connectorId}/token/refresh`, {
    code: oauthCode,
  });
  cache.del('connectors');
  return res.data;
}

/**
 * Run a test pipeline execution with a small record limit (validation step).
 */
async function runTestExecution(pipelineId, recordLimit = 100) {
  const res = await mciHttp.post(`/pipelines/${pipelineId}/test-run`, {
    recordLimit,
  });
  return res.data;
}

/**
 * Query pipeline data using natural language (forwarded to MCI AI endpoint if available,
 * otherwise we handle it in the agent layer with Anthropic).
 */
async function queryPipelineData(question, context = {}) {
  // MCI doesn't have a native NL endpoint — we return raw stats for the AI layer to use
  const [summary, pipelines] = await Promise.all([
    getHealthSummary(),
    getAllPipelines(),
  ]);
  return { summary, pipelines, question, context };
}

module.exports = {
  getAllPipelines,
  getHealthSummary,
  getPipelineRunHistory,
  getRunLogs,
  getConnectors,
  triggerReprocess,
  updateConnectorMapping,
  updateConnectorEndpoint,
  refreshConnectorToken,
  runTestExecution,
  queryPipelineData,
};
