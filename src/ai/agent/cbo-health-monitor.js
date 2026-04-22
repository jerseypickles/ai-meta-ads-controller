/**
 * cbo-health-monitor.js — Observabilidad de CBOs como unidad.
 *
 * Ares hoy es un duplicador ciego: razona sobre adsets individuales pero
 * nunca sobre la CBO como unidad. Este monitor corrige ese ángulo ciego
 * generando un snapshot cada 2h por CBO con: concentración, favorito,
 * starvation, trend de ROAS y señales compuestas de colapso.
 *
 * Corre vía cron propio (no atado a ares-agent) para mantener muestreo
 * denso independiente del ciclo de Ares. Fase 1: solo observa, no decide.
 *
 * Data source: MetricSnapshot (entity_type='adset' con parent_campaign_id).
 * NO llama a Meta API — la data ya está siendo collected cada 10 min por
 * data-collector.js. Esto evita rate limits y da frescura sub-10min.
 */

const MetricSnapshot = require('../../db/models/MetricSnapshot');
const CBOHealthSnapshot = require('../../db/models/CBOHealthSnapshot');
const BrainInsight = require('../../db/models/BrainInsight');
const logger = require('../../utils/logger');

// Threshold configurable — empezamos en 30% del proporcional, afinar con data real
const STARVED_THRESHOLD_PCT = 0.3;
// Concentración sostenida
const CONCENTRATION_THRESHOLD = 0.8;
// Edad mínima para considerar "true starved" (por debajo siguen en learning natural de Meta)
const MIN_AGE_DAYS_FOR_STARVED = 3;
// Ventana para backfill del favorito en el primer run
const FAVORITE_BACKFILL_DAYS = 14;

/**
 * Determina si una campaña es CBO por shape: daily_budget a nivel campaña > 0
 * indica que Meta maneja el budget centralmente (CBO). ABO tiene 0 o null.
 */
function isCBO(campaignSnapshot) {
  return Number(campaignSnapshot?.daily_budget) > 0;
}

/**
 * Última snapshot de cada adset activo bajo una CBO.
 */
async function getLatestAdsetsForCBO(campaign_id) {
  return MetricSnapshot.aggregate([
    { $match: { entity_type: 'adset', campaign_id } },
    { $sort: { entity_id: 1, snapshot_at: -1 } },
    { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } },
    { $match: { status: 'ACTIVE' } }
  ]);
}

/**
 * Para backfill de tenure: determinar cuántos días consecutivos hacia atrás
 * un adset fue el top-spender bajo su CBO. Mira snapshots históricos.
 */
async function computeFavoriteTenure(campaign_id, favorite_adset_id) {
  const since = new Date(Date.now() - FAVORITE_BACKFILL_DAYS * 86400000);

  // Todos los snapshots de adsets de esta CBO en los últimos 14 días
  const snapshots = await MetricSnapshot.aggregate([
    { $match: { entity_type: 'adset', campaign_id, snapshot_at: { $gte: since } } },
    { $addFields: {
      date_str: { $dateToString: { format: '%Y-%m-%d', date: '$snapshot_at' } }
    }},
    // último snapshot del día por adset
    { $sort: { entity_id: 1, snapshot_at: -1 } },
    { $group: {
      _id: { date: '$date_str', entity_id: '$entity_id' },
      doc: { $first: '$$ROOT' }
    }},
    { $replaceRoot: { newRoot: '$doc' } },
    { $sort: { snapshot_at: -1 } }
  ]);

  // Agrupar por día → determinar top spender del día
  const byDay = new Map();
  for (const s of snapshots) {
    const day = new Date(s.snapshot_at).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(s);
  }

  const topPerDay = [];
  for (const [day, list] of byDay.entries()) {
    let top = null;
    let maxSpend = -1;
    for (const s of list) {
      const spend = s.metrics?.today?.spend || 0;
      if (spend > maxSpend) { maxSpend = spend; top = s; }
    }
    topPerDay.push({ day, entity_id: top?.entity_id, spend: maxSpend });
  }
  // Ordenar por día desc
  topPerDay.sort((a, b) => b.day.localeCompare(a.day));

  // Contar días consecutivos donde favorite_adset_id fue top desde el más reciente
  let tenure = 0;
  let since_date = null;
  for (const entry of topPerDay) {
    if (entry.entity_id === favorite_adset_id && entry.spend > 0) {
      tenure++;
      since_date = entry.day;
    } else {
      break;
    }
  }

  return {
    tenure_days: tenure,
    since: since_date ? new Date(since_date + 'T00:00:00Z') : null
  };
}

/**
 * Analiza una CBO individual, genera y persiste un CBOHealthSnapshot.
 */
async function analyzeCBO(campaignSnapshot) {
  const start = Date.now();
  const monitor_errors = [];
  const campaign_id = campaignSnapshot.entity_id;
  const campaign_name = campaignSnapshot.entity_name || '';

  try {
    const adsets = await getLatestAdsetsForCBO(campaign_id);
    const active_adsets_count = adsets.length;
    const daily_budget = Number(campaignSnapshot.daily_budget) || 0;

    // Zombie: CBO activa con budget asignado pero 0 adsets activos.
    // Detecta el problema exacto del creador — 2 CBOs "Duplicados Ganadores"
    // que quedaron flotando sin adsets.
    const is_zombie = active_adsets_count === 0;

    // Budget pulse
    const budget_pulse = active_adsets_count > 0 ? daily_budget / active_adsets_count : 0;

    // Si es zombie, snapshot mínimo
    if (is_zombie) {
      const snap = await CBOHealthSnapshot.create({
        campaign_id, campaign_name,
        snapshot_at: new Date(),
        is_zombie: true,
        daily_budget,
        active_adsets_count: 0,
        budget_pulse: 0,
        compute_ms: Date.now() - start
      });
      return snap;
    }

    // Agregados ventaneados
    const agg = (win) => adsets.reduce((acc, a) => {
      const m = a.metrics?.[win] || {};
      acc.spend += m.spend || 0;
      acc.revenue += m.purchase_value || 0;
      return acc;
    }, { spend: 0, revenue: 0 });

    const w1 = agg('today');
    const w3 = agg('last_3d');
    const w7 = agg('last_7d');

    const cbo_roas_1d = w1.spend > 0 ? w1.revenue / w1.spend : 0;
    const cbo_roas_3d = w3.spend > 0 ? w3.revenue / w3.spend : 0;
    const cbo_roas_7d = w7.spend > 0 ? w7.revenue / w7.spend : 0;

    // Concentración: % del spend que toma el top adset en la ventana
    const spendBy3d = adsets.map(a => ({
      id: a.entity_id,
      name: a.entity_name,
      spend_3d: a.metrics?.last_3d?.spend || 0,
      spend_1d: a.metrics?.today?.spend || 0,
      roas_3d: a.metrics?.last_3d?.spend > 0 ? (a.metrics.last_3d.purchase_value || 0) / a.metrics.last_3d.spend : 0,
      roas_7d: a.metrics?.last_7d?.spend > 0 ? (a.metrics.last_7d.purchase_value || 0) / a.metrics.last_7d.spend : 0,
      freq: a.metrics?.last_7d?.frequency || 0,
      age_days: a.created_time ? Math.floor((Date.now() - new Date(a.created_time).getTime()) / 86400000) : null,
      learning_stage: a.learning_stage || 'unknown'
    }));

    spendBy3d.sort((a, b) => b.spend_3d - a.spend_3d);
    const topSpender = spendBy3d[0];
    const concentration_index_3d = w3.spend > 0 ? topSpender.spend_3d / w3.spend : 0;
    const concentration_index_1d = w1.spend > 0 ? (topSpender.spend_1d / w1.spend) : 0;

    // Sustained 3d — usamos los últimos 3 snapshots diarios para chequear que
    // el favorito haya mantenido >80% cada día. Si tenemos <3 días de history,
    // conservadoramente false.
    const sustained3dHistory = await checkConcentrationSustained(campaign_id, topSpender.id);
    const concentration_sustained_3d = sustained3dHistory;

    // Favorito
    const { tenure_days, since } = await computeFavoriteTenure(campaign_id, topSpender.id);

    // Starvation analysis
    const proportional = 1 / active_adsets_count;
    const starved_adsets = spendBy3d.map(a => {
      const spend_share_3d = w3.spend > 0 ? a.spend_3d / w3.spend : 0;
      const is_true_starved =
        a.age_days != null &&
        a.age_days > MIN_AGE_DAYS_FOR_STARVED &&
        a.learning_stage !== 'LEARNING' &&
        spend_share_3d < proportional * STARVED_THRESHOLD_PCT;
      return {
        adset_id: a.id,
        adset_name: a.name,
        entity_age_days: a.age_days,
        learning_stage: a.learning_stage,
        spend_share_3d,
        proportional_expected: proportional,
        is_true_starved,
        roas_7d: a.roas_7d
      };
    });
    const starved_count = starved_adsets.filter(s => s.is_true_starved).length;

    // Colapso compuesto — ROAS cae 30%+ en 3d Y spend se mantiene/sube
    const collapse_detected =
      cbo_roas_7d > 0 &&
      cbo_roas_3d < cbo_roas_7d * 0.7 &&
      w3.spend >= w7.spend * 0.9 * (3 / 7); // spend 3d >= 90% de su parte proporcional del spend 7d

    // Favorite declining
    const favorite_declining = topSpender.roas_7d > 0 && topSpender.roas_3d < topSpender.roas_7d;

    const snap = await CBOHealthSnapshot.create({
      campaign_id, campaign_name,
      snapshot_at: new Date(),
      is_zombie: false,
      daily_budget,
      active_adsets_count,
      budget_pulse,
      cbo_roas_1d, cbo_roas_3d, cbo_roas_7d,
      cbo_spend_1d: w1.spend, cbo_spend_3d: w3.spend, cbo_spend_7d: w7.spend,
      cbo_revenue_1d: w1.revenue, cbo_revenue_3d: w3.revenue, cbo_revenue_7d: w7.revenue,
      concentration_index_1d,
      concentration_index_3d,
      concentration_sustained_3d,
      favorite_adset_id: topSpender.id,
      favorite_adset_name: topSpender.name,
      favorite_since: since,
      favorite_tenure_days: tenure_days,
      favorite_roas_3d: topSpender.roas_3d,
      favorite_roas_7d: topSpender.roas_7d,
      favorite_freq: topSpender.freq,
      favorite_spend_share_3d: concentration_index_3d,
      favorite_declining,
      starved_adsets,
      starved_count,
      collapse_detected,
      compute_ms: Date.now() - start,
      monitor_errors
    });

    return snap;
  } catch (err) {
    monitor_errors.push(err.message);
    logger.error(`[CBO-MONITOR] analyzeCBO falló para ${campaign_id}: ${err.message}`);
    return null;
  }
}

/**
 * Chequea si el favorito tuvo >80% de concentration por cada uno de los
 * últimos 3 días. Lee MetricSnapshot histórico.
 */
async function checkConcentrationSustained(campaign_id, favorite_id) {
  const since = new Date(Date.now() - 3 * 86400000);
  const snapshots = await MetricSnapshot.aggregate([
    { $match: { entity_type: 'adset', campaign_id, snapshot_at: { $gte: since } } },
    { $addFields: {
      date_str: { $dateToString: { format: '%Y-%m-%d', date: '$snapshot_at' } }
    }},
    { $sort: { entity_id: 1, snapshot_at: -1 } },
    { $group: {
      _id: { date: '$date_str', entity_id: '$entity_id' },
      doc: { $first: '$$ROOT' }
    }},
    { $replaceRoot: { newRoot: '$doc' } }
  ]);

  const byDay = new Map();
  for (const s of snapshots) {
    const day = new Date(s.snapshot_at).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(s);
  }

  if (byDay.size < 3) return false; // no hay suficiente history

  let allSustained = true;
  for (const [day, list] of byDay.entries()) {
    const totalSpend = list.reduce((a, s) => a + (s.metrics?.today?.spend || 0), 0);
    const favSpend = list.find(s => s.entity_id === favorite_id)?.metrics?.today?.spend || 0;
    const share = totalSpend > 0 ? favSpend / totalSpend : 0;
    if (share < CONCENTRATION_THRESHOLD) { allSustained = false; break; }
  }
  return allSustained;
}

/**
 * Itera todas las campañas, filtra las CBO activas y ejecuta analyzeCBO
 * sobre cada una. Retorna el array de snapshots generados.
 */
async function analyzeAllCBOs() {
  const start = Date.now();

  // Latest campaign snapshots
  const campaigns = await MetricSnapshot.aggregate([
    { $match: { entity_type: 'campaign' } },
    { $sort: { entity_id: 1, snapshot_at: -1 } },
    { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } },
    { $match: { status: 'ACTIVE' } }
  ]);

  const cbos = campaigns.filter(isCBO);
  logger.info(`[CBO-MONITOR] detectadas ${cbos.length} CBOs activas de ${campaigns.length} campañas`);

  const results = [];
  for (const cbo of cbos) {
    const snap = await analyzeCBO(cbo);
    if (snap) results.push(snap);
  }

  // Loggear findings relevantes como BrainInsight (no spam — solo cosas
  // dignas de atención)
  for (const snap of results) {
    try {
      // Nota: BrainInsight tiene enum estricto en insight_type y generated_by.
      // Usamos valores existentes (warning/anomaly/trend) + marcamos el origen
      // específico con data_points.monitor_subtype para que el feed los filtre.
      if (snap.is_zombie) {
        await BrainInsight.create({
          insight_type: 'warning',
          severity: 'medium',
          title: `🧟 CBO zombie: ${snap.campaign_name}`,
          body: `Campaña ACTIVE con $${snap.daily_budget}/d pero 0 adsets activos. Budget comprometido sin generar spend. Revisar si apagar.`,
          generated_by: 'brain',
          entities: [{ entity_type: 'campaign', entity_id: snap.campaign_id, entity_name: snap.campaign_name }],
          data_points: {
            monitor_subtype: 'cbo_zombie_detected',
            daily_budget: snap.daily_budget,
            snapshot_id: snap._id.toString()
          }
        });
      } else if (snap.collapse_detected) {
        await BrainInsight.create({
          insight_type: 'anomaly',
          severity: 'critical',
          title: `🔴 CBO colapsando: ${snap.campaign_name}`,
          body: `ROAS 3d ${snap.cbo_roas_3d.toFixed(2)}x cae >30% vs 7d ${snap.cbo_roas_7d.toFixed(2)}x manteniendo spend. Decidir: pausar CBO, rescate de adsets, o wait.`,
          generated_by: 'brain',
          entities: [{ entity_type: 'campaign', entity_id: snap.campaign_id, entity_name: snap.campaign_name }],
          data_points: {
            monitor_subtype: 'cbo_collapse_detected',
            cbo_roas_3d: snap.cbo_roas_3d,
            cbo_roas_7d: snap.cbo_roas_7d,
            cbo_spend_3d: snap.cbo_spend_3d,
            snapshot_id: snap._id.toString()
          }
        });
      } else if (snap.concentration_sustained_3d && snap.favorite_declining && snap.favorite_freq > 2) {
        await BrainInsight.create({
          insight_type: 'warning',
          severity: 'medium',
          title: `⚠ CBO saturando: ${snap.campaign_name}`,
          body: `Favorito ${snap.favorite_adset_name} concentra ${Math.round(snap.concentration_index_3d * 100)}% freq ${snap.favorite_freq.toFixed(2)} ROAS declining (3d ${snap.favorite_roas_3d.toFixed(2)}x < 7d ${snap.favorite_roas_7d.toFixed(2)}x). Candidato a creative_refresh.`,
          generated_by: 'brain',
          entities: [
            { entity_type: 'campaign', entity_id: snap.campaign_id, entity_name: snap.campaign_name },
            { entity_type: 'adset', entity_id: snap.favorite_adset_id, entity_name: snap.favorite_adset_name }
          ],
          data_points: { monitor_subtype: 'cbo_saturation_signal', snapshot_id: snap._id.toString() }
        });
      }
    } catch (insightErr) {
      logger.warn(`[CBO-MONITOR] Error emitting insight: ${insightErr.message}`);
    }
  }

  const elapsed = Date.now() - start;
  logger.info(`[CBO-MONITOR] analizadas ${results.length}/${cbos.length} en ${elapsed}ms`);
  return results;
}

/**
 * Wrapper para el cron.
 */
async function runCBOHealthMonitor() {
  try {
    return await analyzeAllCBOs();
  } catch (err) {
    logger.error(`[CBO-MONITOR] run falló: ${err.message}`);
    return [];
  }
}

module.exports = {
  isCBO,
  analyzeCBO,
  analyzeAllCBOs,
  runCBOHealthMonitor
};
