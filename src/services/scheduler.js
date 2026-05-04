'use strict';

/**
 * scheduler.js
 * Cron-scheduled jobs:
 *   1. Morning pipeline health summary (weekdays 8 AM)
 *   2. Real-time failure polling (every 15 min)
 *   3. Token expiry alerts (every 6 hours)
 */

const { CronJob } = require('cron');
const mciClient = require('../api/mciClient');
const { generateMorningSummaryNarrative } = require('../agent/anthropicAgent');
const {
  buildMorningSummaryBlocks,
  buildTokenExpiryBlock,
  buildFailureAlertBlocks,
} = require('../slack/blockBuilders');
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
      text: `☀️ MCI Pipeline Morning Summary — Health: ${summary.healthScore}/100`,
      blocks,
      unfurl_links: false,
    });

    // Post token expiry warnings as follow-ups
    for (const token of summary.expiringTokens) {
      const urgent = token.daysUntilExpiry <= 2;
      await slackClient.chat.postMessage({
        channel: process.env.SLACK_PIPELINE_CHANNEL,
        text: `${urgent ? '🚨' : '🔑'} Token expiry ${urgent ? 'URGENT' : 'warning'}: ${token.connectorName} — ${token.daysUntilExpiry} day(s) left`,
        blocks: buildTokenExpiryBlock(token, urgent),
        unfurl_links: false,
      });
    }

    // Post individual failure cards
    const failed = summary.pipelines.filter(p => p.lastRun?.status === 'FAILED');
    for (const pipeline of failed) {
      await slackClient.chat.postMessage({
        channel: process.env.SLACK_PIPELINE_CHANNEL,
        text: `🔴 Pipeline failure: ${pipeline.name}`,
        blocks: buildFailureAlertBlocks(pipeline),
        unfurl_links: false,
      });
    }

    logger.info(`Morning summary posted`, {
      healthScore: summary.healthScore,
      total: summary.total,
      failed: failed.length,
      expiringTokens: summary.expiringTokens.length,
    });
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

    const newFailures = [...currentFailures].filter(id => !lastKnownFailures.has(id));

    for (const pipelineId of newFailures) {
      const pipeline = summary.pipelines.find(p => p.id === pipelineId);
      if (!pipeline) continue;

      logger.warn(`New pipeline failure detected: ${pipeline.name}`);

      await slackClient.chat.postMessage({
        channel: process.env.SLACK_ALERTS_CHANNEL || process.env.SLACK_PIPELINE_CHANNEL,
        text: `🚨 NEW failure: ${pipeline.name}`,
        blocks: buildFailureAlertBlocks(pipeline),
      });
    }

    // Also check for pipelines that recovered (were failing, now healthy)
    const recovered = [...lastKnownFailures].filter(id => !currentFailures.has(id));
    for (const pipelineId of recovered) {
      await slackClient.chat.postMessage({
        channel: process.env.SLACK_ALERTS_CHANNEL || process.env.SLACK_PIPELINE_CHANNEL,
        text: `✅ Pipeline recovered: ${pipelineId}`,
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: `*✅ Pipeline recovered*\nPipeline \`${pipelineId}\` is now running successfully.` },
        }],
      });
    }

    lastKnownFailures = currentFailures;
  } catch (err) {
    logger.error('Failure polling job error', err);
  }
}

/**
 * Check token expiry and alert on urgent tokens (≤2 days).
 */
async function pollTokenExpiry(slackClient) {
  try {
    const summary = await mciClient.getHealthSummary();

    const urgent = summary.expiringTokens.filter(t => t.daysUntilExpiry <= 2);
    for (const token of urgent) {
      await slackClient.chat.postMessage({
        channel: process.env.SLACK_PIPELINE_CHANNEL,
        text: `🚨 URGENT: ${token.connectorName} token expires in ${token.daysUntilExpiry} day(s)`,
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

module.exports = { startScheduler, postMorningSummary, pollForNewFailures, pollTokenExpiry };
