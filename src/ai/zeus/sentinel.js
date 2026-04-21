/**
 * Zeus Code Sentinel — orquestador de las sub-lentes de auditoría.
 *
 * Lens 2 (Vulnerability Sentinel) del flujo "Zeus Despierto".
 * - daily pass: security + silent_failures + config_drift (3 críticas)
 * - weekly pass: todas las 5 (agrega calibration + prompt_drift)
 *
 * Cada sub-lente corre runOracle con un prompt especializado.
 * Los findings se taggean con lens='vulnerability', sub_lens=<name>, audit_run_id=<run._id>.
 * Críticos disparan proactive ping al chat.
 */

const logger = require('../../utils/logger');
const { runOracle } = require('./oracle-runner');
const ZeusCodeRecommendation = require('../../db/models/ZeusCodeRecommendation');
const ZeusAuditRun = require('../../db/models/ZeusAuditRun');

const SECURITY = require('./sentinel-lenses/security');
const SILENT_FAILURES = require('./sentinel-lenses/silent-failures');
const CONFIG_DRIFT = require('./sentinel-lenses/config-drift');
const CALIBRATION = require('./sentinel-lenses/calibration');
const PROMPT_DRIFT = require('./sentinel-lenses/prompt-drift');

const DAILY_LENSES = [SECURITY, SILENT_FAILURES, CONFIG_DRIFT];
const WEEKLY_LENSES = [SECURITY, SILENT_FAILURES, CONFIG_DRIFT, CALIBRATION, PROMPT_DRIFT];

/**
 * Corre una sub-lente específica.
 * Crea ZeusAuditRun, invoca runOracle con el prompt de la lente, y taggea los recs nuevos.
 */
async function runSubLens(subLens, mode = 'daily') {
  const startedAt = new Date();
  const run = await ZeusAuditRun.create({
    lens: 'vulnerability',
    sub_lens: subLens.name,
    mode,
    started_at: startedAt,
    status: 'running'
  });

  logger.info(`[SENTINEL] Inicia sub-lente '${subLens.name}' (run ${run._id})`);

  const recsBefore = await ZeusCodeRecommendation.countDocuments({
    created_at: { $gte: startedAt }
  });

  const toolCalls = [];
  let summary = '';
  let tokensUsed = 0;

  try {
    const result = await runOracle({
      userMessage: subLens.prompt,
      mode: 'chat',
      history: [],
      lastSeenAt: null,
      onEvent: (type, data) => {
        if (type === 'tool_use_start') toolCalls.push(data.tool);
      }
    });
    summary = (result.text || '').substring(0, 500);
    tokensUsed = result.tokens_used || 0;
  } catch (err) {
    logger.error(`[SENTINEL] Sub-lente '${subLens.name}' falló: ${err.message}`);
    run.status = 'failed';
    run.error = err.message;
    run.finished_at = new Date();
    run.duration_ms = run.finished_at - startedAt;
    await run.save();
    return { error: err.message, sub_lens: subLens.name };
  }

  // Taggear todos los recs creados durante esta pasada
  const newRecs = await ZeusCodeRecommendation.find({
    created_at: { $gte: startedAt },
    lens: null
  });

  let critical = 0;
  let high = 0;
  for (const rec of newRecs) {
    rec.lens = 'vulnerability';
    rec.sub_lens = subLens.name;
    rec.audit_run_id = run._id;
    await rec.save();
    if (rec.severity === 'critical') critical++;
    if (rec.severity === 'high') high++;
  }

  const finishedAt = new Date();
  run.status = 'completed';
  run.finished_at = finishedAt;
  run.duration_ms = finishedAt - startedAt;
  run.findings_count = newRecs.length;
  run.critical_count = critical;
  run.high_count = high;
  run.tool_calls = toolCalls.length;
  run.tokens_used = tokensUsed;
  run.summary = summary;
  await run.save();

  logger.info(`[SENTINEL] '${subLens.name}' completa — ${newRecs.length} findings (${critical} critical, ${high} high), ${toolCalls.length} tools, ${Math.round(run.duration_ms / 1000)}s`);

  return {
    sub_lens: subLens.name,
    findings: newRecs.length,
    critical,
    high,
    duration_ms: run.duration_ms
  };
}

/**
 * Corre el sentinel completo (daily o weekly).
 * Sub-lentes se ejecutan en serie para no saturar la API de Claude.
 */
async function runSentinel(mode = 'daily') {
  const lenses = mode === 'weekly' ? WEEKLY_LENSES : DAILY_LENSES;
  logger.info(`[SENTINEL] Iniciando pasada '${mode}' con ${lenses.length} sub-lentes`);

  const results = [];
  for (const lens of lenses) {
    const r = await runSubLens(lens, mode);
    results.push(r);
  }

  const totals = results.reduce((acc, r) => {
    acc.findings += r.findings || 0;
    acc.critical += r.critical || 0;
    acc.high += r.high || 0;
    return acc;
  }, { findings: 0, critical: 0, high: 0 });

  logger.info(`[SENTINEL] Pasada '${mode}' completa — ${totals.findings} findings (${totals.critical} critical, ${totals.high} high)`);

  return { mode, results, totals };
}

module.exports = { runSentinel, runSubLens };
