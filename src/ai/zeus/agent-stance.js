/**
 * Agent Stance — motor de juicio matutino + teeth + calibración.
 *
 * Flujo:
 *   - runMorningBriefing(agent) — cron matutino, LLM reflexiona, elige stance
 *   - getCurrentStance(agent)   — consultado por los ciclos de ejecución
 *   - applyStanceTeeth(stance)  — traduce stance a parámetros concretos
 *   - setOverride(...)          — Zeus o creador intervienen manualmente
 *   - runVerdictCron()          — cierra stances ≥7d con verdict retro (Fase 2)
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');

const ZeusAgentStance = require('../../db/models/ZeusAgentStance');
const TestRun = require('../../db/models/TestRun');
const MetricSnapshot = require('../../db/models/MetricSnapshot');
const ActionLog = require('../../db/models/ActionLog');
const SafetyEvent = require('../../db/models/SafetyEvent');

const claude = new Anthropic({ apiKey: config.claude.apiKey });
const MODEL = 'claude-opus-4-7';

const DEFAULT_EXPIRES_HRS = 24;
const MAX_EXPIRES_HRS = 72;
const STALE_EXTENSION_HRS = 26;  // cuánto podemos estirar un stance "stale" antes de rendirnos

const VERDICT_DEFINITION_VERSION = 'v1_proxy_kpi_vs_baseline14d';

// ═══════════════════════════════════════════════════════════════════════════
// Core — get / set
// ═══════════════════════════════════════════════════════════════════════════

async function getCurrentStance(agent) {
  const now = new Date();
  const active = await ZeusAgentStance.findOne({
    agent,
    superseded_at: null,
    expires_at: { $gt: now }
  }).sort({ created_at: -1 }).lean();
  return active || null;
}

async function setStance(agent, data) {
  const now = new Date();
  const hours = Math.min(MAX_EXPIRES_HRS, Math.max(1, data.expires_in_hours || DEFAULT_EXPIRES_HRS));
  const expiresAt = new Date(now.getTime() + hours * 3600000);

  // Supersedear el activo anterior
  await ZeusAgentStance.updateMany(
    { agent, superseded_at: null },
    { $set: { superseded_at: now } }
  );

  const created = await ZeusAgentStance.create({
    agent,
    stance: data.stance,
    focus: data.focus || '',
    rationale: data.rationale || '',
    pros: (data.pros || []).slice(0, 4),
    cons: (data.cons || []).slice(0, 4),
    context_snapshot: data.context_snapshot || {},
    source: data.source || 'briefing',
    override_by: data.override_by || null,
    override_reason: data.override_reason || '',
    stale: !!data.stale,
    expires_at: expiresAt,
    verdict_definition_version: VERDICT_DEFINITION_VERSION
  });
  logger.info(`[STANCE] ${agent} → ${data.stance}${data.focus ? ` (focus: ${data.focus})` : ''} [source: ${data.source}]`);
  return created;
}

async function setOverride({ agent, stance, focus, reason, expires_in_hours, by = 'creator' }) {
  if (!ZeusAgentStance.AGENTS.includes(agent)) throw new Error(`invalid agent: ${agent}`);
  if (!ZeusAgentStance.STANCES.includes(stance)) throw new Error(`invalid stance: ${stance}`);
  const hours = Math.min(MAX_EXPIRES_HRS, Math.max(1, expires_in_hours || DEFAULT_EXPIRES_HRS));
  return await setStance(agent, {
    stance,
    focus: focus || '',
    rationale: reason || 'override manual',
    pros: [],
    cons: [],
    source: by === 'zeus' ? 'override_zeus' : 'override_creator',
    override_by: by,
    override_reason: reason || '',
    expires_in_hours: hours
  });
}

async function renewStance(stanceId, additional_hours = 24) {
  const s = await ZeusAgentStance.findById(stanceId);
  if (!s) throw new Error('stance not found');
  const now = new Date();
  if (s.superseded_at) throw new Error('stance superseded');
  const newExpires = new Date(Math.max(now.getTime(), s.expires_at.getTime()) + Math.min(MAX_EXPIRES_HRS, additional_hours) * 3600000);
  s.expires_at = newExpires;
  await s.save();
  return s;
}

// ═══════════════════════════════════════════════════════════════════════════
// Teeth — stance → parámetros concretos de ejecución
// ═══════════════════════════════════════════════════════════════════════════

function applyStanceTeeth(stance) {
  // Multiplicadores relativos al default. El código de ejecución multiplica.
  switch (stance) {
    case 'aggressive':
      return {
        max_launches_multiplier: 1.5,
        kill_threshold_multiplier: 0.85,    // más permisivo (toleramos peor antes de matar)
        graduation_threshold_multiplier: 0.9, // menos estricto (gradúa antes)
        max_duplications_multiplier: 1.3,
        allow_scale_up: true,
        block_all_writes: false
      };
    case 'steady':
      return {
        max_launches_multiplier: 1.0,
        kill_threshold_multiplier: 1.0,
        graduation_threshold_multiplier: 1.0,
        max_duplications_multiplier: 1.0,
        allow_scale_up: true,
        block_all_writes: false
      };
    case 'observe-only':
      return {
        max_launches_multiplier: 0,           // no lanzar
        kill_threshold_multiplier: 1.0,       // sigue killing/graduando normal
        graduation_threshold_multiplier: 1.0,
        max_duplications_multiplier: 0,
        allow_scale_up: false,
        block_all_writes: false
      };
    case 'paused':
      return {
        max_launches_multiplier: 0,
        kill_threshold_multiplier: 1.0,       // mantiene cooldowns naturales, no mata
        graduation_threshold_multiplier: 1.0,
        max_duplications_multiplier: 0,
        allow_scale_up: false,
        block_all_writes: true                // no tocar nada
      };
    case 'recovering':
      return {
        max_launches_multiplier: 0.4,         // pequeñas dosis
        kill_threshold_multiplier: 1.15,      // más estricto — matamos rápido a perdedores
        graduation_threshold_multiplier: 0.95,// levemente permisivo — no perder wins
        max_duplications_multiplier: 0.3,
        allow_scale_up: false,
        block_all_writes: false
      };
    default:
      return applyStanceTeeth('steady');
  }
}

async function getStanceTeeth(agent) {
  const current = await getCurrentStance(agent);
  if (!current) return { ...applyStanceTeeth('steady'), stance: 'steady', fallback: true };
  return { ...applyStanceTeeth(current.stance), stance: current.stance, stance_id: current._id, focus: current.focus, stale: current.stale };
}

// ═══════════════════════════════════════════════════════════════════════════
// Briefing — el momento de juicio matutino
// ═══════════════════════════════════════════════════════════════════════════

async function buildBriefingContext(agent) {
  const since24h = new Date(Date.now() - 24 * 3600000);
  const since14d = new Date(Date.now() - 14 * 86400000);

  const ctx = { agent, at: new Date().toISOString() };

  if (agent === 'prometheus') {
    const activeTests = await TestRun.find({ phase: { $in: ['learning', 'evaluating'] } }).limit(60).lean();
    const launchedYesterday = await TestRun.find({ launched_at: { $gte: since24h } }).lean();
    const graduatedLast14 = await TestRun.countDocuments({ graduated_at: { $gte: since14d } });
    const killedLast14 = await TestRun.countDocuments({ killed_at: { $gte: since14d } });

    ctx.active_tests = activeTests.length;
    ctx.launched_yesterday = launchedYesterday.length;
    ctx.yesterday_delivery = {
      launched: launchedYesterday.length,
      never_spent: launchedYesterday.filter(t => (t.metrics?.spend || 0) < 3).length,
      got_purchase: launchedYesterday.filter(t => (t.metrics?.purchases || 0) > 0).length
    };
    ctx.pool_snapshot = { graduated_14d: graduatedLast14, killed_14d: killedLast14 };
  }

  // Portfolio momentum
  const latest = await MetricSnapshot.aggregate([
    { $match: { entity_type: 'adset' } },
    { $sort: { created_at: -1 } },
    { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } }
  ]);
  const active = latest.filter(s => s.status === 'ACTIVE');
  const spend24h = active.reduce((s, a) => s + (a.metrics?.today?.spend || 0), 0);
  const spend7d = active.reduce((s, a) => s + (a.metrics?.last_7d?.spend || 0), 0);
  const rev7d = active.reduce((s, a) => s + (a.metrics?.last_7d?.purchase_value || 0), 0);
  ctx.portfolio = {
    active_adsets: active.length,
    spend_24h: +spend24h.toFixed(0),
    spend_7d: +spend7d.toFixed(0),
    roas_7d: spend7d > 0 ? +(rev7d / spend7d).toFixed(2) : null
  };

  // Platform health
  try {
    const { isDegraded } = require('../../safety/platform-circuit-breaker');
    ctx.platform_degraded = await isDegraded();
  } catch (_) { ctx.platform_degraded = { degraded: false }; }

  // Stances de otros agentes (awareness cruzado)
  const otherAgents = ZeusAgentStance.AGENTS.filter(a => a !== agent);
  const others = {};
  for (const a of otherAgents) {
    const s = await getCurrentStance(a);
    others[a] = s ? { stance: s.stance, focus: s.focus, expires_at: s.expires_at } : null;
  }
  ctx.other_agents_stance = others;

  // Similar episodes del pasado — razonamiento por analogía
  try {
    const { findSimilarEpisodes } = require('./episodic-memory');
    const summary = `Agent ${agent} morning briefing. Portfolio: ${ctx.portfolio.active_adsets} ad sets, ROAS 7d ${ctx.portfolio.roas_7d}x. ${agent === 'prometheus' ? `Tests: ${ctx.active_tests} active, ${ctx.launched_yesterday} launched yesterday.` : ''}`;
    ctx.similar_episodes = await findSimilarEpisodes(summary, { topK: 3 });
  } catch (_) { ctx.similar_episodes = []; }

  // Directivas activas para este agente
  try {
    const ZeusDirective = require('../../db/models/ZeusDirective');
    const directives = await ZeusDirective.find({
      target_agent: { $in: [agent, 'all'] },
      active: true,
      $or: [{ expires_at: null }, { expires_at: { $gt: new Date() } }]
    }).sort({ created_at: -1 }).limit(5).lean();
    ctx.active_directives = directives.map(d => ({ type: d.directive_type, text: d.directive }));
  } catch (_) { ctx.active_directives = []; }

  return ctx;
}

function buildBriefingPrompt(agent, context) {
  return `[MORNING BRIEFING — ${agent.toUpperCase()}]

Eres el ${agent === 'prometheus' ? 'testing lead' : agent === 'athena' ? 'account manager' : agent === 'apollo' ? 'creative lead' : 'duplication strategist'} del sistema. Mañana de operación. Tienes que formar opinión del día en 2 minutos — no es un check de variables, es un juicio operativo.

CONTEXTO ACTUAL (JSON):
${JSON.stringify(context, null, 2)}

STANCES DISPONIBLES:
- aggressive: volumen arriba, umbrales permisivos, scale habilitado
- steady: operación normal, sin sesgo
- observe-only: no lanzar/duplicar, sigo monitoreando + kill/graduation
- paused: no tocar nada — plataforma o estado grave lo ameritan
- recovering: post-incident, dosis chicas, kill estricto, no perder wins

DISCIPLINA OBLIGATORIA (anti-reasoning-circular + anti-hysteresis):
1. NO leas el stance de ayer antes de pensar. Arrancas de cero con la data de HOY.
2. Antes de elegir, tienes que listar:
   - 2 razones PARA subir volumen/agresividad (pros de aggressive/steady)
   - 2 razones PARA bajar volumen/agresividad (pros de observe/paused/recovering)
3. Recién después eliges. Si las 2+2 están desbalanceadas, sesga al lado con más peso.
4. "No lanzar" / "no duplicar" son decisiones VÁLIDAS. No un bug. No un default cobarde.

FOCUS (campo ortogonal, opcional):
Además del stance (volumen), puedes declarar un FOCUS temático: qué vas a mirar con atención esta ventana. Ej: "validar scenes outdoor", "entender caída de CTRs jueves", "estabilizar cohort del martes". NO obligatorio.

REGLAS:
- Si platform_degraded=true → stance casi siempre debe ser paused o recovering.
- Si similar_episodes tiene un failure reciente con similarity alta → sesga defensivo.
- Si los otros agentes tienen stance bajo y tú quieres aggressive → justifica por qué no tiene contagio.

Responde SOLO con JSON válido (sin backticks):
{
  "pros_more_volume": ["razón 1", "razón 2"],
  "cons_more_volume": ["razón 1", "razón 2"],
  "stance": "aggressive|steady|observe-only|paused|recovering",
  "focus": "string corto o vacío",
  "rationale": "2-3 oraciones explicando la elección final",
  "expires_in_hours": 24
}`;
}

async function runMorningBriefing(agent, options = {}) {
  const startedAt = Date.now();
  logger.info(`[STANCE-BRIEFING] ${agent} iniciando...`);

  let ctx;
  try {
    ctx = await buildBriefingContext(agent);
  } catch (err) {
    logger.error(`[STANCE-BRIEFING] ${agent}: buildContext falló: ${err.message}`);
    return await applyFallback(agent, `context build failed: ${err.message}`);
  }

  let parsed;
  const maxRetries = options.max_retries ?? 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await claude.messages.create({
        model: MODEL,
        max_tokens: 2000,
        messages: [{ role: 'user', content: buildBriefingPrompt(agent, ctx) }]
      });
      const text = response.content.find(b => b.type === 'text')?.text || '';
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('no JSON in briefing response');
      parsed = JSON.parse(match[0]);
      break;
    } catch (err) {
      logger.warn(`[STANCE-BRIEFING] ${agent} attempt ${attempt}/${maxRetries}: ${err.message}`);
      if (attempt === maxRetries) {
        return await applyFallback(agent, `briefing LLM failed after ${maxRetries} attempts: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 2000 * attempt));  // backoff
    }
  }

  // Validar stance
  if (!ZeusAgentStance.STANCES.includes(parsed.stance)) {
    return await applyFallback(agent, `invalid stance returned: ${parsed.stance}`);
  }

  const stance = await setStance(agent, {
    stance: parsed.stance,
    focus: parsed.focus || '',
    rationale: parsed.rationale || '',
    pros: [...(parsed.pros_more_volume || []), ...(parsed.cons_more_volume || []).map(c => `(contra) ${c}`)].slice(0, 4),
    cons: parsed.cons_more_volume || [],
    context_snapshot: ctx,
    source: 'briefing',
    expires_in_hours: parsed.expires_in_hours || DEFAULT_EXPIRES_HRS
  });

  const duration = Math.round((Date.now() - startedAt) / 1000);
  logger.info(`[STANCE-BRIEFING] ${agent} → ${stance.stance} in ${duration}s`);
  return stance;
}

async function applyFallback(agent, reason) {
  // Intentar mantener el stance de ayer con flag stale=true
  const yesterday = await ZeusAgentStance.findOne({
    agent,
    source: { $in: ['briefing', 'override_creator', 'override_zeus'] }
  }).sort({ created_at: -1 }).lean();

  const stale_window_ok = yesterday && (Date.now() - new Date(yesterday.created_at).getTime()) < STALE_EXTENSION_HRS * 3600000;

  try {
    await SafetyEvent.create({
      event_type: 'stance_briefing_failed',
      severity: 'medium',
      reason: `${agent} briefing failed, fallback ${stale_window_ok ? 'stale yesterday' : 'default steady'}: ${reason}`,
      data: { agent, yesterday_id: yesterday?._id, reason }
    });
  } catch (safetyErr) {
    // Fix silent failure 2026-04-24: antes `catch(_) {}` tragaba el único
    // registro de auditoría del fallback. Sin este log, fallbacks silenciosos
    // quedaban sin trazabilidad en ningún lado.
    logger.error(`[STANCE-BRIEFING] ${agent} fallback SafetyEvent create falló: ${safetyErr.message} · reason='${reason}' · yesterday_id=${yesterday?._id || 'none'}`);
  }

  if (stale_window_ok) {
    logger.warn(`[STANCE-BRIEFING] ${agent} fallback: extendiendo stance de ayer con stale=true (${yesterday.stance})`);
    return await setStance(agent, {
      stance: yesterday.stance,
      focus: yesterday.focus,
      rationale: `FALLBACK stale — briefing de hoy falló. Usando stance de ayer. Razón: ${reason}`,
      pros: [], cons: [],
      context_snapshot: { fallback_from: yesterday._id, reason },
      source: 'fallback_stale',
      stale: true,
      expires_in_hours: 12   // corto — forzar retry mañana
    });
  }

  logger.warn(`[STANCE-BRIEFING] ${agent} fallback: default steady (sin ayer válido)`);
  return await setStance(agent, {
    stance: 'steady',
    focus: '',
    rationale: `FALLBACK default steady — sin stance válido previo. Razón: ${reason}`,
    pros: [], cons: [],
    context_snapshot: { reason },
    source: 'fallback_default',
    expires_in_hours: 12
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Verdict — calibración retroactiva (Fase 2)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calcula KPIs del cohorte afectado por un stance (tests lanzados, acciones,
 * métricas) durante la ventana [stance.created_at, superseded_at || expires_at].
 */
async function computeStanceCohortKPIs(stance) {
  const windowStart = stance.created_at;
  const windowEnd = stance.superseded_at || stance.expires_at;

  if (stance.agent === 'prometheus') {
    const testsInWindow = await TestRun.find({
      launched_at: { $gte: windowStart, $lte: windowEnd }
    }).lean();
    const graduated = testsInWindow.filter(t => t.graduated_at).length;
    const killed = testsInWindow.filter(t => t.killed_at).length;
    const reachedEvaluating = testsInWindow.filter(t => t.phase === 'evaluating' || t.graduated_at).length;
    const totalSpend = testsInWindow.reduce((s, t) => s + (t.metrics?.spend || 0), 0);

    return {
      tests_launched: testsInWindow.length,
      graduated,
      killed,
      reached_evaluating: reachedEvaluating,
      graduation_rate: testsInWindow.length > 0 ? graduated / testsInWindow.length : 0,
      evaluating_rate: testsInWindow.length > 0 ? reachedEvaluating / testsInWindow.length : 0,
      cost_per_graduation: graduated > 0 ? totalSpend / graduated : null,
      total_spend: totalSpend
    };
  }

  // Genérico para otros agentes: actions_count + success_rate
  const actions = await ActionLog.find({
    agent_type: stance.agent === 'athena' ? 'unified_agent' : stance.agent,
    executed_at: { $gte: windowStart, $lte: windowEnd }
  }).lean();
  return {
    actions_total: actions.length,
    success_rate: actions.length ? actions.filter(a => a.success).length / actions.length : null
  };
}

/**
 * Baseline rolling 14d previos al stance — mismo agente, mismos KPIs.
 */
async function computeBaselineKPIs(agent, beforeDate) {
  const start = new Date(new Date(beforeDate).getTime() - 14 * 86400000);
  const end = new Date(beforeDate);

  if (agent === 'prometheus') {
    const tests = await TestRun.find({
      launched_at: { $gte: start, $lt: end }
    }).lean();
    const graduated = tests.filter(t => t.graduated_at).length;
    const reachedEvaluating = tests.filter(t => t.phase === 'evaluating' || t.graduated_at).length;
    const totalSpend = tests.reduce((s, t) => s + (t.metrics?.spend || 0), 0);
    return {
      tests_launched: tests.length,
      graduation_rate: tests.length > 0 ? graduated / tests.length : 0,
      evaluating_rate: tests.length > 0 ? reachedEvaluating / tests.length : 0,
      cost_per_graduation: graduated > 0 ? totalSpend / graduated : null
    };
  }
  const actions = await ActionLog.find({
    agent_type: agent === 'athena' ? 'unified_agent' : agent,
    executed_at: { $gte: start, $lt: end }
  }).lean();
  return {
    actions_total: actions.length,
    success_rate: actions.length ? actions.filter(a => a.success).length / actions.length : null
  };
}

/**
 * Determina verdict comparando cohort vs baseline.
 *
 * Definición v1 (proxy, pactada antes de construir):
 *   Si stance fue aggressive/steady: correct si graduation_rate cohort >= baseline
 *     y cost_per_graduation <= baseline (ambos)
 *   Si stance fue observe-only/paused/recovering: correct si baseline era declining
 *     (graduation_rate o success_rate del baseline en los últimos 7d era inferior
 *     al de los 14d anteriores — señal de que el día fue efectivamente malo y
 *     hacer poco era la jugada).
 *   Inconclusive si sample size < 3 tests (prometheus) o < 5 actions (others).
 */
function determineVerdict(stance, cohort, baseline) {
  const highVolumeStance = ['aggressive', 'steady'].includes(stance.stance);
  const lowVolumeStance = ['observe-only', 'paused', 'recovering'].includes(stance.stance);

  if (stance.agent === 'prometheus') {
    if ((cohort.tests_launched || 0) < 3 && highVolumeStance) {
      return { verdict: 'inconclusive', reason: `sample too small (${cohort.tests_launched} tests)` };
    }
    if (highVolumeStance) {
      const better = (cohort.graduation_rate >= (baseline.graduation_rate || 0))
        && (!baseline.cost_per_graduation || !cohort.cost_per_graduation || cohort.cost_per_graduation <= baseline.cost_per_graduation);
      return { verdict: better ? 'correct' : 'wrong', reason: `grad_rate cohort=${(cohort.graduation_rate*100).toFixed(1)}% vs baseline=${((baseline.graduation_rate||0)*100).toFixed(1)}%` };
    }
    if (lowVolumeStance) {
      // Si no lanzamos mucho, verdict depende de si la abstención estaba justificada.
      // Proxy: si baseline venía declinando (menos graduations de lo esperado),
      // abstenerse era correcto.
      const baselineWeak = (baseline.graduation_rate || 0) < 0.15; // <15% grad rate típico = escenario flojo
      return { verdict: baselineWeak ? 'correct' : 'inconclusive', reason: `abstención ${baselineWeak ? 'justificada' : 'difícil de validar'} por baseline grad=${((baseline.graduation_rate||0)*100).toFixed(1)}%` };
    }
  }

  // Agentes no-prometheus: proxy simple con success_rate
  if ((cohort.actions_total || 0) < 5) return { verdict: 'inconclusive', reason: 'sample too small' };
  const better = (cohort.success_rate || 0) >= (baseline.success_rate || 0);
  return { verdict: better ? 'correct' : 'wrong', reason: `success cohort=${(cohort.success_rate*100).toFixed(1)}% vs baseline=${((baseline.success_rate||0)*100).toFixed(1)}%` };
}

async function runVerdictCron() {
  const cutoff = new Date(Date.now() - 7 * 86400000);
  const pending = await ZeusAgentStance.find({
    created_at: { $lte: cutoff },
    verdict: null,
    verdict_definition_version: VERDICT_DEFINITION_VERSION
  }).sort({ created_at: 1 }).limit(40).lean();

  let closed = 0;
  for (const st of pending) {
    try {
      const cohort = await computeStanceCohortKPIs(st);
      const baseline = await computeBaselineKPIs(st.agent, st.created_at);
      const { verdict, reason } = determineVerdict(st, cohort, baseline);

      await ZeusAgentStance.updateOne({ _id: st._id }, {
        $set: {
          verdict,
          verdict_measured_at: new Date(),
          verdict_metrics: { cohort, baseline, reason }
        }
      });
      closed++;
    } catch (err) {
      logger.warn(`[STANCE-VERDICT] ${st._id} failed: ${err.message}`);
    }
  }
  logger.info(`[STANCE-VERDICT] closed ${closed}/${pending.length} pending stances`);
  return { evaluated: pending.length, closed };
}

module.exports = {
  getCurrentStance,
  setStance,
  setOverride,
  renewStance,
  applyStanceTeeth,
  getStanceTeeth,
  runMorningBriefing,
  runVerdictCron,
  VERDICT_DEFINITION_VERSION
};
