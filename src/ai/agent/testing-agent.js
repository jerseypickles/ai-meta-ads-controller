const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../../../config');
const logger = require('../../utils/logger');
const BrainMemory = require('../../db/models/BrainMemory');
const CreativeProposal = require('../../db/models/CreativeProposal');
const TestRun = require('../../db/models/TestRun');
const ActionLog = require('../../db/models/ActionLog');
const MetricSnapshot = require('../../db/models/MetricSnapshot');
const SystemConfig = require('../../db/models/SystemConfig');
const { getAdsForAdSet } = require('../../db/queries');

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURACION
// ═══════════════════════════════════════════════════════════════════════════════
const MAX_CONCURRENT_TESTS = 40;
const TEST_DAILY_BUDGET = 10; // $10/dia
const MAX_DAILY_TESTING_BUDGET = 400; // Cap diario total: $400 max en testing
const MAX_LAUNCHES_PER_CYCLE = 5; // Max tests nuevos por ciclo
const TEST_MAX_DAYS = 7;
const KILL_MIN_SPEND = 25;     // Kill si $25+ spend y 0 compras
const GRADUATED_BUDGET = 20;   // Budget al promover test ad set graduado ($20/dia)
const GRADUATE_MIN_ROAS = 2.0;
const GRADUATE_EARLY_ROAS = 3.0;
const GRADUATE_EARLY_PURCHASES = 2;
const GRADUATE_MIN_PURCHASES = 1;
const GRADUATE_MAX_CPA = 35;
const MIN_READY_POOL = 5;

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Obtener o crear la campana de testing.
 * Primera vez: crea campana en Meta y guarda ID en SystemConfig.
 * Siguientes: lee de SystemConfig.
 */
async function getTestingCampaignId() {
  // 1. Env var
  if (process.env.TESTING_CAMPAIGN_ID) return process.env.TESTING_CAMPAIGN_ID;

  // 2. SystemConfig
  const stored = await SystemConfig.get('testing_campaign_id', null);
  if (stored) return stored;

  // 3. Auto-crear
  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();
  const result = await meta.createCampaign({
    name: '[TESTING] Creative Testing Pipeline',
    objective: 'OUTCOME_SALES',
    status: 'ACTIVE',
    special_ad_categories: []
  });

  await SystemConfig.set('testing_campaign_id', result.campaign_id);
  logger.info(`[TESTING-AGENT] Campana de testing creada: ${result.campaign_id}`);
  return result.campaign_id;
}

/**
 * Calcular dias activos de un test.
 */
function getDaysActive(launchedAt) {
  return Math.floor((Date.now() - new Date(launchedAt).getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Obtener metricas de un test ad set desde MetricSnapshot.
 */
async function getTestMetrics(testAdsetId) {
  // Buscar los ultimos 5 snapshots y elegir el mejor (mas reciente con data real)
  // Meta API ocasionalmente devuelve ceros transitorios — no debemos confiar en 1 solo snapshot
  const snapshots = await MetricSnapshot.find({
    entity_type: 'adset',
    entity_id: testAdsetId
  }).sort({ snapshot_at: -1 }).limit(5).lean();

  if (!snapshots || snapshots.length === 0) return null;

  // Helper: detectar si un snapshot tiene data real (no ceros transitorios)
  const hasRealData = (snap) => {
    const m7 = snap.metrics?.last_7d || {};
    const m3 = snap.metrics?.last_3d || {};
    const mt = snap.metrics?.today || {};
    return (m7.spend || 0) > 0 || (m3.spend || 0) > 0 || (mt.spend || 0) > 0 || (m7.impressions || 0) > 0;
  };

  // Preferir el mas reciente con data real; fallback al mas reciente absoluto
  const snapshot = snapshots.find(hasRealData) || snapshots[0];

  // Usar la mejor ventana disponible
  const m = (snapshot.metrics?.last_7d?.spend > 0 && snapshot.metrics.last_7d)
         || (snapshot.metrics?.last_3d?.spend > 0 && snapshot.metrics.last_3d)
         || (snapshot.metrics?.today?.spend > 0 && snapshot.metrics.today)
         || null;

  if (!m) return { spend: 0, purchases: 0, roas: 0, cpa: 0, ctr: 0, impressions: 0, frequency: 0 };

  return {
    spend: m.spend || 0,
    purchases: m.purchases || 0,
    roas: m.roas || 0,
    cpa: m.cpa || 0,
    ctr: m.ctr || 0,
    cpm: m.cpm || 0,
    impressions: m.impressions || 0,
    clicks: m.clicks || 0,
    reach: m.reach || 0,
    frequency: snapshot.metrics?.last_7d?.frequency || snapshot.metrics?.last_3d?.frequency || m.frequency || 0,
    add_to_cart: m.add_to_cart || 0,
    initiate_checkout: m.initiate_checkout || 0
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE 1: LANZAR TESTS
// ═══════════════════════════════════════════════════════════════════════════════
async function launchTests() {
  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();

  // Verificar que la campana de testing existe y esta activa
  try {
    const campaignId = await getTestingCampaignId();
    const campaigns = await meta.getCampaigns();
    const testCampaign = campaigns.find(c => c.id === campaignId);
    if (testCampaign && testCampaign.status !== 'ACTIVE') {
      logger.warn(`[TESTING-AGENT] Campana de testing ${campaignId} esta ${testCampaign.status} — no se pueden lanzar tests`);
      return 0;
    }
  } catch (err) {
    logger.warn(`[TESTING-AGENT] No se pudo verificar campana de testing: ${err.message}`);
  }

  // Contar tests activos
  const activeTests = await TestRun.countDocuments({ phase: { $in: ['learning', 'evaluating'] } });
  const currentDailySpend = activeTests * TEST_DAILY_BUDGET;
  const availableSlots = Math.max(0, MAX_CONCURRENT_TESTS - activeTests);
  const budgetSlots = Math.max(0, Math.floor((MAX_DAILY_TESTING_BUDGET - currentDailySpend) / TEST_DAILY_BUDGET));
  const maxLaunches = Math.min(availableSlots, budgetSlots, MAX_LAUNCHES_PER_CYCLE);

  if (maxLaunches === 0) {
    if (availableSlots === 0) logger.info(`[TESTING-AGENT] ${activeTests} tests activos, max ${MAX_CONCURRENT_TESTS} — no hay slots`);
    else if (budgetSlots === 0) logger.info(`[TESTING-AGENT] Budget cap alcanzado: $${currentDailySpend}/$${MAX_DAILY_TESTING_BUDGET} diario`);
    return 0;
  }

  // Leer proposals "ready"
  const readyProposals = await CreativeProposal.find({ status: 'ready' })
    .sort({ created_at: 1 }) // las mas antiguas primero
    .limit(maxLaunches)
    .lean();

  if (readyProposals.length === 0) {
    logger.info('[TESTING-AGENT] No hay propuestas "ready" para testear');
    return 0;
  }

  // Contar tests activos por ad set destino
  const testCountByAdset = {};
  const existingTests = await TestRun.find({ phase: { $in: ['learning', 'evaluating'] } }).select('source_adset_id').lean();
  for (const t of existingTests) testCountByAdset[t.source_adset_id] = (testCountByAdset[t.source_adset_id] || 0) + 1;

  const MAX_TESTS_PER_ADSET = 2; // max 2 tests por ad set destino

  // Priorizar: ad sets con menos tests activos primero, skip si ya tiene 2+
  const prioritized = [];
  for (const proposal of readyProposals) {
    const currentTests = testCountByAdset[proposal.adset_id] || 0;
    if (proposal.adset_id !== 'proactive' && currentTests >= MAX_TESTS_PER_ADSET) {
      continue; // ya tiene suficientes tests
    }
    const ads = await getAdsForAdSet(proposal.adset_id);
    const activeAds = ads.filter(a => a.status === 'ACTIVE').length;
    prioritized.push({ proposal, activeAds, currentTests });
  }
  prioritized.sort((a, b) => a.activeAds - b.activeAds);

  // Obtener campaign + pixel
  const campaignId = await getTestingCampaignId();
  const pixelInfo = await meta.getPixelId();

  let launched = 0;

  for (const { proposal } of prioritized) {
    try {
      const testName = `[TEST] ${proposal.headline}`;

      // 1. Crear test ad set
      if (launched === 0) logger.info(`[TESTING-AGENT] pixelInfo: ${JSON.stringify(pixelInfo)}`);
      const adset = await meta.createAdSet({
        campaign_id: campaignId,
        name: testName,
        daily_budget: TEST_DAILY_BUDGET,
        optimization_goal: pixelInfo.optimization_goal || 'OFFSITE_CONVERSIONS',
        billing_event: pixelInfo.billing_event || 'IMPRESSIONS',
        bid_strategy: pixelInfo.bid_strategy || 'LOWEST_COST_WITHOUT_CAP',
        promoted_object: pixelInfo.promoted_object || { pixel_id: pixelInfo.pixel_id, custom_event_type: 'PURCHASE' },
        targeting: { geo_locations: { countries: ['US'] }, age_min: 18, age_max: 65 },
        status: 'ACTIVE'
      });

      // 2. Subir imagen — escribir base64 a temp file
      const tmpDir = path.join(os.tmpdir(), 'testing-agent');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      const tmpPath = path.join(tmpDir, `test_${proposal._id}.png`);
      fs.writeFileSync(tmpPath, Buffer.from(proposal.image_base64, 'base64'));

      const upload = await meta.uploadImage(tmpPath);

      // Limpiar temp file
      try { fs.unlinkSync(tmpPath); } catch (_) {}

      // 3. Crear ad creative
      const pageId = await meta.getPageId();
      const creative = await meta.createAdCreative({
        page_id: pageId,
        image_hash: upload.image_hash,
        headline: proposal.headline,
        body: proposal.primary_text,
        description: '',
        cta: 'SHOP_NOW',
        link_url: proposal.link_url || 'https://jerseypickles.com'
      });

      // 4. Crear ad
      const adName = `${proposal.headline} [TEST]`;
      const ad = await meta.createAd(adset.adset_id, creative.creative_id, adName, 'ACTIVE');

      // 5. Actualizar proposal
      await CreativeProposal.findByIdAndUpdate(proposal._id, {
        $set: { status: 'testing' }
      });

      // 6. Crear TestRun
      await TestRun.create({
        proposal_id: proposal._id,
        source_adset_id: proposal.adset_id,
        source_adset_name: proposal.adset_name,
        test_adset_id: adset.adset_id,
        test_adset_name: testName,
        test_ad_id: ad.ad_id,
        test_creative_id: creative.creative_id,
        campaign_id: campaignId,
        daily_budget: TEST_DAILY_BUDGET,
        max_days: TEST_MAX_DAYS,
        phase: 'learning',
        launched_at: new Date()
      });

      launched++;
      logger.info(`[TESTING-AGENT] Lanzado: "${proposal.headline}" para ${proposal.adset_name} → ${adset.adset_id}`);

    } catch (err) {
      const metaError = err.response?.data?.error;
      const detail = metaError ? `${metaError.message} (code: ${metaError.code}, subcode: ${metaError.error_subcode})` : err.message;
      logger.error(`[TESTING-AGENT] Error lanzando test para "${proposal.headline}": ${detail}`);
      if (metaError) logger.error(`[TESTING-AGENT] Meta error detail: ${JSON.stringify(metaError)}`);
      // Marcar como failed para no reintentar
      await CreativeProposal.findByIdAndUpdate(proposal._id, {
        $set: { status: 'failed', rejection_reason: `test launch failed: ${detail}` }
      });
    }
  }

  return launched;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE 2: MONITOREAR TESTS ACTIVOS
// ═══════════════════════════════════════════════════════════════════════════════
async function monitorTests() {
  const activeTests = await TestRun.find({
    phase: { $in: ['learning', 'evaluating'] }
  }).lean();

  if (activeTests.length === 0) return { monitored: 0, graduated: 0, killed: 0, expired: 0 };

  let graduated = 0, killed = 0, expired = 0;

  for (const test of activeTests) {
    try {
      const daysActive = getDaysActive(test.launched_at);
      const metrics = await getTestMetrics(test.test_adset_id);

      if (!metrics) {
        logger.debug(`[TESTING-AGENT] ${test.test_adset_name}: sin snapshots aun (dia ${daysActive})`);
        continue;
      }

      // PROTECCION: si las metricas nuevas vienen en ceros pero el TestRun ya tenia
      // data real, NO sobrescribir — Meta API ocasionalmente devuelve zeros transitorios
      const oldMetrics = test.metrics || {};
      const newIsZero = (metrics.spend || 0) === 0 && (metrics.impressions || 0) === 0;
      const oldHadData = (oldMetrics.spend || 0) > 0 || (oldMetrics.impressions || 0) > 0;
      if (newIsZero && oldHadData) {
        logger.warn(`[TESTING-AGENT] ${test.test_adset_name}: nuevas metricas en cero, manteniendo data previa ($${(oldMetrics.spend || 0).toFixed(2)} spend, ${oldMetrics.purchases || 0} compras)`);
        continue;
      }

      // Actualizar metricas en TestRun
      await TestRun.findByIdAndUpdate(test._id, {
        $set: { metrics: { ...metrics, updated_at: new Date() } }
      });

      // ── Dia 0-2: Learning — solo observar ──
      if (daysActive <= 2) {
        const assessment = `Dia ${daysActive}: $${metrics.spend.toFixed(2)} spend, ${metrics.purchases} compras, ROAS ${metrics.roas.toFixed(2)}x, ${metrics.clicks || 0} clicks, CTR ${metrics.ctr.toFixed(1)}%, ${metrics.add_to_cart || 0} ATC. Learning.`;
        await TestRun.findByIdAndUpdate(test._id, {
          $push: { assessments: { day_number: daysActive, phase: 'learning', assessment, metrics_snapshot: metrics } }
        });
        // Cambiar a evaluating si ya paso dia 2
        if (daysActive >= 2 && test.phase === 'learning') {
          await TestRun.findByIdAndUpdate(test._id, { $set: { phase: 'evaluating' } });
        }
        continue;
      }

      // ── Dia 3+: Evaluacion activa ──

      // KILL: 0 compras + gasto suficiente
      if (metrics.purchases === 0 && metrics.spend >= KILL_MIN_SPEND) {
        await killOrExpireTest(test, `0 compras con $${metrics.spend.toFixed(2)} spend, ${metrics.clicks || 0} clicks, ${metrics.add_to_cart || 0} ATC`, 'killed');
        killed++;
        continue;
      }

      // KILL TEMPRANO: alto spend + clicks pero 0 ATC (funnel roto — el creativo atrae pero no convierte)
      if (metrics.spend >= 15 && metrics.clicks >= 20 && metrics.add_to_cart === 0 && metrics.purchases === 0 && daysActive >= 3) {
        await killOrExpireTest(test, `Funnel roto: $${metrics.spend.toFixed(2)} spend, ${metrics.clicks} clicks, 0 ATC — creativo atrae pero no convierte`, 'killed');
        killed++;
        continue;
      }

      // GRADUATE EARLY: rendimiento excepcional
      if (metrics.roas >= GRADUATE_EARLY_ROAS && metrics.purchases >= GRADUATE_EARLY_PURCHASES) {
        await graduateTest(test, metrics);
        graduated++;
        continue;
      }

      // Dia 6-7: Decision final
      if (daysActive >= 6) {
        const meetsRoas = metrics.roas >= GRADUATE_MIN_ROAS;
        const meetsCpa = metrics.purchases >= GRADUATE_MIN_PURCHASES && metrics.cpa <= GRADUATE_MAX_CPA && metrics.cpa > 0;

        if (meetsRoas || meetsCpa) {
          await graduateTest(test, metrics);
          graduated++;
        } else {
          await killOrExpireTest(test, `Dia ${daysActive}: ROAS ${metrics.roas.toFixed(2)}x, ${metrics.purchases} compras, CPA $${metrics.cpa.toFixed(2)}`, 'expired');
          expired++;
        }
        continue;
      }

      // Dia 3-5: Kill agresivo — 1 compra + $40+ spend + ROAS < 2x = no va a mejorar
      if (daysActive >= 3 && metrics.purchases <= 1 && metrics.spend >= 40 && metrics.roas < 2.0) {
        await killOrExpireTest(test, `${metrics.purchases} compras con $${metrics.spend.toFixed(0)} spend, ROAS ${metrics.roas.toFixed(2)}x — CPA demasiado alto, no mejorara`, 'killed');
        killed++;
        continue;
      }

      // Dia 3-5: Esperar — guardar assessment
      const assessment = `Dia ${daysActive}: $${metrics.spend.toFixed(2)} spend, ${metrics.purchases} compras, ROAS ${metrics.roas.toFixed(2)}x, CTR ${metrics.ctr.toFixed(1)}%, ${metrics.add_to_cart || 0} ATC, freq ${metrics.frequency.toFixed(1)}. Evaluando.`;
      await TestRun.findByIdAndUpdate(test._id, {
        $set: { phase: 'evaluating' },
        $push: { assessments: { day_number: daysActive, phase: 'evaluating', assessment, metrics_snapshot: metrics } }
      });

    } catch (err) {
      logger.error(`[TESTING-AGENT] Error monitoreando ${test.test_adset_name}: ${err.message}`);
    }
  }

  return { monitored: activeTests.length, graduated, killed, expired };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GRADUACION
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Marca directivas force_graduate activas del mismo test como resueltas,
 * aunque Prometheus haya llegado al outcome por su cuenta (graduacion o kill natural).
 * Cierra el loop para Zeus: ve que su intuicion fue correcta (si fue graduada) o errada (si fue killed).
 */
async function _resolveForceGraduateDirectives(test, outcome, metrics) {
  const ZeusDirective = require('../../db/models/ZeusDirective');
  try {
    const proposal = test.proposal_id ? await CreativeProposal.findById(test.proposal_id).lean() : null;
    const headline = proposal?.headline || '';
    const testName = test.test_adset_name || '';

    // Match por adset_id (lo mas confiable — Zeus lo manda siempre) o por nombre/headline
    const matchers = [];
    if (test.test_adset_id) {
      matchers.push({ 'data.adset_id': test.test_adset_id });
      matchers.push({ 'data.test_adset_id': test.test_adset_id });
    }
    if (headline) matchers.push({ 'data.test_id': { $regex: headline.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } });
    if (testName) matchers.push({ 'data.test_id': { $regex: testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } });

    if (matchers.length === 0) return 0;

    const result = outcome === 'graduated'
      ? `graduated naturally (ROAS ${(metrics?.roas || 0).toFixed(2)}x, ${metrics?.purchases || 0} purchases) — Zeus called it right`
      : `${outcome} naturally (ROAS ${(metrics?.roas || 0).toFixed(2)}x, ${metrics?.purchases || 0} purchases) — Zeus directive bypassed by outcome`;

    const updated = await ZeusDirective.updateMany(
      {
        directive_type: 'force_graduate',
        active: true,
        executed: false,
        $or: matchers
      },
      {
        $set: {
          executed: true,
          executed_at: new Date(),
          execution_result: result
        }
      }
    );

    if (updated.modifiedCount > 0) {
      logger.info(`[TESTING-AGENT] Zeus directives cerradas para ${testName}: ${updated.modifiedCount} (${outcome})`);
    }
    return updated.modifiedCount;
  } catch (err) {
    logger.warn(`[TESTING-AGENT] No se pudo cerrar directivas force_graduate (non-fatal): ${err.message}`);
    return 0;
  }
}

async function graduateTest(test, metrics) {
  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();
  const proposal = await CreativeProposal.findById(test.proposal_id).lean();
  const adName = `${proposal?.headline || 'Graduated'} [AI Creative Agent]`;
  const daysActive = getDaysActive(test.launched_at);

  // ═══ GRADUACION: Solo promover test ad set como ad set nuevo de produccion ═══
  // NO crear ad en ad set original (Meta ignora ads nuevos en ad sets con ad viejo dominante)

  // 1. Promover test ad set: SOLO renombrar (NO cambiar budget — resetea Meta learning)
  // Athena escalará gradualmente (+15%) una vez que salga de learning
  const promotedName = `${proposal?.headline || 'Graduated'} [Prometheus]`;
  try {
    await meta.post(`/${test.test_adset_id}`, {
      name: promotedName
    });
    logger.info(`[TESTING-AGENT] Test ad set promovido: "${promotedName}" — budget se mantiene en $${TEST_DAILY_BUDGET}/dia (Athena escalará)`);
  } catch (err) {
    logger.warn(`[TESTING-AGENT] No se pudo promover test ad set: ${err.message}. Pausando en su lugar.`);
    await meta.updateStatus(test.test_adset_id, 'PAUSED');
  }

  // 2. Actualizar proposal
  await CreativeProposal.findByIdAndUpdate(test.proposal_id, {
    $set: {
      status: 'graduated',
      meta_creative_id: test.test_creative_id,
      meta_ad_name: promotedName,
      decided_at: new Date()
    }
  });

  // 3. Actualizar TestRun
  await TestRun.findByIdAndUpdate(test._id, {
    $set: {
      phase: 'graduated',
      graduated_at: new Date(),
      test_adset_name: promotedName,
      metrics: { ...metrics, updated_at: new Date() }
    },
    $push: {
      assessments: {
        day_number: daysActive,
        phase: 'graduated',
        assessment: `GRADUADO: ROAS ${metrics.roas.toFixed(2)}x, ${metrics.purchases} compras, $${metrics.spend.toFixed(2)} spend. Promovido como ad set de produccion "${promotedName}" a $${GRADUATED_BUDGET}/dia.`,
        metrics_snapshot: metrics
      }
    }
  });

  // 4. ActionLog
  await ActionLog.create({
    entity_type: 'adset',
    entity_id: test.test_adset_id,
    entity_name: promotedName,
    action: 'create_adset',
    after_value: promotedName,
    reasoning: `[TESTING-AGENT] Graduado: "${proposal?.headline}" — ROAS ${metrics.roas.toFixed(2)}x, ${metrics.purchases} compras en ${daysActive}d. Promovido como ad set nuevo a $${GRADUATED_BUDGET}/dia.`,
    confidence: 'high',
    agent_type: 'testing_agent',
    success: true,
    new_entity_id: test.test_adset_id
  });

  logger.info(`[TESTING-AGENT] GRADUADO: "${proposal?.headline}" → "${promotedName}" a $${GRADUATED_BUDGET}/dia`);

  // 5. Cerrar directivas force_graduate pendientes de Zeus para este test (aunque Prometheus llego primero)
  await _resolveForceGraduateDirectives(test, 'graduated', metrics);
}

// ═══════════════════════════════════════════════════════════════════════════════
// KILL / EXPIRE
// ═══════════════════════════════════════════════════════════════════════════════
async function killOrExpireTest(test, reason, phase) {
  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();

  // 1. Eliminar test ad set (DELETED para que no contamine snapshots)
  try {
    await meta.updateStatus(test.test_adset_id, 'DELETED');
  } catch (err) {
    // Fallback a PAUSED si DELETED falla
    try { await meta.updateStatus(test.test_adset_id, 'PAUSED'); } catch (_) {}
    logger.warn(`[TESTING-AGENT] No se pudo eliminar test ${test.test_adset_id}: ${err.message} — pausado`);
  }

  const now = new Date();

  // 2. Actualizar TestRun
  await TestRun.findByIdAndUpdate(test._id, {
    $set: {
      phase,
      [phase === 'killed' ? 'killed_at' : 'expired_at']: now,
      kill_reason: reason
    },
    $push: {
      assessments: {
        day_number: getDaysActive(test.launched_at),
        phase,
        assessment: `${phase.toUpperCase()}: ${reason}`,
        metrics_snapshot: test.metrics
      }
    }
  });

  // 3. Actualizar proposal
  await CreativeProposal.findByIdAndUpdate(test.proposal_id, {
    $set: { status: phase, rejection_reason: reason, decided_at: now }
  });

  // 4. Guardar feedback para Creative Agent (scene performance)
  try {
    const proposal = await CreativeProposal.findById(test.proposal_id).lean();
    if (proposal && !test.feedback_saved) {
      // Incrementar rejection count para la escena si fue killed
      // El Creative Agent lee esto al rankear escenas
      await TestRun.findByIdAndUpdate(test._id, { $set: { feedback_saved: true } });
    }
  } catch (_) {}

  logger.info(`[TESTING-AGENT] ${phase.toUpperCase()}: "${test.test_adset_name}" — ${reason}`);

  // Cerrar directivas force_graduate pendientes de Zeus para este test (Zeus pidio graduar pero Prometheus mato/expiro)
  await _resolveForceGraduateDirectives(test, phase, test.metrics);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE 3: VERIFICAR POOL DE PROPUESTAS
// ═══════════════════════════════════════════════════════════════════════════════
async function checkReadyPool() {
  const readyCount = await CreativeProposal.countDocuments({ status: 'ready' });

  if (readyCount < MIN_READY_POOL) {
    // Buscar ad sets con pocos ads que no esten flaggeados
    const activeAdsets = await MetricSnapshot.aggregate([
      { $match: { entity_type: 'adset', status: 'ACTIVE' } },
      { $sort: { entity_id: 1, snapshot_at: -1 } },
      { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } }
    ]);

    let flagged = 0;
    for (const adset of activeAdsets) {
      // Skipear ad sets de testing
      if ((adset.entity_name || '').startsWith('[TEST]')) continue;

      const ads = await getAdsForAdSet(adset.entity_id);
      const activeAds = ads.filter(a => a.status === 'ACTIVE').length;

      if (activeAds <= 1) {
        const mem = await BrainMemory.findOne({ entity_id: adset.entity_id }).lean();
        if (!mem?.agent_needs_new_creatives) {
          await BrainMemory.findOneAndUpdate(
            { entity_id: adset.entity_id },
            { $set: { agent_needs_new_creatives: true, last_updated_at: new Date() } },
            { upsert: true }
          );
          flagged++;
        }
      }
    }

    if (flagged > 0) {
      logger.info(`[TESTING-AGENT] Pool bajo (${readyCount} ready). Flaggeados ${flagged} ad sets para Creative Agent.`);
    }
  }

  return readyCount;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN: RUN TESTING AGENT
// ═══════════════════════════════════════════════════════════════════════════════
async function processForceGraduateDirectives() {
  const ZeusDirective = require('../../db/models/ZeusDirective');
  const directives = await ZeusDirective.find({
    target_agent: { $in: ['prometheus', 'all'] },
    directive_type: 'force_graduate',
    active: true,
    executed: false
  }).lean();

  if (directives.length === 0) return 0;

  let forced = 0;
  for (const d of directives) {
    try {
      const data = d.data || {};
      // Buscar el test por test_id (ObjectId), headline, adset_name o adset_id
      let test = null;
      if (data.test_id) {
        // Intentar como ObjectId primero
        if (/^[a-f\d]{24}$/i.test(data.test_id)) {
          test = await TestRun.findById(data.test_id).lean();
        }
        // Si no es ObjectId o no encontro, buscar por nombre/headline
        if (!test) {
          test = await TestRun.findOne({
            $or: [
              { test_adset_name: { $regex: data.test_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
              { test_adset_name: `[TEST] ${data.test_id}` }
            ],
            phase: { $in: ['learning', 'evaluating'] }
          }).lean();
        }
      }
      // Fallback: buscar por test_name (Zeus a veces usa este campo)
      if (!test && data.test_name) {
        const escaped = data.test_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        test = await TestRun.findOne({
          $or: [
            { test_adset_name: { $regex: escaped, $options: 'i' } },
            { test_adset_name: `[TEST] ${data.test_name}` }
          ],
          phase: { $in: ['learning', 'evaluating'] }
        }).lean();
      }
      // Fallback: buscar por directive text (Zeus parafrasea nombres)
      if (!test) {
        const words = d.directive.split(/\s+/).filter(w => w.length > 4 && !/ROAS|ready|convs|purchases|graduate/i.test(w)).slice(0, 5);
        if (words.length >= 2) {
          const pattern = words.join('.*');
          test = await TestRun.findOne({
            test_adset_name: { $regex: pattern, $options: 'i' },
            phase: { $in: ['learning', 'evaluating'] }
          }).lean();
        }
      }
      if (!test && (data.adset_id || data.test_adset_id)) {
        test = await TestRun.findOne({
          test_adset_id: data.adset_id || data.test_adset_id,
          phase: { $in: ['learning', 'evaluating'] }
        }).lean();
      }

      if (!test) {
        logger.warn(`[TESTING-AGENT] force_graduate: test no encontrado para directiva ${d._id}`);
        continue;
      }

      // Validacion minima: debe tener al menos 1 compra y ROAS >= 2x
      const m = test.metrics || {};
      if ((m.purchases || 0) < 1 || (m.roas || 0) < 2.0) {
        logger.warn(`[TESTING-AGENT] force_graduate denegado: ${test.test_adset_name} no cumple minimos (${m.purchases || 0} compras, ${(m.roas || 0).toFixed(2)}x ROAS)`);
        continue;
      }

      logger.info(`[TESTING-AGENT] FORCE GRADUATE [Zeus]: ${test.test_adset_name} con ${m.purchases} compras y ${m.roas.toFixed(2)}x ROAS`);
      await graduateTest(test, m);
      forced++;

      // Marcar directiva como executed
      await ZeusDirective.updateOne(
        { _id: d._id },
        { $set: { executed: true, executed_at: new Date(), execution_result: `force graduated ${test.test_adset_name}` } }
      );
    } catch (err) {
      logger.error(`[TESTING-AGENT] Error en force_graduate ${d._id}: ${err.message}`);
    }
  }

  if (forced > 0) {
    logger.info(`[TESTING-AGENT] Force graduations: ${forced} tests promovidos por orden de Zeus`);
  }
  return forced;
}

async function runTestingAgent() {
  const startTime = Date.now();
  const cycleId = `testing_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  logger.info(`═══ Iniciando Testing Agent [${cycleId}] ═══`);

  // Fase 0: Procesar force_graduate directives de Zeus (orden directa del CEO)
  const forceGraduated = await processForceGraduateDirectives();

  // Fase 1: Lanzar tests nuevos
  const launched = await launchTests();

  // Fase 2: Monitorear tests activos
  const { monitored, graduated, killed, expired } = await monitorTests();

  // Fase 3: Verificar pool de propuestas
  const readyPool = await checkReadyPool();

  const elapsed = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;

  logger.info(`═══ Testing Agent completado [${cycleId}]: ${launched} lanzados, ${monitored} monitoreados (${graduated} graduados, ${killed} killed, ${expired} expired), pool: ${readyPool} ready — ${elapsed} ═══`);

  // Reportar a Zeus con inteligencia real — clasificando por nivel de evidencia
  try {
    const ZeusConversation = require('../../db/models/ZeusConversation');

    // Analizar tests activos
    const activeTests = await TestRun.find({ phase: { $in: ['learning', 'evaluating'] } })
      .populate('proposal_id', 'scene_short headline')
      .lean();

    // Helper: calcular dias activos
    const ageInDays = (t) => (Date.now() - new Date(t.launched_at).getTime()) / 86400000;

    // Umbrales de confianza por tamano de muestra
    const VALIDATED_MIN_SPEND = 25;
    const VALIDATED_MIN_PURCHASES = 3;
    const VALIDATED_MIN_DAYS = 3;

    // Clasificar tests con compras en 2 niveles
    const testsWithPurchases = activeTests
      .filter(t => (t.metrics?.purchases || 0) >= 1)
      .sort((a, b) => (b.metrics?.roas || 0) - (a.metrics?.roas || 0));

    const validatedWinners = testsWithPurchases.filter(t => {
      const m = t.metrics || {};
      return (m.spend || 0) >= VALIDATED_MIN_SPEND
        && (m.purchases || 0) >= VALIDATED_MIN_PURCHASES
        && ageInDays(t) >= VALIDATED_MIN_DAYS
        && (m.roas || 0) >= 2.0;
    });

    const earlySignals = testsWithPurchases.filter(t => !validatedWinners.includes(t)).slice(0, 5);

    // Tests en peligro: funnel roto
    const funnelBroken = activeTests.filter(t => {
      const m = t.metrics || {};
      return (m.spend || 0) >= 10 && (m.add_to_cart || 0) === 0 && (m.purchases || 0) === 0;
    });

    // Patrones por escena — solo si hay muestra decente
    const byScene = {};
    activeTests.forEach(t => {
      const scene = t.proposal_id?.scene_short || 'unknown';
      if (!byScene[scene]) byScene[scene] = { count: 0, purchases: 0, spend: 0, revenue: 0 };
      byScene[scene].count++;
      byScene[scene].purchases += t.metrics?.purchases || 0;
      byScene[scene].spend += t.metrics?.spend || 0;
      byScene[scene].revenue += (t.metrics?.roas || 0) * (t.metrics?.spend || 0);
    });
    // Solo patrones con 2+ tests Y $20+ spend combinado (muestra minima)
    const scenePatterns = Object.entries(byScene)
      .filter(([_, d]) => d.count >= 2 && d.spend >= 20)
      .map(([scene, d]) => ({
        scene,
        count: d.count,
        purchases: d.purchases,
        spend: Math.round(d.spend),
        avg_roas: d.spend > 0 ? +(d.revenue / d.spend).toFixed(2) : 0
      }))
      .sort((a, b) => b.avg_roas - a.avg_roas);

    // Construir mensaje
    let msg = `Ciclo completado: ${launched} lanzados, ${monitored} monitoreados.`;
    if (forceGraduated > 0) msg += ` ${forceGraduated} FORCE-GRADUATED por orden de Zeus.`;
    if (graduated > 0) msg += ` ${graduated} GRADUADOS.`;
    if (killed > 0) msg += ` ${killed} killed.`;
    if (expired > 0) msg += ` ${expired} expirados.`;
    msg += ` Pool: ${readyPool} ready.`;

    // Contexto: la cuenta tiene 37 ad sets, varios con data historica larga.
    // BYB (39/40) son ejemplos recientes prometedores pero NO son "el ganador" unico.
    msg += `\n\nCONTEXTO: La cuenta tiene multiples ad sets con data historica. BYB (39/40) son ejemplos recientes del camino BYB con buen ROAS temprano — prometedores pero no son la unica verdad. Los ad sets viejos (dias 70+) tienen muestras mas grandes y representan la base real de la cuenta. No sesgar decisiones hacia 39/40 solo porque son visibles.`;

    if (validatedWinners.length > 0) {
      msg += `\n\nVALIDATED WINNERS (≥$${VALIDATED_MIN_SPEND} spend, ≥${VALIDATED_MIN_PURCHASES} compras, ≥${VALIDATED_MIN_DAYS}d):`;
      validatedWinners.forEach(t => {
        const m = t.metrics || {};
        const name = (t.test_adset_name || '').replace('[TEST] ', '').substring(0, 40);
        const age = ageInDays(t).toFixed(1);
        msg += `\n  - "${name}" ROAS ${(m.roas || 0).toFixed(2)}x, ${m.purchases || 0} compras, $${(m.spend || 0).toFixed(0)} spend, ${age}d`;
      });
    } else {
      msg += `\n\nNO hay tests validados aun (necesitan ≥$${VALIDATED_MIN_SPEND} spend + ≥${VALIDATED_MIN_PURCHASES} compras + ≥${VALIDATED_MIN_DAYS}d).`;
    }

    if (earlySignals.length > 0) {
      msg += `\n\nSENALES TEMPRANAS (muestra pequena — NO accionar todavia, necesitan mas data):`;
      earlySignals.forEach(t => {
        const m = t.metrics || {};
        const name = (t.test_adset_name || '').replace('[TEST] ', '').substring(0, 40);
        const age = ageInDays(t).toFixed(1);
        msg += `\n  - "${name}" ROAS ${(m.roas || 0).toFixed(2)}x, ${m.purchases || 0} compras, $${(m.spend || 0).toFixed(0)} spend, ${age}d (sample size bajo)`;
      });
    }

    if (funnelBroken.length > 0) {
      msg += `\n\nFUNNEL ROTO: ${funnelBroken.length} tests con $10+ spend y 0 ATC (posible problema de landing o product-market fit).`;
    }

    if (scenePatterns.length > 0) {
      const topScene = scenePatterns[0];
      if (topScene.avg_roas >= 3.0 && topScene.purchases >= 2) {
        msg += `\n\nPATRON EMERGENTE (no validado aun): escena "${topScene.scene}" con ${topScene.count} tests, ${topScene.avg_roas}x avg ROAS, ${topScene.purchases} compras combinadas. Senal interesante pero muestra pequena — esperar mas data antes de replicar.`;
      }
      const losers = scenePatterns.filter(s => s.spend >= 20 && s.purchases === 0);
      if (losers.length > 0) {
        msg += `\n\nESCENAS PERDEDORAS: ` + losers.slice(0, 3).map(s => `${s.scene} ($${s.spend}, 0 purchases)`).join(', ');
      }
    }

    if (readyPool < MIN_READY_POOL) msg += '\n\nPool bajo — Apollo debe generar mas.';

    await ZeusConversation.create({
      from: 'prometheus', to: 'zeus', type: 'report', message: msg, cycle_id: cycleId,
      context: {
        launched, monitored, graduated, killed, expired, pool: readyPool,
        validated_winners: validatedWinners.map(t => ({
          name: t.test_adset_name,
          roas: t.metrics?.roas || 0,
          purchases: t.metrics?.purchases || 0,
          spend: t.metrics?.spend || 0,
          days: +ageInDays(t).toFixed(1)
        })),
        early_signals: earlySignals.map(t => ({
          name: t.test_adset_name,
          roas: t.metrics?.roas || 0,
          purchases: t.metrics?.purchases || 0,
          spend: t.metrics?.spend || 0,
          days: +ageInDays(t).toFixed(1)
        })),
        funnel_broken_count: funnelBroken.length,
        scene_patterns: scenePatterns.slice(0, 5)
      }
    });
  } catch (err) {
    logger.warn(`[TESTING-AGENT] Error reportando a Zeus: ${err.message}`);
  }

  return {
    launched,
    monitored,
    graduated,
    killed,
    expired,
    ready_pool: readyPool,
    elapsed,
    cycle_id: cycleId
  };
}

module.exports = { runTestingAgent };
