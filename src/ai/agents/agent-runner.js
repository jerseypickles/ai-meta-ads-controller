const { getLatestSnapshots, getAccountOverview, getRecentActions, getExecutedActionsWithImpact } = require('../../db/queries');
const { CooldownManager } = require('../../safety/cooldown-manager');
const ScalingAgent = require('./scaling-agent');
const PerformanceAgent = require('./performance-agent');
const CreativeAgent = require('./creative-agent');
const PacingAgent = require('./pacing-agent');
const AgentReport = require('../../db/models/AgentReport');
const ActionLog = require('../../db/models/ActionLog');
const CreativeAsset = require('../../db/models/CreativeAsset');
const AICreation = require('../../db/models/AICreation');
const safetyGuards = require('../../../config/safety-guards');
const logger = require('../../utils/logger');

const AGENTS = [ScalingAgent, PerformanceAgent, CreativeAgent, PacingAgent];

class AgentRunner {
  /**
   * Ejecuta todos los agentes secuencialmente.
   * Carga datos una sola vez y los comparte entre agentes.
   */
  async runAll() {
    const startTime = Date.now();
    const cycleId = `agents_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    logger.info(`═══ Iniciando ciclo de agentes IA [${cycleId}] ═══`);

    try {
      // Auto-expirar recomendaciones pendientes de ciclos anteriores
      await this._expirePendingRecommendations();

      // Cargar datos compartidos
      const sharedData = await this._loadSharedData(cycleId);
      if (!sharedData) {
        logger.warn('Sin datos disponibles para agentes');
        return null;
      }

      const results = [];
      let autoExecuted = 0;

      // Ejecutar agentes secuencialmente (evitar saturar Claude API)
      for (const AgentClass of AGENTS) {
        try {
          const agent = new AgentClass();
          const report = await agent.analyze(sharedData);
          if (report) {
            results.push({
              agent: agent.agentType,
              status: report.status,
              recommendations: report.recommendations.length,
              alerts: report.alerts.length
            });

            // Auto-ejecutar según modo de autonomía
            const executed = await this._autoExecuteRecommendations(report, agent.agentType);
            autoExecuted += executed;
          }
        } catch (agentError) {
          logger.error(`Error en agente ${AgentClass.name}:`, agentError.message);
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const totalRecs = results.reduce((sum, r) => sum + r.recommendations, 0);
      logger.info(`═══ Ciclo de agentes completado en ${elapsed}s — ${totalRecs} recomendaciones, ${autoExecuted} auto-ejecutadas ═══`);

      return {
        cycleId,
        elapsed: `${elapsed}s`,
        agents: results,
        autoExecuted
      };
    } catch (error) {
      logger.error(`Error en ciclo de agentes [${cycleId}]:`, error.message);
      throw error;
    }
  }

  /**
   * Auto-expirar recomendaciones pendientes de reportes anteriores.
   * Cuando inicia un nuevo ciclo, las pendientes del ciclo anterior ya no son relevantes.
   */
  async _expirePendingRecommendations() {
    try {
      const agentTypes = ['scaling', 'performance', 'creative', 'pacing'];
      let totalExpired = 0;

      for (const type of agentTypes) {
        // Buscar reportes anteriores (no el último) con recomendaciones pendientes
        const reports = await AgentReport.find({
          agent_type: type,
          'recommendations.status': 'pending'
        }).sort({ created_at: -1 });

        // Saltar el reporte más reciente (ese se reemplazará por el nuevo ciclo)
        // Expirar pendientes en todos los reportes
        for (const report of reports) {
          let modified = false;
          for (const rec of report.recommendations) {
            if (rec.status === 'pending' && rec.action !== 'no_action') {
              rec.status = 'expired';
              modified = true;
              totalExpired++;
            }
          }
          if (modified) {
            await report.save();
          }
        }
      }

      if (totalExpired > 0) {
        logger.info(`Auto-expiradas ${totalExpired} recomendaciones pendientes de ciclos anteriores`);
      }
    } catch (error) {
      logger.warn(`Error al expirar recomendaciones: ${error.message}`);
    }
  }

  /**
   * Auto-ejecutar recomendaciones según el modo de autonomía del agente.
   * - manual: no hace nada (el usuario aprueba y ejecuta)
   * - semi_auto: auto-ejecuta si confidence=high Y cambio <= max_auto_change_pct
   * - auto: ejecuta todo automáticamente
   */
  async _autoExecuteRecommendations(report, agentType) {
    const autonomy = safetyGuards.autonomy || {};
    const mode = autonomy[agentType] || 'manual';

    if (mode === 'manual') return 0;

    const maxChangePct = autonomy.max_auto_change_pct || 20;
    let executed = 0;

    // Recargar el reporte desde DB (analyze() ya lo guardó)
    const freshReport = await AgentReport.findOne({
      agent_type: agentType,
      cycle_id: report.cycle_id
    }).sort({ created_at: -1 });

    if (!freshReport) return 0;

    for (const rec of freshReport.recommendations) {
      if (rec.status !== 'pending' || rec.action === 'no_action') continue;

      let shouldExecute = false;

      if (mode === 'auto') {
        shouldExecute = true;
      } else if (mode === 'semi_auto') {
        // Solo auto-ejecutar si: confidence=high Y cambio pequeño
        const changePct = Math.abs(rec.change_percent || 0);
        shouldExecute = rec.confidence === 'high' && changePct <= maxChangePct;

        // Para pause/reactivate/update_ad_status en semi_auto, solo si confidence=high
        if (['pause', 'reactivate', 'update_ad_status'].includes(rec.action)) {
          shouldExecute = rec.confidence === 'high';
        }

        // Nunca auto-ejecutar acciones que crean/duplican entidades o cambian bid strategy
        if (['duplicate_adset', 'create_ad', 'update_ad_creative', 'move_budget', 'update_bid_strategy'].includes(rec.action)) {
          shouldExecute = false;
        }
      }

      if (!shouldExecute) continue;

      try {
        // Verificar cooldown antes de ejecutar
        const cooldownManager = new CooldownManager();
        const cooldownCheck = await cooldownManager.isOnCooldown(rec.entity_id);
        if (cooldownCheck.onCooldown) {
          logger.info(`[AUTO] Saltando ${rec.entity_name} — en cooldown ${cooldownCheck.hoursLeft}h restantes (último: ${cooldownCheck.lastAction} por ${cooldownCheck.lastAgent})`);
          continue;
        }

        // Ejecutar via Meta API
        const { getMetaClient } = require('../../meta/client');
        const meta = getMetaClient();
        let apiResponse;

        // Acciones complejas no se auto-ejecutan (solo manual via dashboard)
        const complexActions = ['duplicate_adset', 'create_ad', 'update_ad_creative', 'move_budget'];
        if (complexActions.includes(rec.action)) {
          continue;
        }

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

        // Marcar como ejecutado
        rec.status = 'executed';
        rec.approved_by = `auto_${mode}`;
        rec.approved_at = new Date();
        rec.executed_at = new Date();
        rec.execution_result = apiResponse;

        // Capturar métricas al momento de ejecución
        let metricsAtExecution = {};
        try {
          const snapshots = await getLatestSnapshots('adset');
          const entitySnapshot = snapshots.find(s => s.entity_id === rec.entity_id);
          if (entitySnapshot) {
            metricsAtExecution = {
              roas_7d: entitySnapshot.metrics?.last_7d?.roas || 0,
              roas_3d: entitySnapshot.metrics?.last_3d?.roas || 0,
              cpa_7d: entitySnapshot.metrics?.last_7d?.cpa || 0,
              spend_today: entitySnapshot.metrics?.today?.spend || 0,
              daily_budget: entitySnapshot.daily_budget || 0,
              frequency: entitySnapshot.metrics?.last_7d?.frequency || 0,
              ctr: entitySnapshot.metrics?.last_7d?.ctr || 0
            };
          }
        } catch (snapErr) {
          logger.warn(`[AUTO] No se pudieron capturar métricas: ${snapErr.message}`);
        }

        // Registrar en ActionLog
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
          reasoning: `[${agentType.toUpperCase()}][AUTO_${mode.toUpperCase()}] ${rec.reasoning}`,
          confidence: rec.confidence,
          agent_type: agentType,
          success: true,
          meta_api_response: apiResponse,
          metrics_at_execution: metricsAtExecution
        });

        // Registrar cooldown
        await cooldownManager.setCooldown(rec.entity_id, rec.entity_type, rec.action);

        executed++;
        logger.info(`[AUTO_${mode.toUpperCase()}] Ejecutado: ${rec.action} en ${rec.entity_name} ($${rec.current_value} → $${rec.recommended_value})`);
      } catch (execError) {
        logger.error(`[AUTO] Error ejecutando ${rec.action} en ${rec.entity_name}: ${execError.message}`);
      }
    }

    if (executed > 0) {
      await freshReport.save();
    }

    return executed;
  }

  /**
   * Carga todos los datos necesarios una sola vez.
   */
  async _loadSharedData(cycleId) {
    const cooldownManager = new CooldownManager();
    const [snapshots, accountOverview, recentActions, activeCooldowns, impactHistory, creativeAssets, aiCreations] = await Promise.all([
      getLatestSnapshots(),
      getAccountOverview(),
      getRecentActions(3),
      cooldownManager.getActiveCooldowns(),
      getExecutedActionsWithImpact(30),
      CreativeAsset.find({ status: 'active' }).sort({ created_at: -1 }).lean().catch(() => []),
      AICreation.find({}).sort({ created_at: -1 }).limit(30).lean().catch(() => [])
    ]);

    if (snapshots.length === 0) {
      return null;
    }

    const adSetSnapshots = snapshots.filter(s => s.entity_type === 'adset');
    const adSnapshots = snapshots.filter(s => s.entity_type === 'ad');
    const campaignSnapshots = snapshots.filter(s => s.entity_type === 'campaign');

    // Cargar feedback loop por agente — cada agente recibe sus propias acciones medidas
    const agentFeedback = await this._loadAgentFeedback(creativeAssets);

    logger.info(`Datos cargados: ${adSetSnapshots.length} ad sets, ${adSnapshots.length} ads, ${campaignSnapshots.length} campanas, ${recentActions.length} acciones recientes, ${activeCooldowns.length} cooldowns activos, ${impactHistory.length} acciones con impacto, ${creativeAssets.length} creative assets, ${aiCreations.length} AI creations`);

    return {
      cycleId,
      snapshots,
      adSetSnapshots,
      adSnapshots,
      campaignSnapshots,
      accountOverview,
      recentActions,
      activeCooldowns,
      impactHistory,
      creativeAssets,
      aiCreations,
      agentFeedback
    };
  }

  /**
   * Carga feedback de acciones pasadas POR AGENTE.
   * Cada agente recibe sus propias acciones medidas con resultados.
   */
  async _loadAgentFeedback(creativeAssets) {
    const agentTypes = ['scaling', 'performance', 'creative', 'pacing'];
    const feedback = {};

    try {
      for (const agentType of agentTypes) {
        // Buscar acciones medidas de este agente (impact_measured = true)
        const measuredActions = await ActionLog.find({
          agent_type: agentType,
          success: true,
          impact_measured: true
        }).sort({ executed_at: -1 }).limit(20).lean();

        if (measuredActions.length === 0) {
          feedback[agentType] = { actions: [], summary: { total_measured: 0, improved: 0, worsened: 0, neutral: 0, avg_roas_delta: 0, success_rate_pct: 0 }, patternsByAction: {}, creativePerformance: {} };
          continue;
        }

        // Procesar cada acción y calcular deltas
        const processedActions = measuredActions.map(a => {
          const before = a.metrics_at_execution || {};
          const after = a.metrics_after_3d || a.metrics_after_1d || {};

          const roasBefore = before.roas_7d || 0;
          const roasAfter = after.roas_7d || 0;
          const cpaBefore = before.cpa_7d || 0;
          const cpaAfter = after.cpa_7d || 0;

          const deltaRoas = roasBefore > 0
            ? Math.round((roasAfter - roasBefore) / roasBefore * 10000) / 100
            : 0;
          const deltaCpa = cpaBefore > 0
            ? Math.round((cpaAfter - cpaBefore) / cpaBefore * 10000) / 100
            : 0;

          // Determinar resultado
          let result = 'neutral';
          if (deltaRoas > 5) result = 'improved';
          else if (deltaRoas < -5) result = 'worsened';

          return {
            action: a.action,
            entity_id: a.entity_id,
            entity_name: a.entity_name || 'Sin nombre',
            before_value: a.before_value,
            after_value: a.after_value,
            executed_at: a.executed_at,
            roas_before: roasBefore,
            roas_after: roasAfter,
            cpa_before: cpaBefore,
            cpa_after: cpaAfter,
            delta_roas_pct: deltaRoas,
            delta_cpa_pct: deltaCpa,
            result,
            creative_asset_id: a.creative_asset_id || null
          };
        });

        // Resumen estadístico
        const improved = processedActions.filter(a => a.result === 'improved').length;
        const worsened = processedActions.filter(a => a.result === 'worsened').length;
        const neutral = processedActions.filter(a => a.result === 'neutral').length;
        const avgRoasDelta = processedActions.length > 0
          ? Math.round(processedActions.reduce((sum, a) => sum + a.delta_roas_pct, 0) / processedActions.length * 100) / 100
          : 0;

        // Patrones por tipo de acción
        const patternsByAction = {};
        for (const a of processedActions) {
          if (!patternsByAction[a.action]) {
            patternsByAction[a.action] = { total: 0, improved: 0, worsened: 0, deltas: [] };
          }
          patternsByAction[a.action].total++;
          if (a.result === 'improved') patternsByAction[a.action].improved++;
          if (a.result === 'worsened') patternsByAction[a.action].worsened++;
          patternsByAction[a.action].deltas.push(a.delta_roas_pct);
        }
        for (const [action, stats] of Object.entries(patternsByAction)) {
          stats.success_rate = stats.total > 0 ? Math.round(stats.improved / stats.total * 100) : 0;
          stats.avg_delta = stats.deltas.length > 0
            ? Math.round(stats.deltas.reduce((s, d) => s + d, 0) / stats.deltas.length * 100) / 100
            : 0;
          delete stats.deltas;
        }

        // Para creative agent: rendimiento por estilo de creativo
        let creativePerformance = {};
        if (agentType === 'creative') {
          const createAdActions = processedActions.filter(a => a.action === 'create_ad' && a.creative_asset_id);
          if (createAdActions.length > 0) {
            const styleMap = {};
            for (const a of createAdActions) {
              const asset = (creativeAssets || []).find(ca => String(ca._id) === String(a.creative_asset_id));
              const style = asset?.style || 'unknown';
              if (!styleMap[style]) styleMap[style] = { total: 0, improved: 0, worsened: 0, deltas: [] };
              styleMap[style].total++;
              if (a.result === 'improved') styleMap[style].improved++;
              if (a.result === 'worsened') styleMap[style].worsened++;
              styleMap[style].deltas.push(a.delta_roas_pct);
            }
            for (const [style, stats] of Object.entries(styleMap)) {
              stats.success_rate = stats.total > 0 ? Math.round(stats.improved / stats.total * 100) : 0;
              stats.avg_delta = stats.deltas.length > 0
                ? Math.round(stats.deltas.reduce((s, d) => s + d, 0) / stats.deltas.length * 100) / 100
                : 0;
              delete stats.deltas;
            }
            creativePerformance = styleMap;
          }
        }

        feedback[agentType] = {
          actions: processedActions,
          summary: {
            total_measured: processedActions.length,
            improved,
            worsened,
            neutral,
            avg_roas_delta: avgRoasDelta,
            success_rate_pct: processedActions.length > 0 ? Math.round(improved / processedActions.length * 100) : 0
          },
          patternsByAction,
          creativePerformance
        };
      }

      const totalFeedbackActions = Object.values(feedback).reduce((sum, f) => sum + f.actions.length, 0);
      if (totalFeedbackActions > 0) {
        logger.info(`Feedback loop cargado: ${Object.entries(feedback).map(([t, f]) => `${t}=${f.actions.length}`).join(', ')} acciones medidas`);
      }

    } catch (err) {
      logger.warn(`Error cargando feedback de agentes: ${err.message}`);
    }

    return feedback;
  }
}

module.exports = AgentRunner;
