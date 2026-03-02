const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const kpiTargets = require('../../../config/kpi-targets');
const { getLatestSnapshots, getAccountOverview, getRecentActions } = require('../../db/queries');
const BrainMemory = require('../../db/models/BrainMemory');
const BrainInsight = require('../../db/models/BrainInsight');
const BrainChat = require('../../db/models/BrainChat');
const BrainRecommendation = require('../../db/models/BrainRecommendation');
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

      // 2. Cargar memorias existentes
      const memories = await BrainMemory.find({}).lean();
      const memoryMap = {};
      for (const m of memories) {
        memoryMap[m.entity_id] = m;
      }

      // 3. Fase matemática: detectar cambios significativos
      const findings = this._detectChanges(adsetSnapshots, memoryMap, accountOverview);

      // 4. Fase IA: si hay hallazgos, generar insights de calidad
      let insightsCreated = 0;
      if (findings.length > 0) {
        insightsCreated = await this._generateInsights(findings, adsetSnapshots, accountOverview, recentActions);
      }

      // 5. Actualizar memoria con estado actual
      await this._updateMemory(adsetSnapshots);

      // 6. Verificar si toca resumen periódico (cada ~6 horas)
      const summaryCreated = await this._maybeSummary(adsetSnapshots, accountOverview);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`[BRAIN-ANALYZER] Completado en ${elapsed}s — ${findings.length} hallazgos, ${insightsCreated + (summaryCreated ? 1 : 0)} insights generados`);

      return {
        findings: findings.length,
        insights_created: insightsCreated + (summaryCreated ? 1 : 0),
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
  _detectChanges(snapshots, memoryMap, accountOverview) {
    const findings = [];

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
          findings.push({
            type: roasDelta < 0 ? 'anomaly' : 'opportunity',
            severity: Math.abs(roasDelta) > 40 ? 'high' : 'medium',
            entity: { entity_type: 'adset', entity_id: snap.entity_id, entity_name: snap.entity_name },
            data: {
              metric: 'roas_7d',
              from: rm.roas_7d,
              to: m7d.roas,
              delta_pct: +roasDelta.toFixed(1)
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
   * Fase 2: IA interpreta los hallazgos y genera insights de calidad.
   */
  async _generateInsights(findings, snapshots, accountOverview, recentActions) {
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

    // Construir prompt para Claude
    const prompt = this._buildInsightPrompt(filtered, snapshots, accountOverview, recentActions, previousMap);

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

      // Guardar cada insight
      let created = 0;
      for (const insight of insights) {
        try {
          const doc = await BrainInsight.create({
            ...insight,
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
  _buildInsightPrompt(findings, snapshots, accountOverview, recentActions, previousMap) {
    const snapshotMap = {};
    for (const s of snapshots) snapshotMap[s.entity_id] = s;

    let prompt = `## HALLAZGOS DETECTADOS\n\n`;

    for (const f of findings) {
      const snap = snapshotMap[f.entity.entity_id];
      const m7d = snap?.metrics?.last_7d || {};
      const m3d = snap?.metrics?.last_3d || {};
      const mToday = snap?.metrics?.today || {};

      prompt += `### ${f.entity.entity_name} (${f.entity.entity_id})\n`;
      prompt += `Tipo: ${f.type} | Severidad: ${f.severity}\n`;
      prompt += `Datos: ${JSON.stringify(f.data)}\n`;
      prompt += `Métricas actuales 7d: ROAS=${m7d.roas?.toFixed(2)||'N/A'}, Spend=$${m7d.spend?.toFixed(0)||0}, CPA=$${m7d.cpa?.toFixed(2)||'N/A'}, CTR=${m7d.ctr?.toFixed(2)||'N/A'}%, Freq=${m7d.frequency?.toFixed(1)||'N/A'}, Purchases=${m7d.purchases||0}\n`;
      prompt += `Métricas 3d: ROAS=${m3d.roas?.toFixed(2)||'N/A'}, Spend=$${m3d.spend?.toFixed(0)||0}\n`;
      prompt += `Hoy: ROAS=${mToday.roas?.toFixed(2)||'N/A'}, Spend=$${mToday.spend?.toFixed(0)||0}\n`;
      prompt += `Budget diario: $${snap?.daily_budget || 0}\n`;

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

    let summaryPrompt = `Genera un RESUMEN EJECUTIVO breve del estado actual de las campañas de Meta Ads.

## DATOS DE CUENTA
- ROAS 7d: ${accountOverview.roas_7d?.toFixed(2)}x (target: ${kpiTargets.roas_target}x)
- ROAS 3d: ${accountOverview.roas_3d?.toFixed(2)}x
- Spend hoy: $${accountOverview.today_spend?.toFixed(0)}
- Revenue hoy: $${accountOverview.today_revenue?.toFixed(0)}
- Ad sets activos: ${accountOverview.active_adsets} | Pausados: ${accountOverview.paused_adsets} | Total: ${accountOverview.total_adsets}

## TOP 5 PERFORMERS (7d ROAS)
${topPerformers.map(s => `- ${s.entity_name}: ROAS ${(s.metrics?.last_7d?.roas || 0).toFixed(2)}x, Spend $${(s.metrics?.last_7d?.spend || 0).toFixed(0)}, ${s.metrics?.last_7d?.purchases || 0} compras`).join('\n')}

## PEORES 5 (con spend >$10)
${worstPerformers.map(s => `- ${s.entity_name}: ROAS ${(s.metrics?.last_7d?.roas || 0).toFixed(2)}x, Spend $${(s.metrics?.last_7d?.spend || 0).toFixed(0)}, ${s.metrics?.last_7d?.purchases || 0} compras`).join('\n')}

${lastSummary ? `\n## RESUMEN ANTERIOR (${lastSummary.created_at.toISOString().split('T')[0]})\n"${lastSummary.title}"\n${lastSummary.body.substring(0, 300)}...` : ''}

Responde con un JSON object:
{
  "title": "Título corto del resumen (máx 80 chars)",
  "body": "Resumen ejecutivo en 2-3 párrafos en español"
}`;

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

      await BrainInsight.create({
        insight_type: 'summary',
        severity: 'info',
        title: parsed.title || 'Resumen de cuenta',
        body: parsed.body || '',
        entities: [{ entity_type: 'account', entity_id: 'account', entity_name: 'Cuenta' }],
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
  async chat(userMessage) {
    // 1. Cargar datos actuales para contexto
    const [adsetSnapshots, accountOverview, recentInsights, chatHistory, activeRecs] = await Promise.all([
      getLatestSnapshots('adset'),
      getAccountOverview(),
      BrainInsight.find({}).sort({ created_at: -1 }).limit(10).lean(),
      BrainChat.find({}).sort({ created_at: -1 }).limit(20).lean(),
      BrainRecommendation.find({ status: { $in: ['pending', 'approved'] } }).sort({ created_at: -1 }).limit(10).lean()
    ]);

    // 2. Guardar mensaje del usuario
    await BrainChat.create({ role: 'user', content: userMessage });

    // 3. Construir contexto
    const context = this._buildChatContext(adsetSnapshots, accountOverview, recentInsights, activeRecs);

    // 4. Construir historial de conversación
    const messages = [];
    const history = chatHistory.reverse(); // Más antiguo primero
    for (const msg of history) {
      messages.push({ role: msg.role, content: msg.content });
    }
    messages.push({ role: 'user', content: userMessage });

    // 5. Llamar a Claude
    const response = await this.anthropic.messages.create({
      model: config.claude.model,
      max_tokens: 2048,
      messages,
      system: `Eres el Brain Analyst de Jersey Pickles — un asistente experto en Meta Ads que conoce todas las campañas en detalle.

DATOS ACTUALES DE LAS CAMPAÑAS:
${context}

REGLAS:
1. Responde en ESPAÑOL, de forma profesional pero accesible.
2. Usa datos específicos cuando respondas — nombres de ad sets, números, métricas reales.
3. Si no tienes la información, dilo honestamente.
4. Puedes sugerir acciones pero aclara que el Brain las ejecutaría si se aprueban.
5. Sé conciso pero completo.`
    });

    const assistantMessage = response.content[0]?.text || '';
    const tokensUsed = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

    // 6. Guardar respuesta
    await BrainChat.create({
      role: 'assistant',
      content: assistantMessage,
      context_summary: `${adsetSnapshots.length} adsets, ROAS 7d: ${accountOverview.roas_7d?.toFixed(2)}`,
      tokens_used: tokensUsed,
      ai_model: config.claude.model
    });

    return {
      message: assistantMessage,
      tokens_used: tokensUsed,
      context_entities: adsetSnapshots.length
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
      // 1. Cargar datos actuales
      const [adsetSnapshots, accountOverview, recentActions] = await Promise.all([
        getLatestSnapshots('adset'),
        getAccountOverview(),
        getRecentActions(7)
      ]);

      // 2. Cargar memorias y insights recientes para contexto
      const [memories, recentInsights, previousRecs] = await Promise.all([
        BrainMemory.find({}).lean(),
        BrainInsight.find({}).sort({ created_at: -1 }).limit(30).lean(),
        BrainRecommendation.find({ status: 'pending' }).lean()
      ]);

      const memoryMap = {};
      for (const m of memories) memoryMap[m.entity_id] = m;

      // 3. Construir prompt con datos 7d estables
      const prompt = this._buildRecommendationPrompt(
        adsetSnapshots, accountOverview, recentActions,
        memoryMap, recentInsights, previousRecs
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

      // 7. Guardar nuevas recomendaciones
      let created = 0;
      for (const rec of recs) {
        try {
          // Capturar snapshot de métricas al momento de la recomendación
          const snap = adsetSnapshots.find(s => s.entity_id === rec.entity.entity_id);
          const m7d = snap?.metrics?.last_7d || {};

          await BrainRecommendation.create({
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
              purchases_7d: m7d.purchases || 0,
              status: snap?.status || 'UNKNOWN'
            }
          });
          created++;
        } catch (saveErr) {
          logger.error(`[BRAIN-RECS] Error guardando recomendación: ${saveErr.message}`);
        }
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

FORMATO DE RESPUESTA — JSON array:
[
  {
    "priority": "urgente|evaluar|monitorear",
    "action_type": "pause|scale_up|scale_down|reactivate|restructure|creative_refresh|bid_change|monitor",
    "entity_id": "id_del_adset",
    "entity_name": "nombre",
    "title": "Título corto y claro (máx 80 chars)",
    "body": "Análisis completo en español: por qué recomiendas esto, qué datos lo respaldan, qué esperas que pase si se ejecuta (2-3 párrafos)",
    "action_detail": "Acción específica: 'Pausar ad set BROAD 5' o 'Aumentar budget de BROAD 2 de $15 a $20/día'",
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
  _buildRecommendationPrompt(snapshots, accountOverview, recentActions, memoryMap, recentInsights, previousRecs) {
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
      const mem = memoryMap[s.entity_id];
      const trend = mem?.trends || {};

      prompt += `### ${s.entity_name} [${s.entity_id}]\n`;
      prompt += `  7d: ROAS=${(m7d.roas||0).toFixed(2)}x, Spend=$${(m7d.spend||0).toFixed(0)}, CPA=$${(m7d.cpa||0).toFixed(2)}, CTR=${(m7d.ctr||0).toFixed(2)}%, Freq=${(m7d.frequency||0).toFixed(1)}, Purchases=${m7d.purchases||0}\n`;
      prompt += `  3d: ROAS=${(m3d.roas||0).toFixed(2)}x, Spend=$${(m3d.spend||0).toFixed(0)}\n`;
      prompt += `  Budget: $${s.daily_budget||0}/día\n`;
      if (trend.roas_direction && trend.roas_direction !== 'unknown') {
        prompt += `  Tendencia ROAS: ${trend.roas_direction}`;
        if (trend.consecutive_decline_days > 0) prompt += ` (${trend.consecutive_decline_days} ciclos declinando)`;
        if (trend.consecutive_improve_days > 0) prompt += ` (${trend.consecutive_improve_days} ciclos mejorando)`;
        prompt += `\n`;
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

    // Recomendaciones anteriores que fueron aprobadas/rechazadas (para que el Brain aprenda)
    const decidedRecs = previousRecs.filter(r => r.status === 'approved' || r.status === 'rejected');
    // Actually, load from DB the recently decided ones
    prompt += `## HISTORIAL DE DECISIONES DEL USUARIO\n`;
    prompt += `(El usuario aprueba o rechaza las recomendaciones. Aprende de sus preferencias.)\n`;
    // This will be enhanced — for now, note previous pending ones
    if (previousRecs.length > 0) {
      prompt += `Recomendaciones pendientes que serán reemplazadas por este ciclo:\n`;
      for (const r of previousRecs.slice(0, 5)) {
        prompt += `- [${r.priority}] ${r.title} (estado: ${r.status})\n`;
      }
    }
    prompt += `\n`;

    prompt += `Genera recomendaciones accionables basándote en los datos 7d. Si no hay acciones claras que tomar, devuelve un array vacío [].`;

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
      }).filter(r => r.body.length > 0 && r.entity.entity_id);
    } catch (parseErr) {
      logger.error(`[BRAIN-RECS] Error parseando respuesta: ${parseErr.message}`);
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // FOLLOW-UP ENGINE — Mide impacto de recomendaciones aprobadas
  // ═══════════════════════════════════════════════════════════════

  /**
   * Revisa recomendaciones aprobadas y mide si la acción fue ejecutada + impacto.
   * Llamado en cada ciclo de datos (cada 10 min) pero solo actúa si hay
   * recomendaciones aprobadas hace >24h sin follow-up.
   */
  async followUpApprovedRecommendations() {
    try {
      // Buscar recomendaciones aprobadas sin follow-up, aprobadas hace >24h
      const oneDayAgo = new Date(Date.now() - 24 * 3600000);
      const approvedRecs = await BrainRecommendation.find({
        status: 'approved',
        'follow_up.checked': false,
        decided_at: { $lte: oneDayAgo }
      }).lean();

      if (approvedRecs.length === 0) return 0;

      const snapshots = await getLatestSnapshots('adset');
      const snapshotMap = {};
      for (const s of snapshots) snapshotMap[s.entity_id] = s;

      let followedUp = 0;

      for (const rec of approvedRecs) {
        const snap = snapshotMap[rec.entity.entity_id];
        if (!snap) continue;

        const m7d = snap.metrics?.last_7d || {};
        const prev = rec.follow_up?.metrics_at_recommendation || {};

        // Detectar si la acción fue ejecutada
        let actionExecuted = false;
        if (rec.action_type === 'pause') {
          actionExecuted = ['PAUSED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED'].includes(snap.status);
        } else if (rec.action_type === 'scale_up') {
          actionExecuted = (snap.daily_budget || 0) > (prev.spend_7d / 7 || 0);
        } else if (rec.action_type === 'scale_down') {
          actionExecuted = (snap.daily_budget || 0) < (prev.spend_7d / 7 || 0);
        } else if (rec.action_type === 'reactivate') {
          actionExecuted = snap.status === 'ACTIVE' && prev.status !== 'ACTIVE';
        } else {
          // Para otros tipos, simplemente medir el cambio
          actionExecuted = true; // Asumimos que se hizo algo
        }

        // Calcular impacto
        let impactSummary = '';
        let impactVerdict = 'neutral';

        if (rec.action_type === 'pause' && actionExecuted) {
          // Impacto en la cuenta general
          impactSummary = `Ad set "${rec.entity.entity_name}" fue pausado. ROAS de cuenta al momento: ${prev.roas_7d?.toFixed(2)}x.`;
          impactVerdict = 'positive'; // Pausar un bajo rendimiento es generalmente positivo
        } else if (prev.roas_7d && prev.roas_7d > 0) {
          const roasChange = ((m7d.roas || 0) - prev.roas_7d) / prev.roas_7d * 100;
          if (roasChange > 10) {
            impactVerdict = 'positive';
            impactSummary = `ROAS mejoró de ${prev.roas_7d.toFixed(2)}x a ${(m7d.roas||0).toFixed(2)}x (+${roasChange.toFixed(0)}%). Compras: ${prev.purchases_7d||0} → ${m7d.purchases||0}.`;
          } else if (roasChange < -10) {
            impactVerdict = 'negative';
            impactSummary = `ROAS bajó de ${prev.roas_7d.toFixed(2)}x a ${(m7d.roas||0).toFixed(2)}x (${roasChange.toFixed(0)}%). Puede ser volatilidad transitoria.`;
          } else {
            impactVerdict = 'neutral';
            impactSummary = `ROAS se mantuvo estable: ${prev.roas_7d.toFixed(2)}x → ${(m7d.roas||0).toFixed(2)}x. Sin cambio significativo aún.`;
          }
        } else {
          impactSummary = `Datos insuficientes para medir impacto. Métricas actuales: ROAS=${(m7d.roas||0).toFixed(2)}x, Spend=$${(m7d.spend||0).toFixed(0)}.`;
        }

        // Guardar follow-up
        await BrainRecommendation.updateOne(
          { _id: rec._id },
          {
            $set: {
              'follow_up.checked': true,
              'follow_up.checked_at': new Date(),
              'follow_up.action_executed': actionExecuted,
              'follow_up.execution_detected_at': actionExecuted ? new Date() : null,
              'follow_up.metrics_after': {
                roas_7d: m7d.roas || 0,
                cpa_7d: m7d.cpa || 0,
                spend_7d: m7d.spend || 0,
                frequency_7d: m7d.frequency || 0,
                purchases_7d: m7d.purchases || 0,
                status: snap.status,
                measured_at: new Date()
              },
              'follow_up.impact_summary': impactSummary,
              'follow_up.impact_verdict': impactVerdict,
              updated_at: new Date()
            }
          }
        );

        // Crear insight de follow-up si la acción fue ejecutada
        if (actionExecuted) {
          try {
            await BrainInsight.create({
              insight_type: 'follow_up',
              severity: impactVerdict === 'positive' ? 'info' : impactVerdict === 'negative' ? 'medium' : 'low',
              title: `Seguimiento: ${rec.title}`,
              body: `**Recomendación aprobada:** ${rec.action_detail}\n\n**Estado:** ${actionExecuted ? 'Acción ejecutada' : 'Acción no detectada'}\n\n**Impacto:** ${impactSummary}`,
              entities: [rec.entity],
              generated_by: 'hybrid',
              data_points: {
                recommendation_id: rec._id.toString(),
                action_type: rec.action_type,
                impact_verdict: impactVerdict,
                roas_before: prev.roas_7d,
                roas_after: m7d.roas || 0
              }
            });
          } catch (insightErr) {
            logger.error(`[BRAIN-RECS] Error creando insight de follow-up: ${insightErr.message}`);
          }
        }

        followedUp++;
      }

      if (followedUp > 0) {
        logger.info(`[BRAIN-RECS] Follow-up: ${followedUp} recomendaciones revisadas`);
      }
      return followedUp;
    } catch (error) {
      logger.error(`[BRAIN-RECS] Error en follow-up: ${error.message}`);
      return 0;
    }
  }

  /**
   * Construir contexto compacto para el chat.
   */
  _buildChatContext(snapshots, accountOverview, recentInsights, activeRecs = []) {
    let ctx = `## CUENTA\n`;
    ctx += `ROAS 7d: ${accountOverview.roas_7d?.toFixed(2)}x | ROAS 3d: ${accountOverview.roas_3d?.toFixed(2)}x | Spend hoy: $${accountOverview.today_spend?.toFixed(0)} | Revenue hoy: $${accountOverview.today_revenue?.toFixed(0)}\n`;
    ctx += `Ad sets: ${accountOverview.active_adsets} activos, ${accountOverview.paused_adsets} pausados, ${accountOverview.total_adsets} total\n\n`;

    ctx += `## AD SETS ACTIVOS\n`;
    const active = snapshots.filter(s => s.status === 'ACTIVE').sort((a, b) => (b.metrics?.last_7d?.spend || 0) - (a.metrics?.last_7d?.spend || 0));
    for (const s of active) {
      const m = s.metrics?.last_7d || {};
      ctx += `- ${s.entity_name} [${s.entity_id}]: ROAS=${(m.roas||0).toFixed(2)}x, Spend=$${(m.spend||0).toFixed(0)}, CPA=$${(m.cpa||0).toFixed(2)}, CTR=${(m.ctr||0).toFixed(2)}%, Freq=${(m.frequency||0).toFixed(1)}, Purchases=${m.purchases||0}, Budget=$${s.daily_budget||0}/d\n`;
    }

    const paused = snapshots.filter(s => ['PAUSED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED'].includes(s.status));
    if (paused.length > 0) {
      ctx += `\n## AD SETS PAUSADOS\n`;
      for (const s of paused) {
        const m = s.metrics?.last_7d || {};
        ctx += `- ${s.entity_name}: ROAS=${(m.roas||0).toFixed(2)}x, Spend=$${(m.spend||0).toFixed(0)} (último 7d)\n`;
      }
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

    return ctx;
  }
}

module.exports = BrainAnalyzer;
