const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const AgentReport = require('../../db/models/AgentReport');
const ActionLog = require('../../db/models/ActionLog');
const ResearchModule = require('../strategic/research-module');
const logger = require('../../utils/logger');

const VALID_ACTIONS = [
  'scale_up', 'scale_down', 'pause', 'reactivate', 'no_action',
  'duplicate_adset', 'create_ad', 'update_bid_strategy',
  'update_ad_status', 'move_budget', 'update_ad_creative'
];
const VALID_CONFIDENCE = ['high', 'medium', 'low'];
const VALID_PRIORITY = ['critical', 'high', 'medium', 'low'];

class BaseAgent {
  constructor(agentType) {
    this.agentType = agentType;
    this.anthropic = new Anthropic({ apiKey: config.claude.apiKey });
    this.researchModule = new ResearchModule();
  }

  /**
   * Metodo principal. Cada agente lo implementa.
   * Ahora incluye deep research integrado.
   * @param {Object} sharedData - Datos cargados por el AgentRunner
   * @returns {AgentReport} Reporte guardado en MongoDB
   */
  async analyze(sharedData) {
    const startTime = Date.now();
    logger.info(`[${this.agentType.toUpperCase()}] Iniciando analisis...`);

    try {
      // Deep research (cada agente define sus queries)
      let researchContext = '';
      let researchSources = [];
      try {
        const research = await this._conductResearch(sharedData);
        if (research && research.insights && research.insights.length > 0) {
          researchContext = research.insights
            .map(i => i.summary)
            .filter(Boolean)
            .join('\n\n');
          researchSources = research.sources || [];
          logger.info(`[${this.agentType.toUpperCase()}] Research: ${research.insights.length} insights obtenidos`);
        }
      } catch (researchErr) {
        logger.warn(`[${this.agentType.toUpperCase()}] Research falló (continuando sin él): ${researchErr.message}`);
      }

      const systemPrompt = this.getSystemPrompt();
      let userPrompt = this.buildUserPrompt(sharedData);

      // Inyectar research context en el prompt
      if (researchContext) {
        userPrompt += `\n\nINVESTIGACION WEB RECIENTE (usa esto para informar tus decisiones):
${researchContext}`;
      }

      const response = await this._callClaude(systemPrompt, userPrompt);
      if (!response) {
        logger.warn(`[${this.agentType.toUpperCase()}] Sin respuesta de Claude`);
        return null;
      }

      const parsed = this._parseResponse(response.text);
      if (!parsed) {
        logger.warn(`[${this.agentType.toUpperCase()}] No se pudo parsear respuesta`);
        return null;
      }

      // Filtrar recomendaciones por cooldown activo
      const validRecs = (parsed.recommendations || [])
        .map(r => this._validateRecommendation(r, sharedData, researchSources))
        .filter(Boolean);

      const cooldownEntityIds = (sharedData.activeCooldowns || []).map(c => c.entity_id);
      const filteredRecs = validRecs.filter(r => {
        if (cooldownEntityIds.includes(r.entity_id)) {
          logger.info(`[${this.agentType.toUpperCase()}] Recomendacion filtrada por cooldown: ${r.entity_name} (${r.entity_id})`);
          return false;
        }
        return true;
      });

      // Guardar reporte
      const report = await AgentReport.create({
        agent_type: this.agentType,
        cycle_id: sharedData.cycleId,
        summary: parsed.summary || 'Sin resumen',
        status: ['healthy', 'warning', 'critical'].includes(parsed.status) ? parsed.status : 'healthy',
        recommendations: filteredRecs,
        alerts: (parsed.alerts || []).map(a => this._validateAlert(a)).filter(Boolean),
        prompt_tokens: response.usage?.input_tokens || 0,
        completion_tokens: response.usage?.output_tokens || 0
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`[${this.agentType.toUpperCase()}] Completado en ${elapsed}s — ${report.recommendations.length} recomendaciones, status: ${report.status}`);

      return report;
    } catch (error) {
      logger.error(`[${this.agentType.toUpperCase()}] Error: ${error.message || error.status || JSON.stringify(error)}`);
      return null;
    }
  }

  /**
   * Subclases deben implementar estos metodos.
   */
  getSystemPrompt() {
    throw new Error('getSystemPrompt() debe ser implementado por la subclase');
  }

  buildUserPrompt(sharedData) {
    throw new Error('buildUserPrompt() debe ser implementado por la subclase');
  }

  /**
   * Override por cada agente para queries de investigación específicos.
   * Retorna un objeto con los flags de contexto de la cuenta.
   */
  getResearchContext(sharedData) {
    return {}; // Por defecto no investiga
  }

  /**
   * Ejecuta deep research usando el ResearchModule.
   */
  async _conductResearch(sharedData) {
    const ctx = this.getResearchContext(sharedData);
    if (!ctx || Object.keys(ctx).length === 0) return { insights: [], sources: [] };
    return this.researchModule.research(ctx);
  }

  /**
   * Llama a Claude con retry simple.
   */
  async _callClaude(systemPrompt, userPrompt) {
    try {
      const message = await this.anthropic.messages.create({
        model: config.claude.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      });

      return {
        text: message.content[0].text,
        usage: message.usage
      };
    } catch (error) {
      if (error.status === 429) {
        logger.warn(`[${this.agentType.toUpperCase()}] Rate limit, esperando 15s...`);
        await new Promise(r => setTimeout(r, 15000));
        try {
          const retry = await this.anthropic.messages.create({
            model: config.claude.model,
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }]
          });
          return { text: retry.content[0].text, usage: retry.usage };
        } catch (retryErr) {
          logger.error(`[${this.agentType.toUpperCase()}] Retry fallido:`, retryErr.message);
          return null;
        }
      }
      logger.error(`[${this.agentType.toUpperCase()}] Error Claude: ${error.message || error.status || JSON.stringify(error)}`);
      return null;
    }
  }

  /**
   * Parsea la respuesta JSON de Claude.
   */
  _parseResponse(rawText) {
    try {
      let cleaned = rawText.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      // Try to extract JSON object if Claude added extra text
      if (!cleaned.startsWith('{')) {
        const jsonStart = cleaned.indexOf('{');
        const jsonEnd = cleaned.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1) {
          cleaned = cleaned.substring(jsonStart, jsonEnd + 1);
        }
      }
      const parsed = JSON.parse(cleaned);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (error) {
      logger.error(`[${this.agentType.toUpperCase()}] Error parseando JSON: ${error.message}`);
      logger.error(`[${this.agentType.toUpperCase()}] Raw (first 500 chars): ${rawText.substring(0, 500)}`);
      return null;
    }
  }

  /**
   * Genera la seccion de acciones recientes para el prompt del agente.
   */
  _buildRecentActionsContext(sharedData) {
    const { recentActions, activeCooldowns } = sharedData;
    if (!recentActions || recentActions.length === 0) return '';

    const actionLines = recentActions.map(a => {
      const daysAgo = ((Date.now() - new Date(a.executed_at).getTime()) / (1000 * 60 * 60 * 24)).toFixed(1);
      return `- ${a.entity_name} (${a.entity_id}): ${a.action} | Budget: $${a.before_value} -> $${a.after_value} | Hace ${daysAgo} dias`;
    }).join('\n');

    const cooldownIds = (activeCooldowns || []).map(c => c.entity_id);
    const cooldownList = cooldownIds.length > 0
      ? `\nEntidades con cooldown activo (NO recomendar cambios): ${cooldownIds.join(', ')}`
      : '';

    return `\n\nACCIONES RECIENTES (ultimos 3 dias):
${actionLines}${cooldownList}
IMPORTANTE: NO recomiendes cambios en entidades que fueron modificadas en los ultimos 3 dias. Necesitan tiempo para estabilizarse.`;
  }

  /**
   * Genera contexto de feedback de impacto POR AGENTE.
   * Cada agente recibe sus propias acciones pasadas con resultados medidos,
   * un resumen estadístico y patrones de aprendizaje.
   */
  _buildImpactFeedbackContext(sharedData) {
    const agentFeedback = sharedData.agentFeedback;
    if (!agentFeedback) {
      // Fallback: usar impactHistory genérico si no hay feedback por agente
      return this._buildGenericImpactFeedback(sharedData);
    }

    const myFeedback = agentFeedback[this.agentType];
    if (!myFeedback || myFeedback.actions.length === 0) return '';

    const { actions, summary, patternsByAction } = myFeedback;

    // Líneas individuales de cada acción medida
    const actionLines = actions.map(a => {
      const daysAgo = Math.round((Date.now() - new Date(a.executed_at).getTime()) / (1000 * 60 * 60 * 24));
      const budgetStr = ['scale_up', 'scale_down', 'move_budget'].includes(a.action)
        ? ` $${a.before_value} -> $${a.after_value}` : '';
      return `- ${a.entity_name}: ${a.action}${budgetStr} (hace ${daysAgo}d) | resultado: ${a.result} | ROAS: ${a.roas_before.toFixed(2)}x -> ${a.roas_after.toFixed(2)}x (${a.delta_roas_pct > 0 ? '+' : ''}${a.delta_roas_pct}%) | CPA: $${a.cpa_before.toFixed(2)} -> $${a.cpa_after.toFixed(2)} (${a.delta_cpa_pct > 0 ? '+' : ''}${a.delta_cpa_pct}%)`;
    }).join('\n');

    // Resumen estadístico
    const summaryStr = `Total acciones medidas: ${summary.total_measured} | Mejoraron: ${summary.improved} (${summary.success_rate_pct}%) | Empeoraron: ${summary.worsened} | Neutras: ${summary.neutral} | Promedio ROAS delta: ${summary.avg_roas_delta > 0 ? '+' : ''}${summary.avg_roas_delta}%`;

    // Patrones por tipo de acción
    let patternsStr = '';
    if (Object.keys(patternsByAction).length > 0) {
      const patternLines = Object.entries(patternsByAction).map(([action, stats]) => {
        return `  ${action}: ${stats.total} veces, ${stats.improved} mejoraron (${stats.success_rate}%), promedio ROAS delta: ${stats.avg_delta > 0 ? '+' : ''}${stats.avg_delta}%`;
      }).join('\n');
      patternsStr = `\nPATRONES POR TIPO DE ACCION:\n${patternLines}`;
    }

    return `\n\nFEEDBACK LOOP — TUS ACCIONES PASADAS Y SUS RESULTADOS:
${summaryStr}
${patternsStr}

HISTORIAL DETALLADO (ultimas ${actions.length} acciones medidas):
${actionLines}

INSTRUCCIONES DE APRENDIZAJE:
- Si tu tasa de exito es ALTA (>60%), sigue con tu estrategia actual. Si es BAJA (<40%), cambia de enfoque.
- Mira los patrones por tipo de accion: si "scale_up" tiene exito alto pero "pause" tiene exito bajo, ajusta en consecuencia.
- Busca patrones en que ENTIDADES respondieron bien vs mal a tus acciones. Repite lo que funciono, evita lo que fallo.
- El delta de ROAS promedio te indica tu impacto neto. Si es negativo, estas empeorando la cuenta — se mas conservador.`;
  }

  /**
   * Fallback genérico si no hay agentFeedback cargado.
   */
  _buildGenericImpactFeedback(sharedData) {
    const { impactHistory } = sharedData;
    if (!impactHistory || impactHistory.length === 0) return '';

    const feedbackLines = impactHistory.map(a => {
      const before = a.metrics_at_execution || {};
      const after3d = a.metrics_after_3d || {};
      const after1d = a.metrics_after_1d || {};

      const roasBefore = before.roas_7d || 0;
      let roasLine = '';

      if (after3d.roas_7d > 0) {
        const delta3d = roasBefore > 0 ? ((after3d.roas_7d - roasBefore) / roasBefore * 100).toFixed(1) : 'N/A';
        const label = after3d.roas_7d >= roasBefore ? 'MEJORO' : 'EMPEORO';
        roasLine = `ROAS 7d: ${roasBefore.toFixed(2)}x -> ${after3d.roas_7d.toFixed(2)}x (${delta3d}%) ${label}`;
      } else if (after1d.roas_7d > 0) {
        const delta1d = roasBefore > 0 ? ((after1d.roas_7d - roasBefore) / roasBefore * 100).toFixed(1) : 'N/A';
        const label = after1d.roas_7d >= roasBefore ? 'MEJORO' : 'EMPEORO';
        roasLine = `ROAS 7d (24h): ${roasBefore.toFixed(2)}x -> ${after1d.roas_7d.toFixed(2)}x (${delta1d}%) ${label} [solo 24h]`;
      } else {
        roasLine = 'ROAS: pendiente de medicion';
      }

      const daysAgo = ((Date.now() - new Date(a.executed_at).getTime()) / (1000 * 60 * 60 * 24)).toFixed(0);
      const budgetChange = a.action.includes('scale') ? ` $${a.before_value} -> $${a.after_value}` : '';

      return `- ${a.entity_name}: ${a.action}${budgetChange} (hace ${daysAgo}d) | ${roasLine}`;
    }).join('\n');

    return `\n\nRESULTADOS DE ACCIONES ANTERIORES (feedback de impacto):
${feedbackLines}
USA estos resultados para calibrar tus decisiones.`;
  }

  /**
   * Genera contexto del banco de creativos para agentes que lo necesiten.
   * Separa assets ad-ready (usables en ads) de references (contexto de estilo para IA).
   */
  _buildCreativeBankContext(sharedData) {
    const { creativeAssets } = sharedData;
    if (!creativeAssets || creativeAssets.length === 0) return '';

    const adReady = (creativeAssets || []).filter(a => a.purpose !== 'reference');
    const references = (creativeAssets || []).filter(a => a.purpose === 'reference');

    let context = '';

    if (adReady.length > 0) {
      const adLines = adReady.map(a => {
        const usage = a.times_used > 0 ? `(usado ${a.times_used}x, CTR prom: ${(a.avg_ctr || 0).toFixed(2)}%, ROAS: ${(a.avg_roas || 0).toFixed(1)}x)` : '(sin usar)';
        const style = a.style && a.style !== 'other' ? ` | estilo: ${a.style}` : '';
        const tags = a.tags && a.tags.length > 0 ? ` | tags: ${a.tags.join(', ')}` : '';
        const gen = a.generated_by && a.generated_by !== 'manual' ? ` | generado: ${a.generated_by}` : '';
        return `- ID: ${a._id} | "${a.headline || a.original_name}" | ${a.media_type} | CTA: ${a.cta}${style}${tags}${gen} ${usage}`;
      }).join('\n');

      context += `\n\nBANCO DE CREATIVOS DISPONIBLES (ad-ready):
${adLines}
Puedes recomendar "create_ad" usando el creative_asset_id de cualquiera de estos assets.`;
    }

    if (references.length > 0) {
      const refLines = references.map(a => {
        const style = a.style && a.style !== 'other' ? ` | estilo: ${a.style}` : '';
        const tags = a.tags && a.tags.length > 0 ? ` | tags: ${a.tags.join(', ')}` : '';
        return `- ID: ${a._id} | "${a.headline || a.original_name}" | ${a.media_type}${style}${tags}`;
      }).join('\n');

      context += `\n\nREFERENCIAS DE ESTILO (NO usar como ads, solo contexto):
${refLines}
Estos son ejemplos de estilos que funcionan. Usalos como contexto para entender que tipo de creativo recomendar, NO como assets para crear ads directamente.`;
    }

    return context;
  }

  /**
   * Genera lista de entidades creadas por la IA que estan en learning phase.
   * Los agentes NO deben tocar estas entidades (no scale, no pause, no budget changes).
   */
  _buildLearningPhaseProtection(sharedData) {
    const { aiCreations } = sharedData;
    if (!aiCreations || aiCreations.length === 0) return '';

    const protected_ = aiCreations.filter(c =>
      ['created', 'activating', 'learning'].includes(c.lifecycle_phase)
    );

    if (protected_.length === 0) return '';

    const lines = protected_.map(c => {
      const phase = c.lifecycle_phase;
      const phaseLabel = { created: 'ESPERANDO ACTIVACION', activating: 'ACTIVANDOSE', learning: 'LEARNING PHASE' }[phase] || phase;
      let endsInfo = '';
      if (c.learning_ends_at) {
        const daysLeft = Math.max(0, Math.ceil((new Date(c.learning_ends_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
        endsInfo = ` (${daysLeft}d restantes)`;
      }
      return `- ${c.meta_entity_id} "${c.meta_entity_name}" — ${phaseLabel}${endsInfo}`;
    }).join('\n');

    const protectedIds = protected_.map(c => c.meta_entity_id);

    return `\n\nENTIDADES EN LEARNING PHASE (CREADAS POR IA — NO TOCAR):
${lines}
PROHIBIDO recomendar scale_up, scale_down, pause, move_budget, o cualquier cambio en estas entidades. Estan en fase de aprendizaje controlada por el Lifecycle Manager. IDs protegidos: ${protectedIds.join(', ')}`;
  }

  /**
   * Genera contexto de creaciones anteriores de la IA para feedback loop.
   * Los agentes ven que entidades crearon antes y como les fue.
   */
  _buildAICreationsContext(sharedData) {
    const { aiCreations } = sharedData;
    if (!aiCreations || aiCreations.length === 0) return '';

    // Solo mostrar las relevantes a este agente + las con veredicto
    const relevant = aiCreations.filter(c =>
      c.agent_type === this.agentType || c.verdict !== 'pending'
    ).slice(0, 15);

    if (relevant.length === 0) return '';

    const lines = relevant.map(c => {
      const age = Math.floor((Date.now() - new Date(c.created_at).getTime()) / (1000 * 60 * 60 * 24));
      const type = c.creation_type === 'duplicate_adset' ? 'DUPLICADO' : 'NUEVO AD';
      const verdictEmoji = { positive: 'BUENA', negative: 'MALA', neutral: 'NEUTRA', pending: 'MIDIENDO' };
      const vLabel = verdictEmoji[c.verdict] || 'MIDIENDO';

      let metricsStr = '';
      if (c.measured_7d && c.metrics_7d) {
        metricsStr = ` | ROAS: ${(c.metrics_7d.roas_7d || 0).toFixed(1)}x, CTR: ${(c.metrics_7d.ctr || 0).toFixed(2)}%, Spend: $${(c.metrics_7d.spend || 0).toFixed(0)}`;
      } else if (c.measured_3d && c.metrics_3d) {
        metricsStr = ` | ROAS 3d: ${(c.metrics_3d.roas_7d || 0).toFixed(1)}x, Spend: $${(c.metrics_3d.spend || 0).toFixed(0)} (parcial)`;
      }

      return `- [${vLabel}] ${type}: "${c.meta_entity_name}" (hace ${age}d) | Padre: ${c.parent_entity_name}${metricsStr}${c.verdict_reason ? ` | ${c.verdict_reason}` : ''}`;
    }).join('\n');

    const stats = {
      total: aiCreations.length,
      positive: aiCreations.filter(c => c.verdict === 'positive').length,
      negative: aiCreations.filter(c => c.verdict === 'negative').length,
      pending: aiCreations.filter(c => c.verdict === 'pending').length
    };
    const measured = stats.total - stats.pending;
    const rate = measured > 0 ? Math.round((stats.positive / measured) * 100) : 0;

    return `\n\nCREACIONES ANTERIORES DE LA IA (feedback):
Tasa de exito: ${rate}% (${stats.positive} positivas / ${measured} medidas, ${stats.pending} midiendo)
${lines}
APRENDE de estos resultados. Si un tipo de duplicacion/ad funciono bien, repite esa estrategia. Si funciono mal, evitala.`;
  }

  /**
   * Genera contexto de rendimiento de creativos por estilo,
   * basado en acciones create_ad medidas de ESTE agente.
   */
  _buildCreativeStylePerformance(sharedData) {
    const agentFeedback = sharedData.agentFeedback;
    if (!agentFeedback) return '';

    const myFeedback = agentFeedback[this.agentType];
    if (!myFeedback || !myFeedback.creativePerformance || Object.keys(myFeedback.creativePerformance).length === 0) return '';

    const lines = Object.entries(myFeedback.creativePerformance).map(([style, stats]) => {
      return `- ${style}: ${stats.total} ads creados, ${stats.improved} mejoraron ROAS (${stats.success_rate}%), promedio ROAS delta: ${stats.avg_delta > 0 ? '+' : ''}${stats.avg_delta}%`;
    }).join('\n');

    return `\n\nRENDIMIENTO POR ESTILO DE CREATIVO (de tus create_ad anteriores):
${lines}
PRIORIZA estilos con mejor tasa de exito y delta ROAS positivo al recomendar nuevos create_ad.`;
  }

  /**
   * Valida y limpia una recomendacion.
   */
  _validateRecommendation(rec, sharedData, researchSources = []) {
    if (!rec || typeof rec !== 'object') return null;
    if (!VALID_ACTIONS.includes(rec.action)) return null;
    if (!rec.entity_id) return null;

    // Hard block: no changes to AI-created entities in learning phase
    const aiCreations = sharedData.aiCreations || [];
    const protectedEntity = aiCreations.find(c =>
      c.meta_entity_id === String(rec.entity_id) &&
      ['created', 'activating', 'learning'].includes(c.lifecycle_phase)
    );
    if (protectedEntity && rec.action !== 'no_action') {
      logger.info(`[${this.agentType.toUpperCase()}] Bloqueada recomendacion ${rec.action} en ${rec.entity_name || rec.entity_id} — en ${protectedEntity.lifecycle_phase} phase (lifecycle manager controla)`);
      return null;
    }

    // Buscar la entidad en los datos para obtener metricas reales
    const adSet = sharedData.adSetSnapshots?.find(s => s.entity_id === rec.entity_id);
    const ad = sharedData.adSnapshots?.find(s => s.entity_id === rec.entity_id);
    const entity = adSet || ad;

    const clean = {
      action: rec.action,
      entity_type: rec.entity_type || 'adset',
      entity_id: String(rec.entity_id),
      entity_name: String(rec.entity_name || entity?.entity_name || 'Sin nombre'),
      current_value: parseFloat(rec.current_value) || (entity?.daily_budget || 0),
      recommended_value: parseFloat(rec.recommended_value) || 0,
      change_percent: 0,
      reasoning: String(rec.reasoning || 'Sin razon'),
      expected_impact: String(rec.expected_impact || ''),
      confidence: VALID_CONFIDENCE.includes(rec.confidence) ? rec.confidence : 'medium',
      priority: VALID_PRIORITY.includes(rec.priority) ? rec.priority : 'medium',
      metrics: {
        roas_7d: entity?.metrics?.last_7d?.roas || parseFloat(rec.metrics?.roas_7d) || 0,
        roas_3d: entity?.metrics?.last_3d?.roas || parseFloat(rec.metrics?.roas_3d) || 0,
        cpa_7d: entity?.metrics?.last_7d?.cpa || parseFloat(rec.metrics?.cpa_7d) || 0,
        spend_today: entity?.metrics?.today?.spend || parseFloat(rec.metrics?.spend_today) || 0,
        frequency: entity?.metrics?.last_7d?.frequency || parseFloat(rec.metrics?.frequency) || 0,
        ctr: entity?.metrics?.last_7d?.ctr || parseFloat(rec.metrics?.ctr) || 0
      },
      // Campos avanzados
      target_entity_id: rec.target_entity_id || null,
      target_entity_name: rec.target_entity_name || null,
      creative_asset_id: rec.creative_asset_id || null,
      bid_strategy: rec.bid_strategy || null,
      duplicate_name: rec.duplicate_name || null,
      duplicate_strategy: rec.duplicate_strategy || null,
      ad_name: rec.ad_name || null,
      creative_rationale: rec.creative_rationale || null,
      ads_to_pause: Array.isArray(rec.ads_to_pause) ? rec.ads_to_pause.filter(id => typeof id === 'string' && id.length > 0) : [],
      creative_changes: rec.creative_changes || {},
      // Research
      research_context: rec.research_context || '',
      research_sources: researchSources.slice(0, 3).map(s => ({
        title: s.title || '',
        url: s.url || '',
        snippet: (s.snippet || '').substring(0, 200)
      })),
      status: 'pending'
    };

    // Calcular change_percent
    if (['scale_up', 'scale_down'].includes(clean.action) && clean.current_value > 0) {
      clean.change_percent = ((clean.recommended_value - clean.current_value) / clean.current_value) * 100;
    }

    return clean;
  }

  /**
   * Valida una alerta.
   */
  _validateAlert(alert) {
    if (!alert || typeof alert !== 'object') return null;
    return {
      type_name: String(alert.type || alert.type_name || 'unknown'),
      message: String(alert.message || 'Sin mensaje'),
      severity: ['critical', 'warning', 'info'].includes(alert.severity) ? alert.severity : 'info'
    };
  }
}

module.exports = BaseAgent;
