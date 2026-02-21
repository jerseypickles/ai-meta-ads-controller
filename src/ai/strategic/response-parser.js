const logger = require('../../utils/logger');

const VALID_INSIGHT_TYPES = [
  'creative_refresh', 'structure_change', 'audience_insight',
  'copy_strategy', 'platform_alert', 'attribution_insight',
  'testing_suggestion', 'seasonal_strategy', 'budget_strategy',
  'scaling_playbook', 'competitive_insight', 'general'
];

const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low'];
const VALID_HEALTH = ['strong', 'stable', 'warning', 'critical'];
const VALID_ACTIONS = ['scale_up', 'scale_down', 'pause', 'reactivate'];
const VALID_DIRECTIVE_TYPES = ['boost', 'suppress', 'override', 'protect'];
const VALID_TARGET_ACTIONS = ['scale_up', 'scale_down', 'pause', 'reactivate', 'any'];

/**
 * Parsea la respuesta de Claude del agente estrategico.
 * Espera JSON con la estructura definida en strategic-prompts.js.
 */
function parseStrategicResponse(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    logger.error('[STRATEGIC_PARSER] Respuesta vacia o invalida');
    return null;
  }

  let cleaned = rawText.trim();

  // Remover bloques de codigo markdown
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // Si hay texto antes del JSON, extraer solo el JSON
  const jsonStartIdx = cleaned.indexOf('{');
  if (jsonStartIdx > 0) {
    cleaned = cleaned.substring(jsonStartIdx);
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // Intentar extraer JSON de texto mixto (buscar el objeto mas externo)
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch (e2) {
        // Intentar reparar JSON truncado (por max_tokens)
        parsed = _tryRepairTruncatedJson(jsonMatch[0]);
        if (!parsed) {
          logger.error(`[STRATEGIC_PARSER] No se pudo parsear respuesta como JSON. Primeros 300 chars: ${cleaned.substring(0, 300)}`);
          return null;
        }
        logger.warn('[STRATEGIC_PARSER] JSON reparado (estaba truncado)');
      }
    } else {
      // Ultimo intento: reparar JSON sin cierre
      parsed = _tryRepairTruncatedJson(cleaned);
      if (!parsed) {
        logger.error(`[STRATEGIC_PARSER] No se encontro JSON valido. Primeros 300 chars: ${cleaned.substring(0, 300)}`);
        return null;
      }
      logger.warn('[STRATEGIC_PARSER] JSON reparado (sin cierre)');
    }
  }

  // Aceptar ambos nombres de campo (account_summary o executive_summary)
  const summary = parsed.account_summary || parsed.executive_summary || 'Sin resumen disponible';

  // Normalizar account_health: el prompt puede devolver "healthy" que mapeamos a "stable"
  let health = parsed.account_health || 'stable';
  if (health === 'healthy') health = 'stable';
  if (!VALID_HEALTH.includes(health)) health = 'stable';

  const result = {
    account_summary: String(summary),
    account_health: health,
    research_notes: parsed.research_notes ? String(parsed.research_notes) : null,
    insights: [],
    alerts: [],
    directives: []
  };

  // Parsear insights
  if (Array.isArray(parsed.insights)) {
    result.insights = parsed.insights
      .map(i => validateInsight(i))
      .filter(Boolean);
  }

  // Parsear alertas
  if (Array.isArray(parsed.alerts)) {
    result.alerts = parsed.alerts
      .map(a => validateAlert(a))
      .filter(Boolean);
  }

  // Parsear directivas estrategicas
  if (Array.isArray(parsed.directives)) {
    result.directives = parsed.directives
      .map(d => validateDirective(d))
      .filter(Boolean);
  }

  logger.info(`[STRATEGIC_PARSER] Parseado: ${result.insights.length} insights, ${result.directives.length} directivas, ${result.alerts.length} alertas, salud: ${result.account_health}`);

  return result;
}

/**
 * Valida y limpia un insight individual.
 */
function validateInsight(insight) {
  if (!insight || typeof insight !== 'object') return null;

  const insightType = VALID_INSIGHT_TYPES.includes(insight.insight_type)
    ? insight.insight_type : 'general';

  const severity = VALID_SEVERITIES.includes(insight.severity)
    ? insight.severity : 'medium';

  if (!insight.title || !insight.analysis || !insight.recommendation) {
    logger.debug('[STRATEGIC_PARSER] Insight descartado: faltan campos requeridos');
    return null;
  }

  const clean = {
    insight_type: insightType,
    severity,
    title: String(insight.title).slice(0, 200),
    analysis: String(insight.analysis).slice(0, 2000),
    recommendation: String(insight.recommendation).slice(0, 2000),
    evidence: Array.isArray(insight.evidence)
      ? insight.evidence.map(e => String(e)).slice(0, 10)
      : [],
    affected_entities: [],
    actionable: !!insight.actionable,
    auto_action: null,
    creative_context: []
  };

  // Validar entidades afectadas
  if (Array.isArray(insight.affected_entities)) {
    clean.affected_entities = insight.affected_entities
      .filter(e => e && e.entity_id)
      .map(e => ({
        entity_type: ['campaign', 'adset', 'ad', 'account'].includes(e.entity_type)
          ? e.entity_type : 'adset',
        entity_id: String(e.entity_id),
        entity_name: String(e.entity_name || '')
      }))
      .slice(0, 20);
  }

  // Validar accion automatica
  if (insight.actionable && insight.auto_action) {
    const aa = insight.auto_action;
    if (VALID_ACTIONS.includes(aa.action) && aa.entity_id) {
      clean.auto_action = {
        action: aa.action,
        entity_type: aa.entity_type || 'adset',
        entity_id: String(aa.entity_id),
        value: parseFloat(aa.value) || null
      };
    }
  }

  // Contexto creativo
  if (Array.isArray(insight.creative_context)) {
    clean.creative_context = insight.creative_context
      .filter(c => c && c.ad_id)
      .map(c => ({
        ad_id: String(c.ad_id),
        ad_name: String(c.ad_name || ''),
        headline: String(c.headline || ''),
        body: String(c.body || ''),
        cta: String(c.cta || ''),
        image_url: String(c.image_url || '')
      }))
      .slice(0, 10);
  }

  return clean;
}

/**
 * Valida una alerta.
 */
function validateAlert(alert) {
  if (!alert || typeof alert !== 'object') return null;
  if (!alert.message) return null;

  return {
    type: String(alert.type || 'info'),
    message: String(alert.message).slice(0, 500),
    severity: VALID_SEVERITIES.includes(alert.severity) ? alert.severity : 'medium'
  };
}

/**
 * Valida una directiva estrategica.
 */
function validateDirective(directive) {
  if (!directive || typeof directive !== 'object') return null;
  if (!directive.entity_id || !directive.directive_type) return null;

  const directiveType = VALID_DIRECTIVE_TYPES.includes(directive.directive_type)
    ? directive.directive_type : null;
  if (!directiveType) return null;

  const targetAction = VALID_TARGET_ACTIONS.includes(directive.target_action)
    ? directive.target_action : 'any';

  let scoreModifier = parseFloat(directive.score_modifier) || 0;
  scoreModifier = Math.max(-0.5, Math.min(0.5, scoreModifier));

  // Defaults por tipo de directiva
  if (directiveType === 'boost' && scoreModifier === 0) scoreModifier = 0.15;
  if (directiveType === 'suppress' && scoreModifier === 0) scoreModifier = -0.15;

  return {
    directive_type: directiveType,
    entity_type: ['adset', 'ad', 'campaign'].includes(directive.entity_type)
      ? directive.entity_type : 'adset',
    entity_id: String(directive.entity_id),
    entity_name: String(directive.entity_name || ''),
    target_action: targetAction,
    score_modifier: scoreModifier,
    reason: String(directive.reason || '').slice(0, 500),
    confidence: ['high', 'medium', 'low'].includes(directive.confidence)
      ? directive.confidence : 'medium'
  };
}

/**
 * Intenta reparar un JSON truncado (cortado por max_tokens).
 * Cierra brackets/braces abiertos y parsea lo que se pueda.
 */
function _tryRepairTruncatedJson(text) {
  if (!text || !text.startsWith('{')) return null;

  try {
    // Buscar el ultimo insight completo antes del corte
    // Estrategia: cortar en la ultima "}" que cierra un objeto de insight,
    // cerrar el array de insights y el objeto raiz
    let repaired = text;

    // Contar brackets abiertos vs cerrados
    let braces = 0;
    let brackets = 0;
    let inString = false;
    let escape = false;

    for (let i = 0; i < repaired.length; i++) {
      const ch = repaired[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') braces++;
      if (ch === '}') braces--;
      if (ch === '[') brackets++;
      if (ch === ']') brackets--;
    }

    // Cerrar lo que falte
    while (brackets > 0) { repaired += ']'; brackets--; }
    while (braces > 0) { repaired += '}'; braces--; }

    return JSON.parse(repaired);
  } catch (e) {
    // Segundo intento: cortar en la ultima llave de cierre valida
    try {
      const lastBrace = text.lastIndexOf('}');
      if (lastBrace > 0) {
        let truncated = text.substring(0, lastBrace + 1);
        // Cerrar brackets faltantes
        let brackets = 0;
        let inStr = false;
        let esc = false;
        for (let i = 0; i < truncated.length; i++) {
          const ch = truncated[i];
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (ch === '[') brackets++;
          if (ch === ']') brackets--;
        }
        while (brackets > 0) { truncated += ']'; brackets--; }
        // Cerrar objeto raiz si necesario
        let braces = 0;
        inStr = false;
        esc = false;
        for (let i = 0; i < truncated.length; i++) {
          const ch = truncated[i];
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (ch === '{') braces++;
          if (ch === '}') braces--;
        }
        while (braces > 0) { truncated += '}'; braces--; }
        return JSON.parse(truncated);
      }
    } catch (e2) {
      // No se pudo reparar
    }
    return null;
  }
}

module.exports = { parseStrategicResponse };
