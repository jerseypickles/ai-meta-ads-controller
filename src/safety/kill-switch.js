const safetyGuards = require('../../config/safety-guards');
const kpiTargets = require('../../config/kpi-targets');
const { getMetaClient } = require('../meta/client');
const { getLatestSnapshots, isKillSwitchActive, getSnapshotFreshness } = require('../db/queries');
const SafetyEvent = require('../db/models/SafetyEvent');
const logger = require('../utils/logger');

class KillSwitch {
  constructor() {
    this.meta = getMetaClient();
  }

  /**
   * Monitoreo principal — corre cada 15 minutos independientemente.
   * Verifica condiciones de emergencia.
   */
  async monitor() {
    if (!safetyGuards.kill_switch.enabled) {
      return { triggered: false, reason: 'Kill switch deshabilitado' };
    }

    // Si ya está activo, no hacer nada
    if (await isKillSwitchActive()) {
      logger.debug('Kill switch ya está activo');
      return { triggered: true, reason: 'Ya activo' };
    }

    try {
      // Freshness check — stale data means we CAN'T trust the safety metrics
      const freshness = await getSnapshotFreshness('adset');
      if (!freshness.fresh) {
        logger.error(`[KILL-SWITCH] ⚠ Datos stale (${freshness.age_minutes} min) — no se puede evaluar seguridad con precisión`);
        // Registrar evento de seguridad para visibilidad
        await SafetyEvent.create({
          event_type: 'stale_data_warning',
          severity: 'warning',
          description: `Kill switch monitor no puede evaluar con precisión: datos tienen ${freshness.age_minutes} min de antigüedad (máximo 15 min). DataCollector puede estar fallando.`,
          details: { age_minutes: freshness.age_minutes, last_snapshot_at: freshness.last_snapshot_at }
        }).catch(() => {});
        return { triggered: false, reason: `Datos stale (${freshness.age_minutes} min) — evaluación no confiable`, stale: true };
      }

      const snapshots = await getLatestSnapshots('adset');
      if (snapshots.length === 0) {
        return { triggered: false, reason: 'Sin datos para evaluar' };
      }

      // Calcular métricas de la cuenta
      const totalSpend7d = snapshots.reduce((sum, s) => sum + (s.metrics?.last_7d?.spend || 0), 0);
      const totalRevenue7d = snapshots.reduce((sum, s) => sum + (s.metrics?.last_7d?.purchase_value || 0), 0);
      const accountROAS = totalSpend7d > 0 ? totalRevenue7d / totalSpend7d : 0;

      const totalSpendToday = snapshots.reduce((sum, s) => sum + (s.metrics?.today?.spend || 0), 0);
      const totalRevenueToday = snapshots.reduce((sum, s) => sum + (s.metrics?.today?.purchase_value || 0), 0);
      const dailyLoss = totalSpendToday - totalRevenueToday;

      const totalPurchases7d = snapshots.reduce((sum, s) => sum + (s.metrics?.last_7d?.purchases || 0), 0);
      const accountCPA = totalPurchases7d > 0 ? totalSpend7d / totalPurchases7d : 0;

      // CHECK 1: ROAS por debajo del umbral crítico — requiere $1000+ spend 7d
      if (accountROAS > 0 && totalSpend7d >= 1000 && accountROAS < safetyGuards.kill_switch.account_roas_below) {
        return this.triggerEmergencyPause(
          `ROAS de la cuenta en ${accountROAS.toFixed(2)}x con $${totalSpend7d.toFixed(0)} spend — debajo del umbral de ${safetyGuards.kill_switch.account_roas_below}x`
        );
      }

      // CHECK 2: CPA demasiado alto — requiere mínimo 100 compras 7d para disparar
      // (evita falsos positivos cuando el data collector aún no procesó todos los snapshots)
      if (accountCPA > 0 && totalPurchases7d >= 100 && accountCPA > kpiTargets.cpa_target * safetyGuards.kill_switch.account_cpa_above_multiplier) {
        return this.triggerEmergencyPause(
          `CPA de la cuenta en $${accountCPA.toFixed(2)} con ${totalPurchases7d} compras 7d — ${safetyGuards.kill_switch.account_cpa_above_multiplier}x por encima del objetivo de $${kpiTargets.cpa_target}`
        );
      }

      // CHECK 3: Pérdida diaria excesiva
      if (dailyLoss > safetyGuards.kill_switch.daily_loss_threshold) {
        return this.triggerEmergencyPause(
          `Pérdida diaria de $${dailyLoss.toFixed(2)} — excede el umbral de $${safetyGuards.kill_switch.daily_loss_threshold}`
        );
      }

      logger.debug(`Kill switch monitor OK — ROAS: ${accountROAS.toFixed(2)}x, CPA: $${accountCPA.toFixed(2)}`);
      return { triggered: false, reason: 'Métricas dentro de rango seguro' };
    } catch (error) {
      logger.error('Error en kill switch monitor:', error);
      return { triggered: false, reason: `Error: ${error.message}` };
    }
  }

  /**
   * Pausa de emergencia — pausa TODAS las campañas activas.
   */
  async triggerEmergencyPause(reason) {
    logger.error(`🚨 KILL SWITCH ACTIVADO: ${reason}`);

    try {
      // 1. Obtener todas las campañas activas
      const campaigns = await this.meta.getCampaigns(
        'id,name,status',
        JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE'] }])
      );

      // 2. Pausar cada campaña
      const pausedCampaigns = [];

      for (const campaign of campaigns) {
        try {
          await this.meta.updateStatus(campaign.id, 'PAUSED');
          pausedCampaigns.push({ id: campaign.id, name: campaign.name });
          logger.warn(`Campaña pausada: ${campaign.name} (${campaign.id})`);
        } catch (err) {
          logger.error(`Error pausando campaña ${campaign.id}:`, err);
        }
      }

      // 3. Registrar evento de seguridad
      await SafetyEvent.create({
        event_type: 'kill_switch_triggered',
        severity: 'critical',
        description: reason,
        details: {
          campaigns_paused: pausedCampaigns,
          total_paused: pausedCampaigns.length
        }
      });

      logger.error(`Kill switch: ${pausedCampaigns.length} campañas pausadas`);

      return {
        triggered: true,
        reason,
        campaignsPaused: pausedCampaigns.length
      };
    } catch (error) {
      logger.error('Error crítico en kill switch:', error);
      return { triggered: true, reason, error: error.message };
    }
  }

  /**
   * Reset manual del kill switch.
   * Requiere confirmación — solo se puede hacer desde el dashboard.
   */
  async manualReset() {
    const event = await SafetyEvent.findOne({
      event_type: 'kill_switch_triggered',
      resolved: false
    });

    if (!event) {
      return { success: false, reason: 'No hay kill switch activo para resetear' };
    }

    event.resolved = true;
    event.resolved_at = new Date();
    event.resolved_by = 'manual';
    await event.save();

    // Registrar el reset
    await SafetyEvent.create({
      event_type: 'kill_switch_reset',
      severity: 'info',
      description: 'Kill switch reseteado manualmente desde el dashboard',
      details: { original_event_id: event._id }
    });

    logger.warn('Kill switch reseteado manualmente');
    return { success: true, reason: 'Kill switch reseteado. Las campañas necesitan reactivarse manualmente.' };
  }
}

module.exports = KillSwitch;
