/**
 * ares-scale-gate.js — gate de cordura para los scale_up de CBO de Ares.
 *
 * Da "sentido entre cada scale": cada scale debe poder medirse y la ROAS aguantar
 * antes del próximo. Lo invoca `validateSafetyGates` (ares-portfolio-manager), que
 * usan AMBOS ejecutores de scale (Ares Brain vía portfolioHelpers + Ares Portfolio),
 * así que un solo punto cubre los dos paths.
 *
 * 3 checks (solo aplican a scale_up de CBO):
 *   1. Cooldown por-CBO 48h (cross-agent) — antes los layers se pisaban: el brain
 *      tenía dedup 24h propio, el portfolio cooldown 36h, pero no unificado a 48h.
 *      Sin esto no podés saber si un scale funcionó: ya escalaste de nuevo.
 *   2. Degradación marginal — si la ROAS 3d cae bajo la 7d Y se acerca al target,
 *      frenar: cada escalón estaría comprimiendo eficiencia hacia el piso.
 *   3. Fatiga del favorito — al escalar una CBO concentrada, el budget va al adset
 *      favorito; si ya está saturado (freq alta), escalar empeora.
 *
 * Fail-open: sin CBOHealthSnapshot no bloquea (los demás gates igual corren).
 */

const ActionLog = require('../../db/models/ActionLog');
const CBOHealthSnapshot = require('../../db/models/CBOHealthSnapshot');

const CBO_SCALE_COOLDOWN_H = 48;
const ROAS_TARGET = 3.0;
const MARGINAL_FLOOR_MULT = 1.5;   // freno marginal si roas_7d < target*1.5 (4.5x)
const MARGINAL_DECLINE = 0.95;     // ...Y roas_3d < roas_7d*0.95 (caída ≥5% reciente)
const FREQ_CRITICAL = 4.0;         // fatiga crítica del adset favorito

/**
 * @param {string} campaignId
 * @returns {Promise<{allow:boolean, reason?:string}>}
 */
async function checkCBOScaleSanity(campaignId) {
  if (!campaignId) return { allow: true };

  // 1. Cooldown por-CBO 48h (cualquier agente, solo scales exitosos)
  const since = new Date(Date.now() - CBO_SCALE_COOLDOWN_H * 3600000);
  const recent = await ActionLog.findOne({
    entity_id: campaignId,
    action: 'scale_up',
    success: true,
    executed_at: { $gte: since }
  }).sort({ executed_at: -1 }).lean();
  if (recent) {
    const hAgo = Math.round((Date.now() - new Date(recent.executed_at).getTime()) / 3600000);
    return { allow: false, reason: `cooldown CBO: último scale_up hace ${hAgo}h (<${CBO_SCALE_COOLDOWN_H}h) — esperar a medir antes de re-escalar` };
  }

  // Snapshot para marginal + fatiga
  const snap = await CBOHealthSnapshot.findOne({ campaign_id: campaignId })
    .sort({ snapshot_at: -1 }).lean();
  if (!snap) return { allow: true }; // fail-open: sin data no bloquea

  // 2. Degradación marginal — ROAS 3d cae ≥5% bajo 7d Y acercándose al target
  const r3 = snap.cbo_roas_3d || 0;
  const r7 = snap.cbo_roas_7d || 0;
  if (r7 > 0 && r3 > 0 && r3 < r7 * MARGINAL_DECLINE && r7 < ROAS_TARGET * MARGINAL_FLOOR_MULT) {
    return {
      allow: false,
      reason: `degradación marginal: ROAS 3d ${r3.toFixed(2)}x < 7d ${r7.toFixed(2)}x y a ${(r7 / ROAS_TARGET).toFixed(1)}x del target — comprimiendo hacia el piso, no re-escalar`
    };
  }

  // 3. Fatiga del favorito (donde se concentra el budget al escalar)
  const freq = snap.favorite_freq || 0;
  if (freq >= FREQ_CRITICAL) {
    return {
      allow: false,
      reason: `fatiga: adset favorito "${snap.favorite_adset_name || ''}" freq ${freq.toFixed(1)} ≥ ${FREQ_CRITICAL} — escalar empeoraría la saturación`
    };
  }

  return { allow: true };
}

module.exports = { checkCBOScaleSanity, CBO_SCALE_COOLDOWN_H };
