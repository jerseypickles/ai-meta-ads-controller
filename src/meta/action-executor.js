const { getMetaClient } = require('./client');
const GuardRail = require('../safety/guard-rail');
const { CooldownManager } = require('../safety/cooldown-manager');
const ActionLog = require('../db/models/ActionLog');
const AICreation = require('../db/models/AICreation');
const { getLatestSnapshots } = require('../db/queries');
const logger = require('../utils/logger');
const CreativeAsset = require('../db/models/CreativeAsset');

class ActionExecutor {
  constructor() {
    this.meta = getMetaClient();
    this.guardRail = new GuardRail();
    this.cooldownManager = new CooldownManager();
  }

  /**
   * Ejecuta un batch de decisiones aprobadas por la IA.
   * Cada decisión pasa por safety check antes de ejecutarse.
   */
  async executeBatch(decisionDoc) {
    const decisions = decisionDoc.decisions || [];
    let approved = 0;
    let rejected = 0;
    let executed = 0;

    logger.info(`Procesando ${decisions.length} decisiones para ejecución`);

    for (const decision of decisions) {
      // Saltar no_action
      if (decision.action === 'no_action') continue;

      // Safety check
      const validation = await this.guardRail.validate(decision);

      // Guardar resultado del safety check en la decisión
      decision.safety_check = {
        approved: validation.approved,
        modified: validation.modified || false,
        reason: validation.reason,
        original_value: validation.modified ? decision.new_value : undefined
      };

      if (!validation.approved) {
        decision.recommendation_status = 'rejected';
        decision.reviewed_by = decision.reviewed_by || 'system_auto';
        decision.reviewed_at = decision.reviewed_at || new Date();
        rejected++;
        logger.info(`Rechazada: ${decision.action} en ${decision.entity_name} — ${validation.reason}`);
        continue;
      }

      approved++;
      decision.recommendation_status = 'approved';
      decision.reviewed_by = decision.reviewed_by || 'system_auto';
      decision.reviewed_at = decision.reviewed_at || new Date();

      // Si el safety guard modificó el valor, actualizar
      if (validation.modified && validation.adjustedValue != null) {
        decision.new_value = validation.adjustedValue;
        decision.change_percent = decision.current_value > 0
          ? ((validation.adjustedValue - decision.current_value) / decision.current_value) * 100
          : 0;
      }

      // Ejecutar la acción
      const result = await this._executeAction(decision, decisionDoc);
      if (result.success) {
        executed++;
        decision.recommendation_status = 'executed';
        decision.executed_at = new Date();

        // Establecer cooldown
        await this.cooldownManager.setCooldown(
          decision.entity_id,
          decision.entity_type,
          decision.action
        );
      }
    }

    // Actualizar estadísticas en el documento de decisión
    this._refreshDecisionStats(decisionDoc, { approved, rejected, executed });
    await decisionDoc.save();

    logger.info(`Ejecución completada: ${approved} aprobadas, ${rejected} rechazadas, ${executed} ejecutadas`);

    return { approved, rejected, executed };
  }

  /**
   * Ejecuta una recomendación individual (flujo manual approve/execute).
   */
  async executeSingle(decisionDoc, decisionItem, reviewer = 'admin') {
    if (!decisionItem) {
      throw new Error('Decisión individual no encontrada');
    }

    if (decisionItem.action === 'no_action') {
      throw new Error('no_action no es ejecutable');
    }

    if (decisionItem.recommendation_status === 'executed') {
      return { success: true, alreadyExecuted: true };
    }

    if (decisionItem.recommendation_status === 'rejected') {
      throw new Error('La recomendación está rechazada y no se puede ejecutar');
    }

    const validation = await this.guardRail.validate(decisionItem);
    decisionItem.safety_check = {
      approved: validation.approved,
      modified: validation.modified || false,
      reason: validation.reason,
      original_value: validation.modified ? decisionItem.new_value : undefined
    };

    if (!validation.approved) {
      decisionItem.recommendation_status = 'rejected';
      decisionItem.reviewed_by = reviewer;
      decisionItem.reviewed_at = new Date();
      this._refreshDecisionStatsFromDoc(decisionDoc);
      await decisionDoc.save();
      return { success: false, rejected: true, reason: validation.reason };
    }

    if (validation.modified && validation.adjustedValue != null) {
      decisionItem.new_value = validation.adjustedValue;
      decisionItem.change_percent = decisionItem.current_value > 0
        ? ((validation.adjustedValue - decisionItem.current_value) / decisionItem.current_value) * 100
        : 0;
    }

    decisionItem.recommendation_status = 'approved';
    decisionItem.reviewed_by = reviewer;
    decisionItem.reviewed_at = new Date();

    const result = await this._executeAction(decisionItem, decisionDoc);
    if (result.success) {
      decisionItem.recommendation_status = 'executed';
      decisionItem.executed_at = new Date();
      await this.cooldownManager.setCooldown(
        decisionItem.entity_id,
        decisionItem.entity_type,
        decisionItem.action
      );
    }

    this._refreshDecisionStatsFromDoc(decisionDoc);
    await decisionDoc.save();
    return { success: result.success };
  }

  /**
   * Ejecuta una acción individual.
   */
  async _executeAction(decision, decisionDoc) {
    const metricsAtExecution = await this._captureMetricsAtExecution(decision.entity_type, decision.entity_id);

    const actionLog = {
      decision_id: decisionDoc._id,
      cycle_id: decisionDoc.cycle_id,
      entity_type: decision.entity_type,
      entity_id: decision.entity_id,
      entity_name: decision.entity_name,
      campaign_id: decision.campaign_name, // referencia
      campaign_name: decision.campaign_name,
      action: decision.action,
      before_value: decision.current_value,
      after_value: decision.new_value,
      change_percent: decision.change_percent,
      reasoning: decision.reasoning,
      hypothesis: decision.hypothesis || '',
      decision_category: decision.decision_category || '',
      expected_impact_pct: Number(decision.expected_impact_pct || 0),
      risk_score: Number(decision.risk_score || 0),
      uncertainty_score: Number(decision.uncertainty_score || 0),
      confidence_score: Number(decision.confidence_score || 0),
      measurement_window_hours: Number(decision.measurement_window_hours || 72),
      evidence_points: Array.isArray(decision.rationale_evidence) ? decision.rationale_evidence : [],
      research_context: decision.research_context || '',
      confidence: decision.confidence,
      success: false,
      error: null,
      meta_api_response: null,
      metrics_at_execution: metricsAtExecution
    };

    try {
      let response;

      switch (decision.action) {
        case 'scale_up':
        case 'scale_down':
          if (decision.entity_type !== 'adset') {
            throw new Error(`Acción ${decision.action} solo soportada para adsets`);
          }
          response = await this.meta.updateBudget(decision.entity_id, decision.new_value);
          break;

        case 'pause':
          response = await this.meta.updateStatus(decision.entity_id, 'PAUSED');
          break;

        case 'reactivate':
          response = await this.meta.updateStatus(decision.entity_id, 'ACTIVE');
          break;

        case 'duplicate_adset':
          response = await this.meta.duplicateAdSet(decision.entity_id, {
            name: decision.duplicate_name || `[SCALE] ${decision.entity_name} - Copy`,
            daily_budget: decision.new_value || undefined
          });
          actionLog.new_entity_id = response.new_adset_id;
          if (decision.duplicate_strategy) {
            actionLog.duplicate_strategy = decision.duplicate_strategy;
          }
          break;

        case 'create_ad':
          response = await this._executeCreateAd(decision);
          actionLog.new_entity_id = response.ad_id;
          actionLog.creative_asset_id = decision.creative_asset_id;
          break;

        case 'update_bid_strategy':
          response = await this.meta.updateBidStrategy(
            decision.entity_id,
            decision.new_value,
            decision.bid_amount || null
          );
          break;

        case 'update_ad_status':
          response = await this.meta.updateAdStatus(
            decision.entity_id,
            decision.new_value
          );
          break;

        case 'move_budget':
          response = await this._executeMoveBudget(decision);
          actionLog.target_entity_id = decision.target_entity_id;
          actionLog.target_entity_name = decision.target_entity_name;
          break;

        case 'update_ad_creative':
          response = await this.meta.duplicateAd(decision.entity_id, {
            name: decision.duplicate_name || `${decision.entity_name} - New Creative`
          });
          actionLog.new_entity_id = response.new_ad_id;
          break;

        default:
          throw new Error(`Acción desconocida: ${decision.action}`);
      }

      actionLog.success = true;
      actionLog.meta_api_response = response;
      logger.info(`EJECUTADO: ${decision.action.toUpperCase()}: ${decision.entity_name} — ${this._describeAction(decision)}`);
    } catch (error) {
      actionLog.success = false;
      actionLog.error = error.message;
      logger.error(`Error ejecutando ${decision.action} en ${decision.entity_id}:`, error);
    }

    // Guardar log de acción
    let savedActionLog = null;
    try {
      savedActionLog = await ActionLog.create(actionLog);
    } catch (logError) {
      logger.error('Error guardando action log:', logError);
    }

    // Registrar AICreation para seguimiento exclusivo de entidades creadas por IA
    if (actionLog.success && savedActionLog && ['duplicate_adset', 'create_ad'].includes(decision.action)) {
      try {
        await this._registerAICreation(decision, actionLog, savedActionLog._id, metricsAtExecution);
      } catch (creationErr) {
        logger.error('Error registrando AICreation:', creationErr);
      }
    }

    return { success: actionLog.success };
  }

  /**
   * Registra una entidad creada por la IA para seguimiento exclusivo.
   */
  async _registerAICreation(decision, actionLog, actionLogId, metricsAtExecution) {
    const creation = {
      creation_type: decision.action,
      meta_entity_id: actionLog.new_entity_id,
      meta_entity_type: decision.action === 'duplicate_adset' ? 'adset' : 'ad',
      meta_entity_name: decision.action === 'duplicate_adset'
        ? (decision.duplicate_name || `[SCALE] ${decision.entity_name} - Copy`)
        : (decision.ad_name || 'AI Ad'),
      parent_entity_id: decision.entity_id,
      parent_entity_name: decision.entity_name || '',
      agent_type: decision.agent_type || 'scaling',
      reasoning: decision.reasoning || '',
      confidence: decision.confidence || 'medium',
      duplicate_strategy: decision.duplicate_strategy || null,
      creative_rationale: decision.creative_rationale || null,
      creative_asset_id: decision.creative_asset_id || null,
      ads_paused: Array.isArray(decision.ads_to_pause) ? decision.ads_to_pause : [],
      initial_budget: decision.new_value || 0,
      report_id: decision.report_id || null,
      action_log_id: actionLogId,
      parent_metrics_at_creation: {
        roas_7d: metricsAtExecution.roas_7d || 0,
        cpa_7d: metricsAtExecution.cpa_7d || 0,
        ctr: metricsAtExecution.ctr || 0,
        frequency: metricsAtExecution.frequency || 0,
        spend_7d: metricsAtExecution.spend_7d || 0,
        daily_budget: metricsAtExecution.daily_budget || 0
      },
      current_status: 'PAUSED'
    };

    await AICreation.create(creation);
    logger.info(`[AI_CREATION] Registrado: ${creation.creation_type} — ${creation.meta_entity_name} (${creation.meta_entity_id})`);
  }

  _refreshDecisionStats(decisionDoc, totals) {
    decisionDoc.approved_actions = totals.approved;
    decisionDoc.rejected_actions = totals.rejected;
    decisionDoc.executed_actions = totals.executed;
  }

  _refreshDecisionStatsFromDoc(decisionDoc) {
    const actionable = (decisionDoc.decisions || []).filter(d => d.action !== 'no_action');
    decisionDoc.total_actions = actionable.length;
    decisionDoc.approved_actions = actionable.filter(d =>
      ['approved', 'executed'].includes(d.recommendation_status)
    ).length;
    decisionDoc.rejected_actions = actionable.filter(d => d.recommendation_status === 'rejected').length;
    decisionDoc.executed_actions = actionable.filter(d => d.recommendation_status === 'executed').length;
  }

  async _captureMetricsAtExecution(entityType, entityId) {
    try {
      const preferredType = entityType === 'ad' ? 'ad' : 'adset';
      const typedSnapshots = await getLatestSnapshots(preferredType);
      let snapshot = typedSnapshots.find(s => s.entity_id === entityId);

      if (!snapshot) {
        const allSnapshots = await getLatestSnapshots();
        snapshot = allSnapshots.find(s => s.entity_type === preferredType && s.entity_id === entityId)
          || allSnapshots.find(s => s.entity_id === entityId);
      }

      if (!snapshot) {
        return {};
      }

      return {
        roas_7d: snapshot.metrics?.last_7d?.roas || 0,
        roas_3d: snapshot.metrics?.last_3d?.roas || 0,
        cpa_7d: snapshot.metrics?.last_7d?.cpa || 0,
        spend_today: snapshot.metrics?.today?.spend || 0,
        spend_7d: snapshot.metrics?.last_7d?.spend || 0,
        daily_budget: snapshot.daily_budget || 0,
        purchases_7d: snapshot.metrics?.last_7d?.purchases || 0,
        purchase_value_7d: snapshot.metrics?.last_7d?.purchase_value || 0,
        frequency: snapshot.metrics?.last_7d?.frequency || 0,
        ctr: snapshot.metrics?.last_7d?.ctr || 0
      };
    } catch (error) {
      logger.warn(`No se pudieron capturar métricas al ejecutar ${entityType}:${entityId} — ${error.message}`);
      return {};
    }
  }

  /**
   * Ejecuta la creación de un ad nuevo usando el banco de creativos.
   * Flujo: obtener asset → subir a Meta si necesario → crear creative → crear ad
   */
  async _executeCreateAd(decision) {
    const assetId = decision.creative_asset_id;
    if (!assetId) {
      throw new Error('creative_asset_id es requerido para create_ad');
    }

    const asset = await CreativeAsset.findById(assetId);
    if (!asset) {
      throw new Error(`Creative asset ${assetId} no encontrado en banco`);
    }

    // Subir imagen/video a Meta si no se ha subido antes
    if (!asset.uploaded_to_meta) {
      if (asset.media_type === 'image') {
        const upload = await this.meta.uploadImage(asset.file_path);
        asset.meta_image_hash = upload.image_hash;
      } else if (asset.media_type === 'video') {
        const upload = await this.meta.uploadVideo(asset.file_path);
        asset.meta_video_id = upload.video_id;
      }
      asset.uploaded_to_meta = true;
      asset.uploaded_at = new Date();
      await asset.save();
    }

    // Obtener page_id de la cuenta
    const pageId = await this.meta.getPageId();
    if (!pageId) {
      throw new Error('No se pudo obtener page_id de la cuenta');
    }

    // Crear el ad creative
    const creative = await this.meta.createAdCreative({
      page_id: pageId,
      image_hash: asset.meta_image_hash || undefined,
      video_id: asset.meta_video_id || undefined,
      headline: asset.headline,
      body: asset.body,
      description: asset.description || '',
      cta: asset.cta || 'SHOP_NOW',
      link_url: asset.link_url
    });

    // Crear el ad en el ad set destino — usar nombre generado por la IA
    const adName = decision.ad_name || decision.duplicate_name || `${asset.headline} - ${new Date().toISOString().split('T')[0]}`;
    const ad = await this.meta.createAd(
      decision.entity_id, // ad set ID
      creative.creative_id,
      adName,
      'PAUSED' // Siempre crear pausado
    );

    // Pausar ads fatigados que la IA identificó
    const pausedAds = [];
    if (Array.isArray(decision.ads_to_pause) && decision.ads_to_pause.length > 0) {
      for (const adId of decision.ads_to_pause) {
        try {
          await this.meta.updateAdStatus(adId, 'PAUSED');
          pausedAds.push(adId);
          logger.info(`Ad fatigado pausado: ${adId} (recomendado por IA al crear nuevo ad)`);
        } catch (pauseErr) {
          logger.warn(`No se pudo pausar ad fatigado ${adId}: ${pauseErr.message}`);
        }
      }
    }

    // Actualizar tracking del asset
    asset.times_used = (asset.times_used || 0) + 1;
    asset.used_in_ads.push(ad.ad_id);
    await asset.save();

    return {
      ad_id: ad.ad_id,
      creative_id: creative.creative_id,
      adset_id: decision.entity_id,
      name: adName,
      creative_rationale: decision.creative_rationale || null,
      paused_fatigued_ads: pausedAds
    };
  }

  /**
   * Ejecuta redistribución de budget: baja uno, sube otro.
   * El gasto total de la cuenta no cambia.
   */
  async _executeMoveBudget(decision) {
    const sourceId = decision.entity_id;
    const targetId = decision.target_entity_id;
    const amount = decision.new_value; // Monto a mover

    if (!targetId) {
      throw new Error('target_entity_id es requerido para move_budget');
    }

    // Obtener budgets actuales
    const snapshots = await getLatestSnapshots('adset');
    const sourceSnapshot = snapshots.find(s => s.entity_id === sourceId);
    const targetSnapshot = snapshots.find(s => s.entity_id === targetId);

    if (!sourceSnapshot || !targetSnapshot) {
      throw new Error('No se encontraron snapshots para source/target ad sets');
    }

    const sourceBudget = sourceSnapshot.daily_budget;
    const targetBudget = targetSnapshot.daily_budget;
    const newSourceBudget = Math.round((sourceBudget - amount) * 100) / 100;
    const newTargetBudget = Math.round((targetBudget + amount) * 100) / 100;

    if (newSourceBudget < 10) {
      throw new Error(`Budget de origen quedaría en $${newSourceBudget} (mínimo $10)`);
    }

    // Ejecutar ambos cambios
    const sourceResult = await this.meta.updateBudget(sourceId, newSourceBudget);
    const targetResult = await this.meta.updateBudget(targetId, newTargetBudget);

    return {
      source: { id: sourceId, before: sourceBudget, after: newSourceBudget, api: sourceResult },
      target: { id: targetId, before: targetBudget, after: newTargetBudget, api: targetResult },
      amount_moved: amount
    };
  }

  /**
   * Describe una acción en texto legible.
   */
  _describeAction(decision) {
    switch (decision.action) {
      case 'scale_up':
        return `Presupuesto $${decision.current_value} → $${decision.new_value} (+${Number(decision.change_percent || 0).toFixed(1)}%)`;
      case 'scale_down':
        return `Presupuesto $${decision.current_value} → $${decision.new_value} (${Number(decision.change_percent || 0).toFixed(1)}%)`;
      case 'pause':
        return `Pausado — ${decision.reasoning}`;
      case 'reactivate':
        return `Reactivado — ${decision.reasoning}`;
      case 'duplicate_adset':
        return `Duplicado ad set → ${decision.duplicate_name || 'Copy'}`;
      case 'create_ad':
        return `Nuevo ad creado en ad set`;
      case 'update_bid_strategy':
        return `Bid strategy → ${decision.new_value}`;
      case 'update_ad_status':
        return `Ad status → ${decision.new_value}`;
      case 'move_budget':
        return `$${decision.new_value} movido de ${decision.entity_name} → ${decision.target_entity_name}`;
      case 'update_ad_creative':
        return `Creative actualizado via duplicación`;
      default:
        return decision.reasoning;
    }
  }
}

module.exports = ActionExecutor;
