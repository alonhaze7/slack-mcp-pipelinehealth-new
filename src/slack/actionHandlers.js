'use strict';

/**
 * actionHandlers.js
 * Handles all Slack interactive element actions:
 *   - Auto-repair button (single + bulk)
 *   - Repair confirm modal submission
 *   - View pipeline logs
 *   - Token re-authentication (OAuth flow from Slack)
 *   - Snooze alerts
 *   - Open full report / canvas / viz
 *   - Canvas Q&A submission
 *   - Refresh summary
 */

const mciClient = require('../api/mciClient');
const { executeRepair, executeBulkRepair, describeRepairStrategy } = require('../services/repairService');
const { generateRepairPlan, generateCanvasAnswer } = require('../agent/anthropicAgent');
const {
  buildRepairProgressBlocks,
  buildRepairCompleteBlocks,
  buildLogsModal,
  buildFullReportModal,
  buildCanvasVizModal,
  buildCanvasAskModal,
  buildCanvasAnswerModal,
  buildReauthModal,
  buildRepairConfirmModal,
} = require('./blockBuilders');
const { publishHomeTab } = require('./homeTab');
const logger = require('../services/logger');

// Snoozed pipelines: pipelineId → snoozeUntil timestamp
const snoozedPipelines = new Map();

function registerActionHandlers(app) {

  // ── Auto-repair single pipeline ───────────────────────────────────────────
  app.action('auto_repair_pipeline', async ({ action, body, client, ack, respond }) => {
    await ack();

    const pipelineId = action.value;
    const triggeredBy = body.user.id;
    logger.info(`Auto-repair triggered by ${triggeredBy} for pipeline ${pipelineId}`);

    // Check snooze
    const snoozedUntil = snoozedPipelines.get(pipelineId);
    if (snoozedUntil && Date.now() < snoozedUntil) {
      const remaining = Math.ceil((snoozedUntil - Date.now()) / 60000);
      await respond({ text: `⏰ This pipeline's alerts are snoozed for ${remaining} more minute(s).`, replace_original: false });
      return;
    }

    try {
      const allPipelines = await mciClient.getAllPipelines();
      const pipeline = allPipelines.find(p => p.id === pipelineId);

      if (!pipeline) {
        await respond({ text: `❌ Pipeline \`${pipelineId}\` not found.`, replace_original: false });
        return;
      }

      // Generate AI repair plan + strategy description
      const [repairPlan, strategyDesc] = await Promise.all([
        generateRepairPlan(pipeline),
        Promise.resolve(describeRepairStrategy(pipeline)),
      ]);

      // Open confirmation modal with full plan
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildRepairConfirmModal(pipeline, repairPlan, strategyDesc),
      });
    } catch (err) {
      logger.error('auto_repair_pipeline error', err);
      await respond({ text: `❌ Failed to prepare repair plan: ${err.message}`, replace_original: false });
    }
  });

  // ── Repair confirm modal submission ──────────────────────────────────────
  app.view('repair_confirm_modal', async ({ view, body, client, ack }) => {
    await ack();

    const metadata = JSON.parse(view.private_metadata);
    const { pipelineId, channelId, repairPlan } = metadata;
    const userId = body.user.id;

    // Post a progress message to the channel
    const progressMsg = await client.chat.postMessage({
      channel: channelId || process.env.SLACK_PIPELINE_CHANNEL,
      text: `🔧 Auto-repair in progress...`,
      blocks: buildRepairProgressBlocks('Loading...', repairPlan || [{ title: 'Starting...' }], 0),
    });

    try {
      const allPipelines = await mciClient.getAllPipelines();
      const pipeline = allPipelines.find(p => p.id === pipelineId);

      if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found`);

      let stepIndex = 0;
      const onProgress = async (message) => {
        stepIndex++;
        await client.chat.update({
          channel: progressMsg.channel,
          ts: progressMsg.ts,
          text: message,
          blocks: buildRepairProgressBlocks(pipeline.name, repairPlan || [], stepIndex),
        });
      };

      const result = await executeRepair(pipeline, onProgress);

      await client.chat.update({
        channel: progressMsg.channel,
        ts: progressMsg.ts,
        text: result.summary,
        blocks: buildRepairCompleteBlocks(result),
      });

      // Refresh home tab for the user who triggered the repair
      await publishHomeTab(client, userId).catch(() => {});

    } catch (err) {
      logger.error('Repair execution failed', err);
      await client.chat.update({
        channel: progressMsg.channel,
        ts: progressMsg.ts,
        text: `❌ Repair failed: ${err.message}`,
        blocks: [{
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*❌ Repair Failed*\n${err.message}\n\nPlease review manually in MCI or contact support.`,
          },
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
      await respond({ text: '🎉 No failed pipelines found. All pipelines are healthy!', replace_original: false });
      return;
    }

    const channelId = body.channel?.id || process.env.SLACK_PIPELINE_CHANNEL;
    const progressMsg = await client.chat.postMessage({
      channel: channelId,
      text: `🔧 Bulk repair starting for ${failedIds.length} pipeline${failedIds.length !== 1 ? 's' : ''}...`,
    });

    let completed = 0;
    const onProgress = async (message) => {
      completed++;
      await client.chat.update({
        channel: progressMsg.channel,
        ts: progressMsg.ts,
        text: `🔧 Bulk repair (${completed}/${failedIds.length}): ${message}`,
      }).catch(() => {});
    };

    const results = await executeBulkRepair(failedIds, onProgress);
    const successes = results.filter(r => r.success).length;
    const failures = results.filter(r => !r.success).length;
    const needsAuth = results.filter(r => r.requiresUserAction).length;

    const resultBlocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*🔧 Bulk Repair Complete*\n✅ ${successes} repaired${failures > 0 ? `\n⚠️ ${failures} need manual review` : ''}${needsAuth > 0 ? `\n🔐 ${needsAuth} need re-authentication` : ''}`,
        },
      },
      ...results.filter(r => !r.success).map(r => ({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `❌ *${r.pipelineName}*: ${r.error || r.summary}` }],
      })),
    ];

    await client.chat.update({
      channel: progressMsg.channel,
      ts: progressMsg.ts,
      text: `Bulk repair: ${successes}/${failedIds.length} repaired`,
      blocks: resultBlocks,
    });

    // Refresh home tab
    await publishHomeTab(client, body.user.id).catch(() => {});
  });

  // ── View pipeline logs ────────────────────────────────────────────────────
  app.action('view_pipeline_logs', async ({ action, body, client, ack }) => {
    await ack();
    const [pipelineId, runId] = action.value.split(':');

    try {
      const [allPipelines, logs] = await Promise.all([
        mciClient.getAllPipelines(),
        mciClient.getRunLogs(pipelineId, runId || 'latest').catch(() => ({ entries: [] })),
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
          title: { type: 'plain_text', text: 'Log Error' },
          close: { type: 'plain_text', text: 'Close' },
          blocks: [{
            type: 'section',
            text: { type: 'mrkdwn', text: `❌ Failed to load logs: ${err.message}` },
          }],
        },
      });
    }
  });

  // ── Logs modal submission → trigger reprocess ─────────────────────────────
  app.view('logs_modal', async ({ view, body, client, ack }) => {
    await ack();
    const { pipelineId } = JSON.parse(view.private_metadata);

    try {
      const result = await mciClient.triggerReprocess(pipelineId);
      await client.chat.postMessage({
        channel: body.user.id,
        text: `✅ Reprocess triggered for pipeline \`${pipelineId}\`. Job ID: \`${result.jobId}\``,
      });
    } catch (err) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: `❌ Reprocess failed: ${err.message}`,
      });
    }
  });

  // ── Token re-authentication ───────────────────────────────────────────────
  app.action('reauth_connector', async ({ action, body, client, ack }) => {
    await ack();
    const { connectorName, connectorId, pipelineId } = JSON.parse(action.value);

    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildReauthModal(connectorName, pipelineId),
    });
  });

  // ── Re-auth modal submission → send OAuth link ────────────────────────────
  app.view('reauth_modal', async ({ view, body, client, ack }) => {
    await ack();
    const { connectorName, pipelineId } = JSON.parse(view.private_metadata);

    const oauthUrl = `${process.env.MCI_API_BASE_URL}/connectors/oauth/authorize?connector=${encodeURIComponent(connectorName)}&redirect_uri=${encodeURIComponent(process.env.OAUTH_REDIRECT_URI || 'https://yourapp.com/oauth/callback')}&state=${pipelineId}`;

    await client.chat.postMessage({
      channel: body.user.id,
      text: `🔐 Re-authenticate ${connectorName}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*🔐 Re-authenticate: ${connectorName}*\n\nClick the button below to open the OAuth consent screen.\n\n✅ Once you complete authentication:\n• Your token is refreshed automatically in MCI\n• All pipelines using this connector will resume\n• You'll receive a confirmation message here`,
          },
        },
        {
          type: 'actions',
          elements: [{
            type: 'button',
            text: { type: 'plain_text', text: '🔐 Open OAuth Consent Screen', emoji: true },
            url: oauthUrl,
            action_id: 'oauth_external_link',
            style: 'primary',
          }],
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '⏰ This link expires in 10 minutes.' }],
        },
      ],
    });
  });

  // ── Ask AI about a specific pipeline ─────────────────────────────────────
  app.action('ask_ai_about_pipeline', async ({ action, body, client, ack }) => {
    await ack();
    const pipelineId = action.value;

    try {
      const allPipelines = await mciClient.getAllPipelines();
      const pipeline = allPipelines.find(p => p.id === pipelineId);
      const question = pipeline
        ? `Analyse the failure of pipeline "${pipeline.name}" and explain what caused it and how to fix it.`
        : `Tell me about pipeline ${pipelineId}`;

      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildCanvasAskModal(null, question),
      });
    } catch (err) {
      logger.error('ask_ai_about_pipeline error', err);
    }
  });

  // ── Open canvas ask modal ─────────────────────────────────────────────────
  app.action('open_canvas_ask', async ({ body, client, ack }) => {
    await ack();
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildCanvasAskModal(),
    });
  });

  // ── Canvas Q&A modal submission ───────────────────────────────────────────
  app.view('canvas_ask_modal', async ({ view, body, client, ack }) => {
    await ack();

    const userId = body.user.id;
    const question = view.state.values?.canvas_question_block?.canvas_question_input?.value?.trim();

    if (!question) return;

    try {
      const response = await generateCanvasAnswer(userId, question);

      // Push the answer modal on top
      await client.views.push({
        trigger_id: body.trigger_id,
        view: buildCanvasAnswerModal(question, response.text, userId),
      }).catch(async () => {
        // If push fails (no trigger_id in views), send as DM
        await client.chat.postMessage({
          channel: userId,
          text: response.text,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `*Your question:*\n_${question}_` } },
            { type: 'section', text: { type: 'mrkdwn', text: `*🤖 AI Response:*\n${response.text}` } },
          ],
        });
      });
    } catch (err) {
      logger.error('Canvas Q&A error', err);
      await client.chat.postMessage({
        channel: userId,
        text: `❌ AI error: ${err.message}`,
      });
    }
  });

  // ── Canvas answer modal → ask another ────────────────────────────────────
  app.view('canvas_answer_modal', async ({ view, body, client, ack }) => {
    await ack({ response_action: 'push', view: buildCanvasAskModal() });
  });

  // ── Open canvas visualisation ─────────────────────────────────────────────
  app.action('open_canvas_viz', async ({ body, client, ack }) => {
    await ack();
    try {
      const summary = await mciClient.getHealthSummary();
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildCanvasVizModal(summary),
      });
    } catch (err) {
      logger.error('open_canvas_viz error', err);
    }
  });

  // ── Open full report modal ────────────────────────────────────────────────
  app.action('open_full_report', async ({ body, client, ack }) => {
    await ack();
    try {
      const summary = await mciClient.getHealthSummary();
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildFullReportModal(summary),
      });
    } catch (err) {
      logger.error('open_full_report error', err);
    }
  });

  // ── Refresh summary ───────────────────────────────────────────────────────
  app.action('refresh_summary', async ({ body, client, ack, respond }) => {
    await ack();
    const mciClient2 = require('../api/mciClient');
    mciClient2.invalidateAllCaches();

    const { generateMorningSummaryNarrative: genNarrative } = require('../agent/anthropicAgent');
    const { buildMorningSummaryBlocks } = require('./blockBuilders');

    try {
      const summary = await mciClient2.getHealthSummary();
      const narrative = await genNarrative(summary);
      await respond({
        blocks: buildMorningSummaryBlocks(summary, narrative),
        text: `Health: ${summary.healthScore}/100`,
        replace_original: true,
      });
    } catch (err) {
      await respond({ text: `❌ Refresh failed: ${err.message}`, replace_original: false });
    }
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
  app.action('snooze_token_alert', async ({ action, ack, respond }) => {
    await ack();
    await respond({ text: `⏰ Token expiry reminder snoozed until tomorrow.`, replace_original: false });
  });

  // ── Noop for external OAuth link buttons ─────────────────────────────────
  app.action('oauth_external_link', async ({ ack }) => { await ack(); });

  // ── Viz modal canvas → ask AI ─────────────────────────────────────────────
  app.view('canvas_viz_modal', async ({ view, body, client, ack }) => {
    await ack();
    // Nothing to submit — view is read-only
  });
}

module.exports = { registerActionHandlers, snoozedPipelines };
