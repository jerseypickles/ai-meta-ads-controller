/**
 * Mantenimiento de directivas — cron nightly que marca active=false a las
 * directivas expiradas, EXCEPTO las marcadas como persistent (reglas estables).
 *
 * Sin esto, las expires_at < now quedan como zombies con active=true en DB.
 * Los filtros de agentes las excluyen por expires_at, pero se acumulan y
 * ensucian queries + scans.
 *
 * Diseño:
 *   1. Encontrar directivas con active=true, expires_at<now, persistent!=true
 *   2. updateMany → active=false, last_validated_at=now, data.auto_deactivated=true
 *   3. Loggear count + muestra para que Zeus lo pueda reportar si se acumula
 */

const ZeusDirective = require('../../db/models/ZeusDirective');
const logger = require('../../utils/logger');

async function runDirectiveCleanup() {
  const now = new Date();

  // Directivas expiradas pero todavía active=true
  // Excluir persistent=true (esas sobreviven al cleanup por diseño)
  const filter = {
    active: true,
    expires_at: { $ne: null, $lt: now },
    persistent: { $ne: true }
  };

  const zombies = await ZeusDirective.find(filter).limit(500).lean();

  if (zombies.length === 0) {
    logger.info('[DIR-CLEANUP] nada que limpiar — no hay zombies');
    return { deactivated: 0, sample: [] };
  }

  const result = await ZeusDirective.updateMany(filter, {
    $set: {
      active: false,
      last_validated_at: now,
      'data.auto_deactivated': true,
      'data.auto_deactivated_at': now,
      'data.auto_deactivated_reason': 'expired — cleaned by directive-maintenance cron'
    }
  });

  const sample = zombies.slice(0, 5).map(z => ({
    id: z._id.toString(),
    agent: z.target_agent,
    type: z.directive_type,
    source: z.source || 'system',
    expired: z.expires_at,
    directive: (z.directive || '').substring(0, 80)
  }));

  logger.info(`[DIR-CLEANUP] ${result.modifiedCount || result.nModified || 0} directivas zombies desactivadas (de ${zombies.length} encontradas, cap 500)`);

  return {
    deactivated: result.modifiedCount || result.nModified || 0,
    total_found: zombies.length,
    sample
  };
}

module.exports = { runDirectiveCleanup };
