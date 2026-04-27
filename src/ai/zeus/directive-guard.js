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

  // 2026-04-27: ignorar directivas que tienen action_scope (esas son
  // granulares, las maneja isActionBlockedForAgent con scope específico).
  // isAgentBlocked solo bloquea ciclo completo si hay directiva GENÉRICA
  // (sin action_scope) — equivalente a "blocked all actions".
  const blockingDirectives = directives.filter(d =>
    !Array.isArray(d.action_scope) || d.action_scope.length === 0
  );

  if (blockingDirectives.length === 0) {
    return { blocked: false };
  }

  const top = blockingDirectives[0];
  return {
    blocked: true,
    reason: top.directive,
    directive_id: top._id,
    confidence: top.confidence,
    expires_at: top.expires_at,
    total_active: blockingDirectives.length
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

/**
 * Parser de texto de directiva → Set de action_types que bloquea.
 * Heurística por keywords. Si no hay match claro, default conservador:
 * bloquea solo el action más literal de la categoría.
 *
 * Agregado 2026-04-23 para dar granularidad al ares-portfolio-manager —
 * una directiva "no new duplications" no debería bloquear kills ni scales.
 */
function parseBlockedActions(directiveText) {
  const t = (directiveText || '').toLowerCase();
  const blocked = new Set();

  // Duplicaciones
  if (/\bduplic/.test(t) || /\bclone/.test(t) || /no new/.test(t)) {
    blocked.add('duplicate_adset');
    blocked.add('fast_track_duplicate');
  }
  // Pauses / kills
  if (/\bpaus/.test(t) || /\bkill/.test(t)) {
    blocked.add('pause');
    blocked.add('update_ad_status');
  }
  // Budget changes
  if (/\bbudget\b/.test(t) || /\bscale\b/.test(t) || /\bescalar\b/.test(t)) {
    blocked.add('scale_up');
    blocked.add('scale_down');
    blocked.add('move_budget');
  }
  // Creative changes
  if (/\bcreativ/.test(t) || /\brefresh\b/.test(t)) {
    blocked.add('creative_refresh');
    blocked.add('create_ad');
    blocked.add('update_ad_creative');
  }
  // Tests
  if (/\btest/.test(t) || /\blaunch\b/.test(t) || /\blanzar\b/.test(t)) {
    blocked.add('launch_test');
    blocked.add('graduate');
  }

  // Si no matcheó ningún keyword específico, es una directiva genérica →
  // bloquear TODO por seguridad (patrón actual pre-granularidad).
  if (blocked.size === 0) {
    return { scope: 'all', actions: null };
  }

  return { scope: 'specific', actions: blocked };
}

/**
 * Como isAgentBlocked pero con granularidad por action_type.
 * Retorna blocked=true SOLO si alguna directiva avoid activa incluye
 * ese action específico en su scope (parseado del texto).
 *
 * Uso:
 *   const block = await isActionBlockedForAgent('ares', 'pause');
 *   if (block.blocked) skip;
 */
async function isActionBlockedForAgent(agentName, actionType) {
  const now = new Date();
  const directives = await ZeusDirective.find({
    active: true,
    directive_type: 'avoid',
    $or: [{ target_agent: agentName }, { target_agent: 'all' }],
    $and: [{ $or: [{ expires_at: null }, { expires_at: { $gt: now } }] }]
  }).sort({ confidence: -1 }).lean();

  if (directives.length === 0) return { blocked: false };

  for (const d of directives) {
    // PRIORITY 1: action_scope structured (añadido 2026-04-24)
    // Si la directiva declara scope explícito, usarlo tal cual — sin parse.
    if (Array.isArray(d.action_scope) && d.action_scope.length > 0) {
      if (d.action_scope.includes(actionType)) {
        return {
          blocked: true,
          reason: d.directive,
          directive_id: d._id,
          scope: 'structured',
          blocked_actions: d.action_scope,
          llm_can_override: !!d.llm_can_override,
          source: d.source
        };
      }
      // action_scope definido pero NO incluye esta action → libre
      continue;
    }

    // PRIORITY 2 (fallback retrocompat): parse del texto
    const parsed = parseBlockedActions(d.directive);
    if (parsed.scope === 'all') {
      return {
        blocked: true,
        reason: d.directive,
        directive_id: d._id,
        scope: 'all_actions_genericamente',
        llm_can_override: !!d.llm_can_override,
        source: d.source
      };
    }
    if (parsed.actions.has(actionType)) {
      return {
        blocked: true,
        reason: d.directive,
        directive_id: d._id,
        scope: 'specific',
        blocked_actions: Array.from(parsed.actions),
        llm_can_override: !!d.llm_can_override,
        source: d.source
      };
    }
  }

  return { blocked: false };
}

module.exports = { isAgentBlocked, isActionBlockedForAgent, getActiveConstraints, parseBlockedActions };
