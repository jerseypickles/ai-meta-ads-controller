const ActionLog = require('../../db/models/ActionLog');
const BrainRecommendation = require('../../db/models/BrainRecommendation');
const CreativeAsset = require('../../db/models/CreativeAsset');
const logger = require('../../utils/logger');

/**
 * Construye el contexto de impacto para el Cerebro IA.
 * Carga acciones medidas, calcula patrones, e identifica acciones en observacion.
 */
class ImpactContextBuilder {

  /**
   * Genera el contexto completo de impacto para incluir en el prompt de Claude.
   * @returns {Object} { feedbackText, pendingText, summary, patterns }
   */
  async build() {
    const [measured, pending, creativeAssets, trackingRecs] = await Promise.all([
      this._loadMeasuredActions(30),
      this._loadPendingActions(),
      CreativeAsset.find({ status: 'active' }).lean().catch(() => []),
      this._loadTrackingRecommendations()
    ]);

    const processed = this._processActions(measured);
    const patterns = this._extractPatterns(processed);
    const creativePerformance = this._extractCreativePerformance(processed, creativeAssets);
    const pendingEntities = this._extractPendingEntities(pending, trackingRecs);

    // Fix 5 — Learning Loop: compute weighted success rate to avoid double counting
    const weightedImproved = processed.reduce((sum, a) => sum + (a.result === 'improved' ? (a.weight || 1) : 0), 0);
    const totalWeight = processed.reduce((sum, a) => sum + (a.weight || 1), 0);

    const summary = {
      total_measured: processed.length,
      improved: processed.filter(a => a.result === 'improved').length,
      worsened: processed.filter(a => a.result === 'worsened').length,
      neutral: processed.filter(a => a.result === 'neutral').length,
      avg_roas_delta: processed.length > 0
        ? Math.round(processed.reduce((sum, a) => sum + a.delta_roas_pct, 0) / processed.length * 100) / 100
        : 0,
      success_rate_pct: totalWeight > 0 ? Math.round(weightedImproved / totalWeight * 100) : 0,
      pending_count: pending.length
    };

    const feedbackText = this._buildFeedbackText(processed, summary, patterns, creativePerformance);
    const pendingText = this._buildPendingText(pending, pendingEntities, trackingRecs);

    return {
      feedbackText,
      pendingText,
      summary,
      patterns,
      creativePerformance,
      pendingEntities,
      trackingRecs,
      processedActions: processed
    };
  }

  async _loadMeasuredActions(limit) {
    return ActionLog.find({
      success: true,
      impact_measured: true
    })
      .sort({ executed_at: -1 })
      .limit(limit)
      .lean();
  }

  async _loadPendingActions() {
    // Extend window to 7 days — actions still within attribution window should not be disturbed
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    return ActionLog.find({
      success: true,
      $or: [
        { impact_measured: { $ne: true } },           // Not yet measured at 3d
        { impact_7d_measured: { $ne: true } }          // Not yet measured at 7d
      ],
      executed_at: { $gte: sevenDaysAgo }
    })
      .sort({ executed_at: -1 })
      .lean();
  }

  _processActions(actions) {
    return actions.map(a => {
      const before = a.metrics_at_execution || {};
      // Prefer 7d attribution (~95% accuracy) over 3d (~85-90%) for learning
      const after = (a.impact_7d_measured && a.metrics_after_7d?.roas_7d > 0)
        ? a.metrics_after_7d
        : (a.metrics_after_3d || a.metrics_after_1d || {});

      const roasBefore = before.roas_7d || 0;
      const roasAfter = after.roas_7d || 0;
      const cpaBefore = before.cpa_7d || 0;
      const cpaAfter = after.cpa_7d || 0;

      const delta_roas_pct = roasBefore > 0
        ? Math.round((roasAfter - roasBefore) / roasBefore * 10000) / 100
        : 0;
      const delta_cpa_pct = cpaBefore > 0
        ? Math.round((cpaAfter - cpaBefore) / cpaBefore * 10000) / 100
        : 0;

      let result = 'neutral';
      if (delta_roas_pct > 5) result = 'improved';
      else if (delta_roas_pct < -5) result = 'worsened';

      const checkpoint = (a.impact_7d_measured && a.metrics_after_7d?.roas_7d > 0) ? '7d' : '3d';

      // Fix 5 — Learning Loop: weight by concurrent actions to avoid double counting
      const concurrent = actions.filter(other =>
        other._id.toString() !== a._id.toString() &&
        other.entity_id === a.entity_id &&
        Math.abs(new Date(other.executed_at).getTime() - new Date(a.executed_at).getTime()) < 7 * 86400000
      );
      const weight = concurrent.length > 0 ? 1 / (1 + concurrent.length) : 1.0;

      return {
        action: a.action,
        entity_id: a.entity_id,
        entity_name: a.entity_name || 'Sin nombre',
        entity_type: a.entity_type || 'adset',
        before_value: a.before_value,
        after_value: a.after_value,
        executed_at: a.executed_at,
        roas_before: roasBefore,
        roas_after: roasAfter,
        cpa_before: cpaBefore,
        cpa_after: cpaAfter,
        delta_roas_pct,
        delta_cpa_pct,
        result,
        checkpoint,
        agent_type: a.agent_type,
        creative_asset_id: a.creative_asset_id || null,
        weight
      };
    });
  }

  _extractPatterns(processed) {
    const byAction = {};
    for (const a of processed) {
      const w = a.weight || 1;
      if (!byAction[a.action]) {
        byAction[a.action] = { total: 0, improved: 0, worsened: 0, deltas: [], weighted_improved: 0, total_weight: 0 };
      }
      byAction[a.action].total++;
      if (a.result === 'improved') byAction[a.action].improved++;
      if (a.result === 'worsened') byAction[a.action].worsened++;
      byAction[a.action].deltas.push(a.delta_roas_pct);
      // Fix 5 — Learning Loop: weighted counters for accurate success_rate
      byAction[a.action].weighted_improved += (a.result === 'improved' ? w : 0);
      byAction[a.action].total_weight += w;
    }

    for (const [, stats] of Object.entries(byAction)) {
      // Fix 5: use weighted success rate to avoid double counting overlapping actions
      stats.success_rate = stats.total_weight > 0 ? Math.round(stats.weighted_improved / stats.total_weight * 100) : 0;
      stats.avg_delta = stats.deltas.length > 0
        ? Math.round(stats.deltas.reduce((s, d) => s + d, 0) / stats.deltas.length * 100) / 100
        : 0;
      delete stats.deltas;
      delete stats.weighted_improved;
      delete stats.total_weight;
    }

    return byAction;
  }

  _extractCreativePerformance(processed, creativeAssets) {
    const createAdActions = processed.filter(a => a.action === 'create_ad' && a.creative_asset_id);
    if (createAdActions.length === 0) return {};

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
    for (const [, stats] of Object.entries(styleMap)) {
      stats.success_rate = stats.total > 0 ? Math.round(stats.improved / stats.total * 100) : 0;
      stats.avg_delta = stats.deltas.length > 0
        ? Math.round(stats.deltas.reduce((s, d) => s + d, 0) / stats.deltas.length * 100) / 100
        : 0;
      delete stats.deltas;
    }

    return styleMap;
  }

  /**
   * Load approved BrainRecommendations still in active follow-up tracking.
   * These entities should NOT receive new recommendations.
   */
  async _loadTrackingRecommendations() {
    try {
      return await BrainRecommendation.find({
        status: 'approved',
        decided_at: { $ne: null },
        'follow_up.current_phase': { $in: ['awaiting_day_3', 'awaiting_day_7', 'awaiting_day_14'] }
      }).lean();
    } catch (e) {
      logger.warn(`[IMPACT] Error loading tracking recommendations: ${e.message}`);
      return [];
    }
  }

  _extractPendingEntities(pending, trackingRecs = []) {
    const entityIds = new Set(pending.map(a => a.entity_id));
    // Also block entities with approved recs in active follow-up
    for (const rec of trackingRecs) {
      if (rec.entity?.entity_id) {
        entityIds.add(rec.entity.entity_id);
      }
    }
    return entityIds;
  }

  _buildFeedbackText(processed, summary, patterns, creativePerformance) {
    if (processed.length === 0) {
      return '\nFEEDBACK DE IMPACTO: Sin acciones medidas aun. No hay historial de resultados.';
    }

    // Resumen estadistico
    const summaryStr = `Total acciones medidas: ${summary.total_measured} | Mejoraron: ${summary.improved} (${summary.success_rate_pct}%) | Empeoraron: ${summary.worsened} | Neutras: ${summary.neutral} | Promedio ROAS delta: ${summary.avg_roas_delta > 0 ? '+' : ''}${summary.avg_roas_delta}%`;

    // Patrones por tipo de accion
    let patternsStr = '';
    if (Object.keys(patterns).length > 0) {
      const patternLines = Object.entries(patterns).map(([action, stats]) => {
        return `  ${action}: ${stats.total} veces, ${stats.improved} mejoraron (${stats.success_rate}%), promedio ROAS delta: ${stats.avg_delta > 0 ? '+' : ''}${stats.avg_delta}%`;
      }).join('\n');
      patternsStr = `\nPATRONES POR TIPO DE ACCION:\n${patternLines}`;
    }

    // Rendimiento por estilo de creativo
    let creativeStr = '';
    if (Object.keys(creativePerformance).length > 0) {
      const lines = Object.entries(creativePerformance).map(([style, stats]) => {
        return `  ${style}: ${stats.total} ads creados, ${stats.improved} mejoraron (${stats.success_rate}%), promedio ROAS delta: ${stats.avg_delta > 0 ? '+' : ''}${stats.avg_delta}%`;
      }).join('\n');
      creativeStr = `\nRENDIMIENTO POR ESTILO DE CREATIVO:\n${lines}`;
    }

    // Historial detallado (ultimas 20)
    const actionLines = processed.slice(0, 20).map(a => {
      const daysAgo = Math.round((Date.now() - new Date(a.executed_at).getTime()) / (1000 * 60 * 60 * 24));
      const budgetStr = ['scale_up', 'scale_down', 'move_budget'].includes(a.action)
        ? ` $${a.before_value} -> $${a.after_value}` : '';
      const statusChange = a.action === 'update_ad_status'
        ? ` (${a.after_value === 0 ? 'PAUSADO' : 'ACTIVADO'})` : '';
      return `- ${a.entity_name}: ${a.action}${budgetStr}${statusChange} (hace ${daysAgo}d, medido a ${a.checkpoint || '3d'}) | resultado: ${a.result} | ROAS: ${a.roas_before.toFixed(2)}x -> ${a.roas_after.toFixed(2)}x (${a.delta_roas_pct > 0 ? '+' : ''}${a.delta_roas_pct}%) | CPA: $${a.cpa_before.toFixed(2)} -> $${a.cpa_after.toFixed(2)} (${a.delta_cpa_pct > 0 ? '+' : ''}${a.delta_cpa_pct}%)`;
    }).join('\n');

    return `\n\nFEEDBACK DE IMPACTO — RESULTADOS DE TUS ACCIONES PASADAS:
${summaryStr}
${patternsStr}
${creativeStr}

HISTORIAL DETALLADO (ultimas ${Math.min(processed.length, 20)} acciones medidas):
${actionLines}

INSTRUCCIONES DE APRENDIZAJE:
- Si tu tasa de exito es ALTA (>60%), sigue con tu estrategia actual. Si es BAJA (<40%), cambia de enfoque.
- Mira los patrones por tipo de accion: si "scale_up" tiene exito alto pero "pause" tiene exito bajo, ajusta.
- Busca patrones en que ENTIDADES respondieron bien vs mal. Repite lo que funciono, evita lo que fallo.
- El delta de ROAS promedio te indica tu impacto neto. Si es negativo, se mas conservador.
- Si un estilo de creativo tiene mejor tasa de exito, prioriza ese estilo al recomendar create_ad.`;
  }

  _buildPendingText(pending, pendingEntities, trackingRecs = []) {
    if (pending.length === 0 && trackingRecs.length === 0) return '';

    let text = '';

    if (pending.length > 0) {
      const lines = pending.map(a => {
        const hoursElapsed = Math.round((Date.now() - new Date(a.executed_at).getTime()) / (1000 * 60 * 60));
        const daysElapsed = (hoursElapsed / 24).toFixed(1);
        const hoursLeftFor7d = Math.max(0, 168 - hoursElapsed); // 7 days = 168 hours
        const has3d = a.impact_measured === true;
        const checkpoint = has3d ? `3d medido, esperando 7d (${hoursLeftFor7d}h)` : `midiendo (${Math.max(0, 72 - hoursElapsed)}h para 3d)`;
        const after1d = a.metrics_after_1d || {};
        let partial = '';
        if (after1d.roas_7d > 0) {
          const before = a.metrics_at_execution || {};
          const delta1d = before.roas_7d > 0
            ? ((after1d.roas_7d - before.roas_7d) / before.roas_7d * 100).toFixed(1)
            : 'N/A';
          partial = ` | parcial 24h: ROAS ${after1d.roas_7d.toFixed(2)}x (${delta1d}%)`;
        }
        return `- ${a.entity_name} (${a.entity_id}): ${a.action} hace ${daysElapsed}d, ${checkpoint}${partial}`;
      }).join('\n');

      text += `\n\nACCIONES EN MEDICION (NO TOCAR estas entidades):\n${lines}`;
    }

    // Include approved recs in active follow-up tracking
    if (trackingRecs.length > 0) {
      const trackingLines = trackingRecs.map(r => {
        const daysAgo = r.decided_at ? Math.round((Date.now() - new Date(r.decided_at).getTime()) / 86400000) : '?';
        const phase = r.follow_up?.current_phase || 'awaiting_day_3';
        const executed = r.follow_up?.action_executed ? 'ejecutada' : 'pendiente ejecucion';
        return `- ${r.entity?.entity_name || 'N/A'} (${r.entity?.entity_id || 'N/A'}): ${r.action_type} aprobada hace ${daysAgo}d, fase: ${phase}, ${executed}`;
      }).join('\n');

      text += `\n\nRECOMENDACIONES APROBADAS EN SEGUIMIENTO (NO TOCAR estas entidades):\n${trackingLines}`;
    }

    const entityIds = [...pendingEntities];
    text += `\nIMPORTANTE: Las siguientes entidades estan siendo medidas o en seguimiento. NO recomiendes cambios en ellas hasta que la medicion termine: ${entityIds.join(', ')}`;

    return text;
  }
}

module.exports = ImpactContextBuilder;
