/**
 * Sub-lente Lens 1 — Plan Readiness.
 *
 * No corre en cron propio: se invoca DESDE el planner cada vez que se genera
 * un plan. Para cada goal, verifica si el código actual del agente responsable
 * puede ejecutarlo. Anota gaps en el plan + crea ZeusCodeRecommendation
 * cuando el gap es crítico.
 */

const logger = require('../../../utils/logger');
const { runOracle } = require('../oracle-runner');
const ZeusCodeRecommendation = require('../../../db/models/ZeusCodeRecommendation');
const ZeusAuditRun = require('../../../db/models/ZeusAuditRun');

const AGENT_FILE_MAP = `
- athena (Account Agent)     → src/ai/agents/*account*, src/dashboard/routes/agent.js
- apollo (Creative Agent)    → src/dashboard/routes/creative-agent.js, src/ai/creative/*
- prometheus (Testing Agent) → src/dashboard/routes/testing-agent.js
- ares (Duplication Agent)   → src/dashboard/routes/ares.js
`.trim();

function buildPrompt(plan) {
  const goalsText = (plan.goals || []).map((g, i) => {
    const by = g.by_date ? new Date(g.by_date).toISOString().substring(0, 10) : '—';
    return `  ${i + 1}. [${g.priority}] ${g.metric} → target ${g.target} (by ${by})`;
  }).join('\n');

  const milestonesText = (plan.milestones || []).slice(0, 5).map(m => {
    const by = m.by_date ? new Date(m.by_date).toISOString().substring(0, 10) : '—';
    return `  - ${m.description} (by ${by})`;
  }).join('\n');

  return `[SENTINEL — LENS 1: PLAN READINESS CHECK]

Sos Zeus en modo centinela, verificando si el código ACTUAL puede ejecutar el plan que acabás de generar. Este es tu reality check ANTES de que el creador apruebe el plan.

PLAN (${plan.horizon}, ${plan.period_start.toISOString().substring(0, 10)} → ${plan.period_end.toISOString().substring(0, 10)}):
Summary: ${plan.summary || '(vacío)'}

GOALS:
${goalsText || '  (ninguno)'}

MILESTONES:
${milestonesText || '  (ninguno)'}

AGENTES Y DÓNDE VIVE SU CÓDIGO:
${AGENT_FILE_MAP}

TU TAREA:
Para cada GOAL del plan, determiná:
1. ¿Qué agente(s) lo ejecutan?
2. ¿El código actual de ese agente puede cumplirlo? Usá grep_code + read_code_file para VERIFICAR — no asumas.
3. Si NO puede, describí el gap concreto en 1 oración.

Para cada MILESTONE accionable (no todos lo son), si detectás que requiere capability nueva, marcalo como gap también.

Si encontrás un gap CRÍTICO (goal priority high/critical + capable=false), creá una ZeusCodeRecommendation con propose_code_change — category='refactor', severity='high', rationale que explique qué capability falta y dónde agregarla.

REGLAS:
- Sé conservador con "capable=false" — solo si claramente falta código, no si "podría estar mejor".
- NO inventes archivos. Si no encontrás con grep_code, capable=false con gap="agente no parece tener handler para esta métrica".
- NO propongas cambios a oracle-runner.js, oracle-tools.js, agent-brains.js, code-tools.js, oracle-proactive.js.

Respondé SOLO con JSON válido, sin backticks, formato exacto:
{
  "readiness": [
    { "goal_metric": "string", "agent": "athena|apollo|prometheus|ares|multiple", "file": "path/to/file.js:123", "capable": true|false, "gap_description": "si no capable" }
  ],
  "summary": "string de 1-2 oraciones — X/Y goals listos, gaps principales"
}`;
}

/**
 * Corre el readiness check sobre un plan draft. Retorna { entries, summary }
 * y crea recs si hay gaps críticos. No muta el plan — el caller decide cómo persistir.
 */
async function checkPlanReadiness(plan) {
  const startedAt = new Date();
  const run = await ZeusAuditRun.create({
    lens: 'plan_readiness',
    sub_lens: null,
    mode: 'on_demand',
    started_at: startedAt,
    status: 'running'
  });

  logger.info(`[LENS1-READINESS] Check plan ${plan._id} (${plan.horizon})`);

  let result;
  let toolCalls = [];
  let tokensUsed = 0;

  try {
    const oracle = await runOracle({
      userMessage: buildPrompt(plan),
      mode: 'chat',
      history: [],
      lastSeenAt: null,
      onEvent: (type, data) => {
        if (type === 'tool_use_start') toolCalls.push(data.tool);
      }
    });
    const raw = oracle.text || '';
    tokensUsed = oracle.tokens_used || 0;

    // Extraer JSON del output
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON en respuesta del readiness check');
    result = JSON.parse(match[0]);
  } catch (err) {
    logger.error(`[LENS1-READINESS] Falló: ${err.message}`);
    run.status = 'failed';
    run.error = err.message;
    run.finished_at = new Date();
    run.duration_ms = run.finished_at - startedAt;
    await run.save();
    return { entries: [], summary: 'readiness check falló', error: err.message };
  }

  const entries = (result.readiness || []).map(r => ({
    goal_metric: r.goal_metric || '',
    agent: r.agent || 'multiple',
    file: r.file || '',
    capable: r.capable !== false,
    gap_description: r.gap_description || '',
    rec_id: null
  }));

  // Linkear recs que Zeus creó durante esta pasada (taggeadas post-facto)
  const newRecs = await ZeusCodeRecommendation.find({
    created_at: { $gte: startedAt },
    lens: null
  });

  let critical = 0;
  let high = 0;
  for (const rec of newRecs) {
    rec.lens = 'plan_readiness';
    rec.sub_lens = null;
    rec.audit_run_id = run._id;
    await rec.save();
    if (rec.severity === 'critical') critical++;
    if (rec.severity === 'high') high++;
  }

  // Asociar cada rec al gap correspondiente por file path match (best effort)
  for (const rec of newRecs) {
    const entry = entries.find(e => e.file && rec.file_path && e.file.startsWith(rec.file_path));
    if (entry) entry.rec_id = rec._id;
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
  run.summary = (result.summary || '').substring(0, 500);
  await run.save();

  logger.info(`[LENS1-READINESS] ${entries.length} goals evaluados, ${newRecs.length} gaps marcados como recs`);

  return {
    entries,
    summary: result.summary || '',
    run_id: run._id
  };
}

module.exports = { checkPlanReadiness };
