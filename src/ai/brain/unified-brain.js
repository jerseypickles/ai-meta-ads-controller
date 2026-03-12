const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const safetyGuards = require('../../../config/safety-guards');
const unifiedPolicyConfig = require('../../../config/unified-policy');
const deepResearchPriors = require('../../../config/deep-research-priors');
const kpiTargets = require('../../../config/kpi-targets');
const { getLatestSnapshots, getAccountOverview, getRecentActions, getActiveDirectives, getSnapshotFreshness } = require('../../db/queries');
const { CooldownManager } = require('../../safety/cooldown-manager');
const { buildFeatureSet } = require('../unified/feature-builder');
const AdaptiveScorer = require('../unified/adaptive-scorer');
const PolicyLearner = require('../unified/policy-learner');
const ImpactContextBuilder = require('./impact-context-builder');
const DiagnosticEngine = require('./diagnostic-engine');
const { getSystemPrompt, buildUserPrompt } = require('./brain-prompts');
const AgentReport = require('../../db/models/AgentReport');
const ActionLog = require('../../db/models/ActionLog');
const CreativeAsset = require('../../db/models/CreativeAsset');
const AICreation = require('../../db/models/AICreation');
const BrainRecommendation = require('../../db/models/BrainRecommendation');
const BrainCycleMemory = require('../../db/models/BrainCycleMemory');
const BrainMemory = require('../../db/models/BrainMemory');
const BrainTemporalPattern = require('../../db/models/BrainTemporalPattern');
const StrategicDirective = require('../../db/models/StrategicDirective');
const logger = require('../../utils/logger');

const VALID_ACTIONS = [
  'scale_up', 'scale_down', 'pause', 'reactivate', 'no_action', 'observe',
  'duplicate_adset', 'create_ad', 'update_bid_strategy',
  'update_ad_status', 'move_budget', 'update_ad_creative'
];
const VALID_CONFIDENCE = ['high', 'medium', 'low'];
const VALID_PRIORITY = ['critical', 'high', 'medium', 'low'];

class UnifiedBrain {
  constructor() {
    this.anthropic = new Anthropic({ apiKey: config.claude.apiKey });
    this.buildFeatureSet = buildFeatureSet;
    this.scorer = new AdaptiveScorer({
      config: unifiedPolicyConfig,
      knowledge: deepResearchPriors
    });
    this.learner = new PolicyLearner();
    this.impactBuilder = new ImpactContextBuilder();
    this.diagnosticEngine = new DiagnosticEngine();
  }

  /**
   * Ejecuta un ciclo completo del cerebro IA.
   * @returns {Object} { report, autoExecuted, elapsed }
   */
  async runCycle() {
    const startTime = Date.now();
    const cycleId = `brain_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    logger.info(`═══ Iniciando ciclo del Cerebro IA [${cycleId}] ═══`);

    try {
      // 0. Freshness guard — no tomar decisiones con datos stale (> 15 min)
      const freshness = await getSnapshotFreshness('adset');
      if (!freshness.fresh) {
        logger.warn(`[BRAIN] Datos stale (${freshness.age_minutes} min) — abortando ciclo. Umbral: 15 min.`);
        return {
          cycleId, elapsed: '0s', recommendations: 0, autoExecuted: 0,
          abortReason: `Snapshots tienen ${freshness.age_minutes} min de antigüedad (máximo 15 min). DataCollector puede estar fallando.`
        };
      }
      logger.info(`[BRAIN] Datos frescos: ${freshness.age_minutes} min de antigüedad`);

      // 1. Expirar recomendaciones pendientes de ciclos anteriores
      await this._expirePendingRecommendations();

      // 2. Consumir feedback de aprendizaje (actualizar bandit)
      const learningResult = await this.learner.consumeImpactFeedback();

      // 3. Cargar todos los datos en paralelo
      const sharedData = await this._loadSharedData(cycleId);
      if (!sharedData) {
        logger.warn('[BRAIN] Sin datos disponibles — no hay snapshots');
        return { cycleId, elapsed: '0s', recommendations: 0, autoExecuted: 0, abortReason: 'No hay snapshots disponibles. Ejecutar recoleccion de datos primero.' };
      }

      // 4. Construir contexto de impacto
      const impactContext = await this.impactBuilder.build();

      // 4.5. Validar hipótesis pendientes de ciclos anteriores
      let validatedHypotheses = null;
      try {
        validatedHypotheses = await this._validateHypotheses(
          sharedData.cycleMemories,
          sharedData.accountOverview,
          sharedData.adSetSnapshots
        );
      } catch (hypErr) {
        logger.warn(`[BRAIN] Error validando hipótesis (non-fatal): ${hypErr.message}`);
      }

      // 5. Construir resumen del learner para Claude
      const learnerState = await this.learner.loadState();
      const learnerSummary = this._buildLearnerSummary(learnerState, learningResult);

      // 5.5. Build feature set EARLY — used by both diagnostics and scorer
      const features = this.buildFeatureSet({
        adSetSnapshots: sharedData.adSetSnapshots,
        adSnapshots: sharedData.adSnapshots,
        accountOverview: sharedData.accountOverview,
        recentActions: sharedData.recentActions,
        activeCooldowns: sharedData.activeCooldowns
      });
      const featureMap = {};
      for (const f of features) { featureMap[f.entity_id] = f; }

      // 5.6. Run diagnostic engine for structured pre-analysis
      let diagnosticContext = '';
      try {
        const memoryMap = {};
        if (sharedData.memories) {
          for (const m of sharedData.memories) memoryMap[m.entity_id] = m;
        }
        const diagnostics = this.diagnosticEngine.diagnoseAll(
          sharedData.adSetSnapshots || [],
          sharedData.adSnapshots || [],
          memoryMap,
          sharedData.accountOverview || {},
          featureMap
        );
        diagnosticContext = this.diagnosticEngine.formatForPrompt(diagnostics);
        const diagCount = Object.keys(diagnostics).length;
        const urgentCount = Object.values(diagnostics).filter(d => d.overall.urgency === 'high').length;
        if (diagCount > 0) {
          logger.info(`[BRAIN] Diagnósticos: ${diagCount} entidades analizadas, ${urgentCount} urgentes`);
        }
      } catch (diagErr) {
        logger.warn(`[BRAIN] Diagnostic engine error (non-fatal): ${diagErr.message}`);
      }

      // 6. Llamar a Claude con todo el contexto
      const systemPrompt = getSystemPrompt();
      const userPrompt = buildUserPrompt({
        accountOverview: sharedData.accountOverview,
        adSetSnapshots: sharedData.adSetSnapshots,
        adSnapshots: sharedData.adSnapshots,
        campaignSnapshots: sharedData.campaignSnapshots,
        recentActions: sharedData.recentActions,
        activeCooldowns: sharedData.activeCooldowns,
        impactContext,
        creativeAssets: sharedData.creativeAssets,
        aiCreations: sharedData.aiCreations,
        strategicDirectives: sharedData.strategicDirectives,
        learnerSummary,
        aiManagerFeedback: sharedData.aiManagerFeedback,
        recommendationHistory: sharedData.recommendationHistory,
        cycleMemories: sharedData.cycleMemories,
        diagnosticContext,
        validatedHypotheses,
        memories: sharedData.memories,
        temporalPatterns: sharedData.temporalPatterns,
        pauseContextMap: sharedData.pauseContextMap
      });

      logger.info(`[BRAIN] Prompt enviado a Claude: ${userPrompt.length} chars`);
      const response = await this._callClaude(systemPrompt, userPrompt);
      if (!response) {
        logger.warn('[BRAIN] Sin respuesta de Claude');
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        return { cycleId, elapsed: `${elapsed}s`, recommendations: 0, autoExecuted: 0, abortReason: 'Claude no respondio (posible error de API o rate limit).' };
      }

      logger.info(`[BRAIN] Respuesta de Claude recibida: ${response.text.length} chars, tokens: ${response.usage?.input_tokens}/${response.usage?.output_tokens}, stop: ${response.stopReason}`);
      if (response.stopReason === 'max_tokens') {
        logger.warn('[BRAIN] Respuesta truncada por max_tokens — intentando recuperar JSON parcial');
      }

      // 7. Parsear y validar recomendaciones
      const parsed = this._parseResponse(response.text);
      if (!parsed) {
        logger.warn('[BRAIN] No se pudo parsear respuesta');
        logger.warn(`[BRAIN] Respuesta raw (primeros 800 chars): ${response.text.substring(0, 800)}`);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        return { cycleId, elapsed: `${elapsed}s`, recommendations: 0, autoExecuted: 0, abortReason: 'No se pudo parsear la respuesta JSON de Claude.' };
      }

      logger.info(`[BRAIN] Parseado OK: ${(parsed.recommendations || []).length} recomendaciones raw, status: ${parsed.status}`);

      // 8. Validar recomendaciones + enriquecer con scorer
      const rawRecsCount = (parsed.recommendations || []).length;
      const validRecs = (parsed.recommendations || [])
        .map(r => this._validateRecommendation(r, sharedData, impactContext))
        .filter(Boolean);

      logger.info(`[BRAIN] Validacion: ${rawRecsCount} raw -> ${validRecs.length} validas (${rawRecsCount - validRecs.length} descartadas)`);

      // Filtrar por cooldown — allow 'observe' actions through for follow-up monitoring
      const cooldownEntityIds = new Set((sharedData.activeCooldowns || []).map(c => c.entity_id));
      const pendingEntityIds = impactContext.pendingEntities || new Set();

      const filteredRecs = validRecs.filter(r => {
        // 'observe' actions pass through cooldown — they are non-modifying follow-ups
        const isObservation = r.action === 'observe';
        if (cooldownEntityIds.has(r.entity_id) && !isObservation) {
          logger.info(`[BRAIN] Filtrada por cooldown: ${r.entity_name}`);
          return false;
        }
        if (pendingEntityIds.has(r.entity_id) && !isObservation) {
          logger.info(`[BRAIN] Filtrada por medicion pendiente: ${r.entity_name}`);
          return false;
        }
        return true;
      });

      logger.info(`[BRAIN] Post-filtro: ${filteredRecs.length} (${validRecs.length - filteredRecs.length} filtradas por cooldown/medicion)`);

      // 9. Aplicar adaptive scorer a cada recomendacion (features already built at step 5.5)
      const accountContext = this.scorer.buildAccountContext(sharedData.accountOverview, features);

      const scoredRecs = filteredRecs.map(rec => {
        const feature = features.find(f => f.entity_id === rec.entity_id);
        if (!feature) return rec;

        const bucketContext = {
          hour: new Date().getHours(),
          seasonal_event: this.learner._isSeasonalDate(new Date()),
          account_roas_7d: accountContext?.accountRoas7d || 0
        };
        const bucket = this.learner.bucketFromMetrics(rec.metrics || {}, bucketContext);
        const learningSignal = this.learner.getActionBias(learnerState, bucket, rec.action);

        const scored = this.scorer.scoreCandidate({
          feature,
          candidate: {
            action: rec.action,
            baseScore: this._baseScoreFromConfidence(rec.confidence, feature.metrics || {}),
            baseRisk: deepResearchPriors.action_priors?.[rec.action]?.baseline_risk || 0.35,
            baseImpactPct: deepResearchPriors.action_priors?.[rec.action]?.baseline_impact_pct || 5,
            hypothesis: rec.reasoning
          },
          learningSignal,
          accountContext
        });

        return {
          ...rec,
          policy_score: scored.policyScore,
          confidence_score: scored.confidenceScore,
          expected_impact_pct: scored.expectedImpactPct,
          risk_score: scored.riskScore,
          uncertainty_score: scored.uncertaintyScore,
          measurement_window_hours: scored.measurementWindowHours,
          hypothesis: scored.hypothesis,
          evidence: scored.evidence,
          policy_bucket: bucket,
          // Override confidence/priority with scorer's calculation
          confidence: scored.confidence,
          priority: scored.priority
        };
      });

      // 9b. Inyectar rotación de creativos forzada para ad sets con fatiga alta
      const rotationRecs = this._injectCreativeRotationRecs(features, sharedData, cooldownEntityIds, pendingEntityIds);
      if (rotationRecs.length > 0) {
        logger.info(`[BRAIN] Rotación creativa forzada: ${rotationRecs.length} recomendaciones inyectadas`);
      }
      const allScoredRecs = [...scoredRecs, ...rotationRecs];

      // 9c. Auto-inyectar create_ad compañero cuando una pausa dejaría 0 ads activos.
      // Claude a veces recomienda pausar el único ad de un ad set sin generar reemplazo,
      // lo cual mata el ad set. Este paso detecta ese caso y fuerza el create_ad.
      const companionCreateRecs = this._injectCompanionCreateAds(allScoredRecs, sharedData);
      if (companionCreateRecs.length > 0) {
        logger.info(`[BRAIN] Companion create_ad: ${companionCreateRecs.length} reemplazos auto-inyectados para ad sets que quedarían sin ads`);
        allScoredRecs.push(...companionCreateRecs);
      }

      // 10. Aplicar directivas estrategicas
      const withDirectives = this._applyStrategicDirectives(allScoredRecs, sharedData.strategicDirectives);

      // 10b. Dedup: enforce one recommendation per entity — keep highest policy_score
      const dedupedRecs = [];
      const seenEntityIds = new Set();
      const sortedForDedup = [...withDirectives].sort((a, b) => (b.policy_score || 0) - (a.policy_score || 0));
      for (const rec of sortedForDedup) {
        if (rec.entity_id && seenEntityIds.has(rec.entity_id)) {
          logger.info(`[BRAIN] Dedup: descartada segunda rec para ${rec.entity_name} (${rec.action}, score ${(rec.policy_score || 0).toFixed(2)})`);
          continue;
        }
        if (rec.entity_id) seenEntityIds.add(rec.entity_id);
        dedupedRecs.push(rec);
      }
      if (dedupedRecs.length < withDirectives.length) {
        logger.info(`[BRAIN] Dedup: ${withDirectives.length} -> ${dedupedRecs.length} (${withDirectives.length - dedupedRecs.length} duplicadas eliminadas)`);
      }

      // 11. Ordenar por score y limitar
      const finalRecs = dedupedRecs
        .sort((a, b) => (b.policy_score || 0) - (a.policy_score || 0))
        .slice(0, unifiedPolicyConfig.max_recommendations_per_cycle || 12);

      // 12. Separar: recomendaciones normales vs directivas para AI Manager
      // Construir set de IDs gestionados por AI Manager (adsets + sus ads hijos)
      const aiManagedAdSetIds = new Set(
        sharedData.adSetSnapshots.filter(s => s._ai_managed).map(s => s.entity_id)
      );
      const humanRecs = [];
      const aiManagerRecs = [];
      for (const rec of finalRecs) {
        // Caso 1: la recomendacion es sobre un adset gestionado
        if (aiManagedAdSetIds.has(rec.entity_id)) {
          aiManagerRecs.push(rec);
          continue;
        }
        // Caso 2: la recomendacion es sobre un ad dentro de un adset gestionado
        if (rec.entity_type === 'ad') {
          const adSnap = sharedData.adSnapshots.find(s => s.entity_id === rec.entity_id);
          if (adSnap && aiManagedAdSetIds.has(adSnap.parent_id)) {
            aiManagerRecs.push(rec);
            continue;
          }
        }
        humanRecs.push(rec);
      }

      // 12a. Convertir recomendaciones de ad sets AI-managed en directivas estrategicas
      const directivesCreated = await this._createDirectivesForAIManager(aiManagerRecs, cycleId);

      // 12b. Enriquecer recomendaciones normales con historial de impacto
      const enrichedRecs = this._enrichWithPastImpact(humanRecs, impactContext.processedActions || []);

      // 13. Guardar reporte en AgentReport (legacy — mantener para AI Ops dashboard)
      const report = await AgentReport.create({
        agent_type: 'brain',
        cycle_id: cycleId,
        summary: parsed.summary || 'Sin resumen',
        status: ['healthy', 'warning', 'critical'].includes(parsed.status) ? parsed.status : 'healthy',
        recommendations: enrichedRecs,
        alerts: (parsed.alerts || []).map(a => this._validateAlert(a)).filter(Boolean),
        prompt_tokens: response.usage?.input_tokens || 0,
        completion_tokens: response.usage?.output_tokens || 0
      });

      // 13b. Guardar en BrainRecommendation — sistema unificado con follow-up + learning
      const brainRecsCreated = await this._saveToBrainRecommendations(
        enrichedRecs, cycleId, sharedData, response.usage
      );
      logger.info(`[BRAIN] ${brainRecsCreated} recomendaciones guardadas en BrainRecommendation`);

      // 14. Auto-ejecutar segun modo de autonomia
      const autoExecuted = await this._autoExecuteRecommendations(report);

      // 15. Persistir memoria de análisis del ciclo (non-blocking)
      this._saveCycleMemory(cycleId, parsed, enrichedRecs, sharedData.accountOverview, response).catch(err => {
        logger.warn(`[BRAIN] Error guardando cycle memory: ${err.message}`);
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`═══ Cerebro IA completado en ${elapsed}s — ${report.recommendations.length} recomendaciones, ${autoExecuted} auto-ejecutadas, ${directivesCreated} directivas para AI Manager ═══`);

      return {
        cycleId,
        elapsed: `${elapsed}s`,
        recommendations: report.recommendations.length,
        report,
        autoExecuted,
        impactSummary: impactContext.summary
      };

    } catch (error) {
      logger.error(`[BRAIN] Error en ciclo [${cycleId}]: ${error.message}`);
      throw error;
    }
  }

  // ===== PRIVATE METHODS =====

  async _loadSharedData(cycleId) {
    const cooldownManager = new CooldownManager();
    const [snapshots, accountOverview, recentActions, activeCooldowns, creativeAssets, aiCreations, strategicDirectives] = await Promise.all([
      getLatestSnapshots(),
      getAccountOverview(),
      getRecentActions(3),
      cooldownManager.getActiveCooldowns(),
      CreativeAsset.find({ status: 'active' }).sort({ created_at: -1 }).lean().catch(() => []),
      AICreation.find({}).sort({ created_at: -1 }).limit(30).lean().catch(() => []),
      getActiveDirectives().catch(() => [])
    ]);

    if (snapshots.length === 0) return null;

    // Identificar ad sets gestionados por AI Manager (Brain los analiza pero no ejecuta directamente)
    const managedByAI = await AICreation.find({
      creation_type: 'create_adset',
      managed_by_ai: true,
      lifecycle_phase: { $nin: ['dead'] }
    }).select('meta_entity_id').lean().catch(() => []);
    const managedIds = new Set(managedByAI.map(m => m.meta_entity_id));

    const adSetSnapshots = snapshots.filter(s => s.entity_type === 'adset');
    const adSnapshots = snapshots.filter(s => s.entity_type === 'ad');
    const campaignSnapshots = snapshots.filter(s => s.entity_type === 'campaign');

    // Marcar cada ad set con su origen para que el Brain genere directivas en vez de acciones directas
    for (const snap of adSetSnapshots) {
      snap._ai_managed = managedIds.has(snap.entity_id);
    }

    if (managedIds.size > 0) {
      const managedCount = adSetSnapshots.filter(s => s._ai_managed).length;
      logger.info(`[BRAIN] ${managedCount} ad sets gestionados por AI Manager (supervisión jerárquica activa)`);
    }

    // ═══ BIDIRECTIONAL FEEDBACK: Load AI Manager's recent actions + directive compliance ═══
    let aiManagerFeedback = null;
    try {
      aiManagerFeedback = await this._loadAIManagerFeedback(managedIds);
    } catch (e) {
      logger.warn(`[BRAIN] Error cargando feedback del AI Manager: ${e.message}`);
    }

    // Load recommendation approval/rejection history for Brain learning
    let recommendationHistory = [];
    try {
      recommendationHistory = await BrainRecommendation.find({
        status: { $in: ['approved', 'rejected'] }
      }).sort({ decided_at: -1 }).limit(30).lean();
    } catch (e) {
      logger.warn(`[BRAIN] Error cargando historial de recomendaciones: ${e.message}`);
    }

    // Load recent cycle memories (Claude's persistent analysis memory)
    let cycleMemories = [];
    try {
      cycleMemories = await BrainCycleMemory.find({})
        .sort({ created_at: -1 })
        .limit(5)
        .lean();
    } catch (e) {
      logger.warn(`[BRAIN] Error cargando cycle memories: ${e.message}`);
    }

    // Load BrainMemory for diagnostic engine (entity trends & remembered metrics)
    let memories = [];
    try {
      memories = await BrainMemory.find({}).lean();
    } catch (e) {
      logger.warn(`[BRAIN] Error cargando BrainMemory: ${e.message}`);
    }

    // Load temporal patterns for day-of-week context
    let temporalPatterns = [];
    try {
      temporalPatterns = await BrainTemporalPattern.find({ pattern_type: 'day_of_week', level: 'account' }).lean();
    } catch (e) {
      logger.warn(`[BRAIN] Error cargando temporal patterns: ${e.message}`);
    }

    // Load pause context for paused ad sets (who paused, why, when)
    let pauseContextMap = {};
    try {
      const pausedIds = adSetSnapshots
        .filter(s => ['PAUSED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED'].includes(s.status))
        .map(s => s.entity_id);

      if (pausedIds.length > 0) {
        const pauseActions = await ActionLog.find({
          entity_id: { $in: pausedIds },
          action: { $in: ['pause', 'kill_switch'] },
          success: true
        }).sort({ executed_at: -1 }).lean();

        for (const a of pauseActions) {
          if (!pauseContextMap[a.entity_id]) {
            pauseContextMap[a.entity_id] = {
              paused_by: a.agent_type || 'unknown',
              reasoning: a.reasoning || null,
              executed_at: a.executed_at,
              days_ago: Math.round((Date.now() - new Date(a.executed_at).getTime()) / 86400000),
              metrics_at_pause: a.metrics_at_execution || null
            };
          }
        }
      }
    } catch (e) {
      logger.warn(`[BRAIN] Error cargando contexto de pausas: ${e.message}`);
    }

    logger.info(`[BRAIN] Datos cargados: ${adSetSnapshots.length} ad sets, ${adSnapshots.length} ads, ${campaignSnapshots.length} campanas, ${activeCooldowns.length} cooldowns, ${recommendationHistory.length} rec history, ${cycleMemories.length} cycle memories`);

    return {
      cycleId,
      snapshots,
      adSetSnapshots,
      adSnapshots,
      campaignSnapshots,
      accountOverview,
      recentActions,
      activeCooldowns,
      creativeAssets,
      aiCreations,
      strategicDirectives,
      aiManagerFeedback,
      recommendationHistory,
      cycleMemories,
      memories,
      temporalPatterns,
      pauseContextMap
    };
  }

  /**
   * Load AI Manager's recent actions and directive compliance for Brain awareness.
   * Returns: { actions: [...], compliance: { total_directives, acted_on, ignored, compliance_rate }, summary: "..." }
   */
  async _loadAIManagerFeedback(managedIds) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000); // Last 24h

    // 1. Get AI Manager actions in last 24h
    const aiManagerActions = await ActionLog.find({
      agent_type: 'ai_manager',
      created_at: { $gte: since }
    }).sort({ created_at: -1 }).limit(50).lean();

    // 2. Get directives created in last 72h for compliance tracking
    const recentDirectives = await StrategicDirective.find({
      source_insight_type: 'brain_supervision',
      created_at: { $gte: new Date(Date.now() - 72 * 60 * 60 * 1000) }
    }).lean();

    // 3. Calculate compliance: how many directives were acted upon?
    const directivesByEntity = new Map();
    for (const d of recentDirectives) {
      const key = d.entity_id;
      if (!directivesByEntity.has(key)) directivesByEntity.set(key, []);
      directivesByEntity.get(key).push(d);
    }

    let totalDirectiveEntities = directivesByEntity.size;
    let actedOn = 0;
    let ignored = 0;

    for (const [entityId, directives] of directivesByEntity) {
      // Check if AI Manager took any action on this entity
      const hasAction = aiManagerActions.some(a =>
        a.entity_id === entityId || a.entity_name === directives[0]?.entity_name
      );
      // Also check if directive was marked as applied
      const hasApplied = directives.some(d => d.status === 'applied' || d.applied_count > 0);

      if (hasAction || hasApplied) {
        actedOn++;
      } else {
        ignored++;
      }
    }

    const complianceRate = totalDirectiveEntities > 0
      ? Math.round((actedOn / totalDirectiveEntities) * 100)
      : 100;

    // 4. Build summary for Brain's context
    const actionSummary = aiManagerActions.slice(0, 10).map(a => {
      const ago = Math.round((Date.now() - new Date(a.created_at).getTime()) / (60 * 60 * 1000));
      return `  - [${ago}h ago] ${a.action} on ${a.entity_name || a.entity_id}: ${a.reasoning?.substring(0, 120) || 'N/A'}`;
    });

    const ignoredEntities = [];
    for (const [entityId, directives] of directivesByEntity) {
      const hasAction = aiManagerActions.some(a => a.entity_id === entityId);
      const hasApplied = directives.some(d => d.status === 'applied' || d.applied_count > 0);
      if (!hasAction && !hasApplied) {
        ignoredEntities.push({
          entity_id: entityId,
          entity_name: directives[0]?.entity_name || entityId,
          directive_count: directives.length,
          directive_types: [...new Set(directives.map(d => `${d.directive_type}/${d.target_action}`))],
          oldest_hours: Math.round((Date.now() - new Date(directives[directives.length - 1]?.created_at || Date.now()).getTime()) / (60 * 60 * 1000))
        });
      }
    }

    const summary = [
      `AI Manager Feedback (last 24h):`,
      `  Actions executed: ${aiManagerActions.length}`,
      `  Directive compliance: ${complianceRate}% (${actedOn}/${totalDirectiveEntities} entities acted on)`,
      aiManagerActions.length > 0 ? `  Recent actions:\n${actionSummary.join('\n')}` : '  No recent actions.',
      ignoredEntities.length > 0 ? `  IGNORED directives (${ignoredEntities.length} entities):\n${ignoredEntities.map(e => `    - ${e.entity_name}: ${e.directive_count} directives (${e.directive_types.join(', ')}) — ignored for ${e.oldest_hours}h`).join('\n')}` : ''
    ].filter(Boolean).join('\n');

    if (complianceRate < 50 && totalDirectiveEntities >= 2) {
      logger.warn(`[BRAIN] AI Manager compliance bajo: ${complianceRate}% — ${ignored} entidades con directivas ignoradas`);
    }

    return {
      actions: aiManagerActions,
      compliance: {
        total_directive_entities: totalDirectiveEntities,
        acted_on: actedOn,
        ignored,
        compliance_rate: complianceRate
      },
      ignored_entities: ignoredEntities,
      summary
    };
  }

  _buildLearnerSummary(state, learningResult) {
    if (!state || !state.buckets || Object.keys(state.buckets).length === 0) {
      return 'Sin datos de aprendizaje aun. Sistema en fase inicial.';
    }

    const lines = [];
    lines.push(`Total muestras de aprendizaje: ${state.total_samples || 0}`);

    if (learningResult.processed > 0) {
      lines.push(`Ultimo ciclo: ${learningResult.processed} acciones procesadas, reward medio: ${learningResult.averageReward.toFixed(3)}`);
    }

    // Resumir top buckets con mas datos
    const bucketEntries = Object.entries(state.buckets)
      .map(([bucket, actions]) => {
        const total = Object.values(actions).reduce((s, a) => s + (a.count || 0), 0);
        return { bucket, actions, total };
      })
      .filter(b => b.total >= 3)
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);

    if (bucketEntries.length > 0) {
      lines.push('Patrones detectados por contexto:');
      for (const { bucket, actions } of bucketEntries) {
        const actionSummary = Object.entries(actions)
          .filter(([, s]) => s.count >= 2)
          .map(([action, s]) => {
            const mean = s.alpha / (s.alpha + s.beta);
            return `${action}: ${(mean * 100).toFixed(0)}% exito (${s.count} muestras)`;
          })
          .join(', ');
        if (actionSummary) {
          lines.push(`  [${bucket}]: ${actionSummary}`);
        }
      }
    }

    return lines.join('\n');
  }

  async _callClaude(systemPrompt, userPrompt) {
    try {
      const message = await this.anthropic.messages.create({
        model: config.claude.model,
        max_tokens: 16384,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      });
      return { text: message.content[0].text, usage: message.usage, stopReason: message.stop_reason };
    } catch (error) {
      if (error.status === 429) {
        logger.warn('[BRAIN] Rate limit, esperando 15s...');
        await new Promise(r => setTimeout(r, 15000));
        try {
          const retry = await this.anthropic.messages.create({
            model: config.claude.model,
            max_tokens: 16384,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }]
          });
          return { text: retry.content[0].text, usage: retry.usage, stopReason: retry.stop_reason };
        } catch (retryErr) {
          logger.error(`[BRAIN] Retry fallido: ${retryErr.message}`);
          return null;
        }
      }
      logger.error(`[BRAIN] Error Claude: ${error.message || error.status}`);
      return null;
    }
  }

  _parseResponse(rawText) {
    try {
      let cleaned = rawText.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
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
      logger.warn(`[BRAIN] Error parseando JSON: ${error.message}`);
      // Intentar recuperar JSON truncado (truncado por max_tokens)
      const recovered = this._recoverTruncatedJSON(rawText);
      if (recovered) {
        logger.info(`[BRAIN] JSON truncado recuperado OK: ${(recovered.recommendations || []).length} recomendaciones`);
        return recovered;
      }
      logger.error(`[BRAIN] Raw (first 500 chars): ${rawText.substring(0, 500)}`);
      return null;
    }
  }

  /**
   * Intenta recuperar un JSON truncado cerrando brackets/arrays abiertos.
   * Busca la ultima recomendacion completa y cierra la estructura.
   */
  _recoverTruncatedJSON(rawText) {
    try {
      let cleaned = rawText.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      const jsonStart = cleaned.indexOf('{');
      if (jsonStart === -1) return null;
      cleaned = cleaned.substring(jsonStart);

      // Buscar el ultimo objeto de recomendacion completo (termina con })
      // La estructura es: { "summary":..., "recommendations": [ {...}, {...}, ... ], "alerts": [...] }
      // Si se trunco en medio de recommendations, cortamos ahi

      // Encontrar la posicion del array de recommendations
      const recsStart = cleaned.indexOf('"recommendations"');
      if (recsStart === -1) return null;

      const arrayStart = cleaned.indexOf('[', recsStart);
      if (arrayStart === -1) return null;

      // Encontrar todos los objetos {} completos dentro del array
      let depth = 0;
      let lastCompleteObjEnd = -1;
      let inString = false;
      let escape = false;

      for (let i = arrayStart + 1; i < cleaned.length; i++) {
        const ch = cleaned[i];

        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"' && !escape) { inString = !inString; continue; }
        if (inString) continue;

        if (ch === '{') depth++;
        if (ch === '}') {
          depth--;
          if (depth === 0) {
            lastCompleteObjEnd = i;
          }
        }
        // Si encontramos el cierre del array de recommendations
        if (ch === ']' && depth === 0) {
          // El array ya estaba cerrado, no es truncado en recommendations
          break;
        }
      }

      if (lastCompleteObjEnd === -1) return null;

      // Reconstruir: tomar hasta la ultima recomendacion completa, cerrar arrays y objetos
      const truncated = cleaned.substring(0, lastCompleteObjEnd + 1);
      const recoveredJSON = truncated + '], "alerts": [] }';

      const parsed = JSON.parse(recoveredJSON);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (err) {
      logger.warn(`[BRAIN] Recovery tambien fallo: ${err.message}`);
      return null;
    }
  }

  _validateRecommendation(rec, sharedData, impactContext) {
    if (!rec || typeof rec !== 'object') return null;
    if (!VALID_ACTIONS.includes(rec.action)) return null;
    if (!rec.entity_id) return null;
    if (rec.action === 'no_action') return null;
    // 'observe' is a valid non-modifying action (follow-up for cooldown entities)

    // Hard block: no changes to AI-created entities in learning phase
    const aiCreations = sharedData.aiCreations || [];
    const protectedEntity = aiCreations.find(c =>
      c.meta_entity_id === String(rec.entity_id) &&
      ['created', 'activating', 'learning'].includes(c.lifecycle_phase)
    );
    if (protectedEntity) {
      logger.info(`[BRAIN] Bloqueada: ${rec.action} en ${rec.entity_name || rec.entity_id} — en ${protectedEntity.lifecycle_phase}`);
      return null;
    }

    // Hard block: no repetir misma accion en entidad que tuvo resultado negativo recientemente
    // Usa delta_roas_pct < 0 (cualquier caida) en vez de solo 'worsened' (< -5%)
    if (impactContext.processedActions && ['scale_up', 'scale_down', 'pause', 'reactivate'].includes(rec.action)) {
      const recentNegative = impactContext.processedActions.find(a =>
        a.entity_id === String(rec.entity_id) &&
        a.action === rec.action &&
        a.delta_roas_pct < 0 &&
        a.executed_at && (Date.now() - new Date(a.executed_at).getTime()) < 7 * 24 * 60 * 60 * 1000
      );
      if (recentNegative) {
        logger.info(`[BRAIN] Bloqueada: ${rec.action} en ${rec.entity_name || rec.entity_id} — misma accion tuvo resultado negativo hace ${Math.round((Date.now() - new Date(recentNegative.executed_at).getTime()) / (1000 * 60 * 60 * 24))}d (ROAS ${recentNegative.delta_roas_pct > 0 ? '+' : ''}${recentNegative.delta_roas_pct}%)`);
        return null;
      }
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
      target_entity_id: rec.target_entity_id || null,
      target_entity_name: rec.target_entity_name || null,
      creative_asset_id: rec.creative_asset_id || null,
      bid_strategy: rec.bid_strategy || null,
      duplicate_name: rec.duplicate_name || null,
      duplicate_strategy: rec.duplicate_strategy || null,
      ad_name: rec.ad_name || null,
      ad_headline: rec.ad_headline || null,
      ad_primary_text: rec.ad_primary_text || null,
      creative_rationale: rec.creative_rationale || null,
      ads_to_pause: Array.isArray(rec.ads_to_pause) ? rec.ads_to_pause.filter(id => typeof id === 'string' && id.length > 0) : [],
      status: 'pending'
    };

    // Calcular change_percent
    if (['scale_up', 'scale_down'].includes(clean.action) && clean.current_value > 0) {
      clean.change_percent = ((clean.recommended_value - clean.current_value) / clean.current_value) * 100;
    }

    return clean;
  }

  _validateAlert(alert) {
    if (!alert || typeof alert !== 'object') return null;
    return {
      type_name: String(alert.type || alert.type_name || 'unknown'),
      message: String(alert.message || 'Sin mensaje'),
      severity: ['critical', 'warning', 'info'].includes(alert.severity) ? alert.severity : 'info'
    };
  }

  // FIX 4: baseScore calculado desde métricas reales + señal de Claude.
  // Antes: solo usaba el string de Claude ('low'→0.48), ignorando que un
  // ad set con ROAS 5.47x y 69 compras merece score alto.
  // Ahora: métricas aportan 60% y Claude 40%, reflejando datos + juicio AI.
  _baseScoreFromConfidence(confidence, metrics = {}) {
    // Señal de Claude (40% del peso)
    const claudeSignal = confidence === 'high' ? 0.85 : confidence === 'medium' ? 0.65 : 0.45;

    // Señal de métricas (60% del peso)
    const roasTarget = kpiTargets.roas_target || 3;
    const cpaTarget = kpiTargets.cpa_target || 25;
    const roas7d = metrics.roas_7d || 0;
    const cpa7d = metrics.cpa_7d || 0;
    const purchases7d = metrics.purchases_7d || 0;

    const roasRatio = Math.min(roas7d / Math.max(roasTarget, 0.1), 2); // cap en 2x target
    const cpaRatio = cpa7d > 0 ? Math.min(cpaTarget / cpa7d, 2) : 0.5; // bueno si CPA < target
    const volumeSignal = Math.min(purchases7d / 30, 1); // 30 compras = señal completa

    const metricsSignal = (roasRatio * 0.45 + cpaRatio * 0.30 + volumeSignal * 0.25) / 2;
    const metricsClamped = Math.max(0.20, Math.min(0.85, metricsSignal));

    return Math.max(0.20, Math.min(0.85, metricsClamped * 0.60 + claudeSignal * 0.40));
  }

  /**
   * Detecta ad sets con fatiga creativa alta y fuerza recomendaciones de rotacion.
   * Se inyecta ANTES del ranking para que tenga prioridad sobre las recomendaciones de Claude.
   * Condiciones: creative_fatigue_score > 0.6, frequency_7d > 3.0, status ACTIVE.
   */
  _injectCreativeRotationRecs(features, sharedData, cooldownEntityIds, pendingEntityIds) {
    const injected = [];
    const creativeIntelCfg = unifiedPolicyConfig.creative_intelligence || {};
    const fatigueThreshold = 0.6;
    const frequencyThreshold = creativeIntelCfg.severe_fatigue_frequency || 3.8;

    // Solo ad sets activos con fatiga alta
    const fatiguedAdSets = features.filter(f =>
      f.entity_type === 'adset' &&
      f.status === 'ACTIVE' &&
      (f.derived?.creative_fatigue_score || 0) >= fatigueThreshold &&
      (f.metrics?.frequency_7d || 0) >= frequencyThreshold &&
      !cooldownEntityIds.has(f.entity_id) &&
      !pendingEntityIds.has(f.entity_id)
    );

    if (fatiguedAdSets.length === 0) return [];

    // Para cada ad set fatigado, buscar el peor ad para pausar
    const adSnapshots = sharedData.adSnapshots || [];

    const now = new Date();
    for (const adset of fatiguedAdSets) {
      const entityId = adset.entity_id;

      // Buscar ads activos de este ad set
      const activeAds = adSnapshots.filter(ad =>
        ad.parent_id === entityId &&
        ad.status === 'ACTIVE'
      );

      if (activeAds.length === 0) continue;

      // Classify each ad: learning / fatigued / drag / healthy
      const classified = activeAds.map(ad => {
        const createdTime = ad.meta_created_time || ad.created_time || ad.created_at;
        const ageHours = createdTime ? (now - new Date(createdTime)) / (1000 * 60 * 60) : Infinity;
        const ageDays = Math.floor(ageHours / 24);
        const roas7d = ad.metrics?.last_7d?.roas || 0;
        const ctr7d = ad.metrics?.last_7d?.ctr || 0;
        const spend7d = ad.metrics?.last_7d?.spend || 0;
        const freq7d = ad.metrics?.last_7d?.frequency || 0;

        const kpiRoasTarget = kpiTargets.roas_target || 3;
        let tag;
        if (ageHours < 72) {
          tag = 'learning';
        } else if ((freq7d >= 4.0 || ageDays >= 28) && roas7d < kpiRoasTarget * 0.8) {
          tag = 'fatigued';
        } else if (roas7d < (adset.metrics?.roas_7d || 0) * 0.4 && spend7d > 5) {
          tag = 'drag';
        } else {
          tag = 'healthy';
        }

        return { entity_id: ad.entity_id, entity_name: ad.entity_name, tag, roas_7d: roas7d, ctr_7d: ctr7d, spend_7d: spend7d, freq_7d: freq7d, age_days: ageDays };
      });

      const learningAds = classified.filter(a => a.tag === 'learning');
      const pauseCandidates = classified.filter(a => a.tag === 'fatigued' || a.tag === 'drag');
      const healthyAds = classified.filter(a => a.tag === 'healthy');

      // If ALL ads are learning, skip — ad set is too new to judge
      if (learningAds.length === activeAds.length) {
        logger.info(`[BRAIN][ROTACIÓN] Skipping ${adset.entity_name} — all ${activeAds.length} ads are in learning phase`);
        continue;
      }

      const fatigueScore = adset.derived?.creative_fatigue_score || 0;
      const frequency = adset.metrics?.frequency_7d || 0;

      // Build detailed evidence
      const evidence = [
        `Fatiga creativa: ${fatigueScore.toFixed(2)} (umbral 0.6)`,
        `Frecuencia 7d: ${frequency.toFixed(1)} (umbral ${frequencyThreshold})`,
        `Ads activos: ${activeAds.length} (${learningAds.length} learning, ${pauseCandidates.length} fatigados/drag, ${healthyAds.length} sanos)`
      ];
      if (learningAds.length > 0) {
        evidence.push(`Ads en learning (protegidos): ${learningAds.map(a => a.entity_name).join(', ')}`);
      }

      // Inyectar create_ad
      injected.push({
        action: 'create_ad',
        entity_type: 'adset',
        entity_id: entityId,
        entity_name: adset.entity_name,
        current_value: adset.current_budget,
        recommended_value: 0,
        change_percent: 0,
        reasoning: `[ROTACIÓN FORZADA] Fatiga creativa ${fatigueScore.toFixed(2)}, frecuencia ${frequency.toFixed(1)}. ${pauseCandidates.length} ads fatigados/drag identificados${learningAds.length > 0 ? `, ${learningAds.length} ads en learning protegidos` : ''}. Necesita creativo fresco.`,
        expected_impact: `Reducir fatiga de ${fatigueScore.toFixed(2)} a <0.4 con creativo nuevo`,
        confidence: 'high',
        priority: 'high',
        policy_score: 0.88,
        confidence_score: 0.75,
        risk_score: 0.15,
        uncertainty_score: 0.20,
        expected_impact_pct: 8,
        measurement_window_hours: 72,
        hypothesis: `La fatiga creativa (${fatigueScore.toFixed(2)}) y frecuencia alta (${frequency.toFixed(1)}) indican saturación. Un creativo fresco debería mejorar CTR y ROAS.`,
        evidence,
        metrics: adset.metrics || {},
        ads_to_pause: pauseCandidates.map(a => a.entity_id),
        status: 'pending',
        _injected_by: 'creative_rotation_trigger'
      });

      // Pause each fatigued/drag ad individually (but NEVER learning ads)
      for (const bad of pauseCandidates) {
        // Only pause if there will be at least 1 non-learning ad remaining (or learning ads to take over)
        const remainingAfterPause = activeAds.length - pauseCandidates.indexOf(bad) - 1 + learningAds.length + healthyAds.length;
        if (remainingAfterPause < 1) continue;

        const reasonTag = bad.tag === 'fatigued'
          ? `Fatigado (freq ${bad.freq_7d.toFixed(1)}, ${bad.age_days}d activo)`
          : `Drag (ROAS ${bad.roas_7d.toFixed(2)}x vs ad set ${(adset.metrics?.roas_7d || 0).toFixed(2)}x)`;

        injected.push({
          action: 'update_ad_status',
          entity_type: 'ad',
          entity_id: bad.entity_id,
          entity_name: bad.entity_name,
          current_value: 1,
          recommended_value: 0,
          change_percent: 0,
          reasoning: `[ROTACIÓN FORZADA] ${reasonTag}. Pausar para liberar presupuesto.`,
          expected_impact: `Liberar $${bad.spend_7d.toFixed(0)}/sem de gasto ineficiente`,
          confidence: 'high',
          priority: 'high',
          policy_score: 0.85,
          confidence_score: 0.72,
          risk_score: 0.18,
          uncertainty_score: 0.22,
          expected_impact_pct: 6,
          measurement_window_hours: 72,
          hypothesis: `${reasonTag}. Pausar libera presupuesto para creativos frescos/sanos.`,
          evidence: [
            `Tag: [${bad.tag.toUpperCase()}]`,
            `ROAS 7d: ${bad.roas_7d.toFixed(2)}x | CTR: ${bad.ctr_7d.toFixed(2)}% | Freq: ${bad.freq_7d.toFixed(1)}`,
            `Gasto 7d: $${bad.spend_7d.toFixed(2)} | Edad: ${bad.age_days}d`
          ],
          metrics: {},
          status: 'pending',
          _injected_by: 'creative_rotation_trigger'
        });
      }

      logger.info(`[BRAIN][ROTACIÓN] Ad set ${adset.entity_name} (fatiga=${fatigueScore.toFixed(2)}, freq=${frequency.toFixed(1)}) — create_ad + ${pauseCandidates.length} pausas (${learningAds.length} learning protegidos)`);
    }

    return injected;
  }

  /**
   * Detecta recomendaciones de pausa (update_ad_status) que dejarían un ad set con 0 ads activos.
   * Para cada caso, auto-inyecta un create_ad compañero para que el ad set no muera.
   * Solo inyecta si NO existe ya un create_ad para ese ad set en las recs del ciclo.
   */
  _injectCompanionCreateAds(currentRecs, sharedData) {
    const injected = [];
    const adSnapshots = sharedData.adSnapshots || [];
    const creativeAssets = sharedData.creativeAssets || [];

    // Encontrar todas las pausas de ads en este ciclo
    const pauseRecs = currentRecs.filter(r =>
      r.action === 'update_ad_status' &&
      r.entity_type === 'ad' &&
      (r.recommended_value === 0 || r.recommended_value === '0' || r.recommended_value === 'PAUSED')
    );

    if (pauseRecs.length === 0) return [];

    // Agrupar pausas por ad set padre
    const pausesByAdSet = {};
    for (const rec of pauseRecs) {
      const adSnap = adSnapshots.find(s => s.entity_id === rec.entity_id);
      const parentId = adSnap?.parent_id;
      if (!parentId) continue;
      if (!pausesByAdSet[parentId]) pausesByAdSet[parentId] = [];
      pausesByAdSet[parentId].push(rec);
    }

    // Ad sets que ya tienen create_ad en este ciclo
    const adSetsWithCreateAd = new Set(
      currentRecs
        .filter(r => r.action === 'create_ad')
        .map(r => r.entity_id)
    );

    for (const [adSetId, pauses] of Object.entries(pausesByAdSet)) {
      // Si ya hay create_ad para este ad set, skip
      if (adSetsWithCreateAd.has(adSetId)) continue;

      // Contar ads activos en este ad set
      const activeAds = adSnapshots.filter(ad =>
        ad.parent_id === adSetId && ad.status === 'ACTIVE'
      );

      // IDs que se van a pausar
      const pauseIds = new Set(pauses.map(p => p.entity_id));

      // Ads que quedarían activos después de las pausas
      const remainingActive = activeAds.filter(ad => !pauseIds.has(ad.entity_id));

      if (remainingActive.length > 0) continue; // Quedan ads activos, no hay problema

      // El ad set quedaría vacío — inyectar create_ad compañero
      const adSetSnap = sharedData.adSetSnapshots?.find(s => s.entity_id === adSetId);
      const adSetName = adSetSnap?.entity_name || `Ad Set ${adSetId}`;
      const adSetRoas = adSetSnap?.metrics?.last_7d?.roas || 0;
      const adSetSpend = adSetSnap?.metrics?.last_7d?.spend || 0;

      // Buscar mejor creativo disponible para sugerir
      const readyCreatives = creativeAssets.filter(c =>
        c.status === 'approved' || c.status === 'ready'
      );
      const bestCreative = readyCreatives.length > 0
        ? readyCreatives.sort((a, b) => (b.judge_score || 0) - (a.judge_score || 0))[0]
        : null;

      const creativeSuggestion = bestCreative
        ? ` Sugerido: '${bestCreative.style || bestCreative.name}' (score ${bestCreative.judge_score || 'N/A'}, ID ${bestCreative._id}).`
        : ' No hay creativos aprobados — generar uno nuevo es prioritario.';

      // Heredar score de la pausa más alta del grupo (son acciones vinculadas)
      const highestPause = pauses.sort((a, b) => (b.policy_score || 0) - (a.policy_score || 0))[0];

      injected.push({
        action: 'create_ad',
        entity_type: 'adset',
        entity_id: adSetId,
        entity_name: adSetName,
        current_value: 0,
        recommended_value: 0,
        change_percent: 0,
        reasoning: `[REEMPLAZO OBLIGATORIO] ${adSetName} quedaría con 0 ads activos tras pausar ${pauses.length} ad(s). Se necesita creativo de reemplazo urgente para mantener el ad set vivo.${creativeSuggestion}`,
        expected_impact: `Mantener ${adSetName} activo con creativo fresco. Sin reemplazo, se pierde ~$${Math.round(adSetSpend / 7)}/día de inversión.`,
        confidence: highestPause.confidence || 'medium',
        priority: 'urgente',
        policy_score: Math.max((highestPause.policy_score || 0.5) + 0.05, 0.55),
        confidence_score: Math.max((highestPause.confidence_score || 0.4) + 0.05, 0.45),
        risk_score: 0.20,
        uncertainty_score: 0.25,
        expected_impact_pct: 7,
        measurement_window_hours: 72,
        hypothesis: `${adSetName} perderá TODO su tráfico si se pausan los ${pauses.length} ad(s) sin reemplazo. El create_ad es condición necesaria para que la pausa tenga sentido.`,
        evidence: [
          `Ads activos actuales: ${activeAds.length}`,
          `Ads a pausar: ${pauses.length} (${pauses.map(p => p.entity_name).join(', ')})`,
          `Ads restantes tras pausa: 0 — ad set MUERTO sin reemplazo`,
          `ROAS 7d del ad set: ${adSetRoas.toFixed ? adSetRoas.toFixed(2) : adSetRoas}x | Spend 7d: $${adSetSpend.toFixed ? adSetSpend.toFixed(0) : adSetSpend}`
        ],
        metrics: adSetSnap?.metrics || {},
        creative_asset_id: bestCreative?._id?.toString() || null,
        status: 'pending',
        _injected_by: 'companion_create_ad',
        _companion_of: pauses.map(p => p.entity_id)
      });

      logger.info(`[BRAIN][COMPANION] ${adSetName} — inyectando create_ad obligatorio (${pauses.length} pausas dejarían 0 ads activos)`);
    }

    return injected;
  }

  /**
   * Guarda recomendaciones del UnifiedBrain en BrainRecommendation.
   * Esto las integra con el follow-up multi-fase (3d/7d),
   * BrainMemory action_history, y AI impact analysis.
   */
  async _saveToBrainRecommendations(recs, cycleId, sharedData, usage) {
    if (!recs || recs.length === 0) return 0;

    // Expirar recomendaciones pendientes >24h (dar tiempo al usuario para actuar)
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 3600000);
    const expired = await BrainRecommendation.updateMany(
      { status: 'pending', created_at: { $lt: twentyFourHoursAgo } },
      { $set: { status: 'expired', updated_at: new Date() } }
    );
    if (expired.modifiedCount > 0) {
      logger.info(`[BRAIN] ${expired.modifiedCount} recomendaciones anteriores expiradas`);
    }

    // Cargar follow-ups activos para deduplicación
    const activeFollowUps = await BrainRecommendation.find({
      status: 'approved',
      'follow_up.current_phase': { $in: ['awaiting_day_3', 'awaiting_day_7'] }
    }).lean();

    const followUpMap = {};
    for (const fu of activeFollowUps) {
      if (fu.entity?.entity_id) {
        followUpMap[fu.entity.entity_id] = {
          rec_id: fu._id,
          title: fu.title,
          action_type: fu.action_type,
          current_phase: fu.follow_up?.current_phase || 'awaiting_day_3',
          day_3_verdict: fu.follow_up?.phases?.day_3?.verdict || null,
          decided_at: fu.decided_at
        };
      }
    }

    let created = 0;
    const tokensPerRec = usage ? Math.ceil(((usage.input_tokens || 0) + (usage.output_tokens || 0)) / recs.length) : 0;

    for (const rec of recs) {
      try {
        const entityId = rec.entity_id;

        // Deduplicación vs follow-ups activos
        const existingFU = entityId ? followUpMap[entityId] : null;
        if (existingFU) {
          const phase = existingFU.current_phase;
          const sameAction = existingFU.action_type === rec.action;
          const day3Measured = phase !== 'awaiting_day_3';
          const day3Negative = existingFU.day_3_verdict === 'negative';

          if (!day3Measured && sameAction) {
            logger.info(`[BRAIN] Skipped BrainRec: ${rec.entity_name} — misma acción en seguimiento temprano (${phase})`);
            continue;
          }
          if (sameAction && !day3Negative) {
            logger.info(`[BRAIN] Skipped BrainRec: ${rec.entity_name} — misma acción en seguimiento`);
            continue;
          }
        }

        // Buscar snapshot para métricas baseline
        const snap = sharedData.adSetSnapshots?.find(s => s.entity_id === entityId)
          || sharedData.adSnapshots?.find(s => s.entity_id === entityId);
        const m7d = snap?.metrics?.last_7d || {};

        // Mapear priority: UnifiedBrain usa critical/high/medium/low → BrainRec usa urgente/evaluar
        const priorityMap = { critical: 'urgente', high: 'urgente', medium: 'evaluar', low: 'evaluar' };

        // Buscar parent ad set para recs a nivel de ad
        let parentAdsetId = null;
        let parentAdsetName = null;
        if (rec.entity_type === 'ad') {
          const adSnap = sharedData.adSnapshots?.find(s => s.entity_id === entityId);
          if (adSnap?.parent_id) {
            parentAdsetId = adSnap.parent_id;
            const parentSnap = sharedData.adSetSnapshots?.find(s => s.entity_id === adSnap.parent_id);
            parentAdsetName = parentSnap?.entity_name || '';
          }
        }

        const createData = {
          priority: priorityMap[rec.priority] || 'evaluar',
          action_type: rec.action,
          entity: {
            entity_type: rec.entity_type || 'adset',
            entity_id: entityId,
            entity_name: rec.entity_name || ''
          },
          parent_adset_id: parentAdsetId,
          parent_adset_name: parentAdsetName,
          title: (rec.reasoning || 'Recomendación').substring(0, 120),
          diagnosis: rec.hypothesis || '',
          expected_outcome: rec.expected_impact || '',
          risk: '',
          body: rec.evidence ? rec.evidence.join(' | ') : '',
          action_detail: `${rec.action} en ${rec.entity_name}${rec.recommended_value ? ` → $${rec.recommended_value}` : ''}`,
          supporting_data: {
            current_roas_7d: rec.metrics?.roas_7d || m7d.roas || 0,
            current_cpa_7d: rec.metrics?.cpa_7d || m7d.cpa || 0,
            current_spend_7d: rec.metrics?.spend_today ? rec.metrics.spend_today * 7 : (m7d.spend || 0),
            current_frequency_7d: rec.metrics?.frequency || m7d.frequency || 0,
            current_ctr_7d: rec.metrics?.ctr || m7d.ctr || 0,
            current_purchases_7d: m7d.purchases || 0,
            account_avg_roas_7d: sharedData.accountOverview?.roas_7d || 0,
            trend_direction: 'unknown',
            days_declining: 0
          },
          confidence: rec.confidence || 'medium',
          confidence_score: Math.round((rec.confidence_score || 0.5) * 100),
          cycle_id: cycleId,
          generated_by: 'ai',
          ai_model: 'claude-sonnet',
          tokens_used: tokensPerRec,
          'follow_up.metrics_at_recommendation': {
            roas_7d: m7d.roas || 0,
            cpa_7d: m7d.cpa || 0,
            spend_7d: m7d.spend || 0,
            frequency_7d: m7d.frequency || 0,
            ctr_7d: m7d.ctr || 0,
            purchases_7d: m7d.purchases || 0,
            purchase_value_7d: m7d.purchase_value || 0,
            daily_budget: snap?.daily_budget || 0,
            active_ads: snap?.ads_count || 0,
            status: snap?.status || 'UNKNOWN'
          }
        };

        // Adjuntar referencia al follow-up activo si existe
        if (existingFU) {
          createData.related_follow_up = {
            rec_id: existingFU.rec_id,
            title: existingFU.title,
            action_type: existingFU.action_type,
            current_phase: existingFU.current_phase,
            day_3_verdict: existingFU.day_3_verdict,
            decided_at: existingFU.decided_at
          };
        }

        await BrainRecommendation.create(createData);
        created++;
      } catch (saveErr) {
        logger.error(`[BRAIN] Error guardando BrainRecommendation: ${saveErr.message}`);
      }
    }

    return created;
  }

  _applyStrategicDirectives(recs, directives) {
    if (!directives || directives.length === 0) return recs;

    return recs.map(rec => {
      const matching = directives.filter(d =>
        d.entity_id === rec.entity_id ||
        (d.target_action && d.target_action === rec.action)
      );

      let scoreModifier = 0;
      for (const d of matching) {
        if (d.directive_type === 'protect') {
          logger.info(`[BRAIN] Directive PROTECT: skip ${rec.entity_name}`);
          return null;
        }
        if (d.directive_type === 'override' && d.target_action === rec.action) {
          rec.policy_score = Math.max(rec.policy_score || 0, 0.90);
          rec.reasoning = `[DIRECTIVE OVERRIDE] ${rec.reasoning}`;
        }
        if (d.directive_type === 'boost') {
          scoreModifier += (d.score_modifier || 0.15);
        }
        if (d.directive_type === 'suppress') {
          scoreModifier -= (d.score_modifier || 0.15);
        }
      }

      if (scoreModifier !== 0) {
        rec.policy_score = Math.max(0, Math.min(1, (rec.policy_score || 0) + scoreModifier));
      }

      return rec;
    }).filter(Boolean);
  }

  _enrichWithPastImpact(recs, processedActions) {
    if (!processedActions || processedActions.length === 0) return recs;

    return recs.map(rec => {
      // Buscar acciones pasadas en la misma entidad
      const entityHistory = processedActions.filter(a => a.entity_id === rec.entity_id).slice(0, 3);

      // Buscar acciones pasadas del mismo tipo de accion
      const actionHistory = processedActions.filter(a => a.action === rec.action).slice(0, 3);

      const pastImpact = [];

      for (const h of entityHistory) {
        const daysAgo = Math.round((Date.now() - new Date(h.executed_at).getTime()) / (1000 * 60 * 60 * 24));
        pastImpact.push({
          action: h.action,
          result: h.result,
          delta_roas_pct: h.delta_roas_pct,
          days_ago: daysAgo,
          source: 'entity'
        });
      }

      // Agregar historial por tipo de accion si no hay suficiente historial de entidad
      if (pastImpact.length < 3) {
        for (const h of actionHistory) {
          if (pastImpact.some(p => p.action === h.action && p.days_ago === Math.round((Date.now() - new Date(h.executed_at).getTime()) / (1000 * 60 * 60 * 24)))) continue;
          const daysAgo = Math.round((Date.now() - new Date(h.executed_at).getTime()) / (1000 * 60 * 60 * 24));
          pastImpact.push({
            action: h.action,
            result: h.result,
            delta_roas_pct: h.delta_roas_pct,
            days_ago: daysAgo,
            source: 'action_type'
          });
          if (pastImpact.length >= 3) break;
        }
      }

      rec.past_impact = pastImpact;
      return rec;
    });
  }

  /**
   * Convierte recomendaciones del Brain para ad sets AI-managed en directivas estratégicas.
   * El AI Manager lee estas directivas en su próximo ciclo y las incorpora en su decisión.
   */
  async _createDirectivesForAIManager(recs, cycleId) {
    if (!recs || recs.length === 0) return 0;

    let created = 0;
    for (const rec of recs) {
      try {
        // Mapear acción del Brain a tipo de directiva
        // Extended directive types for post-learning flow:
        //   boost       → favor this action (scale, reactivate)
        //   suppress    → disfavor (be conservative, don't scale)
        //   protect     → don't touch this entity
        //   override    → force this action
        //   stabilize   → just exited learning, wait 3-7 days before acting
        //   optimize_ads → clean up individual ads (pause bad ones, add fresh creatives)
        //   rescue      → CTR is good but no conversions, try creative refresh before killing
        let directiveType = 'boost';
        let targetAction = 'any';

        if (rec.action === 'pause') {
          directiveType = 'suppress';
          targetAction = 'pause';
        } else if (rec.action === 'scale_down') {
          directiveType = 'suppress';
          targetAction = 'scale_up';
        } else if (rec.action === 'scale_up') {
          directiveType = 'boost';
          targetAction = 'scale_up';
        } else if (rec.action === 'reactivate') {
          directiveType = 'boost';
          targetAction = 'reactivate';
        } else if (rec.action === 'optimize_ads' || rec.action === 'update_ad_status' || rec.action === 'create_ad') {
          directiveType = 'optimize_ads';
          targetAction = rec.action;
        }

        // Check for post-learning special cases
        if (rec._post_learning_directive) {
          directiveType = rec._post_learning_directive;
          targetAction = rec._post_learning_target || targetAction;
        }

        // Score modifier basado en la confianza y policy_score del Brain
        const scoreMod = rec.confidence === 'high' ? 0.3 : rec.confidence === 'medium' ? 0.2 : 0.1;

        // ═══ ENRICHED DIRECTIVE: classify reason, extract metrics, set urgency ═══
        const reasonCategory = this._classifyReasonCategory(rec);
        const urgencyLevel = this._classifyUrgency(rec, reasonCategory);
        const supportingMetrics = this._extractSupportingMetrics(rec);
        const suggestedActions = this._buildSuggestedActions(rec, reasonCategory);

        // Check for existing active directive with same entity+type+target (avoid spam)
        // If one exists from the last 24h, just update consecutive_count instead of creating duplicate
        const existingDirective = await StrategicDirective.findOne({
          entity_id: rec.entity_id,
          directive_type: directiveType,
          target_action: targetAction,
          source_insight_type: 'brain_supervision',
          status: 'active',
          created_at: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        }).sort({ created_at: -1 });

        if (existingDirective) {
          // Directive already exists — just bump consecutive_count and update reason
          existingDirective.consecutive_count = (existingDirective.consecutive_count || 1) + 1;
          existingDirective.reason = `[BRAIN→AI-MANAGER] ${rec.reasoning}`;
          existingDirective.supporting_metrics = supportingMetrics;
          existingDirective.urgency_level = urgencyLevel;
          await existingDirective.save();
          logger.info(`[BRAIN] Directiva existente actualizada (consecutive=${existingDirective.consecutive_count}) para ${rec.entity_name}: ${directiveType}/${targetAction}`);
          created++;
          continue;
        }

        // Count consecutive directives for same entity+type (escalation signal)
        let consecutiveCount = 1;
        try {
          const recentSame = await StrategicDirective.countDocuments({
            entity_id: rec.entity_id,
            directive_type: directiveType,
            target_action: targetAction,
            source_insight_type: 'brain_supervision',
            created_at: { $gte: new Date(Date.now() - 72 * 60 * 60 * 1000) }
          });
          consecutiveCount = recentSame + 1;
        } catch (_) { /* ignore count errors */ }

        await StrategicDirective.create({
          cycle_id: cycleId,
          directive_type: directiveType,
          entity_type: rec.entity_type || 'adset',
          entity_id: rec.entity_id,
          entity_name: rec.entity_name || '',
          target_action: targetAction,
          score_modifier: scoreMod,
          reason: `[BRAIN→AI-MANAGER] ${rec.reasoning}`,
          source_insight_type: 'brain_supervision',
          confidence: rec.confidence || 'medium',
          reason_category: reasonCategory,
          urgency_level: urgencyLevel,
          supporting_metrics: supportingMetrics,
          suggested_actions: suggestedActions,
          consecutive_count: consecutiveCount,
          expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000), // 72h — gives AI Manager multiple cycles to act
          status: 'active'
        });

        created++;
        logger.info(`[BRAIN] Directiva ${directiveType} creada para AI Manager: ${rec.action} en ${rec.entity_name} (${rec.entity_id})`);
      } catch (err) {
        logger.warn(`[BRAIN] Error creando directiva para ${rec.entity_id}: ${err.message}`);
      }
    }

    if (created > 0) {
      logger.info(`[BRAIN] ${created} directivas estratégicas creadas para AI Manager`);
    }
    return created;
  }

  /**
   * Classify the reason category for a recommendation.
   */
  _classifyReasonCategory(rec) {
    const reasoning = (rec.reasoning || '').toLowerCase();
    const metrics = rec.metrics || {};
    const roas = metrics.roas_7d || metrics.last_7d?.roas || 0;
    const purchases = metrics.purchases_7d || metrics.last_7d?.purchases || 0;
    const frequency = metrics.frequency_7d || metrics.last_7d?.frequency || 0;
    const cpa = metrics.cpa_7d || metrics.last_7d?.cpa || 0;

    // Priority order: most specific first
    if (purchases === 0 && (rec.action === 'pause' || rec.action === 'scale_down')) return 'no_conversions';
    if (reasoning.includes('fatiga') || reasoning.includes('fatigue') || reasoning.includes('frecuencia') || reasoning.includes('frequency') || reasoning.includes('rotaci')) return 'creative_fatigue';
    if (reasoning.includes('saturaci') || reasoning.includes('saturation') || frequency > 3.5) return 'audience_saturation';
    if (reasoning.includes('cpa') || reasoning.includes('cost per') || cpa > 0) {
      if (rec.action === 'pause' || rec.action === 'scale_down') return 'high_cpa';
    }
    if (reasoning.includes('roas') && (rec.action === 'pause' || rec.action === 'scale_down')) return 'low_roas';
    if (reasoning.includes('gasto') || reasoning.includes('spend') || reasoning.includes('waste')) return 'budget_waste';
    if (rec.action === 'scale_up' || rec.action === 'reactivate') {
      if (reasoning.includes('recuper') || reasoning.includes('recover') || reasoning.includes('mejora')) return 'recovery_signal';
      return 'strong_performer';
    }
    if (reasoning.includes('learning') || reasoning.includes('aprendizaje')) return 'learning_phase';
    if (roas > 0 && roas < 1.5 && rec.action === 'pause') return 'low_roas';

    return 'other';
  }

  /**
   * Determine urgency based on category and metrics.
   */
  _classifyUrgency(rec, category) {
    const metrics = rec.metrics || {};
    const roas = metrics.roas_7d || metrics.last_7d?.roas || 0;
    const spend = metrics.spend_7d || metrics.last_7d?.spend || 0;

    // Critical: burning money with no results
    if (category === 'no_conversions' && spend > 30) return 'critical';
    if (category === 'low_roas' && roas < 0.5 && spend > 20) return 'critical';
    if (category === 'budget_waste' && spend > 50) return 'critical';

    // High: clear underperformance
    if (category === 'low_roas' && roas < 1.0) return 'high';
    if (category === 'high_cpa') return 'high';
    if (category === 'no_conversions') return 'high';
    if (rec.confidence === 'high' && (rec.action === 'pause' || rec.action === 'scale_down')) return 'high';

    // Low: positive signals
    if (category === 'strong_performer' || category === 'recovery_signal') return 'low';
    if (category === 'learning_phase') return 'low';

    return 'medium';
  }

  /**
   * Extract key metrics from the recommendation to include in the directive.
   */
  _extractSupportingMetrics(rec) {
    const m = rec.metrics || {};
    const m7d = m.last_7d || m;
    const mToday = m.today || {};
    return {
      roas_7d: m7d.roas_7d || m7d.roas || 0,
      roas_3d: m.last_3d?.roas || m.roas_3d || 0,
      cpa_7d: m7d.cpa_7d || m7d.cpa || 0,
      spend_7d: m7d.spend_7d || m7d.spend || 0,
      spend_today: mToday.spend || 0,
      frequency_7d: m7d.frequency_7d || m7d.frequency || 0,
      ctr_7d: m7d.ctr_7d || m7d.ctr || 0,
      purchases_7d: m7d.purchases_7d || m7d.purchases || 0,
      daily_budget: m.daily_budget || rec.current_value || 0,
      fatigue_score: m.fatigue_score || 0
    };
  }

  /**
   * Build concrete suggested actions based on reason category.
   */
  _buildSuggestedActions(rec, category) {
    const actions = [];

    switch (category) {
      case 'no_conversions':
        actions.push({ action: 'pause_all_ads', detail: 'Zero purchases — pause all ads and minimize budget' });
        actions.push({ action: 'pause_worst_ads', detail: 'Pause all ads with 0 purchases first' });
        break;
      case 'low_roas':
        actions.push({ action: 'scale_down', detail: 'Cut budget 30-50% to limit losses' });
        actions.push({ action: 'pause_worst_ads', detail: 'Pause ads with ROAS below ad set average' });
        break;
      case 'high_cpa':
        actions.push({ action: 'scale_down', detail: 'Reduce budget to lower CPA pressure' });
        break;
      case 'creative_fatigue':
        actions.push({ action: 'add_fresh_creative', detail: 'Add new ad from creative bank' });
        actions.push({ action: 'pause_worst_ads', detail: 'Pause fatigued ads with declining CTR' });
        break;
      case 'audience_saturation':
        actions.push({ action: 'scale_down', detail: 'Reduce budget to lower frequency' });
        actions.push({ action: 'add_fresh_creative', detail: 'Fresh creative may re-engage audience' });
        break;
      case 'budget_waste':
        actions.push({ action: 'pause_all_ads', detail: 'High spend with poor return — pause all ads and minimize budget' });
        break;
      case 'strong_performer':
        actions.push({ action: 'scale_up', detail: 'Increase budget 15-20%' });
        break;
      case 'recovery_signal':
        actions.push({ action: 'scale_up', detail: 'Metrics improving — cautious scale up 10-15%' });
        break;
      default:
        if (rec.action === 'pause') actions.push({ action: 'pause', detail: rec.reasoning?.substring(0, 100) || '' });
        if (rec.action === 'scale_down') actions.push({ action: 'scale_down', detail: 'Reduce budget' });
        if (rec.action === 'scale_up') actions.push({ action: 'scale_up', detail: 'Increase budget' });
    }

    return actions;
  }

  /**
   * Persiste la memoria de análisis del ciclo actual.
   * Hace una llamada ligera a Claude pidiendo un resumen de conclusiones
   * para que el Brain recuerde su razonamiento entre ciclos.
   */
  /**
   * Validates active hypotheses from previous cycles against current data.
   * Returns { confirmed: [...], rejected: [...], still_active: [...] }
   */
  async _validateHypotheses(cycleMemories, accountOverview, adSetSnapshots) {
    if (!cycleMemories || cycleMemories.length === 0) return null;

    // Collect all active hypotheses across recent cycle memories
    const activeHypotheses = [];
    for (const mem of cycleMemories) {
      for (const h of (mem.hypotheses || [])) {
        if (h.status === 'active') {
          activeHypotheses.push({
            hypothesis: h.hypothesis,
            proposed_action: h.proposed_action,
            cycle_id: mem.cycle_id,
            created_at: mem.created_at,
            mem_id: mem._id
          });
        }
      }
    }

    if (activeHypotheses.length === 0) return null;

    // Build context summary for Claude to validate against
    const activeAdSets = (adSetSnapshots || []).filter(s => s.status === 'ACTIVE');
    const adSetSummary = activeAdSets.slice(0, 10).map(s => {
      const m7d = s.metrics?.last_7d || {};
      return `${s.entity_name}: ROAS ${(m7d.roas||0).toFixed(2)}x, CPA $${(m7d.cpa||0).toFixed(0)}, CTR ${(m7d.ctr||0).toFixed(2)}%, Freq ${(m7d.frequency||0).toFixed(1)}, Purchases ${m7d.purchases||0}`;
    }).join('\n');

    const hypList = activeHypotheses.map((h, i) => {
      const hoursAgo = Math.round((Date.now() - new Date(h.created_at).getTime()) / 3600000);
      return `${i + 1}. "${h.hypothesis}" (propuesta: ${h.proposed_action}) — formulada hace ${hoursAgo}h`;
    }).join('\n');

    const prompt = `Tienes hipótesis pendientes de validar con datos actuales.

HIPÓTESIS ACTIVAS:
${hypList}

DATOS ACTUALES:
ROAS 7d: ${(accountOverview.roas_7d||0).toFixed(2)}x | 3d: ${(accountOverview.roas_3d||0).toFixed(2)}x
Ad sets activos: ${accountOverview.active_adsets || 0}

AD SETS:
${adSetSummary}

Para cada hipótesis, evalúa si los datos actuales la confirman, refutan, o si necesita más tiempo.

Responde SOLO con JSON válido:
{
  "validations": [
    { "index": 1, "status": "confirmed|rejected|still_active", "reason": "Explicación breve basada en datos" }
  ]
}`;

    try {
      const response = await this.anthropic.messages.create({
        model: config.claude.model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      });

      const text = response.content[0]?.text || '';
      let cleaned = text.trim();
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      const parsed = JSON.parse(cleaned);

      const result = { confirmed: [], rejected: [], still_active: [] };

      for (const v of (parsed.validations || [])) {
        const idx = (v.index || 1) - 1;
        const hyp = activeHypotheses[idx];
        if (!hyp) continue;

        const status = v.status || 'still_active';
        const bucket = status === 'confirmed' ? result.confirmed
          : status === 'rejected' ? result.rejected
          : result.still_active;

        bucket.push({
          hypothesis: hyp.hypothesis,
          status,
          reason: v.reason || '',
          cycle_id: hyp.cycle_id
        });

        // Update the hypothesis status in DB
        if (status === 'confirmed' || status === 'rejected') {
          await BrainCycleMemory.updateOne(
            { _id: hyp.mem_id, 'hypotheses.hypothesis': hyp.hypothesis },
            { $set: {
              'hypotheses.$.status': status,
              'hypotheses.$.validated_at': new Date(),
              'hypotheses.$.validation_result': v.reason
            }}
          );
        }
      }

      const total = result.confirmed.length + result.rejected.length + result.still_active.length;
      if (total > 0) {
        logger.info(`[BRAIN] Hipótesis validadas: ${result.confirmed.length} confirmadas, ${result.rejected.length} rechazadas, ${result.still_active.length} pendientes`);
      }

      return result;
    } catch (err) {
      logger.warn(`[BRAIN] Error parseando validación de hipótesis: ${err.message}`);
      return null;
    }
  }

  async _saveCycleMemory(cycleId, parsed, recommendations, accountOverview, originalResponse) {
    try {
      // Construir resumen de lo que se recomendó
      const recSummary = recommendations.slice(0, 8).map(r =>
        `${r.action} en ${r.entity_name}: ${r.reasoning?.substring(0, 100)}`
      ).join('\n');

      const memoryPrompt = `Acabas de analizar la cuenta de Meta Ads y generaste estas recomendaciones:

RESUMEN: ${parsed.summary || 'Sin resumen'}
STATUS: ${parsed.status || 'unknown'}

RECOMENDACIONES (${recommendations.length}):
${recSummary || 'Ninguna'}

Ahora necesito que generes un JSON con tus CONCLUSIONES CLAVE para recordar en el próximo ciclo (en 6 horas).

Responde SOLO con JSON válido:
{
  "conclusions": [
    { "topic": "categoria_corta", "conclusion": "tu conclusión en 1-2 oraciones", "confidence": "high|medium|low", "entities": ["entity_id1"] }
  ],
  "account_assessment": "healthy|warning|declining|recovering|critical",
  "hypotheses": [
    { "hypothesis": "algo que quieres validar en el próximo ciclo", "proposed_action": "qué observar" }
  ]
}

REGLAS:
- Máximo 5 conclusiones, solo las más importantes
- Máximo 3 hipótesis activas
- Topics válidos: scaling_opportunity, fatigue_risk, budget_concern, performance_pattern, creative_gap, audience_saturation, recovery_signal, learning_insight
- Sé específico: nombra entidades, da números
- Las hipótesis deben ser verificables en el próximo ciclo`;

      const memoryResponse = await this.anthropic.messages.create({
        model: config.claude.model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: memoryPrompt }]
      });

      const memoryText = memoryResponse.content[0]?.text || '';
      let memoryData;
      try {
        let cleaned = memoryText.trim();
        if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
        memoryData = JSON.parse(cleaned);
      } catch (parseErr) {
        logger.warn(`[BRAIN] No se pudo parsear cycle memory: ${parseErr.message}`);
        return;
      }

      // Determinar top action
      const actionCounts = {};
      for (const r of recommendations) {
        actionCounts[r.action] = (actionCounts[r.action] || 0) + 1;
      }
      const topAction = Object.entries(actionCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';

      await BrainCycleMemory.create({
        cycle_id: cycleId,
        conclusions: (memoryData.conclusions || []).slice(0, 5).map(c => ({
          topic: c.topic || 'other',
          conclusion: String(c.conclusion || '').substring(0, 300),
          confidence: ['high', 'medium', 'low'].includes(c.confidence) ? c.confidence : 'medium',
          entities: Array.isArray(c.entities) ? c.entities.slice(0, 5) : []
        })),
        account_assessment: memoryData.account_assessment || parsed.status || 'unknown',
        hypotheses: (memoryData.hypotheses || []).slice(0, 3).map(h => ({
          hypothesis: String(h.hypothesis || '').substring(0, 200),
          proposed_action: String(h.proposed_action || '').substring(0, 150),
          status: 'active',
          created_cycle_id: cycleId
        })),
        snapshot: {
          roas_7d: accountOverview.roas_7d || 0,
          roas_30d: accountOverview.roas_30d || 0,
          active_adsets: accountOverview.active_adsets || 0,
          recommendations_count: recommendations.length,
          top_action: topAction
        }
      });

      logger.info(`[BRAIN] Cycle memory guardada: ${(memoryData.conclusions || []).length} conclusiones, ${(memoryData.hypotheses || []).length} hipótesis`);
    } catch (error) {
      logger.warn(`[BRAIN] Error en _saveCycleMemory: ${error.message}`);
    }
  }

  async _expirePendingRecommendations() {
    try {
      const reports = await AgentReport.find({
        agent_type: 'brain',
        'recommendations.status': 'pending'
      }).sort({ created_at: -1 });

      let totalExpired = 0;
      for (const report of reports) {
        let modified = false;
        for (const rec of report.recommendations) {
          if (rec.status === 'pending' && rec.action !== 'no_action' && rec.action !== 'observe') {
            rec.status = 'expired';
            modified = true;
            totalExpired++;
          }
        }
        if (modified) await report.save();
      }

      if (totalExpired > 0) {
        logger.info(`[BRAIN] Auto-expiradas ${totalExpired} recomendaciones pendientes`);
      }
    } catch (error) {
      logger.warn(`[BRAIN] Error al expirar recomendaciones: ${error.message}`);
    }
  }

  async _autoExecuteRecommendations(report) {
    const autonomy = safetyGuards.autonomy || {};
    const mode = autonomy.brain || autonomy.mode || 'manual';

    if (mode === 'manual') return 0;

    const maxChangePct = autonomy.max_auto_change_pct || 20;
    let executed = 0;

    const freshReport = await AgentReport.findOne({
      agent_type: 'brain',
      cycle_id: report.cycle_id
    }).sort({ created_at: -1 });

    if (!freshReport) return 0;

    for (const rec of freshReport.recommendations) {
      if (rec.status !== 'pending' || rec.action === 'no_action' || rec.action === 'observe') continue;

      let shouldExecute = false;

      if (mode === 'auto') {
        shouldExecute = true;
      } else if (mode === 'semi_auto') {
        const changePct = Math.abs(rec.change_percent || 0);
        shouldExecute = rec.confidence === 'high' && changePct <= maxChangePct;

        if (['pause', 'reactivate', 'update_ad_status'].includes(rec.action)) {
          shouldExecute = rec.confidence === 'high';
        }
        if (['duplicate_adset', 'create_ad', 'update_ad_creative', 'move_budget', 'update_bid_strategy'].includes(rec.action)) {
          shouldExecute = false;
        }
      }

      if (!shouldExecute) continue;

      try {
        const cooldownManager = new CooldownManager();
        const cooldownCheck = await cooldownManager.isOnCooldown(rec.entity_id);
        if (cooldownCheck.onCooldown) {
          logger.info(`[BRAIN][AUTO] Saltando ${rec.entity_name} — cooldown ${cooldownCheck.hoursLeft}h`);
          continue;
        }

        // Check de respiración: no actuar si alguien (brain, manager, etc) ya tocó esta entidad en las últimas 24h
        const recentCheck = await cooldownManager.hasRecentAction(rec.entity_id);
        if (recentCheck.hasRecent) {
          logger.info(`[BRAIN][AUTO] Saltando ${rec.entity_name} — acción reciente hace ${recentCheck.hoursAgo}h por ${recentCheck.lastAgent} (${recentCheck.lastAction}). Esperando respiración.`);
          continue;
        }

        const complexActions = ['duplicate_adset', 'create_ad', 'update_ad_creative', 'move_budget'];
        if (complexActions.includes(rec.action)) continue;

        const { getMetaClient } = require('../../meta/client');
        const meta = getMetaClient();
        let apiResponse;

        switch (rec.action) {
          case 'scale_up':
          case 'scale_down':
            apiResponse = await meta.updateBudget(rec.entity_id, rec.recommended_value);
            break;
          case 'pause':
            apiResponse = await meta.updateStatus(rec.entity_id, 'PAUSED');
            break;
          case 'reactivate':
            apiResponse = await meta.updateStatus(rec.entity_id, 'ACTIVE');
            break;
          case 'update_ad_status':
            apiResponse = await meta.updateAdStatus(rec.entity_id, rec.recommended_value === 0 ? 'PAUSED' : 'ACTIVE');
            break;
          case 'update_bid_strategy':
            apiResponse = await meta.updateBidStrategy(rec.entity_id, rec.bid_strategy, rec.recommended_value || null);
            break;
          default:
            continue;
        }

        rec.status = 'executed';
        rec.approved_by = `auto_${mode}`;
        rec.approved_at = new Date();
        rec.executed_at = new Date();
        rec.execution_result = apiResponse;

        // Capturar metricas al momento de ejecucion (FIX: buscar por tipo correcto)
        let metricsAtExecution = {};
        try {
          const entityType = rec.entity_type || 'adset';
          const lookupType = entityType === 'ad' ? 'adset' : entityType;
          const snapshots = await getLatestSnapshots(lookupType);

          // Para ads, buscar metricas del ad set padre
          let entitySnapshot;
          if (entityType === 'ad') {
            const adSnaps = await getLatestSnapshots('ad');
            const adSnap = adSnaps.find(s => s.entity_id === rec.entity_id);
            const parentId = adSnap?.parent_id;
            entitySnapshot = parentId
              ? snapshots.find(s => s.entity_id === parentId)
              : snapshots.find(s => s.entity_id === rec.entity_id);
          } else {
            entitySnapshot = snapshots.find(s => s.entity_id === rec.entity_id);
          }

          if (entitySnapshot) {
            metricsAtExecution = {
              roas_7d: entitySnapshot.metrics?.last_7d?.roas || 0,
              roas_3d: entitySnapshot.metrics?.last_3d?.roas || 0,
              cpa_7d: entitySnapshot.metrics?.last_7d?.cpa || 0,
              spend_today: entitySnapshot.metrics?.today?.spend || 0,
              spend_7d: entitySnapshot.metrics?.last_7d?.spend || 0,
              daily_budget: entitySnapshot.daily_budget || 0,
              purchases_7d: entitySnapshot.metrics?.last_7d?.purchases || 0,
              purchase_value_7d: entitySnapshot.metrics?.last_7d?.purchase_value || 0,
              frequency: entitySnapshot.metrics?.last_7d?.frequency || 0,
              ctr: entitySnapshot.metrics?.last_7d?.ctr || 0
            };
          }
        } catch (snapErr) {
          logger.warn(`[BRAIN][AUTO] No se pudieron capturar metricas: ${snapErr.message}`);
        }

        await ActionLog.create({
          decision_id: freshReport._id,
          cycle_id: freshReport.cycle_id,
          entity_type: rec.entity_type,
          entity_id: rec.entity_id,
          entity_name: rec.entity_name,
          action: rec.action,
          before_value: rec.current_value,
          after_value: rec.recommended_value,
          change_percent: rec.change_percent,
          reasoning: `[BRAIN][AUTO_${mode.toUpperCase()}] ${rec.reasoning}`,
          confidence: rec.confidence,
          agent_type: 'brain',
          success: true,
          meta_api_response: apiResponse,
          metrics_at_execution: metricsAtExecution
        });

        await cooldownManager.setCooldown(rec.entity_id, rec.entity_type, rec.action);

        executed++;
        logger.info(`[BRAIN][AUTO] Ejecutado: ${rec.action} en ${rec.entity_name}`);
      } catch (execError) {
        logger.error(`[BRAIN][AUTO] Error ejecutando ${rec.action} en ${rec.entity_name}: ${execError.message}`);
      }
    }

    if (executed > 0) {
      await freshReport.save();
    }

    return executed;
  }
}

module.exports = UnifiedBrain;
