'use strict';

/**
 * homeTab.js
 * Registers the Slack App Home tab.
 * This is the primary interactive dashboard users see when they open the bot's DM.
 * Shows pipeline health, failed pipelines with repair buttons, token alerts, and canvas links.
 */

const mciClient = require('../api/mciClient');
const { generateMorningSummaryNarrative } = require('../agent/anthropicAgent');
const { buildHomeTabBlocks } = require('./blockBuilders');
const logger = require('../services/logger');

/**
 * Publish (or refresh) the Home tab for a given user.
 */
async function publishHomeTab(client, userId) {
  try {
    const summary = await mciClient.getHealthSummary();
    const narrative = await generateMorningSummaryNarrative(summary);
    const blocks = buildHomeTabBlocks(summary, narrative);

    await client.views.publish({
      user_id: userId,
      view: {
        type: 'home',
        blocks,
      },
    });

    logger.info(`Home tab published for user ${userId}`, { healthScore: summary.healthScore });
  } catch (err) {
    logger.error(`Failed to publish home tab for user ${userId}`, err);

    // Fallback: show an error state
    await client.views.publish({
      user_id: userId,
      view: {
        type: 'home',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*⚡ MCI Pipeline Intelligence Agent*\n\n_Unable to load pipeline data. Please check your MCI API configuration._',
            },
          },
          {
            type: 'actions',
            elements: [{
              type: 'button',
              text: { type: 'plain_text', text: '🔄 Retry', emoji: true },
              action_id: 'home_refresh',
              style: 'primary',
            }],
          },
        ],
      },
    });
  }
}

/**
 * Register the app_home_opened event handler.
 */
function registerHomeTab(app) {
  // Publish home tab when user opens the app
  app.event('app_home_opened', async ({ event, client }) => {
    if (event.tab !== 'home') return;
    await publishHomeTab(client, event.user);
  });

  // Refresh button in the home tab
  app.action('home_refresh', async ({ body, client, ack }) => {
    await ack();
    await publishHomeTab(client, body.user.id);
  });
}

module.exports = { registerHomeTab, publishHomeTab };
