/**
 * Delivery Health Check — detecta anomalías operacionales que suelen pasar
 * desapercibidas: billing freeze, campañas que no gastan, drops de delivery,
 * errores de Meta API, policy violations, etc.
 *
 * Se usa de dos formas:
 * 1. En el proactive cron (cada 30min) para alertar sin que pregunten
 * 2. Como tool de Zeus (query_delivery_health) para on-demand
 */

const SafetyEvent = require('../../db/models/SafetyEvent');
const BrainInsight = require('../../db/models/BrainInsight');
const { getLatestSnapshots } = require('../../db/queries');

/**
 * Fracción del día transcurrida en ET (0.0 = medianoche, 1.0 = 23:59:59).
 * Usada para pacing proportional — evita falsos positivos de "spend bajo"
 * cuando el día recién empezó.
 *
 * Fix 2026-04-23: los checks de freeze + mass_non_delivery comparaban contra
 * avgDailySpend completo sin normalizar por hora del día. A las 00:38 ET con
 * avg $4453/d, el threshold "spend < 15% del avg" dispara con $136 (esperado
 * $4453 * 0.027 = $120 a esa hora). Alarmaba por diseño madrugadas enteras.
 */
function dayFractionElapsedET() {
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const startOfDayET = new Date(nowET);
  startOfDayET.setHours(0, 0, 0, 0);
  const msElapsed = nowET.getTime() - startOfDayET.getTime();
  return Math.max(0, Math.min(1, msElapsed / (24 * 3600 * 1000)));
}

/**
 * Chequeo completo de salud de entrega. Retorna reporte estructurado.
 */
async function checkDeliveryHealth() {
  const now = Date.now();
  const snapshots = await getLatestSnapshots('adset');
  const active = snapshots.filter(s => s.status === 'ACTIVE');

  if (active.length === 0) {
    return { status: 'unknown', issues: [], detail: 'sin ad sets activos' };
  }

  // Agregados
  // NOTA: 'last_1d' NO existe en el schema (solo today/last_3d/last_7d/last_14d/last_30d).
  // Fijado 2026-04-21: se usaba last_1d como proxy de "ayer" que siempre retornaba 0 silencioso.
  const totalSpendToday = active.reduce((s, a) => s + (a.metrics?.today?.spend || 0), 0);
  const totalSpend7d = active.reduce((s, a) => s + (a.metrics?.last_7d?.spend || 0), 0);
  const avgDailySpend = totalSpend7d / 7;
  const totalImpressionsToday = active.reduce((s, a) => s + (a.metrics?.today?.impressions || 0), 0);

  // Pacing proporcional — cuánto se debería haber gastado a esta hora.
  // Distribución lineal como aproximación simple. La distribución real
  // en Meta no es uniforme (picos en horarios activos) pero lineal es
  // conservadora: si con asunción lineal ya no alarmamos, con la curva
  // real tampoco deberíamos. Mejor falso negativo suave que falso positivo.
  const dayFraction = dayFractionElapsedET();
  const expectedSpendByNow = avgDailySpend * dayFraction;
  const pacingRatio = expectedSpendByNow > 0 ? totalSpendToday / expectedSpendByNow : 0;

  // Min time skip: antes de las 1h ET (madrugada profunda) no chequeamos
  // pacing porque Meta puede no haber arrancado bidding activo todavía y
  // la normalización proporcional amplifica ruido.
  const tooEarlyForPacingCheck = dayFraction < (1 / 24); // <1h del día

  const issues = [];

  // ═══ Check 1: Portfolio freeze — NORMALIZADO POR HORA ═══
  // Antes: dispara si spend < 15% del avg diario. Falso positivo sistemático
  // madrugadas (avg se compara contra spend parcial del día en curso).
  // Ahora: dispara si spend < 40% del spend ESPERADO por pacing proporcional.
  // Skip si es muy temprano (<1h del día ET) — el ruido domina.
  if (!tooEarlyForPacingCheck && avgDailySpend > 100 && pacingRatio < 0.4) {
    issues.push({
      kind: 'portfolio_freeze',
      severity: 'critical',
      detail: `Portfolio spend today $${Math.round(totalSpendToday)} vs esperado $${Math.round(expectedSpendByNow)} a esta hora (${Math.round(dayFraction * 100)}% del día transcurrido) — posible billing freeze o auth issue con Meta`,
      metrics: {
        spend_today: Math.round(totalSpendToday),
        expected_by_now: Math.round(expectedSpendByNow),
        avg_daily_7d: Math.round(avgDailySpend),
        day_fraction: +dayFraction.toFixed(3),
        pacing_ratio: +pacingRatio.toFixed(3)
      }
    });
  }

  // ═══ Check 2: Mass non-delivery — NORMALIZADO POR HORA ═══
  // Antes: adsets con today.spend < $0.5 y 7d > $50. Falso positivo en
  // madrugada (Meta aún no distribuyó spend en todos los adsets).
  // Ahora: el threshold de "no gastó nada" se relaja con el día — si el
  // día está al 10%, un adset con $0.50 gastado ya está pacing OK.
  // Skip el check entero si día < 3h transcurridas (ruido domina).
  const minDayFractionForNonDelivery = 3 / 24; // 3 horas ET
  if (dayFraction >= minDayFractionForNonDelivery) {
    // Umbral dinámico: un adset con daily_budget B debería haber gastado
    // ~B * dayFraction por esta hora. Si gastó <30% de eso → non-delivery.
    const notDelivering = active.filter(a => {
      const dailyBudget = a.daily_budget || 0;
      const spendToday = a.metrics?.today?.spend || 0;
      const spend7d = a.metrics?.last_7d?.spend || 0;
      if (dailyBudget <= 0 || spend7d <= 50) return false;
      const expectedByNow = dailyBudget * dayFraction;
      return spendToday < expectedByNow * 0.3;
    });
    if (notDelivering.length >= 5) {
      issues.push({
        kind: 'mass_non_delivery',
        severity: notDelivering.length >= 10 ? 'critical' : 'high',
        detail: `${notDelivering.length} ad sets activos gastando <30% del pacing esperado (día ${Math.round(dayFraction * 100)}% transcurrido)`,
        entities: notDelivering.slice(0, 8).map(a => ({
          name: a.entity_name,
          id: a.entity_id,
          spend_today: Math.round((a.metrics?.today?.spend || 0) * 100) / 100,
          spend_7d: Math.round(a.metrics?.last_7d?.spend || 0),
          daily_budget: a.daily_budget,
          expected_by_now: Math.round(((a.daily_budget || 0) * dayFraction) * 100) / 100
        }))
      });
    }
  }

  // ═══ Check 3: Individual big drops — NORMALIZADO POR HORA ═══
  // Antes: today < (avg7d/7) * 0.1 → falso positivo sistemático en madrugada.
  // Ahora: today < expected_by_now * 0.1 donde expected_by_now = (avg7d/7) * dayFraction.
  // Skip si día < 3h (ruido domina).
  let bigDrops = [];
  if (dayFraction >= minDayFractionForNonDelivery) {
    bigDrops = active.filter(a => {
      const today = a.metrics?.today?.spend || 0;
      const avgDailyPerEntity = (a.metrics?.last_7d?.spend || 0) / 7;
      if (avgDailyPerEntity <= 30) return false;
      const expectedByNow = avgDailyPerEntity * dayFraction;
      return today < expectedByNow * 0.1;
    });
    if (bigDrops.length >= 3) {
      issues.push({
        kind: 'delivery_drop',
        severity: bigDrops.length >= 8 ? 'high' : 'medium',
        detail: `${bigDrops.length} ad sets con >90% drop en spend hoy vs pacing esperado (día ${Math.round(dayFraction * 100)}% transcurrido)`,
        entities: bigDrops.slice(0, 5).map(a => {
          const avgDaily = (a.metrics?.last_7d?.spend || 0) / 7;
          return {
            name: a.entity_name,
            id: a.entity_id,
            avg_daily_7d: Math.round(avgDaily),
            expected_by_now: Math.round(avgDaily * dayFraction * 100) / 100,
            spend_today: Math.round((a.metrics?.today?.spend || 0) * 100) / 100
          };
        })
      });
    }
  }

  // ═══ Check 4: Zero impressions while budget active — GATED POR HORA ═══
  // En madrugada profunda (<3h) Meta puede no haber arrancado impressions
  // todavía para todos los adsets. Esperar fuera de ese ruido para alarmar.
  let zeroImpressions = [];
  if (dayFraction >= minDayFractionForNonDelivery) {
    zeroImpressions = active.filter(a =>
      (a.metrics?.today?.impressions || 0) === 0 &&
      (a.daily_budget || 0) > 0 &&
      (a.metrics?.last_7d?.impressions || 0) > 1000
    );
    if (zeroImpressions.length >= 5) {
      issues.push({
        kind: 'zero_impressions_active',
        severity: 'high',
        detail: `${zeroImpressions.length} ad sets activos con budget pero 0 impressions hoy (día ${Math.round(dayFraction * 100)}% transcurrido)`,
        entities: zeroImpressions.slice(0, 5).map(a => ({
          name: a.entity_name,
          id: a.entity_id,
          daily_budget: a.daily_budget
        }))
      });
    }
  }

  // ═══ Check 5: Recent safety events críticos ═══
  const recentCritical = await SafetyEvent.find({
    created_at: { $gte: new Date(now - 4 * 3600000) },
    severity: { $in: ['critical', 'high'] }
  }).sort({ created_at: -1 }).limit(5).lean();
  for (const ev of recentCritical) {
    issues.push({
      kind: 'safety_event',
      severity: ev.severity,
      detail: `${ev.event_type}${ev.entity_name ? ` en ${ev.entity_name}` : ''}: ${(ev.reason || '').substring(0, 200)}`,
      event_type: ev.event_type,
      created_at: ev.created_at
    });
  }

  // ═══ Check 6: Anomalías críticas de BrainInsight ═══
  // Fix 2026-04-22 (rec Zeus): payload anterior tenía anomaly_type:a.insight_type, que
  // siempre era 'anomaly' (la query filtra por eso). Ahora propagamos el subtipo real
  // (diagnosis: CREATIVE_FATIGUE / FUNNEL_LEAK / AUDIENCE_SATURATED / etc), data points
  // numéricos, y entity context — para que Athena pueda discriminar respuesta sin
  // tool calls extras.
  const recentAnomalies = await BrainInsight.find({
    insight_type: 'anomaly',
    severity: { $in: ['critical', 'high'] },
    created_at: { $gte: new Date(now - 2 * 3600000) }
  }).limit(5).lean();
  for (const a of recentAnomalies) {
    const firstEntity = (Array.isArray(a.entities) && a.entities[0]) || {};
    const entityName = a.entity_name || firstEntity.entity_name || null;
    issues.push({
      kind: 'anomaly',
      severity: a.severity,
      detail: `${a.title}${entityName ? ` — ${entityName}` : ''}`,
      // Subtipo real (diagnosis): CREATIVE_FATIGUE, FUNNEL_LEAK, AUDIENCE_SATURATED, etc.
      // Reemplaza el anterior anomaly_type:'anomaly' que era redundante.
      anomaly_subtype: a.diagnosis || null,
      // Snapshot métrico bruto del momento de detección
      metric_snapshot: a.data_points || null,
      // Análisis del Brain (truncado para no inflar payload)
      analysis: (a.body || '').substring(0, 400),
      entity_id: firstEntity.entity_id || null,
      entity_type: firstEntity.entity_type || null,
      insight_id: a._id
    });
  }

  // Status general
  let status = 'healthy';
  if (issues.some(i => i.severity === 'critical')) status = 'critical';
  else if (issues.some(i => i.severity === 'high')) status = 'degraded';
  else if (issues.length > 0) status = 'watch';

  // Nota: spend_yesterday/impressions_yesterday no se exponen porque el schema
  // no tiene ventana "ayer" (solo today/3d/7d/14d/30d). Antes estas líneas
  // referenciaban totalSpend1d e totalImpressions1d — variables nunca definidas
  // que causaban ReferenceError al ejecutar query_delivery_health.
  // Fijado 2026-04-23. Si se necesita "ayer" en el futuro, implementar via
  // query a MetricSnapshot histórico buscando el último snapshot del día D-1.
  return {
    status,
    summary: {
      active_adsets: active.length,
      spend_today: Math.round(totalSpendToday),
      avg_daily_7d: Math.round(avgDailySpend),
      impressions_today: totalImpressionsToday,
      // Pacing context — necesario para que Zeus NO interprete "spend bajo
      // temprano en el día" como anomalía. Este campo lo calibra.
      day_fraction_elapsed_et: +dayFraction.toFixed(3),
      expected_spend_by_now: Math.round(expectedSpendByNow),
      pacing_ratio: +pacingRatio.toFixed(3),   // 1.0 = exactamente pacing esperado
      pacing_context: tooEarlyForPacingCheck
        ? 'day_too_early_skip_checks'
        : pacingRatio >= 0.8 ? 'on_pace'
        : pacingRatio >= 0.4 ? 'below_expected_but_normal_variance'
        : 'significantly_below_expected'
    },
    issues,
    issues_count: issues.length,
    checked_at: new Date().toISOString()
  };
}

module.exports = { checkDeliveryHealth };
