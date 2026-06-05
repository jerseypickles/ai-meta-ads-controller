// ═══════════════════════════════════════════════════════════════════════════════
// DEMAND FORECAST — Pilar 2 de "Zeus con esteroides" (2026-06-05).
// Predice la demanda (revenue Shopify) próximos 7/30/90d desde la serie diaria real
// (DemeterSnapshot.total_sales), con estacionalidad por día-de-semana + tendencia +
// eventos estacionales. Zeus pasa de REACCIONAR a ayer → ANTICIPAR (pre-posicionar
// budget/creativos). Método heurístico transparente (no caja negra): baseline reciente
// × multiplicador DoW × tendencia^semanas. Honesto: es un pronóstico, no una certeza.
// ═══════════════════════════════════════════════════════════════════════════════

const DemeterSnapshot = require('../../db/models/DemeterSnapshot');
const DemandForecast = require('../../db/models/DemandForecast');
const logger = require('../../utils/logger');

const HISTORY_DAYS = 90;       // ventana de historia para el modelo
const TREND_CLAMP = 0.15;      // ±15% semanal máx (evita proyecciones explosivas por ruido)
const DOW_NAMES = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

function dowOf(dateEt) { return new Date(dateEt + 'T12:00:00Z').getUTCDay(); }

/** Computa el forecast y persiste un snapshot. */
async function computeDemandForecast() {
  const snaps = await DemeterSnapshot.find({})
    .sort({ date_et: -1 }).limit(HISTORY_DAYS)
    .select('date_et total_sales orders_count').lean();
  // serie ascendente, solo días con venta real (descarta días basura/recovery a $0)
  const series = snaps
    .map(s => ({ date: s.date_et, rev: s.total_sales || 0, orders: s.orders_count || 0 }))
    .filter(s => s.rev > 0)
    .reverse();
  if (series.length < 14) { logger.warn(`[DEMAND-FORECAST] poca data (${series.length}d) — skip`); return null; }

  const n = series.length;
  const overallAvg = series.reduce((s, d) => s + d.rev, 0) / n;

  // ── Multiplicadores por día de semana ──
  const dowAgg = {};
  for (const d of series) {
    const k = dowOf(d.date);
    (dowAgg[k] = dowAgg[k] || { sum: 0, n: 0 });
    dowAgg[k].sum += d.rev; dowAgg[k].n++;
  }
  const dowMult = {};
  for (let i = 0; i < 7; i++) {
    const e = dowAgg[i];
    dowMult[i] = e && e.n ? (e.sum / e.n) / overallAvg : 1;
  }

  // ── Baseline = promedio ponderado reciente (últimos 28d, más peso a lo nuevo) ──
  const recent = series.slice(-28);
  let wSum = 0, wTot = 0;
  recent.forEach((d, i) => { const w = i + 1; wSum += d.rev * w; wTot += w; });
  const baseline = wTot ? wSum / wTot : overallAvg;

  // ── Tendencia: WoW growth (media de ratios de las últimas ~6 semanas), clamp ──
  const weeks = [];
  for (let i = n; i >= 7; i -= 7) weeks.unshift(series.slice(i - 7, i).reduce((s, d) => s + d.rev, 0));
  let gSum = 0, gN = 0;
  for (let i = Math.max(1, weeks.length - 6); i < weeks.length; i++) {
    if (weeks[i - 1] > 0) { gSum += (weeks[i] / weeks[i - 1] - 1); gN++; }
  }
  let weeklyGrowth = gN ? gSum / gN : 0;
  weeklyGrowth = Math.max(-TREND_CLAMP, Math.min(TREND_CLAMP, weeklyGrowth));

  // ── Forecast día a día ──
  const forecastDay = (offset) => {
    const date = new Date(Date.now() + offset * 86400000);
    const day = date.getUTCDay();
    const weeksAhead = offset / 7;
    return Math.max(0, baseline * (dowMult[day] || 1) * Math.pow(1 + weeklyGrowth, weeksAhead));
  };
  let next7 = 0, next30 = 0, next90 = 0;
  const daily14 = [];
  for (let o = 1; o <= 90; o++) {
    const v = forecastDay(o);
    if (o <= 7) next7 += v;
    if (o <= 30) next30 += v;
    next90 += v;
    if (o <= 14) {
      const dt = new Date(Date.now() + o * 86400000);
      daily14.push({ date: dt.toISOString().slice(0, 10), dow: DOW_NAMES[dt.getUTCDay()], rev: Math.round(v) });
    }
  }

  // ── Momentum: últimos 7d reales vs 7d previos ──
  const last7 = series.slice(-7).reduce((s, d) => s + d.rev, 0);
  const prev7 = series.slice(-14, -7).reduce((s, d) => s + d.rev, 0);
  const momentumPct = prev7 > 0 ? +(((last7 / prev7) - 1) * 100).toFixed(1) : 0;

  // ── Día de semana pico / valle ──
  const dowRanked = Object.entries(dowMult).map(([k, v]) => ({ day: DOW_NAMES[k], mult: +v.toFixed(2) }))
    .sort((a, b) => b.mult - a.mult);

  // ── Eventos estacionales próximos (90d) ──
  let events = [];
  try {
    const { getUpcomingEvents } = require('./seasonal-calendar');
    const up = await getUpcomingEvents(90);
    events = (up || []).slice(0, 6).map(e => ({ name: e.name, days_away: e.days_away ?? e.daysAway, phase: e.phase, category: e.category }));
  } catch (_) { /* informativo */ }

  const data = {
    based_on_days: n,
    baseline_daily: Math.round(baseline),
    last_7d_actual: Math.round(last7),
    momentum_pct: momentumPct,
    weekly_growth_pct: +(weeklyGrowth * 100).toFixed(1),
    trend: weeklyGrowth > 0.02 ? 'creciendo' : weeklyGrowth < -0.02 ? 'cayendo' : 'estable',
    forecast: { next_7d: Math.round(next7), next_30d: Math.round(next30), next_90d: Math.round(next90) },
    forecast_vs_last7_pct: last7 > 0 ? +(((next7 / last7) - 1) * 100).toFixed(1) : 0,
    dow_pattern: { peak: dowRanked[0], low: dowRanked[dowRanked.length - 1], all: dowRanked },
    daily_14d: daily14,
    upcoming_events: events,
    note: 'Pronóstico heurístico (baseline reciente × estacionalidad DoW × tendencia). Usar para PRE-POSICIONAR budget/creativos, no como certeza. Escalar antes de los picos (DoW + eventos), no después.'
  };

  try { await DemandForecast.create({ computed_at: new Date(), data }); }
  catch (e) { logger.warn(`[DEMAND-FORECAST] no se pudo persistir: ${e.message}`); }
  logger.info(`[DEMAND-FORECAST] baseline $${Math.round(baseline)}/d · trend ${data.trend} (${data.weekly_growth_pct}%/sem) · next7 $${Math.round(next7)} · pico ${dowRanked[0]?.day}`);
  return data;
}

async function getLatestDemandForecast() {
  const doc = await DemandForecast.findOne({}).sort({ computed_at: -1 }).lean();
  return doc ? { ...doc.data, computed_at: doc.computed_at } : null;
}

module.exports = { computeDemandForecast, getLatestDemandForecast };
