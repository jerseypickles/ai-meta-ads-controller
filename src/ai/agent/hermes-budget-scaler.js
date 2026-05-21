/**
 * Hermes Budget Scaler (2026-05-21).
 *
 * Escala el budget del CBO de foot traffic de Hermes por CONGRUENCIA, sin techo
 * de negocio. Hermes no tiene ROAS (tienda física, sin ventas online atribuibles),
 * así que el gate son señales de plataforma: CTR + CPC al link + frecuencia.
 *
 * Filosofía: mientras el scale sea congruente (eficiencia sostenida), el budget
 * sube. Cuando subir empieza a degradar CTR o saturar (freq alta), el mercado
 * se saturó → el sistema recorta solo. El mercado define el techo, no un número.
 * El budget extra es lo que habilita meter más adsets/creativos sin canibalizar.
 *
 * - SUBE +stepUpPct si CTR≥ctrMin y CPC≤cpcMax y freq<freqMax (todos)
 * - BAJA -stepDownPct si CTR<ctrFloor o freq>freqCeiling (cualquiera)
 * - cooldown entre ajustes, safety ceiling solo como circuit-breaker anti-runaway
 * - Live cuando HERMES_BUDGET_SCALER=true (arranca OFF).
 */

const config = require('../../../config');
const logger = require('../../utils/logger');
const SystemConfig = require('../../db/models/SystemConfig');
const ActionLog = require('../../db/models/ActionLog');

const HERMES_CAMPAIGN_KEY = 'hermes_meta_campaign';
const COOLDOWN_KEY = 'hermes_scaler_last_adjust';

async function logScalerAction({ entity_id, entity_name, action, before_value, after_value, reasoning, metadata, success, error }) {
  try {
    await ActionLog.create({
      entity_type: 'campaign',
      entity_id,
      entity_name,
      action,
      success: !!success,
      executed_at: new Date(),
      agent_type: 'hermes',
      reasoning,
      before_value,
      after_value,
      metadata: metadata || {},
      error: error || null
    });
  } catch (err) {
    logger.error(`[HERMES-SCALER] logAction failed: ${err.message}`);
  }
}

/**
 * Extrae la primera fila de insights sin asumir el shape exacto.
 */
function firstInsightRow(res) {
  if (!res) return null;
  if (Array.isArray(res)) return res[0] || null;
  if (Array.isArray(res.data)) return res.data[0] || null;
  return res;
}

function ymd(date) {
  return date.toISOString().split('T')[0];
}

async function runHermesBudgetScaler() {
  if (!config.hermes?.enabled) return { skipped: 'hermes_disabled' };
  const cfg = config.hermes.scaler;
  if (!cfg?.enabled) {
    logger.debug('[HERMES-SCALER] flag OFF — no corre (set HERMES_BUDGET_SCALER=true para activar)');
    return { skipped: 'scaler_off' };
  }

  // 1. Resolver el CBO de Hermes
  const stored = await SystemConfig.get(HERMES_CAMPAIGN_KEY);
  const campaignId = stored?.campaign_id;
  if (!campaignId) {
    logger.warn('[HERMES-SCALER] sin campaign_id de Hermes en SystemConfig — skip');
    return { skipped: 'no_campaign' };
  }

  // 2. Cooldown
  const last = await SystemConfig.get(COOLDOWN_KEY);
  if (last?.at) {
    const hrs = (Date.now() - new Date(last.at).getTime()) / 3600000;
    if (hrs < cfg.cooldownHours) {
      logger.info(`[HERMES-SCALER] cooldown: ${(cfg.cooldownHours - hrs).toFixed(1)}h restantes — skip`);
      return { skipped: 'cooldown' };
    }
  }

  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();

  // 3. Budget actual del CBO + insights 7d
  let currentBudget;
  let campaignName = stored.name || '[HERMES] CBO';
  try {
    const camp = await meta.get(`/${campaignId}`, { fields: 'daily_budget,name,effective_status' });
    campaignName = camp?.name || campaignName;
    currentBudget = camp?.daily_budget ? Number(camp.daily_budget) / 100 : null;
    if (!currentBudget) {
      logger.warn(`[HERMES-SCALER] CBO ${campaignId} sin daily_budget (¿ABO o lifetime?) — skip`);
      return { skipped: 'no_daily_budget' };
    }
  } catch (err) {
    logger.error(`[HERMES-SCALER] no se pudo leer el CBO: ${err.message}`);
    return { skipped: 'campaign_read_failed', error: err.message };
  }

  const now = new Date();
  const since = new Date(now.getTime() - 7 * 86400000);
  let row;
  try {
    const ins = await meta.getInsights(campaignId, {
      fields: 'ctr,cpc,inline_link_click_ctr,cost_per_inline_link_click,frequency,spend,impressions',
      time_range: JSON.stringify({ since: ymd(since), until: ymd(now) })
    });
    row = firstInsightRow(ins);
  } catch (err) {
    logger.error(`[HERMES-SCALER] insights falló: ${err.message}`);
    return { skipped: 'insights_failed', error: err.message };
  }
  if (!row) return { skipped: 'no_insights' };

  // Preferir métricas de link (objetivo LINK_CLICKS); fallback a generales
  const ctr = parseFloat(row.inline_link_click_ctr || row.ctr || 0);
  const cpc = parseFloat(row.cost_per_inline_link_click || row.cpc || 0);
  const freq = parseFloat(row.frequency || 0);
  const spend = parseFloat(row.spend || 0);

  // 4. Muestra mínima — no decidir con poco gasto
  if (spend < cfg.minSpend7d) {
    logger.info(`[HERMES-SCALER] spend 7d $${spend.toFixed(2)} < min $${cfg.minSpend7d} — skip`);
    return { skipped: 'low_sample', spend };
  }

  // 5. Decisión por congruencia
  let decision = 'hold';
  let newBudget = currentBudget;
  let reasoning;

  if (ctr < cfg.ctrFloor || freq > cfg.freqCeiling) {
    decision = 'down';
    newBudget = Math.max(config.hermes.minDailyBudget || 20, Math.round(currentBudget * (1 - cfg.stepDownPct)));
    reasoning = `Recorte por incongruencia: CTR ${ctr.toFixed(2)}% (floor ${cfg.ctrFloor}%) / freq ${freq.toFixed(2)} (ceil ${cfg.freqCeiling}). Budget $${currentBudget}→$${newBudget}.`;
  } else if (ctr >= cfg.ctrMin && cpc <= cfg.cpcMax && freq < cfg.freqMax) {
    decision = 'up';
    newBudget = Math.min(cfg.safetyCeiling, Math.round(currentBudget * (1 + cfg.stepUpPct)));
    reasoning = `Scale congruente: CTR ${ctr.toFixed(2)}% (≥${cfg.ctrMin}) · CPC $${cpc.toFixed(2)} (≤$${cfg.cpcMax}) · freq ${freq.toFixed(2)} (<${cfg.freqMax}). Budget $${currentBudget}→$${newBudget}.`;
  } else {
    reasoning = `Zona gris — mantener. CTR ${ctr.toFixed(2)}% · CPC $${cpc.toFixed(2)} · freq ${freq.toFixed(2)}.`;
  }

  if (decision === 'hold' || newBudget === currentBudget) {
    logger.info(`[HERMES-SCALER] HOLD — ${reasoning}`);
    return { decision: 'hold', current_budget: currentBudget, ctr, cpc, freq, spend };
  }

  // 6. Ejecutar (live)
  try {
    await meta.updateBudget(campaignId, newBudget);
    await SystemConfig.set(COOLDOWN_KEY, { at: now.toISOString(), from: currentBudget, to: newBudget });
    await logScalerAction({
      entity_id: campaignId,
      entity_name: campaignName,
      action: decision === 'up' ? 'scale_up' : 'scale_down',
      before_value: currentBudget,
      after_value: newBudget,
      reasoning,
      metadata: { source: 'hermes_budget_scaler', ctr, cpc, freq, spend_7d: spend, step_pct: decision === 'up' ? cfg.stepUpPct : -cfg.stepDownPct },
      success: true
    });
    logger.info(`[HERMES-SCALER] ✓ ${decision.toUpperCase()} CBO "${campaignName}" $${currentBudget}→$${newBudget}/d — ${reasoning}`);
    return { decision, from: currentBudget, to: newBudget, ctr, cpc, freq, spend };
  } catch (err) {
    await logScalerAction({
      entity_id: campaignId, entity_name: campaignName,
      action: decision === 'up' ? 'scale_up' : 'scale_down',
      before_value: currentBudget, after_value: newBudget, reasoning,
      metadata: { source: 'hermes_budget_scaler' }, success: false, error: err.message
    });
    logger.error(`[HERMES-SCALER] ejecución falló: ${err.message}`);
    return { decision, error: err.message };
  }
}

module.exports = { runHermesBudgetScaler };
