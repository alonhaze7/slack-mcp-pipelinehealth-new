'use strict';

/**
 * messageHandlers.js
 * Handles all incoming Slack messages — @mentions, DMs.
 * Routes to the AI agent for natural language Q&A.
 */

const { chat, clearHistory, getHistoryLength } = require('../agent/anthropicAgent');
const mciClient = require('../api/mciClient');
const {
  buildMorningSummaryBlocks,
  buildCanvasAskModal,
  buildCanvasVizModal,
} = require('./blockBuilders');
const { generateMorningSummaryNarrative } = require('../agent/anthropicAgent');
const logger = require('../services/logger');

function registerMessageHandlers(app) {

  // ── Handle @mentions in channels ──────────────────────────────────────────
  app.event('app_mention', async ({ event, client, say }) => {
    const userId = event.user;
    const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

    logger.info(`App mention from ${userId}: "${text.slice(0, 100)}"`);

    // Show thinking indicator
    await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: 'thinking_face' }).catch(() => {});

    try {
      if (!text || text.toLowerCase() === 'help') {
        await say({ thread_ts: event.ts, blocks: buildHelpBlocks(), text: 'MCI Pipeline Agent help' });
        return;
      }

      if (text.toLowerCase() === 'status' || text.toLowerCase() === 'health') {
        const summary = await mciClient.getHealthSummary();
        const narrative = await generateMorningSummaryNarrative(summary);
        await say({
          thread_ts: event.ts,
          blocks: buildMorningSummaryBlocks(summary, narrative),
          text: `Health score: ${summary.healthScore}/100`,
        });
        return;
      }

      if (text.toLowerCase().startsWith('reset')) {
        clearHistory(userId);
        await say({ thread_ts: event.ts, text: '🔄 Conversation history cleared. Ask me anything!' });
        return;
      }

      // Default: AI chat response
      const response = await chat(userId, text);
      await say({ thread_ts: event.ts, text: response.text });

    } catch (err) {
      logger.error('App mention handler error', err);
      await say({
        thread_ts: event.ts,
        text: `Sorry, I hit an error. _${err.message}_`,
      });
    } finally {
      await client.reactions.remove({ channel: event.channel, timestamp: event.ts, name: 'thinking_face' }).catch(() => {});
    }
  });

  // ── Handle direct messages ────────────────────────────────────────────────
  app.message(async ({ message, client, say }) => {
    if (message.channel_type !== 'im' || message.bot_id) return;

    const userId = message.user;
    const text = (message.text || '').trim();
    if (!text) return;

    logger.info(`DM from ${userId}: "${text.slice(0, 100)}"`);

    try {
      const cmd = text.toLowerCase();

      if (cmd === 'help') {
        await say({ blocks: buildHelpBlocks(), text: 'Help' });
        return;
      }

      if (cmd === 'reset') {
        clearHistory(userId);
        await say({ text: '🔄 Conversation reset. Ask me anything about your MCI pipelines.' });
        return;
      }

      if (cmd === 'status' || cmd === 'health') {
        const summary = await mciClient.getHealthSummary();
        const narrative = await generateMorningSummaryNarrative(summary);
        await say({
          blocks: buildMorningSummaryBlocks(summary, narrative),
          text: `Health: ${summary.healthScore}/100`,
        });
        return;
      }

      if (cmd === 'history') {
        const turns = getHistoryLength(userId);
        await say({ text: `📝 You have ${turns} turn${turns !== 1 ? 's' : ''} in conversation history. Type \`reset\` to clear.` });
        return;
      }

      // Default: AI chat
      const response = await chat(userId, text);
      await say({ text: response.text });

    } catch (err) {
      logger.error('DM handler error', err);
      await say({ text: `❌ Error: ${err.message}` });
    }
  });
}

// ─── Help blocks ──────────────────────────────────────────────────────────────
function buildHelpBlocks() {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: '⚡ MCI Pipeline Intelligence Agent', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'I monitor Marketing Cloud Intelligence pipelines in real-time and can repair failures automatically. Here\'s what I can do:',
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*💬 Mention me in any channel*' },
      fields: [
        { type: 'mrkdwn', text: '`@mci-agent status`\nFull pipeline health overview' },
        { type: 'mrkdwn', text: '`@mci-agent reset`\nClear your conversation history' },
        { type: 'mrkdwn', text: '`@mci-agent help`\nShow this message' },
        { type: 'mrkdwn', text: '`@mci-agent <any question>`\nAI-powered pipeline Q&A' },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*⚡ Slash commands*' },
      fields: [
        { type: 'mrkdwn', text: '`/mci-status`\nFull health overview' },
        { type: 'mrkdwn', text: '`/mci-repair <name>`\nRepair a pipeline by name' },
        { type: 'mrkdwn', text: '`/mci-ask <question>`\nAsk the AI agent anything' },
        { type: 'mrkdwn', text: '`/mci-summary`\nForce-post a morning summary' },
      ],
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '🏠 Open the *App Home* for an interactive dashboard · 📊 Use *Canvas View* for visualisations · 🤖 Use *Ask AI* for deep Q&A',
      }],
    },
  ];
}

module.exports = { registerMessageHandlers };
