/**
 * Rec Capacity — capacity-aware gate para code-rec generation.
 *
 * Analog de portfolio-capacity.js pero para ZeusCodeRecommendation. El creador
 * es recurso limitado; generar recs sin awareness de backlog es ruido, no valor.
 *
 * Diseño Phase 2 (Hilo D, 2026-04-22):
 *   - Gradient zones (verde/amarillo/rojo) — NO binary block
 *   - Dedup por (file_path, line_range, pattern_hash) contra applied_last_30d + pending
 *   - Red-state aging: 72h clogged → ping creator (evita silent-failure propio)
 *   - Hysteresis: 24h cooldown post-transición a verde antes de full producción
 *   - pending_count operativo: excluye stale >30d + probables re-hallazgos
 *
 * Zones (basado en pending_count efectivo + growth rate):
 *   - green:  pending_eff < 10, cadencia normal, todas severities permitidas
 *   - yellow: 10 ≤ pending_eff < 15, cadencia reducida (sentinel x72h vs x24h),
 *             solo HIGH+ severities (MEDIUM/LOW pausadas)
 *   - red:    pending_eff ≥ 15 o growth_rate_per_day > 3, sentinel skip,
 *             solo CRITICAL bypassa (con dedup check)
 *
 * Implementado 2026-04-22.
 */

const crypto = require('crypto');
const logger = require('../../utils/logger');

const ZeusCodeRecommendation = require('../../db/models/ZeusCodeRecommendation');
const ZeusChatMessage = require('../../db/models/ZeusChatMessage');
const SystemConfig = require('../../db/models/SystemConfig');

// ═══ Thresholds (configurables via SystemConfig) ═══
const DEFAULT_CONFIG = {
  green_max_pending: 10,
  yellow_max_pending: 15,
  // growth_rate_per_day: pending netos nuevos por día últimos 7d
  red_growth_rate: 3,
  // Stale cutoff — recs pending >30d no cuentan en pending_eff
  stale_cutoff_days: 30,
  // Red aging — si zone=red >72h sin actividad, ping
  red_aging_hours: 72,
  // Hysteresis — 24h post-transición green antes de full cadencia
  post_green_hysteresis_hours: 24,
  // Sentinel yellow cadence multiplier (24h normal → 72h en yellow)
  sentinel_yellow_cadence_multiplier: 3
};

const STATE_KEY = 'rec_capacity_state';

// ═══════════════════════════════════════════════════════════════════════════
// Dedup
// ═══════════════════════════════════════════════════════════════════════════

/**
 * pattern_hash combina (file_path, line_range aproximado, primeras palabras del
 * rationale). No es hash exacto — tolera variación de wording mientras el bug
 * subyacente es el mismo.
 */
function computePatternHash(rec) {
  const lineRange = rec.line_start && rec.line_end
    ? `${Math.floor(rec.line_start / 20)}x` // bucket de 20 líneas
    : 'noline';
  const rationaleKey = (rec.rationale || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 8)
    .sort()
    .join('_');
  const raw = `${rec.file_path}::${lineRange}::${rec.category}::${rationaleKey}`;
  return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16);
}

/**
 * Chequea si una rec propuesta es duplicado probable de otra applied_last_30d
 * o pending. Retorna la rec que matchea (si existe) o null.
 */
async function findLikelyDuplicate(proposedRec) {
  const cutoff = new Date(Date.now() - 30 * 86400000);
  // Candidates: same file + not-too-old
  const candidates = await ZeusCodeRecommendation.find({
    file_path: proposedRec.file_path,
    $or: [
      { status: 'pending' },
      { status: 'applied', reviewed_at: { $gte: cutoff } }
    ]
  }).lean();

  if (candidates.length === 0) return null;

  const proposedHash = computePatternHash(proposedRec);
  for (const c of candidates) {
    if (computePatternHash(c) === proposedHash) return c;
    // Extra check: same line bucket + same category
    if (proposedRec.line_start && c.line_start) {
      const sameBucket = Math.floor(proposedRec.line_start / 20) === Math.floor(c.line_start / 20);
      if (sameBucket && c.category === proposedRec.category) return c;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Capacity assessment
// ═══════════════════════════════════════════════════════════════════════════

async function getConfig() {
  const stored = await SystemConfig.get('rec_capacity_config', null);
  return { ...DEFAULT_CONFIG, ...(stored || {}) };
}

async function getState() {
  return await SystemConfig.get(STATE_KEY, {
    zone: 'green',
    entered_green_at: null,
    entered_red_at: null,
    last_red_ping_at: null,
    last_assessed_at: null
  });
}

async function setState(newState) {
  await SystemConfig.set(STATE_KEY, { ...newState, last_assessed_at: new Date().toISOString() });
}

/**
 * pending_eff = pending recs NO stale + NO probable-dedup.
 * Excluye recs >30d sin review (se presumen abandonadas) y recs cuyo pattern_hash
 * coincide con otra ya applied en últimos 30d.
 */
async function computePendingEff(cfg) {
  const staleCutoff = new Date(Date.now() - cfg.stale_cutoff_days * 86400000);
  const allPending = await ZeusCodeRecommendation.find({
    status: 'pending',
    created_at: { $gte: staleCutoff }
  }).lean();

  const recentApplied = await ZeusCodeRecommendation.find({
    status: 'applied',
    reviewed_at: { $gte: staleCutoff }
  }).lean();
  const appliedHashes = new Set(recentApplied.map(r => computePatternHash(r)));

  const eff = allPending.filter(p => !appliedHashes.has(computePatternHash(p)));
  const staleDropped = (await ZeusCodeRecommendation.countDocuments({
    status: 'pending',
    created_at: { $lt: staleCutoff }
  }));
  const dedupDropped = allPending.length - eff.length;

  return {
    total_pending: allPending.length + staleDropped,
    pending_eff: eff.length,
    stale_dropped: staleDropped,
    dedup_dropped: dedupDropped,
    effective_recs: eff
  };
}

/**
 * growth_rate_per_day = (applied_7d - created_7d) / 7 — si created > applied,
 * el backlog crece. Negativo = bajando.
 */
async function computeGrowthRate() {
  const since7d = new Date(Date.now() - 7 * 86400000);
  const [created7d, resolved7d] = await Promise.all([
    ZeusCodeRecommendation.countDocuments({ created_at: { $gte: since7d } }),
    ZeusCodeRecommendation.countDocuments({
      status: { $in: ['applied', 'rejected'] },
      reviewed_at: { $gte: since7d }
    })
  ]);
  return +((created7d - resolved7d) / 7).toFixed(2);
}

function classifyZone(pendingEff, growthRate, cfg) {
  if (pendingEff >= cfg.yellow_max_pending) return 'red';
  if (growthRate > cfg.red_growth_rate) return 'red';
  if (pendingEff >= cfg.green_max_pending) return 'yellow';
  return 'green';
}

/**
 * Assessment completo — expuesto al Oracle via query_rec_capacity.
 */
async function assessRecCapacity() {
  const cfg = await getConfig();
  const pendingInfo = await computePendingEff(cfg);
  const growthRate = await computeGrowthRate();
  const zone = classifyZone(pendingInfo.pending_eff, growthRate, cfg);
  const prevState = await getState();

  // Transición de zone — actualizar state
  const stateUpdate = { ...prevState, zone };
  if (prevState.zone !== 'green' && zone === 'green') {
    stateUpdate.entered_green_at = new Date().toISOString();
  }
  if (prevState.zone !== 'red' && zone === 'red') {
    stateUpdate.entered_red_at = new Date().toISOString();
  }
  if (prevState.zone === 'red' && zone !== 'red') {
    stateUpdate.entered_red_at = null;
    stateUpdate.last_red_ping_at = null;
  }
  await setState(stateUpdate);

  // Hysteresis — si recién entramos green, aún no full cadencia
  const inHysteresis = stateUpdate.entered_green_at
    && zone === 'green'
    && (Date.now() - new Date(stateUpdate.entered_green_at).getTime()) < cfg.post_green_hysteresis_hours * 3600000;

  return {
    zone,
    pending_eff: pendingInfo.pending_eff,
    total_pending: pendingInfo.total_pending,
    stale_dropped: pendingInfo.stale_dropped,
    dedup_dropped: pendingInfo.dedup_dropped,
    growth_rate_per_day: growthRate,
    in_hysteresis: inHysteresis,
    hysteresis_remaining_hours: inHysteresis
      ? +(cfg.post_green_hysteresis_hours - (Date.now() - new Date(stateUpdate.entered_green_at).getTime()) / 3600000).toFixed(1)
      : 0,
    entered_red_at: stateUpdate.entered_red_at,
    red_aged_hours: stateUpdate.entered_red_at
      ? +((Date.now() - new Date(stateUpdate.entered_red_at).getTime()) / 3600000).toFixed(1)
      : null,
    config: cfg,
    assessed_at: new Date().toISOString()
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Gates — pre-emission decisions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Gate para propose_code_change. Retorna decisión + razón para el caller.
 *   - allowed: boolean — si puede emitir
 *   - is_duplicate: si detectó dedup
 *   - severity_required: qué severity mínima se necesita según zone
 */
async function canEmitRec(proposedRec) {
  const capacity = await assessRecCapacity();
  const { zone } = capacity;

  // Dedup check — siempre, independiente de zone
  const duplicate = await findLikelyDuplicate(proposedRec);
  if (duplicate) {
    return {
      allowed: false,
      reason: `duplicate of existing rec ${duplicate._id} (file=${duplicate.file_path}, status=${duplicate.status})`,
      is_duplicate: true,
      duplicate_rec_id: duplicate._id,
      zone
    };
  }

  // Severity gate por zone
  const severity = (proposedRec.severity || 'medium').toLowerCase();
  if (zone === 'red' && severity !== 'critical') {
    return {
      allowed: false,
      reason: `rec-capacity zone=red: solo CRITICAL bypassa. pending_eff=${capacity.pending_eff}. Procesá backlog antes de emitir MEDIUM/HIGH nuevos.`,
      zone,
      severity_required: 'critical'
    };
  }
  if (zone === 'yellow' && !['high', 'critical'].includes(severity)) {
    return {
      allowed: false,
      reason: `rec-capacity zone=yellow: solo HIGH+ permitidas. pending_eff=${capacity.pending_eff}.`,
      zone,
      severity_required: 'high'
    };
  }

  return {
    allowed: true,
    zone,
    in_hysteresis: capacity.in_hysteresis,
    pending_eff: capacity.pending_eff
  };
}

/**
 * Gate para Sentinel cron. Retorna si debe correr este ciclo.
 *   - red: skip completo
 *   - yellow: solo corre cada N ciclos (1/3 = cada 72h si cron es diario)
 *   - green + hysteresis: corre pero con flag para reducir scope
 *   - green full: corre normal
 */
async function shouldSentinelRun() {
  const capacity = await assessRecCapacity();
  const { zone, in_hysteresis } = capacity;

  if (zone === 'red') {
    return {
      run: false,
      reason: `rec-capacity zone=red (pending_eff=${capacity.pending_eff}). Sentinel skipped — procesá backlog.`,
      capacity
    };
  }

  if (zone === 'yellow') {
    // En yellow, sentinel corre con cadencia reducida. Usamos SystemConfig
    // para trackear la última ejecución y decidir.
    const lastRun = await SystemConfig.get('sentinel_last_run_at', null);
    const hoursSinceLastRun = lastRun
      ? (Date.now() - new Date(lastRun).getTime()) / 3600000
      : Infinity;
    const required = 24 * capacity.config.sentinel_yellow_cadence_multiplier; // 72h
    if (hoursSinceLastRun < required) {
      return {
        run: false,
        reason: `rec-capacity zone=yellow: sentinel cadence reducida a cada ${required}h. Faltan ${(required - hoursSinceLastRun).toFixed(1)}h.`,
        capacity
      };
    }
  }

  if (in_hysteresis) {
    return {
      run: true,
      reason: `green post-transición (${capacity.hysteresis_remaining_hours}h de hysteresis). Scope reducido.`,
      scope_reduced: true,
      capacity
    };
  }

  return { run: true, capacity };
}

/**
 * Marca el last-run del sentinel (llamado después de cada ejecución).
 */
async function markSentinelRun() {
  await SystemConfig.set('sentinel_last_run_at', new Date().toISOString());
}

// ═══════════════════════════════════════════════════════════════════════════
// Red-state aging — detecta backlog clogged y pingea al creador
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Chequea si el sistema está en zone=red por >72h sin actividad del creador
 * ni CRITICAL nuevo. Si sí, genera proactive ping.
 *
 * Llamado desde cron diario (comparte schedule con health checks).
 */
async function checkRedStateAging() {
  const state = await getState();
  if (state.zone !== 'red' || !state.entered_red_at) return { pinged: false };

  const cfg = await getConfig();
  const hoursInRed = (Date.now() - new Date(state.entered_red_at).getTime()) / 3600000;
  if (hoursInRed < cfg.red_aging_hours) return { pinged: false, hours_in_red: hoursInRed };

  // Ya pingeamos recientemente? (no spamear cada 30 min)
  if (state.last_red_ping_at) {
    const hoursSinceLastPing = (Date.now() - new Date(state.last_red_ping_at).getTime()) / 3600000;
    if (hoursSinceLastPing < 24) return { pinged: false, last_ping_hours_ago: hoursSinceLastPing };
  }

  // Chequear actividad reciente (último rec-resolution)
  const since = new Date(Date.now() - cfg.red_aging_hours * 3600000);
  const recentActivity = await ZeusCodeRecommendation.countDocuments({
    reviewed_at: { $gte: since },
    status: { $in: ['applied', 'rejected'] }
  });
  if (recentActivity > 0) {
    // Hubo actividad — no pingueamos, pero loggeamos
    logger.info(`[REC-CAPACITY] zone=red ${hoursInRed.toFixed(1)}h pero hay ${recentActivity} recs procesadas en ventana. Skip ping.`);
    return { pinged: false, reason: 'recent_activity' };
  }

  // Chequear CRITICAL recientes
  const criticalSince = await ZeusCodeRecommendation.countDocuments({
    severity: 'critical',
    created_at: { $gte: since }
  });

  // Ping
  const capacity = await assessRecCapacity();
  const msg = `🚨 **Rec backlog saturado** — zone=red por ${hoursInRed.toFixed(0)}h sin actividad tuya.\n\n` +
    `pending_eff: ${capacity.pending_eff} · stale descartados: ${capacity.stale_dropped} · dedups descartados: ${capacity.dedup_dropped}\n` +
    `growth_rate: ${capacity.growth_rate_per_day}/día\n` +
    `CRITICAL nuevos en ventana: ${criticalSince}\n\n` +
    `**Sentinel está pausado** hasta que proceses recs o aparezca CRITICAL genuino. Dos opciones:\n` +
    `1. Abrir panel 💡 y procesar (approve/reject) algunas pending — sobretodo MEDIUM/LOW viejas\n` +
    `2. Subir manualmente thresholds en SystemConfig.rec_capacity_config si considerás que 15 pending es normal para tu ritmo`;

  try {
    await ZeusChatMessage.create({
      conversation_id: 'rec_capacity_ping_' + Date.now(),
      role: 'assistant',
      content: msg,
      proactive: true
    });
    await setState({ ...state, last_red_ping_at: new Date().toISOString() });
    logger.warn(`[REC-CAPACITY] red-aging ping enviado. ${hoursInRed.toFixed(1)}h en red.`);
    return { pinged: true, hours_in_red: hoursInRed };
  } catch (err) {
    logger.warn(`[REC-CAPACITY] failed to send red-aging ping: ${err.message}`);
    return { pinged: false, error: err.message };
  }
}

module.exports = {
  assessRecCapacity,
  canEmitRec,
  shouldSentinelRun,
  markSentinelRun,
  checkRedStateAging,
  findLikelyDuplicate,
  computePatternHash,
  DEFAULT_CONFIG
};
