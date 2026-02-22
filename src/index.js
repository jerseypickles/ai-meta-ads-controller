require('dotenv').config({ override: true });
const cron = require('node-cron');
const moment = require('moment-timezone');
const config = require('../config');
const safetyGuards = require('../config/safety-guards');
const db = require('./db/connection');
const DataCollector = require('./meta/data-collector');
const KillSwitch = require('./safety/kill-switch');
const AnomalyDetector = require('./safety/anomaly-detector');
const { CooldownManager } = require('./safety/cooldown-manager');
const UnifiedBrain = require('./ai/brain/unified-brain');
const { cleanupOldSnapshots, isAIEnabled, getPendingImpactMeasurement, getPending1dImpactMeasurement, getPending7dImpactMeasurement, getLatestSnapshots } = require('./db/queries');
const ActionLog = require('./db/models/ActionLog');
const AICreation = require('./db/models/AICreation');
const SystemConfig = require('./db/models/SystemConfig');
const LifecycleManager = require('./ai/lifecycle-manager');
const { runManager } = require('./ai/adset-creator/manager');
const { startDashboard } = require('./dashboard/server');
const { refreshMetaToken } = require('./dashboard/routes/meta-auth');
const { syncCreativeMetrics } = require('./dashboard/routes/creatives');
const logger = require('./utils/logger');

const TIMEZONE = config.system.timezone;

/**
 * Verifica si estamos dentro de las horas activas.
 */
function isActiveHours() {
  const now = moment().tz(TIMEZONE);
  const hour = now.hours();
  return hour >= safetyGuards.active_hours.start && hour < safetyGuards.active_hours.end;
}

/**
 * Job: Recolección de datos — cada 30 minutos durante horas activas.
 */
async function jobDataCollection() {
  if (!isActiveHours()) {
    logger.debug('Fuera de horas activas, saltando recolección de datos');
    return;
  }

  try {
    logger.info('[CRON] Iniciando recolección de datos...');
    const collector = new DataCollector();
    const result = await collector.collect();
    logger.info(`[CRON] Recolección completada: ${result.snapshots} snapshots en ${result.elapsed}`);
  } catch (error) {
    logger.error('[CRON] Error en recolección de datos:', error);
  }
}

/**
 * Job: Sync de métricas de creativos — actualiza avg_ctr y avg_roas
 * desde los snapshots de ads donde cada creativo ha sido usado.
 */
async function jobCreativeMetricsSync() {
  try {
    const result = await syncCreativeMetrics();
    if (result.discovered > 0 || result.synced > 0) {
      logger.info(`[CRON] Creative metrics sync: ${result.discovered || 0} links descubiertos, ${result.synced} actualizados, ${result.skipped} sin datos`);
    }
  } catch (error) {
    logger.error('[CRON] Error en sync de métricas de creativos:', error.message);
  }
}

/**
 * Job: Ciclo del Cerebro IA unificado.
 * Un solo cerebro que coordina todas las decisiones:
 * scaling, performance, creativos, pacing.
 * Se alimenta del historial de impacto de sus propias decisiones.
 * Auto-ejecucion segun modo de autonomia (manual/semi_auto/auto).
 */
async function jobAgentsCycle() {
  if (!isActiveHours()) {
    logger.debug('Fuera de horas activas, saltando ciclo del Cerebro IA');
    return;
  }

  const aiEnabled = await isAIEnabled();
  if (!aiEnabled) {
    logger.info('[CRON] IA desactivada — saltando ciclo del Cerebro IA');
    return;
  }

  try {
    logger.info('[CRON] Iniciando ciclo del Cerebro IA...');
    const brain = new UnifiedBrain();
    const result = await brain.runCycle();
    if (result) {
      logger.info(`[CRON] Cerebro IA completado en ${result.elapsed} — ${result.recommendations} recomendaciones, ${result.autoExecuted} auto-ejecutadas`);
    }
  } catch (error) {
    logger.error('[CRON] Error en ciclo del Cerebro IA:', error);
  }
}

/**
 * Job: Monitor del Kill Switch — cada 15 minutos.
 */
async function jobKillSwitchMonitor() {
  try {
    const ks = new KillSwitch();
    const result = await ks.monitor();

    if (result.triggered) {
      logger.error(`[CRON] KILL SWITCH: ${result.reason}`);
    }
  } catch (error) {
    logger.error('[CRON] Error en monitor de kill switch:', error);
  }
}

/**
 * Job: Detección de anomalías por entidad — cada 10 minutos.
 * Busca caídas bruscas de ROAS, spikes de gasto, y CPA explosivo
 * en entidades individuales. Pausa selectiva (no toda la cuenta).
 */
async function jobAnomalyDetection() {
  if (!isActiveHours()) return;

  try {
    const detector = new AnomalyDetector();
    const result = await detector.monitor();

    if (result.anomalies > 0) {
      logger.warn(`[CRON] Anomalías detectadas: ${result.anomalies}, pausadas: ${result.paused}`);
    }
  } catch (error) {
    logger.error('[CRON] Error en detección de anomalías:', error);
  }
}

/**
 * Job: Medición de impacto — cada 6 horas.
 * Busca acciones ejecutadas hace 3+ días que no han sido medidas,
 * y compara métricas antes vs ahora.
 */
async function jobMeasureImpact() {
  try {
    const snapshots = await getLatestSnapshots();
    const snapshotMap = new Map(
      snapshots.map(s => [`${s.entity_type}:${s.entity_id}`, s])
    );

    // Helper to extract metrics from snapshot
    const extractMetrics = (entitySnapshot) => ({
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
    });

    // Helper: for create_ad actions, also capture the new ad's own metrics
    const extractAdMetrics = (action, sMap) => {
      if (action.action !== 'create_ad' || !action.new_entity_id) return null;
      const adSnap = sMap.get(`ad:${action.new_entity_id}`);
      if (!adSnap) return null;
      const m7 = adSnap.metrics?.last_7d || {};
      const m3 = adSnap.metrics?.last_3d || {};
      return {
        ad_id: action.new_entity_id,
        ad_name: adSnap.entity_name || '',
        status: adSnap.status || 'UNKNOWN',
        spend_7d: m7.spend || 0,
        impressions_7d: m7.impressions || 0,
        clicks_7d: m7.clicks || 0,
        ctr_7d: m7.ctr || 0,
        roas_7d: m7.roas || 0,
        cpa_7d: m7.cpa || 0,
        purchases_7d: m7.purchases || 0,
        purchase_value_7d: m7.purchase_value || 0,
        frequency_7d: m7.frequency || 0,
        spend_3d: m3.spend || 0,
        roas_3d: m3.roas || 0,
        ctr_3d: m3.ctr || 0
      };
    };

    // Checkpoint 1: Medición a las 24 horas
    const pending1d = await getPending1dImpactMeasurement();
    let measured1d = 0;
    for (const action of pending1d) {
      const entityType = action.entity_type || 'adset';
      const entitySnapshot = snapshotMap.get(`${entityType}:${action.entity_id}`)
        || snapshotMap.get(`adset:${action.entity_id}`);
      if (!entitySnapshot) continue;

      const updates = {
        metrics_after_1d: extractMetrics(entitySnapshot),
        impact_1d_measured: true,
        impact_1d_measured_at: new Date()
      };
      // Capture ad-level metrics for create_ad
      const adMetrics = extractAdMetrics(action, snapshotMap);
      if (adMetrics) updates.ad_metrics_after_1d = adMetrics;

      await ActionLog.findByIdAndUpdate(action._id, updates);
      measured1d++;
    }

    // Checkpoint 2: Medición a los 3 días (final)
    const pending3d = await getPendingImpactMeasurement();
    let measured3d = 0;
    for (const action of pending3d) {
      const entityType = action.entity_type || 'adset';
      const entitySnapshot = snapshotMap.get(`${entityType}:${action.entity_id}`)
        || snapshotMap.get(`adset:${action.entity_id}`);
      if (!entitySnapshot) continue;

      const updates = {
        metrics_after_3d: extractMetrics(entitySnapshot),
        impact_measured: true,
        impact_measured_at: new Date()
      };
      const adMetrics = extractAdMetrics(action, snapshotMap);
      if (adMetrics) updates.ad_metrics_after_3d = adMetrics;

      await ActionLog.findByIdAndUpdate(action._id, updates);
      measured3d++;
    }

    // Checkpoint 3: Medición a los 7 días (atribución completa ~95%)
    const pending7d = await getPending7dImpactMeasurement();
    let measured7d = 0;
    for (const action of pending7d) {
      const entityType = action.entity_type || 'adset';
      const entitySnapshot = snapshotMap.get(`${entityType}:${action.entity_id}`)
        || snapshotMap.get(`adset:${action.entity_id}`);
      if (!entitySnapshot) continue;

      const updates = {
        metrics_after_7d: extractMetrics(entitySnapshot),
        impact_7d_measured: true,
        impact_7d_measured_at: new Date()
      };
      const adMetrics = extractAdMetrics(action, snapshotMap);
      if (adMetrics) updates.ad_metrics_after_7d = adMetrics;

      await ActionLog.findByIdAndUpdate(action._id, updates);
      measured7d++;
    }

    if (measured1d > 0 || measured3d > 0 || measured7d > 0) {
      logger.info(`[CRON] Impacto medido — 24h: ${measured1d}/${pending1d.length}, 3d: ${measured3d}/${pending3d.length}, 7d: ${measured7d}/${pending7d.length}`);
    } else {
      logger.debug('[CRON] Sin acciones pendientes de medición de impacto');
    }

    // === AICreation: medir metricas de entidades creadas por IA ===
    await jobMeasureAICreations(snapshotMap, extractMetrics);

  } catch (error) {
    logger.error('[CRON] Error midiendo impacto:', error);
  }
}

/**
 * Medir metricas de entidades creadas por la IA a 1d, 3d, 7d.
 * Calcula veredicto automatico despues de 7d.
 */
async function jobMeasureAICreations(snapshotMap, extractMetrics) {
  try {
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;

    // Buscar creaciones pendientes de medicion
    const pendingCreations = await AICreation.find({
      $or: [
        { measured_1d: false },
        { measured_3d: false },
        { measured_7d: false }
      ]
    }).lean();

    if (pendingCreations.length === 0) return;

    let measured = { d1: 0, d3: 0, d7: 0 };

    for (const creation of pendingCreations) {
      const elapsed = now - new Date(creation.created_at).getTime();
      const entityType = creation.meta_entity_type || 'adset';
      const snapshot = snapshotMap.get(`${entityType}:${creation.meta_entity_id}`)
        || snapshotMap.get(`adset:${creation.meta_entity_id}`)
        || snapshotMap.get(`ad:${creation.meta_entity_id}`);

      if (!snapshot) continue;

      const metrics = {
        roas_7d: snapshot.metrics?.last_7d?.roas || 0,
        cpa_7d: snapshot.metrics?.last_7d?.cpa || 0,
        ctr: snapshot.metrics?.last_7d?.ctr || 0,
        spend: snapshot.metrics?.last_7d?.spend || 0,
        impressions: snapshot.metrics?.last_7d?.impressions || 0,
        purchases: snapshot.metrics?.last_7d?.purchases || 0,
        frequency: snapshot.metrics?.last_7d?.frequency || 0
      };

      const updates = {};

      // 1 dia
      if (!creation.measured_1d && elapsed >= 1 * DAY_MS) {
        updates.metrics_1d = metrics;
        updates.measured_1d = true;
        updates.measured_1d_at = new Date();
        updates.current_status = snapshot.status || 'UNKNOWN';
        measured.d1++;
      }

      // 3 dias
      if (!creation.measured_3d && elapsed >= 3 * DAY_MS) {
        updates.metrics_3d = metrics;
        updates.measured_3d = true;
        updates.measured_3d_at = new Date();
        updates.current_status = snapshot.status || 'UNKNOWN';
        measured.d3++;
      }

      // 7 dias — calcular veredicto
      if (!creation.measured_7d && elapsed >= 7 * DAY_MS) {
        updates.metrics_7d = metrics;
        updates.measured_7d = true;
        updates.measured_7d_at = new Date();
        updates.current_status = snapshot.status || 'UNKNOWN';

        // Calcular veredicto comparando con metricas del padre al momento de crear
        const parentRoas = creation.parent_metrics_at_creation?.roas_7d || 0;
        const newRoas = metrics.roas_7d;

        if (metrics.spend < 1) {
          updates.verdict = 'neutral';
          updates.verdict_reason = 'Sin gasto significativo — no se puede evaluar';
        } else if (parentRoas > 0 && newRoas >= parentRoas * 0.8) {
          updates.verdict = 'positive';
          updates.verdict_reason = `ROAS ${newRoas.toFixed(1)}x vs padre ${parentRoas.toFixed(1)}x — decision positiva`;
        } else if (parentRoas > 0 && newRoas < parentRoas * 0.5) {
          updates.verdict = 'negative';
          updates.verdict_reason = `ROAS ${newRoas.toFixed(1)}x vs padre ${parentRoas.toFixed(1)}x — rendimiento bajo`;
        } else if (newRoas >= 1.5) {
          updates.verdict = 'positive';
          updates.verdict_reason = `ROAS ${newRoas.toFixed(1)}x — rentable`;
        } else if (newRoas < 0.8 && metrics.spend > 5) {
          updates.verdict = 'negative';
          updates.verdict_reason = `ROAS ${newRoas.toFixed(1)}x con $${metrics.spend.toFixed(0)} gasto — no rentable`;
        } else {
          updates.verdict = 'neutral';
          updates.verdict_reason = `ROAS ${newRoas.toFixed(1)}x — resultado mixto`;
        }

        measured.d7++;
      }

      if (Object.keys(updates).length > 0) {
        updates.updated_at = new Date();
        await AICreation.findByIdAndUpdate(creation._id, updates);
      }
    }

    if (measured.d1 > 0 || measured.d3 > 0 || measured.d7 > 0) {
      logger.info(`[CRON] AICreation medido — 1d: ${measured.d1}, 3d: ${measured.d3}, 7d: ${measured.d7}`);
    }
  } catch (error) {
    logger.error('[CRON] Error midiendo AICreations:', error);
  }
}

/**
 * Job: Lifecycle Manager — cada 30 minutos.
 * Gestiona el ciclo de vida de entidades creadas por la IA:
 * activate, learning phase, evaluate, scale/kill.
 */
async function jobLifecycleManager() {
  if (!isActiveHours()) {
    logger.debug('Fuera de horas activas, saltando lifecycle manager');
    return;
  }

  const aiEnabled = await isAIEnabled();
  if (!aiEnabled) return;

  try {
    const manager = new LifecycleManager();
    const result = await manager.run();
    if (result.processed > 0) {
      logger.info(`[CRON] Lifecycle manager: ${result.processed} creaciones procesadas`);
    }
  } catch (error) {
    logger.error('[CRON] Error en lifecycle manager:', error);
  }
}

/**
 * Job: AI Manager — cada 8 horas.
 * Claude revisa todos los ad sets que él creó (managed_by_ai: true)
 * y toma acciones autónomas: escalar, pausar ads, rotar creativos, matar.
 */
async function jobAIManager() {
  if (!isActiveHours()) {
    logger.debug('Fuera de horas activas, saltando AI Manager');
    return;
  }

  const aiEnabled = await isAIEnabled();
  if (!aiEnabled) {
    logger.info('[CRON] IA desactivada — saltando AI Manager');
    return;
  }

  try {
    logger.info('[CRON] Ejecutando AI Manager autónomo...');
    const result = await runManager();
    if (result.managed > 0) {
      logger.info(`[CRON] AI Manager: ${result.managed} ad sets revisados, ${result.actions_taken} acciones ejecutadas`);
    } else {
      logger.debug('[CRON] AI Manager: sin ad sets gestionados');
    }
  } catch (error) {
    logger.error('[CRON] Error en AI Manager:', error);
  }
}

/**
 * Job: Limpieza de snapshots antiguos — diario a las 2:00 AM.
 */
async function jobCleanup() {
  try {
    logger.info('[CRON] Iniciando limpieza de snapshots antiguos...');
    const deleted = await cleanupOldSnapshots(90);
    logger.info(`[CRON] Limpieza completada: ${deleted} snapshots eliminados`);

    // Limpiar cooldowns expirados
    const cooldownMgr = new CooldownManager();
    await cooldownMgr.cleanupExpired();
  } catch (error) {
    logger.error('[CRON] Error en limpieza:', error);
  }
}

/**
 * Job: Verificación y renovación automática del token — diario a las 3:00 AM.
 * Si el token expira en menos de 10 días, lo renueva automáticamente.
 */
async function jobTokenHealthCheck() {
  try {
    // Intentar renovar si está cerca de expirar (desde MongoDB)
    const refreshResult = await refreshMetaToken();
    logger.info(`[CRON] Token Meta: ${refreshResult.reason}`);

    // También verificar directamente con la API
    const { getMetaClient } = require('./meta/client');
    const meta = getMetaClient();
    await meta.reloadToken(); // Recargar por si se renovó

    const health = await meta.checkTokenHealth();

    if (!health.valid) {
      logger.error('[CRON] Token de Meta API inválido o expirado!');
    } else if (health.daysLeft < 7) {
      logger.warn(`[CRON] Token de Meta API expira en ${health.daysLeft} días!`);
    } else {
      logger.info(`[CRON] Token de Meta API OK — ${health.daysLeft === Infinity ? 'No expira' : `${health.daysLeft} días restantes`}`);
    }
  } catch (error) {
    logger.error('[CRON] Error verificando salud del token:', error);
  }
}

/**
 * Inicializa todos los cron jobs.
 */
function initCronJobs() {
  logger.info('Configurando cron jobs...');

  // Cada 15 minutos: Kill switch monitor
  cron.schedule('*/15 * * * *', jobKillSwitchMonitor, {
    timezone: TIMEZONE,
    name: 'kill-switch-monitor'
  });
  logger.info('  [*] Kill switch monitor — cada 15 min');

  // Cada 10 minutos: Detección de anomalías por entidad
  cron.schedule('*/10 * * * *', jobAnomalyDetection, {
    timezone: TIMEZONE,
    name: 'anomaly-detection'
  });
  logger.info('  [*] Detección de anomalías — cada 10 min (horas activas)');

  // Cada 10 minutos: Recolección de datos (horas activas)
  cron.schedule('*/10 * * * *', jobDataCollection, {
    timezone: TIMEZONE,
    name: 'data-collection'
  });
  logger.info('  [*] Recolección de datos — cada 10 min (horas activas)');

  // Cada 30 minutos (offset 15): Ciclo del Cerebro IA unificado
  cron.schedule('15,45 * * * *', jobAgentsCycle, {
    timezone: TIMEZONE,
    name: 'brain-cycle'
  });
  logger.info('  [*] Cerebro IA — cada 30 min (horas activas)');

  // Cada 30 minutos (offset 5): Lifecycle manager (activar, learning, escalar, matar)
  cron.schedule('5,35 * * * *', jobLifecycleManager, {
    timezone: TIMEZONE,
    name: 'lifecycle-manager'
  });
  logger.info('  [*] Lifecycle Manager IA — cada 30 min (horas activas)');

  // Cada 2 horas: Medición de impacto (24h y 3d checkpoints)
  cron.schedule('0 */2 * * *', jobMeasureImpact, {
    timezone: TIMEZONE,
    name: 'impact-measurement'
  });
  logger.info('  [*] Medición de impacto — cada 2 horas');

  // Cada 2 horas: AI Manager autónomo (ad sets creados por Claude)
  cron.schedule('0 */2 * * *', jobAIManager, {
    timezone: TIMEZONE,
    name: 'ai-manager'
  });
  logger.info('  [*] AI Manager autónomo — cada 2 horas (horas activas)');

  // Cada 6 horas: Sync de métricas de creativos (después de data collection)
  cron.schedule('30 */6 * * *', jobCreativeMetricsSync, {
    timezone: TIMEZONE,
    name: 'creative-metrics-sync'
  });
  logger.info('  [*] Creative metrics sync — cada 6 horas');

  // Diario 2:00 AM: Limpieza
  cron.schedule('0 2 * * *', jobCleanup, {
    timezone: TIMEZONE,
    name: 'cleanup'
  });
  logger.info('  [*] Limpieza de datos — diario 2:00 AM');

  // Diario 3:00 AM: Token health check
  cron.schedule('0 3 * * *', jobTokenHealthCheck, {
    timezone: TIMEZONE,
    name: 'token-health'
  });
  logger.info('  [*] Verificación de token — diario 3:00 AM');
}

/**
 * Punto de entrada principal.
 */
async function main() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   AI META ADS CONTROLLER                 ║');
  console.log('║   Jersey Pickles                         ║');
  console.log('╚══════════════════════════════════════════╝\n');

  try {
    // 1. Conectar a MongoDB
    await db.connect();
    logger.info('MongoDB conectado');

    // 1.5. Restaurar autonomía desde MongoDB
    const savedAutonomy = await SystemConfig.get('autonomy');
    if (savedAutonomy) {
      safetyGuards.autonomy = { ...savedAutonomy };
      const mode = savedAutonomy.mode || 'manual';
      logger.info(`[AUTONOMIA] Restaurada desde MongoDB: mode=${mode}`);
    } else {
      logger.info('[AUTONOMIA] Sin config guardada, usando defaults (manual)');
    }

    // 2. Iniciar cron jobs
    initCronJobs();

    // 3. Iniciar dashboard
    await startDashboard();

    // 4. Info del sistema
    const now = moment().tz(TIMEZONE);
    const aiEnabled = await isAIEnabled();
    logger.info('');
    logger.info('═══ Sistema iniciado ═══');
    logger.info(`  Hora: ${now.format('YYYY-MM-DD HH:mm:ss')} ET`);
    logger.info(`  Horas activas: ${safetyGuards.active_hours.start}:00 - ${safetyGuards.active_hours.end}:00 ET`);
    logger.info(`  Estado actual: ${isActiveHours() ? 'ACTIVO' : 'FUERA DE HORARIO'}`);
    logger.info(`  IA: ${aiEnabled ? 'ACTIVADA' : 'DESACTIVADA (solo recolección de datos)'}`);
    logger.info(`  Dashboard: http://localhost:${config.dashboard.port}`);
    logger.info(`  Meta API: ${config.meta.apiVersion}`);
    logger.info(`  Claude: ${config.claude.model}`);
    logger.info('  Cerebro IA: unificado (scaling + performance + creative + pacing) (cada 30min)');
    logger.info('  Lifecycle Manager: activate, learning, evaluate, scale/kill (cada 30min)');
    logger.info('  AI Manager: gestión autónoma de ad sets creados por Claude (cada 8h)');
    logger.info('  Acciones: scale_up/down, pause, duplicate, create_ad, move_budget, bid_strategy');
    logger.info(`  Autonomia: mode=${safetyGuards.autonomy.mode || 'manual'}`);
    logger.info('  Deep research: integrado en el cerebro (Brave/SERP API)');
    logger.info('');

    // 5. Ejecutar primera recolección de datos si estamos en horas activas
    if (isActiveHours()) {
      logger.info('Ejecutando primera recolección de datos...');
      setTimeout(jobDataCollection, 5000); // Esperar 5s para que todo se inicialice
    }

  } catch (error) {
    logger.error('Error fatal al iniciar el sistema:', error);
    process.exit(1);
  }
}

// Manejo de señales
process.on('SIGTERM', async () => {
  logger.info('SIGTERM recibido, cerrando...');
  await db.disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT recibido, cerrando...');
  await db.disconnect();
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection:', reason);
});

// Iniciar
main();
