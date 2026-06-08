// ═══════════════════════════════════════════════════════════════════════════════
// athena-marginal.js — ROAS MARGINAL: la frontera eficiente de escalamiento.
//
// El problema que resuelve: cuando escalás un adset, el dinero NUEVO convierte PEOR
// que el viejo (rendimientos decrecientes). Pero el ROAS 7d (viejo+nuevo mezclado)
// sigue alto un rato → Athena seguía escalando sobre una señal retrasada hasta que
// rompía. El ROAS MARGINAL aísla el rendimiento del budget INCREMENTAL del último
// scale → revela el techo REAL del adset ANTES de quemarlo.
//
//   marginal = (B1·R1 − B0·R0) / (B1 − B0)
//   (B = budget diario, R = ROAS; 0 = antes del scale, 1 = después)
//
// Ej: $20@5x → $30@4x. Mezclado 4x se ve bien (>3x), pero marginal = (120−100)/10 =
// 2.0x → el dólar nuevo rindió a 2x. Estás pasado de la frontera y el 7d no lo dice.
// ═══════════════════════════════════════════════════════════════════════════════

const ActionLog = require('../../db/models/ActionLog');
const logger = require('../../utils/logger');

const TARGET_ROAS = 3.0;   // KPI target (cash-adj)
const MIN_ROAS = 1.5;      // KPI mínimo — bajo esto el dólar nuevo no vale

/**
 * ROAS marginal del último scale_up MEDIDO del adset (cash-adjusted).
 * @returns {{marginal, B0, B1, R0, R1, days_ago}|null}
 */
async function computeMarginal(adsetId, cashHaircut = 1) {
  const last = await ActionLog.findOne({
    entity_id: adsetId, action: 'scale_up', impact_measured: true // tiene metrics_after_3d
  }).sort({ executed_at: -1 }).lean();
  if (!last) return null;

  const B0 = last.before_value || 0, B1 = last.after_value || 0;
  if (B1 <= B0) return null; // no fue un scale up real

  const R0 = (last.metrics_at_execution?.roas_7d || 0) * cashHaircut;
  const af = last.metrics_after_3d || {};
  const R1 = (af.roas_3d || af.roas_7d || 0) * cashHaircut; // post-scale (3d = más limpio)
  if (R0 <= 0 || R1 <= 0) return null;

  const marginal = (B1 * R1 - B0 * R0) / (B1 - B0);
  // CONFIABILIDAD: el ROAS post-scale sobre <2 compras es ruido (igual que el cold-start
  // del pixel que daba falsos negativos en el verdict). Sin compras suficientes, el marginal
  // es preliminar → se MUESTRA al LLM como contexto, pero NO dispara el gate determinístico.
  const afPurch = af.purchases_7d || 0;
  const reliable = afPurch >= 2;
  return {
    marginal: +marginal.toFixed(2),
    B0, B1, R0: +R0.toFixed(2), R1: +R1.toFixed(2), reliable, after_purchases: afPurch,
    days_ago: Math.round((Date.now() - new Date(last.executed_at).getTime()) / 86400000)
  };
}

// Clasifica el marginal en una zona de decisión.
function classify(marginal, target = TARGET_ROAS) {
  if (marginal >= target * 1.15) return { zone: 'deep', label: 'HEADROOM PROFUNDO', guide: 'el dólar nuevo rinde MUY por encima del target → ESCALÁ FUERTE (+25-30%), hay mucho espacio.' };
  if (marginal >= target) return { zone: 'healthy', label: 'EFICIENTE', guide: 'el budget nuevo rinde al target → seguí escalando con confianza (+20%).' };
  if (marginal >= MIN_ROAS) return { zone: 'frontier', label: 'CERCA DE LA FRONTERA', guide: 'rendimientos decrecientes: el dólar nuevo rinde bajo el target. Escalá CHICO (+10%) o MANTENÉ — estás cerca del techo de este adset.' };
  return { zone: 'over', label: 'SOBRE-ESCALADO', guide: 'el budget nuevo casi no convierte → NO escales más. Mantené o bajá. Llegaste al techo.' };
}

/**
 * Contexto para el prompt + un gate determinístico (si está sobre-escalado).
 * @returns {{context:string, gate:string|null, marginal:number|null, zone:string|null}}
 */
async function getMarginalSignal(adSetSnap, cashHaircut = 1) {
  try {
    const m = await computeMarginal(adSetSnap.entity_id, cashHaircut);
    if (!m) return { context: '', gate: null, marginal: null, zone: null };
    const c = classify(m.marginal);
    const prelim = m.reliable ? '' : ` (PRELIMINAR — solo ${m.after_purchases} compras post-scale, poca señal; pesalo suave)`;
    const context = `\n\n## ROAS MARGINAL (último scale hace ${m.days_ago}d: $${m.B0}→$${m.B1}, ROAS ${m.R0}x→${m.R1}x)\n` +
      `El budget NUEVO convirtió a ${m.marginal}x cash-adj → ${c.label}${prelim}. ${c.guide}\n` +
      `CLAVE: decidí si SEGUIR escalando por el ROAS MARGINAL (¿el dólar nuevo todavía rinde?), NO por el ROAS 7d mezclado (que es retrasado y te hace escalar de más).`;
    // Gate determinístico SOLO si es confiable (≥2 compras post-scale) — si no, es ruido
    // del cold-start y bloquearía falso (la lección del verdict). Preliminar → solo contexto.
    const gate = (c.zone === 'over' && m.reliable)
      ? `frontera marginal: el último scale rindió ${m.marginal}x marginal cash-adj (<${MIN_ROAS}x, ${m.after_purchases} compras) — este adset llegó a su techo de escalamiento. Mantené, no escales más.`
      : null;
    return { context, gate, marginal: m.marginal, zone: c.zone, reliable: m.reliable };
  } catch (e) {
    logger.warn(`[ATHENA-MARGINAL] ${adSetSnap.entity_id}: ${e.message}`);
    return { context: '', gate: null, marginal: null, zone: null };
  }
}

module.exports = { computeMarginal, classify, getMarginalSignal, TARGET_ROAS, MIN_ROAS };
