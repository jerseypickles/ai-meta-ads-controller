const logger = require('../utils/logger');

const VALID_ACTIONS = ['scale_up', 'scale_down', 'pause', 'reactivate', 'no_action'];
const VALID_ENTITY_TYPES = ['adset', 'ad'];
const VALID_CONFIDENCE = ['high', 'medium', 'low'];
const VALID_PRIORITY = ['critical', 'high', 'medium', 'low'];
const VALID_SEVERITY = ['critical', 'warning', 'info'];

/**
 * Parsea y valida la respuesta JSON de Claude.
 * Retorna un objeto estructurado o null si es inválido.
 */
function parseResponse(rawText) {
  try {
    // Limpiar posible markdown wrapping
    let cleaned = rawText.trim();

    // Remover ```json ... ``` si Claude lo envuelve
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    const parsed = JSON.parse(cleaned);

    // Validar estructura principal
    if (!parsed || typeof parsed !== 'object') {
      logger.error('Respuesta de Claude no es un objeto JSON');
      return null;
    }

    // Validar campos requeridos
    const result = {
      analysis_summary: parsed.analysis_summary || 'Sin resumen',
      total_daily_spend: parseFloat(parsed.total_daily_spend) || 0,
      account_roas: parseFloat(parsed.account_roas) || 0,
      decisions: [],
      alerts: []
    };

    // Validar y limpiar cada decisión
    if (Array.isArray(parsed.decisions)) {
      result.decisions = parsed.decisions
        .map(d => validateDecision(d))
        .filter(d => d !== null);
    }

    // Validar alertas
    if (Array.isArray(parsed.alerts)) {
      result.alerts = parsed.alerts
        .map(a => validateAlert(a))
        .filter(a => a !== null);
    }

    logger.info(`Respuesta parseada: ${result.decisions.length} decisiones, ${result.alerts.length} alertas`);
    return result;
  } catch (error) {
    logger.error('Error parseando respuesta de Claude:', {
      error: error.message,
      raw: rawText.substring(0, 500)
    });
    return null;
  }
}

/**
 * Valida una decisión individual.
 */
function validateDecision(decision) {
  if (!decision || typeof decision !== 'object') return null;

  // Validar action
  if (!VALID_ACTIONS.includes(decision.action)) {
    logger.warn(`Acción inválida: ${decision.action}`);
    return null;
  }

  // Validar entity_type
  if (!VALID_ENTITY_TYPES.includes(decision.entity_type)) {
    logger.warn(`Tipo de entidad inválido: ${decision.entity_type}`);
    return null;
  }

  // Validar entity_id
  if (!decision.entity_id || typeof decision.entity_id !== 'string') {
    logger.warn('Decision sin entity_id válido');
    return null;
  }

  // Construir decisión limpia
  const clean = {
    action: decision.action,
    entity_type: decision.entity_type,
    entity_id: String(decision.entity_id),
    entity_name: String(decision.entity_name || 'Sin nombre'),
    campaign_name: String(decision.campaign_name || ''),
    current_value: decision.current_value != null ? parseFloat(decision.current_value) : 0,
    new_value: decision.new_value != null ? parseFloat(decision.new_value) : 0,
    change_percent: parseFloat(decision.change_percent) || 0,
    reasoning: String(decision.reasoning || 'Sin razón proporcionada'),
    confidence: VALID_CONFIDENCE.includes(decision.confidence) ? decision.confidence : 'low',
    priority: VALID_PRIORITY.includes(decision.priority) ? decision.priority : 'low',
    metrics_snapshot: {}
  };

  // Validar metrics_snapshot
  if (decision.metrics_snapshot && typeof decision.metrics_snapshot === 'object') {
    clean.metrics_snapshot = {
      roas_3d: parseFloat(decision.metrics_snapshot.roas_3d) || 0,
      roas_7d: parseFloat(decision.metrics_snapshot.roas_7d) || 0,
      cpa_3d: parseFloat(decision.metrics_snapshot.cpa_3d) || 0,
      spend_today: parseFloat(decision.metrics_snapshot.spend_today) || 0,
      frequency: parseFloat(decision.metrics_snapshot.frequency) || 0,
      ctr: parseFloat(decision.metrics_snapshot.ctr) || 0
    };
  }

  // Validar coherencia: scale_up/scale_down deben tener valores
  if (['scale_up', 'scale_down'].includes(clean.action)) {
    if (clean.current_value <= 0 || clean.new_value <= 0) {
      logger.warn(`Decisión de ${clean.action} sin valores válidos para ${clean.entity_name}`);
      return null;
    }

    // Recalcular change_percent para seguridad
    if (clean.current_value > 0) {
      clean.change_percent = ((clean.new_value - clean.current_value) / clean.current_value) * 100;
    }
  }

  return clean;
}

/**
 * Valida una alerta.
 */
function validateAlert(alert) {
  if (!alert || typeof alert !== 'object') return null;

  return {
    type_name: String(alert.type || alert.type_name || 'unknown'),
    message: String(alert.message || 'Sin mensaje'),
    severity: VALID_SEVERITY.includes(alert.severity) ? alert.severity : 'info'
  };
}

module.exports = { parseResponse, validateDecision, validateAlert };
