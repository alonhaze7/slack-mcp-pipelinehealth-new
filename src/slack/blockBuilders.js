'use strict';

/**
 * blockBuilders.js
 * All Slack Block Kit message, modal, canvas, and Home Tab layouts.
 *
 * Block Kit reference: https://api.slack.com/block-kit
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

const statusEmoji = (status) => ({
  SUCCESS: '🟢', FAILED: '🔴', PARTIAL: '🟡', RUNNING: '🔵', UNKNOWN: '⚪',
}[status] || '⚪');

const healthColor = (score) =>
  score >= 80 ? 'good' : score >= 60 ? 'warning' : 'danger';

const healthEmoji = (score) =>
  score >= 80 ? '💚' : score >= 60 ? '🟡' : '🔴';

/**
 * Render a 7-run history as colored emoji dots.
 */
function runHistoryDots(runs = []) {
  return runs.slice(-7).map(r => ({
    SUCCESS: '🟩', FAILED: '🟥', PARTIAL: '🟨',
  }[r.status] || '⬜').join('');
}

/**
 * Build a health score bar (text-based progress bar for Slack).
 */
function healthBar(score) {
  const filled = Math.round(score / 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  return `\`${bar}\` ${score}/100`;
}

// ─── Morning Summary ──────────────────────────────────────────────────────────

function buildMorningSummaryBlocks(summary, narrative) {
  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: process.env.TIMEZONE || 'UTC',
  });

  const topFailures = Object.entries(summary.failureReasons || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([code, count]) => `• \`${code}\` × ${count}`)
    .join('\n');

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `☀️ MCI Pipeline Morning Summary`, emoji: true },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `*${date}* · ${summary.total} pipelines monitored`,
      }],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `_${narrative}_` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*${healthEmoji(summary.healthScore)} Health Score*\n${healthBar(summary.healthScore)}` },
        { type: 'mrkdwn', text: `*📊 Pipeline Status*\n🟢 ${summary.successful} healthy  🔴 ${summary.failed} failed  🟡 ${summary.warnings} warnings` },
      ],
    },
  ];

  // Token expiry warning row
  if (summary.expiringTokens.length > 0) {
    const tokenList = summary.expiringTokens
      .map(t => `• ${t.connectorName} — *${t.daysUntilExpiry}d left*`)
      .join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*🔑 Expiring Tokens (${summary.expiringTokens.length})*\n${tokenList}` },
    });
  }

  // Top failure reasons
  if (topFailures) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*🔍 Top Failure Reasons*\n${topFailures}` },
    });
  }

  blocks.push({ type: 'divider' });

  // Action buttons
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '📋 Full Report', emoji: true },
        action_id: 'open_full_report',
        style: 'primary',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '🔧 Repair All Failed', emoji: true },
        action_id: 'bulk_repair_all_failed',
        style: 'danger',
        confirm: {
          title: { type: 'plain_text', text: 'Repair all failed pipelines?' },
          text: {
            type: 'mrkdwn',
            text: `This will attempt to auto-repair *${summary.failed} failed pipeline${summary.failed !== 1 ? 's' : ''}*. A test run with 100 records will execute before any reprocessing begins.`,
          },
          confirm: { type: 'plain_text', text: 'Yes, repair all' },
          deny: { type: 'plain_text', text: 'Cancel' },
        },
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '🤖 Ask AI', emoji: true },
        action_id: 'open_canvas_ask',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '🔄 Refresh', emoji: true },
        action_id: 'refresh_summary',
      },
    ],
  });

  return blocks;
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
        text: `*🔴 Pipeline Failure: ${pipeline.name}*\n${pipeline.connector?.name || 'Unknown connector'} · Workspace: \`${pipeline.workspaceName || pipeline.workspaceId || 'default'}\``,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Status*\n${statusEmoji(run.status)} ${run.status || 'FAILED'}` },
        { type: 'mrkdwn', text: `*Failed At*\n${run.startedAt ? new Date(run.startedAt).toLocaleTimeString() : 'Unknown'}` },
        { type: 'mrkdwn', text: `*Records*\n${run.failedRecords ? `${run.failedRecords.toLocaleString()} failed` : '0'} / ${run.expectedRecords?.toLocaleString() || '?'} expected` },
        { type: 'mrkdwn', text: `*7-Day History*\n${dots || '(no history)'}` },
      ],
    },
  ];

  if (run.errorCode || run.errorMessage) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error*\n\`${run.errorCode || 'ERROR'}\` — ${run.errorMessage || 'No message available'}`,
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
        text: { type: 'plain_text', text: '🔧 Auto-Repair', emoji: true },
        action_id: 'auto_repair_pipeline',
        value: pipeline.id,
        style: 'primary',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '📄 View Logs', emoji: true },
        action_id: 'view_pipeline_logs',
        value: `${pipeline.id}:${run.id || 'latest'}`,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '🤖 Ask AI About This', emoji: true },
        action_id: 'ask_ai_about_pipeline',
        value: pipeline.id,
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

  const urgentBar = urgent
    ? '\n> ⚠️ *ACTION REQUIRED* — Pipeline is actively failing due to expired token'
    : '';

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${urgent ? '🚨' : '🔑'} *Token Expiry ${urgent ? 'CRITICAL' : 'Warning'}: ${token.connectorName}*\nExpires *${expiryDate}* (${token.daysUntilExpiry} day${token.daysUntilExpiry !== 1 ? 's' : ''} remaining)\nPipeline: _${token.pipelineName}_${urgentBar}`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔐 Re-authenticate Now', emoji: true },
          action_id: 'reauth_connector',
          value: JSON.stringify({
            connectorName: token.connectorName,
            connectorId: token.connectorId,
            pipelineId: token.pipelineId,
          }),
          style: urgent ? 'danger' : 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔔 Remind Tomorrow', emoji: true },
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
    const duration = step.estimatedDuration ? ` _(${step.estimatedDuration})_` : '';
    return `${icon} *${step.title}*${duration}\n  ${step.description}`;
  });

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🔧 Auto-Repair in Progress: ${pipelineName}*\n\n${stepBlocks.join('\n\n')}`,
      },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Step ${currentStep + 1} of ${steps.length} · Do not interrupt`,
      }],
    },
  ];
}

function buildRepairCompleteBlocks(result) {
  const success = !result.requiresManualReview && !result.requiresUserAction;

  const statusIcon = result.requiresUserAction ? '🔐' : success ? '✅' : '⚠️';
  const statusText = result.requiresUserAction
    ? 'Requires Re-authentication'
    : success
    ? 'Repair Complete'
    : 'Needs Manual Review';

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${statusIcon} ${statusText}: ${result.pipelineName}*\n${result.summary}`,
      },
    },
  ];

  if (result.reprocessJobId) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `📋 Reprocess job ID: \`${result.reprocessJobId}\`` }],
    });
  }

  if (result.requiresUserAction && result.connectorName) {
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '🔐 Re-authenticate Now', emoji: true },
        action_id: 'reauth_connector',
        value: JSON.stringify({
          connectorName: result.connectorName,
          connectorId: result.connectorId,
          pipelineId: result.pipelineId,
        }),
        style: 'danger',
      }],
    });
  }

  return blocks;
}

// ─── Logs Modal ───────────────────────────────────────────────────────────────

function buildLogsModal(pipeline, logs) {
  const logLines = (logs.entries || [])
    .slice(-20)
    .map(e => {
      const level = e.level === 'ERROR' ? '🔴' : e.level === 'WARN' ? '🟡' : '🔵';
      return `${level} \`${new Date(e.timestamp).toLocaleTimeString()}\` ${e.message}`;
    })
    .join('\n');

  return {
    type: 'modal',
    callback_id: 'logs_modal',
    title: { type: 'plain_text', text: 'Pipeline Run Logs' },
    close: { type: 'plain_text', text: 'Close' },
    submit: { type: 'plain_text', text: 'Trigger Reprocess' },
    private_metadata: JSON.stringify({ pipelineId: pipeline.id }),
    blocks: [
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Pipeline*\n${pipeline.name}` },
          { type: 'mrkdwn', text: `*Last Run*\n${pipeline.lastRun?.startedAt ? new Date(pipeline.lastRun.startedAt).toLocaleString() : 'Unknown'}` },
          { type: 'mrkdwn', text: `*Status*\n${statusEmoji(pipeline.lastRun?.status)} ${pipeline.lastRun?.status || 'UNKNOWN'}` },
          { type: 'mrkdwn', text: `*Error*\n\`${pipeline.lastRun?.errorCode || 'N/A'}\`` },
        ],
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: logLines || '_No log entries found for this run_',
        },
      },
    ],
  };
}

// ─── Full Report Modal ────────────────────────────────────────────────────────

function buildFullReportModal(summary) {
  const pipelineLines = summary.pipelines.map(p => {
    const emoji = statusEmoji(p.lastRun?.status);
    const dots = runHistoryDots(p.runHistory || []);
    const errorNote = p.lastRun?.status === 'FAILED'
      ? `\n   └ \`${p.lastRun?.errorCode || 'ERROR'}\`: ${(p.lastRun?.errorMessage || '').slice(0, 60)}`
      : '';
    return `${emoji} *${p.name}* — ${p.connector?.name || '?'}\n   ${dots || '(no history)'}  ${p.lastRun?.status || 'UNKNOWN'}${errorNote}`;
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
          { type: 'mrkdwn', text: `*${healthEmoji(summary.healthScore)} Health Score*\n${healthBar(summary.healthScore)}` },
          { type: 'mrkdwn', text: `*Total Pipelines*\n${summary.total}` },
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

// ─── Interactive Home Tab ─────────────────────────────────────────────────────

/**
 * Build the App Home tab — the main interactive dashboard.
 * This is the primary "summary screen" and "notification screen" combined.
 */
function buildHomeTabBlocks(summary, narrative) {
  const date = new Date().toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: process.env.TIMEZONE || 'UTC',
  });

  const blocks = [
    // ── Header ──
    {
      type: 'header',
      text: { type: 'plain_text', text: '⚡ MCI Pipeline Intelligence Agent', emoji: true },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Last updated: *${date}* · Marketing Cloud Intelligence` }],
    },
    { type: 'divider' },

    // ── Health Score ──
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${healthEmoji(summary.healthScore)} Overall Health Score*\n${healthBar(summary.healthScore)}\n\n_${narrative || 'Loading AI summary...'}_`,
      },
    },

    // ── Stats row ──
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*🟢 Healthy*\n${summary.successful} pipelines` },
        { type: 'mrkdwn', text: `*🔴 Failed*\n${summary.failed} pipelines` },
        { type: 'mrkdwn', text: `*🟡 Warnings*\n${summary.warnings} pipelines` },
        { type: 'mrkdwn', text: `*🔑 Token Alerts*\n${summary.expiringTokens.length} connectors` },
      ],
    },

    { type: 'divider' },

    // ── Quick Actions ──
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*⚡ Quick Actions*' },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔄 Refresh Status', emoji: true },
          action_id: 'home_refresh',
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '📋 Full Pipeline Report', emoji: true },
          action_id: 'open_full_report',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔧 Repair All Failed', emoji: true },
          action_id: 'bulk_repair_all_failed',
          style: 'danger',
          confirm: {
            title: { type: 'plain_text', text: 'Repair all failed pipelines?' },
            text: { type: 'mrkdwn', text: `Auto-repair *${summary.failed} pipeline${summary.failed !== 1 ? 's' : ''}*. Test runs execute first.` },
            confirm: { type: 'plain_text', text: 'Yes, repair all' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🤖 Ask AI', emoji: true },
          action_id: 'open_canvas_ask',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '📊 Canvas View', emoji: true },
          action_id: 'open_canvas_viz',
        },
      ],
    },
  ];

  // ── Failed pipelines list ──
  if (summary.failed > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*🔴 Failed Pipelines (${summary.failed})*` },
    });

    const failedPipelines = summary.pipelines.filter(p => p.lastRun?.status === 'FAILED').slice(0, 5);
    for (const pipeline of failedPipelines) {
      const dots = runHistoryDots(pipeline.runHistory || []);
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${pipeline.name}*\n\`${pipeline.lastRun?.errorCode || 'ERROR'}\` — ${(pipeline.lastRun?.errorMessage || 'Unknown error').slice(0, 80)}\n${dots || '(no history)'}`,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: '🔧 Repair', emoji: true },
          action_id: 'auto_repair_pipeline',
          value: pipeline.id,
          style: 'primary',
        },
      });
    }
    if (summary.failed > 5) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `+${summary.failed - 5} more failed pipelines — click *Full Pipeline Report* to see all` }],
      });
    }
  }

  // ── Token expiry warnings ──
  if (summary.expiringTokens.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*🔑 Expiring Tokens (${summary.expiringTokens.length})*` },
    });

    for (const token of summary.expiringTokens.slice(0, 4)) {
      const urgent = token.daysUntilExpiry <= 2;
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${urgent ? '🚨' : '🔑'} *${token.connectorName}*\nExpires in *${token.daysUntilExpiry} day${token.daysUntilExpiry !== 1 ? 's' : ''}* · Pipeline: _${token.pipelineName}_`,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: '🔐 Re-auth', emoji: true },
          action_id: 'reauth_connector',
          value: JSON.stringify({
            connectorName: token.connectorName,
            connectorId: token.connectorId,
            pipelineId: token.pipelineId,
          }),
          style: urgent ? 'danger' : 'primary',
        },
      });
    }
  }

  // ── Healthy pipelines summary ──
  if (summary.successful > 0) {
    blocks.push({ type: 'divider' });
    const healthyList = summary.pipelines
      .filter(p => p.lastRun?.status === 'SUCCESS')
      .slice(0, 6)
      .map(p => `🟢 ${p.name}`)
      .join('  ');
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*Healthy pipelines:* ${healthyList}${summary.successful > 6 ? ` +${summary.successful - 6} more` : ''}` }],
    });
  }

  // ── Footer ──
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: '💬 DM this bot anytime · `/mci-status` · `/mci-repair <name>` · `/mci-ask <question>` · `/mci-summary`',
    }],
  });

  return blocks;
}

// ─── Canvas: Visualisation View ───────────────────────────────────────────────

/**
 * Build the pipeline visualisation canvas — a rich modal with charts and stats.
 */
function buildCanvasVizModal(summary) {
  const workspaceStats = summary.pipelines.reduce((acc, p) => {
    const ws = p.workspaceName || p.workspaceId || 'default';
    if (!acc[ws]) acc[ws] = { total: 0, success: 0, failed: 0, warnings: 0 };
    acc[ws].total++;
    if (p.lastRun?.status === 'SUCCESS') acc[ws].success++;
    else if (p.lastRun?.status === 'FAILED') acc[ws].failed++;
    else if (p.lastRun?.status === 'PARTIAL') acc[ws].warnings++;
    return acc;
  }, {});

  // Build a mini bar chart using emoji blocks
  const workspaceChartLines = Object.entries(workspaceStats).map(([ws, stats]) => {
    const successPct = stats.total > 0 ? Math.round((stats.success / stats.total) * 10) : 0;
    const bar = '🟩'.repeat(successPct) + '🟥'.repeat(Math.round((stats.failed / stats.total) * 10)) + '⬜'.repeat(Math.max(0, 10 - successPct - Math.round((stats.failed / stats.total) * 10)));
    return `*${ws}*\n${bar} ${stats.success}/${stats.total} healthy`;
  }).join('\n\n');

  // Error breakdown chart
  const errorChart = Object.entries(summary.failureReasons || {})
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => {
      const bar = '▓'.repeat(Math.min(count * 2, 20));
      return `\`${code}\`\n${bar} ${count}`;
    })
    .join('\n\n');

  // 7-day trend for all pipelines
  const allRuns = summary.pipelines
    .flatMap(p => (p.runHistory || []).slice(-7))
    .reduce((acc, run) => {
      if (!run?.startedAt) return acc;
      const day = new Date(run.startedAt).toLocaleDateString('en-US', { weekday: 'short' });
      if (!acc[day]) acc[day] = { success: 0, failed: 0 };
      if (run.status === 'SUCCESS') acc[day].success++;
      else if (run.status === 'FAILED') acc[day].failed++;
      return acc;
    }, {});

  const trendLines = Object.entries(allRuns)
    .slice(-7)
    .map(([day, counts]) => {
      const total = counts.success + counts.failed;
      const pct = total > 0 ? Math.round((counts.success / total) * 5) : 0;
      const bar = '🟩'.repeat(pct) + '🟥'.repeat(5 - pct);
      return `${day}: ${bar} (${counts.success}✓ ${counts.failed}✗)`;
    })
    .join('\n');

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '📊 Pipeline Health Visualisation', emoji: true },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*MCI Pipeline Intelligence Agent* · ${summary.total} pipelines · Health: *${summary.healthScore}/100*` }],
    },
    { type: 'divider' },

    // Overall gauge
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${healthEmoji(summary.healthScore)} Overall Health*\n${healthBar(summary.healthScore)}\n\n🟢 *${summary.successful}* healthy  ·  🔴 *${summary.failed}* failed  ·  🟡 *${summary.warnings}* warnings  ·  🔑 *${summary.expiringTokens.length}* token alerts`,
      },
    },
    { type: 'divider' },

    // Workspace breakdown
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*🌍 Workspace Breakdown*\n\n${workspaceChartLines || '_No workspace data_'}` },
    },
  ];

  if (trendLines) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*📈 7-Day Run Trend*\n\n${trendLines}` },
    });
  }

  if (errorChart) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*🔍 Error Type Distribution*\n\n${errorChart}` },
    });
  }

  // Individual pipeline run history
  const pipelineHistoryLines = summary.pipelines.slice(0, 8).map(p => {
    const dots = runHistoryDots(p.runHistory || []);
    const status = statusEmoji(p.lastRun?.status);
    return `${status} *${p.name}*\n   ${dots || '(no data)'} — ${p.connector?.name || '?'}`;
  }).join('\n\n');

  if (pipelineHistoryLines) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*🔁 Pipeline Run History (last 7 runs each)*\n\n${pipelineHistoryLines}` },
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '🤖 Ask AI About These Stats', emoji: true },
        action_id: 'open_canvas_ask',
        style: 'primary',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '🔧 Repair All Failed', emoji: true },
        action_id: 'bulk_repair_all_failed',
        style: 'danger',
      },
    ],
  });

  return {
    type: 'modal',
    callback_id: 'canvas_viz_modal',
    title: { type: 'plain_text', text: 'Pipeline Visualisation' },
    close: { type: 'plain_text', text: 'Close' },
    blocks,
  };
}

// ─── Canvas: AI Q&A ───────────────────────────────────────────────────────────

/**
 * Build the AI Canvas Q&A modal — an interactive chat interface for asking questions.
 */
function buildCanvasAskModal(previousAnswer = null, previousQuestion = null) {
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🤖 Ask the MCI Pipeline AI*\nAsk anything about your pipelines, failures, tokens, or historical trends. The AI has full context of your current pipeline state.`,
      },
    },
    { type: 'divider' },
  ];

  // Show previous Q&A if available
  if (previousQuestion && previousAnswer) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Your question:*\n_${previousQuestion}_` },
    });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*AI Response:*\n${previousAnswer}`,
      },
    });
    blocks.push({ type: 'divider' });
  }

  // Question input
  blocks.push({
    type: 'input',
    block_id: 'canvas_question_block',
    label: { type: 'plain_text', text: previousQuestion ? 'Ask a follow-up question:' : 'Your question:' },
    element: {
      type: 'plain_text_input',
      action_id: 'canvas_question_input',
      multiline: true,
      placeholder: {
        type: 'plain_text',
        text: 'e.g. "Why did the Meta EMEA pipeline fail?" or "Which pipelines have the most failures this week?"',
      },
    },
  });

  // Suggested questions
  if (!previousQuestion) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '💡 *Suggestions:* "What failed overnight?" · "Which tokens are about to expire?" · "Why is my health score low?" · "How do I fix a rate limit error?"',
      }],
    });
  }

  return {
    type: 'modal',
    callback_id: 'canvas_ask_modal',
    title: { type: 'plain_text', text: 'Ask the AI Agent' },
    submit: { type: 'plain_text', text: '🤖 Ask' },
    close: { type: 'plain_text', text: 'Close' },
    private_metadata: JSON.stringify({ previousQuestion, previousAnswer }),
    blocks,
  };
}

/**
 * Build the AI answer display modal (shown after canvas Q&A submission).
 */
function buildCanvasAnswerModal(question, answer, userId) {
  return {
    type: 'modal',
    callback_id: 'canvas_answer_modal',
    title: { type: 'plain_text', text: 'AI Agent Response' },
    close: { type: 'plain_text', text: 'Close' },
    submit: { type: 'plain_text', text: '🔄 Ask Another' },
    private_metadata: JSON.stringify({ question, answer, userId }),
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Your question:*\n_${question}_` },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*🤖 AI Response:*\n${answer}` },
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: '💡 Click *Ask Another* to ask a follow-up question, or use `/mci-ask` anytime in any channel',
        }],
      },
    ],
  };
}

// ─── Re-auth modal ────────────────────────────────────────────────────────────

function buildReauthModal(connectorName, pipelineId) {
  return {
    type: 'modal',
    callback_id: 'reauth_modal',
    title: { type: 'plain_text', text: 'Re-authenticate Connector' },
    submit: { type: 'plain_text', text: 'Open OAuth' },
    close: { type: 'plain_text', text: 'Later' },
    private_metadata: JSON.stringify({ connectorName, pipelineId }),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*🔐 Re-authenticate: ${connectorName}*\n\nThis connector's access token is expiring soon. Clicking *Open OAuth* will:\n\n• Open the OAuth consent screen in your browser\n• Securely store the new token in MCI\n• Resume all affected pipelines automatically\n• Send you a confirmation message here`,
        },
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: '⚠️ You must complete the OAuth flow within 10 minutes for the token to refresh.',
        }],
      },
    ],
  };
}

// ─── Repair Confirm Modal ─────────────────────────────────────────────────────

function buildRepairConfirmModal(pipeline, repairPlan, strategyDescription) {
  const stepBlocks = repairPlan.map((step, i) => ({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*${i + 1}. ${step.title}*${step.estimatedDuration ? ` _(${step.estimatedDuration})_` : ''}\n${step.description}`,
    },
  }));

  return {
    type: 'modal',
    callback_id: 'repair_confirm_modal',
    title: { type: 'plain_text', text: 'Confirm Auto-Repair' },
    submit: { type: 'plain_text', text: '▶️ Run Repair' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: JSON.stringify({
      pipelineId: pipeline.id,
      channelId: process.env.SLACK_PIPELINE_CHANNEL,
      repairPlan,
    }),
    blocks: [
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Pipeline*\n${pipeline.name}` },
          { type: 'mrkdwn', text: `*Connector*\n${pipeline.connector?.name || 'Unknown'}` },
          { type: 'mrkdwn', text: `*Error Code*\n\`${pipeline.lastRun?.errorCode || 'UNKNOWN'}\`` },
          { type: 'mrkdwn', text: `*Strategy*\n${strategyDescription?.strategy || 'AUTO'}` },
        ],
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `*Error:* ${pipeline.lastRun?.errorMessage || 'No error message'}` }],
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*The agent will perform the following steps:*' },
      },
      ...stepBlocks,
      { type: 'divider' },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: '⚠️ A test run with *100 records* will always execute first. Full reprocess only proceeds if the test passes.',
        }],
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
  buildHomeTabBlocks,
  buildCanvasVizModal,
  buildCanvasAskModal,
  buildCanvasAnswerModal,
  buildReauthModal,
  buildRepairConfirmModal,
  runHistoryDots,
  statusEmoji,
  healthBar,
  healthEmoji,
};
