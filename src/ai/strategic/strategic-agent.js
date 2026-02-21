const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const { SYSTEM_PROMPT, buildStrategicUserPrompt, getSeasonalContext } = require('./strategic-prompts');
const { parseStrategicResponse } = require('./response-parser');
const CreativeAnalyzer = require('./creative-analyzer');
const ResearchModule = require('./research-module');
const StrategicInsight = require('../../db/models/StrategicInsight');
const StrategicDirective = require('../../db/models/StrategicDirective');
const Decision = require('../../db/models/Decision');
const { getLatestSnapshots, getAccountOverview, getRecentActions, getExecutedActionsWithImpact, getLatestPolicyDecisions } = require('../../db/queries');
const logger = require('../../utils/logger');

/**
 * Strategic Agent — el cerebro de IA del sistema.
 *
 * Orquesta:
 * 1. Recoleccion de datos de la cuenta (metricas, estructura)
 * 2. Analisis de contenido creativo (headlines, copy, CTAs)
 * 3. Investigacion web (tendencias, cambios en Meta, best practices)
 * 4. Llamada a Claude con todo el contexto
 * 5. Parseo y almacenamiento de insights estrategicos
 */
class StrategicAgent {
  constructor() {
    this.anthropic = new Anthropic({ apiKey: config.claude.apiKey });
    this.model = config.claude.model || 'claude-sonnet-4-5-20250929';
    this.maxTokens = Math.max(config.claude.maxTokens || 4096, 8192);
    this.creativeAnalyzer = new CreativeAnalyzer();
    this.researchModule = new ResearchModule();
  }

  /**
   * Ejecuta un ciclo completo de analisis estrategico.
   * Retorna el resultado con insights generados.
   */
  async runCycle() {
    const cycleId = `strategic_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    logger.info(`[STRATEGIC] Iniciando ciclo ${cycleId}...`);

    const startTime = Date.now();

    try {
      // PASO 1: Recolectar todos los datos en paralelo
      logger.info('[STRATEGIC] Paso 1: Recolectando datos...');
      const [
        snapshots,
        accountOverview,
        recentActions,
        impactHistory,
        creativeAnalysis,
        policyDecisions
      ] = await Promise.all([
        getLatestSnapshots(),
        getAccountOverview(),
        getRecentActions(7),
        getExecutedActionsWithImpact(30),
        this.creativeAnalyzer.analyze(),
        getLatestPolicyDecisions()
      ]);

      const adSetSnapshots = snapshots.filter(s => s.entity_type === 'adset');
      const adSnapshots = snapshots.filter(s => s.entity_type === 'ad');

      // PASO 2: Investigacion web (condicionada a problemas detectados)
      logger.info('[STRATEGIC] Paso 2: Investigacion web...');
      const researchContext = this._buildResearchContext(accountOverview, creativeAnalysis, adSetSnapshots);
      const researchInsights = await this.researchModule.research(researchContext);

      // PASO 3: Contexto estacional
      const seasonalContext = getSeasonalContext();

      // PASO 4: Obtener estado del learning (si existe)
      let learningState = null;
      try {
        const SystemConfig = require('../../db/models/SystemConfig');
        learningState = await SystemConfig.get('policy_learning_state');
      } catch (e) {
        // No critical
      }

      // PASO 5: Construir prompt y llamar a Claude
      logger.info('[STRATEGIC] Paso 3: Llamando a Claude...');
      const userPrompt = buildStrategicUserPrompt({
        accountOverview,
        adSetSnapshots,
        adSnapshots,
        creativeAnalysis,
        recentActions,
        impactHistory,
        researchInsights,
        learningState,
        seasonalContext,
        policyDecisions
      });

      const response = await this._callClaude(userPrompt);

      // PASO 6: Parsear respuesta
      logger.info(`[STRATEGIC] Paso 4: Parseando respuesta (${response.text?.length || 0} chars, stop: ${response.stop_reason || 'unknown'})...`);

      if (response.stop_reason === 'max_tokens') {
        logger.warn('[STRATEGIC] Respuesta de Claude truncada por max_tokens. Aumentar maxTokens.');
      }

      // Log primeros 500 chars para diagnostico
      if (response.text) {
        logger.debug(`[STRATEGIC] Respuesta raw (primeros 500 chars): ${response.text.substring(0, 500)}`);
      }

      const parsed = parseStrategicResponse(response.text);

      if (!parsed) {
        logger.error('[STRATEGIC] No se pudo parsear la respuesta de Claude');
        logger.error(`[STRATEGIC] Respuesta raw (primeros 1000 chars): ${(response.text || '').substring(0, 1000)}`);
        return { success: false, error: 'parse_error', cycleId };
      }

      // PASO 7: Guardar insights en MongoDB
      logger.info(`[STRATEGIC] Paso 5: Guardando ${parsed.insights.length} insights...`);
      const savedInsights = [];

      for (const insight of parsed.insights) {
        // Agregar fuentes de investigacion si hay
        const researchSources = this._matchResearchSources(insight, researchInsights);

        const doc = await StrategicInsight.create({
          cycle_id: cycleId,
          insight_type: insight.insight_type,
          severity: insight.severity,
          title: insight.title,
          analysis: insight.analysis,
          recommendation: insight.recommendation,
          evidence: insight.evidence,
          affected_entities: insight.affected_entities,
          creative_context: insight.creative_context || [],
          research_sources: researchSources,
          actionable: insight.actionable,
          auto_action: insight.auto_action,
          account_summary: parsed.account_summary,
          account_health: parsed.account_health,
          token_usage: {
            input_tokens: response.usage?.input_tokens || 0,
            output_tokens: response.usage?.output_tokens || 0
          }
        });

        savedInsights.push(doc);
      }

      // PASO 8: Guardar directivas estrategicas
      let savedDirectives = 0;
      if (parsed.directives && parsed.directives.length > 0) {
        logger.info(`[STRATEGIC] Paso 6: Guardando ${parsed.directives.length} directivas...`);

        // Expirar directivas anteriores
        await StrategicDirective.updateMany(
          { status: 'active' },
          { $set: { status: 'expired' } }
        );

        const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000); // 4 horas

        for (const directive of parsed.directives) {
          // Buscar el insight padre (si tiene entidades afectadas coincidentes)
          const parentInsight = savedInsights.find(si =>
            si.affected_entities?.some(ae => ae.entity_id === directive.entity_id)
          );

          try {
            await StrategicDirective.create({
              cycle_id: cycleId,
              insight_id: parentInsight?._id || null,
              directive_type: directive.directive_type,
              entity_type: directive.entity_type,
              entity_id: directive.entity_id,
              entity_name: directive.entity_name || '',
              target_action: directive.target_action || 'any',
              score_modifier: directive.score_modifier,
              reason: directive.reason,
              source_insight_type: parentInsight?.insight_type || '',
              confidence: directive.confidence || 'medium',
              expires_at: expiresAt,
              status: 'active'
            });
            savedDirectives++;
          } catch (dirErr) {
            logger.warn(`[STRATEGIC] Error guardando directiva para ${directive.entity_id}: ${dirErr.message}`);
          }
        }
        logger.info(`[STRATEGIC] ${savedDirectives} directivas guardadas (expiran en 4h)`);
      }

      // PASO 9: Generar Decision document para directivas accionables
      // Esto hace que las recomendaciones estrategicas aparezcan en la pagina Agente IA
      // donde el usuario puede aprobar/rechazar/ejecutar los cambios reales.
      let strategicDecisionDoc = null;
      try {
        strategicDecisionDoc = await this._generateStrategicDecisions({
          cycleId,
          parsed,
          savedInsights,
          snapshots,
          accountOverview
        });
      } catch (decErr) {
        logger.warn(`[STRATEGIC] Error generando decisions: ${decErr.message}`);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const result = {
        success: true,
        cycleId,
        account_summary: parsed.account_summary,
        account_health: parsed.account_health,
        insights_count: savedInsights.length,
        actionable_count: savedInsights.filter(i => i.actionable).length,
        directives_count: savedDirectives,
        research_enabled: researchInsights.enabled,
        research_queries: researchInsights.queries_executed || 0,
        creative_issues: creativeAnalysis.total_issues || 0,
        decisions_generated: strategicDecisionDoc?.decisions?.length || 0,
        token_usage: response.usage,
        elapsed: `${elapsed}s`
      };

      logger.info(`[STRATEGIC] Ciclo completado: ${result.insights_count} insights, ${result.directives_count} directivas, ${result.actionable_count} accionables, ${result.decisions_generated} decisions para Agente IA, ${result.elapsed}`);
      return result;

    } catch (error) {
      logger.error(`[STRATEGIC] Error en ciclo: ${error.message}`, error.stack);
      return { success: false, error: error.message, cycleId };
    }
  }

  /**
   * Llama a Claude con el system prompt estrategico + user prompt.
   */
  async _callClaude(userPrompt) {
    const _extractResponse = (response) => {
      const text = (response.content || [])
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('');

      return {
        text,
        usage: response.usage,
        stop_reason: response.stop_reason
      };
    };

    try {
      logger.info(`[STRATEGIC] Enviando prompt (${userPrompt.length} chars) a ${this.model} con maxTokens=${this.maxTokens}...`);
      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: userPrompt }
        ]
      });

      return _extractResponse(response);
    } catch (error) {
      // Manejar rate limit
      if (error.status === 429) {
        logger.warn('[STRATEGIC] Rate limit de Claude. Esperando 15s...');
        await new Promise(resolve => setTimeout(resolve, 15000));

        const retryResponse = await this.anthropic.messages.create({
          model: this.model,
          max_tokens: this.maxTokens,
          system: SYSTEM_PROMPT,
          messages: [
            { role: 'user', content: userPrompt }
          ]
        });

        return _extractResponse(retryResponse);
      }

      throw error;
    }
  }

  /**
   * Construye contexto para el modulo de investigacion web
   * basado en problemas detectados en la cuenta.
   */
  _buildResearchContext(accountOverview, creativeAnalysis, adSetSnapshots) {
    const ctx = {};

    // ROAS bajo
    const roas7d = accountOverview?.roas_7d || 0;
    if (roas7d < 2.0) ctx.low_roas = true;

    // CPA alto
    const avgCpa = adSetSnapshots
      .filter(s => s.status === 'ACTIVE' && s.metrics?.last_7d?.cpa > 0)
      .reduce((sum, s) => sum + (s.metrics.last_7d.cpa || 0), 0) /
      Math.max(adSetSnapshots.filter(s => s.status === 'ACTIVE').length, 1);
    if (avgCpa > 40) ctx.high_cpa = true;

    // Fatiga creativa
    const highFreqCount = adSetSnapshots.filter(s =>
      s.status === 'ACTIVE' && (s.metrics?.last_7d?.frequency || 0) >= 2.5
    ).length;
    if (highFreqCount >= 3) ctx.high_fatigue = true;
    if (highFreqCount >= 2) ctx.high_frequency = true;

    // Pocos creativos
    if (creativeAnalysis?.account_issues?.some(i => i.type === 'account_low_creative_diversity')) {
      ctx.low_creative_count = true;
    }

    // Oportunidad de scaling
    const strongAdSets = adSetSnapshots.filter(s =>
      s.status === 'ACTIVE' &&
      (s.metrics?.last_7d?.roas || 0) >= 3.0 &&
      (s.metrics?.last_14d?.roas || 0) >= 2.0
    );
    if (strongAdSets.length >= 2) ctx.scaling_opportunity = true;

    // Evento estacional
    const seasonal = getSeasonalContext();
    if (seasonal) ctx.upcoming_seasonal_event = seasonal.name;

    return ctx;
  }

  /**
   * Busca fuentes de investigacion relevantes para un insight.
   */
  _matchResearchSources(insight, researchInsights) {
    if (!researchInsights?.insights?.length) return [];

    const sources = [];
    const type = insight.insight_type;

    // Mapear tipos de insight a categorias de investigacion
    const categoryMap = {
      'platform_alert': 'platform_updates',
      'creative_refresh': 'problem_specific',
      'copy_strategy': 'best_practices',
      'audience_insight': 'best_practices',
      'scaling_playbook': 'best_practices',
      'competitive_insight': 'industry_trends',
      'seasonal_strategy': 'seasonal'
    };

    const targetCategory = categoryMap[type];
    if (!targetCategory) return [];

    for (const finding of researchInsights.insights) {
      if (finding.category === targetCategory && finding.sources) {
        sources.push(...finding.sources.slice(0, 2));
      }
    }

    return sources.slice(0, 3);
  }

  /**
   * Genera un Decision document a partir de directivas override y insights accionables.
   * Estas decisions aparecen en la pagina Agente IA con el flujo approve → execute → Meta API.
   */
  async _generateStrategicDecisions({ cycleId, parsed, savedInsights, snapshots, accountOverview }) {
    const decisionItems = [];

    // 1) Directivas override con target_action especifico → Decision items
    if (parsed.directives) {
      for (const directive of parsed.directives) {
        if (directive.directive_type !== 'override' || directive.target_action === 'any') continue;

        const snapshot = snapshots.find(s => s.entity_id === directive.entity_id);
        const actionValues = this._buildActionValues(directive.target_action, snapshot);

        decisionItems.push({
          action: directive.target_action,
          entity_type: directive.entity_type || 'adset',
          entity_id: directive.entity_id,
          entity_name: directive.entity_name || snapshot?.name || '',
          campaign_name: snapshot?.campaign_name || '',
          current_value: actionValues.currentValue,
          new_value: actionValues.newValue,
          change_percent: actionValues.changePercent,
          reasoning: `[IA ESTRATEGICA] ${directive.reason}`,
          confidence: directive.confidence || 'medium',
          priority: 'high',
          metrics_snapshot: this._extractMetricsSnapshot(snapshot),
          policy_score: 0.90,
          policy_bucket: 'strategic_ai',
          expected_impact: '',
          expected_impact_pct: 0,
          risk_score: 0.15,
          uncertainty_score: 0.2,
          confidence_score: directive.confidence === 'high' ? 0.85 : 0.65,
          measurement_window_hours: 72,
          hypothesis: `[IA ESTRATEGICA] ${directive.reason}`,
          rationale_evidence: [],
          research_context: '',
          decision_category: 'strategic_override',
          data_quality_score: 0.7,
          recommendation_status: 'pending'
        });
      }
    }

    // 2) Insights accionables con auto_action → Decision items
    for (const insight of savedInsights) {
      if (!insight.actionable || !insight.auto_action) continue;
      const aa = insight.auto_action;
      if (!aa.action || !aa.entity_id) continue;

      // Evitar duplicar si ya hay un override para la misma entidad+accion
      const alreadyExists = decisionItems.some(
        d => d.entity_id === aa.entity_id && d.action === aa.action
      );
      if (alreadyExists) continue;

      const snapshot = snapshots.find(s => s.entity_id === aa.entity_id);
      const actionValues = this._buildActionValues(aa.action, snapshot, aa.value);

      decisionItems.push({
        action: aa.action,
        entity_type: aa.entity_type || 'adset',
        entity_id: aa.entity_id,
        entity_name: snapshot?.name || '',
        campaign_name: snapshot?.campaign_name || '',
        current_value: actionValues.currentValue,
        new_value: actionValues.newValue,
        change_percent: actionValues.changePercent,
        reasoning: `[IA ESTRATEGICA] ${insight.title}: ${insight.recommendation}`,
        confidence: 'medium',
        priority: insight.severity === 'critical' ? 'critical' : insight.severity === 'high' ? 'high' : 'medium',
        metrics_snapshot: this._extractMetricsSnapshot(snapshot),
        policy_score: 0.85,
        policy_bucket: 'strategic_ai',
        expected_impact: '',
        expected_impact_pct: 0,
        risk_score: 0.20,
        uncertainty_score: 0.25,
        confidence_score: 0.65,
        measurement_window_hours: 72,
        hypothesis: `[IA ESTRATEGICA] ${insight.title}`,
        rationale_evidence: insight.evidence || [],
        research_context: '',
        decision_category: 'strategic_auto_action',
        data_quality_score: 0.7,
        recommendation_status: 'pending'
      });
    }

    if (decisionItems.length === 0) {
      logger.info('[STRATEGIC] No hay directivas accionables para generar decisions.');
      return null;
    }

    // Crear Decision document (mismo modelo que usa el Policy Agent)
    const decisionDoc = await Decision.create({
      cycle_id: cycleId,
      analysis_summary: `[IA ESTRATEGICA] ${parsed.account_summary || 'Analisis estrategico con Claude AI'}`,
      total_daily_spend: accountOverview?.today_spend || 0,
      account_roas: accountOverview?.roas_7d || 0,
      decisions: decisionItems,
      alerts: [],
      total_actions: decisionItems.length,
      approved_actions: 0,
      rejected_actions: 0,
      executed_actions: 0,
      claude_model: this.model,
      prompt_tokens: 0,
      completion_tokens: 0,
      knowledge_version: 'strategic-ai',
      learning_samples_total: 0,
      decision_mix: decisionItems.reduce((acc, d) => {
        if (d.entity_type === 'ad') acc.ad += 1;
        else acc.adset += 1;
        return acc;
      }, { adset: 0, ad: 0 }),
      research_digest: ''
    });

    logger.info(`[STRATEGIC] Decision document creado con ${decisionItems.length} items para Agente IA (ID: ${decisionDoc._id})`);
    return decisionDoc;
  }

  /**
   * Construye los valores de accion (currentValue, newValue, changePercent)
   * para un decision item estrategico.
   */
  _buildActionValues(action, snapshot, explicitValue) {
    if (action === 'pause') {
      return { currentValue: snapshot?.status || 'ACTIVE', newValue: 'PAUSED', changePercent: 0 };
    }
    if (action === 'reactivate') {
      return { currentValue: snapshot?.status || 'PAUSED', newValue: 'ACTIVE', changePercent: 0 };
    }

    const currentBudget = snapshot?.daily_budget || 0;

    if (action === 'scale_up') {
      const newValue = explicitValue || Math.round(currentBudget * 1.15 * 100) / 100;
      return {
        currentValue: currentBudget,
        newValue,
        changePercent: currentBudget > 0 ? ((newValue - currentBudget) / currentBudget) * 100 : 0
      };
    }
    if (action === 'scale_down') {
      const newValue = explicitValue || Math.round(currentBudget * 0.85 * 100) / 100;
      return {
        currentValue: currentBudget,
        newValue,
        changePercent: currentBudget > 0 ? ((newValue - currentBudget) / currentBudget) * 100 : 0
      };
    }

    return { currentValue: 0, newValue: 0, changePercent: 0 };
  }

  /**
   * Extrae un metrics_snapshot de un snapshot de entidad.
   */
  _extractMetricsSnapshot(snapshot) {
    if (!snapshot) return {};
    const m7 = snapshot.metrics?.last_7d || {};
    const m3 = snapshot.metrics?.last_3d || {};
    return {
      roas_3d: m3.roas || 0,
      roas_7d: m7.roas || 0,
      cpa_3d: m3.cpa || 0,
      spend_today: snapshot.metrics?.today?.spend || 0,
      frequency: m7.frequency || 0,
      ctr: m7.ctr || 0
    };
  }
}

module.exports = StrategicAgent;
