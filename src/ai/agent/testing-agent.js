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
const MAX_CONCURRENT_TESTS = 20;
const TEST_DAILY_BUDGET = 10; // $10/dia
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
  // Buscar snapshot del ad set de test
  const snapshot = await MetricSnapshot.findOne({
    entity_type: 'adset',
    entity_id: testAdsetId
  }).sort({ snapshot_at: -1 }).lean();

  if (!snapshot) return null;

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
    impressions: m.impressions || 0,
    frequency: snapshot.metrics?.last_7d?.frequency || snapshot.metrics?.last_3d?.frequency || 0
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE 1: LANZAR TESTS
// ═══════════════════════════════════════════════════════════════════════════════
async function launchTests() {
  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();

  // Contar tests activos
  const activeTests = await TestRun.countDocuments({ phase: { $in: ['learning', 'evaluating'] } });
  const availableSlots = Math.max(0, MAX_CONCURRENT_TESTS - activeTests);

  if (availableSlots === 0) {
    logger.info(`[TESTING-AGENT] ${activeTests} tests activos, max ${MAX_CONCURRENT_TESTS} — no hay slots`);
    return 0;
  }

  // Leer proposals "ready"
  const readyProposals = await CreativeProposal.find({ status: 'ready' })
    .sort({ created_at: 1 }) // las mas antiguas primero
    .limit(availableSlots)
    .lean();

  if (readyProposals.length === 0) {
    logger.info('[TESTING-AGENT] No hay propuestas "ready" para testear');
    return 0;
  }

  // Priorizar: ad sets con menos ads activos primero
  const prioritized = [];
  for (const proposal of readyProposals) {
    const ads = await getAdsForAdSet(proposal.adset_id);
    const activeAds = ads.filter(a => a.status === 'ACTIVE').length;
    prioritized.push({ proposal, activeAds });
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

      // Actualizar metricas en TestRun
      await TestRun.findByIdAndUpdate(test._id, {
        $set: { metrics: { ...metrics, updated_at: new Date() } }
      });

      // ── Dia 0-2: Learning — solo observar ──
      if (daysActive <= 2) {
        const assessment = `Dia ${daysActive}: $${metrics.spend.toFixed(2)} spend, ${metrics.purchases} compras, ROAS ${metrics.roas.toFixed(2)}x. Learning phase.`;
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
        await killOrExpireTest(test, `0 compras con $${metrics.spend.toFixed(2)} spend`, 'killed');
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

      // Dia 3-5: Esperar — guardar assessment
      const assessment = `Dia ${daysActive}: $${metrics.spend.toFixed(2)} spend, ${metrics.purchases} compras, ROAS ${metrics.roas.toFixed(2)}x. Evaluando.`;
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
async function graduateTest(test, metrics) {
  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();
  const proposal = await CreativeProposal.findById(test.proposal_id).lean();
  const adName = `${proposal?.headline || 'Graduated'} [AI Creative Agent]`;
  const daysActive = getDaysActive(test.launched_at);

  // ═══ OPCION C: Ad en ad set original + promover test ad set ═══
  const isProactive = test.source_adset_id === 'proactive';

  // 1. Crear ad en el ad set ORIGINAL (solo si no es proactivo)
  let ad = null;
  if (!isProactive) {
    ad = await meta.createAd(test.source_adset_id, test.test_creative_id, adName, 'ACTIVE');
  }

  // 2. Promover test ad set: renombrar + subir budget (NO pausar)
  const promotedName = `${proposal?.headline || 'Graduated'} [Prometheus]`;
  try {
    await meta.post(`/${test.test_adset_id}`, {
      name: promotedName,
      daily_budget: Math.round(GRADUATED_BUDGET * 100) // centavos
    });
    logger.info(`[TESTING-AGENT] Test ad set promovido: "${promotedName}" → $${GRADUATED_BUDGET}/dia`);
  } catch (err) {
    logger.warn(`[TESTING-AGENT] No se pudo promover test ad set: ${err.message}. Pausando en su lugar.`);
    await meta.updateStatus(test.test_adset_id, 'PAUSED');
  }

  // 3. Limpiar flag needs_new_creatives (solo si no es proactivo)
  if (!isProactive) {
    await BrainMemory.findOneAndUpdate(
      { entity_id: test.source_adset_id },
      { $set: { agent_needs_new_creatives: false, last_updated_at: new Date() } }
    );
  }

  // 4. Actualizar proposal
  await CreativeProposal.findByIdAndUpdate(test.proposal_id, {
    $set: {
      status: 'graduated',
      meta_ad_id: ad?.ad_id || null,
      meta_creative_id: test.test_creative_id,
      meta_ad_name: adName,
      decided_at: new Date()
    }
  });

  // 5. Actualizar TestRun
  await TestRun.findByIdAndUpdate(test._id, {
    $set: {
      phase: 'graduated',
      graduated_at: new Date(),
      graduation_target_ad_id: ad?.ad_id || null,
      test_adset_name: promotedName,
      metrics: { ...metrics, updated_at: new Date() }
    },
    $push: {
      assessments: {
        day_number: daysActive,
        phase: 'graduated',
        assessment: isProactive
          ? `GRADUADO (proactivo): ROAS ${metrics.roas.toFixed(2)}x, ${metrics.purchases} compras, $${metrics.spend.toFixed(2)} spend. Ad set promovido a $${GRADUATED_BUDGET}/dia como nuevo ad set de produccion.`
          : `GRADUADO: ROAS ${metrics.roas.toFixed(2)}x, ${metrics.purchases} compras, $${metrics.spend.toFixed(2)} spend. Ad en ${test.source_adset_name} + test promovido a $${GRADUATED_BUDGET}/dia.`,
        metrics_snapshot: metrics
      }
    }
  });

  // 6. ActionLog
  await ActionLog.create({
    entity_type: 'adset',
    entity_id: isProactive ? test.test_adset_id : test.source_adset_id,
    entity_name: isProactive ? promotedName : test.source_adset_name,
    action: isProactive ? 'create_adset' : 'create_ad',
    after_value: isProactive ? promotedName : adName,
    reasoning: isProactive
      ? `[TESTING-AGENT] Graduado proactivo: "${proposal?.headline}" — ROAS ${metrics.roas.toFixed(2)}x, ${metrics.purchases} compras en ${daysActive}d. Nuevo ad set de produccion a $${GRADUATED_BUDGET}/dia.`
      : `[TESTING-AGENT] Graduado: "${proposal?.headline}" — ROAS ${metrics.roas.toFixed(2)}x, ${metrics.purchases} compras en ${daysActive}d. Ad en original + test promovido a $${GRADUATED_BUDGET}/dia.`,
    confidence: 'high',
    agent_type: 'testing_agent',
    success: true,
    new_entity_id: ad?.ad_id || test.test_adset_id
  });

  logger.info(`[TESTING-AGENT] GRADUADO${isProactive ? ' (proactivo)' : ''}: "${proposal?.headline}" → ${isProactive ? 'nuevo ad set' : 'ad en ' + test.source_adset_name} + "${promotedName}" a $${GRADUATED_BUDGET}/dia`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// KILL / EXPIRE
// ═══════════════════════════════════════════════════════════════════════════════
async function killOrExpireTest(test, reason, phase) {
  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();

  // 1. Pausar test ad set
  try {
    await meta.updateStatus(test.test_adset_id, 'PAUSED');
  } catch (err) {
    logger.warn(`[TESTING-AGENT] No se pudo pausar test ${test.test_adset_id}: ${err.message}`);
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
async function runTestingAgent() {
  const startTime = Date.now();
  const cycleId = `testing_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  logger.info(`═══ Iniciando Testing Agent [${cycleId}] ═══`);

  // Fase 1: Lanzar tests nuevos
  const launched = await launchTests();

  // Fase 2: Monitorear tests activos
  const { monitored, graduated, killed, expired } = await monitorTests();

  // Fase 3: Verificar pool de propuestas
  const readyPool = await checkReadyPool();

  const elapsed = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;

  logger.info(`═══ Testing Agent completado [${cycleId}]: ${launched} lanzados, ${monitored} monitoreados (${graduated} graduados, ${killed} killed, ${expired} expired), pool: ${readyPool} ready — ${elapsed} ═══`);

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
