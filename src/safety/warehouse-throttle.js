/**
 * Warehouse Throttle — frena el spend del account cuando logística no
 * puede procesar más órdenes.
 *
 * Filosofía:
 *   1. Bajar progresivo (-5% a -20% según ROAS) hasta llegar al target
 *   2. Bajar primero los peores ROAS, los winners apenas se tocan
 *   3. Pausar Apollo (no genera) + Prometheus (no testea) para no
 *      acumular inventario nuevo durante la pausa
 *   4. Auto-disable después de N días (default 21) por safety
 *   5. Recovery automático: cuando enabled=false → cron sigue corriendo
 *      pero scale_up gradual en vez de scale_down
 *
 * Config persistida en SystemConfig key 'warehouse_throttle'.
 * Mutable desde frontend sin redeploy.
 */

const SystemConfig = require('../db/models/SystemConfig');
const ActionLog = require('../db/models/ActionLog');
const MetricSnapshot = require('../db/models/MetricSnapshot');
const logger = require('../utils/logger');

const CONFIG_KEY = 'warehouse_throttle';

// Defaults — usar Object.freeze para que no se muten accidentalmente.
const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  // Throttle target (cuando enabled=true)
  target_daily_spend: 2500,
  // Recovery target (cuando enabled=true + recovery_mode=true)
  recovery_target_daily_spend: 3000,
  recovery_mode: false,
  // Tiered scaling por ROAS 7d
  // Cuando bajamos: peor ROAS → bajada más fuerte
  // Cuando subimos (recovery): peor ROAS → subida más débil (proteger capital)
  roas_tiers: [
    { roas_max: 2.0, scale_down_pct: 0.20, scale_up_pct: 0.03 },
    { roas_max: 2.5, scale_down_pct: 0.15, scale_up_pct: 0.05 },
    { roas_max: 3.5, scale_down_pct: 0.10, scale_up_pct: 0.08 },
    { roas_max: 5.0, scale_down_pct: 0.07, scale_up_pct: 0.12 },
    { roas_max: Infinity, scale_down_pct: 0.05, scale_up_pct: 0.15 }
  ],
  floor_per_cbo: 200,
  floor_per_adset: 10,
  pause_apollo: true,
  pause_prometheus: true,
  pause_ares_scaling: true, // bloquea scale_up de Ares también
  auto_disable_after_days: 21,
  enabled_at: null,
  reason: 'Warehouse capacity bottleneck'
});

async function getConfig() {
  const stored = await SystemConfig.get(CONFIG_KEY);
  return { ...DEFAULT_CONFIG, ...(stored || {}) };
}

async function setConfig(updates) {
  const current = await getConfig();
  const merged = { ...current, ...updates };
  await SystemConfig.set(CONFIG_KEY, merged);

  // Sincronizar ZeusDirective: cuando se activa/desactiva throttle,
  // creamos/archivamos directiva para que TODOS los agentes (que ya
  // consultan directive-guard) sepan del bloqueo de scale_up.
  // Esto cubre: Athena, Brain Unified, Zeus en chat context, agentes
  // legacy. Granular gracias a action_scope.
  try {
    const justEnabled = !current.enabled && merged.enabled;
    const justDisabled = current.enabled && !merged.enabled;
    const recoveryChanged = current.recovery_mode !== merged.recovery_mode;

    if (justEnabled || (recoveryChanged && merged.enabled)) {
      // Recoger directiva pendiente (si existe) y archivar antes de crear nueva
      await archiveExistingThrottleDirective();
      // No crear directiva si está en recovery_mode (recovery permite scale_up)
      if (!merged.recovery_mode) {
        await createThrottleDirective(merged);
      }
    } else if (justDisabled) {
      await archiveExistingThrottleDirective();
    }
  } catch (err) {
    const logger = require('../utils/logger');
    logger.error(`[WAREHOUSE-THROTTLE] sync directive failed: ${err.message}`);
  }

  return merged;
}

async function createThrottleDirective(cfg) {
  const ZeusDirective = require('../db/models/ZeusDirective');
  const expiresAt = new Date(Date.now() + (cfg.auto_disable_after_days || 21) * 86400000);
  await ZeusDirective.create({
    target_agent: 'all',
    directive_type: 'avoid',
    directive: `Warehouse throttle activo (target $${cfg.target_daily_spend}/d). NO scale_up ni scale_budget mientras logística alcanza capacidad. ${cfg.reason}`,
    data: {
      throttle_target: cfg.target_daily_spend,
      reason: cfg.reason
    },
    confidence: 1.0,
    based_on_samples: 0,
    category: 'general',
    source: 'system',
    active: true,
    persistent: true,  // no auto-cleanup por cron de directivas
    action_scope: ['scale_up', 'scale_budget'],
    llm_can_override: false,  // ningún LLM agent puede argumentar override
    expires_at: expiresAt
  });
}

async function archiveExistingThrottleDirective() {
  const ZeusDirective = require('../db/models/ZeusDirective');
  await ZeusDirective.updateMany(
    {
      active: true,
      source: 'system',
      'data.throttle_target': { $exists: true }
    },
    { $set: { active: false } }
  );
}

/**
 * Estado público para frontend/zeus context.
 */
async function getStatus() {
  const cfg = await getConfig();
  if (!cfg.enabled) return { enabled: false };

  const enabledAt = cfg.enabled_at ? new Date(cfg.enabled_at) : null;
  const daysActive = enabledAt ? (Date.now() - enabledAt.getTime()) / 86400000 : 0;
  const daysRemaining = Math.max(0, cfg.auto_disable_after_days - daysActive);

  // Spend ayer (1 day window)
  const yesterdaySpend = await getYesterdaySpend();

  return {
    enabled: true,
    recovery_mode: cfg.recovery_mode,
    target_daily_spend: cfg.target_daily_spend,
    recovery_target_daily_spend: cfg.recovery_target_daily_spend,
    yesterday_spend: yesterdaySpend,
    excess: cfg.recovery_mode
      ? Math.max(0, cfg.recovery_target_daily_spend - yesterdaySpend)
      : Math.max(0, yesterdaySpend - cfg.target_daily_spend),
    days_active: +daysActive.toFixed(1),
    days_remaining: +daysRemaining.toFixed(1),
    enabled_at: cfg.enabled_at,
    reason: cfg.reason,
    pause_apollo: cfg.pause_apollo,
    pause_prometheus: cfg.pause_prometheus
  };
}

/**
 * ¿Apollo debe pararse en este ciclo?
 */
async function isApolloPaused() {
  const cfg = await getConfig();
  return cfg.enabled && !cfg.recovery_mode && cfg.pause_apollo;
}

/**
 * ¿Prometheus debe pararse en este ciclo?
 */
async function isPrometheusPaused() {
  const cfg = await getConfig();
  return cfg.enabled && !cfg.recovery_mode && cfg.pause_prometheus;
}

/**
 * ¿Cualquier scale_up debe ser bloqueado?
 */
async function isScaleUpBlocked() {
  const cfg = await getConfig();
  return cfg.enabled && !cfg.recovery_mode && cfg.pause_ares_scaling;
}

/**
 * Spend diario reciente del account (proxy para "ayer").
 *
 * IMPORTANTE: metrics.last_1d.spend es bug histórico — siempre retorna $0
 * (documentado en CLAUDE.md, oracle-context tuvo mismo issue). Usamos
 * last_3d.spend / 3 como average reciente confiable. Refleja mejor el
 * spend "típico" actual y es estable contra outliers de un día.
 */
async function getYesterdaySpend() {
  const snaps = await MetricSnapshot.aggregate([
    { $match: { entity_type: 'adset' } },
    { $sort: { entity_id: 1, snapshot_at: -1 } },
    { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } },
    { $match: { status: 'ACTIVE' } }
  ]);
  // Sum last_3d.spend across adsets, divide by 3 = avg daily spend
  const sum3d = snaps.reduce((s, a) => s + (a.metrics?.last_3d?.spend || 0), 0);
  return Math.round(sum3d / 3);
}

/**
 * Determina el tier de ROAS de una entidad.
 */
function tierForRoas(roas, tiers) {
  for (const t of tiers) {
    if (roas < t.roas_max) return t;
  }
  return tiers[tiers.length - 1];
}

/**
 * Cron job principal — corre diario 6am ET.
 *
 * Si enabled=false, no hace nada.
 * Si enabled=true && recovery_mode=false → scale_down tiered hasta target
 * Si enabled=true && recovery_mode=true → scale_up tiered hasta recovery target
 * Si days_active >= auto_disable_after_days → disable automático.
 */
async function runThrottleCycle() {
  const cfg = await getConfig();
  if (!cfg.enabled) {
    return { skipped: 'throttle disabled' };
  }

  // Auto-disable check
  if (cfg.enabled_at) {
    const daysActive = (Date.now() - new Date(cfg.enabled_at).getTime()) / 86400000;
    if (daysActive > cfg.auto_disable_after_days) {
      logger.info(`[WAREHOUSE-THROTTLE] auto-disable triggered (${daysActive.toFixed(0)} días > ${cfg.auto_disable_after_days})`);
      await setConfig({ enabled: false, enabled_at: null });
      await pingZeus(`🟢 Warehouse Throttle auto-disabled (${cfg.auto_disable_after_days} días cumplidos). Sistema vuelve a operación normal.`);
      return { auto_disabled: true };
    }
  }

  const yesterdaySpend = await getYesterdaySpend();
  const direction = cfg.recovery_mode ? 'up' : 'down';
  const target = cfg.recovery_mode ? cfg.recovery_target_daily_spend : cfg.target_daily_spend;

  // Si ya estamos en/debajo del target (down) o en/arriba del target (up), no actuar
  if (cfg.recovery_mode && yesterdaySpend >= target) {
    logger.info(`[WAREHOUSE-THROTTLE] recovery target alcanzado ($${yesterdaySpend} >= $${target}). Disabling throttle.`);
    await setConfig({ enabled: false, recovery_mode: false, enabled_at: null });
    await pingZeus(`🟢 Warehouse Throttle recovery completed: spend $${yesterdaySpend}/d alcanzó target $${target}/d. Sistema vuelve a operación normal.`);
    return { recovery_complete: true };
  }
  if (!cfg.recovery_mode && yesterdaySpend <= target) {
    logger.info(`[WAREHOUSE-THROTTLE] ya en target ($${yesterdaySpend} <= $${target}), no se aplica scale_down`);
    return { in_target: true, yesterday_spend: yesterdaySpend, target };
  }

  // Aplicar tiered scaling
  const result = await applyTieredScaling(cfg, direction);
  await pingZeus(buildPingMessage(cfg, direction, yesterdaySpend, target, result));
  return result;
}

/**
 * Lee todas las entidades con daily_budget activo y aplica scale_up/down
 * tiered según su ROAS 7d.
 */
async function applyTieredScaling(cfg, direction) {
  const { getMetaClient } = require('../meta/client');
  const meta = getMetaClient();

  // Reunir CBOs (campaign con daily_budget) + adsets ABO (adset con daily_budget)
  const [campaigns, adsets] = await Promise.all([
    MetricSnapshot.aggregate([
      { $match: { entity_type: 'campaign' } },
      { $sort: { entity_id: 1, snapshot_at: -1 } },
      { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      { $match: { status: 'ACTIVE', daily_budget: { $gt: 0 } } }
    ]),
    MetricSnapshot.aggregate([
      { $match: { entity_type: 'adset' } },
      { $sort: { entity_id: 1, snapshot_at: -1 } },
      { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      { $match: { status: 'ACTIVE', daily_budget: { $gt: 0 } } }
    ])
  ]);

  const entities = [
    ...campaigns.map(c => ({ ...c, _kind: 'campaign', _floor: cfg.floor_per_cbo })),
    ...adsets.map(a => ({ ...a, _kind: 'adset', _floor: cfg.floor_per_adset }))
  ];

  let applied = 0, skipped = 0, errors = 0;
  const details = [];

  for (const e of entities) {
    const roas = e.metrics?.last_7d?.spend > 0
      ? (e.metrics.last_7d.purchase_value || 0) / e.metrics.last_7d.spend
      : 0;
    const tier = tierForRoas(roas, cfg.roas_tiers);
    const pct = direction === 'down' ? tier.scale_down_pct : tier.scale_up_pct;

    const currentBudget = e.daily_budget;
    const proposedBudget = direction === 'down'
      ? Math.max(e._floor, Math.round(currentBudget * (1 - pct)))
      : Math.round(currentBudget * (1 + pct));

    if (proposedBudget === currentBudget) {
      skipped++;
      continue;
    }

    try {
      await meta.updateBudget(e.entity_id, proposedBudget);
      await ActionLog.create({
        entity_type: e._kind,
        entity_id: e.entity_id,
        entity_name: e.entity_name,
        action: direction === 'down' ? 'scale_down' : 'scale_up',
        before_value: currentBudget,
        after_value: proposedBudget,
        success: true,
        executed_at: new Date(),
        agent_type: 'warehouse_throttle',
        reasoning: `${cfg.recovery_mode ? 'Recovery' : 'Throttle'}: ${(pct*100).toFixed(0)}% (${direction}) · ROAS 7d ${roas.toFixed(2)}x (tier <${tier.roas_max}x) · target $${cfg.recovery_mode ? cfg.recovery_target_daily_spend : cfg.target_daily_spend}/d`,
        metadata: {
          source: 'warehouse_throttle',
          roas_7d: +roas.toFixed(3),
          tier_pct: pct,
          tier_roas_max: tier.roas_max,
          direction,
          recovery_mode: cfg.recovery_mode
        }
      });
      applied++;
      details.push({
        kind: e._kind,
        name: e.entity_name,
        before: currentBudget,
        after: proposedBudget,
        pct: +(pct * 100).toFixed(0),
        roas: +roas.toFixed(2)
      });
    } catch (err) {
      errors++;
      logger.error(`[WAREHOUSE-THROTTLE] ${e.entity_id} (${e.entity_name}) falló: ${err.message}`);
    }
  }

  logger.info(`[WAREHOUSE-THROTTLE] cycle ${direction}: ${applied} aplicados, ${skipped} skipped, ${errors} errors`);
  return { applied, skipped, errors, direction, details };
}

async function pingZeus(content) {
  try {
    const ZeusChatMessage = require('../db/models/ZeusChatMessage');
    const lastMsg = await ZeusChatMessage.findOne({}).sort({ created_at: -1 }).lean();
    if (!lastMsg?.conversation_id) return;
    await ZeusChatMessage.create({
      conversation_id: lastMsg.conversation_id,
      role: 'assistant',
      content,
      proactive: true,
      context_snapshot: { source: 'warehouse_throttle' }
    });
  } catch (_) { /* non-critical */ }
}

function buildPingMessage(cfg, direction, spend, target, result) {
  const arrow = direction === 'down' ? '🔻' : '🔺';
  const verb = direction === 'down' ? 'reduciendo' : 'aumentando';
  const pctSummary = result.details
    .reduce((acc, d) => { acc[d.pct] = (acc[d.pct]||0)+1; return acc; }, {});
  const pctStr = Object.entries(pctSummary).map(([p,n]) => `${n}× ${p}%`).join(', ');

  return `${arrow} **Warehouse Throttle ciclo ${direction}**\n\nSpend ayer: $${spend} · Target: $${target}\nAjustes aplicados: ${result.applied} entidades (${pctStr})\nErrores: ${result.errors || 0}\n\nDías activo: ${cfg.enabled_at ? Math.floor((Date.now() - new Date(cfg.enabled_at).getTime()) / 86400000) : 0}/${cfg.auto_disable_after_days}`;
}

/**
 * Rescale inmediato de TODOS los adsets/CBOs (active + paused) para que
 * el budget total sume ≤ targetTotal.
 *
 * Diferencia con runThrottleCycle:
 *  - NO filtra por status (toca paused también)
 *  - NO tiered por ROAS — proporcional uniforme
 *  - dryRun por default; pasar { dryRun: false } para aplicar
 *
 * Útil cuando hay pausa total y se quiere bajar budgets para reactivación
 * controlada.
 */
async function rescaleAll(targetTotal, options = {}) {
  const { dryRun = true, respectFloors = true } = options;
  const cfg = await getConfig();

  const [campaigns, adsets] = await Promise.all([
    MetricSnapshot.aggregate([
      { $match: { entity_type: 'campaign' } },
      { $sort: { entity_id: 1, snapshot_at: -1 } },
      { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      { $match: { daily_budget: { $gt: 0 }, status: { $ne: 'ARCHIVED' } } }
    ]),
    MetricSnapshot.aggregate([
      { $match: { entity_type: 'adset' } },
      { $sort: { entity_id: 1, snapshot_at: -1 } },
      { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      { $match: { daily_budget: { $gt: 0 }, status: { $ne: 'ARCHIVED' } } }
    ])
  ]);

  const entities = [
    ...campaigns.map(c => ({ ...c, _kind: 'campaign', _floor: respectFloors ? cfg.floor_per_cbo : 1 })),
    ...adsets.map(a => ({ ...a, _kind: 'adset', _floor: respectFloors ? cfg.floor_per_adset : 1 }))
  ];

  const totalCurrent = entities.reduce((s, e) => s + e.daily_budget, 0);
  const factor = totalCurrent > 0 ? targetTotal / totalCurrent : 0;

  const plan = entities.map(e => {
    const proposed = Math.max(e._floor, Math.round(e.daily_budget * factor));
    return {
      kind: e._kind,
      entity_id: e.entity_id,
      name: e.entity_name,
      status: e.status,
      before: e.daily_budget,
      after: proposed,
      delta: proposed - e.daily_budget
    };
  });

  const totalProjected = plan.reduce((s, p) => s + p.after, 0);

  if (dryRun) {
    return {
      dryRun: true,
      total_current: totalCurrent,
      target: targetTotal,
      total_projected: totalProjected,
      factor: +factor.toFixed(4),
      entities_count: plan.length,
      plan
    };
  }

  // Aplicar
  const { getMetaClient } = require('../meta/client');
  const meta = getMetaClient();

  let applied = 0, skipped = 0, errors = 0;
  const failed_details = [];
  for (const p of plan) {
    if (p.before === p.after) { skipped++; continue; }
    try {
      await meta.updateBudget(p.entity_id, p.after);
      await ActionLog.create({
        entity_type: p.kind,
        entity_id: p.entity_id,
        entity_name: p.name,
        action: p.delta < 0 ? 'scale_down' : 'scale_up',
        before_value: p.before,
        after_value: p.after,
        success: true,
        executed_at: new Date(),
        agent_type: 'warehouse_throttle',
        reasoning: `Rescale-all immediate: factor ${factor.toFixed(3)} towards target $${targetTotal}/d total`,
        metadata: {
          source: 'warehouse_throttle_rescale_all',
          factor,
          target_total: targetTotal,
          status_at_rescale: p.status
        }
      });
      applied++;
    } catch (err) {
      errors++;
      failed_details.push({
        kind: p.kind,
        entity_id: p.entity_id,
        name: p.name,
        status: p.status,
        before: p.before,
        attempted: p.after,
        error: err.message?.substring(0, 200) || 'unknown'
      });
      logger.error(`[WAREHOUSE-THROTTLE] rescale ${p.entity_id} (${p.name}) falló: ${err.message}`);
    }
  }

  logger.info(`[WAREHOUSE-THROTTLE] rescale-all: ${applied} aplicados, ${skipped} skipped, ${errors} errors · target $${targetTotal} · projected $${totalProjected}`);

  return {
    dryRun: false,
    applied,
    skipped,
    errors,
    total_current: totalCurrent,
    target: targetTotal,
    total_projected: totalProjected,
    factor: +factor.toFixed(4),
    failed_details,
    plan
  };
}

module.exports = {
  CONFIG_KEY,
  DEFAULT_CONFIG,
  getConfig,
  setConfig,
  getStatus,
  isApolloPaused,
  isPrometheusPaused,
  isScaleUpBlocked,
  runThrottleCycle,
  rescaleAll,
  getYesterdaySpend
};
