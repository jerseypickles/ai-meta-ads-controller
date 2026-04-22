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

  const issues = [];

  // ═══ Check 1: Portfolio freeze ═══
  // Avg 7d > $100/día y hoy <15% del avg → muy probable freeze
  if (avgDailySpend > 100 && totalSpendToday < avgDailySpend * 0.15) {
    issues.push({
      kind: 'portfolio_freeze',
      severity: 'critical',
      detail: `Portfolio spend today $${Math.round(totalSpendToday)} vs avg 7d $${Math.round(avgDailySpend)}/día — posible billing freeze o auth issue con Meta`,
      metrics: {
        spend_today: Math.round(totalSpendToday),
        avg_daily_7d: Math.round(avgDailySpend),
        ratio: totalSpendToday > 0 ? +(totalSpendToday / avgDailySpend).toFixed(3) : 0
      }
    });
  }

  // ═══ Check 2: Mass non-delivery ═══
  // Ad sets que 7d>$50 y hoy no gastan nada
  const notDelivering = active.filter(a =>
    (a.metrics?.today?.spend || 0) < 0.5 &&
    (a.metrics?.last_7d?.spend || 0) > 50 &&
    (a.daily_budget || 0) > 0
  );
  if (notDelivering.length >= 5) {
    issues.push({
      kind: 'mass_non_delivery',
      severity: notDelivering.length >= 10 ? 'critical' : 'high',
      detail: `${notDelivering.length} ad sets activos no gastaron nada hoy (últimos 7d > $50 cada uno)`,
      entities: notDelivering.slice(0, 8).map(a => ({
        name: a.entity_name,
        id: a.entity_id,
        spend_7d: Math.round(a.metrics?.last_7d?.spend || 0),
        daily_budget: a.daily_budget
      }))
    });
  }

  // ═══ Check 3: Individual big drops (>90% drop hoy vs avg diario 7d) ═══
  // Antes comparaba contra last_1d (inexistente → siempre 0 → check nunca disparó).
  // Ahora: spend hoy < 10% del avg diario de los últimos 7d, con baseline sustancial.
  const bigDrops = active.filter(a => {
    const today = a.metrics?.today?.spend || 0;
    const avg7d = (a.metrics?.last_7d?.spend || 0) / 7;
    return avg7d > 30 && today < avg7d * 0.1;
  });
  if (bigDrops.length >= 3) {
    issues.push({
      kind: 'delivery_drop',
      severity: bigDrops.length >= 8 ? 'high' : 'medium',
      detail: `${bigDrops.length} ad sets con >90% drop en spend hoy vs avg diario 7d`,
      entities: bigDrops.slice(0, 5).map(a => ({
        name: a.entity_name,
        id: a.entity_id,
        avg_daily_7d: Math.round((a.metrics?.last_7d?.spend || 0) / 7),
        spend_today: Math.round(a.metrics?.today?.spend || 0)
      }))
    });
  }

  // ═══ Check 4: Zero impressions while budget active ═══
  const zeroImpressions = active.filter(a =>
    (a.metrics?.today?.impressions || 0) === 0 &&
    (a.daily_budget || 0) > 0 &&
    (a.metrics?.last_7d?.impressions || 0) > 1000
  );
  if (zeroImpressions.length >= 5) {
    issues.push({
      kind: 'zero_impressions_active',
      severity: 'high',
      detail: `${zeroImpressions.length} ad sets activos con budget pero 0 impressions hoy`,
      entities: zeroImpressions.slice(0, 5).map(a => ({
        name: a.entity_name,
        id: a.entity_id,
        daily_budget: a.daily_budget
      }))
    });
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

  return {
    status,
    summary: {
      active_adsets: active.length,
      spend_today: Math.round(totalSpendToday),
      spend_yesterday: Math.round(totalSpend1d),
      avg_daily_7d: Math.round(avgDailySpend),
      impressions_today: totalImpressionsToday,
      impressions_yesterday: totalImpressions1d
    },
    issues,
    issues_count: issues.length,
    checked_at: new Date().toISOString()
  };
}

module.exports = { checkDeliveryHealth };
