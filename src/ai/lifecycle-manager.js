const AICreation = require('../db/models/AICreation');
const { getMetaClient } = require('../meta/client');
const { getLatestSnapshots } = require('../db/queries');
const kpiTargets = require('../../config/kpi-targets');
const logger = require('../utils/logger');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * AI Lifecycle Manager
 *
 * Gestiona el ciclo de vida completo de entidades creadas por la IA.
 * Fases: created -> activating -> learning -> evaluating -> scaling/stable/killing -> dead
 *
 * Corre cada 30 minutos via cron.
 */
class LifecycleManager {
  constructor() {
    this.meta = getMetaClient();
  }

  async run() {
    try {
      const activeCreations = await AICreation.find({
        lifecycle_phase: { $nin: ['dead'] }
      }).lean();

      if (activeCreations.length === 0) return { processed: 0 };

      const snapshots = await getLatestSnapshots();
      const snapshotMap = new Map();
      for (const s of snapshots) {
        snapshotMap.set(`${s.entity_type}:${s.entity_id}`, s);
      }

      let processed = 0;

      for (const creation of activeCreations) {
        try {
          await this._processCreation(creation, snapshotMap);
          processed++;
        } catch (err) {
          logger.error(`[LIFECYCLE] Error procesando ${creation.meta_entity_id}: ${err.message}`);
        }
      }

      if (processed > 0) {
        logger.info(`[LIFECYCLE] Procesadas ${processed} creaciones IA`);
      }

      return { processed };
    } catch (error) {
      logger.error('[LIFECYCLE] Error general:', error);
      return { processed: 0, error: error.message };
    }
  }

  async _processCreation(creation, snapshotMap) {
    const now = Date.now();
    const age = now - new Date(creation.created_at).getTime();

    // For managed_by_ai ad sets: Lifecycle Manager only handles early phases
    // (created → activating → learning → evaluating transition).
    // Post-learning decisions (scale, kill, optimize) are handled by Brain + AI Manager
    // which have full context (account-wide view, creative bank, trends, directives).
    const isManagedByAI = creation.managed_by_ai === true;

    switch (creation.lifecycle_phase) {
      case 'created':
        await this._handleCreated(creation, age);
        break;
      case 'activating':
        await this._handleActivating(creation, snapshotMap);
        break;
      case 'learning':
        await this._handleLearning(creation, snapshotMap);
        break;
      case 'evaluating':
        if (isManagedByAI) {
          // For AI-managed: just log, don't take actions. Brain + AI Manager decide.
          logger.debug(`[LIFECYCLE] ${creation.meta_entity_name} en evaluating — gestionado por Brain + AI Manager`);
        } else {
          await this._handleEvaluating(creation, snapshotMap);
        }
        break;
      case 'scaling':
      case 'stable':
        if (isManagedByAI) {
          // For AI-managed: don't override Brain/AI Manager decisions
          logger.debug(`[LIFECYCLE] ${creation.meta_entity_name} en ${creation.lifecycle_phase} — gestionado por Brain + AI Manager`);
        } else {
          await this._handleActive(creation, snapshotMap);
        }
        break;
      case 'killing':
        await this._handleKilling(creation);
        break;
    }
  }

  /**
   * CREATED: Esperar X horas, luego activar automaticamente.
   */
  async _handleCreated(creation, ageMs) {
    const activateAfter = (creation.activate_after_hours || 1) * HOUR_MS;

    if (ageMs >= activateAfter) {
      try {
        // Activar en Meta
        if (creation.meta_entity_type === 'adset') {
          await this.meta.updateStatus(creation.meta_entity_id, 'ACTIVE');
        } else {
          await this.meta.updateAdStatus(creation.meta_entity_id, 'ACTIVE');
        }

        const learningDays = creation.learning_phase_days || 3;
        const learningEnds = new Date(Date.now() + learningDays * DAY_MS);

        await this._updatePhase(creation, 'activating', 'activate', null,
          `Activado automaticamente despues de ${creation.activate_after_hours || 1}h`);

        await AICreation.findByIdAndUpdate(creation._id, {
          activated_at: new Date(),
          learning_ends_at: learningEnds,
          current_status: 'ACTIVE',
          current_budget: creation.initial_budget
        });

        logger.info(`[LIFECYCLE] Activado: ${creation.meta_entity_name} (learning hasta ${learningEnds.toISOString().split('T')[0]})`);
      } catch (err) {
        logger.error(`[LIFECYCLE] Error activando ${creation.meta_entity_id}: ${err.message}`);
      }
    }
  }

  /**
   * ACTIVATING: Verificar que realmente esta activo en Meta, pasar a learning.
   */
  async _handleActivating(creation, snapshotMap) {
    const snapshot = this._getSnapshot(creation, snapshotMap);

    // Si ya tiene impressions, esta corriendo — pasar a learning
    if (snapshot && (snapshot.metrics?.today?.impressions > 0 || snapshot.status === 'ACTIVE')) {
      await this._updatePhase(creation, 'learning', null, null,
        'Confirmado activo en Meta, iniciando learning phase');
    }

    // Si lleva mas de 6h en activating sin impressions, algo fallo
    const phaseAge = Date.now() - new Date(creation.lifecycle_phase_changed_at).getTime();
    if (phaseAge > 6 * HOUR_MS) {
      // Intentar activar de nuevo
      try {
        if (creation.meta_entity_type === 'adset') {
          await this.meta.updateStatus(creation.meta_entity_id, 'ACTIVE');
        } else {
          await this.meta.updateAdStatus(creation.meta_entity_id, 'ACTIVE');
        }
        logger.warn(`[LIFECYCLE] Re-activando ${creation.meta_entity_name} — no tenia impressions despues de 6h`);
      } catch (err) {
        logger.error(`[LIFECYCLE] Error re-activando: ${err.message}`);
      }
    }
  }

  /**
   * LEARNING: No tocar durante learning phase. Solo monitorear.
   * Si la learning phase termina, pasar a evaluating.
   */
  async _handleLearning(creation, snapshotMap) {
    const now = Date.now();
    const learningEnds = creation.learning_ends_at
      ? new Date(creation.learning_ends_at).getTime()
      : new Date(creation.created_at).getTime() + (creation.learning_phase_days || 3) * DAY_MS;

    if (now >= learningEnds) {
      await this._updatePhase(creation, 'evaluating', null, null,
        `Learning phase completada (${creation.learning_phase_days || 3} dias)`);
      logger.info(`[LIFECYCLE] Learning completada: ${creation.meta_entity_name} — evaluando rendimiento`);
    }
  }

  /**
   * EVALUATING: Learning termino. Evaluar metricas y decidir destino.
   */
  async _handleEvaluating(creation, snapshotMap) {
    const snapshot = this._getSnapshot(creation, snapshotMap);
    if (!snapshot) return;

    const metrics = this._extractMetrics(snapshot);
    const parentRoas = creation.parent_metrics_at_creation?.roas_7d || 0;

    // Decision basada en metricas
    if (metrics.roas >= kpiTargets.roas_minimum && metrics.spend > 5) {
      // Rindiendo bien
      if (metrics.roas >= kpiTargets.roas_excellent || (parentRoas > 0 && metrics.roas >= parentRoas)) {
        // Excelente — escalar (subir budget 20%)
        const newBudget = Math.round((creation.current_budget || creation.initial_budget) * 1.2 * 100) / 100;
        try {
          if (creation.meta_entity_type === 'adset') {
            await this.meta.updateBudget(creation.meta_entity_id, newBudget);
          }
          await this._updatePhase(creation, 'scaling', 'scale_up', newBudget,
            `ROAS ${metrics.roas.toFixed(1)}x excelente — escalando budget a $${newBudget}`);
          await AICreation.findByIdAndUpdate(creation._id, { current_budget: newBudget });
          logger.info(`[LIFECYCLE] Escalando: ${creation.meta_entity_name} — ROAS ${metrics.roas.toFixed(1)}x, budget $${newBudget}`);
        } catch (err) {
          logger.error(`[LIFECYCLE] Error escalando: ${err.message}`);
        }
      } else {
        // Aceptable — mantener estable
        await this._updatePhase(creation, 'stable', null, null,
          `ROAS ${metrics.roas.toFixed(1)}x aceptable — manteniendo`);
        logger.info(`[LIFECYCLE] Estable: ${creation.meta_entity_name} — ROAS ${metrics.roas.toFixed(1)}x`);
      }
    } else if (metrics.spend < 3) {
      // Muy poco gasto — esperar mas tiempo, volver a evaluar
      await this._updatePhase(creation, 'learning', null, null,
        `Spend $${metrics.spend.toFixed(0)} muy bajo para evaluar — extendiendo observacion`);
    } else {
      // Rindiendo mal — matar
      try {
        if (creation.meta_entity_type === 'adset') {
          await this.meta.updateStatus(creation.meta_entity_id, 'PAUSED');
        } else {
          await this.meta.updateAdStatus(creation.meta_entity_id, 'PAUSED');
        }
        await this._updatePhase(creation, 'killing', 'pause', null,
          `ROAS ${metrics.roas.toFixed(1)}x bajo minimo ${kpiTargets.roas_minimum}x con $${metrics.spend.toFixed(0)} gasto — pausando`);
        await AICreation.findByIdAndUpdate(creation._id, { current_status: 'PAUSED' });
        logger.info(`[LIFECYCLE] Matando: ${creation.meta_entity_name} — ROAS ${metrics.roas.toFixed(1)}x, pausado`);
      } catch (err) {
        logger.error(`[LIFECYCLE] Error pausando: ${err.message}`);
      }
    }
  }

  /**
   * SCALING/STABLE: Entidad activa y rindiendo. Monitoreo continuo.
   * Re-evaluar cada ciclo: escalar mas, mantener, o matar si empeora.
   */
  async _handleActive(creation, snapshotMap) {
    const snapshot = this._getSnapshot(creation, snapshotMap);
    if (!snapshot) return;

    const metrics = this._extractMetrics(snapshot);
    const phaseAge = Date.now() - new Date(creation.lifecycle_phase_changed_at).getTime();

    // Solo re-evaluar si paso al menos 1 dia desde ultimo cambio
    if (phaseAge < DAY_MS) return;

    if (metrics.roas < kpiTargets.roas_minimum && metrics.spend > 10) {
      // Se deterioro — matar
      try {
        if (creation.meta_entity_type === 'adset') {
          await this.meta.updateStatus(creation.meta_entity_id, 'PAUSED');
        } else {
          await this.meta.updateAdStatus(creation.meta_entity_id, 'PAUSED');
        }
        await this._updatePhase(creation, 'killing', 'pause', null,
          `ROAS cayo a ${metrics.roas.toFixed(1)}x — pausando`);
        await AICreation.findByIdAndUpdate(creation._id, { current_status: 'PAUSED' });
      } catch (err) {
        logger.error(`[LIFECYCLE] Error pausando en monitoreo: ${err.message}`);
      }
    } else if (creation.lifecycle_phase === 'scaling' && metrics.roas >= kpiTargets.roas_excellent) {
      // Sigue excelente — escalar mas (max +20% cada dia)
      const currentBudget = creation.current_budget || creation.initial_budget;
      const maxBudget = creation.initial_budget * 3; // No mas de 3x el budget original
      if (currentBudget < maxBudget) {
        const newBudget = Math.min(Math.round(currentBudget * 1.2 * 100) / 100, maxBudget);
        try {
          if (creation.meta_entity_type === 'adset') {
            await this.meta.updateBudget(creation.meta_entity_id, newBudget);
          }
          await this._updatePhase(creation, 'scaling', 'scale_up', newBudget,
            `ROAS ${metrics.roas.toFixed(1)}x sigue excelente — budget $${currentBudget} -> $${newBudget}`);
          await AICreation.findByIdAndUpdate(creation._id, { current_budget: newBudget });
        } catch (err) {
          logger.error(`[LIFECYCLE] Error escalando en monitoreo: ${err.message}`);
        }
      }
    } else if (creation.lifecycle_phase === 'stable' && metrics.roas >= kpiTargets.roas_excellent && metrics.spend > 10) {
      // Estaba stable pero ahora es excelente — promover a scaling
      const currentBudget = creation.current_budget || creation.initial_budget;
      const newBudget = Math.round(currentBudget * 1.15 * 100) / 100;
      try {
        if (creation.meta_entity_type === 'adset') {
          await this.meta.updateBudget(creation.meta_entity_id, newBudget);
        }
        await this._updatePhase(creation, 'scaling', 'scale_up', newBudget,
          `Promovido a scaling — ROAS ${metrics.roas.toFixed(1)}x, budget $${newBudget}`);
        await AICreation.findByIdAndUpdate(creation._id, { current_budget: newBudget });
      } catch (err) {
        logger.error(`[LIFECYCLE] Error promoviendo: ${err.message}`);
      }
    }
  }

  /**
   * KILLING: Entidad pausada. Marcar como dead despues de 1 dia.
   */
  async _handleKilling(creation) {
    const phaseAge = Date.now() - new Date(creation.lifecycle_phase_changed_at).getTime();
    if (phaseAge >= DAY_MS) {
      await this._updatePhase(creation, 'dead', null, null, 'Marcado como dead definitivo');
    }
  }

  // ---- HELPERS ----

  _getSnapshot(creation, snapshotMap) {
    return snapshotMap.get(`${creation.meta_entity_type}:${creation.meta_entity_id}`)
      || snapshotMap.get(`adset:${creation.meta_entity_id}`)
      || snapshotMap.get(`ad:${creation.meta_entity_id}`);
  }

  _extractMetrics(snapshot) {
    return {
      roas: snapshot.metrics?.last_7d?.roas || snapshot.metrics?.last_3d?.roas || 0,
      cpa: snapshot.metrics?.last_7d?.cpa || 0,
      ctr: snapshot.metrics?.last_7d?.ctr || 0,
      spend: snapshot.metrics?.last_7d?.spend || snapshot.metrics?.last_3d?.spend || 0,
      impressions: snapshot.metrics?.last_7d?.impressions || 0,
      frequency: snapshot.metrics?.last_7d?.frequency || 0,
      purchases: snapshot.metrics?.last_7d?.purchases || 0
    };
  }

  async _updatePhase(creation, newPhase, actionType, value, reason) {
    const updates = {
      lifecycle_phase: newPhase,
      lifecycle_phase_changed_at: new Date(),
      updated_at: new Date()
    };

    if (actionType) {
      updates.$push = {
        lifecycle_actions: {
          action: actionType,
          value: value,
          reason: reason,
          executed_at: new Date()
        }
      };
    }

    // Use $set for normal fields, $push separately
    const setFields = { ...updates };
    delete setFields.$push;

    if (updates.$push) {
      await AICreation.findByIdAndUpdate(creation._id, {
        $set: setFields,
        $push: updates.$push
      });
    } else {
      await AICreation.findByIdAndUpdate(creation._id, { $set: setFields });
    }
  }
}

module.exports = LifecycleManager;
