'use strict';

/**
 * anthropicAgent.js
 * Powers the "Ask the agent" canvas chat and the repair plan generator.
 * Uses Claude claude-sonnet-4-20250514 with full pipeline context injected as system prompt.
 * Supports prompt caching for repeated system-prompt payloads.
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
    .map(p => `- ${p.name} (${p.connector?.name}): [${p.lastRun?.errorCode || 'ERROR'}] ${p.lastRun?.errorMessage || 'Unknown error'} | Failed records: ${p.lastRun?.failedRecords || 'all'} | Last success: ${p.lastRun?.lastSuccessAt || 'unknown'}`)
    .join('\n');

  const warningPipelines = summary.pipelines
    .filter(p => p.lastRun?.status === 'PARTIAL')
    .map(p => `- ${p.name}: ${p.lastRun?.successRate}% success rate, ${p.lastRun?.failedRecords} failed records`)
    .join('\n');

  const expiringTokens = summary.expiringTokens
    .map(t => `- ${t.connectorName} (${t.pipelineName}): expires in ${t.daysUntilExpiry} days on ${new Date(t.expiresAt).toLocaleDateString()}`)
    .join('\n');

  const workspaceBreakdown = summary.pipelines.reduce((acc, p) => {
    const ws = p.workspaceId || 'default';
    if (!acc[ws]) acc[ws] = { total: 0, failed: 0, warnings: 0 };
    acc[ws].total++;
    if (p.lastRun?.status === 'FAILED') acc[ws].failed++;
    if (p.lastRun?.status === 'PARTIAL') acc[ws].warnings++;
    return acc;
  }, {});

  const workspaceSummary = Object.entries(workspaceBreakdown)
    .map(([ws, stats]) => `- ${ws}: ${stats.total} pipelines, ${stats.failed} failed, ${stats.warnings} warnings`)
    .join('\n');

  return `You are the MCI Pipeline Intelligence Agent — an expert assistant embedded in Slack for the Marketing Cloud Intelligence (Datorama) platform.

Current date/time: ${now}
Overall health score: ${summary.healthScore}/100
Total pipelines: ${summary.total} (${summary.successful} healthy, ${summary.failed} failed, ${summary.warnings} warnings)

WORKSPACE BREAKDOWN:
${workspaceSummary || 'No workspace data'}

FAILED PIPELINES:
${failedPipelines || 'None — all pipelines healthy'}

PIPELINES WITH WARNINGS (partial success):
${warningPipelines || 'None'}

EXPIRING TOKENS (≤7 days):
${expiringTokens || 'None'}

Your expertise covers:
- MCI/Datorama connector architecture and data pipeline mechanics
- Meta/Facebook Graph API and Marketing API deprecations (v16 → v19, Media Views migration)
- Google Ads API, DV360, Campaign Manager 360 auth flows and field structures
- TikTok, Snapchat, LinkedIn, Twitter/X API connector patterns
- Pipeline failure diagnosis, root cause analysis, and remediation steps
- OAuth token management and re-authentication flows
- Data quality, record completeness, backfill, and reprocessing strategies
- MCI workspace configuration and connector setup

Guidelines:
- Be concise and actionable. Slack messages must be short (under 500 chars).
- When diagnosing failures, always state: what failed, why, what records are affected, and what to do next.
- When suggesting repairs, describe EXACTLY what the auto-repair will do before the user confirms.
- Format responses for Slack: use plain text, emoji for status, bullet lists (not markdown tables).
- If you don't have enough data to answer confidently, say so and suggest what to check.
- Never make up pipeline names, record counts, or API details that aren't in the context above.
- For canvas Q&A: you may give longer, more detailed responses with structured breakdowns.`;
}

// ─── Main Chat Function ──────────────────────────────────────────────────────

/**
 * Chat with the pipeline agent. Maintains per-user conversation history.
 * @param {string} userId - Slack user ID (for conversation threading)
 * @param {string} message - User's question
 * @param {object} options - { maxHistoryTurns, isCanvas } canvas mode allows longer responses
 */
async function chat(userId, message, options = {}) {
  const { maxHistoryTurns = 10, isCanvas = false } = options;

  try {
    const systemPrompt = await buildSystemPrompt();

    if (!conversationHistory.has(userId)) {
      conversationHistory.set(userId, []);
    }
    const history = conversationHistory.get(userId);

    history.push({ role: 'user', content: message });

    const trimmedHistory = history.slice(-maxHistoryTurns * 2);

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: isCanvas ? 2048 : 1024,
      system: systemPrompt,
      messages: trimmedHistory,
    });

    const assistantMessage = response.content[0].text;

    history.push({ role: 'assistant', content: assistantMessage });

    if (history.length > maxHistoryTurns * 2 + 2) {
      history.splice(0, 2);
    }

    logger.info('Anthropic chat response', {
      userId,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      isCanvas,
    });

    return { text: assistantMessage, usage: response.usage };
  } catch (err) {
    logger.error('Anthropic chat error', err);
    throw err;
  }
}

/**
 * Clear conversation history for a user.
 */
function clearHistory(userId) {
  conversationHistory.delete(userId);
  logger.info(`Cleared conversation history for user ${userId}`);
}

/**
 * Get conversation history length for a user (for UI display).
 */
function getHistoryLength(userId) {
  return Math.floor((conversationHistory.get(userId)?.length || 0) / 2);
}

// ─── Repair Plan Generator ───────────────────────────────────────────────────

/**
 * Generate a detailed repair plan for a failed pipeline.
 * Returns structured steps that are shown in the Slack confirm modal.
 */
async function generateRepairPlan(pipeline) {
  const systemPrompt = `You are an MCI automation engine. Generate a precise, ordered repair plan for a failed MCI pipeline.
Return ONLY a JSON array of step objects: [{ "title": "...", "description": "...", "action": "api_call|field_remap|reprocess|token_refresh|test_run", "estimatedDuration": "~Xs" }]
Be specific about field names, API versions, endpoints, and record counts. Maximum 5 steps.`;

  const userPrompt = `Pipeline: ${pipeline.name}
Connector: ${pipeline.connector?.name} (type: ${pipeline.connector?.type})
Error code: ${pipeline.lastRun?.errorCode}
Error message: ${pipeline.lastRun?.errorMessage}
Failed records: ${pipeline.lastRun?.failedRecords || 'all'}
Expected records: ${pipeline.lastRun?.expectedRecords || 'unknown'}
Last successful run: ${pipeline.lastRun?.lastSuccessAt || 'unknown'}
Workspace: ${pipeline.workspaceId}

Generate the repair plan.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
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
      { title: 'Diagnose failure', description: 'Inspect error logs to confirm root cause', action: 'api_call', estimatedDuration: '~5s' },
      { title: 'Apply fix', description: 'Update connector configuration based on error type', action: 'field_remap', estimatedDuration: '~10s' },
      { title: 'Test run', description: 'Execute a test with 100 records to validate fix', action: 'test_run', estimatedDuration: '~30s' },
      { title: 'Full reprocess', description: 'Reprocess all records from the failed window', action: 'reprocess', estimatedDuration: '~2m' },
    ];
  }
}

/**
 * Summarise a set of pipeline runs in natural language (used for the morning summary narrative).
 */
async function generateMorningSummaryNarrative(summary) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Write a 2-sentence morning briefing for the MCI data team about pipeline health overnight.
Health score: ${summary.healthScore}/100.
Total pipelines monitored: ${summary.total}.
Successful: ${summary.successful}. Failed: ${summary.failed}. Warnings: ${summary.warnings}.
Expiring tokens: ${summary.expiringTokens.length}.
${summary.failed > 0 ? `Top failure reasons: ${Object.entries(summary.failureReasons).map(([k,v]) => `${k} (${v}x)`).join(', ')}` : ''}
${summary.expiringTokens.length > 0 ? `Connectors expiring soon: ${summary.expiringTokens.map(t => `${t.connectorName} (${t.daysUntilExpiry}d)`).join(', ')}` : ''}
Be concise and direct. No greetings. Use emojis sparingly.`,
      }],
    });
    return response.content[0].text;
  } catch (err) {
    logger.error('Failed to generate morning narrative', err);
    return `Pipeline health score is ${summary.healthScore}/100 with ${summary.failed} failed and ${summary.warnings} warnings across ${summary.total} monitored pipelines.`;
  }
}

/**
 * Generate a canvas visualisation answer (richer, with markdown structure).
 */
async function generateCanvasAnswer(userId, question) {
  return chat(userId, question, { isCanvas: true, maxHistoryTurns: 5 });
}

module.exports = {
  chat,
  clearHistory,
  getHistoryLength,
  generateRepairPlan,
  generateMorningSummaryNarrative,
  generateCanvasAnswer,
};
