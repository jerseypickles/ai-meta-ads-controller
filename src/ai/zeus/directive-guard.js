/**
 * Directive Guard — helper para que los agentes respeten las directivas
 * de Zeus escritas en lenguaje natural (avoid/alert/prioritize).
 *
 * Uso típico en agentes procedurales:
 *   const block = await isAgentBlocked('ares');
 *   if (block.blocked) {
 *     logger.info(`[ARES] Bloqueado por directiva: ${block.reason}`);
 *     return { skipped: true, reason: block.reason };
 *   }
 *
 * Uso en agentes LLM:
 *   const activeConstraints = await getActiveConstraints('apollo');
 *   // Inyectar en el system prompt como "CONSTRAINTS ACTIVAS"
 */

const ZeusDirective = require('../../db/models/ZeusDirective');
const logger = require('../../utils/logger');

/**
 * Chequea si hay directivas 'avoid' activas que bloquean la operación principal
 * del agente. Retorna { blocked, reason, directive_id } o { blocked: false }.
 *
 * Heurística: si existe cualquier directiva avoid activa, vigente (no expirada),
 * target=agent o target=all → bloquea. Simple pero efectivo.
 */
async function isAgentBlocked(agentName) {
  const now = new Date();
  const directives = await ZeusDirective.find({
    active: true,
    directive_type: 'avoid',
    $or: [
      { target_agent: agentName },
      { target_agent: 'all' }
    ],
    $and: [
      { $or: [{ expires_at: null }, { expires_at: { $gt: now } }] }
    ]
  }).sort({ confidence: -1 }).lean();

  if (directives.length === 0) {
    return { blocked: false };
  }

  const top = directives[0];
  return {
    blocked: true,
    reason: top.directive,
    directive_id: top._id,
    confidence: top.confidence,
    expires_at: top.expires_at,
    total_active: directives.length
  };
}

/**
 * Retorna todas las directivas activas vigentes para un agente (o 'all').
 * Formateadas como texto para inyectar en el prompt LLM del agente.
 */
async function getActiveConstraints(agentName) {
  const now = new Date();
  const directives = await ZeusDirective.find({
    active: true,
    $or: [
      { target_agent: agentName },
      { target_agent: 'all' }
    ],
    $and: [
      { $or: [{ expires_at: null }, { expires_at: { $gt: now } }] }
    ]
  }).sort({ directive_type: 1, confidence: -1 }).lean();

  if (directives.length === 0) return { directives: [], prompt_block: '' };

  const byType = { avoid: [], prioritize: [], adjust: [], alert: [], insight: [] };
  for (const d of directives) {
    const key = byType[d.directive_type] ? d.directive_type : 'alert';
    byType[key].push(d);
  }

  const lines = [];
  if (byType.avoid.length) {
    lines.push('NO HACER (directivas avoid activas):');
    for (const d of byType.avoid) {
      lines.push(`  ✗ ${d.directive}${d.expires_at ? ` (hasta ${new Date(d.expires_at).toLocaleString('es-AR')})` : ''}`);
    }
  }
  if (byType.prioritize.length) {
    lines.push('PRIORIZAR:');
    for (const d of byType.prioritize) lines.push(`  ✓ ${d.directive}`);
  }
  if (byType.adjust.length) {
    lines.push('AJUSTES:');
    for (const d of byType.adjust) lines.push(`  · ${d.directive}`);
  }
  if (byType.alert.length) {
    lines.push('CONTEXTO/ALERTAS:');
    for (const d of byType.alert) lines.push(`  ! ${d.directive}`);
  }

  return {
    directives,
    prompt_block: lines.length ? '\n\n═══ DIRECTIVAS ACTIVAS DE ZEUS (respetar) ═══\n' + lines.join('\n') + '\n═══════════════════════════════════════════════\n' : ''
  };
}

module.exports = { isAgentBlocked, getActiveConstraints };
