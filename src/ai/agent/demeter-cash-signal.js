/**
 * demeter-cash-signal.js — señal de cash ROAS a nivel cuenta, derivada de los
 * DemeterSnapshot (reconciliación Shopify ↔ Meta).
 *
 * Demeter solo tiene granularidad cuenta/día (no hay cash ROAS por adset, porque
 * Shopify no atribuye órdenes a adsets). Por eso este helper expone dos cosas:
 *
 *   1. Señal de cuenta (cash_roas 7d/14d, meta_roas, gap, zona, trend).
 *   2. Un "haircut factor" = cash_roas_14d / meta_roas_14d que permite estimar
 *      un cash-adjusted ROAS por adset:  meta_roas_adset × haircut_factor.
 *      Es una aproximación (asume que el ratio cash/meta de la cuenta aplica
 *      proporcionalmente a cada adset), pero usa el único dato de cash real
 *      que tenemos. Se clampea para no propagar ruido extremo.
 *
 * Uso actual: SHADOW. Athena (account-agent) lo consume solo para loguear qué
 * habría decidido un cash-gate, sin cambiar su comportamiento. Ver
 * account-agent.js:handleScaleBudget.
 */

const DemeterSnapshot = require('../../db/models/DemeterSnapshot');

// Umbrales (alineados con la filosofía de scaling cash-ROAS del creador)
const CASH_SCALE_GATE = 2.5;       // cash-adjusted ROAS mínimo para justificar scale_up
const CASH_GOVERNOR_FLOOR = 2.0;   // cash_roas_14d de cuenta debajo de esto → no escalar nada
const CASH_HEALTHY = 2.5;          // por encima → un scale_down de Meta sería discutible
const HAIRCUT_MIN = 0.3;           // clamps para evitar ajustes absurdos por ruido/poca data
const HAIRCUT_MAX = 3.0;
const MIN_SNAPSHOTS = 7;           // días mínimos para una señal 14d confiable

const sum = (arr, k) => arr.reduce((a, s) => a + (s[k] || 0), 0);

/**
 * Lee Demeter y devuelve la señal de cash de la cuenta + el haircut factor.
 * Devuelve { available: false } si no hay data suficiente (el caller debe
 * hacer fail-open: comportarse normal sin la señal).
 */
async function getAccountCashSignal() {
  try {
    const todayEt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
    const since14d = new Date(Date.now() - 14 * 86400000);
    since14d.setUTCHours(0, 0, 0, 0);
    const sinceDateEt = since14d.toISOString().slice(0, 10);

    const snaps = await DemeterSnapshot.find({
      date_et: { $gte: sinceDateEt, $lte: todayEt }
    }).sort({ date_et: -1 }).lean();

    // Filtrar días sin actividad (spend 0) para no diluir los ratios.
    const active = snaps.filter(s => (s.meta_spend || 0) > 0);
    if (active.length < MIN_SNAPSHOTS) {
      return { available: false, reason: `Demeter insuficiente (${active.length}/${MIN_SNAPSHOTS} días con spend)` };
    }

    const last14 = active.slice(0, 14);
    const last7 = active.slice(0, 7);

    const spend14 = sum(last14, 'meta_spend');
    const cashRoas14d = spend14 > 0 ? sum(last14, 'net_for_merchant') / spend14 : 0;
    const metaRoas14d = spend14 > 0 ? sum(last14, 'meta_purchase_value') / spend14 : 0;

    const spend7 = sum(last7, 'meta_spend');
    const cashRoas7d = spend7 > 0 ? sum(last7, 'net_for_merchant') / spend7 : 0;
    const metaRoas7d = spend7 > 0 ? sum(last7, 'meta_purchase_value') / spend7 : 0;
    const gap7d = metaRoas7d > 0 ? ((metaRoas7d - cashRoas7d) / metaRoas7d) * 100 : 0;

    // Trend: 7d actual vs 7d previo
    const prev7 = active.slice(7, 14);
    let trend = 'estable', cashRoasPrev7d = null;
    if (prev7.length >= 4) {
      const ps = sum(prev7, 'meta_spend');
      cashRoasPrev7d = ps > 0 ? sum(prev7, 'net_for_merchant') / ps : 0;
      const delta = cashRoas7d - cashRoasPrev7d;
      if (delta > 0.15) trend = 'mejorando';
      else if (delta < -0.15) trend = 'empeorando';
    }

    // Haircut factor a partir de la ventana 14d (más estable que 7d), clampeado.
    let haircut = metaRoas14d > 0 ? cashRoas14d / metaRoas14d : 1;
    haircut = Math.max(HAIRCUT_MIN, Math.min(HAIRCUT_MAX, haircut));

    let zone, zoneHint;
    if (cashRoas14d >= 3.0) { zone = 'green'; zoneHint = 'cash sano — escalar es defendible'; }
    else if (cashRoas14d >= CASH_HEALTHY) { zone = 'yellow'; zoneHint = 'cash aceptable — escalar con moderación'; }
    else if (cashRoas14d >= CASH_GOVERNOR_FLOOR) { zone = 'orange'; zoneHint = 'cash bajo — preferir hold sobre scale_up'; }
    else { zone = 'red'; zoneHint = 'cash crítico — governor frenaría scale_up'; }

    return {
      available: true,
      cash_roas_14d: +cashRoas14d.toFixed(3),
      meta_roas_14d: +metaRoas14d.toFixed(3),
      cash_roas_7d: +cashRoas7d.toFixed(3),
      meta_roas_7d: +metaRoas7d.toFixed(3),
      gap_pct_7d: +gap7d.toFixed(1),
      haircut_factor: +haircut.toFixed(3),
      zone, zone_hint: zoneHint, trend,
      cash_roas_prev_7d: cashRoasPrev7d != null ? +cashRoasPrev7d.toFixed(3) : null,
      days: active.length,
      governor_blocks_scale: cashRoas14d < CASH_GOVERNOR_FLOOR
    };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

/**
 * Dada la señal de cuenta + el ROAS Meta 7d de un adset y la acción real que
 * tomó el Meta-gate, computa qué habría decidido el cash-gate. SHADOW: no cambia
 * nada, solo describe la (des)coincidencia para análisis retrospectivo.
 *
 * @returns objeto listo para guardar en ActionLog.metadata.shadow_cash_consideration
 */
function buildCashShadow(signal, adsetMetaRoas7d, metaAction) {
  if (!signal || !signal.available) {
    return { mode: 'shadow', available: false, reason: signal?.reason || signal?.error || 'sin señal' };
  }
  const cashAdjRoas = +(adsetMetaRoas7d * signal.haircut_factor).toFixed(3);

  // Recomendación del cash-gate para esta acción
  let cashGate, note;
  if (metaAction === 'scale_up') {
    if (signal.governor_blocks_scale) {
      cashGate = 'hold';
      note = `Governor: cash 14d ${signal.cash_roas_14d}x < ${CASH_GOVERNOR_FLOOR}x → cash habría frenado el scale_up`;
    } else if (cashAdjRoas >= CASH_SCALE_GATE) {
      cashGate = 'scale_up';
      note = `Cash de acuerdo: cash-adj ROAS ${cashAdjRoas}x ≥ ${CASH_SCALE_GATE}x`;
    } else {
      cashGate = 'hold';
      note = `Cash más estricto: cash-adj ROAS ${cashAdjRoas}x < ${CASH_SCALE_GATE}x → cash habría hecho hold`;
    }
  } else if (metaAction === 'scale_down') {
    if (cashAdjRoas >= CASH_HEALTHY) {
      cashGate = 'hold';
      note = `Cash discrepa: cash-adj ROAS ${cashAdjRoas}x ≥ ${CASH_HEALTHY}x → Meta lo subvaluó, cash habría sostenido`;
    } else {
      cashGate = 'scale_down';
      note = `Cash de acuerdo con el scale_down (cash-adj ROAS ${cashAdjRoas}x bajo)`;
    }
  } else {
    cashGate = metaAction;
    note = 'acción no evaluada por cash-gate';
  }

  return {
    mode: 'shadow',
    available: true,
    evaluated_at: new Date(),
    account_cash_roas_14d: signal.cash_roas_14d,
    account_meta_roas_14d: signal.meta_roas_14d,
    haircut_factor: signal.haircut_factor,
    zone: signal.zone,
    trend: signal.trend,
    adset_meta_roas_7d: +(+adsetMetaRoas7d).toFixed(3),
    adset_cash_adjusted_roas: cashAdjRoas,
    meta_gate: metaAction,
    cash_gate: cashGate,
    agree: cashGate === metaAction,
    note
  };
}

module.exports = {
  getAccountCashSignal,
  buildCashShadow,
  CASH_SCALE_GATE,
  CASH_GOVERNOR_FLOOR,
  CASH_HEALTHY
};
