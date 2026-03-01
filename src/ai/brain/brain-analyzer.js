const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const kpiTargets = require('../../../config/kpi-targets');
const { getLatestSnapshots, getAccountOverview, getRecentActions } = require('../../db/queries');
const BrainMemory = require('../../db/models/BrainMemory');
const BrainInsight = require('../../db/models/BrainInsight');
const BrainChat = require('../../db/models/BrainChat');
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
    const [adsetSnapshots, accountOverview, recentInsights, chatHistory] = await Promise.all([
      getLatestSnapshots('adset'),
      getAccountOverview(),
      BrainInsight.find({}).sort({ created_at: -1 }).limit(10).lean(),
      BrainChat.find({}).sort({ created_at: -1 }).limit(20).lean()
    ]);

    // 2. Guardar mensaje del usuario
    await BrainChat.create({ role: 'user', content: userMessage });

    // 3. Construir contexto
    const context = this._buildChatContext(adsetSnapshots, accountOverview, recentInsights);

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

  /**
   * Construir contexto compacto para el chat.
   */
  _buildChatContext(snapshots, accountOverview, recentInsights) {
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

    return ctx;
  }
}

module.exports = BrainAnalyzer;
