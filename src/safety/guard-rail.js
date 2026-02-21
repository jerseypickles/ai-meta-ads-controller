const safetyGuards = require('../../config/safety-guards');
const { CooldownManager } = require('./cooldown-manager');
const { getTodaysBudgetChanges, isKillSwitchActive } = require('../db/queries');
const SafetyEvent = require('../db/models/SafetyEvent');
const logger = require('../utils/logger');
const moment = require('moment-timezone');

class GuardRail {
  constructor() {
    this.cooldownManager = new CooldownManager();
  }

  /**
   * Valida una decisión contra todos los safety guards.
   * Retorna: { approved, modified, reason, adjustedValue }
   */
  async validate(decision, currentState = {}) {
    const checks = [];

    // 1. Kill switch activo?
    if (await isKillSwitchActive()) {
      return this._reject(decision, 'Kill switch activo — todas las acciones bloqueadas', 'kill_switch');
    }

    // 2. Dentro de horas de operación?
    if (!this._isWithinOperatingHours()) {
      return this._reject(decision, 'Fuera de horas de operación', 'operating_hours_deferred');
    }

    // 3. Si es no_action, aprobar siempre
    if (decision.action === 'no_action') {
      return { approved: true, modified: false, reason: 'Sin acción requerida' };
    }

    // 4. Cooldown check
    const cooldownStatus = await this.cooldownManager.isOnCooldown(decision.entity_id);
    if (cooldownStatus.onCooldown) {
      return this._reject(
        decision,
        `En cooldown por ${cooldownStatus.minutesLeft} minutos más (última acción: ${cooldownStatus.lastAction})`,
        'cooldown_rejected'
      );
    }

    // 5. Validar acciones de presupuesto
    if (['scale_up', 'scale_down'].includes(decision.action)) {
      return this._validateBudgetChange(decision, currentState);
    }

    // 6. Pause/reactivate siempre se aprueban (después de cooldown check)
    if (['pause', 'reactivate'].includes(decision.action)) {
      return { approved: true, modified: false, reason: 'Acción de status aprobada' };
    }

    // 7. update_ad_status — pausar/activar un ad individual
    if (decision.action === 'update_ad_status') {
      return { approved: true, modified: false, reason: 'Cambio de status de ad aprobado' };
    }

    // 8. duplicate_adset — validar que no exceda techo de presupuesto
    if (decision.action === 'duplicate_adset') {
      const dupBudget = decision.new_value || decision.current_value;
      const ceilingCheck = await this._checkBudgetCeiling(null, dupBudget);
      if (!ceilingCheck.ok) {
        return this._reject(
          decision,
          `Duplicar ad set excedería techo de presupuesto: $${ceilingCheck.totalProjected.toFixed(2)} > $${safetyGuards.budget_ceiling_daily}`,
          'budget_ceiling_hit'
        );
      }
      return { approved: true, modified: false, reason: 'Duplicación de ad set aprobada' };
    }

    // 9. create_ad — validar que tiene creative_asset_id
    if (decision.action === 'create_ad') {
      if (!decision.creative_asset_id) {
        return this._reject(decision, 'create_ad requiere creative_asset_id', 'missing_creative');
      }
      return { approved: true, modified: false, reason: 'Creación de ad aprobada' };
    }

    // 10. update_bid_strategy — solo validar que tenga bid_strategy
    if (decision.action === 'update_bid_strategy') {
      const validStrategies = ['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP', 'LOWEST_COST_WITH_MIN_ROAS'];
      if (!validStrategies.includes(decision.bid_strategy)) {
        return this._reject(decision, `Bid strategy inválida: ${decision.bid_strategy}`, 'invalid_bid_strategy');
      }
      return { approved: true, modified: false, reason: 'Cambio de bid strategy aprobado' };
    }

    // 11. move_budget — validar source no quede debajo del mínimo
    if (decision.action === 'move_budget') {
      const moveAmount = decision.new_value || 0;
      const sourceRemaining = (decision.current_value || 0) - moveAmount;
      if (sourceRemaining < safetyGuards.min_adset_budget) {
        return this._reject(
          decision,
          `move_budget dejaría ad set source con $${sourceRemaining.toFixed(2)} (mínimo: $${safetyGuards.min_adset_budget})`,
          'budget_minimum_violation'
        );
      }
      // Validar techo
      const ceilingCheck = await this._checkBudgetCeiling(null, 0);
      if (!ceilingCheck.ok) {
        return this._reject(decision, 'Techo de presupuesto excedido', 'budget_ceiling_hit');
      }
      return { approved: true, modified: false, reason: 'Redistribución de presupuesto aprobada' };
    }

    // 12. update_ad_creative
    if (decision.action === 'update_ad_creative') {
      return { approved: true, modified: false, reason: 'Actualización de creative aprobada' };
    }

    return { approved: true, modified: false, reason: 'Validación completada' };
  }

  /**
   * Valida específicamente los cambios de presupuesto.
   */
  async _validateBudgetChange(decision, currentState) {
    let newValue = decision.new_value;
    let modified = false;
    const reasons = [];

    // Check: Presupuesto mínimo
    if (newValue < safetyGuards.min_adset_budget) {
      newValue = safetyGuards.min_adset_budget;
      modified = true;
      reasons.push(`Ajustado al mínimo: $${safetyGuards.min_adset_budget}`);
    }

    // Check: Presupuesto máximo por ad set
    if (newValue > safetyGuards.max_single_adset_budget) {
      newValue = safetyGuards.max_single_adset_budget;
      modified = true;
      reasons.push(`Capeado al máximo: $${safetyGuards.max_single_adset_budget}`);
    }

    // Check: Porcentaje de cambio
    const currentValue = decision.current_value;
    if (currentValue > 0) {
      const changePct = ((newValue - currentValue) / currentValue) * 100;

      if (changePct > safetyGuards.max_budget_increase_pct) {
        newValue = currentValue * (1 + safetyGuards.max_budget_increase_pct / 100);
        modified = true;
        reasons.push(`Incremento capeado a +${safetyGuards.max_budget_increase_pct}%`);
      }

      if (changePct < -safetyGuards.max_budget_decrease_pct) {
        newValue = currentValue * (1 - safetyGuards.max_budget_decrease_pct / 100);
        modified = true;
        reasons.push(`Reducción capeada a -${safetyGuards.max_budget_decrease_pct}%`);
      }
    }

    // Check: Techo de presupuesto total diario
    const totalBudgetCheck = await this._checkBudgetCeiling(decision.entity_id, newValue);
    if (!totalBudgetCheck.ok) {
      return this._reject(
        decision,
        `Techo de presupuesto diario excedido: $${totalBudgetCheck.totalProjected.toFixed(2)} > $${safetyGuards.budget_ceiling_daily}`,
        'budget_ceiling_hit'
      );
    }

    // Check: Límite de cambio diario total
    const dailyChangeCheck = await this._checkDailyChangeLimit(decision);
    if (!dailyChangeCheck.ok) {
      return this._reject(
        decision,
        `Límite de cambio diario total excedido: ${dailyChangeCheck.totalChangePct.toFixed(1)}% > ${safetyGuards.max_total_daily_change_pct}%`,
        'daily_change_limit_hit'
      );
    }

    // Redondear a 2 decimales
    newValue = Math.round(newValue * 100) / 100;

    if (modified) {
      await this._logSafetyEvent('budget_capped', 'warning', decision, reasons.join('; '));
    }

    return {
      approved: true,
      modified,
      reason: modified ? reasons.join('; ') : 'Cambio de presupuesto aprobado',
      adjustedValue: newValue,
      originalValue: decision.new_value
    };
  }

  /**
   * Verifica que el presupuesto total no exceda el techo.
   */
  async _checkBudgetCeiling(entityId, newBudget) {
    const MetricSnapshot = require('../db/models/MetricSnapshot');
    const latestAdsets = await MetricSnapshot.aggregate([
      { $match: { entity_type: 'adset' } },
      { $sort: { entity_id: 1, snapshot_at: -1 } },
      { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } }
    ]);

    let totalBudget = 0;
    for (const adset of latestAdsets) {
      if (adset.entity_id === entityId) {
        totalBudget += newBudget;
      } else if (adset.status === 'ACTIVE') {
        totalBudget += adset.daily_budget || 0;
      }
    }

    return {
      ok: totalBudget <= safetyGuards.budget_ceiling_daily,
      totalProjected: totalBudget
    };
  }

  /**
   * Verifica que el cambio total del día no exceda el límite.
   */
  async _checkDailyChangeLimit(decision) {
    const todaysChanges = await getTodaysBudgetChanges();

    let totalChangeAmount = 0;
    let totalOriginalBudget = 0;

    for (const change of todaysChanges) {
      const before = typeof change.before_value === 'number' ? change.before_value : 0;
      const after = typeof change.after_value === 'number' ? change.after_value : 0;
      totalChangeAmount += Math.abs(after - before);
      totalOriginalBudget += before;
    }

    // Agregar el cambio propuesto
    totalChangeAmount += Math.abs(decision.new_value - decision.current_value);
    totalOriginalBudget += decision.current_value;

    const totalChangePct = totalOriginalBudget > 0
      ? (totalChangeAmount / totalOriginalBudget) * 100
      : 0;

    return {
      ok: totalChangePct <= safetyGuards.max_total_daily_change_pct,
      totalChangePct
    };
  }

  /**
   * Verifica si estamos dentro de las horas de operación.
   */
  _isWithinOperatingHours() {
    const { start, end, timezone } = safetyGuards.active_hours;
    const now = moment().tz(timezone);
    const currentHour = now.hours();
    return currentHour >= start && currentHour < end;
  }

  /**
   * Rechaza una decisión y registra el evento de seguridad.
   */
  async _reject(decision, reason, eventType) {
    logger.warn(`Decisión rechazada [${eventType}]: ${reason} — ${decision.entity_name || decision.entity_id}`);

    await this._logSafetyEvent(eventType, 'warning', decision, reason);

    return {
      approved: false,
      modified: false,
      reason
    };
  }

  /**
   * Registra un evento de seguridad en MongoDB.
   */
  async _logSafetyEvent(eventType, severity, decision, description) {
    try {
      await SafetyEvent.create({
        event_type: eventType,
        severity,
        entity_id: decision.entity_id,
        entity_name: decision.entity_name,
        description,
        details: {
          action: decision.action,
          current_value: decision.current_value,
          proposed_value: decision.new_value
        }
      });
    } catch (error) {
      logger.error('Error registrando evento de seguridad:', error);
    }
  }
}

module.exports = GuardRail;
