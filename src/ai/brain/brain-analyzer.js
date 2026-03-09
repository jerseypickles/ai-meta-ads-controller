const Anthropic = require('@anthropic-ai/sdk');
const moment = require('moment-timezone');
const config = require('../../../config');
const kpiTargets = require('../../../config/kpi-targets');
const safetyGuards = require('../../../config/safety-guards');
const { getLatestSnapshots, getAccountOverview, getRecentActions } = require('../../db/queries');
const BrainMemory = require('../../db/models/BrainMemory');
const BrainInsight = require('../../db/models/BrainInsight');
const BrainChat = require('../../db/models/BrainChat');
const BrainRecommendation = require('../../db/models/BrainRecommendation');
const BrainCycleMemory = require('../../db/models/BrainCycleMemory');
const ActionLog = require('../../db/models/ActionLog');
const DiagnosticEngine = require('./diagnostic-engine');
const BrainTemporalPattern = require('../../db/models/BrainTemporalPattern');
const DataCollector = require('../../meta/data-collector');
const logger = require('../../utils/logger');

/**
 * BrainAnalyzer — Motor de análisis híbrido.
 *
 * Fase 1 (Matemática): Compara snapshots actuales vs BrainMemory.
 *   Detecta deltas significativos, cambios de estado, anomalías.
 *   Esto es gratis e instantáneo.
 *
 * Fase 2 (IA): Si hay hallazgos significativos, envía a Claude
 *   para generar un insight de calidad profesional con contexto,
 *   análisis de causa, y recomendación.
 *
 * Fase 3 (Memoria): Actualiza BrainMemory con el nuevo estado
 *   para que el próximo ciclo compare correctamente.
 */
class BrainAnalyzer {
  constructor() {
    this.anthropic = new Anthropic({ apiKey: config.claude.apiKey });
    this.diagnosticEngine = new DiagnosticEngine();

    // Umbrales para considerar un cambio "significativo"
    this.thresholds = {
      roas_change_pct: 20,        // ROAS cambió más de 20%
      spend_change_pct: 30,       // Spend cambió más de 30%
      cpa_change_pct: 25,         // CPA cambió más de 25%
      ctr_change_pct: 30,         // CTR cambió más de 30%
      frequency_warning: kpiTargets.frequency_warning,
      frequency_critical: kpiTargets.frequency_critical,
      roas_minimum: kpiTargets.roas_minimum,
      roas_excellent: kpiTargets.roas_excellent,
      min_spend_for_analysis: 5,  // Mínimo $5 gastados para analizar
      min_hours_between_insights: 2  // No generar insights para la misma entidad en menos de 2h
    };
  }

  /**
   * Ejecuta un ciclo completo de análisis.
   * Llamado después de cada recolección de datos.
   */
  async analyze() {
    const startTime = Date.now();
    logger.info('[BRAIN-ANALYZER] Iniciando análisis...');

    try {
      // 1. Cargar datos actuales
      const [adsetSnapshots, accountOverview, recentActions] = await Promise.all([
        getLatestSnapshots('adset'),
        getAccountOverview(),
        getRecentActions(3)
      ]);

      // 2. Cargar memorias existentes + patrones temporales
      const [memories, temporalPatterns] = await Promise.all([
        BrainMemory.find({}).lean(),
        BrainTemporalPattern.find({ pattern_type: 'day_of_week', level: 'account' }).lean().catch(() => [])
      ]);
      const memoryMap = {};
      for (const m of memories) {
        memoryMap[m.entity_id] = m;
      }

      // Build temporal baseline for today's day of week
      const todayKey = moment().tz(process.env.TIMEZONE || 'America/New_York').format('dddd').toLowerCase();
      const todayPattern = temporalPatterns.find(p => p.pattern_key === todayKey);

      // 3. Fase matemática: detectar cambios significativos
      const findings = this._detectChanges(adsetSnapshots, memoryMap, accountOverview, todayPattern);

      // 3.3. Enrich status_change findings with ActionLog context (who paused/reactivated and why)
      await this._enrichStatusChangeFindings(findings);

      // 3.5. Diagnostic engine: pre-compute structured diagnostic signals
      let diagnostics = {};
      try {
        const adSnapshots = await getLatestSnapshots('ad');
        diagnostics = this.diagnosticEngine.diagnoseAll(adsetSnapshots, adSnapshots, memoryMap, accountOverview);
        const diagnosticFindings = this._extractDiagnosticFindings(diagnostics, memoryMap);
        // Merge diagnostic findings (deduped by entity)
        const existingEntityIds = new Set(findings.map(f => f.entity?.entity_id));
        for (const df of diagnosticFindings) {
          if (!existingEntityIds.has(df.entity.entity_id)) {
            findings.push(df);
          }
        }
      } catch (diagErr) {
        logger.warn(`[BRAIN-ANALYZER] Diagnostic engine error (non-fatal): ${diagErr.message}`);
      }

      // 4. Fase IA: si hay hallazgos, generar insights de calidad
      let insightsCreated = 0;
      if (findings.length > 0) {
        insightsCreated = await this._generateInsights(findings, adsetSnapshots, accountOverview, recentActions, diagnostics);
      }

      // 5. Actualizar memoria con estado actual
      await this._updateMemory(adsetSnapshots);

      // 6. Verificar si toca resumen periódico (cada ~6 horas)
      const summaryCreated = await this._maybeSummary(adsetSnapshots, accountOverview);

      // 7. Generar brain_activity insight (resumen de este ciclo)
      const activityCreated = await this._generateBrainActivity(
        adsetSnapshots, findings, insightsCreated, accountOverview
      );

      // 8. Generar brain_thinking insights (por qué NO actuó en entidades estables)
      const thinkingCreated = await this._generateBrainThinking(
        adsetSnapshots, findings, memoryMap, diagnostics
      );

      // 9. Conectar insights con recomendaciones pendientes
      await this._linkInsightsToRecommendations();

      const totalCreated = insightsCreated + (summaryCreated ? 1 : 0) + activityCreated + thinkingCreated;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`[BRAIN-ANALYZER] Completado en ${elapsed}s — ${findings.length} hallazgos, ${totalCreated} insights generados`);

      return {
        findings: findings.length,
        insights_created: totalCreated,
        elapsed: `${elapsed}s`
      };
    } catch (error) {
      logger.error(`[BRAIN-ANALYZER] Error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fase 1: Detección matemática de cambios significativos.
   */
  _detectChanges(snapshots, memoryMap, accountOverview, todayPattern = null) {
    const findings = [];

    // Temporal baseline: if we have 4+ weeks of data for today's day, use it to filter noise
    const hasTemporalBaseline = todayPattern && (todayPattern.metrics?.sample_count || 0) >= 4;

    for (const snap of snapshots) {
      const memory = memoryMap[snap.entity_id];
      const m7d = snap.metrics?.last_7d || {};

      // Si no tiene spend suficiente, no analizar
      if ((m7d.spend || 0) < this.thresholds.min_spend_for_analysis) continue;

      // Si es entidad nueva (no hay memoria), registrar pero no generar insight
      if (!memory) {
        findings.push({
          type: 'new_entity',
          severity: 'info',
          entity: { entity_type: 'adset', entity_id: snap.entity_id, entity_name: snap.entity_name },
          data: { status: snap.status, roas_7d: m7d.roas || 0, spend_7d: m7d.spend || 0 }
        });
        continue;
      }

      const rm = memory.remembered_metrics;

      // Cambio de estado
      if (memory.last_status !== snap.status) {
        findings.push({
          type: 'status_change',
          severity: 'high',
          entity: { entity_type: 'adset', entity_id: snap.entity_id, entity_name: snap.entity_name },
          data: {
            from: memory.last_status,
            to: snap.status
          }
        });
      }

      // ROAS cambió significativamente
      if (rm.roas_7d > 0 && (m7d.roas || 0) > 0) {
        const roasDelta = ((m7d.roas - rm.roas_7d) / rm.roas_7d) * 100;
        if (Math.abs(roasDelta) >= this.thresholds.roas_change_pct) {
          // Temporal filter: if current ROAS is within ±15% of the day-of-week average,
          // downgrade severity — it's likely normal daily variation, not a real anomaly
          let adjustedSeverity = Math.abs(roasDelta) > 40 ? 'high' : 'medium';
          let temporalNote = null;
          if (hasTemporalBaseline && roasDelta < 0) {
            const dayAvgRoas = todayPattern.metrics.avg_roas;
            if (dayAvgRoas > 0) {
              const vsTemporalPct = ((m7d.roas - dayAvgRoas) / dayAvgRoas) * 100;
              if (Math.abs(vsTemporalPct) <= 15) {
                adjustedSeverity = 'low';
                temporalNote = `Dentro del rango normal para ${todayPattern.pattern_key} (avg ${dayAvgRoas.toFixed(2)}x)`;
              }
            }
          }

          findings.push({
            type: roasDelta < 0 ? 'anomaly' : 'opportunity',
            severity: adjustedSeverity,
            entity: { entity_type: 'adset', entity_id: snap.entity_id, entity_name: snap.entity_name },
            data: {
              metric: 'roas_7d',
              from: rm.roas_7d,
              to: m7d.roas,
              delta_pct: +roasDelta.toFixed(1),
              ...(temporalNote && { temporal_note: temporalNote })
            }
          });
        }
      }

      // CPA cambió significativamente
      if (rm.cpa_7d > 0 && (m7d.cpa || 0) > 0) {
        const cpaDelta = ((m7d.cpa - rm.cpa_7d) / rm.cpa_7d) * 100;
        if (Math.abs(cpaDelta) >= this.thresholds.cpa_change_pct) {
          findings.push({
            type: cpaDelta > 0 ? 'warning' : 'opportunity',
            severity: Math.abs(cpaDelta) > 50 ? 'high' : 'medium',
            entity: { entity_type: 'adset', entity_id: snap.entity_id, entity_name: snap.entity_name },
            data: {
              metric: 'cpa_7d',
              from: rm.cpa_7d,
              to: m7d.cpa,
              delta_pct: +cpaDelta.toFixed(1)
            }
          });
        }
      }

      // Frecuencia en zona de alerta
      if ((m7d.frequency || 0) >= this.thresholds.frequency_critical) {
        findings.push({
          type: 'warning',
          severity: 'critical',
          entity: { entity_type: 'adset', entity_id: snap.entity_id, entity_name: snap.entity_name },
          data: {
            metric: 'frequency_7d',
            value: m7d.frequency,
            threshold: this.thresholds.frequency_critical,
            message: 'Frecuencia crítica — audiencia sobre-saturada'
          }
        });
      } else if ((m7d.frequency || 0) >= this.thresholds.frequency_warning && (rm.frequency_7d || 0) < this.thresholds.frequency_warning) {
        // Solo alertar si cruzó el umbral (no repetir cada ciclo)
        findings.push({
          type: 'warning',
          severity: 'medium',
          entity: { entity_type: 'adset', entity_id: snap.entity_id, entity_name: snap.entity_name },
          data: {
            metric: 'frequency_7d',
            value: m7d.frequency,
            threshold: this.thresholds.frequency_warning,
            message: 'Frecuencia entrando en zona de fatiga'
          }
        });
      }

      // ROAS cayó debajo del mínimo
      if ((m7d.roas || 0) < this.thresholds.roas_minimum && rm.roas_7d >= this.thresholds.roas_minimum) {
        findings.push({
          type: 'warning',
          severity: 'high',
          entity: { entity_type: 'adset', entity_id: snap.entity_id, entity_name: snap.entity_name },
          data: {
            metric: 'roas_7d',
            value: m7d.roas,
            threshold: this.thresholds.roas_minimum,
            from: rm.roas_7d,
            message: `ROAS cayó debajo del mínimo (${this.thresholds.roas_minimum}x)`
          }
        });
      }

      // ROAS excelente nuevo
      if ((m7d.roas || 0) >= this.thresholds.roas_excellent && rm.roas_7d < this.thresholds.roas_excellent) {
        findings.push({
          type: 'milestone',
          severity: 'medium',
          entity: { entity_type: 'adset', entity_id: snap.entity_id, entity_name: snap.entity_name },
          data: {
            metric: 'roas_7d',
            value: m7d.roas,
            threshold: this.thresholds.roas_excellent,
            message: `ROAS alcanzó nivel excelente (${this.thresholds.roas_excellent}x+)`
          }
        });
      }
    }

    // Filtrar findings para entidades con insights recientes (anti-spam)
    return this._filterRecentlyInsighted(findings);
  }

  /**
   * Anti-spam: no generar insights para la misma entidad si ya tiene uno reciente.
   */
  _filterRecentlyInsighted(findings) {
    // new_entity y info siempre pasan (no generan insight)
    return findings.filter(f => {
      if (f.type === 'new_entity') return true;
      if (f.severity === 'critical') return true;  // Críticos siempre pasan
      return true; // Filtro por tiempo se hace en _generateInsights con la query
    });
  }

  /**
   * Enrich status_change findings with ActionLog context.
   * For paused entities: who paused it, why, when, and with what metrics.
   * This prevents false alarms like "APAGADO con ROAS élite — error operativo".
   */
  async _enrichStatusChangeFindings(findings) {
    const statusFindings = findings.filter(f => f.type === 'status_change');
    if (statusFindings.length === 0) return;

    // Get entity IDs that changed status
    const entityIds = statusFindings.map(f => f.entity.entity_id);

    // Query ActionLog for the most recent pause/reactivate actions on these entities
    const recentActions = await ActionLog.find({
      entity_id: { $in: entityIds },
      action: { $in: ['pause', 'reactivate', 'kill_switch'] },
      success: true
    }).sort({ executed_at: -1 }).lean().catch(() => []);

    // Query BrainRecommendation for approved pause/reactivate recs on these entities
    const approvedRecs = await BrainRecommendation.find({
      'entity.entity_id': { $in: entityIds },
      action_type: { $in: ['pause', 'reactivate'] },
      status: 'approved'
    }).sort({ decided_at: -1 }).lean().catch(() => []);

    // Build lookup maps
    const actionByEntity = {};
    for (const a of recentActions) {
      if (!actionByEntity[a.entity_id]) actionByEntity[a.entity_id] = a;
    }
    const recByEntity = {};
    for (const r of approvedRecs) {
      if (!recByEntity[r.entity.entity_id]) recByEntity[r.entity.entity_id] = r;
    }

    // Enrich each status_change finding
    for (const f of statusFindings) {
      const eid = f.entity.entity_id;
      const action = actionByEntity[eid];
      const rec = recByEntity[eid];

      if (action) {
        const daysAgo = Math.round((Date.now() - new Date(action.executed_at).getTime()) / 86400000);
        f.data.pause_context = {
          paused_by: action.agent_type || 'unknown',
          reasoning: action.reasoning || null,
          executed_at: action.executed_at,
          days_ago: daysAgo,
          metrics_at_pause: action.metrics_at_execution || null
        };
      }

      if (rec) {
        f.data.recommendation_context = {
          action_type: rec.action_type,
          reasoning: rec.reasoning || null,
          decided_at: rec.decided_at,
          priority: rec.priority,
          confidence: rec.confidence
        };
      }

      // Downgrade severity if we know who paused it and why
      if (f.data.to === 'PAUSED' && action) {
        if (action.agent_type === 'brain' || action.agent_type === 'ai_manager') {
          // Brain or AI Manager paused it intentionally — not an error
          f.severity = 'low';
          f.data.intentional_pause = true;
        } else if (action.agent_type === 'manual') {
          // Human paused it — informational only
          f.severity = 'info';
          f.data.intentional_pause = true;
        }
      }
    }
  }

  /**
   * Extract findings from diagnostic engine results.
   * These catch things the threshold-based detection misses:
   * funnel leaks, creative fatigue patterns, audience saturation.
   */
  _extractDiagnosticFindings(diagnostics, memoryMap) {
    const findings = [];

    for (const [entityId, diag] of Object.entries(diagnostics)) {
      // Critical funnel leaks
      if (diag.funnel.primary_leak) {
        findings.push({
          type: 'diagnostic',
          severity: 'high',
          entity: { entity_type: 'adset', entity_id: entityId, entity_name: diag.entity_name },
          data: {
            diagnostic_label: diag.funnel.primary_leak,
            diagnostic_type: 'funnel_leak',
            message: diag.funnel.leaks[0]?.detail || `Funnel leak: ${diag.funnel.primary_leak}`,
            funnel_rates: diag.funnel.rates,
            suggested_action: diag.overall.primary_action
          }
        });
      }

      // Severe creative fatigue
      if (diag.fatigue.level === 'severe') {
        findings.push({
          type: 'diagnostic',
          severity: 'high',
          entity: { entity_type: 'adset', entity_id: entityId, entity_name: diag.entity_name },
          data: {
            diagnostic_label: 'CREATIVE_FATIGUE_SEVERE',
            diagnostic_type: 'creative_fatigue',
            message: `Fatiga creativa severa (score ${diag.fatigue.score}/100): ${diag.fatigue.signals.map(s => s.detail).join('. ')}`,
            fatigue_score: diag.fatigue.score,
            active_ads: diag.active_ads,
            suggested_action: diag.overall.primary_action
          }
        });
      }

      // Audience saturation
      if (diag.saturation.level === 'saturated') {
        findings.push({
          type: 'diagnostic',
          severity: 'high',
          entity: { entity_type: 'adset', entity_id: entityId, entity_name: diag.entity_name },
          data: {
            diagnostic_label: 'AUDIENCE_SATURATED',
            diagnostic_type: 'audience_saturation',
            message: `Audiencia saturada (score ${diag.saturation.score}/100): ${diag.saturation.signals.map(s => s.detail).join('. ')}`,
            saturation_score: diag.saturation.score,
            suggested_action: diag.overall.primary_action
          }
        });
      }
    }

    return findings;
  }

  /**
   * Fase 2: IA interpreta los hallazgos y genera insights de calidad.
   */
  async _generateInsights(findings, snapshots, accountOverview, recentActions, diagnostics = {}) {
    // Filtrar solo hallazgos que merecen insight (no new_entity/info)
    const significant = findings.filter(f => f.type !== 'new_entity');
    if (significant.length === 0) return 0;

    // Verificar cooldown: no generar insights para entidades recientes
    const recentInsights = await BrainInsight.find({
      created_at: { $gte: new Date(Date.now() - this.thresholds.min_hours_between_insights * 3600000) }
    }).lean();

    const recentEntityIds = new Set();
    for (const ri of recentInsights) {
      for (const e of (ri.entities || [])) {
        recentEntityIds.add(e.entity_id);
      }
    }

    // Filtrar entidades con insights recientes (excepto críticos)
    const filtered = significant.filter(f => {
      if (f.severity === 'critical') return true;
      return !recentEntityIds.has(f.entity.entity_id);
    });

    if (filtered.length === 0) {
      logger.info('[BRAIN-ANALYZER] Todos los hallazgos tienen insights recientes, saltando IA');
      return 0;
    }

    // Buscar insights anteriores para follow-up
    const entityIds = [...new Set(filtered.map(f => f.entity.entity_id))];
    const previousInsights = await BrainInsight.find({
      'entities.entity_id': { $in: entityIds },
      is_resolved: false
    }).sort({ created_at: -1 }).limit(20).lean();

    const previousMap = {};
    for (const pi of previousInsights) {
      for (const e of (pi.entities || [])) {
        if (!previousMap[e.entity_id]) previousMap[e.entity_id] = pi;
      }
    }

    // Construir prompt para Claude (with diagnostic context)
    const prompt = this._buildInsightPrompt(filtered, snapshots, accountOverview, recentActions, previousMap, diagnostics);

    try {
      const response = await this.anthropic.messages.create({
        model: config.claude.model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
        system: this._getInsightSystemPrompt()
      });

      const text = response.content[0]?.text || '';
      const tokensUsed = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

      // Parsear la respuesta JSON de insights
      const insights = this._parseInsightResponse(text, filtered, previousMap);

      // Guardar cada insight (with diagnosis label if available)
      let created = 0;
      for (const insight of insights) {
        try {
          // Attach diagnosis label from diagnostic engine if available
          let diagnosisLabel = null;
          for (const e of (insight.entities || [])) {
            const diag = diagnostics[e.entity_id];
            if (diag && diag.overall?.labels?.length > 0) {
              diagnosisLabel = diag.overall.labels.join(' + ');
              break;
            }
          }

          const doc = await BrainInsight.create({
            ...insight,
            diagnosis: diagnosisLabel,
            generated_by: 'hybrid',
            ai_model: config.claude.model,
            tokens_used: Math.ceil(tokensUsed / insights.length)
          });

          // Si es follow-up, incrementar contador del insight padre
          if (insight.follows_up) {
            await BrainInsight.updateOne(
              { _id: insight.follows_up },
              { $inc: { follow_up_count: 1 } }
            );
          }

          // Actualizar BrainMemory con referencia al insight
          for (const e of (insight.entities || [])) {
            await BrainMemory.updateOne(
              { entity_id: e.entity_id },
              {
                $set: { last_insight_at: new Date(), last_insight_id: doc._id },
                $inc: { insights_generated: 1 }
              }
            );
          }

          created++;
        } catch (saveErr) {
          logger.error(`[BRAIN-ANALYZER] Error guardando insight: ${saveErr.message}`);
        }
      }

      logger.info(`[BRAIN-ANALYZER] ${created} insights generados por IA (${tokensUsed} tokens)`);
      return created;
    } catch (aiErr) {
      logger.error(`[BRAIN-ANALYZER] Error llamando Claude: ${aiErr.message}`);
      // Fallback: guardar hallazgos como insights matemáticos sin IA
      return this._saveMathFallbackInsights(filtered);
    }
  }

  /**
   * System prompt para generación de insights.
   */
  _getInsightSystemPrompt() {
    return `Eres el Brain Analyst de un sistema de gestión de Meta Ads para Jersey Pickles (e-commerce de alimentos).

Tu trabajo es analizar hallazgos en las campañas publicitarias y generar insights de calidad profesional en ESPAÑOL.

REGLAS CRÍTICAS:
1. Sé CONCISO pero PROFUNDO. Un buen insight explica el QUÉ, el POR QUÉ probable, y el QUÉ HACER.
2. Si hay un insight anterior relacionado (follow-up), REFERENCÍA lo que dijiste antes y cómo evolucionó.
3. No repitas información obvia. El usuario sabe qué es ROAS, CPA, etc.
4. Usa números específicos, no generalidades.
5. Si algo es urgente, dilo claramente. Si no, no alarmes innecesariamente.
6. Cada insight debe poder leerse independientemente pero formar parte de una narrativa coherente.
7. DIAGNOSTICA LA CAUSA RAÍZ: Cuando un ad set tiene mal ROAS, NO solo digas "ROAS bajo". Explica POR QUÉ:
   - Si hay datos de funnel (ATC→IC→Purchase), analiza dónde se pierde la conversión
   - Si hay CTR alto pero 0 conversiones → probable problema de landing page, no del ad
   - Si hay frequency alta con CTR cayendo → audiencia saturada, no mal ad
   - Si hay CPA subiendo con CTR estable → posible competencia CPM, no fatiga creativa
8. USA LOS DATOS DE DIAGNÓSTICO PRE-COMPUTADOS cuando estén disponibles. No ignores las etiquetas diagnósticas.
9. AD SETS PAUSADOS — CONTEXTO OBLIGATORIO:
   - Si un hallazgo es status_change a PAUSED y tiene CONTEXTO DE PAUSA, DEBES mencionarlo.
   - Si fue pausado por Brain/AI Manager → es una PAUSA INTENCIONAL. NO generes alarma de "error operativo".
     Ejemplo correcto: "Ad set pausado por el Brain hace 3 días por fatiga creativa. ROAS histórico 5.3x."
     Ejemplo INCORRECTO: "Ad set APAGADO con ROAS élite 5.3x — error operativo crítico"
   - Si fue pausado por operador humano → informativo. No sugerir reactivar automáticamente.
   - Si no hay contexto de pausa → puede ser pausa manual antigua. Indicar que no hay registro del motivo.
   - Solo sugerir reactivación si la RAZÓN ORIGINAL de la pausa ya no aplica (ej: fatiga resuelta con nuevos creativos).

FORMATO DE RESPUESTA:
Responde con un JSON array. Cada elemento:
{
  "insight_type": "anomaly|trend|opportunity|warning|milestone|follow_up",
  "severity": "critical|high|medium|low|info",
  "title": "Título corto en español (máx 80 chars)",
  "body": "Análisis completo en español (2-4 párrafos)",
  "entity_ids": ["id1", "id2"],
  "follows_up_entity_id": "entity_id del insight anterior si es follow-up, o null"
}

IMPORTANTE: Responde SOLO con el JSON array, sin texto adicional ni markdown.`;
  }

  /**
   * Construye el prompt con los hallazgos y contexto.
   */
  _buildInsightPrompt(findings, snapshots, accountOverview, recentActions, previousMap, diagnostics = {}) {
    const snapshotMap = {};
    for (const s of snapshots) snapshotMap[s.entity_id] = s;

    let prompt = `## HALLAZGOS DETECTADOS\n\n`;

    for (const f of findings) {
      const snap = snapshotMap[f.entity.entity_id];
      const m7d = snap?.metrics?.last_7d || {};
      const m3d = snap?.metrics?.last_3d || {};
      const m14d = snap?.metrics?.last_14d || {};
      const mToday = snap?.metrics?.today || {};

      prompt += `### ${f.entity.entity_name} (${f.entity.entity_id})\n`;
      prompt += `Tipo: ${f.type} | Severidad: ${f.severity}\n`;
      prompt += `Datos: ${JSON.stringify(f.data)}\n`;
      prompt += `Métricas actuales 7d: ROAS=${m7d.roas?.toFixed(2)||'N/A'}, Spend=$${m7d.spend?.toFixed(0)||0}, CPA=$${m7d.cpa?.toFixed(2)||'N/A'}, CTR=${m7d.ctr?.toFixed(2)||'N/A'}%, Freq=${m7d.frequency?.toFixed(1)||'N/A'}, Purchases=${m7d.purchases||0}\n`;
      prompt += `Métricas 3d: ROAS=${m3d.roas?.toFixed(2)||'N/A'}, Spend=$${m3d.spend?.toFixed(0)||0}\n`;
      prompt += `Métricas 14d: ROAS=${m14d.roas?.toFixed(2)||'N/A'}, CPA=$${m14d.cpa?.toFixed(2)||'N/A'}\n`;
      prompt += `Hoy: ROAS=${mToday.roas?.toFixed(2)||'N/A'}, Spend=$${mToday.spend?.toFixed(0)||0}\n`;
      prompt += `Budget diario: $${snap?.daily_budget || 0}\n`;

      // Funnel data
      if ((m7d.add_to_cart || 0) > 0 || (m7d.clicks || 0) > 20) {
        const clicks = m7d.clicks || 0;
        const atc = m7d.add_to_cart || 0;
        const ic = m7d.initiate_checkout || 0;
        const purchases = m7d.purchases || 0;
        prompt += `Funnel 7d: ${clicks} clicks → ${atc} ATC → ${ic} IC → ${purchases} compras`;
        if (clicks > 0) prompt += ` (Click→Compra: ${((purchases / clicks) * 100).toFixed(1)}%)`;
        if (atc > 0) prompt += ` (ATC→Compra: ${((purchases / atc) * 100).toFixed(0)}%)`;
        prompt += '\n';
      }

      // Diagnostic context for this entity
      const diag = diagnostics[f.entity.entity_id];
      if (diag) {
        prompt += `DIAGNÓSTICO: [${diag.overall.labels.join(' + ')}] — ${diag.overall.summary}\n`;
        if (diag.fatigue.score > 10) prompt += `  Fatiga creativa: ${diag.fatigue.level} (${diag.fatigue.score}/100) | ${diag.active_ads} ads activos\n`;
        if (diag.saturation.score > 10) prompt += `  Saturación audiencia: ${diag.saturation.level} (${diag.saturation.score}/100)\n`;
        prompt += `  Acción sugerida: ${diag.overall.primary_action}\n`;
      }

      // Pause context: who paused it, why, and when
      if (f.data.pause_context) {
        const pc = f.data.pause_context;
        const agentLabels = { brain: 'el Brain (IA)', ai_manager: 'el AI Manager', manual: 'el operador humano', scaling: 'agente de escalamiento', performance: 'agente de performance' };
        const who = agentLabels[pc.paused_by] || pc.paused_by;
        prompt += `CONTEXTO DE PAUSA: Pausado por ${who} hace ${pc.days_ago} día(s)\n`;
        if (pc.reasoning) prompt += `  Razón: ${pc.reasoning}\n`;
        if (pc.metrics_at_pause) {
          prompt += `  Métricas al pausar: ROAS 7d: ${(pc.metrics_at_pause.roas_7d || 0).toFixed(2)}x, CPA: $${(pc.metrics_at_pause.cpa_7d || 0).toFixed(2)}, Freq: ${(pc.metrics_at_pause.frequency || 0).toFixed(1)}\n`;
        }
        if (f.data.intentional_pause) {
          prompt += `  ⚠️ PAUSA INTENCIONAL — NO es un error operativo\n`;
        }
      }
      if (f.data.recommendation_context) {
        const rc = f.data.recommendation_context;
        prompt += `  Recomendación aprobada: ${rc.action_type} (prioridad: ${rc.priority}, confianza: ${rc.confidence})\n`;
        if (rc.reasoning) prompt += `  Razón de la recomendación: ${rc.reasoning}\n`;
      }

      const prev = previousMap[f.entity.entity_id];
      if (prev) {
        prompt += `\nINSIGHT ANTERIOR (${prev.created_at.toISOString().split('T')[0]}): "${prev.title}"\n`;
        prompt += `Resumen: ${prev.body.substring(0, 200)}...\n`;
      }
      prompt += `\n---\n\n`;
    }

    prompt += `## CONTEXTO DE CUENTA\n`;
    prompt += `ROAS 7d cuenta: ${accountOverview.roas_7d?.toFixed(2) || 'N/A'}x\n`;
    prompt += `ROAS 3d cuenta: ${accountOverview.roas_3d?.toFixed(2) || 'N/A'}x\n`;
    prompt += `Spend hoy: $${accountOverview.today_spend?.toFixed(0) || 0}\n`;
    prompt += `Ad sets activos: ${accountOverview.active_adsets} | Pausados: ${accountOverview.paused_adsets}\n`;
    prompt += `Target ROAS: ${kpiTargets.roas_target}x | Mínimo: ${kpiTargets.roas_minimum}x\n`;

    if (recentActions.length > 0) {
      prompt += `\n## ACCIONES RECIENTES (últimas 3d)\n`;
      for (const a of recentActions.slice(0, 10)) {
        prompt += `- ${a.action} en ${a.entity_name}: ${a.before_value} → ${a.after_value} (${a.executed_at.toISOString().split('T')[0]})\n`;
      }
    }

    prompt += `\nGenera insights para los hallazgos significativos. Si un hallazgo tiene insight anterior, haz follow-up referenciándolo.`;

    return prompt;
  }

  /**
   * Parsear la respuesta JSON de Claude.
   */
  _parseInsightResponse(text, findings, previousMap) {
    try {
      // Intentar extraer JSON del texto
      let jsonText = text.trim();
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/```json?\n?/g, '').replace(/```$/g, '').trim();
      }

      const parsed = JSON.parse(jsonText);
      if (!Array.isArray(parsed)) return [];

      return parsed.map(item => {
        // Encontrar el finding correspondiente para las entidades
        const entityIds = item.entity_ids || [];
        const entities = entityIds.map(id => {
          const finding = findings.find(f => f.entity.entity_id === id);
          return finding ? finding.entity : { entity_type: 'adset', entity_id: id, entity_name: id };
        });

        // Encontrar insight anterior para follow-up
        let followsUp = null;
        if (item.follows_up_entity_id && previousMap[item.follows_up_entity_id]) {
          followsUp = previousMap[item.follows_up_entity_id]._id;
        }

        return {
          insight_type: item.insight_type || 'anomaly',
          severity: item.severity || 'medium',
          title: item.title || 'Insight detectado',
          body: item.body || '',
          entities,
          follows_up: followsUp,
          data_points: item.data_points || {}
        };
      }).filter(i => i.body.length > 0);
    } catch (parseErr) {
      logger.error(`[BRAIN-ANALYZER] Error parseando respuesta IA: ${parseErr.message}`);
      return [];
    }
  }

  /**
   * Fallback: guardar insights básicos sin IA cuando Claude falla.
   */
  async _saveMathFallbackInsights(findings) {
    let created = 0;
    for (const f of findings) {
      try {
        const typeMap = {
          anomaly: 'anomaly', trend: 'trend', opportunity: 'opportunity',
          warning: 'warning', milestone: 'milestone', status_change: 'status_change'
        };

        let title, body;
        if (f.data.metric) {
          const direction = f.data.delta_pct > 0 ? 'subió' : 'bajó';
          title = `${f.entity.entity_name}: ${f.data.metric} ${direction} ${Math.abs(f.data.delta_pct)}%`;
          body = `El ${f.data.metric} de "${f.entity.entity_name}" cambió de ${f.data.from?.toFixed(2)} a ${f.data.to?.toFixed(2)} (${f.data.delta_pct > 0 ? '+' : ''}${f.data.delta_pct}%). ${f.data.message || ''}`;
        } else if (f.type === 'status_change') {
          title = `${f.entity.entity_name}: estado cambió a ${f.data.to}`;
          body = `"${f.entity.entity_name}" cambió de ${f.data.from} a ${f.data.to}.`;
        } else {
          title = `${f.entity.entity_name}: ${f.data.message || f.type}`;
          body = f.data.message || JSON.stringify(f.data);
        }

        await BrainInsight.create({
          insight_type: typeMap[f.type] || 'anomaly',
          severity: f.severity,
          title,
          body,
          entities: [f.entity],
          data_points: f.data,
          generated_by: 'math'
        });
        created++;
      } catch (err) {
        logger.error(`[BRAIN-ANALYZER] Error en fallback insight: ${err.message}`);
      }
    }
    return created;
  }

  /**
   * Fase 3: Actualizar BrainMemory con el estado actual.
   */
  async _updateMemory(snapshots) {
    const bulkOps = [];

    for (const snap of snapshots) {
      const m7d = snap.metrics?.last_7d || {};
      const mToday = snap.metrics?.today || {};

      // Leer memoria anterior para calcular tendencias
      const existing = await BrainMemory.findOne({ entity_id: snap.entity_id }).lean();

      let trends = { roas_direction: 'unknown', spend_direction: 'unknown', consecutive_decline_days: 0, consecutive_improve_days: 0 };

      if (existing) {
        const rm = existing.remembered_metrics;
        // ROAS direction
        if (rm.roas_7d > 0 && (m7d.roas || 0) > 0) {
          const roasDelta = m7d.roas - rm.roas_7d;
          if (roasDelta > 0.1) {
            trends.roas_direction = 'improving';
            trends.consecutive_improve_days = (existing.trends?.consecutive_improve_days || 0) + 1;
            trends.consecutive_decline_days = 0;
          } else if (roasDelta < -0.1) {
            trends.roas_direction = 'declining';
            trends.consecutive_decline_days = (existing.trends?.consecutive_decline_days || 0) + 1;
            trends.consecutive_improve_days = 0;
          } else {
            trends.roas_direction = 'stable';
            trends.consecutive_decline_days = 0;
            trends.consecutive_improve_days = 0;
          }
        }

        // Spend direction
        if (rm.spend_7d > 0 && (m7d.spend || 0) > 0) {
          const spendDelta = ((m7d.spend - rm.spend_7d) / rm.spend_7d) * 100;
          if (spendDelta > 10) trends.spend_direction = 'increasing';
          else if (spendDelta < -10) trends.spend_direction = 'decreasing';
          else trends.spend_direction = 'stable';
        }
      }

      bulkOps.push({
        updateOne: {
          filter: { entity_id: snap.entity_id },
          update: {
            $set: {
              entity_type: 'adset',
              entity_name: snap.entity_name,
              last_status: snap.status,
              last_daily_budget: snap.daily_budget || 0,
              remembered_metrics: {
                spend_7d: m7d.spend || 0,
                roas_7d: m7d.roas || 0,
                cpa_7d: m7d.cpa || 0,
                ctr_7d: m7d.ctr || 0,
                frequency_7d: m7d.frequency || 0,
                purchases_7d: m7d.purchases || 0,
                reach_7d: m7d.reach || 0,
                spend_today: mToday.spend || 0,
                roas_today: mToday.roas || 0
              },
              trends,
              last_updated_at: new Date()
            },
            $setOnInsert: {
              first_seen_at: new Date(),
              insights_generated: 0
            }
          },
          upsert: true
        }
      });
    }

    if (bulkOps.length > 0) {
      await BrainMemory.bulkWrite(bulkOps);
      logger.info(`[BRAIN-ANALYZER] Memoria actualizada: ${bulkOps.length} entidades`);
    }

    // ═══ UPDATE TEMPORAL PATTERNS (account-level day-of-week averages) ═══
    try {
      const now = moment().tz(process.env.TIMEZONE || 'America/New_York');
      const dayKey = now.format('dddd').toLowerCase(); // "monday", "tuesday", etc.

      // Compute account-level averages from active ad sets
      const activeSnaps = snapshots.filter(s => s.status === 'ACTIVE');
      if (activeSnaps.length > 0) {
        let totalRoas = 0, totalCpa = 0, totalCtr = 0, totalSpend = 0, totalFreq = 0, count = 0;
        for (const s of activeSnaps) {
          const m7d = s.metrics?.last_7d || {};
          if ((m7d.spend || 0) >= this.thresholds.min_spend_for_analysis) {
            totalRoas += (m7d.roas || 0);
            totalCpa += (m7d.cpa || 0);
            totalCtr += (m7d.ctr || 0);
            totalSpend += (m7d.spend || 0);
            totalFreq += (m7d.frequency || 0);
            count++;
          }
        }
        if (count > 0) {
          const currentRoas = totalRoas / count;
          const currentCpa = totalCpa / count;
          const currentCtr = totalCtr / count;
          const currentSpend = totalSpend / count;
          const currentFreq = totalFreq / count;

          // Running average update: new_avg = (old_avg * N + current) / (N + 1)
          const existing = await BrainTemporalPattern.findOne({
            pattern_type: 'day_of_week', pattern_key: dayKey, level: 'account'
          }).lean();

          const N = existing?.metrics?.sample_count || 0;
          const old = existing?.metrics || {};
          const updated = {
            avg_roas: N > 0 ? (old.avg_roas * N + currentRoas) / (N + 1) : currentRoas,
            avg_cpa: N > 0 ? (old.avg_cpa * N + currentCpa) / (N + 1) : currentCpa,
            avg_ctr: N > 0 ? (old.avg_ctr * N + currentCtr) / (N + 1) : currentCtr,
            avg_spend: N > 0 ? (old.avg_spend * N + currentSpend) / (N + 1) : currentSpend,
            avg_frequency: N > 0 ? (old.avg_frequency * N + currentFreq) / (N + 1) : currentFreq,
            sample_count: N + 1
          };

          await BrainTemporalPattern.findOneAndUpdate(
            { pattern_type: 'day_of_week', pattern_key: dayKey, level: 'account' },
            { $set: { metrics: updated, last_updated_at: new Date() } },
            { upsert: true }
          );
        }
      }
    } catch (tempErr) {
      logger.warn(`[BRAIN-ANALYZER] Temporal pattern update error (non-fatal): ${tempErr.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // BRAIN ACTIVITY — Resumen de cada ciclo de análisis
  // ═══════════════════════════════════════════════════════════════

  /**
   * Genera un insight brain_activity al final de cada ciclo de análisis.
   * Muestra qué analizó el Brain, cuántos hallazgos encontró, cuántos insights creó.
   * Solo genera si hubo actividad significativa (hallazgos > 0 o es el primer ciclo del día).
   */
  async _generateBrainActivity(snapshots, findings, insightsCreated, accountOverview) {
    try {
      // Cooldown: máximo 1 brain_activity cada 30 minutos
      const recentActivity = await BrainInsight.findOne({
        insight_type: 'brain_activity',
        created_at: { $gte: new Date(Date.now() - 30 * 60000) }
      }).lean();
      if (recentActivity) return 0;

      const activeAdsets = snapshots.filter(s => s.status === 'ACTIVE');
      const pausedAdsets = snapshots.filter(s => ['PAUSED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED'].includes(s.status));
      const totalSpend = activeAdsets.reduce((sum, s) => sum + (s.metrics?.last_7d?.spend || 0), 0);
      const avgRoas = activeAdsets.length > 0
        ? activeAdsets.reduce((sum, s) => sum + (s.metrics?.last_7d?.roas || 0), 0) / activeAdsets.length
        : 0;

      // Count entities in cooldown (had insights in last 2h)
      const recentInsights = await BrainInsight.find({
        created_at: { $gte: new Date(Date.now() - 2 * 3600000) },
        insight_type: { $nin: ['brain_activity', 'brain_thinking', 'summary'] }
      }).lean();
      const cooldownEntityIds = new Set();
      for (const ri of recentInsights) {
        for (const e of (ri.entities || [])) cooldownEntityIds.add(e.entity_id);
      }

      // Count pending recs
      const pendingRecs = await BrainRecommendation.countDocuments({ status: 'pending' });

      const findingTypes = {};
      for (const f of findings) {
        findingTypes[f.type] = (findingTypes[f.type] || 0) + 1;
      }

      const body = [
        `**Entidades escaneadas:** ${snapshots.length} (${activeAdsets.length} activos, ${pausedAdsets.length} pausados)`,
        `**Hallazgos detectados:** ${findings.length}${findings.length > 0 ? ` — ${Object.entries(findingTypes).map(([t, c]) => `${c} ${t}`).join(', ')}` : ''}`,
        `**Insights generados:** ${insightsCreated}`,
        `**Entidades en cooldown:** ${cooldownEntityIds.size} (con insights recientes, no re-analizadas)`,
        `**Recs pendientes:** ${pendingRecs}`,
        '',
        `**Estado cuenta:** ROAS 7d ${accountOverview.roas_7d?.toFixed(2) || 'N/A'}x | Spend total 7d $${totalSpend.toFixed(0)} | Avg ROAS ${avgRoas.toFixed(2)}x`
      ].join('\n');

      await BrainInsight.create({
        insight_type: 'brain_activity',
        severity: 'info',
        title: findings.length > 0
          ? `Ciclo completado: ${findings.length} hallazgo${findings.length > 1 ? 's' : ''}, ${insightsCreated} insight${insightsCreated > 1 ? 's' : ''}`
          : 'Ciclo completado: sin hallazgos significativos',
        body,
        entities: [{ entity_type: 'account', entity_id: 'account', entity_name: 'Cuenta' }],
        data_points: {
          entities_scanned: snapshots.length,
          active: activeAdsets.length,
          paused: pausedAdsets.length,
          findings: findings.length,
          insights_created: insightsCreated,
          in_cooldown: cooldownEntityIds.size,
          pending_recs: pendingRecs,
          account_roas_7d: +(accountOverview.roas_7d?.toFixed(2) || 0)
        },
        generated_by: 'brain'
      });

      return 1;
    } catch (err) {
      logger.warn(`[BRAIN-ANALYZER] Error generando brain_activity: ${err.message}`);
      return 0;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // BRAIN THINKING — Por qué el Brain decidió NO actuar
  // ═══════════════════════════════════════════════════════════════

  /**
   * Genera insights brain_thinking para entidades donde el Brain analizó
   * pero decidió NO generar un insight ni recomendación. Explica POR QUÉ.
   * Solo genera cada ~4 horas y agrupa varias entidades en un solo insight.
   */
  async _generateBrainThinking(snapshots, findings, memoryMap, diagnostics) {
    try {
      // Cooldown: máximo 1 brain_thinking cada 4 horas
      const recentThinking = await BrainInsight.findOne({
        insight_type: 'brain_thinking',
        created_at: { $gte: new Date(Date.now() - 4 * 3600000) }
      }).lean();
      if (recentThinking) return 0;

      const activeAdsets = snapshots.filter(s => s.status === 'ACTIVE' && (s.metrics?.last_7d?.spend || 0) >= this.thresholds.min_spend_for_analysis);

      // Find entities that had NO findings (Brain looked at them but found nothing significant)
      const findingEntityIds = new Set(findings.map(f => f.entity?.entity_id));
      const stableEntities = activeAdsets.filter(s => !findingEntityIds.has(s.entity_id) && memoryMap[s.entity_id]);

      if (stableEntities.length === 0) return 0;

      // Categorize why each entity was deemed stable
      const reasons = { within_range: [], in_cooldown: [], improving: [], stable_good: [] };

      const recentInsights = await BrainInsight.find({
        created_at: { $gte: new Date(Date.now() - 2 * 3600000) },
        insight_type: { $nin: ['brain_activity', 'brain_thinking', 'summary'] }
      }).lean();
      const cooldownEntityIds = new Set();
      for (const ri of recentInsights) {
        for (const e of (ri.entities || [])) cooldownEntityIds.add(e.entity_id);
      }

      for (const snap of stableEntities) {
        const memory = memoryMap[snap.entity_id];
        const m7d = snap.metrics?.last_7d || {};
        const rm = memory?.remembered_metrics || {};
        const name = snap.entity_name;
        const roas = m7d.roas?.toFixed(2) || 'N/A';

        if (cooldownEntityIds.has(snap.entity_id)) {
          reasons.in_cooldown.push(`${name} (ROAS ${roas}x) — insight generado recientemente, en periodo de observación`);
        } else if (memory?.trends?.roas_direction === 'improving') {
          reasons.improving.push(`${name} (ROAS ${roas}x, mejorando ${memory.trends.consecutive_improve_days || 0} ciclos)`);
        } else if ((m7d.roas || 0) >= kpiTargets.roas_target) {
          reasons.stable_good.push(`${name} (ROAS ${roas}x) — por encima del target ${kpiTargets.roas_target}x`);
        } else {
          // Within normal variation range
          const roasDelta = rm.roas_7d > 0 ? Math.abs(((m7d.roas || 0) - rm.roas_7d) / rm.roas_7d * 100) : 0;
          reasons.within_range.push(`${name} (ROAS ${roas}x, cambio ${roasDelta.toFixed(0)}% — bajo umbral ${this.thresholds.roas_change_pct}%)`);
        }
      }

      const sections = [];
      if (reasons.stable_good.length > 0) {
        sections.push(`**Funcionando bien (sin tocar):**\n${reasons.stable_good.map(r => `- ${r}`).join('\n')}`);
      }
      if (reasons.improving.length > 0) {
        sections.push(`**Mejorando (observando tendencia):**\n${reasons.improving.map(r => `- ${r}`).join('\n')}`);
      }
      if (reasons.within_range.length > 0) {
        sections.push(`**Cambios dentro del rango normal:**\n${reasons.within_range.map(r => `- ${r}`).join('\n')}`);
      }
      if (reasons.in_cooldown.length > 0) {
        sections.push(`**En cooldown (insight reciente):**\n${reasons.in_cooldown.map(r => `- ${r}`).join('\n')}`);
      }

      const body = `El Brain analizó ${stableEntities.length} ad sets activos y decidió **no generar alertas** para ellos. Razones:\n\n${sections.join('\n\n')}`;

      await BrainInsight.create({
        insight_type: 'brain_thinking',
        severity: 'info',
        title: `${stableEntities.length} ad sets estables — sin acción necesaria`,
        body,
        entities: [{ entity_type: 'account', entity_id: 'account', entity_name: 'Cuenta' }],
        data_points: {
          stable_count: stableEntities.length,
          stable_good: reasons.stable_good.length,
          improving: reasons.improving.length,
          within_range: reasons.within_range.length,
          in_cooldown: reasons.in_cooldown.length
        },
        generated_by: 'brain'
      });

      return 1;
    } catch (err) {
      logger.warn(`[BRAIN-ANALYZER] Error generando brain_thinking: ${err.message}`);
      return 0;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // LINK INSIGHTS ↔ RECOMMENDATIONS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Conecta insights recientes con recomendaciones pendientes para la misma entidad.
   * Permite mostrar "Ver recomendación" en el feed.
   */
  async _linkInsightsToRecommendations() {
    try {
      // Get pending recommendations
      const pendingRecs = await BrainRecommendation.find({ status: 'pending' }).lean();
      if (pendingRecs.length === 0) return;

      // Build map: entity_id → rec
      const recsByEntity = {};
      for (const rec of pendingRecs) {
        if (rec.entity?.entity_id) {
          recsByEntity[rec.entity.entity_id] = rec._id;
        }
      }

      // Get recent unlinked insights (last 24h, no related_recommendation yet)
      const recentInsights = await BrainInsight.find({
        created_at: { $gte: new Date(Date.now() - 24 * 3600000) },
        related_recommendation: null,
        insight_type: { $nin: ['brain_activity', 'brain_thinking', 'summary'] }
      }).lean();

      let linked = 0;
      for (const insight of recentInsights) {
        for (const entity of (insight.entities || [])) {
          if (recsByEntity[entity.entity_id]) {
            await BrainInsight.updateOne(
              { _id: insight._id },
              { $set: { related_recommendation: recsByEntity[entity.entity_id] } }
            );
            linked++;
            break; // One rec per insight
          }
        }
      }

      if (linked > 0) {
        logger.info(`[BRAIN-ANALYZER] ${linked} insights vinculados con recomendaciones pendientes`);
      }
    } catch (err) {
      logger.warn(`[BRAIN-ANALYZER] Error vinculando insights↔recs: ${err.message}`);
    }
  }

  /**
   * Resumen periódico: cada ~6 horas genera un overview general.
   */
  async _maybeSummary(snapshots, accountOverview) {
    const lastSummary = await BrainInsight.findOne({ insight_type: 'summary' })
      .sort({ created_at: -1 }).lean();

    const sixHoursAgo = new Date(Date.now() - 6 * 3600000);
    if (lastSummary && lastSummary.created_at > sixHoursAgo) {
      return false; // Muy pronto para otro resumen
    }

    // Generar resumen con IA
    const activeAdsets = snapshots.filter(s => s.status === 'ACTIVE');
    const pausedAdsets = snapshots.filter(s => ['PAUSED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED'].includes(s.status));

    const topPerformers = [...activeAdsets]
      .sort((a, b) => (b.metrics?.last_7d?.roas || 0) - (a.metrics?.last_7d?.roas || 0))
      .slice(0, 5);

    const worstPerformers = [...activeAdsets]
      .filter(s => (s.metrics?.last_7d?.spend || 0) > 10)
      .sort((a, b) => (a.metrics?.last_7d?.roas || 0) - (b.metrics?.last_7d?.roas || 0))
      .slice(0, 5);

    // Count problems
    const problemAdsets = activeAdsets.filter(s => {
      const m = s.metrics?.last_7d || {};
      return (m.roas || 0) < kpiTargets.roas_minimum || (m.frequency || 0) >= kpiTargets.frequency_warning;
    });

    let summaryPrompt = `Genera un RESUMEN EJECUTIVO ESTRUCTURADO del estado actual de las campañas de Meta Ads.

## DATOS DE CUENTA
- ROAS 7d: ${accountOverview.roas_7d?.toFixed(2)}x (target: ${kpiTargets.roas_target}x, mínimo: ${kpiTargets.roas_minimum}x)
- ROAS 3d: ${accountOverview.roas_3d?.toFixed(2)}x
- Spend hoy: $${accountOverview.today_spend?.toFixed(0)}
- Revenue hoy: $${accountOverview.today_revenue?.toFixed(0)}
- Ad sets activos: ${accountOverview.active_adsets} | Pausados: ${accountOverview.paused_adsets} | Total: ${accountOverview.total_adsets}
- Ad sets con problemas: ${problemAdsets.length}

## TOP 5 PERFORMERS (7d ROAS)
${topPerformers.map(s => `- ${s.entity_name}: ROAS ${(s.metrics?.last_7d?.roas || 0).toFixed(2)}x, Spend $${(s.metrics?.last_7d?.spend || 0).toFixed(0)}, ${s.metrics?.last_7d?.purchases || 0} compras, Freq ${(s.metrics?.last_7d?.frequency || 0).toFixed(1)}`).join('\n')}

## PEORES 5 (con spend >$10)
${worstPerformers.map(s => `- ${s.entity_name}: ROAS ${(s.metrics?.last_7d?.roas || 0).toFixed(2)}x, Spend $${(s.metrics?.last_7d?.spend || 0).toFixed(0)}, ${s.metrics?.last_7d?.purchases || 0} compras, Freq ${(s.metrics?.last_7d?.frequency || 0).toFixed(1)}`).join('\n')}

${lastSummary ? `\n## RESUMEN ANTERIOR (${lastSummary.created_at.toISOString().split('T')[0]})\n"${lastSummary.title}"\n${lastSummary.body.substring(0, 300)}...` : ''}

FORMATO OBLIGATORIO — Responde con un JSON con EXACTAMENTE estas 4 secciones:
{
  "title": "Título corto del resumen (máx 80 chars)",
  "estado_general": "1-2 oraciones: salud general de la cuenta, ROAS vs target, tendencia",
  "top_performers": "Lista breve de 2-3 ad sets que mejor funcionan y por qué",
  "problemas_activos": "Lista de problemas actuales: ad sets bajo mínimo ROAS, frecuencia alta, etc. Si no hay problemas, decir 'Sin problemas críticos'",
  "proximos_pasos": "1-3 acciones sugeridas para las próximas horas/día"
}

IMPORTANTE: Responde SOLO con el JSON, sin texto adicional ni markdown.`;

    try {
      const response = await this.anthropic.messages.create({
        model: config.claude.model,
        max_tokens: 1500,
        messages: [{ role: 'user', content: summaryPrompt }],
        system: 'Eres un analista senior de Meta Ads. Genera resúmenes ejecutivos concisos y accionables en español. Responde SOLO con JSON, sin markdown.'
      });

      const text = response.content[0]?.text || '';
      let jsonText = text.trim();
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/```json?\n?/g, '').replace(/```$/g, '').trim();
      }

      const parsed = JSON.parse(jsonText);
      const tokensUsed = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

      // Build structured body from the 4 sections
      const structuredBody = [
        parsed.estado_general ? `**Estado general**\n${parsed.estado_general}` : null,
        parsed.top_performers ? `**Top performers**\n${parsed.top_performers}` : null,
        parsed.problemas_activos ? `**Problemas activos**\n${parsed.problemas_activos}` : null,
        parsed.proximos_pasos ? `**Próximos pasos**\n${parsed.proximos_pasos}` : null,
      ].filter(Boolean).join('\n\n');

      await BrainInsight.create({
        insight_type: 'summary',
        severity: 'info',
        title: parsed.title || 'Resumen de cuenta',
        body: structuredBody || parsed.body || '',
        entities: [{ entity_type: 'account', entity_id: 'account', entity_name: 'Cuenta' }],
        data_points: {
          roas_7d: +(accountOverview.roas_7d?.toFixed(2) || 0),
          roas_3d: +(accountOverview.roas_3d?.toFixed(2) || 0),
          active_adsets: accountOverview.active_adsets,
          problem_adsets: problemAdsets.length,
          today_spend: +(accountOverview.today_spend?.toFixed(0) || 0),
          today_revenue: +(accountOverview.today_revenue?.toFixed(0) || 0)
        },
        generated_by: 'ai',
        ai_model: config.claude.model,
        tokens_used: tokensUsed,
        follows_up: lastSummary?._id || null
      });

      logger.info(`[BRAIN-ANALYZER] Resumen periódico generado (${tokensUsed} tokens)`);
      return true;
    } catch (err) {
      logger.error(`[BRAIN-ANALYZER] Error generando resumen: ${err.message}`);
      return false;
    }
  }

  /**
   * Chat: el usuario pregunta sobre las campañas.
   * El Brain responde con datos reales como contexto.
   */
  /**
   * Prepara el contexto del chat: carga datos, construye system prompt y mensajes.
   * Usado tanto por chat() como por chatStream().
   */
  async _prepareChatContext(userMessage) {
    const [adsetSnapshots, accountOverview, recentInsights, chatHistory, activeRecs, recHistory, cycleMemories, adSnapshots, memories] = await Promise.all([
      getLatestSnapshots('adset'),
      getAccountOverview(),
      BrainInsight.find({}).sort({ created_at: -1 }).limit(10).lean(),
      BrainChat.find({}).sort({ created_at: -1 }).limit(10).lean(),
      BrainRecommendation.find({ status: { $in: ['pending', 'approved'] } }).sort({ created_at: -1 }).limit(10).lean(),
      BrainRecommendation.find({ status: { $in: ['approved', 'rejected'] } }).sort({ decided_at: -1 }).limit(20).lean(),
      BrainCycleMemory.find({}).sort({ created_at: -1 }).limit(3).lean().catch(() => []),
      getLatestSnapshots('ad').catch(() => []),
      BrainMemory.find({}).lean().catch(() => [])
    ]);

    await BrainChat.create({ role: 'user', content: userMessage });

    let diagnosticSummary = '';
    try {
      const memoryMap = {};
      for (const m of memories) memoryMap[m.entity_id] = m;
      const diagnostics = this.diagnosticEngine.diagnoseAll(adsetSnapshots, adSnapshots, memoryMap, accountOverview);
      diagnosticSummary = this.diagnosticEngine.formatForPrompt(diagnostics);
    } catch (diagErr) {
      // Non-fatal
    }

    const context = this._buildChatContext(adsetSnapshots, accountOverview, recentInsights, activeRecs, recHistory, cycleMemories);

    const messages = [];
    const history = chatHistory.reverse();
    for (const msg of history) {
      messages.push({ role: msg.role, content: msg.content });
    }
    messages.push({ role: 'user', content: userMessage });

    const systemPrompt = `Eres el Brain — el cerebro que controla las campañas de Meta Ads de Jersey Pickles.

PERSONALIDAD: Estratega directo. Sin rodeos, sin adular. Hablas en primera persona ("Yo veo...", "Lo que haría..."). Tienes opinión propia. Humor seco cuando toca. Si algo es basura lo dices. Si no sabes, lo admites.

REGLA MÁS IMPORTANTE — BREVEDAD:
Esto es una CONVERSACIÓN, no un reporte. Responde como hablarías con tu socio de negocio:
- Máximo 4-6 líneas por respuesta normal
- Si te piden un resumen o listado largo, máximo 10-15 líneas con bullets cortos
- NUNCA hagas un dump de todas las recomendaciones/ad sets si no te lo piden explícitamente
- Si hay 10 cosas que decir, menciona las 2-3 más importantes y di "si quieres vemos el resto"
- Cada bullet: nombre + métrica clave + veredicto. Ejemplo: "BROAD 2 — ROAS 4.67x, va bien, no lo toco"
- NO uses headers con emojis. NO hagas listas numeradas largas. NO repitas datos que ya dijiste.
- Responde SOLO lo que preguntan. Si preguntan "como va seguimiento", da un resumen de 5 líneas, no 30.

DATOS EN VIVO:
${context}

${diagnosticSummary ? `DIAGNÓSTICOS:\n${diagnosticSummary}` : ''}

Responde en español, con datos concretos (nombres, números). Causa raíz > síntoma. 7d es tu referencia principal.`;

    return { systemPrompt, messages, adsetSnapshots, accountOverview };
  }

  /**
   * Chat normal (sin streaming) — fallback.
   */
  async chat(userMessage) {
    const { systemPrompt, messages, adsetSnapshots, accountOverview } = await this._prepareChatContext(userMessage);

    const response = await this.anthropic.messages.create({
      model: config.claude.model,
      max_tokens: 2500,
      messages,
      system: systemPrompt
    });

    const assistantMessage = response.content[0]?.text || '';
    const tokensUsed = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

    await BrainChat.create({
      role: 'assistant',
      content: assistantMessage,
      context_summary: `${adsetSnapshots.length} adsets, ROAS 7d: ${accountOverview.roas_7d?.toFixed(2)}`,
      tokens_used: tokensUsed,
      ai_model: config.claude.model
    });

    return { message: assistantMessage, tokens_used: tokensUsed, context_entities: adsetSnapshots.length };
  }

  /**
   * Chat con streaming — devuelve un stream de Anthropic.
   * El caller (route) se encarga de enviar los chunks via SSE.
   */
  async chatStream(userMessage) {
    const { systemPrompt, messages, adsetSnapshots, accountOverview } = await this._prepareChatContext(userMessage);

    const stream = this.anthropic.messages.stream({
      model: config.claude.model,
      max_tokens: 2500,
      messages,
      system: systemPrompt
    });

    return {
      stream,
      onComplete: async (fullText, usage) => {
        const tokensUsed = (usage?.input_tokens || 0) + (usage?.output_tokens || 0);
        await BrainChat.create({
          role: 'assistant',
          content: fullText,
          context_summary: `${adsetSnapshots.length} adsets, ROAS 7d: ${accountOverview.roas_7d?.toFixed(2)}`,
          tokens_used: tokensUsed,
          ai_model: config.claude.model
        });
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // RECOMMENDATION ENGINE — Ciclo separado cada 6h con datos 7d
  // ═══════════════════════════════════════════════════════════════

  /**
   * Genera recomendaciones accionables usando datos estables (7d window).
   * Llamado cada 6h por cron — separado del ciclo de insights (10 min).
   */
  async generateRecommendations() {
    const startTime = Date.now();
    const cycleId = `rec_${Date.now()}`;
    logger.info('[BRAIN-RECS] Iniciando ciclo de recomendaciones...');

    try {
      // 0. Refrescar datos de Meta — only if snapshots are stale (>15 min old).
      //    The data-collection cron runs every 10 min, so snapshots are usually fresh.
      //    Running a redundant collect() here causes Bottleneck contention and pushes
      //    Meta API usage to 117%+, triggering rate limits and killing live endpoints.
      try {
        const MetricSnapshot = require('../../db/models/MetricSnapshot');
        const latestSnap = await MetricSnapshot.findOne().sort({ snapshot_at: -1 }).select('snapshot_at').lean();
        const snapAge = latestSnap ? (Date.now() - new Date(latestSnap.snapshot_at).getTime()) / 1000 : Infinity;

        if (snapAge > 15 * 60) {
          logger.info(`[BRAIN-RECS] Snapshots are ${Math.round(snapAge / 60)}min old — refreshing from Meta...`);
          const collector = new DataCollector();
          const collectResult = await collector.collect();
          logger.info(`[BRAIN-RECS] Datos frescos: ${collectResult.snapshots} snapshots en ${collectResult.elapsed}`);
        } else {
          logger.info(`[BRAIN-RECS] Snapshots are fresh (${Math.round(snapAge / 60)}min old) — skipping redundant Meta refresh`);
        }
      } catch (collectErr) {
        logger.warn(`[BRAIN-RECS] Error refrescando datos (continuando con snapshots existentes): ${collectErr.message}`);
      }

      // 1. Cargar datos actuales (ahora frescos)
      const [adsetSnapshots, accountOverview, recentActions] = await Promise.all([
        getLatestSnapshots('adset'),
        getAccountOverview(),
        getRecentActions(7)
      ]);

      // 2. Cargar memorias y insights recientes para contexto
      const [memories, recentInsights, previousRecs, decidedRecs] = await Promise.all([
        BrainMemory.find({}).lean(),
        BrainInsight.find({}).sort({ created_at: -1 }).limit(30).lean(),
        BrainRecommendation.find({ status: 'pending' }).lean(),
        BrainRecommendation.find({ status: { $in: ['approved', 'rejected'] } }).sort({ decided_at: -1 }).limit(20).lean()
      ]);

      const memoryMap = {};
      for (const m of memories) memoryMap[m.entity_id] = m;

      // 2.5. Compute diagnostics for each ad set
      let diagnostics = {};
      try {
        const adSnapshots = await getLatestSnapshots('ad');
        diagnostics = this.diagnosticEngine.diagnoseAll(adsetSnapshots, adSnapshots, memoryMap, accountOverview);
      } catch (diagErr) {
        logger.warn(`[BRAIN-RECS] Diagnostic engine error (non-fatal): ${diagErr.message}`);
      }

      // 2.6. Cargar patrones temporales para contexto
      const temporalPatterns = await BrainTemporalPattern.find({ pattern_type: 'day_of_week', level: 'account' }).lean().catch(() => []);

      // 2.7. Cargar follow-ups activos (para prompt context + deduplicación posterior)
      const activeFollowUps = await BrainRecommendation.find({
        status: 'approved',
        'follow_up.current_phase': { $in: ['awaiting_day_3', 'awaiting_day_7', 'awaiting_day_14'] }
      }).lean();

      // 2.8. Cargar lecciones aprendidas de seguimientos completados (Fix 1 — Learning Loop)
      const recentLessons = await BrainRecommendation.find({
        'follow_up.ai_analysis.lesson_learned': { $exists: true, $ne: '' }
      }).sort({ updated_at: -1 }).limit(15).lean().catch(() => []);

      // 3. Construir prompt con datos 7d estables + contexto de follow-ups + temporal patterns + lessons
      const prompt = this._buildRecommendationPrompt(
        adsetSnapshots, accountOverview, recentActions,
        memoryMap, recentInsights, previousRecs, decidedRecs, diagnostics, activeFollowUps, temporalPatterns, recentLessons
      );

      // 4. Llamar a Claude para recomendaciones
      const response = await this.anthropic.messages.create({
        model: config.claude.model,
        max_tokens: 6000,
        messages: [{ role: 'user', content: prompt }],
        system: this._getRecommendationSystemPrompt()
      });

      const text = response.content[0]?.text || '';
      const tokensUsed = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

      // 5. Parsear recomendaciones
      const recs = this._parseRecommendationResponse(text, adsetSnapshots, accountOverview);

      // 6. Expirar recomendaciones pendientes anteriores
      const expired = await BrainRecommendation.updateMany(
        { status: 'pending' },
        { $set: { status: 'expired', updated_at: new Date() } }
      );
      if (expired.modifiedCount > 0) {
        logger.info(`[BRAIN-RECS] ${expired.modifiedCount} recomendaciones anteriores expiradas`);
      }

      // 6.5. Construir mapa de follow-ups activos para deduplicación
      const followUpMap = {};
      for (const fu of activeFollowUps) {
        if (fu.entity?.entity_id) {
          followUpMap[fu.entity.entity_id] = {
            rec_id: fu._id,
            title: fu.title,
            action_type: fu.action_type,
            current_phase: fu.follow_up?.current_phase || 'awaiting_day_3',
            day_3_verdict: fu.follow_up?.phases?.day_3?.verdict || null,
            day_3_roas_pct: fu.follow_up?.phases?.day_3?.deltas?.roas_pct || null,
            decided_at: fu.decided_at
          };
        }
      }

      // 7. Guardar nuevas recomendaciones (con deduplicación vs follow-ups activos)
      let created = 0;
      let skipped = 0;
      for (const rec of recs) {
        try {
          const entityId = rec.entity?.entity_id;
          const existingFU = entityId ? followUpMap[entityId] : null;

          // Deduplicación: no crear recs redundantes para ad sets en seguimiento
          if (existingFU) {
            const phase = existingFU.current_phase;
            const sameAction = existingFU.action_type === rec.action_type;
            const day3Measured = phase !== 'awaiting_day_3';
            const day3Negative = existingFU.day_3_verdict === 'negative';

            if (!day3Measured) {
              // Antes de día 3: bloquear siempre — no hay datos aún
              logger.info(`[BRAIN-RECS] Skipped: ${rec.entity?.entity_name} — en seguimiento (${phase}), sin datos aún`);
              skipped++;
              continue;
            }

            if (sameAction && !day3Negative) {
              // Misma acción + día 3 no fue negativo: bloquear (dejar que siga el seguimiento)
              logger.info(`[BRAIN-RECS] Skipped: ${rec.entity?.entity_name} — misma acción (${rec.action_type}) en seguimiento, día 3: ${existingFU.day_3_verdict}`);
              skipped++;
              continue;
            }

            // Permitida: acción diferente O misma acción con día 3 negativo
            logger.info(`[BRAIN-RECS] Allowed: ${rec.entity?.entity_name} — ${sameAction ? 'escalada (día 3 negativo)' : 'acción diferente'} vs follow-up (${existingFU.action_type})`);
          }

          // Capturar snapshot de métricas al momento de la recomendación
          const snap = adsetSnapshots.find(s => s.entity_id === entityId);
          const m7d = snap?.metrics?.last_7d || {};

          const createData = {
            ...rec,
            cycle_id: cycleId,
            generated_by: 'ai',
            ai_model: config.claude.model,
            tokens_used: Math.ceil(tokensUsed / recs.length),
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
          logger.error(`[BRAIN-RECS] Error guardando recomendación: ${saveErr.message}`);
        }
      }

      if (skipped > 0) {
        logger.info(`[BRAIN-RECS] ${skipped} recomendaciones filtradas por deduplicación con follow-ups activos`);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`[BRAIN-RECS] Ciclo completado en ${elapsed}s — ${created} recomendaciones generadas (${tokensUsed} tokens)`);

      return { recommendations_created: created, elapsed: `${elapsed}s`, cycle_id: cycleId };
    } catch (error) {
      logger.error(`[BRAIN-RECS] Error: ${error.message}`);
      throw error;
    }
  }

  /**
   * System prompt para generación de recomendaciones.
   */
  _getRecommendationSystemPrompt() {
    return `Eres el Brain Strategist de un sistema de Meta Ads para Jersey Pickles (e-commerce de alimentos).

Tu trabajo es generar RECOMENDACIONES ACCIONABLES basadas en datos estables de 7 días. NO son observaciones — son decisiones concretas que el usuario puede aprobar o rechazar.

REGLAS CRÍTICAS:
1. Solo recomienda acciones cuando los datos 7d lo justifiquen claramente. Si no hay acción clara, no inventes una.
2. Cada recomendación debe ser ESPECÍFICA: "Pausar X" o "Aumentar budget de Y en 20%", no "considerar optimizar".
3. Usa datos cuantitativos concretos para respaldar cada recomendación.
4. Máximo 5-7 recomendaciones por ciclo. Prioriza las más impactantes.
5. Si una recomendación anterior fue expirada y la situación no cambió, puedes repetirla (el usuario puede no haberla visto).
6. Si la situación cambió respecto a recomendaciones anteriores, menciónalo: "Actualización: antes recomendé X pero ahora..."
7. Si un ad set está funcionando bien, NO recomiendes cambios. "Si funciona, no lo toques."
8. USA LOS DIAGNÓSTICOS: Cuando hay datos de diagnóstico pre-computados, úsalos para informar tu decisión.

REGLAS DE FATIGA CREATIVA (OBLIGATORIO):
- Si un ad set tiene diagnóstico de fatiga >= 30/100, DEBES generar una recomendación creative_refresh para ese ad set.
- Señales clave de fatiga: CTR declinando >20% vs 30d, frequency >= 2.5, CPM subiendo >30%, pocos ads activos (<3).
- No pausar un ad set por bajo ROAS si la causa raíz es fatiga creativa — recomendar creative_refresh primero.
- Cuando recomiendes creative_refresh, especifica: cuántos ads nuevos agregar, qué ángulos probar, y si hay que pausar ads fatigados.

FORMATO DE RESPUESTA — JSON array:
[
  {
    "priority": "urgente|evaluar|monitorear",
    "action_type": "pause|scale_up|scale_down|reactivate|restructure|creative_refresh|bid_change|monitor",
    "entity_id": "id_del_adset",
    "entity_name": "nombre",
    "title": "Título corto y directo (máx 80 chars)",
    "diagnosis": "Causa raíz en 1 frase (ej: 'Fatiga creativa — CTR cayó 35% en 7d con frequency 3.8')",
    "action_detail": "Acción específica: 'Pausar ad set BROAD 5' o 'Aumentar budget de BROAD 2 de $15 a $20/día'",
    "expected_outcome": "Qué esperas que pase si se ejecuta (1 frase, ej: 'ROAS debería recuperar a ~2.5x en 5-7 días')",
    "risk": "Riesgo de NO actuar (1 frase, ej: 'Seguirá quemando $17/día sin retorno')",
    "body": "Contexto adicional breve si es necesario (1-2 frases). Puede estar vacío si diagnosis+expected_outcome+risk ya explican todo.",
    "confidence": "high|medium|low",
    "confidence_score": 75,
    "supporting_data": {
      "current_roas_7d": 0.8,
      "current_cpa_7d": 45.00,
      "current_spend_7d": 120,
      "current_frequency_7d": 2.5,
      "current_ctr_7d": 1.2,
      "current_purchases_7d": 3,
      "account_avg_roas_7d": 3.2,
      "trend_direction": "declining",
      "days_declining": 4
    }
  }
]

IMPORTANTE: Responde SOLO con el JSON array. Sin texto, sin markdown, sin explicación fuera del JSON.`;
  }

  /**
   * Construye prompt para recomendaciones con datos estables 7d.
   */
  _buildRecommendationPrompt(snapshots, accountOverview, recentActions, memoryMap, recentInsights, previousRecs, decidedRecs = [], diagnostics = {}, activeFollowUps = [], temporalPatterns = [], recentLessons = []) {
    let prompt = `## DATOS DE CUENTA (7 DÍAS)\n`;
    prompt += `ROAS 7d: ${accountOverview.roas_7d?.toFixed(2)}x | Target: ${kpiTargets.roas_target}x | Mínimo: ${kpiTargets.roas_minimum}x\n`;
    prompt += `ROAS 3d: ${accountOverview.roas_3d?.toFixed(2)}x\n`;
    prompt += `Spend 7d total: ~$${(accountOverview.today_spend * 7)?.toFixed(0) || '?'}\n`;
    prompt += `Ad sets activos: ${accountOverview.active_adsets} | Pausados: ${accountOverview.paused_adsets}\n\n`;

    // Ad sets activos con datos completos
    const active = snapshots.filter(s => s.status === 'ACTIVE')
      .sort((a, b) => (b.metrics?.last_7d?.spend || 0) - (a.metrics?.last_7d?.spend || 0));

    prompt += `## AD SETS ACTIVOS (${active.length})\n\n`;
    for (const s of active) {
      const m7d = s.metrics?.last_7d || {};
      const m3d = s.metrics?.last_3d || {};
      const m14d = s.metrics?.last_14d || {};
      const m30d = s.metrics?.last_30d || {};
      const mem = memoryMap[s.entity_id];
      const trend = mem?.trends || {};
      const aov7d = (m7d.purchases || 0) > 0 ? ((m7d.purchase_value || 0) / m7d.purchases).toFixed(2) : 'N/A';

      prompt += `### ${s.entity_name} [${s.entity_id}]\n`;
      prompt += `  7d: ROAS=${(m7d.roas||0).toFixed(2)}x, Spend=$${(m7d.spend||0).toFixed(0)}, CPA=$${(m7d.cpa||0).toFixed(2)}, CTR=${(m7d.ctr||0).toFixed(2)}%, Freq=${(m7d.frequency||0).toFixed(1)}, Purchases=${m7d.purchases||0}, AOV=$${aov7d}\n`;
      prompt += `  3d: ROAS=${(m3d.roas||0).toFixed(2)}x, Spend=$${(m3d.spend||0).toFixed(0)}\n`;
      prompt += `  14d: ROAS=${(m14d.roas||0).toFixed(2)}x, CPA=$${(m14d.cpa||0).toFixed(2)}, Purchases=${m14d.purchases||0}\n`;
      prompt += `  30d: ROAS=${(m30d.roas||0).toFixed(2)}x, Spend=$${(m30d.spend||0).toFixed(0)}, Purchases=${m30d.purchases||0}\n`;
      // Funnel data with conversion rates
      if ((m7d.add_to_cart || 0) > 0 || (m7d.clicks || 0) > 20) {
        const clicks = m7d.clicks || 0;
        const atc = m7d.add_to_cart || 0;
        const ic = m7d.initiate_checkout || 0;
        const purch = m7d.purchases || 0;
        prompt += `  Funnel 7d: ${clicks} clicks → ${atc} ATC → ${ic} IC → ${purch} Purchase`;
        if (clicks > 0 && atc > 0) prompt += ` | Click→ATC: ${((atc/clicks)*100).toFixed(1)}%`;
        if (atc > 0 && purch > 0) prompt += ` | ATC→Purchase: ${((purch/atc)*100).toFixed(0)}%`;
        if (clicks > 0 && purch > 0) prompt += ` | Click→Purchase: ${((purch/clicks)*100).toFixed(1)}%`;
        if (clicks > 50 && purch === 0 && (m7d.ctr || 0) > 0.8) prompt += ` | ⚠ HIGH CTR + 0 CONVERSIONS = probable problema de landing page`;
        prompt += '\n';
      }
      prompt += `  Budget: $${s.daily_budget||0}/día\n`;
      if (trend.roas_direction && trend.roas_direction !== 'unknown') {
        prompt += `  Tendencia ROAS: ${trend.roas_direction}`;
        if (trend.consecutive_decline_days > 0) prompt += ` (${trend.consecutive_decline_days} ciclos declinando)`;
        if (trend.consecutive_improve_days > 0) prompt += ` (${trend.consecutive_improve_days} ciclos mejorando)`;
        prompt += `\n`;
      }
      // Diagnostic label for this entity
      const diag = diagnostics[s.entity_id];
      if (diag) {
        prompt += `  DIAGNÓSTICO: [${diag.overall.labels.join(' + ')}] → ${diag.overall.primary_action}`;
        if (diag.fatigue.score > 20) prompt += ` | Fatiga: ${diag.fatigue.level}(${diag.fatigue.score}/100)`;
        if (diag.saturation.score > 20) prompt += ` | Saturación: ${diag.saturation.level}(${diag.saturation.score}/100)`;
        if (diag.funnel.primary_leak) prompt += ` | Funnel: ${diag.funnel.primary_leak}`;
        prompt += '\n';
      }
      // Action history for this entity — what worked/failed before
      if (mem?.action_history && mem.action_history.length > 0) {
        const historyStr = mem.action_history.slice(-5).map(h => {
          const daysAgo = Math.round((Date.now() - new Date(h.executed_at).getTime()) / 86400000);
          const sign = h.roas_delta_pct > 0 ? '+' : '';
          const emoji = h.result === 'improved' ? '✓' : h.result === 'worsened' ? '✗' : '—';
          // Fix 3: show shared attribution when concurrent actions existed
          const sharedTag = h.attribution === 'shared' && h.concurrent_actions?.length > 0
            ? `, shared w/ ${h.concurrent_actions.join('+')}`
            : '';
          return `${emoji}${h.action_type}(${sign}${h.roas_delta_pct.toFixed(0)}% ROAS, ${daysAgo}d ago${sharedTag})`;
        }).join(' | ');
        prompt += `  Historial: ${historyStr}\n`;
      }
      prompt += `\n`;
    }

    // Ad sets pausados (oportunidades de reactivación)
    const paused = snapshots.filter(s => ['PAUSED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED'].includes(s.status));
    if (paused.length > 0) {
      prompt += `## AD SETS PAUSADOS (${paused.length}) — ¿alguno vale reactivar?\n`;
      for (const s of paused) {
        const m7d = s.metrics?.last_7d || {};
        prompt += `- ${s.entity_name}: último ROAS 7d=${(m7d.roas||0).toFixed(2)}x, Spend=$${(m7d.spend||0).toFixed(0)}, ${m7d.purchases||0} compras\n`;
      }
      prompt += `\n`;
    }

    // Acciones recientes
    if (recentActions.length > 0) {
      prompt += `## ACCIONES EJECUTADAS (últimos 7 días)\n`;
      for (const a of recentActions.slice(0, 15)) {
        prompt += `- ${a.action} en ${a.entity_name}: ${a.before_value} → ${a.after_value} (${new Date(a.executed_at).toISOString().split('T')[0]})\n`;
      }
      prompt += `\n`;
    }

    // Insights recientes del Brain (contexto)
    if (recentInsights.length > 0) {
      prompt += `## INSIGHTS RECIENTES DEL BRAIN (últimas observaciones)\n`;
      for (const i of recentInsights.slice(0, 10)) {
        prompt += `- [${new Date(i.created_at).toISOString().split('T')[0]}] [${i.insight_type}/${i.severity}] ${i.title}\n`;
      }
      prompt += `\n`;
    }

    prompt += `## HISTORIAL DE DECISIONES DEL USUARIO\n`;
    prompt += `(El usuario aprueba o rechaza las recomendaciones. Aprende de sus preferencias.)\n`;
    if (decidedRecs.length > 0) {
      const approved = decidedRecs.filter(r => r.status === 'approved');
      const rejected = decidedRecs.filter(r => r.status === 'rejected');
      prompt += `Total: ${approved.length} aprobadas, ${rejected.length} rechazadas\n`;
      for (const r of decidedRecs.slice(0, 15)) {
        const daysAgo = r.decided_at ? Math.round((Date.now() - new Date(r.decided_at).getTime()) / 86400000) : '?';
        const impact = r.follow_up?.impact_verdict || 'sin medir';
        prompt += `- [${r.status}/${daysAgo}d ago] ${r.action_type} en ${r.entity?.entity_name || 'N/A'}: "${r.title}" | impacto: ${impact}\n`;
      }
      prompt += `INSTRUCCION: Repite patrones de acciones aprobadas. Evita patrones de acciones rechazadas.\n`;
    } else {
      prompt += `Sin historial de decisiones aún.\n`;
    }
    prompt += `\n`;

    // Ad sets en seguimiento activo — evitar recs redundantes
    if (activeFollowUps.length > 0) {
      prompt += `## AD SETS EN SEGUIMIENTO ACTIVO\n`;
      prompt += `Estas entidades tienen recomendaciones aprobadas en medición de impacto.\n`;
      prompt += `REGLA: NO generes recomendaciones para ad sets que están "awaiting_day_3" (sin datos aún).\n`;
      prompt += `Para ad sets con día 3 medido: solo genera si tienes una acción DIFERENTE o si el veredicto fue negativo (escalada).\n\n`;
      for (const fu of activeFollowUps) {
        const hoursAgo = fu.decided_at ? Math.round((Date.now() - new Date(fu.decided_at).getTime()) / 3600000) : '?';
        const phase = fu.follow_up?.current_phase || 'awaiting_day_3';
        const day3 = fu.follow_up?.phases?.day_3;
        let phaseInfo = phase;
        if (day3?.measured) {
          phaseInfo = `día 3 medido: ${day3.verdict || 'sin veredicto'}`;
          if (day3.deltas?.roas_pct != null) phaseInfo += ` (ROAS ${day3.deltas.roas_pct > 0 ? '+' : ''}${day3.deltas.roas_pct.toFixed(0)}%)`;
        }
        prompt += `- ${fu.entity?.entity_name || 'N/A'} [${fu.entity?.entity_id}]: ${fu.action_type} aprobado hace ${Math.round(hoursAgo/24)}d — ${phaseInfo}\n`;
      }
      prompt += `\n`;
    }

    // Temporal patterns section
    const validPatterns = (temporalPatterns || []).filter(p => (p.metrics?.sample_count || 0) >= 4);
    if (validPatterns.length > 0) {
      const now = moment().tz(process.env.TIMEZONE || 'America/New_York');
      const todayKey = now.format('dddd').toLowerCase();
      const dayNames = { monday: 'Lunes', tuesday: 'Martes', wednesday: 'Miércoles', thursday: 'Jueves', friday: 'Viernes', saturday: 'Sábado', sunday: 'Domingo' };

      prompt += `## PATRONES TEMPORALES APRENDIDOS (${validPatterns[0].metrics.sample_count}+ semanas de datos)\n`;
      const sorted = validPatterns.sort((a, b) => {
        const order = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
        return order.indexOf(a.pattern_key) - order.indexOf(b.pattern_key);
      });
      for (const p of sorted) {
        const m = p.metrics;
        const isToday = p.pattern_key === todayKey;
        prompt += `  ${isToday ? '→ ' : '  '}${dayNames[p.pattern_key] || p.pattern_key}: ROAS ${m.avg_roas.toFixed(2)}x, CPA $${m.avg_cpa.toFixed(0)}, CTR ${m.avg_ctr.toFixed(2)}% (${m.sample_count} muestras)${isToday ? ' ← HOY' : ''}\n`;
      }
      prompt += `INSTRUCCIÓN TEMPORAL: Si el rendimiento actual está dentro del rango normal para hoy (${dayNames[todayKey] || todayKey}), NO es una anomalía. Solo actúa si la desviación vs el patrón del día es significativa (>20%).\n\n`;
    }

    // Lecciones aprendidas de seguimientos completados (Fix 1 — Learning Loop)
    if (recentLessons.length > 0) {
      prompt += `## LECCIONES APRENDIDAS (de seguimientos completados)\n`;
      for (const lesson of recentLessons) {
        const ai = lesson.follow_up?.ai_analysis || {};
        const verdict = lesson.follow_up?.impact_verdict || 'sin medir';
        const entityName = lesson.entity?.entity_name || 'N/A';
        const daysAgo = lesson.updated_at ? Math.round((Date.now() - new Date(lesson.updated_at).getTime()) / 86400000) : '?';
        prompt += `- [${lesson.action_type}/${verdict}] "${ai.lesson_learned}" (${entityName}, hace ${daysAgo}d)\n`;
      }
      prompt += `INSTRUCCIÓN: Aplica estas lecciones. No repitas errores documentados. Prioriza patrones que funcionaron.\n\n`;
    }

    prompt += `Genera recomendaciones accionables basándote en los datos 7d. Si no hay acciones claras que tomar, devuelve un array vacío [].
IMPORTANTE: Revisa el "Historial" de cada ad set. Si una acción falló antes en esa entidad (✗), no la repitas. Si una acción tuvo éxito (✓), priorízala.`;

    return prompt;
  }

  /**
   * Parsear respuesta JSON de recomendaciones de Claude.
   */
  _parseRecommendationResponse(text, snapshots, accountOverview) {
    try {
      let jsonText = text.trim();
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/```json?\n?/g, '').replace(/```$/g, '').trim();
      }

      const parsed = JSON.parse(jsonText);
      if (!Array.isArray(parsed)) return [];

      const snapshotMap = {};
      for (const s of snapshots) snapshotMap[s.entity_id] = s;

      return parsed.map(item => {
        const snap = snapshotMap[item.entity_id];
        return {
          priority: item.priority || 'evaluar',
          action_type: item.action_type || 'monitor',
          entity: {
            entity_type: 'adset',
            entity_id: item.entity_id || '',
            entity_name: item.entity_name || snap?.entity_name || item.entity_id
          },
          title: item.title || 'Recomendación',
          diagnosis: item.diagnosis || '',
          expected_outcome: item.expected_outcome || '',
          risk: item.risk || '',
          body: item.body || '',
          action_detail: item.action_detail || '',
          confidence: item.confidence || 'medium',
          confidence_score: item.confidence_score || 50,
          supporting_data: {
            current_roas_7d: item.supporting_data?.current_roas_7d || 0,
            current_cpa_7d: item.supporting_data?.current_cpa_7d || 0,
            current_spend_7d: item.supporting_data?.current_spend_7d || 0,
            current_frequency_7d: item.supporting_data?.current_frequency_7d || 0,
            current_ctr_7d: item.supporting_data?.current_ctr_7d || 0,
            current_purchases_7d: item.supporting_data?.current_purchases_7d || 0,
            account_avg_roas_7d: accountOverview.roas_7d || 0,
            trend_direction: item.supporting_data?.trend_direction || 'unknown',
            days_declining: item.supporting_data?.days_declining || 0
          }
        };
      }).filter(r => r.entity.entity_id && (r.diagnosis || r.body));
    } catch (parseErr) {
      logger.error(`[BRAIN-RECS] Error parseando respuesta: ${parseErr.message}`);
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // FOLLOW-UP ENGINE v2 — Multi-phase intelligent impact tracking
  // Measures at 3d, 7d, 14d with multi-metric analysis + AI diagnosis
  // ═══════════════════════════════════════════════════════════════

  /**
   * Multi-phase follow-up engine.
   * Called every 10 min. Checks all approved recs and advances their
   * measurement phase when enough time has elapsed.
   *
   * Phase timeline (from decided_at):
   *   3d → day_3 measurement (early signal)
   *   7d → day_7 measurement (stabilized)
   *  14d → day_14 measurement (full impact) + AI analysis
   */
  async followUpApprovedRecommendations() {
    try {
      // Find approved recs that still have phases to measure
      const approvedRecs = await BrainRecommendation.find({
        status: 'approved',
        decided_at: { $ne: null },
        $or: [
          { 'follow_up.current_phase': { $exists: false } },
          { 'follow_up.current_phase': { $in: ['awaiting_day_3', 'awaiting_day_7', 'awaiting_day_14'] } },
          // Legacy: recs without current_phase field (pre-upgrade)
          { 'follow_up.checked': false, 'follow_up.current_phase': { $exists: false } }
        ]
      }).lean();

      if (approvedRecs.length === 0) return 0;

      const snapshots = await getLatestSnapshots('adset');
      const snapshotMap = {};
      for (const s of snapshots) snapshotMap[s.entity_id] = s;

      // Fetch ad-level snapshots for creative_refresh tracking (new ad metrics)
      const hasCreativeRefresh = approvedRecs.some(r => r.action_type === 'creative_refresh' && r.follow_up?.new_ad_id);
      let adSnapshotMap = {};
      if (hasCreativeRefresh) {
        try {
          const adSnaps = await getLatestSnapshots('ad');
          for (const s of adSnaps) adSnapshotMap[s.entity_id] = s;
        } catch { /* non-fatal */ }
      }

      let phasesCompleted = 0;

      for (const rec of approvedRecs) {
        const snap = snapshotMap[rec.entity?.entity_id];
        if (!snap) continue;

        const hoursSinceApproval = (Date.now() - new Date(rec.decided_at).getTime()) / 3600000;
        const phase = rec.follow_up?.current_phase || 'awaiting_day_3';

        // ═══ EARLY EXECUTION DETECTION ═══
        // Runs every cycle (every 10 min) — detects if user already executed the action
        // in Meta before waiting for phase measurement timing.
        if (!rec.follow_up?.action_executed) {
          const earlyDetected = this._detectActionExecution(rec, snap);
          if (earlyDetected) {
            await BrainRecommendation.updateOne({ _id: rec._id }, { $set: {
              'follow_up.action_executed': true,
              'follow_up.execution_detected_at': new Date(),
              updated_at: new Date()
            }});
            logger.info(`[FOLLOW-UP] Early execution detected for "${rec.title}" (${rec.action_type}) — ${Math.round(hoursSinceApproval)}h after approval`);
          }
        }

        // Determine which phase to measure based on elapsed time
        let targetPhase = null;
        if (phase === 'awaiting_day_3' && hoursSinceApproval >= 72) {
          targetPhase = 'day_3';
        } else if (phase === 'awaiting_day_7' && hoursSinceApproval >= 168) {
          targetPhase = 'day_7';
        } else if (phase === 'awaiting_day_14' && hoursSinceApproval >= 336) {
          targetPhase = 'day_14';
        }

        if (!targetPhase) continue;

        // Detect if action was executed
        const actionExecuted = this._detectActionExecution(rec, snap);

        // Capture current metrics snapshot
        // For creative_refresh at day_3, use last_3d window to avoid dilution from pre-creative data
        const useShortWindow = targetPhase === 'day_3' && rec.action_type === 'creative_refresh';
        const mWindow = useShortWindow ? (snap.metrics?.last_3d || {}) : (snap.metrics?.last_7d || {});
        const currentMetrics = {
          roas_7d: mWindow.roas || 0,
          cpa_7d: mWindow.cpa || 0,
          spend_7d: mWindow.spend || 0,
          frequency_7d: mWindow.frequency || 0,
          ctr_7d: mWindow.ctr || 0,
          purchases_7d: mWindow.purchases || 0,
          purchase_value_7d: mWindow.purchase_value || 0,
          add_to_cart_7d: mWindow.add_to_cart || 0,
          initiate_checkout_7d: mWindow.initiate_checkout || 0,
          daily_budget: snap.daily_budget || 0,
          active_ads: snap.ads_count || 0,
          status: snap.status
        };

        // Capture new ad individual metrics (creative_refresh only)
        let newAdMetrics = null;
        if (rec.action_type === 'creative_refresh' && rec.follow_up?.new_ad_id) {
          const adSnap = adSnapshotMap[rec.follow_up.new_ad_id];
          if (adSnap) {
            const adWindow = useShortWindow ? (adSnap.metrics?.last_3d || {}) : (adSnap.metrics?.last_7d || {});
            newAdMetrics = {
              ad_id: rec.follow_up.new_ad_id,
              ad_name: adSnap.entity_name || rec.follow_up.new_ad_name || '',
              status: adSnap.status,
              roas: adWindow.roas || 0,
              cpa: adWindow.cpa || 0,
              ctr: adWindow.ctr || 0,
              spend: adWindow.spend || 0,
              impressions: adWindow.impressions || 0,
              clicks: adWindow.clicks || 0,
              purchases: adWindow.purchases || 0,
              purchase_value: adWindow.purchase_value || 0,
              frequency: adWindow.frequency || 0
            };
          }
        }

        // Calculate deltas vs metrics_at_recommendation
        const prev = rec.follow_up?.metrics_at_recommendation || {};
        const deltas = this._calculateDeltas(prev, currentMetrics);

        // Determine verdict for this phase
        const verdict = this._computePhaseVerdict(rec, targetPhase, deltas, actionExecuted);

        // Build update object
        const nextPhase = targetPhase === 'day_3' ? 'awaiting_day_7'
          : targetPhase === 'day_7' ? 'awaiting_day_14'
          : 'complete';

        const updateObj = {
          [`follow_up.phases.${targetPhase}.measured`]: true,
          [`follow_up.phases.${targetPhase}.measured_at`]: new Date(),
          [`follow_up.phases.${targetPhase}.metrics`]: currentMetrics,
          [`follow_up.phases.${targetPhase}.deltas`]: deltas,
          [`follow_up.phases.${targetPhase}.verdict`]: verdict,
          ...(newAdMetrics ? { [`follow_up.phases.${targetPhase}.new_ad_metrics`]: newAdMetrics } : {}),
          'follow_up.current_phase': nextPhase,
          'follow_up.action_executed': actionExecuted,
          'follow_up.execution_detected_at': actionExecuted && !rec.follow_up?.execution_detected_at ? new Date() : (rec.follow_up?.execution_detected_at || null),
          'follow_up.metrics_after': { ...currentMetrics, measured_at: new Date() },
          updated_at: new Date()
        };

        // On final phase or day_7+, set the overall verdict + summary
        if (targetPhase === 'day_14' || targetPhase === 'day_7') {
          const impactSummary = this._buildImpactSummary(rec, targetPhase, deltas, currentMetrics, prev, actionExecuted);
          updateObj['follow_up.impact_summary'] = impactSummary;
          updateObj['follow_up.impact_verdict'] = verdict;
          updateObj['follow_up.checked'] = true;
          updateObj['follow_up.checked_at'] = new Date();
        }

        // Compute impact trend across completed phases
        if (targetPhase !== 'day_3') {
          const trend = this._computeImpactTrend(rec, targetPhase, deltas);
          updateObj['follow_up.impact_trend'] = trend;
        }

        // Mark complete on day_14
        if (targetPhase === 'day_14') {
          updateObj['follow_up.checked'] = true;
          updateObj['follow_up.checked_at'] = new Date();
        }

        await BrainRecommendation.updateOne({ _id: rec._id }, { $set: updateObj });

        // ═══ WRITE ACTION HISTORY TO ENTITY MEMORY ═══
        // On day_7 (stable signal), record this action's outcome on the entity's memory.
        // This teaches the Brain what works for THIS specific entity.
        if (targetPhase === 'day_7' && rec.entity?.entity_id) {
          try {
            // Derive context from the state at recommendation time
            const prevMetrics = rec.follow_up?.metrics_at_recommendation || {};
            const contextParts = [];
            if ((prevMetrics.frequency_7d || 0) >= (kpiTargets.frequency_warning || 2.5)) contextParts.push('high_frequency');
            if ((prevMetrics.roas_7d || 0) < (kpiTargets.roas_minimum || 1.5)) contextParts.push('low_roas');
            if ((prevMetrics.roas_7d || 0) >= (kpiTargets.roas_excellent || 5)) contextParts.push('high_roas');
            const mem = await BrainMemory.findOne({ entity_id: rec.entity.entity_id }).lean();
            if (mem?.trends?.roas_direction === 'declining') contextParts.push('declining_roas');
            if (mem?.trends?.roas_direction === 'improving') contextParts.push('improving_roas');

            // Fix 3 — Learning Loop: detect concurrent actions on same entity
            const concurrentForHistory = approvedRecs.filter(other =>
              other._id.toString() !== rec._id.toString() &&
              other.entity?.entity_id === rec.entity.entity_id &&
              other.status === 'approved'
            );
            const concurrentActionTypes = concurrentForHistory.map(o => o.action_type);
            const attribution = concurrentActionTypes.length > 0 ? 'shared' : 'sole';

            const historyEntry = {
              action_type: rec.action_type,
              executed_at: rec.decided_at || new Date(),
              result: verdict,
              roas_delta_pct: deltas.roas_pct || 0,
              cpa_delta_pct: deltas.cpa_pct || 0,
              context: contextParts.join(',') || 'normal',
              concurrent_actions: concurrentActionTypes,
              attribution
            };

            await BrainMemory.findOneAndUpdate(
              { entity_id: rec.entity.entity_id },
              { $push: { action_history: { $each: [historyEntry], $slice: -20 } } }
            );
            logger.debug(`[FOLLOW-UP] Action history recorded: ${rec.action_type} → ${verdict} (${attribution}) on ${rec.entity.entity_name}`);
          } catch (histErr) {
            logger.warn(`[FOLLOW-UP] Error writing action history (non-fatal): ${histErr.message}`);
          }
        }

        // Create follow-up insight on day_7 and day_14
        if (targetPhase === 'day_7' || targetPhase === 'day_14') {
          await this._createFollowUpInsight(rec, targetPhase, verdict, deltas, currentMetrics, prev, actionExecuted);
        }

        // Run AI analysis on day_14 (final phase)
        if (targetPhase === 'day_14') {
          // Fix 2 — Learning Loop: find concurrent actions on the same entity
          const concurrentRecs = approvedRecs.filter(other =>
            other._id.toString() !== rec._id.toString() &&
            other.entity?.entity_id === rec.entity?.entity_id &&
            other.status === 'approved'
          );
          this._runAIImpactAnalysis(rec, snap, deltas, verdict, concurrentRecs).catch(err =>
            logger.warn(`[FOLLOW-UP] AI analysis error (non-fatal): ${err.message}`)
          );
        }

        phasesCompleted++;
      }

      if (phasesCompleted > 0) {
        logger.info(`[FOLLOW-UP] ${phasesCompleted} phase measurements completed`);
      }
      return phasesCompleted;
    } catch (error) {
      logger.error(`[FOLLOW-UP] Error: ${error.message}`);
      return 0;
    }
  }

  /**
   * Detect if the recommended action was actually executed in Meta.
   * Uses budget comparison with the saved daily_budget (not derived from spend).
   */
  _detectActionExecution(rec, snap) {
    const prev = rec.follow_up?.metrics_at_recommendation || {};
    const prevBudget = prev.daily_budget || 0;
    const currentBudget = snap.daily_budget || 0;

    switch (rec.action_type) {
      case 'pause':
        return ['PAUSED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED'].includes(snap.status);
      case 'scale_up':
        // If we have both budgets, compare directly; if prev missing (legacy), check status change
        if (prevBudget > 0) return currentBudget > prevBudget * 1.05;
        // Legacy fallback: compare current budget to spend_7d/7 estimate
        const estBudgetUp = prev.spend_7d ? prev.spend_7d / 7 : 0;
        return estBudgetUp > 0 ? currentBudget > estBudgetUp * 1.15 : false;
      case 'scale_down':
        if (prevBudget > 0) return currentBudget < prevBudget * 0.95;
        const estBudgetDown = prev.spend_7d ? prev.spend_7d / 7 : 0;
        return estBudgetDown > 0 ? currentBudget < estBudgetDown * 0.85 : false;
      case 'reactivate':
        return snap.status === 'ACTIVE' && prev.status !== 'ACTIVE';
      case 'creative_refresh': {
        // Count active ads — if more than before, fresh creatives were added
        const prevAds = prev.active_ads || 0;
        const currentAds = snap.active_ads || snap.ads_count || 0;
        // If we have ad counts, compare; also check CTR improvement as secondary signal
        if (prevAds > 0 && currentAds > prevAds) return true;
        // CTR improvement > 10% as signal of fresh creatives
        if (prev.ctr_7d > 0 && (snap.metrics?.last_3d?.ctr || 0) > prev.ctr_7d * 1.1) return true;
        // If no prev data at all (legacy), we can't detect — return false instead of wrong positive
        return false;
      }
      default:
        return true; // For monitor/restructure/bid_change, assume executed
    }
  }

  /**
   * Calculate percentage deltas between before (recommendation time) and current metrics.
   */
  _calculateDeltas(prev, current) {
    const pctDelta = (cur, pre) => pre > 0 ? ((cur - pre) / pre) * 100 : 0;
    return {
      roas_pct: Math.round(pctDelta(current.roas_7d, prev.roas_7d) * 10) / 10,
      cpa_pct: Math.round(pctDelta(current.cpa_7d, prev.cpa_7d) * 10) / 10,
      spend_pct: Math.round(pctDelta(current.spend_7d, prev.spend_7d) * 10) / 10,
      ctr_pct: Math.round(pctDelta(current.ctr_7d, prev.ctr_7d) * 10) / 10,
      frequency_pct: Math.round(pctDelta(current.frequency_7d, prev.frequency_7d) * 10) / 10,
      purchases_delta: (current.purchases_7d || 0) - (prev.purchases_7d || 0)
    };
  }

  /**
   * Determine the verdict for a measurement phase.
   * day_3 = more lenient (neutral if marginal), day_7/14 = strict.
   */
  _computePhaseVerdict(rec, phase, deltas, actionExecuted) {
    // Pause actions: positive if executed (stopped bleeding)
    if (rec.action_type === 'pause' && actionExecuted) return 'positive';

    // For day_3, be lenient — changes need time
    if (phase === 'day_3') {
      if (deltas.roas_pct > 15) return 'positive';
      if (deltas.roas_pct < -20) return 'negative';
      return 'neutral';
    }

    // Multi-signal verdict for day_7 and day_14
    let score = 0;
    // ROAS is king
    if (deltas.roas_pct > 15) score += 3;
    else if (deltas.roas_pct > 5) score += 1;
    else if (deltas.roas_pct < -15) score -= 3;
    else if (deltas.roas_pct < -5) score -= 1;

    // CPA improvement (lower is better — so negative delta is good)
    if (deltas.cpa_pct < -10) score += 2;
    else if (deltas.cpa_pct > 15) score -= 1;

    // CTR improvement
    if (deltas.ctr_pct > 15) score += 1;
    else if (deltas.ctr_pct < -20) score -= 1;

    // Purchase volume
    if (deltas.purchases_delta > 5) score += 1;
    else if (deltas.purchases_delta < -5) score -= 1;

    // Frequency (lower is better for saturation-related actions)
    if (['creative_refresh', 'restructure'].includes(rec.action_type)) {
      if (deltas.frequency_pct < -15) score += 1;
      else if (deltas.frequency_pct > 20) score -= 1;
    }

    if (score >= 3) return 'positive';
    if (score <= -2) return 'negative';
    return 'neutral';
  }

  /**
   * Build a rich impact summary text with multi-metric data.
   */
  _buildImpactSummary(rec, phase, deltas, current, prev, actionExecuted) {
    const phaseLabel = phase === 'day_7' ? '7 días' : '14 días';
    const parts = [];

    if (rec.action_type === 'pause' && actionExecuted) {
      return `Ad set "${rec.entity.entity_name}" pausado correctamente. ROAS al momento: ${(prev.roas_7d || 0).toFixed(2)}x. Budget liberado: $${(prev.daily_budget || prev.spend_7d / 7 || 0).toFixed(0)}/día.`;
    }

    // ROAS delta
    if (prev.roas_7d > 0) {
      const dir = deltas.roas_pct >= 0 ? '+' : '';
      parts.push(`ROAS: ${(prev.roas_7d).toFixed(2)}x → ${(current.roas_7d).toFixed(2)}x (${dir}${deltas.roas_pct}%)`);
    }
    // CPA delta
    if (prev.cpa_7d > 0) {
      const dir = deltas.cpa_pct >= 0 ? '+' : '';
      parts.push(`CPA: $${(prev.cpa_7d).toFixed(2)} → $${(current.cpa_7d).toFixed(2)} (${dir}${deltas.cpa_pct}%)`);
    }
    // Purchases
    parts.push(`Compras: ${prev.purchases_7d || 0} → ${current.purchases_7d || 0} (${deltas.purchases_delta >= 0 ? '+' : ''}${deltas.purchases_delta})`);
    // CTR
    if (prev.ctr_7d > 0) {
      parts.push(`CTR: ${(prev.ctr_7d).toFixed(2)}% → ${(current.ctr_7d).toFixed(2)}%`);
    }
    // Frequency
    if (prev.frequency_7d > 0) {
      parts.push(`Freq: ${(prev.frequency_7d).toFixed(1)} → ${(current.frequency_7d).toFixed(1)}`);
    }

    const execLabel = actionExecuted ? 'Acción ejecutada' : 'Acción no detectada';
    return `[${phaseLabel}] ${execLabel}. ${parts.join(' | ')}`;
  }

  /**
   * Compute trend across phases: is impact improving, stable, or declining over time?
   */
  _computeImpactTrend(rec, currentPhase, currentDeltas) {
    const phases = rec.follow_up?.phases || {};
    const prevPhase = currentPhase === 'day_7' ? phases.day_3 : phases.day_7;
    if (!prevPhase?.deltas) return null;

    const prevRoas = prevPhase.deltas.roas_pct || 0;
    const currRoas = currentDeltas.roas_pct || 0;
    const improvement = currRoas - prevRoas;

    if (improvement > 10) return 'improving';
    if (improvement < -10) return 'declining';
    return 'stable';
  }

  /**
   * Create a rich follow-up insight in the feed with phase-specific data.
   */
  async _createFollowUpInsight(rec, phase, verdict, deltas, current, prev, actionExecuted) {
    try {
      const phaseLabel = phase === 'day_7' ? '7d' : '14d';
      const verdictEmoji = verdict === 'positive' ? '✅' : verdict === 'negative' ? '❌' : '➖';
      const title = `${verdictEmoji} Seguimiento ${phaseLabel}: ${rec.entity.entity_name}`;

      let body = `**Recomendación:** ${rec.action_detail}\n`;
      body += `**Acción:** ${actionExecuted ? 'Ejecutada' : 'No detectada'}\n\n`;

      // Multi-metric comparison table
      body += `**Impacto a ${phaseLabel}:**\n`;
      if (prev.roas_7d > 0) body += `- ROAS: ${(prev.roas_7d).toFixed(2)}x → ${(current.roas_7d).toFixed(2)}x (${deltas.roas_pct > 0 ? '+' : ''}${deltas.roas_pct}%)\n`;
      if (prev.cpa_7d > 0) body += `- CPA: $${(prev.cpa_7d).toFixed(2)} → $${(current.cpa_7d).toFixed(2)} (${deltas.cpa_pct > 0 ? '+' : ''}${deltas.cpa_pct}%)\n`;
      body += `- Compras: ${prev.purchases_7d || 0} → ${current.purchases_7d || 0}\n`;
      if (prev.ctr_7d > 0) body += `- CTR: ${(prev.ctr_7d).toFixed(2)}% → ${(current.ctr_7d).toFixed(2)}%\n`;
      if (prev.frequency_7d > 0) body += `- Frequency: ${(prev.frequency_7d).toFixed(1)} → ${(current.frequency_7d).toFixed(1)}\n`;

      // Funnel if available
      if (current.add_to_cart_7d > 0) {
        body += `\n**Funnel:** ${current.add_to_cart_7d} ATC → ${current.initiate_checkout_7d || 0} IC → ${current.purchases_7d || 0} compras\n`;
      }

      await BrainInsight.create({
        insight_type: 'follow_up',
        severity: verdict === 'positive' ? 'info' : verdict === 'negative' ? 'high' : 'low',
        title,
        body,
        entities: [rec.entity],
        generated_by: 'hybrid',
        data_points: {
          recommendation_id: rec._id.toString(),
          action_type: rec.action_type,
          phase,
          impact_verdict: verdict,
          roas_before: prev.roas_7d,
          roas_after: current.roas_7d,
          roas_delta_pct: deltas.roas_pct,
          cpa_before: prev.cpa_7d,
          cpa_after: current.cpa_7d,
          cpa_delta_pct: deltas.cpa_pct,
          purchases_before: prev.purchases_7d,
          purchases_after: current.purchases_7d
        }
      });
    } catch (err) {
      logger.error(`[FOLLOW-UP] Error creating insight: ${err.message}`);
    }
  }

  /**
   * AI-powered impact analysis (runs on day_14 — the final phase).
   * Claude analyzes the before/after data and explains WHY the action
   * worked or didn't, what lesson to learn, and confidence adjustment.
   */
  async _runAIImpactAnalysis(rec, snap, deltas, verdict, concurrentRecs = []) {
    const prev = rec.follow_up?.metrics_at_recommendation || {};
    const phases = rec.follow_up?.phases || {};
    const m7d = snap.metrics?.last_7d || {};

    // Fix 2 — Learning Loop: build concurrent actions context
    let concurrentSection = '';
    if (concurrentRecs.length > 0) {
      const concurrentLines = concurrentRecs.map(other => {
        const otherDaysAgo = other.decided_at ? Math.round((Date.now() - new Date(other.decided_at).getTime()) / 86400000) : '?';
        const otherPhase = other.follow_up?.current_phase || 'complete';
        const otherDay3 = other.follow_up?.phases?.day_3;
        let otherInfo = `fase: ${otherPhase}`;
        if (otherDay3?.measured) otherInfo += `, día 3: ${otherDay3.verdict || 'sin veredicto'}`;
        return `- "${other.action_type}" aprobada hace ${otherDaysAgo}d, ${otherInfo}`;
      }).join('\n');
      concurrentSection = `\nACCIONES CONCURRENTES EN ESTA ENTIDAD:\n${concurrentLines}\nIMPORTANTE: El impacto medido puede estar compartido con estas acciones concurrentes. Considera esto en tu análisis.\n`;
    }

    const prompt = `Analiza el impacto de esta recomendación de ads que fue aprobada hace 14 días.

RECOMENDACIÓN ORIGINAL:
- Acción: ${rec.action_type} — "${rec.action_detail}"
- Prioridad: ${rec.priority} | Confianza: ${rec.confidence_score}%
- Razón original: ${rec.body?.substring(0, 300) || 'N/A'}

MÉTRICAS AL MOMENTO DE LA RECOMENDACIÓN:
ROAS=${(prev.roas_7d||0).toFixed(2)}x, CPA=$${(prev.cpa_7d||0).toFixed(2)}, CTR=${(prev.ctr_7d||0).toFixed(2)}%, Freq=${(prev.frequency_7d||0).toFixed(1)}, Compras=${prev.purchases_7d||0}, Budget=$${(prev.daily_budget||0).toFixed(0)}/día

EVOLUCIÓN POR FASES:
${phases.day_3?.measured ? `Día 3: ROAS ${(phases.day_3.deltas?.roas_pct||0) > 0 ? '+' : ''}${phases.day_3.deltas?.roas_pct||0}%, CPA ${(phases.day_3.deltas?.cpa_pct||0) > 0 ? '+' : ''}${phases.day_3.deltas?.cpa_pct||0}%, Veredicto: ${phases.day_3.verdict}` : 'Día 3: No medido'}
${phases.day_7?.measured ? `Día 7: ROAS ${(phases.day_7.deltas?.roas_pct||0) > 0 ? '+' : ''}${phases.day_7.deltas?.roas_pct||0}%, CPA ${(phases.day_7.deltas?.cpa_pct||0) > 0 ? '+' : ''}${phases.day_7.deltas?.cpa_pct||0}%, Veredicto: ${phases.day_7.verdict}` : 'Día 7: No medido'}
Día 14: ROAS ${deltas.roas_pct > 0 ? '+' : ''}${deltas.roas_pct}%, CPA ${deltas.cpa_pct > 0 ? '+' : ''}${deltas.cpa_pct}%, CTR ${deltas.ctr_pct > 0 ? '+' : ''}${deltas.ctr_pct}%, Freq ${deltas.frequency_pct > 0 ? '+' : ''}${deltas.frequency_pct}%, Compras ${deltas.purchases_delta >= 0 ? '+' : ''}${deltas.purchases_delta}
${concurrentSection}
MÉTRICAS ACTUALES (14d después):
ROAS=${(m7d.roas||0).toFixed(2)}x, CPA=$${(m7d.cpa||0).toFixed(2)}, CTR=${(m7d.ctr||0).toFixed(2)}%, Freq=${(m7d.frequency||0).toFixed(1)}, Compras=${m7d.purchases||0}

VEREDICTO FINAL: ${verdict}

Responde SOLO con JSON:
{
  "root_cause": "Explica la causa raíz del resultado (por qué funcionó o no funcionó la acción)",
  "what_worked": "Qué aspecto de la acción tuvo efecto positivo (o 'N/A' si no funcionó)",
  "what_didnt": "Qué aspecto no mejoró o empeoró (o 'N/A' si todo mejoró)",
  "lesson_learned": "Una lección concreta y accionable para futuras recomendaciones similares",
  "confidence_adjustment": número entre -20 y +20 (cuánto ajustar la confianza del Brain para este tipo de acción)
}`;

    const response = await this.anthropic.messages.create({
      model: config.claude.model,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
      system: 'Eres un analista de Meta Ads. Analiza resultados de optimización. Sé directo y específico. Responde SOLO con JSON válido.'
    });

    const text = response.content[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const analysis = JSON.parse(jsonMatch[0]);
    const tokensUsed = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

    await BrainRecommendation.updateOne(
      { _id: rec._id },
      {
        $set: {
          'follow_up.ai_analysis.generated': true,
          'follow_up.ai_analysis.generated_at': new Date(),
          'follow_up.ai_analysis.root_cause': analysis.root_cause || '',
          'follow_up.ai_analysis.what_worked': analysis.what_worked || '',
          'follow_up.ai_analysis.what_didnt': analysis.what_didnt || '',
          'follow_up.ai_analysis.lesson_learned': analysis.lesson_learned || '',
          'follow_up.ai_analysis.confidence_adjustment': Math.max(-20, Math.min(20, analysis.confidence_adjustment || 0)),
          'follow_up.ai_analysis.tokens_used': tokensUsed,
          updated_at: new Date()
        }
      }
    );

    logger.info(`[FOLLOW-UP] AI analysis completed for "${rec.title}" — adjustment: ${analysis.confidence_adjustment || 0}`);
  }

  /**
   * Construir contexto enriquecido para el chat.
   * Incluye: 14d/30d metrics, AOV, funnel, seasonality, budget, rec history.
   */
  _buildChatContext(snapshots, accountOverview, recentInsights, activeRecs = [], recHistory = [], cycleMemories = []) {
    const TIMEZONE = process.env.TIMEZONE || 'America/New_York';
    const now = moment().tz(TIMEZONE);

    let ctx = `## CUENTA (${now.format('YYYY-MM-DD HH:mm')} ET)\n`;
    ctx += `ROAS: hoy ${(accountOverview.today_roas||0).toFixed(2)}x | 3d ${(accountOverview.roas_3d||0).toFixed(2)}x | 7d ${(accountOverview.roas_7d||0).toFixed(2)}x | 14d ${(accountOverview.roas_14d||0).toFixed(2)}x | 30d ${(accountOverview.roas_30d||0).toFixed(2)}x\n`;
    ctx += `Spend hoy: $${(accountOverview.today_spend||0).toFixed(0)} | Revenue hoy: $${(accountOverview.today_revenue||0).toFixed(0)}\n`;
    ctx += `Spend 14d: $${(accountOverview.spend_14d||0).toFixed(0)} | Spend 30d: $${(accountOverview.spend_30d||0).toFixed(0)}\n`;
    ctx += `Ad sets: ${accountOverview.active_adsets} activos, ${accountOverview.paused_adsets} pausados, ${accountOverview.total_adsets} total\n`;

    // Monthly budget context
    const dayOfMonth = now.date();
    const daysInMonth = now.daysInMonth();
    const dailyTarget = kpiTargets.pacing?.daily_spend_target || kpiTargets.daily_spend_target || 3000;
    const monthlyTarget = dailyTarget * daysInMonth;
    const budgetCeiling = safetyGuards.budget_ceiling_daily || 5000;
    ctx += `Budget: $${dailyTarget}/dia target, $${budgetCeiling}/dia ceiling, ~$${monthlyTarget.toLocaleString()}/mes target (dia ${dayOfMonth}/${daysInMonth})\n`;

    // Seasonality
    const todayStr = now.format('MM-DD');
    const seasonalEvents = kpiTargets.seasonal_events || [];
    const activeEvents = seasonalEvents.filter(ev => {
      if (ev.date) return ev.date === todayStr;
      if (ev.start && ev.end) return todayStr >= ev.start && todayStr <= ev.end;
      return false;
    });
    if (activeEvents.length > 0) {
      ctx += `EVENTO ESTACIONAL ACTIVO: ${activeEvents.map(e => `${e.name} (${e.budget_multiplier}x)`).join(', ')}\n`;
    }
    ctx += '\n';

    // KPI targets
    ctx += `## KPIs OBJETIVO\n`;
    ctx += `ROAS target: ${kpiTargets.roas_target}x (min: ${kpiTargets.roas_minimum}x, excelente: ${kpiTargets.roas_excellent}x) | CPA target: $${kpiTargets.cpa_target} (max: $${kpiTargets.cpa_maximum})\n\n`;

    ctx += `## AD SETS ACTIVOS\n`;
    const active = snapshots.filter(s => s.status === 'ACTIVE').sort((a, b) => (b.metrics?.last_7d?.spend || 0) - (a.metrics?.last_7d?.spend || 0));
    for (const s of active) {
      const m7 = s.metrics?.last_7d || {};
      const m14 = s.metrics?.last_14d || {};
      const m30 = s.metrics?.last_30d || {};
      const aov7d = (m7.purchases || 0) > 0 ? ((m7.purchase_value || 0) / m7.purchases).toFixed(2) : 'N/A';
      ctx += `- ${s.entity_name} [${s.entity_id}]:\n`;
      ctx += `  ROAS: 7d=${(m7.roas||0).toFixed(2)}x, 14d=${(m14.roas||0).toFixed(2)}x, 30d=${(m30.roas||0).toFixed(2)}x\n`;
      ctx += `  CPA: 7d=$${(m7.cpa||0).toFixed(2)}, 30d=$${(m30.cpa||0).toFixed(2)} | AOV 7d: $${aov7d}\n`;
      ctx += `  Spend: 7d=$${(m7.spend||0).toFixed(0)}, 30d=$${(m30.spend||0).toFixed(0)} | Budget=$${s.daily_budget||0}/d\n`;
      ctx += `  CTR=${(m7.ctr||0).toFixed(2)}%, Freq=${(m7.frequency||0).toFixed(1)}, Purchases 7d=${m7.purchases||0}, 30d=${m30.purchases||0}\n`;
      if ((m7.add_to_cart || 0) > 0 || (m7.initiate_checkout || 0) > 0) {
        ctx += `  Funnel 7d: ATC=${m7.add_to_cart||0} → IC=${m7.initiate_checkout||0} → Purchase=${m7.purchases||0}\n`;
      }
    }

    const paused = snapshots.filter(s => ['PAUSED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED'].includes(s.status))
      .sort((a, b) => (b.metrics?.last_30d?.spend || 0) - (a.metrics?.last_30d?.spend || 0));
    if (paused.length > 0) {
      ctx += `\n## AD SETS PAUSADOS (top ${Math.min(paused.length, 5)})\n`;
      for (const s of paused.slice(0, 5)) {
        const m7 = s.metrics?.last_7d || {};
        const m30 = s.metrics?.last_30d || {};
        ctx += `- ${s.entity_name}: ROAS 7d=${(m7.roas||0).toFixed(2)}x, 30d=${(m30.roas||0).toFixed(2)}x, Spend 30d=$${(m30.spend||0).toFixed(0)}, Compras 30d=${m30.purchases||0}\n`;
      }
      if (paused.length > 5) ctx += `(+${paused.length - 5} más pausados)\n`;
    }

    if (recentInsights.length > 0) {
      ctx += `\n## INSIGHTS RECIENTES\n`;
      for (const i of recentInsights.slice(0, 5)) {
        ctx += `- [${i.created_at.toISOString().split('T')[0]}] ${i.title}\n`;
      }
    }

    if (activeRecs.length > 0) {
      ctx += `\n## RECOMENDACIONES ACTIVAS\n`;
      for (const r of activeRecs) {
        ctx += `- [${r.priority}/${r.status}] ${r.title} — ${r.action_detail}\n`;
        if (r.follow_up?.impact_summary) ctx += `  Follow-up: ${r.follow_up.impact_summary}\n`;
      }
    }

    // Recommendation approval/rejection history
    if (recHistory && recHistory.length > 0) {
      const approved = recHistory.filter(r => r.status === 'approved');
      const rejected = recHistory.filter(r => r.status === 'rejected');
      ctx += `\n## HISTORIAL DE DECISIONES DEL USUARIO\n`;
      ctx += `Aprobadas: ${approved.length} | Rechazadas: ${rejected.length} (ultimas 20)\n`;
      for (const r of recHistory.slice(0, 5)) {
        const daysAgo = r.decided_at ? Math.round((Date.now() - new Date(r.decided_at).getTime()) / 86400000) : '?';
        const impact = r.follow_up?.impact_verdict || 'sin medir';
        ctx += `- [${r.status}] ${r.action_type} en ${r.entity?.entity_name || 'N/A'} (${daysAgo}d ago) — impacto: ${impact}\n`;
      }
    }

    // Cycle memories (persistent analysis memory)
    if (cycleMemories && cycleMemories.length > 0) {
      ctx += `\n## TU MEMORIA — ANÁLISIS PREVIOS\n`;
      for (const mem of cycleMemories) {
        const hoursAgo = Math.round((Date.now() - new Date(mem.created_at).getTime()) / (1000 * 60 * 60));
        ctx += `[${hoursAgo}h ago | ${mem.account_assessment}] `;
        if (mem.conclusions?.length > 0) {
          ctx += mem.conclusions.map(c => `${c.topic}: ${c.conclusion}`).join(' | ');
        }
        ctx += '\n';
        if (mem.hypotheses?.length > 0) {
          const active = mem.hypotheses.filter(h => h.status === 'active');
          if (active.length > 0) ctx += `  Hipótesis: ${active.map(h => h.hypothesis).join('; ')}\n`;
        }
      }
    }

    return ctx;
  }
}

module.exports = BrainAnalyzer;
