const ActionLog = require('../db/models/ActionLog');
const logger = require('../utils/logger');

const COOLDOWN_DAYS = 3;
const MIN_HOURS_BETWEEN_ACTIONS = 24;

class CooldownManager {
  /**
   * Verifica si algún agente (brain, ai_manager, anomaly_detector) actuó
   * sobre esta entidad en las últimas N horas. Esto es el "tiempo de respiración"
   * mínimo entre cualquier acción — independiente del cooldown largo de 3 días.
   *
   * Meta Ads necesita mínimo 24h para atribuir conversiones y estabilizar delivery.
   * Actuar más seguido es ruido.
   *
   * @param {string} entityId
   * @param {number} hours - Mínimo de horas entre acciones (default 24)
   * @returns {Object} { hasRecent, hoursAgo, lastAction, lastAgent }
   */
  async hasRecentAction(entityId, hours = MIN_HOURS_BETWEEN_ACTIONS) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const lastAction = await ActionLog.findOne({
      entity_id: entityId,
      success: true,
      executed_at: { $gte: since }
    })
      .sort({ executed_at: -1 })
      .lean();

    if (!lastAction) return { hasRecent: false };

    const hoursAgo = Math.round((Date.now() - new Date(lastAction.executed_at).getTime()) / (1000 * 60 * 60));
    return {
      hasRecent: true,
      hoursAgo,
      lastAction: lastAction.action,
      lastAgent: lastAction.agent_type || _extractAgent(lastAction.reasoning),
      executedAt: lastAction.executed_at
    };
  }

  /**
   * Verifica si una entidad está en período de cooldown.
   * Basado en ActionLog: si hay una acción exitosa en los últimos 3 días, está en cooldown.
   */
  async isOnCooldown(entityId) {
    const since = new Date();
    since.setDate(since.getDate() - COOLDOWN_DAYS);

    const lastAction = await ActionLog.findOne({
      entity_id: entityId,
      success: true,
      executed_at: { $gte: since }
    })
      .sort({ executed_at: -1 })
      .lean();

    if (!lastAction) return { onCooldown: false };

    const cooldownUntil = new Date(lastAction.executed_at);
    cooldownUntil.setDate(cooldownUntil.getDate() + COOLDOWN_DAYS);

    const now = new Date();
    if (cooldownUntil > now) {
      const hoursLeft = Math.round((cooldownUntil - now) / (1000 * 60 * 60));
      const minutesLeft = Math.round((cooldownUntil - now) / (1000 * 60));
      return {
        onCooldown: true,
        cooldownUntil,
        hoursLeft,
        minutesLeft,
        lastAction: lastAction.action,
        lastAgent: _extractAgent(lastAction.reasoning),
        executedAt: lastAction.executed_at
      };
    }

    return { onCooldown: false };
  }

  /**
   * setCooldown ya no necesita hacer nada — el cooldown se deriva del ActionLog automáticamente.
   * Se mantiene la firma para compatibilidad.
   */
  async setCooldown(entityId, entityType, action, modifiedBy = 'ai') {
    logger.debug(`Cooldown de ${COOLDOWN_DAYS} días activo para ${entityId} (basado en ActionLog)`);
  }

  /**
   * Obtiene todos los cooldowns activos basados en ActionLog.
   */
  async getActiveCooldowns() {
    const since = new Date();
    since.setDate(since.getDate() - COOLDOWN_DAYS);

    // Obtener la acción más reciente por entity_id
    const actions = await ActionLog.aggregate([
      {
        $match: {
          success: true,
          executed_at: { $gte: since }
        }
      },
      {
        $sort: { executed_at: -1 }
      },
      {
        $group: {
          _id: '$entity_id',
          entity_type: { $first: '$entity_type' },
          entity_name: { $first: '$entity_name' },
          last_action: { $first: '$action' },
          executed_at: { $first: '$executed_at' },
          reasoning: { $first: '$reasoning' }
        }
      }
    ]);

    const now = new Date();
    return actions
      .map(a => {
        const cooldownUntil = new Date(a.executed_at);
        cooldownUntil.setDate(cooldownUntil.getDate() + COOLDOWN_DAYS);
        const hoursLeft = Math.round((cooldownUntil - now) / (1000 * 60 * 60));
        return {
          entity_id: a._id,
          entity_type: a.entity_type,
          entity_name: a.entity_name,
          last_action: a.last_action,
          executed_at: a.executed_at,
          cooldown_until: cooldownUntil,
          hours_left: hoursLeft,
          agent: _extractAgent(a.reasoning)
        };
      })
      .filter(a => a.cooldown_until > now);
  }

  /**
   * "Limpiar" cooldown de una entidad — no aplica porque se basa en ActionLog.
   * Para forzar, habría que borrar la entrada del ActionLog (no recomendado).
   */
  async clearCooldown(entityId) {
    logger.info(`Cooldown clear solicitado para ${entityId} — con ActionLog-based cooldown no hay nada que borrar`);
  }

  /**
   * cleanupExpired — no necesario con ActionLog-based cooldown.
   */
  async cleanupExpired() {
    // No-op: el cooldown se calcula dinámicamente desde ActionLog
  }
}

function _extractAgent(reasoning) {
  if (!reasoning) return 'unknown';
  const match = reasoning.match(/^\[(\w+)\]/);
  return match ? match[1].toLowerCase() : 'unknown';
}

module.exports = { CooldownManager, COOLDOWN_DAYS, MIN_HOURS_BETWEEN_ACTIONS };
