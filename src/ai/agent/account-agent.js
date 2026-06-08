const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const safetyGuards = require('../../../config/safety-guards');
const kpiTargets = require('../../../config/kpi-targets');
const logger = require('../../utils/logger');
const ActionLog = require('../../db/models/ActionLog');
const BrainInsight = require('../../db/models/BrainInsight');
const BrainMemory = require('../../db/models/BrainMemory');
const MetricSnapshot = require('../../db/models/MetricSnapshot');
const StrategicDirective = require('../../db/models/StrategicDirective');
const { getMetaClient } = require('../../meta/client');
const { getLatestSnapshots, getAdsForAdSet, getSnapshotFreshness } = require('../../db/queries');
const { isExcludedEntity } = require('../../config/excluded-entities');
const { CooldownManager } = require('../../safety/cooldown-manager');
const GuardRail = require('../../safety/guard-rail');
const PolicyLearner = require('../unified/policy-learner');
const { hardcodedDecisionTree, forceKill, forceScaleDown } = require('./safety-decisions');

const client = new Anthropic({ apiKey: config.claude.apiKey });

const { TIERED_COOLDOWN_HOURS } = require('../../safety/cooldown-manager');

/**
 * Check cooldown for unified_agent only — ignores legacy ai_manager/brain actions.
 * This lets the Account Agent start fresh without inheriting cooldowns from the old system.
 */
async function _isOnAgentCooldown(entityId) {
  const MIN_COOLDOWN_HOURS = 120; // 5 days minimum between actions on same entity
  const COOLDOWN_DAYS = 6; // lookback window
  const since = new Date(Date.now() - COOLDOWN_DAYS * 86400000);

  // Check both entity_id and parent_adset_id (ad-level actions affect the ad set)
  const lastAction = await ActionLog.findOne({
    $or: [{ entity_id: entityId }, { parent_adset_id: entityId }],
    agent_type: 'unified_agent',
    success: true,
    executed_at: { $gte: since }
  }).sort({ executed_at: -1 }).lean();

  if (!lastAction) return { onCooldown: false };

  const tieredHours = Math.max(MIN_COOLDOWN_HOURS, TIERED_COOLDOWN_HOURS[lastAction.action] || 120);
  const cooldownUntil = new Date(new Date(lastAction.executed_at).getTime() + tieredHours * 3600000);
  const now = new Date();

  if (cooldownUntil > now) {
    return {
      onCooldown: true,
      minutesLeft: Math.round((cooldownUntil - now) / 60000),
      hoursLeft: Math.round((cooldownUntil - now) / 3600000),
      lastAction: lastAction.action
    };
  }
  return { onCooldown: false };
}

/**
 * Marca directivas activas de Zeus como ejecutadas cuando Athena cumple una accion.
 * Matchea por entity_id en data + tipo de accion.
 */
async function _markZeusDirectivesExecuted(adsetId, actionType, actionLogId, resultText) {
  try {
    const ZeusDirective = require('../../db/models/ZeusDirective');
    // Buscar directivas activas, no ejecutadas, dirigidas a Athena
    const activeDirectives = await ZeusDirective.find({
      target_agent: { $in: ['athena', 'all'] },
      active: true,
      executed: false
    }).lean();

    // Matchear: data.adset_id puede ser el meta_id numerico, el numero ordinal ("29"),
    // o el NOMBRE completo del ad set ("Campfire Snacks... [Prometheus]"). Todos los casos se cubren.
    const adsetIdStr = String(adsetId);
    // Buscar el snapshot para obtener el nombre del ad set
    const allSnaps = await getLatestSnapshots('adset');
    const snap = allSnaps.find(s => s.entity_id === adsetIdStr);
    const adsetName = (snap?.entity_name || '').toLowerCase();
    // Numero del ad set (suele ser solo digitos para legacy: "40")
    const adsetNumber = adsetName.match(/^\d+$/) ? adsetName : null;

    const matchedIds = [];
    for (const d of activeDirectives) {
      const data = d.data || {};
      const dirText = (d.directive || '').toLowerCase();

      // Match por entity_id estructurado — 3 formas: meta_id exacto, numero ordinal, nombre completo
      const dataAdsetId = String(data.ad_set_id || data.adset_id || '');
      const dataAdsetIdLower = dataAdsetId.toLowerCase();
      const matchById = dataAdsetId && (
        dataAdsetId === adsetIdStr ||                              // meta_id exacto
        (adsetNumber && dataAdsetId === adsetNumber) ||            // ordinal "29" === nombre "29"
        (adsetName && dataAdsetIdLower === adsetName)              // nombre "Campfire... [Prometheus]" === entity_name
      );

      // Match por accion en el data
      const dataAction = (data.action || '').toLowerCase();
      const matchByAction = dataAction === actionType ||
        (actionType.startsWith('scale') && dataAction.startsWith('scale'));

      // Match por nombre/numero en el texto de la directiva
      const matchByNumberInText = adsetNumber && dirText.includes(`ad set ${adsetNumber}`);
      // Match por nombre del ad set dentro del texto — util cuando Zeus narra sin structured data
      // Usamos un substring significativo (primeros 30 chars) porque el nombre puede ser largo
      const adsetNameSignificant = adsetName && adsetName.length >= 10 ? adsetName.substring(0, Math.min(40, adsetName.length)) : null;
      const matchByNameInText = adsetNameSignificant && dirText.includes(adsetNameSignificant);
      const matchByText = (matchByNumberInText || matchByNameInText) && (
        (actionType.startsWith('scale') && dirText.includes('scale')) ||
        (actionType === 'pause' && (dirText.includes('pause') || dirText.includes('kill'))) ||
        (actionType === 'pause_adset' && (dirText.includes('pause') || dirText.includes('kill')))
      );

      if ((matchById && matchByAction) || matchByText) {
        matchedIds.push(d._id);
      }
    }

    if (matchedIds.length > 0) {
      await ZeusDirective.updateMany(
        { _id: { $in: matchedIds } },
        {
          $set: {
            executed: true,
            executed_at: new Date(),
            executed_by_action_id: actionLogId,
            execution_result: resultText
          }
        }
      );
      logger.info(`[ACCOUNT-AGENT] ${matchedIds.length} directiva(s) de Zeus marcada(s) como executed para ${adsetId}`);
    }
  } catch (err) {
    logger.warn(`[ACCOUNT-AGENT] Error marcando directivas Zeus: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — personalidad y reglas del agente unificado
// ═══════════════════════════════════════════════════════════════════════════════
const AGENT_SYSTEM_PROMPT = `You are Athena, the autonomous account strategist for Jersey Pickles Meta Ads. You manage ALL active ad sets (production + [Prometheus] graduates).

## CORE PHILOSOPHY — DATA-DRIVEN DECISIONS
Evaluate each ad set objectively based on its data. Act when the data justifies it — scale winners, pause losers, hold when unclear. Do not be afraid to act. Do not default to HOLD out of caution. Every cycle you HOLD a winner at low budget is revenue lost.

## COOLDOWNS (respect these — after acting, set next_review_hours)
- After scale_budget: next_review_hours = 48. Let Meta optimize with new budget.
- After pause_ad: next_review_hours = 72. Let remaining ads absorb.
- After pause_adset: no revisit. It is dead.
- After HOLD: next_review_hours = 24. Check again tomorrow.

## TARGET POR-ADSET (cuando aparece en el contexto, MANDA sobre los umbrales globales)
- Si el contexto trae "TARGET POR-ADSET", juzgá ese adset contra SU baseline y SU piso, no contra el 3x/1.5x global. Un adset que probó rendir 5x y cae a 2.5x está degradando → scale_down, aunque 2.5 > 1.5 global. Un adset modesto estable EN su baseline (ej. 1.8x) está sano → no lo bajes.
- "BAJO SU PISO" → scale_down (o pausa si además freq/edad lo justifican). "DEGRADANDO" → vigilá, scale_down si 3d confirma. "en línea con su baseline" + freq sana → escalá con confianza.
- Si NO hay target por-adset (adset nuevo / poca data), usá los umbrales globales de abajo.

## SCALE UP
- 🎓 GRADUADO PROBADO (PRIORIDAD #1) — el ad set ya pasó por testing si su nombre termina en "[Prometheus]" O tiene ROAS 7d >= 3x con >= 2 compras. ESO YA ES PRUEBA: NO lo trates como "data insuficiente" ni esperes $50 de spend. Escalalo YA aunque tenga spend bajo o esté fresco — un ganador de 5x NO puede quedarse hambriento a $20/día. Alimentar a tus graduados probados es el lever de crecimiento #1 del sistema. (Igual respeta: frequency < 3.0 y que la ROAS 3d no venga cayendo vs 7d.)
- ROAS 7d >= 3x with $50+ spend 7d → scale up. No other criteria needed.
- ROAS 7d >= account average with improving 3d trend → scale up.
- Frequency must be < 3.0 (not saturated).
- Zeus PRIORITIZE directive → scale immediately. Zeus already validated.
- MODO AGRESIVO: proponé +20% por defecto, hasta +25-30% para ganadores fuertes y probados (el scale-gate ajusta el paso final según el win-rate y el cash). Nota: subir >20% resetea el learning de Meta — vale la pena para un ganador probado que querés crecer rápido; para uno estable que solo mantenés, quedate en +15-20% sin reset.
- 📈 ROAS MARGINAL (la frontera eficiente) — si el contexto trae "ROAS MARGINAL", ESO MANDA sobre el ROAS 7d para decidir si SEGUIR escalando: mide si el dólar del último scale TODAVÍA rinde. HEADROOM PROFUNDO/EFICIENTE → escalá fuerte, hay espacio. CERCA DE LA FRONTERA → escalá chico (+10%) o mantené. SOBRE-ESCALADO → NO escales más (llegaste al techo de este adset), aunque el 7d mezclado se vea bien. Escalar al MÁXIMO = empujar mientras el marginal aguanta, frenar justo en la frontera — no hasta que rompa.
- 📡 SATURACIÓN DE AUDIENCIA (adelantada) — si el contexto trae "SATURACIÓN", es el techo de AUDIENCIA: FRESCO → escalá libre, hay gente nueva. CALENTANDO → escalá chico (+10%) y vigilá. SATURANDO → NO escales (más budget solo sube la frequency a la misma gente); el lever es expandir audiencia, no plata. No esperes a freq 3.0 (ahí ya quemaste). El ROAS marginal te dice el techo de EFICIENCIA; la saturación te dice el techo de AUDIENCIA — respetá el que llegue primero.
Then: set next_review_hours: 48.

## SCALE DOWN
- ROAS 7d < 1.5x with $100+ spend 7d AND 3d confirms decline → scale -20%.
Then: set next_review_hours: 72.

## MOVE BUDGET (reasignación suma-cero)
- Cuando un loser tiene budget que rinde menos que un winner con headroom, PREFERÍ move_budget sobre subir el winner — no infla el spend total, solo mejora el mix.
- Solo de PEOR a MEJOR (source ROAS < target ROAS). El target no puede estar en declive (ROAS 3d cayendo).
- Es mejor que pausar el loser y esperar que "Zeus redistribuya": acá el budget va directo al ganador.
- Ej: source ROAS 1.2x con $30 → mover $15 a un target ROAS 4x con headroom.

## PAUSE AD
- Ad has $30+ spend, 0 purchases, 7+ days old.
- OR ROAS AND CTR declining across ALL windows (14d > 7d > 3d = dying).
- OR frequency > 4.0 (saturated).
Then: set next_review_hours: 72.

## PAUSE AD SET
- Zeus orders it (ALERT directive), OR
- ROAS 7d < 1.0x AND $200+ spend 7d AND 14+ days (sustained loser).
- Safety: account must have 10+ other healthy ad sets with ROAS > 2x.

## HOLD
- Data insufficient (< $50 spend 7d) → hold, check in 24h. EXCEPCIÓN: un GRADUADO PROBADO ([Prometheus] o ROAS≥3x con compras) NO es "data insuficiente" — ya se probó en testing. NO lo holdees: escalalo (ver SCALE UP, prioridad #1).
- Trend unclear (3d up but 7d down) → hold, check in 24h.
- Within cooldown from recent action → hold until cooldown expires.

## CREATIVE FLAGGING
After calling get_ad_performance, count ACTIVE ads:
- 0 or 1 active ads → ALWAYS set needs_new_creatives: true in save_assessment.
- 2 active ads with any fatigued/dying → set needs_new_creatives: true.

## CREATIVE ROTATION
- New ad has <$5 spend after 5+ days → pause oldest fatigued ad.
- Old ad healthy with freq < 2.0 → DO NOT rotate.

## KILLING FATIGUED ADS (safety)
- Before pausing LAST active ad, check: 10+ other healthy ad sets with ROAS > 2x?
- If YES: pause ad + pause ad set. Zeus redistributes.
- If NO: HOLD. Account needs capacity.
- NEVER leave ad set with 0 active ads and budget running.

## ZEUS DIRECTIVES
Zeus is the CEO. When he sends PRIORITIZE → act this cycle. When he sends HOLD/ALERT → respect it.

## METRICS
- **7d** = primary decision signal.
- **3d** = confirms direction. If 3d improving, trust it.
- **today** = noise. Ignore unless >$30 spend.

## ASSESSMENT FORMAT
Short, max 3-4 sentences in Spanish. Always include:
- **pending_plan**: Specific conditions. "Si ROAS 7d < 1.5x con $100+ spend, scale down 20%."
- **next_review_hours**: 48=stable (default), 120=after action, 168=after scale.

If you received YOUR PREVIOUS PLAN, check conditions and act only if met.

IMPORTANT: Always call save_assessment. Return ONLY tool calls, minimize text.`;

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS — 12 tools
// ═══════════════════════════════════════════════════════════════════════════════
const TOOLS = [
  {
    name: 'get_adset_metrics',
    description: 'Get 7d/3d/today metrics for the ad set plus account context. Call this first.',
    input_schema: {
      type: 'object',
      properties: {
        adset_id: { type: 'string', description: 'The Meta ad set ID' }
      },
      required: ['adset_id']
    }
  },
  {
    name: 'get_ad_performance',
    description: 'Get individual ad performance within this ad set (spend, ROAS, CTR, frequency, fatigue level).',
    input_schema: {
      type: 'object',
      properties: {
        adset_id: { type: 'string', description: 'The Meta ad set ID' }
      },
      required: ['adset_id']
    }
  },
  {
    name: 'get_scaling_history',
    description: 'Get last 15 measured actions (with rewards) for this entity.',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'The entity ID (ad set or ad)' }
      },
      required: ['entity_id']
    }
  },
  {
    name: 'get_bandit_signal',
    description: 'Get Thompson Sampling mean/bias for a specific action in the current context.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['scale_up', 'scale_down', 'pause', 'reactivate'], description: 'Action to query' },
        adset_id: { type: 'string', description: 'The ad set ID (for context metrics)' }
      },
      required: ['action', 'adset_id']
    }
  },
  {
    name: 'get_entity_memory',
    description: 'Get BrainMemory for this entity: trends, action_history, remembered metrics.',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'The entity ID' }
      },
      required: ['entity_id']
    }
  },
  {
    name: 'get_recent_insights',
    description: 'Get recent BrainInsights for this entity (anomalies, trends, milestones).',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'The entity ID' }
      },
      required: ['entity_id']
    }
  },
  {
    name: 'scale_budget',
    description: 'Change the ad set daily budget. Gated: cooldown 48h, max 25% increase, budget floor $10, guard-rail validation.',
    input_schema: {
      type: 'object',
      properties: {
        adset_id: { type: 'string', description: 'The Meta ad set ID' },
        new_budget: { type: 'number', description: 'New daily budget in USD' },
        reason: { type: 'string', description: 'Why you are scaling' }
      },
      required: ['adset_id', 'new_budget', 'reason']
    }
  },
  {
    name: 'move_budget',
    description: 'Reasignar budget de un ad set perdedor a uno ganador (SUMA CERO — no cambia el spend total). Usalo cuando hay un loser con budget que rinde menos que un winner con headroom: en vez de subir el winner (que infla el spend total) o solo pausar el loser (que deja el budget colgado esperando a Zeus). Gated: source queda > floor, source ROAS < target ROAS (solo de peor a mejor), target no en declive, aumento del target ≤20% (evita resetear el learning de Meta).',
    input_schema: {
      type: 'object',
      properties: {
        source_adset_id: { type: 'string', description: 'Ad set del que se SACA budget (el de peor ROAS)' },
        target_adset_id: { type: 'string', description: 'Ad set al que se DA budget (el de mejor ROAS, con headroom)' },
        amount: { type: 'number', description: 'Monto diario en USD a mover' },
        reason: { type: 'string', description: 'Por qué esta reasignación' }
      },
      required: ['source_adset_id', 'target_adset_id', 'amount', 'reason']
    }
  },
  {
    name: 'pause_ad',
    description: 'Pause a specific ad within an ad set. Gated: cooldown check.',
    input_schema: {
      type: 'object',
      properties: {
        ad_id: { type: 'string', description: 'The Meta ad ID to pause' },
        adset_id: { type: 'string', description: 'Parent ad set ID' },
        reason: { type: 'string', description: 'Why you are pausing this ad' }
      },
      required: ['ad_id', 'adset_id', 'reason']
    }
  },
  {
    name: 'reactivate_ad',
    description: 'Reactivate a paused ad. Gated: cooldown check.',
    input_schema: {
      type: 'object',
      properties: {
        ad_id: { type: 'string', description: 'The Meta ad ID to reactivate' },
        adset_id: { type: 'string', description: 'Parent ad set ID' },
        reason: { type: 'string', description: 'Why you are reactivating this ad' }
      },
      required: ['ad_id', 'adset_id', 'reason']
    }
  },
  {
    name: 'pause_adset',
    description: 'Pause an entire ad set. Use only when Zeus orders it (ALERT directive) OR when the ad set has been a clear loser for 14+ days (ROAS < 1.0x with $200+ spend). Frees up the ad set budget which Zeus will redistribute in its next cycle. Gated: requires account coverage (10+ other healthy ad sets with ROAS > 2x) to prevent killing the account.',
    input_schema: {
      type: 'object',
      properties: {
        adset_id: { type: 'string', description: 'The Meta ad set ID to pause entirely' },
        reason: { type: 'string', description: 'Why you are pausing this ad set. Must reference Zeus directive or sustained 14+ day data.' }
      },
      required: ['adset_id', 'reason']
    }
  },
  {
    name: 'save_observation',
    description: 'Create a BrainInsight observation for an entity.',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Entity ID' },
        entity_name: { type: 'string', description: 'Entity name' },
        entity_type: { type: 'string', enum: ['adset', 'ad'], default: 'adset' },
        type: { type: 'string', enum: ['anomaly', 'trend', 'opportunity', 'warning', 'milestone', 'status_change'], description: 'Insight type' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
        title: { type: 'string', description: 'Short title in Spanish' },
        description: { type: 'string', description: 'Detail in Spanish' }
      },
      required: ['entity_id', 'entity_name', 'type', 'severity', 'title', 'description']
    }
  },
  {
    name: 'save_assessment',
    description: 'Save your assessment to BrainMemory. ALWAYS call this before finishing. Include your plan for next review.',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Ad set ID' },
        entity_name: { type: 'string', description: 'Ad set name' },
        assessment: { type: 'string', description: 'Overall assessment in Spanish (max 3-4 sentences)' },
        frequency_status: { type: 'string', enum: ['ok', 'moderate', 'high', 'critical'] },
        creative_health: { type: 'string', description: 'Creative health analysis in Spanish' },
        needs_new_creatives: { type: 'boolean' },
        suggested_creative_styles: { type: 'array', items: { type: 'string' } },
        performance_trend: { type: 'string', enum: ['improving', 'stable', 'declining', 'learning'] },
        next_review_hours: { type: 'number', description: 'Hours until next review needed. 4=urgent, 12=normal, 48=stable. Default 12.' },
        pending_plan: { type: 'string', description: 'What to check/do next cycle. E.g. "If 3d ROAS still < 2.5x, scale down 20%. If new ad has > $15 spend with 0 purchases, pause it."' }
      },
      required: ['entity_id', 'entity_name', 'assessment', 'frequency_status', 'performance_trend']
    }
  },
  {
    name: 'log_reasoning',
    description: 'Log a reasoning trace to help with debugging (stored in ActionLog as no_action).',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Entity ID' },
        entity_name: { type: 'string', description: 'Entity name' },
        reasoning: { type: 'string', description: 'Your reasoning trace' }
      },
      required: ['entity_id', 'reasoning']
    }
  }
];

/**
 * Record an action in BrainMemory.action_history so the Brain learns per-entity.
 */
async function _recordActionInMemory(entityId, entityName, actionType, context) {
  try {
    await BrainMemory.findOneAndUpdate(
      { entity_id: entityId },
      {
        $set: { entity_name: entityName, entity_type: 'adset', last_updated_at: new Date() },
        $push: {
          action_history: {
            $each: [{
              action_type: actionType,
              executed_at: new Date(),
              result: 'pending', // will be updated by impact measurement
              roas_delta_pct: 0,
              cpa_delta_pct: 0,
              context: context || '',
              concurrent_actions: [],
              attribution: 'sole'
            }],
            $slice: -20 // keep last 20
          }
        }
      },
      { upsert: true }
    );
  } catch (err) {
    logger.warn(`[ACCOUNT-AGENT] Error recording action in BrainMemory: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

async function handleGetAdsetMetrics(input) {
  const { adset_id } = input;
  const allSnapshots = await getLatestSnapshots('adset');
  const snap = allSnapshots.find(s => s.entity_id === adset_id);
  if (!snap) return { error: 'No snapshot found for this ad set' };

  const mToday = snap.metrics?.today || {};
  const m3d = snap.metrics?.last_3d || {};
  const m7d = snap.metrics?.last_7d || {};
  const m14d = snap.metrics?.last_14d || {};

  // Helper: compact metrics for a window
  const compact = (m) => ({
    spend: m.spend || 0,
    roas: Math.round((m.roas || 0) * 100) / 100,
    purchases: m.purchases || 0,
    purchase_value: m.purchase_value || 0,
    impressions: m.impressions || 0,
    clicks: m.clicks || 0,
    ctr: m.ctr || 0,
    cpm: m.cpm || 0,
    frequency: m.frequency || 0,
    cpa: m.spend > 0 && m.purchases > 0 ? Math.round(m.spend / m.purchases * 100) / 100 : 0
  });

  // Trend analysis: compare windows to detect deterioration
  const roas7 = m7d.roas || 0;
  const roas3 = m3d.roas || 0;
  const roas14 = m14d.roas || 0;
  const freq7 = m7d.frequency || 0;
  const freq3 = m3d.frequency || 0;

  // Account context — SOLO adsets ABO (budget propio). Los adsets de un CBO
  // tienen daily_budget 0 (budget a nivel campaña) y NO son de Athena: los
  // gestiona Ares. Excluirlos evita que Athena intente escalar budget de adset
  // que no existe en un CBO (Meta lo rechaza) y ensucie su análisis (2026-05-29).
  const activeSnapshots = allSnapshots.filter(s => s.status === 'ACTIVE' && (s.daily_budget || 0) > 0);
  const totalBudget = activeSnapshots.reduce((sum, s) => sum + (s.daily_budget || 0), 0);
  const totalSpend7d = activeSnapshots.reduce((sum, s) => sum + (s.metrics?.last_7d?.spend || 0), 0);
  const totalPV7d = activeSnapshots.reduce((sum, s) => sum + (s.metrics?.last_7d?.purchase_value || 0), 0);

  return {
    adset_id,
    adset_name: snap.entity_name,
    status: snap.status,
    daily_budget: snap.daily_budget || 0,
    days_old: snap.meta_created_time ? Math.round((Date.now() - new Date(snap.meta_created_time).getTime()) / 86400000) : null,
    metrics_today: compact(mToday),
    metrics_3d: compact(m3d),
    metrics_7d: compact(m7d),
    metrics_14d: compact(m14d),
    trend: {
      roas_direction: roas3 > roas7 * 1.05 ? 'improving' : roas3 < roas7 * 0.95 ? 'declining' : 'stable',
      roas_3d_vs_7d_pct: roas7 > 0 ? Math.round((roas3 - roas7) / roas7 * 100) : 0,
      roas_7d_vs_14d_pct: roas14 > 0 ? Math.round((roas7 - roas14) / roas14 * 100) : 0,
      frequency_direction: freq3 > freq7 * 1.1 ? 'rising' : freq3 < freq7 * 0.9 ? 'falling' : 'stable',
      ctr_declining: (m3d.ctr || 0) < (m7d.ctr || 0) * 0.9,
      recent_deterioration: roas3 < roas7 * 0.8 && (m3d.spend || 0) > 10,
      summary: roas3 < roas7 * 0.8 ? 'ROAS dropping fast (3d vs 7d)'
        : freq3 > 3.5 ? 'Frequency critical'
        : roas3 > roas7 * 1.15 ? 'Performance improving'
        : 'Stable'
    },
    account_context: {
      active_adsets: activeSnapshots.length,
      total_daily_budget: Math.round(totalBudget * 100) / 100,
      account_roas_7d: totalSpend7d > 0 ? Math.round(totalPV7d / totalSpend7d * 100) / 100 : 0
    }
  };
}

async function handleGetAdPerformance(input) {
  const { adset_id } = input;
  const adSnapshots = await getAdsForAdSet(adset_id);

  return {
    adset_id,
    ads: adSnapshots.map(snap => {
      const m3 = snap.metrics?.last_3d || {};
      const m7 = snap.metrics?.last_7d || {};
      const m14 = snap.metrics?.last_14d || {};
      const m30 = snap.metrics?.last_30d || {};
      const freq7 = m7.frequency || 0;
      const freq3 = m3.frequency || 0;
      const daysOld = snap.meta_created_time ? Math.round((Date.now() - new Date(snap.meta_created_time).getTime()) / 86400000) : null;

      // Fatigue detection: compare windows to detect decay curve
      const roas7 = m7.roas || 0;
      const roas3 = m3.roas || 0;
      const roas14 = m14.roas || 0;
      const ctr7 = m7.ctr || 0;
      const ctr3 = m3.ctr || 0;
      const ctr14 = m14.ctr || 0;

      // Dying: 3d < 7d < 14d (consistent downtrend)
      const roasDying = roas14 > 0 && roas7 < roas14 * 0.85 && roas3 < roas7 * 0.85;
      const ctrDying = ctr14 > 0 && ctr7 < ctr14 * 0.85 && ctr3 < ctr7 * 0.85;
      // Ignored by Meta: very low spend relative to ad set
      const isIgnored = (m7.spend || 0) < 2 && daysOld != null && daysOld >= 5;

      let health = 'healthy';
      if (isIgnored) health = 'ignored_by_meta';
      else if (roasDying && ctrDying) health = 'dying';
      else if (roasDying || (freq7 > 3 && ctrDying)) health = 'fatigued';
      else if (freq7 > 4) health = 'saturated';

      return {
        ad_id: snap.entity_id,
        ad_name: snap.entity_name,
        status: snap.status || 'ACTIVE',
        days_old: daysOld,
        metrics_3d: { spend: m3.spend || 0, roas: Math.round((m3.roas || 0) * 100) / 100, ctr: m3.ctr || 0, frequency: freq3, purchases: m3.purchases || 0 },
        metrics_7d: { spend: m7.spend || 0, roas: Math.round(roas7 * 100) / 100, ctr: ctr7, frequency: freq7, purchases: m7.purchases || 0, impressions: m7.impressions || 0 },
        metrics_14d: { spend: m14.spend || 0, roas: Math.round(roas14 * 100) / 100, ctr: ctr14, frequency: m14.frequency || 0, purchases: m14.purchases || 0 },
        health,
        health_detail: health === 'ignored_by_meta' ? `Only $${(m7.spend || 0).toFixed(2)} spend in ${daysOld}d — Meta not exploring this ad`
          : health === 'dying' ? `ROAS declining: 14d ${roas14.toFixed(2)}x → 7d ${roas7.toFixed(2)}x → 3d ${roas3.toFixed(2)}x. CTR also falling. Kill candidate.`
          : health === 'fatigued' ? `Performance dropping: ROAS 7d ${roas7.toFixed(2)}x vs 14d ${roas14.toFixed(2)}x. Frequency ${freq7.toFixed(1)}. Watch closely.`
          : health === 'saturated' ? `Frequency ${freq7.toFixed(1)} — audience exhausted`
          : 'Performance stable or improving'
      };
    })
  };
}

async function handleGetScalingHistory(input) {
  const { entity_id } = input;
  const now = Date.now();

  // Fix 2026-04-22 (rec Zeus): antes filtraba solo impact_measured, ignoraba
  // impact_7d_measured. Ahora acepta cualquiera. Para cada action, prefiere
  // metrics_after_7d cuando existe (estable post re-learning de Meta), fallback
  // a metrics_after_3d. Pattern espejo de impact-context-builder.js:95-112.
  const pastActions = await ActionLog.find({
    entity_id,
    success: true,
    $or: [
      { impact_measured: true },
      { impact_7d_measured: true }
    ]
  }).sort({ executed_at: -1 }).limit(15).lean();

  return {
    entity_id,
    total_measured: pastActions.length,
    actions: pastActions.map(a => {
      // Prefer 7d (estable), fallback 3d, fallback 1d — pattern de impact-context-builder
      const after = (a.impact_7d_measured && a.metrics_after_7d?.roas_7d > 0)
        ? a.metrics_after_7d
        : (a.metrics_after_3d || a.metrics_after_1d || {});
      const checkpoint = (a.impact_7d_measured && a.metrics_after_7d?.roas_7d > 0) ? '7d' : '3d';

      const before = a.metrics_at_execution || {};
      const roasBefore = before.roas_7d || 0;
      const roasAfter = after.roas_7d || 0;
      const cpaBefore = before.cpa_7d || 0;
      const cpaAfter = after.cpa_7d || 0;

      const deltaRoas = roasBefore > 0
        ? Math.round((roasAfter - roasBefore) / Math.max(roasBefore, 0.01) * 10000) / 100
        : null;
      const deltaCpa = cpaBefore > 0
        ? Math.round((cpaAfter - cpaBefore) / Math.max(cpaBefore, 0.01) * 10000) / 100
        : null;
      const result = deltaRoas != null ? (deltaRoas > 5 ? 'improved' : deltaRoas < -5 ? 'worsened' : 'neutral') : 'unknown';

      return {
        action: a.action,
        agent_type: a.agent_type,
        days_ago: Math.round((now - new Date(a.executed_at).getTime()) / 86400000),
        before_value: a.before_value,
        after_value: a.after_value,
        result,
        delta_roas_pct: deltaRoas,
        delta_cpa_pct: deltaCpa,
        checkpoint,                              // '7d' (preferido) o '3d' (fallback)
        reasoning: (a.reasoning || '').substring(0, 200)
      };
    })
  };
}

async function handleGetBanditSignal(input) {
  const { action, adset_id } = input;

  const learner = new PolicyLearner();
  const state = await learner.loadState();

  const allSnapshots = await getLatestSnapshots('adset');
  const snap = allSnapshots.find(s => s.entity_id === adset_id);
  if (!snap) return { error: 'No snapshot found', action, mean: 0.5, bias: 0, confidence: 0 };

  const m7d = snap.metrics?.last_7d || {};
  const metrics = {
    roas_7d: m7d.roas || 0,
    cpa_7d: m7d.spend > 0 && m7d.purchases > 0 ? m7d.spend / m7d.purchases : 0,
    frequency: m7d.frequency || 0,
    spend_7d: m7d.spend || 0,
    purchases_7d: m7d.purchases || 0
  };

  const bucket = learner.bucketFromMetrics(metrics);
  const signal = learner.getActionBias(state, bucket, action);

  return {
    action,
    bucket,
    mean: Math.round(signal.mean * 1000) / 1000,
    bias: Math.round(signal.bias * 1000) / 1000,
    confidence: Math.round(signal.confidence * 1000) / 1000,
    interpretation: signal.mean > 0.6 ? 'historically_successful' :
      signal.mean < 0.4 ? 'historically_poor' : 'neutral',
    total_samples: state.total_samples || 0
  };
}

async function handleGetEntityMemory(input) {
  const { entity_id } = input;
  const memory = await BrainMemory.findOne({ entity_id }).lean();
  if (!memory) return { entity_id, found: false };

  return {
    entity_id,
    found: true,
    entity_name: memory.entity_name,
    last_status: memory.last_status,
    last_daily_budget: memory.last_daily_budget,
    remembered_metrics: memory.remembered_metrics,
    trends: memory.trends,
    action_history: (memory.action_history || []).slice(-10).map(a => ({
      action_type: a.action_type,
      executed_at: a.executed_at,
      result: a.result,
      roas_delta_pct: a.roas_delta_pct,
      cpa_delta_pct: a.cpa_delta_pct,
      context: a.context
    })),
    agent_assessment: memory.agent_assessment || null,
    agent_performance_trend: memory.agent_performance_trend || null,
    agent_last_check: memory.agent_last_check || null,
    last_updated_at: memory.last_updated_at
  };
}

async function handleGetRecentInsights(input) {
  const { entity_id } = input;
  const insights = await BrainInsight.find({
    'entities.entity_id': entity_id
  }).sort({ created_at: -1 }).limit(5).lean();

  return {
    entity_id,
    count: insights.length,
    insights: insights.map(i => ({
      type: i.insight_type,
      severity: i.severity,
      title: i.title,
      description: (i.body || '').substring(0, 300),
      created_at: i.created_at
    }))
  };
}

async function handleScaleBudget(input, ctx) {
  const { adset_id, new_budget, reason } = input;
  const meta = getMetaClient();
  const guardRail = new GuardRail();
  const cooldownMgr = new CooldownManager();
  const minBudget = safetyGuards.min_adset_budget || 10;

  // Get current budget from snapshot
  const allSnapshots = await getLatestSnapshots('adset');
  const snap = allSnapshots.find(s => s.entity_id === adset_id);
  if (!snap) return { blocked: true, reason: 'No snapshot found for this ad set' };

  const prevBudget = snap.daily_budget || 0;

  // GUARD CBO: un adset con daily_budget 0 pertenece a un CBO (budget a nivel
  // campaña). Athena NO escala adsets de CBO — eso es de Ares, y Meta rechaza
  // setear budget de adset en CBO. Bloquear con mensaje claro (2026-05-29).
  if (prevBudget <= 0) {
    return { blocked: true, reason: 'Adset de CBO (budget a nivel campaña) — lo gestiona Ares, no Athena.' };
  }

  const isScaleUp = new_budget > prevBudget;
  const actionType = isScaleUp ? 'scale_up' : 'scale_down';

  // ── GATE: Directiva granular de Zeus para esta acción específica.
  // isAgentBlocked al inicio del ciclo solo bloquea directivas genéricas; las
  // que tienen action_scope se manejan acá por handler individual.
  try {
    const { isActionBlockedForAgent } = require('../zeus/directive-guard');
    const block = await isActionBlockedForAgent('athena', actionType);
    if (block.blocked) {
      return { blocked: true, reason: `Directiva activa de Zeus bloquea ${actionType}: "${block.reason}"`, directive_id: block.directive_id };
    }
  } catch (_) { /* fail-open si guard falla */ }

  // ── GATE: Warehouse throttle — bloquea scale_up cuando logística no da.
  // 2026-04-27: si throttle activo y queremos subir budget, blocked.
  if (isScaleUp) {
    try {
      const { isScaleUpBlocked } = require('../../safety/warehouse-throttle');
      if (await isScaleUpBlocked()) {
        return { blocked: true, reason: 'Warehouse throttle activo: scale_up bloqueado mientras logística alcanza capacidad.' };
      }
    } catch (_) { /* fail-open si throttle module falla */ }
  }

  // ── GATE: Learning phase (ad set < 5 days old)
  if (snap.meta_created_time) {
    const daysOld = (Date.now() - new Date(snap.meta_created_time).getTime()) / 86400000;
    if (daysOld < 5) {
      return { blocked: true, reason: `Learning phase: ad set is ${daysOld.toFixed(1)} days old (min 5d). Cannot change budget.` };
    }
  }

  // ── GATE: Budget floor
  if (new_budget < minBudget) {
    return { blocked: true, reason: `Budget cannot go below $${minBudget}. Requested: $${new_budget}.` };
  }

  // ── GATE: Cooldown (unified_agent only — bypassed if Zeus PRIORITIZE active)
  const cooldown = await _isOnAgentCooldown(adset_id);
  if (cooldown.onCooldown && !ctx.hasZeusScaleDirective) {
    return { blocked: true, reason: `Cooldown: ${cooldown.minutesLeft} minutes remaining (last: ${cooldown.lastAction}).` };
  }
  if (cooldown.onCooldown && ctx.hasZeusScaleDirective) {
    logger.info(`[ACCOUNT-AGENT] scale_budget: cooldown bypassed for ${adset_id} — Zeus PRIORITIZE directive`);
  }

  // ── GATE: scale-gate de Athena (2026-05-26) — freno marginal + step adaptativo
  // al win-rate. Solo scale_up; sesga conservador (la causa del scale_up 32% es
  // escalar adsets que revierten). Fail-open.
  let athenaScaleStep = null;
  if (isScaleUp) {
    try {
      const { checkAdsetScaleSanity, getAdaptiveScaleStep } = require('./athena-scale-gate');
      const sanity = checkAdsetScaleSanity(snap);
      if (!sanity.allow) {
        return { blocked: true, reason: sanity.reason };
      }
      athenaScaleStep = await getAdaptiveScaleStep();
    } catch (e) {
      logger.warn(`[ACCOUNT-AGENT] athena scale-gate falló (fail-open): ${e.message}`);
    }
  }

  // ── GATE: ROAS MARGINAL — la frontera eficiente. Si el dólar del último scale rindió
  // marginal < mínimo, el adset llegó a su techo → no escalar más aunque el 7d mezclado
  // se vea bien. SHADOW por default (ATHENA_MARGINAL_GATE_LIVE): el R1 reciente sub-atribuye
  // en el pixel nuevo → en cold-start daría falsos negativos (misma lección que el verdict).
  // El marginal SÍ va al contexto del LLM (que lo razona); el gate DURO espera a madurar.
  if (isScaleUp) {
    try {
      let haircut = 1;
      try { const { getAccountCashSignal } = require('./demeter-cash-signal'); const cs = await getAccountCashSignal(); if (cs.available) haircut = cs.haircut_factor; } catch (_) {}
      const { getMarginalSignal } = require('./athena-marginal');
      const sig = await getMarginalSignal(snap, haircut);
      if (sig.gate) {
        if (process.env.ATHENA_MARGINAL_GATE_LIVE === 'true') {
          return { blocked: true, reason: sig.gate };
        }
        logger.info(`[ACCOUNT-AGENT] 🌗 marginal-gate SHADOW (no bloquea) ${snap.entity_name || adset_id}: ${sig.gate}`);
      }
    } catch (e) {
      logger.warn(`[ACCOUNT-AGENT] marginal-gate falló (fail-open): ${e.message}`);
    }
  }

  // ── GATE: cash-gate de Demeter EN VIVO (promovido de shadow 2026-06-05, tras
  // evaluar ~21d de shadow: ~12% de desacuerdo con Meta; cazó scale_ups de adsets a
  // ~0x ROAS). Para scale_up bloquea si el cash de cuenta dice "hold":
  //   (a) GOVERNOR — cash_roas_14d de cuenta < 2.0x → no escalar NADA (red de seguridad
  //       para cuando el cash real de la cuenta cae, aunque Meta se vea bien), o
  //   (b) el cash-adjusted ROAS del adset (meta_roas_7d × haircut) no llega al piso 2.5x.
  // Fail-open: sin señal de Demeter, deja pasar (no bloquea por falta de data).
  if (isScaleUp) {
    try {
      const { getAccountCashSignal, buildCashShadow } = require('./demeter-cash-signal');
      const signal = await getAccountCashSignal();
      const gate = buildCashShadow(signal, snap.metrics?.last_7d?.roas || 0, 'scale_up');
      if (gate.available && gate.cash_gate === 'hold') {
        return { blocked: true, reason: `Cash-gate: ${gate.note}` };
      }
    } catch (e) {
      logger.warn(`[ACCOUNT-AGENT] cash-gate vivo falló (fail-open): ${e.message}`);
    }
  }

  // ── GATE: Max 30% increase (modo agresivo 2026-06-07 — permite el step +30% de
  // ganadores probados; antes 25%). La seguridad la da el cash-gate, no este cap.
  if (isScaleUp && prevBudget > 0) {
    const changePct = ((new_budget - prevBudget) / prevBudget) * 100;
    if (changePct > 30) {
      return { blocked: true, reason: `Budget increase of ${changePct.toFixed(0)}% exceeds 30% max. Max: $${Math.round(prevBudget * 1.30)}.` };
    }
  }

  // ── GATE: GuardRail validation (ceiling, daily change limit)
  const validation = await guardRail.validate({
    action: isScaleUp ? 'scale_up' : 'scale_down',
    entity_id: adset_id,
    entity_name: snap.entity_name || adset_id,
    entity_type: 'adset',
    current_value: prevBudget,
    new_value: new_budget
  });

  if (!validation.approved) {
    return { blocked: true, reason: validation.reason };
  }

  let finalBudget = validation.modified ? validation.adjustedValue : new_budget;

  // Step cap adaptativo: si el win-rate de scale_up de Athena viene bajo, achicar
  // el paso máximo (graduado). mal track → pasos chicos hasta recuperar.
  if (isScaleUp && athenaScaleStep && prevBudget > 0) {
    const maxBudget = Math.round(prevBudget * (1 + athenaScaleStep.maxStepPct));
    if (finalBudget > maxBudget) {
      logger.info(`[ACCOUNT-AGENT] scale capado por win-rate: $${finalBudget}→$${maxBudget} (${athenaScaleStep.reason})`);
      finalBudget = maxBudget;
    }
  }

  // Execute
  await meta.updateBudget(adset_id, finalBudget);

  // Build metrics snapshot
  const m7d = snap.metrics?.last_7d || {};
  const metricsAtExecution = {
    roas_7d: Math.round((m7d.roas || 0) * 100) / 100,
    roas_3d: Math.round((snap.metrics?.last_3d?.roas || 0) * 100) / 100,
    cpa_7d: m7d.spend > 0 && m7d.purchases > 0 ? Math.round(m7d.spend / m7d.purchases * 100) / 100 : 0,
    spend_today: snap.metrics?.today?.spend || 0,
    spend_7d: m7d.spend || 0,
    daily_budget: prevBudget,
    purchases_7d: m7d.purchases || 0,
    purchase_value_7d: m7d.purchase_value || 0,
    frequency: m7d.frequency || 0,
    ctr: m7d.ctr || 0
  };

  // ── SHADOW/registro: cash-gate de Demeter. scale_up ya es GATE VIVO (arriba) — esto
  // queda como registro en el ActionLog + sigue en shadow para scale_down (que no se
  // gatea en vivo todavía). Fail-open: si Demeter falla, no afecta nada.
  let cashShadow = null;
  try {
    const { getAccountCashSignal, buildCashShadow } = require('./demeter-cash-signal');
    const signal = await getAccountCashSignal();
    cashShadow = buildCashShadow(signal, metricsAtExecution.roas_7d, isScaleUp ? 'scale_up' : 'scale_down');
  } catch (e) {
    logger.warn(`[ACCOUNT-AGENT] cash shadow falló (no crítico): ${e.message}`);
  }

  const actionLog = await ActionLog.create({
    entity_type: 'adset',
    entity_id: adset_id,
    entity_name: snap.entity_name || adset_id,
    action: isScaleUp ? 'scale_up' : 'scale_down',
    before_value: prevBudget,
    after_value: finalBudget,
    change_percent: prevBudget > 0 ? Math.round((finalBudget - prevBudget) / prevBudget * 100) : 0,
    reasoning: reason,
    confidence: 'high',
    agent_type: 'unified_agent',
    success: true,
    executed_at: new Date(),
    metrics_at_execution: metricsAtExecution,
    metadata: {
      ...(cashShadow ? { shadow_cash_consideration: cashShadow } : {}),
      ...(athenaScaleStep ? { athena_scale_step: athenaScaleStep } : {})
    }
  });

  // Marcar directivas matching de Zeus como executed
  await _markZeusDirectivesExecuted(adset_id, isScaleUp ? 'scale_up' : 'scale_down', actionLog._id, `${prevBudget} → ${finalBudget}`);

  ctx.actionsExecuted++;
  if (ctx.actionTypes) ctx.actionTypes.push(isScaleUp ? 'scale_up' : 'scale_down');
  await _recordActionInMemory(adset_id, snap.entity_name, isScaleUp ? 'scale_up' : 'scale_down', reason.substring(0, 100));
  logger.info(`[ACCOUNT-AGENT] ${adset_id}: Budget $${prevBudget} → $${finalBudget} — ${reason}`);

  return {
    success: true,
    previous_budget: prevBudget,
    new_budget: finalBudget,
    change_pct: Math.round((finalBudget - prevBudget) / prevBudget * 100),
    modified_by_guardrail: validation.modified || false
  };
}

async function handleMoveBudget(input, ctx) {
  const { source_adset_id, target_adset_id, amount, reason } = input;
  if (!source_adset_id || !target_adset_id || source_adset_id === target_adset_id) {
    return { blocked: true, reason: 'source y target deben ser ad sets distintos' };
  }
  if (typeof amount !== 'number' || amount <= 0) return { blocked: true, reason: 'amount debe ser > 0' };

  const meta = getMetaClient();
  const minBudget = safetyGuards.min_adset_budget || 10;
  const allSnapshots = await getLatestSnapshots('adset');
  const src = allSnapshots.find(s => s.entity_id === source_adset_id);
  const tgt = allSnapshots.find(s => s.entity_id === target_adset_id);
  if (!src) return { blocked: true, reason: 'source ad set no encontrado' };
  if (!tgt) return { blocked: true, reason: 'target ad set no encontrado' };

  const srcBudget = src.daily_budget || 0;
  const tgtBudget = tgt.daily_budget || 0;
  if (srcBudget <= 0 || tgtBudget <= 0) return { blocked: true, reason: 'algún ad set sin daily_budget (¿CBO/ABO?)' };

  // ── GATE: directiva Zeus (toca budget en ambos lados)
  try {
    const { isActionBlockedForAgent } = require('../zeus/directive-guard');
    const block = await isActionBlockedForAgent('athena', 'move_budget');
    if (block.blocked) return { blocked: true, reason: `Directiva de Zeus bloquea move_budget: "${block.reason}"`, directive_id: block.directive_id };
  } catch (_) { /* fail-open */ }

  // ── GATE: cadencia — no alimentar un target que recién se tocó (tiempo de respuesta)
  try {
    const cd = await _isOnAgentCooldown(target_adset_id);
    if (cd.onCooldown) return { blocked: true, reason: `target en cooldown (${cd.minutesLeft}min, last: ${cd.lastAction}) — dale tiempo de medir su último cambio antes de sumarle más budget` };
  } catch (_) { /* fail-open */ }

  // ── GATE: source queda por encima del floor
  if (srcBudget - amount < minBudget) {
    return { blocked: true, reason: `mover $${amount} dejaría al source bajo el floor $${minBudget} (tiene $${srcBudget}). Reducí el amount.` };
  }

  // ── GATE: solo de PEOR a MEJOR (sanity del move)
  const srcRoas = src.metrics?.last_7d?.roas || 0;
  const tgtRoas = tgt.metrics?.last_7d?.roas || 0;
  if (srcRoas >= tgtRoas) {
    return { blocked: true, reason: `move sin sentido: source ROAS 7d ${srcRoas.toFixed(2)}x ≥ target ${tgtRoas.toFixed(2)}x. Solo se mueve de peor a mejor.` };
  }

  // ── GATE: target no en declive (mismo freno marginal que el scale)
  try {
    const { checkAdsetScaleSanity } = require('./athena-scale-gate');
    const sanity = checkAdsetScaleSanity(tgt);
    if (!sanity.allow) return { blocked: true, reason: `no alimentar un target en declive: ${sanity.reason}` };
  } catch (_) { /* fail-open */ }

  // ── GATE: el aumento del target no debe resetear el learning de Meta (>20%). Clamp.
  let moveAmount = amount;
  const maxTargetAdd = Math.round(tgtBudget * 0.20);
  if (moveAmount > maxTargetAdd) {
    logger.info(`[ACCOUNT-AGENT] move_budget capado: $${amount}→$${maxTargetAdd} (evita reset de learning del target >20%)`);
    moveAmount = maxTargetAdd;
  }
  if (moveAmount < 1) return { blocked: true, reason: 'amount efectivo < $1 tras el clamp del target' };

  const newSrc = Math.round(srcBudget - moveAmount);
  const newTgt = Math.round(tgtBudget + moveAmount);

  // Execute — cortar el source primero, después alimentar el target
  await meta.updateBudget(source_adset_id, newSrc);
  await meta.updateBudget(target_adset_id, newTgt);

  await ActionLog.create({
    entity_type: 'adset',
    entity_id: source_adset_id,
    entity_name: src.entity_name || source_adset_id,
    action: 'move_budget',
    before_value: srcBudget,
    after_value: newSrc,
    change_percent: srcBudget > 0 ? Math.round((newSrc - srcBudget) / srcBudget * 100) : 0,
    reasoning: reason,
    confidence: 'high',
    agent_type: 'unified_agent',
    success: true,
    executed_at: new Date(),
    target_entity_id: target_adset_id,
    target_entity_name: tgt.entity_name || target_adset_id,
    redistributable_budget: moveAmount,
    metrics_at_execution: { roas_7d: Math.round(srcRoas * 100) / 100, daily_budget: srcBudget },
    target_metrics_at_execution: { roas_7d: Math.round(tgtRoas * 100) / 100, daily_budget: tgtBudget },
    metadata: { move: { from: source_adset_id, to: target_adset_id, amount: moveAmount, src_roas_7d: +srcRoas.toFixed(2), tgt_roas_7d: +tgtRoas.toFixed(2) } }
  });

  ctx.actionsExecuted++;
  if (ctx.actionTypes) ctx.actionTypes.push('move_budget');
  logger.info(`[ACCOUNT-AGENT] move_budget: $${moveAmount} de "${src.entity_name || source_adset_id}" (${srcRoas.toFixed(2)}x) → "${tgt.entity_name || target_adset_id}" (${tgtRoas.toFixed(2)}x)`);

  return {
    success: true,
    moved: moveAmount,
    source: { id: source_adset_id, before: srcBudget, after: newSrc },
    target: { id: target_adset_id, before: tgtBudget, after: newTgt }
  };
}

async function handlePauseAd(input, ctx) {
  const { ad_id, adset_id, reason } = input;
  const meta = getMetaClient();

  // ── GATE: Directiva granular de Zeus para 'pause'.
  try {
    const { isActionBlockedForAgent } = require('../zeus/directive-guard');
    const block = await isActionBlockedForAgent('athena', 'pause');
    if (block.blocked) {
      return { blocked: true, reason: `Directiva activa de Zeus bloquea pause: "${block.reason}"`, directive_id: block.directive_id };
    }
  } catch (_) { /* fail-open si guard falla */ }

  // ── GATE: Prevent pausing ad set itself (ad_id must not be an ad set)
  const allAdSetSnaps = await getLatestSnapshots('adset');
  if (allAdSetSnaps.some(s => s.entity_id === ad_id)) {
    return { blocked: true, reason: `BLOCKED: ${ad_id} is an AD SET, not an ad. Never pause ad sets — only individual ads.` };
  }

  // ── GATE: Learning phase (ad set < 5 days old)
  const parentSnap = allAdSetSnaps.find(s => s.entity_id === adset_id);
  if (parentSnap?.meta_created_time) {
    const daysOld = (Date.now() - new Date(parentSnap.meta_created_time).getTime()) / 86400000;
    if (daysOld < 5) {
      return { blocked: true, reason: `Learning phase: ad set is ${daysOld.toFixed(1)} days old (min 5d). Cannot pause ads.` };
    }
  }

  // ── GATE: Don't pause the last active ad in an ad set
  // Track pauses within this cycle to catch same-cycle double pauses
  if (!ctx._pausedAdsThisCycle) ctx._pausedAdsThisCycle = new Set();
  const adsInSet = await getAdsForAdSet(adset_id);

  // ── GATE: Don't pause new ads with insufficient data (<$15 spend AND <7 days old)
  const adToCheck = adsInSet.find(a => a.entity_id === ad_id);
  if (adToCheck) {
    const adSpend = adToCheck.metrics?.last_7d?.spend || 0;
    const adDaysOld = adToCheck.meta_created_time ? (Date.now() - new Date(adToCheck.meta_created_time).getTime()) / 86400000 : 999;
    if (adSpend < 30 && adDaysOld < 7) {
      return { blocked: true, reason: `BLOCKED: Ad has only $${adSpend.toFixed(2)} spend in ${adDaysOld.toFixed(0)} days. Need $30+ spend to evaluate. Let it run.` };
    }
  }
  const activeAds = adsInSet.filter(a => a.status === 'ACTIVE' && !ctx._pausedAdsThisCycle.has(a.entity_id));
  if (activeAds.length <= 1 && activeAds.some(a => a.entity_id === ad_id)) {
    return { blocked: true, reason: `BLOCKED: Cannot pause the last active ad in this ad set. It would effectively kill the ad set. Keep at least 1 ad running.` };
  }

  // ── GATE: Cooldown (unified_agent only)
  const cooldown = await _isOnAgentCooldown(ad_id);
  if (cooldown.onCooldown) {
    return { blocked: true, reason: `Cooldown: ${cooldown.minutesLeft} minutes remaining.` };
  }

  // Execute
  await meta.updateAdStatus(ad_id, 'PAUSED');

  // Metrics for impact tracking
  const snap = parentSnap || (await getLatestSnapshots('adset')).find(s => s.entity_id === adset_id);
  const m7d = snap?.metrics?.last_7d || {};
  const metricsAtExecution = {
    roas_7d: Math.round((m7d.roas || 0) * 100) / 100,
    cpa_7d: m7d.spend > 0 && m7d.purchases > 0 ? Math.round(m7d.spend / m7d.purchases * 100) / 100 : 0,
    spend_7d: m7d.spend || 0,
    daily_budget: snap?.daily_budget || 0,
    purchases_7d: m7d.purchases || 0,
    frequency: m7d.frequency || 0,
    ctr: m7d.ctr || 0
  };

  const adSnaps = await getAdsForAdSet(adset_id);
  const adSnap = adSnaps.find(a => a.entity_id === ad_id);

  const pauseAdLog = await ActionLog.create({
    entity_type: 'ad',
    entity_id: ad_id,
    entity_name: adSnap?.entity_name || ad_id,
    parent_adset_id: adset_id,
    action: 'pause',
    before_value: 'ACTIVE',
    after_value: 'PAUSED',
    reasoning: reason,
    confidence: 'high',
    agent_type: 'unified_agent',
    success: true,
    executed_at: new Date(),
    metrics_at_execution: metricsAtExecution,
    parent_metrics_at_execution: metricsAtExecution
  });

  // Marcar directivas matching de Zeus (pause aplica al parent adset)
  await _markZeusDirectivesExecuted(adset_id, 'pause', pauseAdLog._id, `ad ${ad_id} paused`);

  ctx.actionsExecuted++;
  if (ctx.actionTypes) ctx.actionTypes.push('pause');
  if (!ctx._pausedAdsThisCycle) ctx._pausedAdsThisCycle = new Set();
  ctx._pausedAdsThisCycle.add(ad_id);
  await _recordActionInMemory(adset_id, adSnap?.entity_name || adset_id, 'pause', `ad:${ad_id} ${reason.substring(0, 80)}`);
  logger.info(`[ACCOUNT-AGENT] ${adset_id}: Paused ad ${ad_id} — ${reason}`);

  return { success: true, ad_id, status: 'PAUSED' };
}

async function handleReactivateAd(input, ctx) {
  const { ad_id, adset_id, reason } = input;
  const meta = getMetaClient();

  // ── GATE: Directiva granular de Zeus para 'reactivate'.
  try {
    const { isActionBlockedForAgent } = require('../zeus/directive-guard');
    const block = await isActionBlockedForAgent('athena', 'reactivate');
    if (block.blocked) {
      return { blocked: true, reason: `Directiva activa de Zeus bloquea reactivate: "${block.reason}"`, directive_id: block.directive_id };
    }
  } catch (_) { /* fail-open si guard falla */ }

  // ── GATE: Learning phase (ad set < 5 days old)
  const adsetSnap = (await getLatestSnapshots('adset')).find(s => s.entity_id === adset_id);
  if (adsetSnap?.meta_created_time) {
    const daysOld = (Date.now() - new Date(adsetSnap.meta_created_time).getTime()) / 86400000;
    if (daysOld < 5) {
      return { blocked: true, reason: `Learning phase: ad set is ${daysOld.toFixed(1)} days old (min 5d). Cannot reactivate ads.` };
    }
  }

  // ── GATE: Cooldown (unified_agent only)
  const cooldown = await _isOnAgentCooldown(ad_id);
  if (cooldown.onCooldown) {
    return { blocked: true, reason: `Cooldown: ${cooldown.minutesLeft} minutes remaining.` };
  }

  await meta.updateAdStatus(ad_id, 'ACTIVE');

  const snap = (await getLatestSnapshots('adset')).find(s => s.entity_id === adset_id);
  const m7d = snap?.metrics?.last_7d || {};
  const metricsAtExecution = {
    roas_7d: Math.round((m7d.roas || 0) * 100) / 100,
    cpa_7d: m7d.spend > 0 && m7d.purchases > 0 ? Math.round(m7d.spend / m7d.purchases * 100) / 100 : 0,
    spend_7d: m7d.spend || 0,
    daily_budget: snap?.daily_budget || 0,
    purchases_7d: m7d.purchases || 0,
    frequency: m7d.frequency || 0,
    ctr: m7d.ctr || 0
  };

  await ActionLog.create({
    entity_type: 'ad',
    entity_id: ad_id,
    entity_name: ad_id,
    parent_adset_id: adset_id,
    action: 'reactivate',
    before_value: 'PAUSED',
    after_value: 'ACTIVE',
    reasoning: reason,
    confidence: 'high',
    agent_type: 'unified_agent',
    success: true,
    executed_at: new Date(),
    metrics_at_execution: metricsAtExecution
  });

  ctx.actionsExecuted++;
  if (ctx.actionTypes) ctx.actionTypes.push('reactivate');
  await _recordActionInMemory(adset_id, adset_id, 'reactivate', `ad:${ad_id} ${reason.substring(0, 80)}`);
  logger.info(`[ACCOUNT-AGENT] ${adset_id}: Reactivated ad ${ad_id} — ${reason}`);

  return { success: true, ad_id, status: 'ACTIVE' };
}

async function handlePauseAdSet(input, ctx) {
  const { adset_id, reason } = input;
  const meta = getMetaClient();

  // ── GATE: Directiva granular de Zeus para 'pause_adset'.
  try {
    const { isActionBlockedForAgent } = require('../zeus/directive-guard');
    const block = await isActionBlockedForAgent('athena', 'pause_adset');
    if (block.blocked) {
      return { blocked: true, reason: `Directiva activa de Zeus bloquea pause_adset: "${block.reason}"`, directive_id: block.directive_id };
    }
  } catch (_) { /* fail-open si guard falla */ }

  // Get current snapshot
  const allSnapshots = await getLatestSnapshots('adset');
  const snap = allSnapshots.find(s => s.entity_id === adset_id);
  if (!snap) return { blocked: true, reason: 'No snapshot found for this ad set' };

  const prevBudget = snap.daily_budget || 0;
  const adSetName = snap.entity_name || adset_id;

  // ── GATE: Coverage — cuenta debe tener 10+ ad sets sanos con ROAS > 2x
  const healthyAdSets = allSnapshots.filter(s =>
    s.status === 'ACTIVE'
    && s.entity_id !== adset_id
    && !['[TEST]', 'AI -', 'AMAZON', '[Ares]', '[HERMES]', '[Hermes]'].some(ex => (s.entity_name || '').toUpperCase().includes(ex.toUpperCase()))
    && (s.metrics?.last_7d?.roas || 0) >= 2.0
  );
  if (healthyAdSets.length < 10) {
    return { blocked: true, reason: `Coverage insufficient: only ${healthyAdSets.length} healthy ad sets (need 10+). Not safe to pause — account needs every ad set running.` };
  }

  // ── GATE: Cooldown (bypassed si Zeus tiene directiva PAUSE/ALERT para este ad set)
  const cooldown = await _isOnAgentCooldown(adset_id);
  if (cooldown.onCooldown && !ctx.hasZeusScaleDirective) {
    return { blocked: true, reason: `Cooldown: ${cooldown.minutesLeft} minutes remaining.` };
  }

  // ── GATE: Budget mínimo antes de pausar — prevenir pausa accidental de ad sets grandes
  // (scale_down agresivo es mejor si es muy grande)
  if (prevBudget >= 200) {
    return { blocked: true, reason: `Budget too large to pause outright ($${prevBudget}/day). Use scale_down to -50% first, then pause next cycle if still underperforming.` };
  }

  // Metricas al momento de pausar
  const m7d = snap.metrics?.last_7d || {};
  const metricsAtExecution = {
    roas_7d: Math.round((m7d.roas || 0) * 100) / 100,
    cpa_7d: m7d.spend > 0 && m7d.purchases > 0 ? Math.round(m7d.spend / m7d.purchases * 100) / 100 : 0,
    spend_7d: m7d.spend || 0,
    daily_budget: prevBudget,
    purchases_7d: m7d.purchases || 0,
    frequency: m7d.frequency || 0,
    ctr: m7d.ctr || 0
  };

  // Ejecutar pause
  try {
    await meta.updateStatus(adset_id, 'PAUSED');
  } catch (err) {
    return { blocked: true, reason: `Meta API error: ${err.message}` };
  }

  // Registrar en ActionLog con flag de redistribucion pendiente
  const pauseAdsetLog = await ActionLog.create({
    entity_type: 'adset',
    entity_id: adset_id,
    entity_name: adSetName,
    action: 'pause_adset',
    before_value: prevBudget,
    after_value: 0,
    reasoning: reason,
    confidence: 'high',
    agent_type: 'unified_agent',
    success: true,
    executed_at: new Date(),
    metrics_at_execution: metricsAtExecution,
    // Campo que Zeus va a leer para redistribuir
    redistributable_budget: prevBudget,
    redistribution_pending: true
  });

  // Marcar directivas matching de Zeus como executed
  await _markZeusDirectivesExecuted(adset_id, 'pause_adset', pauseAdsetLog._id, `paused, $${prevBudget} freed`);

  ctx.actionsExecuted++;
  if (ctx.actionTypes) ctx.actionTypes.push('pause_adset');
  await _recordActionInMemory(adset_id, adSetName, 'pause_adset', reason.substring(0, 100));
  logger.info(`[ACCOUNT-AGENT] ${adset_id} (${adSetName}): Ad set pausado — liberado $${prevBudget}/dia — ${reason}`);

  return {
    success: true,
    adset_id,
    adset_name: adSetName,
    status: 'PAUSED',
    budget_freed: prevBudget,
    note: `$${prevBudget}/dia liberado. Zeus redistribuira en su proximo ciclo.`
  };
}

async function handleSaveObservation(input) {
  await BrainInsight.create({
    insight_type: input.type,
    severity: input.severity || 'medium',
    entities: [{
      entity_type: input.entity_type || 'adset',
      entity_id: input.entity_id,
      entity_name: input.entity_name
    }],
    title: input.title,
    body: input.description || input.title,
    generated_by: 'brain'
  });

  return { saved: true };
}

async function handleSaveAssessment(input, ctx) {
  const { entity_id, entity_name } = input;

  const nextReviewHours = input.next_review_hours || 12;
  const nextReviewAt = new Date(Date.now() + nextReviewHours * 3600000);

  await BrainMemory.findOneAndUpdate(
    { entity_id },
    {
      $set: {
        entity_name: entity_name || entity_id,
        entity_type: 'adset',
        agent_assessment: input.assessment || '',
        agent_frequency_status: input.frequency_status || 'unknown',
        agent_creative_health: input.creative_health || '',
        agent_needs_new_creatives: input.needs_new_creatives || false,
        agent_performance_trend: input.performance_trend || 'unknown',
        agent_last_check: new Date(),
        agent_next_review_at: nextReviewAt,
        agent_pending_plan: input.pending_plan || '',
        last_updated_at: new Date()
      }
    },
    { upsert: true, new: true }
  );

  ctx.assessmentsSaved++;
  logger.info(`[ACCOUNT-AGENT] ${entity_id}: Assessment saved — trend: ${input.performance_trend}, freq: ${input.frequency_status}`);

  return { saved: true };
}

async function handleLogReasoning(input) {
  // Lightweight trace — just log, don't create full ActionLog
  logger.debug(`[ACCOUNT-AGENT][REASONING] ${input.entity_id}: ${input.reasoning}`);
  return { logged: true };
}

// Tool dispatch map
const TOOL_HANDLERS = {
  get_adset_metrics: (input, _ctx) => handleGetAdsetMetrics(input),
  get_ad_performance: (input, _ctx) => handleGetAdPerformance(input),
  get_scaling_history: (input, _ctx) => handleGetScalingHistory(input),
  get_bandit_signal: (input, _ctx) => handleGetBanditSignal(input),
  get_entity_memory: (input, _ctx) => handleGetEntityMemory(input),
  get_recent_insights: (input, _ctx) => handleGetRecentInsights(input),
  scale_budget: handleScaleBudget,
  move_budget: handleMoveBudget,
  pause_ad: handlePauseAd,
  reactivate_ad: handleReactivateAd,
  pause_adset: handlePauseAdSet,
  save_observation: (input, _ctx) => handleSaveObservation(input),
  save_assessment: handleSaveAssessment,
  log_reasoning: (input, _ctx) => handleLogReasoning(input)
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_TURNS = 10;
const OBSERVER_TOOLS = TOOLS.filter(t => !['scale_budget', 'pause_ad', 'reactivate_ad', 'pause_adset'].includes(t.name));
const LEARNING_SCALE_ONLY_TOOLS = TOOLS.filter(t => !['pause_ad', 'reactivate_ad', 'pause_adset'].includes(t.name));

/**
 * Detect if we're in active hours (6am-10pm ET) or observer mode.
 */
function _getAgentMode() {
  const moment = require('moment-timezone');
  const hour = moment().tz('America/New_York').hours();
  return (hour >= 6 && hour < 22) ? 'full' : 'observer';
}

/**
 * Run the unified Account Agent.
 * Iterates ALL active ad sets and runs an agentic loop on each.
 * Mode: 'full' (6am-10pm) = examine + act, 'observer' (10pm-6am) = examine only.
 *
 * @returns {Object} { managed, actions_taken, results, elapsed, cycle_id, mode }
 */
/**
 * AUTO-REVERT (2026-06-05): rollback de scale_ups que CRASHEARON post-scale. Ataca de
 * forma directa y per-adset el win-rate de scale_up bajo (~32% revierten), donde el
 * cash-gate (account-level) no llega. Lag-robusto: solo revierte scales con ≥48h
 * (atribución asentada) cuyo cash-adj ROAS 3d quedó claramente perdiendo (<1.0x) sobre
 * spend real post-scale. Es un rollback de BUDGET (no pausa) → bajo riesgo aunque se
 * equivoque (el adset sigue corriendo al budget original y puede re-escalarse).
 */
async function revertDegradedScales(meta, allSnapshots) {
  const LOOKBACK_D = 5, MIN_AGE_H = 48, CASH_FLOOR = 1.0;
  try {
    const since = new Date(Date.now() - LOOKBACK_D * 86400000);
    const maxAge = new Date(Date.now() - MIN_AGE_H * 3600000);
    const scales = await ActionLog.find({
      action: 'scale_up', success: true, agent_type: 'unified_agent',
      executed_at: { $gte: since, $lte: maxAge }
    }).sort({ executed_at: -1 }).lean();
    if (!scales.length) return 0;

    let haircut = 1;
    try {
      const { getAccountCashSignal } = require('./demeter-cash-signal');
      const cs = await getAccountCashSignal();
      if (cs.available) haircut = cs.haircut_factor;
    } catch (_) { /* fail-open: haircut 1 (Meta crudo) */ }

    const byId = new Map(allSnapshots.map(s => [s.entity_id, s]));
    let reverted = 0;
    for (const sc of scales) {
      if (!sc.before_value || !sc.after_value || sc.before_value >= sc.after_value) continue;
      // Idempotencia: ya revertido, o hubo otra decisión de budget después (no pisar).
      const already = await ActionLog.findOne({ 'metadata.revert_of': String(sc._id) }).select('_id').lean();
      if (already) continue;
      const newer = await ActionLog.findOne({ entity_id: sc.entity_id, action: { $in: ['scale_up', 'scale_down', 'move_budget'] }, executed_at: { $gt: sc.executed_at } }).select('_id').lean();
      if (newer) continue;

      const snap = byId.get(sc.entity_id);
      if (!snap) continue;
      const m3 = snap.metrics?.last_3d || {};
      const cashAdj3 = (m3.roas || 0) * haircut;
      const spend3 = m3.spend || 0;
      // Degradó: cash-adj 3d perdiendo (<1.0x) Y gastó post-scale (≥~1 día del budget nuevo
      // en la ventana 3d → hay data real, no es solo lag).
      if (cashAdj3 >= CASH_FLOOR || spend3 < sc.after_value) continue;

      await meta.updateBudget(sc.entity_id, sc.before_value);
      await ActionLog.create({
        entity_type: 'adset', entity_id: sc.entity_id, entity_name: snap.entity_name || sc.entity_id,
        action: 'scale_down', before_value: sc.after_value, after_value: sc.before_value,
        change_percent: Math.round((sc.before_value - sc.after_value) / sc.after_value * 100),
        reasoning: `[AUTO-REVERT] scale_up del ${new Date(sc.executed_at).toISOString().slice(0, 10)} crasheó: cash-adj ROAS 3d ${cashAdj3.toFixed(2)}x (<${CASH_FLOOR}x), ${m3.purchases || 0} compras, $${spend3.toFixed(0)} spend post-scale. Rollback $${sc.after_value}→$${sc.before_value}.`,
        confidence: 'high', agent_type: 'unified_agent', success: true, executed_at: new Date(),
        metadata: { auto_revert: true, revert_of: String(sc._id) }
      });
      reverted++;
      logger.info(`[ACCOUNT-AGENT] ↩️ AUTO-REVERT ${snap.entity_name || sc.entity_id}: $${sc.after_value}→$${sc.before_value} (cash-adj 3d ${cashAdj3.toFixed(2)}x crasheó post-scale)`);
    }
    if (reverted) logger.info(`[ACCOUNT-AGENT] auto-revert: ${reverted} scale_ups degradados revertidos`);
    return reverted;
  } catch (e) {
    logger.warn(`[ACCOUNT-AGENT] auto-revert falló (no crítico): ${e.message}`);
    return 0;
  }
}

async function runAccountAgent() {
  const startTime = Date.now();
  const cycleId = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  let mode = _getAgentMode();
  logger.info(`═══ Iniciando Account Agent [${cycleId}] modo=${mode} ═══`);

  // Platform circuit breaker — si Meta está degradada, forzamos observer (solo read, sin writes)
  try {
    const { isDegraded } = require('../../safety/platform-circuit-breaker');
    const platform = await isDegraded();
    if (platform.degraded && mode !== 'observer') {
      logger.warn(`[ACCOUNT-AGENT] Platform degradada (${platform.reason}) — forzando observer mode, sin writes`);
      mode = 'observer';
    }
  } catch (err) {
    logger.warn(`[ACCOUNT-AGENT] platform circuit breaker check falló: ${err.message}`);
  }

  // Chequear directivas avoid de Zeus (ej billing freeze)
  try {
    const { isAgentBlocked } = require('../zeus/directive-guard');
    const block = await isAgentBlocked('athena');
    if (block.blocked) {
      logger.info(`[ACCOUNT-AGENT] Cycle SKIP por directiva de Zeus: "${block.reason}"`);
      return {
        skipped: true,
        reason: block.reason,
        directive_id: block.directive_id,
        managed: 0,
        actions_taken: 0,
        results: [],
        elapsed: '0s',
        cycle_id: cycleId
      };
    }
  } catch (err) {
    logger.warn(`[ACCOUNT-AGENT] directive-guard check falló: ${err.message}`);
  }

  // Freshness guard
  const freshness = await getSnapshotFreshness('adset');
  if (!freshness.fresh) {
    logger.warn(`[ACCOUNT-AGENT] Datos stale (${freshness.age_minutes} min) — abortando.`);
    return { managed: 0, actions_taken: 0, results: [], elapsed: '0s', cycle_id: cycleId, abortReason: `Datos stale: ${freshness.age_minutes} min` };
  }

  // Consume learning feedback first
  const learner = new PolicyLearner();
  await learner.consumeImpactFeedback();

  // Get ALL active ad set snapshots
  const allSnapshots = await getLatestSnapshots('adset');

  // AUTO-REVERT: antes de decidir scales nuevos, revertir los scale_ups que crashearon.
  if (mode === 'full') {
    await revertDegradedScales(getMetaClient(), allSnapshots).catch(e => logger.warn(`[ACCOUNT-AGENT] auto-revert error: ${e.message}`));
  }

  // Athena = ABO. Excluye: tests activos de Prometheus ([TEST]), clones de Ares,
  // Hermes, y adsets de CBO (daily_budget 0 = budget a nivel campaña → de Ares,
  // no de Athena). Solo deja adsets ABO de producción + graduados [Prometheus].
  const activeAdSets = allSnapshots.filter(s => s.status === 'ACTIVE'
    && (s.daily_budget || 0) > 0
    && !(s.entity_name || '').startsWith('[TEST]')
    && !(s.entity_name || '').startsWith('[Ares]')
    && !(s.entity_name || '').startsWith('[HERMES]')
    && !(s.entity_name || '').startsWith('[Hermes]')
    && !isExcludedEntity({ campaign_id: s.campaign_id, entity_name: s.entity_name })); // campañas manual-only (ej. posts boosteados)

  if (activeAdSets.length === 0) {
    logger.info('[ACCOUNT-AGENT] No active ad sets found');
    return { managed: 0, actions_taken: 0, results: [], elapsed: '0s', cycle_id: cycleId };
  }

  logger.info(`[ACCOUNT-AGENT] Procesando ${activeAdSets.length} ad sets activos (datos: ${freshness.age_minutes} min)`);

  let totalActions = 0;
  const results = [];

  // Haircut de cash UNA vez por ciclo (corregido — ver demeter-cash-blended). Para los
  // targets por-adset (baseline en cash-adjusted). Fail-open a 1 (Meta crudo).
  let cycleHaircut = 1;
  try {
    const { getAccountCashSignal } = require('./demeter-cash-signal');
    const cs = await getAccountCashSignal();
    if (cs.available) cycleHaircut = cs.haircut_factor;
  } catch (_) { /* fail-open */ }

  for (const adSetSnap of activeAdSets) {
    const adSetId = adSetSnap.entity_id;
    try {
      const result = await _manageAdSet(adSetSnap, cycleId, mode, cycleHaircut);
      totalActions += result.actionsExecuted;
      results.push({
        adset_id: adSetId,
        adset_name: adSetSnap.entity_name,
        actions_executed: result.actionsExecuted,
        action_types: result.actionTypes || [],
        assessment_saved: result.assessmentSaved,
        skipped: result.skipped || false,
        skip_reason: result.skipReason || null
      });
    } catch (err) {
      logger.error(`[ACCOUNT-AGENT] Error procesando ${adSetId}: ${err.message}`);
      results.push({
        adset_id: adSetId,
        adset_name: adSetSnap.entity_name,
        error: err.message
      });
    }
  }

  const elapsed = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
  logger.info(`═══ Account Agent completado [${cycleId}]: ${activeAdSets.length} ad sets, ${totalActions} acciones en ${elapsed} ═══`);

  // Reportar a Zeus
  try {
    const ZeusConversation = require('../../db/models/ZeusConversation');
    const ZeusDirective = require('../../db/models/ZeusDirective');
    const activeDirectives = await ZeusDirective.find({ target_agent: { $in: ['athena', 'all'] }, active: true }).lean();
    // Contar por tipo de accion (un ad set puede tener multiples acciones).
    // pause_adset cuenta como pause (ambos pausan inventory). reactivate se reporta aparte.
    const countType = (t) => results.reduce((n, r) => n + (r.action_types || []).filter(at => at === t).length, 0);
    const scaleUps = countType('scale_up');
    const scaleDowns = countType('scale_down');
    const scales = { length: scaleUps + scaleDowns };
    const pauses = { length: countType('pause') + countType('pause_adset') };
    const reactivates = { length: countType('reactivate') };
    const holds = { length: results.filter(r => !r.action_types || r.action_types.length === 0).length };

    // Truncar texto preservando word-boundary y agregando ellipsis si corta.
    const truncSmart = (text, max) => {
      if (!text) return '';
      if (text.length <= max) return text;
      const cut = text.substring(0, max);
      const lastSpace = cut.lastIndexOf(' ');
      const base = lastSpace > max * 0.6 ? cut.substring(0, lastSpace) : cut;
      return base + '…';
    };

    const learningCount = results.filter(r => r.skipReason && r.skipReason.startsWith('Learning phase')).length;
    let msg = `Ciclo completado (${mode}): ${activeAdSets.length} ad sets evaluados, ${totalActions} acciones en ${elapsed}.`;
    msg += ` Escalé ${scales.length}, pausé ${pauses.length}, holdé ${holds.length}.`;
    if (reactivates.length > 0) msg += ` Reactivé ${reactivates.length}.`;
    if (learningCount > 0) msg += ` ${learningCount} ad sets en LEARNING (no tocados).`;
    if (activeDirectives.length > 0) {
      msg += ` Recibí ${activeDirectives.length} directivas tuyas: ${activeDirectives.map(d => `"${truncSmart(d.directive, 80)}"`).join(', ')}.`;
    }
    await ZeusConversation.create({
      from: 'athena', to: 'zeus', type: 'report', message: msg, cycle_id: cycleId,
      context: { managed: activeAdSets.length, actions: totalActions, scales: scales.length, pauses: pauses.length, holds: holds.length, directives_received: activeDirectives.length }
    });
  } catch (err) {
    logger.warn(`[ACCOUNT-AGENT] No se pudo persistir cycle report a Zeus: ${err.message}`);
  }

  return { managed: activeAdSets.length, actions_taken: totalActions, results, elapsed, cycle_id: cycleId, mode };
}

/**
 * Process a single ad set through the agentic loop.
 * @param {Object} adSetSnap - MetricSnapshot for this ad set
 * @param {string} cycleId
 * @param {string} mode - 'full' (can act) or 'observer' (read-only)
 */
async function _manageAdSet(adSetSnap, cycleId, mode = 'full', cashHaircut = 1) {
  const adSetId = adSetSnap.entity_id;
  const adSetName = adSetSnap.entity_name || adSetId;
  const meta = getMetaClient();

  const m7d = adSetSnap.metrics?.last_7d || {};
  const m3d = adSetSnap.metrics?.last_3d || {};
  const adSetRoas = m7d.roas || 0;
  const adSetSpend = m7d.spend || 0;
  const adSetPurchases = m7d.purchases || 0;
  const adSetFrequency = m7d.frequency || 0;
  const roas3d = m3d.roas || 0;
  const currentBudget = adSetSnap.daily_budget || 0;

  // Check if this is an AI-created ad set
  const AICreation = require('../../db/models/AICreation');
  const aiCreation = await AICreation.findOne({
    meta_entity_id: adSetId,
    creation_type: 'create_adset'
  }).lean();

  const daysSinceCreation = aiCreation
    ? (Date.now() - new Date(aiCreation.created_at).getTime()) / 86400000
    : 999; // Non-AI ad sets are considered mature

  // ═══ PRE-CHECK: Hardcoded decision tree (emergencies) — only for AI-created ═══
  if (aiCreation) {
    const adsData = (await getAdsForAdSet(adSetId)).map(snap => {
      const am = snap.metrics?.last_7d || {};
      return {
        ad_id: snap.entity_id,
        ad_name: snap.entity_name,
        status: snap.status || 'ACTIVE',
        spend: am.spend || 0,
        purchases: am.purchases || 0,
        roas: am.roas || 0,
        ctr: am.ctr || 0,
        frequency: am.frequency || 0
      };
    });

    const brainDirectives = await StrategicDirective.find({
      status: 'active',
      expires_at: { $gt: new Date() },
      source_insight_type: 'brain_supervision',
      entity_id: adSetId
    }).sort({ created_at: -1 }).lean().then(dirs => dirs.map(d => ({
      type: d.directive_type,
      target_action: d.target_action,
      reason: d.reason,
      urgency: d.urgency_level || 'medium',
      consecutive_count: d.consecutive_count || 1
    })));

    const metricsAtExecution = {
      roas_7d: Math.round(adSetRoas * 100) / 100,
      roas_3d: Math.round(roas3d * 100) / 100,
      cpa_7d: adSetSpend > 0 && adSetPurchases > 0 ? Math.round(adSetSpend / adSetPurchases * 100) / 100 : 0,
      spend_7d: adSetSpend,
      daily_budget: currentBudget,
      purchases_7d: adSetPurchases,
      frequency: adSetFrequency,
      ctr: m7d.ctr || 0
    };

    // Need the creation document (not lean) for forceKill/forceScaleDown
    const creationDoc = await AICreation.findById(aiCreation._id);
    if (creationDoc) {
      const preDecision = await hardcodedDecisionTree({
        creation: creationDoc, adSetId, adSetRoas, adSetSpend, adSetPurchases, adSetFrequency,
        daysSinceCreation, adsData, brainDirectives, roas3d,
        currentBudget, meta, metricsAtExecution
      });

      if (preDecision && preDecision.forced) {
        logger.info(`[ACCOUNT-AGENT][DECISION-TREE] Forced action on ${adSetName}: ${preDecision.action} — ${preDecision.reason}`);
        // Save assessment for forced actions
        await BrainMemory.findOneAndUpdate(
          { entity_id: adSetId },
          {
            $set: {
              entity_name: adSetName, entity_type: 'adset',
              agent_assessment: `[HARDCODED] ${preDecision.reason}`,
              agent_frequency_status: adSetFrequency > 4 ? 'critical' : adSetFrequency > 3 ? 'high' : 'ok',
              agent_performance_trend: 'declining',
              agent_last_check: new Date(),
              last_updated_at: new Date()
            }
          },
          { upsert: true }
        );
        return { actionsExecuted: preDecision.actionsExecuted || 1, assessmentSaved: true };
      }
    }
  }

  // ═══ PRE-CHECK: Cooldown + Pending (only in full mode — observer always examines) ═══
  // Zeus PRIORITIZE directives bypass cooldown/pending — let Claude evaluate and decide
  let hasZeusScaleDirective = false;
  try {
    const ZeusDirectiveModel = require('../../db/models/ZeusDirective');
    const zeusScaleDirs = await ZeusDirectiveModel.find({
      target_agent: { $in: ['athena', 'all'] },
      active: true,
      directive_type: 'prioritize'
    }).lean();
    // Matchear por nombre del ad set en el texto de la directiva
    const nameWords = adSetName.toLowerCase().split(/\s+/);
    hasZeusScaleDirective = zeusScaleDirs.some(d => {
      const dirText = (d.directive || '').toLowerCase();
      // Tambien checar data.action === 'scale_up' si tiene entity reference
      return nameWords.some(w => w.length > 3 && dirText.includes(w)) ||
        (d.data?.action === 'scale_up' && dirText.includes('scale'));
    });
  } catch (err) {
    // Fail-safe: si la query falla, mantenemos hasZeusScaleDirective=false (conservador: no bypass cooldown).
    // Log para que el fallo no quede invisible y Zeus pueda diagnosticar si sus directivas no se aplican.
    logger.warn(`[ACCOUNT-AGENT] Zeus PRIORITIZE check failed for ${adSetName}: ${err.message}`);
  }

  if (mode === 'full') {
    const cooldown = await _isOnAgentCooldown(adSetId);
    if (cooldown.onCooldown && !hasZeusScaleDirective) {
      logger.debug(`[ACCOUNT-AGENT] ${adSetName}: cooldown (${cooldown.minutesLeft} min remaining)`);
      return { actionsExecuted: 0, assessmentSaved: false, skipped: true, skipReason: `Cooldown: ${cooldown.minutesLeft} min` };
    }
    if (cooldown.onCooldown && hasZeusScaleDirective) {
      logger.info(`[ACCOUNT-AGENT] ${adSetName}: cooldown bypassed — Zeus PRIORITIZE directive active`);
    }

    const pendingActions = await ActionLog.find({
      entity_id: adSetId,
      agent_type: 'unified_agent',
      success: true,
      impact_1d_measured: false,
      executed_at: { $gte: new Date(Date.now() - 24 * 3600000) }
    }).sort({ executed_at: -1 }).limit(1).lean();

    if (pendingActions.length > 0 && !hasZeusScaleDirective) {
      const hoursAgo = Math.round((Date.now() - new Date(pendingActions[0].executed_at).getTime()) / 3600000);
      logger.debug(`[ACCOUNT-AGENT] ${adSetName}: pending impact ("${pendingActions[0].action}" ${hoursAgo}h ago)`);
      return { actionsExecuted: 0, assessmentSaved: false, skipped: true, skipReason: `Pending impact: ${hoursAgo}h` };
    }
  }

  // ═══ PRE-CHECK: Excluded ad sets (traffic campaigns, manual-only) ═══
  if (isExcludedEntity({ campaign_id: adSetSnap.campaign_id, entity_name: adSetName })) {
    logger.debug(`[ACCOUNT-AGENT] ${adSetName}: campaña/entidad excluida (manual-only) — skip`);
    return { actionsExecuted: 0, assessmentSaved: false, skipped: true, skipReason: 'Excluded entity' };
  }
  const excludePatterns = ['DONT TOUCH', 'DONT_TOUCH', 'NO TOCAR', 'EXCLUDE', 'MANUAL ONLY', '[TEST]', '[ARES]', '[HERMES]'];
  if (excludePatterns.some(p => (adSetName || '').toUpperCase().includes(p))) {
    logger.debug(`[ACCOUNT-AGENT] ${adSetName}: excluded by name pattern — skip`);
    return { actionsExecuted: 0, assessmentSaved: false, skipped: true, skipReason: 'Excluded by name' };
  }

  // ═══ PRE-CHECK: Learning stage — Claude can scale but NOT pause ad sets in LEARNING ═══
  // Scale +15% does NOT reset learning. Pause DOES reset. Claude handles this via prompt rules.

  // ═══ PRE-CHECK: Low spend filter (< $5/week) ═══
  if (adSetSpend < 5) {
    logger.debug(`[ACCOUNT-AGENT] ${adSetName}: low spend ($${adSetSpend.toFixed(2)} < $5/7d) — skip`);
    return { actionsExecuted: 0, assessmentSaved: false, skipped: true, skipReason: 'Low spend < $5/7d' };
  }

  // ═══ PRE-CHECK: Smart skip — ad sets estables no necesitan evaluacion cada 2h ═══
  const memory = await BrainMemory.findOne({ entity_id: adSetId }).lean();
  const pendingPlan = memory?.agent_pending_plan || '';
  const nextReview = memory?.agent_next_review_at;
  const lastCheck = memory?.agent_last_check;
  const trend = memory?.agent_performance_trend;

  // Si Zeus tiene directivas activas, no skipear
  let zeusHasDirectives = false;
  try {
    const ZeusDirective = require('../../db/models/ZeusDirective');
    const zeusCount = await ZeusDirective.countDocuments({ target_agent: { $in: ['athena', 'all'] }, active: true });
    zeusHasDirectives = zeusCount > 0;
  } catch (err) {
    // Fail-open: si la query falla, asumimos que SÍ hay directivas → no skipeamos el ad set.
    // Peor evaluar de más que ignorar silenciosamente una directiva de Zeus.
    logger.warn(`[ACCOUNT-AGENT] ZeusDirective query failed, assuming directives exist (fail-open): ${err.message}`);
    zeusHasDirectives = true;
  }

  // Smart skip: si ad set esta estable/improving Y fue checkeado hace < 12h Y no hay plan pendiente urgente
  if (mode === 'full' && !zeusHasDirectives && lastCheck) {
    const hoursSinceCheck = (Date.now() - new Date(lastCheck).getTime()) / 3600000;
    const isHealthy = (trend === 'stable' || trend === 'improving') && adSetRoas >= 2.0 && adSetFrequency < 2.5;

    if (isHealthy && hoursSinceCheck < 12 && !pendingPlan) {
      logger.debug(`[ACCOUNT-AGENT] ${adSetName}: healthy (${trend}, ROAS ${adSetRoas.toFixed(1)}x), checked ${hoursSinceCheck.toFixed(0)}h ago — smart skip`);
      return { actionsExecuted: 0, assessmentSaved: false, skipped: true, skipReason: `Smart skip: healthy, ${hoursSinceCheck.toFixed(0)}h ago` };
    }
  }

  // Next review schedule skip (respeta el programa de Athena)
  if (mode === 'full' && nextReview && new Date(nextReview) > new Date() && !pendingPlan && !zeusHasDirectives) {
    const hoursLeft = Math.round((new Date(nextReview) - new Date()) / 3600000);
    logger.debug(`[ACCOUNT-AGENT] ${adSetName}: next review in ${hoursLeft}h — skip`);
    return { actionsExecuted: 0, assessmentSaved: false, skipped: true, skipReason: `Next review in ${hoursLeft}h` };
  }

  // ═══ AGENTIC LOOP ═══
  const ctx = {
    actionsExecuted: 0,
    assessmentsSaved: 0,
    actionTypes: [],
    hasZeusScaleDirective
  };

  const isObserver = mode === 'observer';
  const activeTools = isObserver ? OBSERVER_TOOLS : TOOLS;

  // Leer directivas de Zeus para Athena
  let zeusContext = '';
  try {
    const ZeusDirective = require('../../db/models/ZeusDirective');
    // Fix 2026-04-22: agregar filter de expires_at. Antes Athena podía leer
    // directivas técnicamente active=true pero expiradas (expires_at < now)
    // que quedaron sin deactivate cron. Ahora solo vigentes.
    const now = new Date();
    const directives = await ZeusDirective.find({
      target_agent: { $in: ['athena', 'all'] },
      active: true,
      $or: [{ expires_at: null }, { expires_at: { $gt: now } }]
    }).lean();
    if (directives.length > 0) {
      zeusContext = '\n\n## ZEUS DIRECTIVES\n' +
        directives.map(d => `- [${d.directive_type.toUpperCase()}] ${d.directive}`).join('\n') +
        '\nZeus is the CEO. PRIORITIZE = act now. ALERT = respect. These override HOLD.';
    }
  } catch (err) {
    // Crítico: si falla, Athena no recibe las directivas de Zeus en el prompt.
    // Logeamos para evidencia + señalizamos el fallo en el prompt mismo para que Athena
    // sepa que NO debería asumir ausencia de directivas = "no hay nada que respetar".
    logger.warn(`[ACCOUNT-AGENT] Zeus directives load failed for ${adSetName}: ${err.message}`);
    zeusContext = '\n\n## ZEUS DIRECTIVES\n[⚠ error loading Zeus directives — proceed conservatively, do NOT assume absence of directives]';
  }

  const systemPromptWithZeus = AGENT_SYSTEM_PROMPT + zeusContext;

  const baseContext = `Ad set ${adSetId} ("${adSetName}"). Budget: $${currentBudget}/day. 7d ROAS: ${adSetRoas.toFixed(2)}x, Spend: $${adSetSpend.toFixed(0)}, Purchases: ${adSetPurchases}, Frequency: ${adSetFrequency.toFixed(1)}.`;
  const planContext = pendingPlan ? `\n\nYOUR PREVIOUS PLAN for this ad set: "${pendingPlan}"\nCheck if conditions are met and execute accordingly. If conditions changed, make a new plan.` : '';

  const learningContext = adSetSnap.learning_stage === 'LEARNING'
    ? ` Meta LEARNING phase: ${adSetSnap.learning_stage_conversions || 0}/50 conversions. Scale +15% is safe (does NOT reset learning). Pause DOES reset — avoid pausing.`
    : '';

  // TARGET POR-ADSET: baseline/piso derivados de la historia del propio adset (cash-adj).
  // Athena juzga contra ESTO, no los umbrales globales. '' si el adset es muy nuevo.
  let targetContext = '';
  try {
    const { computeAdsetTarget, buildTargetContext } = require('./athena-targets');
    targetContext = buildTargetContext(computeAdsetTarget(adSetSnap, cashHaircut));
  } catch (e) {
    logger.warn(`[ACCOUNT-AGENT] target por-adset falló (no crítico): ${e.message}`);
  }

  // ROAS MARGINAL: la frontera eficiente — ¿el dólar del último scale todavía rinde?
  let marginalContext = '';
  try {
    const { getMarginalSignal } = require('./athena-marginal');
    const sig = await getMarginalSignal(adSetSnap, cashHaircut);
    marginalContext = sig.context;
  } catch (e) { /* fail-open */ }

  // SATURACIÓN ADELANTADA: el techo de AUDIENCIA antes de quemar (freq/CPM/CTR trends).
  let saturationContext = '';
  try {
    const { getSaturationSignal } = require('./athena-saturation');
    saturationContext = getSaturationSignal(adSetSnap).context;
  } catch (e) { /* fail-open */ }

  const userMessage = isObserver
    ? `[OBSERVER MODE — nighttime, read-only] Analyze ${baseContext}${targetContext}${marginalContext}${saturationContext} Gather data, analyze trends, and save your assessment. You CANNOT take actions right now — only observe and document what you see.${planContext}`
    : `Analyze and manage ${baseContext}${learningContext}${targetContext}${marginalContext}${saturationContext} Gather data, decide actions based on ROAS and data, and save your assessment.${planContext}`;

  let messages = [{ role: 'user', content: userMessage }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let response;
    try {
      response = await client.messages.create({
        model: config.claude.model,
        max_tokens: 2048,
        system: systemPromptWithZeus,
        tools: activeTools,
        messages
      });
    } catch (apiErr) {
      if (apiErr.status === 429 && turn < 3) {
        logger.warn(`[ACCOUNT-AGENT] Rate limit on turn ${turn} for ${adSetId}. Waiting 15s...`);
        await new Promise(r => setTimeout(r, 15000));
        try {
          response = await client.messages.create({
            model: config.claude.model,
            max_tokens: 2048,
            system: systemPromptWithZeus,
            tools: activeTools,
            messages
          });
        } catch (retryErr) {
          logger.error(`[ACCOUNT-AGENT] Claude API retry failed for ${adSetId}: ${retryErr.message}`);
          break;
        }
      } else {
        logger.error(`[ACCOUNT-AGENT] Claude API error on turn ${turn} for ${adSetId}: ${apiErr.message}`);
        break;
      }
    }

    // Check for end_turn
    if (response.stop_reason === 'end_turn') {
      break;
    }

    // Process tool calls
    const toolUseBlocks = (response.content || []).filter(b => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) {
      break;
    }

    // Add assistant message
    messages.push({ role: 'assistant', content: response.content });

    // Process each tool call
    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      const handler = TOOL_HANDLERS[toolUse.name];
      if (!handler) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({ error: `Unknown tool: ${toolUse.name}` })
        });
        continue;
      }

      logger.debug(`[ACCOUNT-AGENT] ${adSetId} turn ${turn}: ${toolUse.name}`);

      try {
        const result = await handler(toolUse.input, ctx);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result)
        });
      } catch (toolErr) {
        logger.error(`[ACCOUNT-AGENT] Tool ${toolUse.name} error: ${toolErr.message}`);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({ error: toolErr.message }),
          is_error: true
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  // ═══ SAFETY NET: Save assessment if agent didn't ═══
  if (ctx.assessmentsSaved === 0) {
    logger.warn(`[ACCOUNT-AGENT] ${adSetId}: Agent didn't save assessment — saving default`);
    await BrainMemory.findOneAndUpdate(
      { entity_id: adSetId },
      {
        $set: {
          entity_name: adSetName, entity_type: 'adset',
          agent_assessment: `[AUTO] Sin assessment explícito. Acciones: ${ctx.actionsExecuted}.`,
          agent_last_check: new Date(),
          last_updated_at: new Date()
        }
      },
      { upsert: true }
    );
  }

  return { actionsExecuted: ctx.actionsExecuted, assessmentSaved: ctx.assessmentsSaved > 0, actionTypes: ctx.actionTypes || [] };
}

module.exports = { runAccountAgent };
