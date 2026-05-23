/**
 * action-verdict.js — destila los snapshots before→after de un ActionLog en un
 * VEREDICTO por acción (positive/negative/neutral) + deltas %. Cierra el loop de
 * aprendizaje: hasta ahora `follow_up_verdict`/`follow_up_deltas` nunca se escribían
 * (0/1217), así que ningún agente conocía su win-rate pese a que Impact Measurement
 * ya capturaba metrics_at_execution + metrics_after_1d/3d/7d.
 *
 * v1: juicio entity-relative (delta del ROAS propio), consciente del tipo de acción.
 * No ajusta por drift de cuenta (no se guarda baseline de cuenta por acción) — eso es
 * v2. Para pauses usa las métricas del PADRE (jobMeasureImpact ya las sustituye en
 * acciones a nivel ad). Para duplicaciones/creaciones devuelve neutral (requiere
 * tracking de la entidad nueva, v2).
 *
 * Lo consume jobMeasureImpact (index.js) en el checkpoint de 7d.
 */

// Delta porcentual robusto (1 decimal). null si no hay base comparable.
function pctDelta(before, after) {
  if (before == null || after == null) return null;
  if (before === 0) return after === 0 ? 0 : (after > 0 ? 100 : -100);
  return Math.round(((after - before) / Math.abs(before)) * 1000) / 10;
}

// follow_up_deltas: % de cambio en ROAS y CPA para cada ventana disponible.
function computeDeltas(action) {
  const be = action.metrics_at_execution || {};
  const d = {};
  for (const suffix of ['1d', '3d', '7d']) {
    const af = action[`metrics_after_${suffix}`];
    if (af && (af.roas_7d != null || af.cpa_7d != null)) {
      d[`roas_pct_${suffix}`] = pctDelta(be.roas_7d, af.roas_7d);
      d[`cpa_pct_${suffix}`] = pctDelta(be.cpa_7d, af.cpa_7d);
    }
  }
  return d;
}

// Veredicto: usa la ventana más completa (7d, fallback 3d) + el tipo de acción.
function computeVerdict(action) {
  const be = action.metrics_at_execution || {};
  const af = action.metrics_after_7d || action.metrics_after_3d || null;
  if (!af) return 'pending';

  const beRoas = be.roas_7d || 0;
  const afRoas = af.roas_7d || 0;
  const roasDelta = pctDelta(beRoas, afRoas);

  switch (action.action) {
    case 'scale_up': {
      // Subimos budget → queremos eficiencia mantenida y no caer bajo breakeven.
      if (afRoas < 1.0) return 'negative';            // escalamos un money-loser
      if (roasDelta == null) return 'neutral';
      if (roasDelta >= -10) return 'positive';        // aguantó (dip marginal tolerado)
      if (roasDelta <= -30) return 'negative';        // la eficiencia colapsó
      return 'neutral';
    }
    case 'scale_down': {
      // Defensiva: positiva si recuperó tras el corte; negativa solo si cortamos un sano.
      if (beRoas >= 2.5) return 'negative';            // recortamos algo que iba bien
      if (roasDelta != null && roasDelta >= 10) return 'positive';
      return 'neutral';
    }
    case 'pause':
    case 'pause_ad':
    case 'pause_adset':
    case 'update_ad_status': {
      // Matamos un loser → juzgamos por el PADRE (no por la entidad, que va a 0).
      const pBe = action.parent_metrics_at_execution;
      const pAf = action.parent_metrics_after_7d || action.parent_metrics_after_3d;
      if (pBe && pAf) {
        const pd = pctDelta(pBe.roas_7d || 0, pAf.roas_7d || 0);
        if (pd == null) return 'neutral';
        if (pd >= -5) return 'positive';               // el padre aguantó/mejoró sin el loser
        if (pd <= -20) return 'negative';              // el padre cayó → ¿cortamos un contribuyente?
        return 'neutral';
      }
      return 'neutral';                                // adset-level pause sin padre → inconcluso
    }
    case 'reactivate': {
      if (afRoas >= 1.5) return 'positive';
      if (afRoas < 0.5 && (af.spend_7d || 0) > 30) return 'negative';
      return 'neutral';
    }
    default:
      // duplicate_adset, create_ad, create_campaign, move_budget → tracking entidad nueva (v2)
      return 'neutral';
  }
}

function computeFollowUp(action) {
  return {
    follow_up_deltas: computeDeltas(action),
    follow_up_verdict: computeVerdict(action)
  };
}

module.exports = { computeFollowUp, computeDeltas, computeVerdict, pctDelta };
