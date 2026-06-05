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
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Computa el forecast y persiste un snapshot. */
async function computeDemandForecast() {
  const snaps = await DemeterSnapshot.find({})
    .sort({ date_et: -1 }).limit(HISTORY_DAYS)
    .select('date_et total_sales orders_count').lean();
  // serie ascendente, solo días con venta real (descarta días a $0)
  let series = snaps
    .map(s => ({ date: s.date_et, rev: s.total_sales || 0, orders: s.orders_count || 0 }))
    .filter(s => s.rev > 0)
    .reverse();
  if (series.length < 14) { logger.warn(`[DEMAND-FORECAST] poca data (${series.length}d) — skip`); return null; }

  // Excluir días INCOMPLETOS: el snapshot del día EN CURSO es parcial (casi $0, ej. $48/1
  // orden a media tarde) y envenena momentum/trend. Filtro robusto: descarta lo claramente
  // incompleto (< 15% de la mediana) — un día real flojo (ej. martes lento) SÍ se conserva.
  const medRev = median(series.map(s => s.rev));
  const dropped = series.filter(s => s.rev < 0.15 * medRev);
  series = series.filter(s => s.rev >= 0.15 * medRev);
  if (dropped.length) logger.info(`[DEMAND-FORECAST] descarto ${dropped.length} día(s) incompleto(s): ${dropped.map(d => `${d.date}($${Math.round(d.rev)})`).join(', ')}`);
  if (series.length < 14) { logger.warn(`[DEMAND-FORECAST] poca data tras filtro (${series.length}d) — skip`); return null; }

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

  // ── Tendencia: regresión lineal sobre los últimos 14 días limpios → growth semanal.
  // CLAVE (honestidad): con un quiebre estructural reciente (ej. el hack del 27-may: la
  // serie cae de $13k a $3k y se recupera) NINGUNA tendencia es confiable. Por eso medimos
  // también la VOLATILIDAD (coef. de variación) y, si es alta, reportamos baja confianza en
  // vez de un "cayendo" engañoso. Se auto-normaliza cuando el quiebre sale de la ventana. ──
  const trendWin = series.slice(-Math.min(14, n));
  const tn = trendWin.length;
  const xMean = (tn - 1) / 2;
  const yMean = trendWin.reduce((s, d) => s + d.rev, 0) / tn;
  let num = 0, den = 0, varSum = 0;
  trendWin.forEach((d, i) => { num += (i - xMean) * (d.rev - yMean); den += (i - xMean) ** 2; varSum += (d.rev - yMean) ** 2; });
  const slopePerDay = den ? num / den : 0; // $/día
  let weeklyGrowth = yMean > 0 ? (slopePerDay * 7) / yMean : 0;
  weeklyGrowth = Math.max(-TREND_CLAMP, Math.min(TREND_CLAMP, weeklyGrowth));
  const cv = yMean > 0 ? Math.sqrt(varSum / tn) / yMean : 0; // coef. de variación
  const volatile = cv > 0.35; // serie muy volátil → tendencia poco confiable (ej. quiebre)
  const trendConfidence = volatile ? 'baja' : 'normal';

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
    trend: volatile ? 'volátil (quiebre/recuperación reciente)' : (weeklyGrowth > 0.02 ? 'creciendo' : weeklyGrowth < -0.02 ? 'cayendo' : 'estable'),
    trend_confidence: trendConfidence,
    volatility_cv: +cv.toFixed(2),
    forecast: { next_7d: Math.round(next7), next_30d: Math.round(next30), next_90d: Math.round(next90) },
    forecast_vs_last7_pct: last7 > 0 ? +(((next7 / last7) - 1) * 100).toFixed(1) : 0,
    dow_pattern: { peak: dowRanked[0], low: dowRanked[dowRanked.length - 1], all: dowRanked },
    daily_14d: daily14,
    upcoming_events: events,
    note: (volatile
      ? 'OJO: trend_confidence BAJA — la serie está muy volátil (quiebre/recuperación reciente, ej. post-hack). NO confiar en el número de tendencia; guiarse por la trayectoria reciente (los daily_14d y last_7d) y los eventos. '
      : '') +
      'Pronóstico heurístico (baseline reciente × estacionalidad DoW × tendencia). Usar para PRE-POSICIONAR budget/creativos, no como certeza. Escalar ANTES de los picos (DoW + eventos), no después.'
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
