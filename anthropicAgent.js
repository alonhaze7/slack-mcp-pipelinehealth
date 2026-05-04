'use strict';

/**
 * anthropicAgent.js
 * Powers the "Ask the agent" canvas chat and the repair plan generator.
 * Uses Claude claude-sonnet-4-20250514 with full pipeline context injected as system prompt.
 */

const Anthropic = require('@anthropic-ai/sdk');
const mciClient = require('../api/mciClient');
const logger = require('../services/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Per-user conversation history (in-memory; use Redis in production)
const conversationHistory = new Map();

// ─── System Prompt Builder ───────────────────────────────────────────────────
async function buildSystemPrompt() {
  const summary = await mciClient.getHealthSummary();
  const now = new Date().toLocaleString('en-US', {
    timeZone: process.env.TIMEZONE || 'UTC',
    dateStyle: 'full',
    timeStyle: 'short',
  });

  const failedPipelines = summary.pipelines
    .filter(p => p.lastRun?.status === 'FAILED')
    .map(p => `- ${p.name} (${p.connector?.name}): ${p.lastRun?.errorMessage || p.lastRun?.errorCode}`)
    .join('\n');

  const warningPipelines = summary.pipelines
    .filter(p => p.lastRun?.status === 'PARTIAL')
    .map(p => `- ${p.name}: ${p.lastRun?.successRate}% success rate, ${p.lastRun?.failedRecords} failed records`)
    .join('\n');

  const expiringTokens = summary.expiringTokens
    .map(t => `- ${t.connectorName} (${t.pipelineName}): expires in ${t.daysUntilExpiry} days`)
    .join('\n');

  return `You are the MCI Pipeline Intelligence Agent — an expert assistant embedded in Slack for the Marketing Cloud Intelligence (Datorama) platform.

Current date/time: ${now}
Overall health score: ${summary.healthScore}/100
Total pipelines: ${summary.total} (${summary.successful} healthy, ${summary.failed} failed, ${summary.warnings} warnings)

FAILED PIPELINES:
${failedPipelines || 'None'}

PIPELINES WITH WARNINGS:
${warningPipelines || 'None'}

EXPIRING TOKENS (≤7 days):
${expiringTokens || 'None'}

Your expertise covers:
- MCI/Datorama connector architecture and data pipeline mechanics
- Meta/Facebook Graph API and Marketing API deprecations (v16 → v19, Media Views migration)
- Google Ads API, DV360, Campaign Manager auth flows
- Pipeline failure diagnosis, root cause analysis, and remediation steps
- OAuth token management and re-authentication flows
- Data quality, record completeness, and reprocessing strategies

Guidelines:
- Be concise and actionable. Slack messages should be short.
- When diagnosing failures, always state: what failed, why, what records are affected, and what to do.
- When suggesting repairs, describe exactly what the auto-repair will do before the user confirms.
- Format responses for Slack: use plain text, avoid markdown tables (use bullet lists instead).
- If you don't have enough data to answer confidently, say so and suggest what to check.
- Never make up pipeline names, record counts, or API details that aren't in the context above.`;
}

// ─── Main Chat Function ──────────────────────────────────────────────────────

/**
 * Chat with the pipeline agent. Maintains per-user conversation history.
 * @param {string} userId - Slack user ID (for conversation threading)
 * @param {string} message - User's question
 * @param {number} maxHistoryTurns - How many prior turns to keep in context
 */
async function chat(userId, message, maxHistoryTurns = 10) {
  try {
    const systemPrompt = await buildSystemPrompt();

    // Get or init conversation history for this user
    if (!conversationHistory.has(userId)) {
      conversationHistory.set(userId, []);
    }
    const history = conversationHistory.get(userId);

    // Add user message
    history.push({ role: 'user', content: message });

    // Trim history to keep context window manageable
    const trimmedHistory = history.slice(-maxHistoryTurns * 2);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: trimmedHistory,
    });

    const assistantMessage = response.content[0].text;

    // Save assistant reply to history
    history.push({ role: 'assistant', content: assistantMessage });

    // Cap history size
    if (history.length > maxHistoryTurns * 2 + 2) {
      history.splice(0, 2);
    }

    return { text: assistantMessage, usage: response.usage };
  } catch (err) {
    logger.error('Anthropic chat error', err);
    throw err;
  }
}

/**
 * Clear conversation history for a user (e.g. when they type "reset" or "new chat").
 */
function clearHistory(userId) {
  conversationHistory.delete(userId);
}

// ─── Repair Plan Generator ───────────────────────────────────────────────────

/**
 * Generate a detailed repair plan for a failed pipeline.
 * Returns structured steps that are shown in the Slack confirm modal.
 */
async function generateRepairPlan(pipeline) {
  const systemPrompt = `You are an MCI automation engine. Generate a precise, ordered repair plan for a failed MCI pipeline.
Return ONLY a JSON array of step objects: [{ "title": "...", "description": "...", "action": "api_call|field_remap|reprocess|token_refresh|test_run" }]
Be specific about field names, API versions, and endpoints. Maximum 5 steps.`;

  const userPrompt = `Pipeline: ${pipeline.name}
Connector: ${pipeline.connector?.name} (type: ${pipeline.connector?.type})
Error: ${pipeline.lastRun?.errorCode} — ${pipeline.lastRun?.errorMessage}
Failed records: ${pipeline.lastRun?.failedRecords || 'all'}
Last successful run: ${pipeline.lastRun?.lastSuccessAt || 'unknown'}

Generate the repair plan.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content[0].text.trim();
    const jsonStr = text.replace(/```json|```/g, '').trim();
    return JSON.parse(jsonStr);
  } catch (err) {
    logger.error('Failed to generate repair plan', err);
    // Fallback plan
    return [
      { title: 'Diagnose failure', description: 'Inspect error logs to confirm root cause', action: 'api_call' },
      { title: 'Apply fix', description: 'Update connector configuration based on error type', action: 'field_remap' },
      { title: 'Test run', description: 'Execute a test with 100 records to validate fix', action: 'test_run' },
      { title: 'Full reprocess', description: 'Reprocess all records from the failed window', action: 'reprocess' },
    ];
  }
}

/**
 * Summarise a set of pipeline runs in natural language (used for the morning summary narrative).
 */
async function generateMorningSummaryNarrative(summary) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Write a 2-sentence morning briefing for the data team about MCI pipeline health.
Health score: ${summary.healthScore}/100. 
Total: ${summary.total} pipelines. 
Successful: ${summary.successful}. Failed: ${summary.failed}. Warnings: ${summary.warnings}.
Expiring tokens: ${summary.expiringTokens.length}.
${summary.failed > 0 ? `Failed pipeline issues: ${Object.entries(summary.failureReasons).map(([k,v]) => `${k} (${v})`).join(', ')}` : ''}
Keep it concise and factual. No greetings.`,
    }],
  });
  return response.content[0].text;
}

module.exports = { chat, clearHistory, generateRepairPlan, generateMorningSummaryNarrative };
