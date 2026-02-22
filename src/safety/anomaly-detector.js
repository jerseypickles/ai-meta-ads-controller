const safetyGuards = require('../../config/safety-guards');
const kpiTargets = require('../../config/kpi-targets');
const { getMetaClient } = require('../meta/client');
const { getLatestSnapshots } = require('../db/queries');
const SafetyEvent = require('../db/models/SafetyEvent');
const ActionLog = require('../db/models/ActionLog');
const logger = require('../utils/logger');

/**
 * Detección de anomalías por entidad.
 * A diferencia del Kill Switch (que monitorea la cuenta completa),
 * este detector busca anomalías individuales en ad sets y ads:
 *   - Caída brusca de ROAS vs promedio 7d
 *   - Spike de gasto vs presupuesto diario
 * Acción: pausa selectiva de la entidad anómala (no toda la cuenta).
 */
class AnomalyDetector {
  constructor() {
    this.config = safetyGuards.anomaly_detection || {};
    this.meta = getMetaClient();
  }

  /**
   * Corre el ciclo de detección.
   * @returns {Object} { anomalies, paused, skipped }
   */
  async monitor() {
    if (!this.config.enabled) {
      return { anomalies: 0, paused: 0, skipped: 0, reason: 'Anomaly detection deshabilitado' };
    }

    try {
      const snapshots = await getLatestSnapshots('adset');
      if (snapshots.length === 0) {
        return { anomalies: 0, paused: 0, skipped: 0, reason: 'Sin snapshots' };
      }

      // Cargar anomalías recientes para evitar duplicados (cooldown)
      const cooldownHours = this.config.cooldown_hours || 6;
      const cooldownCutoff = new Date(Date.now() - cooldownHours * 60 * 60 * 1000);
      const recentAnomalies = await SafetyEvent.find({
        event_type: 'anomaly_detected',
        created_at: { $gte: cooldownCutoff }
      }).lean();
      const recentAnomalyEntityIds = new Set(recentAnomalies.map(a => a.entity_id));

      const anomalies = [];
      let paused = 0;
      let skipped = 0;

      for (const snapshot of snapshots) {
        if (snapshot.status !== 'ACTIVE') continue;

        const entityId = snapshot.entity_id;
        const entityName = snapshot.entity_name || 'Sin nombre';

        // Skip si ya detectamos anomalía reciente en esta entidad
        if (recentAnomalyEntityIds.has(entityId)) {
          skipped++;
          continue;
        }

        const checks = this._checkEntity(snapshot);

        if (checks.length > 0) {
          const reasons = checks.map(c => c.reason).join('; ');
          const severity = checks.some(c => c.severity === 'critical') ? 'critical' : 'warning';

          anomalies.push({
            entity_id: entityId,
            entity_name: entityName,
            checks,
            severity
          });

          // Registrar evento de seguridad
          await SafetyEvent.create({
            event_type: 'anomaly_detected',
            severity,
            entity_id: entityId,
            entity_name: entityName,
            description: `Anomalía detectada: ${reasons}`,
            details: {
              checks,
              snapshot_metrics: {
                roas_7d: snapshot.metrics?.last_7d?.roas || 0,
                roas_today: snapshot.metrics?.today?.roas || 0,
                spend_today: snapshot.metrics?.today?.spend || 0,
                daily_budget: snapshot.daily_budget || 0,
                cpa_7d: snapshot.metrics?.last_7d?.cpa || 0,
                frequency_7d: snapshot.metrics?.last_7d?.frequency || 0
              }
            }
          });

          // Auto-pausar si configurado
          if (this.config.auto_pause && severity === 'critical') {
            try {
              await this.meta.updateStatus(entityId, 'PAUSED');

              await ActionLog.create({
                entity_type: 'adset',
                entity_id: entityId,
                entity_name: entityName,
                action: 'pause',
                before_value: snapshot.daily_budget || 0,
                after_value: 0,
                change_percent: -100,
                reasoning: `[ANOMALY DETECTOR] Pausa automática: ${reasons}`,
                confidence: 'high',
                agent_type: 'anomaly_detector',
                success: true,
                metrics_at_execution: {
                  roas_7d: snapshot.metrics?.last_7d?.roas || 0,
                  roas_3d: snapshot.metrics?.last_3d?.roas || 0,
                  cpa_7d: snapshot.metrics?.last_7d?.cpa || 0,
                  spend_today: snapshot.metrics?.today?.spend || 0,
                  spend_7d: snapshot.metrics?.last_7d?.spend || 0,
                  daily_budget: snapshot.daily_budget || 0,
                  purchases_7d: snapshot.metrics?.last_7d?.purchases || 0,
                  frequency: snapshot.metrics?.last_7d?.frequency || 0,
                  ctr: snapshot.metrics?.last_7d?.ctr || 0
                }
              });

              paused++;
              logger.error(`[ANOMALY] PAUSA AUTOMÁTICA: ${entityName} (${entityId}) — ${reasons}`);
            } catch (pauseErr) {
              logger.error(`[ANOMALY] Error pausando ${entityName}: ${pauseErr.message}`);
            }
          } else {
            logger.warn(`[ANOMALY] Detectada: ${entityName} (${entityId}) — ${reasons} [severity=${severity}]`);
          }
        }
      }

      if (anomalies.length > 0) {
        logger.info(`[ANOMALY] Ciclo completado: ${anomalies.length} anomalías, ${paused} pausadas, ${skipped} en cooldown`);
      }

      return { anomalies: anomalies.length, paused, skipped };
    } catch (error) {
      logger.error(`[ANOMALY] Error en monitor: ${error.message}`);
      return { anomalies: 0, paused: 0, skipped: 0, error: error.message };
    }
  }

  /**
   * Verifica una entidad individual contra los umbrales de anomalía.
   * @returns {Array} Lista de checks fallidos
   */
  _checkEntity(snapshot) {
    const checks = [];
    const metrics = snapshot.metrics || {};
    const today = metrics.today || {};
    const last7d = metrics.last_7d || {};

    const spendToday = toNumber(today.spend);
    const dailyBudget = toNumber(snapshot.daily_budget);
    const roas7d = toNumber(last7d.roas);
    const roasToday = toNumber(today.roas);
    const spendThreshold = toNumber(this.config.min_spend_for_anomaly, 15);

    // No evaluar entidades con poco gasto (evitar falsos positivos)
    if (spendToday < spendThreshold) return [];

    // CHECK 1: Caída brusca de ROAS
    // ROAS hoy vs ROAS promedio 7d
    const roasDropThreshold = toNumber(this.config.roas_drop_threshold, 0.50);
    if (roas7d > 0.5 && roasToday >= 0) {
      const roasDrop = (roas7d - roasToday) / roas7d;
      if (roasDrop >= roasDropThreshold) {
        checks.push({
          type: 'roas_drop',
          severity: roasDrop >= 0.75 ? 'critical' : 'warning',
          reason: `ROAS cayó ${(roasDrop * 100).toFixed(0)}%: ${roasToday.toFixed(2)}x hoy vs ${roas7d.toFixed(2)}x promedio 7d`,
          roas_today: roasToday,
          roas_7d: roas7d,
          drop_pct: Math.round(roasDrop * 100)
        });
      }
    }

    // CHECK 2: Spike de gasto
    // Gasto hoy > presupuesto_diario * multiplier
    const spendMultiplier = toNumber(this.config.spend_spike_multiplier, 2.5);
    if (dailyBudget > 0 && spendToday > dailyBudget * spendMultiplier) {
      const spikeRatio = spendToday / dailyBudget;
      checks.push({
        type: 'spend_spike',
        severity: spikeRatio >= 4 ? 'critical' : 'warning',
        reason: `Gasto $${spendToday.toFixed(2)} es ${spikeRatio.toFixed(1)}x el presupuesto diario de $${dailyBudget.toFixed(2)}`,
        spend_today: spendToday,
        daily_budget: dailyBudget,
        spike_ratio: Math.round(spikeRatio * 10) / 10
      });
    }

    // CHECK 3: CPA explosivo
    // CPA hoy > 3x CPA objetivo (solo si hay compras para calcularlo)
    const purchasesToday = toNumber(today.purchases);
    if (purchasesToday > 0 && spendToday > 0) {
      const cpaToday = spendToday / purchasesToday;
      const cpaTarget = toNumber(kpiTargets.cpa_target, 25);
      if (cpaToday > cpaTarget * 3) {
        checks.push({
          type: 'cpa_explosion',
          severity: cpaToday > cpaTarget * 5 ? 'critical' : 'warning',
          reason: `CPA hoy $${cpaToday.toFixed(2)} es ${(cpaToday / cpaTarget).toFixed(1)}x el objetivo de $${cpaTarget.toFixed(2)}`,
          cpa_today: cpaToday,
          cpa_target: cpaTarget,
          multiplier: Math.round(cpaToday / cpaTarget * 10) / 10
        });
      }
    }

    return checks;
  }
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = AnomalyDetector;
