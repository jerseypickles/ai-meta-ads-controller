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
const MAX_CONCURRENT_TESTS = parseInt(process.env.MAX_CONCURRENT_TESTS, 10) || 24; // 2026-06-09: 40→12. 2026-06-14: 12→15 (drenaje). 2026-06-15: 15→24 (DRENAJE FUERTE): pipeline saltó a 235 imgs ready; el creador pidió lanzar 10-12 adsets nuevos. 24 = 11 reales activos + ~13 nuevos. Cuadra con cap $1200 (24×$50). REVERTIR a 12 cuando el pipeline baje.
const TEST_DAILY_BUDGET = parseInt(process.env.TEST_DAILY_BUDGET, 10) || 50; // 2026-06-09: $20→$50/día — cada test llega a significancia de CONVERSIÓN (≈2x CPA) → veredicto decisivo rápido. Env-overridable.
const DECISIVE_KILL_SPEND = parseInt(process.env.DECISIVE_KILL_SPEND, 10) || 50; // $ de spend con 0 compras = perdedor decisivo (≈2x CPA). Mata por significancia, no por días.
// 2026-06-09: $25→$35 · 2026-06-10: $35→$50 (pedido del creador) — paridad con foto y
// matemática redonda: a $50/día el kill decisivo ($50/0 compras) llega en el DÍA 1, y
// con CPA $25 espera ~2 compras/día → la graduación (≥2 compras) puede resolverse en
// 24-48h con señal real. El video lo justifica de sobra (4.85x ROAS, 76% de las ventas).
// Los perdedores NO cuestan más: las kill rules son por spend acumulado. Env-overridable.
const VIDEO_TEST_DAILY_BUDGET = parseInt(process.env.VIDEO_TEST_DAILY_BUDGET, 10) || 50; // 2026-06-21: $70→$50 (pedido del creador: máximo $50). Con 2-por-adset = $25/video.
// Track de VIDEO con caps PROPIOS — no compite por los slots/budget de las fotos
// (campaña separada). Si no, los tests de foto bloquean los videos. (2026-05-30)
// 2026-06-05 "Dionisio extremo": el video probó ser el lever más fuerte (4.85x ROAS,
// CPM $14, 76% de las ventas). Subimos los caps de VIDEO fuerte (la economía lo justifica).
// Foto queda igual (1.96x, no merece más volumen).
// 2026-06-11: 24→30 + env-overridable — con la cola llena de tests viejos baratos
// ($25-35) el cap de concurrencia bloqueaba los aprobados nuevos aunque el budget
// tenía espacio ($725/$900). El cap de $900/día sigue siendo el guardián del gasto.
const MAX_CONCURRENT_VIDEO_TESTS = parseInt(process.env.MAX_CONCURRENT_VIDEO_TESTS, 10) || 30;
// Cap diario TOTAL de video: $600→$900 (2026-06-10, "metele más testeo"). A $50/test son
// 18 slots concurrentes, alineado con Dionisio a 4x/día × 8/ciclo. El video es el lever
// más fuerte (4.85x, 76% de las ventas) — el cap es techo, no compromiso: solo se llena
// si hay videos aprobados que testear. Env-overridable.
const MAX_DAILY_VIDEO_TESTING_BUDGET = parseInt(process.env.MAX_DAILY_VIDEO_TESTING_BUDGET, 10) || 1300; // 2026-06-17: 900→1300 — el creador aprueba video activamente (experimento persona) y el cap de $900 tapaba los recién aprobados ($790/$900 = 1 slot). Video es el formato fuerte (2.96x). Env-overridable.
const MAX_DAILY_TESTING_BUDGET = parseInt(process.env.MAX_DAILY_TESTING_BUDGET, 10) || 1200; // Cap diario FOTO. 2026-06-03: 1000→400 · 2026-06-14: 400→500→750 · 2026-06-15: 750→1200 (DRENAJE FUERTE: 235 imgs ready, lanzar 10-12 adsets nuevos; cuadra con concurrencia 24 × $50). El cap no se gasta entero: solo entran grupos completos de 3 mientras hay slot. REVERTIR a ~400 post-drenaje. Env-overridable.
const MAX_LAUNCHES_PER_CYCLE = parseInt(process.env.MAX_LAUNCHES_PER_CYCLE, 10) || 12; // 2026-06-05: 3→6. 2026-06-15: 6→12 (DRENAJE FUERTE: lanzar 10-12 adsets de foto en un ciclo para vaciar las 235 imgs ready). REVERTIR a 6 post-drenaje.
// MULTI-AD foto (2026-06-13): N creativos del MISMO producto por adset → Meta hace el
// A/B/C interno con los mismos $50. Aprovecha mejor el budget de un formato flojo.
// Env: PHOTO_ADS_PER_ADSET.
const PHOTO_ADS_PER_ADSET = Math.max(1, parseInt(process.env.PHOTO_ADS_PER_ADSET, 10) || 3);
// VIDEO: 2-por-adset (2026-06-16, decisión del creador). Video es el formato fuerte
// (2.96x) pero escaso y caro → NO se aprieta a 3 (ahogaría cada video). Con 2 se obtiene
// la señal HEAD-TO-HEAD limpia (A/B controlado, más valiosa para video porque su señal
// es ruidosa) sin starvear: el budget por-adset se sube a $70 → $35/video. Env-overridable.
const VIDEO_ADS_PER_ADSET = Math.max(1, parseInt(process.env.VIDEO_ADS_PER_ADSET, 10) || 2);
const TEST_MAX_DAYS = 7;
const KILL_MIN_SPEND = 25;     // Kill si $25+ spend y 0 compras
const GRADUATED_BUDGET = 20;   // Budget al promover test ad set graduado ($20/dia)
const GRADUATE_MIN_ROAS = 2.0;
const GRADUATE_EARLY_ROAS = 3.0;
const GRADUATE_EARLY_PURCHASES = 2;
// 2026-06-05: piso de spend para graduación TEMPRANA. 2 compras sobre $8.90 (ROAS 14x)
// es un fluke frontloaded, no un winner (caso "Snack Break 🥒": graduó así y murió).
// Exigir spend real garantiza que la señal se sostuvo sobre volumen, no 2 ventas de suerte.
const GRADUATE_EARLY_MIN_SPEND = 30;
const GRADUATE_MIN_PURCHASES = 2;  // 2026-05-26: 1→2. Graduar con 1 compra era ruido (fluke) → graduates débiles que Ares escalaba y revertían. Ahora exigido en AMBOS paths (antes meetsRoas no pedía mínimo).
const GRADUATE_MAX_CPA = 35;
// 2026-06-20: gates anti "kill a media jornada mientras produce" (caso Sweet Horseradish:
// expirado 20:30 ET con cumulative 1.54x cuando HOY venía a 5.69x / 4 ventas).
//  · Momentum: si HOY produce sobre la vara, NO expirar/matar — darle runway (atribución de
//    video llega tarde). · Day-boundary: la expiración (decisión final) solo en runs temprano
//    de mañana (día anterior cerrado), nunca a media tarde truncando un día que produce.
const MOMENTUM_MIN_SPEND = parseFloat(process.env.TEST_MOMENTUM_MIN_SPEND || '10'); // $ mínimo de gasto HOY para que cuente como "produce hoy" (anti-fluke)
const EXPIRE_BOUNDARY_HOUR = parseInt(process.env.TEST_EXPIRE_BOUNDARY_HOUR || '9', 10); // expirar solo si la hora ET < esto (corte de día); fuera de eso, difiere
const RUNWAY_HARD_CAP_DAYS = parseInt(process.env.TEST_RUNWAY_HARD_CAP_DAYS || '10', 10); // tope: más allá de este día se expira igual (evita zombie eterno por momentum)
const MIN_READY_POOL = 5;
// Post-launch: un test con ≥30h y 0 impresiones/0 gasto NO está entregando (Ad error /
// link roto / sin delivery). Matarlo libera el slot sin esperar al día 3. (2026-06-05)
const DELIVERY_MIN_DAYS = 1.25;
// Post-graduación: un graduate cuyo cash-adj 3d cayó >50% vs su ROAS al graduar Y está
// bajo el bar (<2x) = winner falso desinflado → pausar antes de que lo escalen.
// 2026-06-11: política escalonada (decisión del creador) — el drop-ratio fijo y el bar
// de 2x apagaban graduates aún rentables (caso "Chips Forever" a 1.59x). Ahora: pausar
// solo si pierde en AMBAS ventanas (3d dispara, 7d confirma). 1.2-2x = vivo sin escalar
// (Athena/Ares ya exigen 3x para subir budget). Env-overridable.
const DEFLATE_PAUSE_ROAS_3D = parseFloat(process.env.DEFLATE_PAUSE_ROAS_3D || '1.2');
const DEFLATE_PAUSE_ROAS_7D = parseFloat(process.env.DEFLATE_PAUSE_ROAS_7D || '1.5');
const DEFLATE_MIN_AGE_H = 48;

// ── Señales propias de VIDEO (Dionisio) — engagement del creativo ──
// El video tiene métricas que la foto no: hold rate (% que lo ve completo) y
// thumbstop (% que se queda a verlo). Sirven para matar creativos que no
// enganchan ANTES de quemar budget, y para proteger los que sí enganchan.
const VIDEO_ENGAGEMENT_MIN_IMPR = parseInt(process.env.VIDEO_ENG_MIN_IMPR || '2000', 10); // impresiones mín para confiar en las tasas
const VIDEO_THUMBSTOP_MIN = parseFloat(process.env.VIDEO_THUMBSTOP_MIN || '0.15'); // p25/impr — bajo esto, hook débil → kill
const VIDEO_HOLD_GOOD = parseFloat(process.env.VIDEO_HOLD_GOOD || '0.10');         // p100/impr — sobre esto, engancha → más runway

const VIDEO_INSIGHT_FIELDS = 'impressions,video_play_actions,video_thruplay_watched_actions,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions,video_avg_time_watched_actions';
function _firstActionVal(arr) { return (Array.isArray(arr) && arr.length) ? (parseFloat(arr[0].value) || 0) : 0; }

/**
 * Trae las señales de engagement de VIDEO de un adset desde Meta (on-demand).
 * @returns {Object|null} { video_impressions, video_plays, video_p25..p100, thumbstop_rate, hold_rate, thruplay_rate }
 */
async function getVideoEngagement(meta, adsetId, launchedAt) {
  try {
    const since = new Date(launchedAt).toISOString().split('T')[0];
    const until = new Date().toISOString().split('T')[0];
    const rows = await meta.getInsights(adsetId, { fields: VIDEO_INSIGHT_FIELDS, time_range: JSON.stringify({ since, until }) });
    if (!rows || !rows.length) return null;
    const r = rows[0];
    const impr = parseFloat(r.impressions) || 0;
    if (impr <= 0) return null;
    const plays = _firstActionVal(r.video_play_actions);
    const thru = _firstActionVal(r.video_thruplay_watched_actions);
    const p25 = _firstActionVal(r.video_p25_watched_actions);
    const p50 = _firstActionVal(r.video_p50_watched_actions);
    const p75 = _firstActionVal(r.video_p75_watched_actions);
    const p100 = _firstActionVal(r.video_p100_watched_actions);
    const avgT = _firstActionVal(r.video_avg_time_watched_actions);
    return {
      video_impressions: impr, video_plays: plays, video_thruplays: thru,
      video_p25: p25, video_p50: p50, video_p75: p75, video_p100: p100, video_avg_time: avgT,
      thumbstop_rate: p25 / impr,   // proxy thumbstop: % que vio >=25% (inicio de la curva)
      p50_rate: impr ? p50 / impr : 0,   // % que llegó a la mitad (el MEDIO — dónde se cae)
      p75_rate: impr ? p75 / impr : 0,   // % que llegó a 3/4
      hold_rate: p100 / impr,       // % que lo vio completo (final de la curva)
      thruplay_rate: thru / impr
    };
  } catch (e) {
    logger.debug(`[TESTING-AGENT] video engagement falló ${adsetId}: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Obtener o crear la campana de testing.
 * Primera vez: crea campana en Meta y guarda ID en SystemConfig.
 * Siguientes: lee de SystemConfig.
 */
async function getTestingCampaignId() {
  // 1. Config (de TESTING_CAMPAIGN_ID env var, declarado en config/index.js)
  const config = require('../../../config');
  if (config.meta.testingCampaignId) return config.meta.testingCampaignId;

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
 * Obtener o crear la campana de testing de VIDEO (Dionisio).
 * Los creativos de video se testean en su PROPIA campana (separada de las fotos),
 * ABO $25/adset. Mismo patron que getTestingCampaignId: env → SystemConfig → auto-crear.
 */
async function getVideoTestingCampaignId() {
  const config = require('../../../config');
  if (config.meta.videoTestingCampaignId) return config.meta.videoTestingCampaignId;

  const stored = await SystemConfig.get('video_testing_campaign_id', null);
  if (stored) return stored;

  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();
  const result = await meta.createCampaign({
    name: '[TESTING-VIDEO] Video Creative Testing Pipeline',
    objective: 'OUTCOME_SALES',
    status: 'ACTIVE',
    special_ad_categories: []
  });

  await SystemConfig.set('video_testing_campaign_id', result.campaign_id);
  logger.info(`[TESTING-AGENT] Campana de testing de VIDEO creada: ${result.campaign_id}`);
  return result.campaign_id;
}

/**
 * Campaña SEPARADA para video de PERSONA FRONTAL (arquetipo `person`, UGC con cara) —
 * 2026-06-16, pedido del creador: aislar ese formato para medir si el POV frontal de
 * persona convierte mejor que el resto. Mismo patrón lazy: env → SystemConfig → auto-crear.
 */
async function getVideoPersonTestingCampaignId() {
  const config = require('../../../config');
  if (config.meta.videoPersonTestingCampaignId) return config.meta.videoPersonTestingCampaignId;

  const stored = await SystemConfig.get('video_person_testing_campaign_id', null);
  if (stored) return stored;

  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();
  const result = await meta.createCampaign({
    name: '[TESTING-VIDEO-PERSON] Front-Facing Person UGC Testing',
    objective: 'OUTCOME_SALES',
    status: 'ACTIVE',
    special_ad_categories: []
  });

  await SystemConfig.set('video_person_testing_campaign_id', result.campaign_id);
  logger.info(`[TESTING-AGENT] Campana de testing de VIDEO-PERSONA creada: ${result.campaign_id}`);
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
// Ventana de HOY del adset (último snapshot) — para el gate de momentum: ¿produce hoy?
async function getTodayWindow(testAdsetId) {
  const snap = await MetricSnapshot.findOne({ entity_type: 'adset', entity_id: testAdsetId })
    .sort({ snapshot_at: -1 }).select('metrics.today').lean();
  return snap?.metrics?.today || null;
}

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
// Construye el ad creative de un proposal (video o foto). Extraído para reusar al
// crear N ads en un mismo adset (multi-ad foto). (2026-06-13)
async function _buildCreativeForProposal(meta, proposal, pageId, tmpDir) {
  const creativeBase = {
    page_id: pageId, headline: proposal.headline, body: proposal.primary_text,
    description: '', cta: 'SHOP_NOW', link_url: proposal.link_url || 'https://jerseypickles.com'
  };
  if (proposal.media_type === 'video' && proposal.video_url) {
    const axios = require('axios');
    const tmpVid = path.join(tmpDir, `test_${proposal._id}.mp4`);
    const resp = await axios.get(proposal.video_url, { responseType: 'arraybuffer', timeout: 60000 });
    fs.writeFileSync(tmpVid, Buffer.from(resp.data));
    const vup = await meta.uploadVideo(tmpVid);
    try { fs.unlinkSync(tmpVid); } catch (_) {}
    CreativeProposal.findByIdAndUpdate(proposal._id, { $set: { video_base64: '' } }).catch(() => {});
    let thumbnail_hash = null;
    try {
      if (proposal.source_proposal_id) {
        const src = await CreativeProposal.findById(proposal.source_proposal_id).select('image_base64').lean();
        if (src?.image_base64) {
          const tmpThumb = path.join(tmpDir, `thumb_${proposal._id}.png`);
          fs.writeFileSync(tmpThumb, Buffer.from(src.image_base64, 'base64'));
          const tup = await meta.uploadImage(tmpThumb);
          try { fs.unlinkSync(tmpThumb); } catch (_) {}
          thumbnail_hash = tup.image_hash;
        }
      }
    } catch (thErr) {
      logger.warn(`[TESTING-AGENT] No se pudo subir thumbnail del video ${proposal._id}: ${thErr.message}`);
    }
    return await meta.createAdCreative({ ...creativeBase, video_id: vup.video_id, thumbnail_hash });
  }
  const { createMultiFormatCreative } = require('../../meta/creative-formats');
  const srcBuf = Buffer.from(proposal.image_base64, 'base64');
  return await createMultiFormatCreative(meta, srcBuf, creativeBase, `test_${proposal._id}`);
}

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

  // Contar tests activos por TRACK (foto vs video) — caps independientes.
  // El video tiene campaña/budget propios, así que no debe competir por los slots
  // de foto (si no, los 100 tests de foto bloquean cualquier video). (2026-05-30)
  // 2026-06-10: el spend se suma de los daily_budget REALES de cada test, no
  // activos × budget actual — tras subir budgets ($20→$50 foto, $25→$50 video)
  // la cuenta vieja inflaba el spend ficticio (21 tests de $25-35 contados como
  // $1050) y bloqueaba TODOS los lanzamientos ("Sin slots" eterno).
  const _trackAgg = async (matchMedia) => {
    const [agg] = await TestRun.aggregate([
      { $match: { phase: { $in: ['learning', 'evaluating'] }, media_type: matchMedia } },
      { $group: { _id: null, n: { $sum: 1 }, spend: { $sum: { $ifNull: ['$daily_budget', 0] } } } }
    ]);
    return { n: agg?.n || 0, spend: agg?.spend || 0 };
  };
  const photo = await _trackAgg({ $ne: 'video' });
  const video = await _trackAgg('video');
  const activePhotoTests = photo.n, activeVideoTests = video.n;

  // Slots FOTO
  const photoSpend = photo.spend;
  const photoSlots = Math.max(0, MAX_CONCURRENT_TESTS - activePhotoTests);
  const photoBudgetSlots = Math.max(0, Math.floor((MAX_DAILY_TESTING_BUDGET - photoSpend) / TEST_DAILY_BUDGET));
  let maxPhotoLaunches = Math.min(photoSlots, photoBudgetSlots, MAX_LAUNCHES_PER_CYCLE);
  // Pausa manual de FOTO (SystemConfig 'prometheus_photo_paused') — el creador frena solo el
  // lanzamiento de tests de foto (el video sigue). Toggle via /api/controls/agent-pause. (2026-06-22)
  try {
    const SystemConfig = require('../../db/models/SystemConfig');
    if (await SystemConfig.get('prometheus_photo_paused', false)) {
      if (maxPhotoLaunches > 0) logger.info('[TESTING-AGENT] foto PAUSADA (prometheus_photo_paused) — no lanzo tests de foto');
      maxPhotoLaunches = 0;
    }
  } catch (e) { logger.warn(`[TESTING-AGENT] no pude leer prometheus_photo_paused (sigo): ${e.message}`); }

  // Slots VIDEO (independientes)
  const videoSpend = video.spend;
  const videoSlots = Math.max(0, MAX_CONCURRENT_VIDEO_TESTS - activeVideoTests);
  const videoBudgetSlots = Math.max(0, Math.floor((MAX_DAILY_VIDEO_TESTING_BUDGET - videoSpend) / VIDEO_TEST_DAILY_BUDGET));
  const maxVideoLaunches = Math.min(videoSlots, videoBudgetSlots, MAX_LAUNCHES_PER_CYCLE);

  if (maxPhotoLaunches === 0 && maxVideoLaunches === 0) {
    logger.info(`[TESTING-AGENT] Sin slots — foto ${activePhotoTests}/${MAX_CONCURRENT_TESTS} ($${photoSpend}/$${MAX_DAILY_TESTING_BUDGET}), video ${activeVideoTests}/${MAX_CONCURRENT_VIDEO_TESTS} ($${videoSpend}/$${MAX_DAILY_VIDEO_TESTING_BUDGET})`);
    return 0;
  }

  // Leer proposals "ready" y partir por tipo; cada track se capa por separado.
  let allReady = await CreativeProposal.find({ status: 'ready' })
    .sort({ created_at: 1 }) // las mas antiguas primero (base / fallback)
    .lean();

  // FRENO POR PRODUCTO RETIRADO (2026-06-15): si un producto se elimina del ProductBank
  // (ej. el creador retira "Pickle Chamoy"), sus proposals 'ready' NO deben lanzarse como
  // tests. Marca killed y las saca del pool. Fail-open: si ProductBank no se puede leer o
  // viene vacío, no filtra nada (no romper el flujo de testeo).
  try {
    const ProductBank = require('../../db/models/ProductBank');
    const activeProducts = await ProductBank.find({ active: true }).select('product_name').lean();
    const activeNames = new Set(activeProducts.map(p => p.product_name).filter(Boolean));
    if (activeNames.size > 0) {
      const retired = allReady.filter(p => p.product_name && !activeNames.has(p.product_name));
      if (retired.length) {
        await CreativeProposal.updateMany(
          { _id: { $in: retired.map(p => p._id) } },
          { $set: { status: 'killed', rejection_reason: 'producto retirado del ProductBank', decided_at: new Date() } }
        );
        const names = [...new Set(retired.map(p => p.product_name))].join(', ');
        logger.info(`[TESTING-AGENT] ${retired.length} proposals 'ready' de producto(s) retirado(s) → killed: ${names}`);
        allReady = allReady.filter(p => !p.product_name || activeNames.has(p.product_name));
      }
    }
  } catch (e) {
    logger.warn(`[TESTING-AGENT] freno por producto retirado falló (fail-open): ${e.message}`);
  }

  const readyVideoAll = allReady.filter(p => p.media_type === 'video' && p.video_url);
  const readyPhotoAll = allReady.filter(p => !(p.media_type === 'video' && p.video_url));

  // PRIORIZACIÓN POR DNA (foto): en vez de FIFO, testear primero los combos con MÁS
  // potencial — el fitness shrunk de sus dimensiones (un combo nuevo hereda el prior de
  // sus marginales probadas). Así se encuentran winners más rápido y se gasta menos en
  // combos que ya sabemos que pierden. Video sigue FIFO (usa su propio DNA). Fail-open.
  let readyPhotoSorted = readyPhotoAll;
  try {
    const { buildFitnessContext, shrunkRoas } = require('../creative/dna-fitness');
    const ctx = await buildFitnessContext();
    const dnaScore = (p) => shrunkRoas({
      dimensions: {
        scene: p.scene_short || p.scene || 'unknown', style: p.style || 'unknown',
        copy_angle: p.copy_angle || 'unknown', product: p.product_name || 'unknown',
        hook_type: p.hook_type || 'unknown'
      },
      fitness: { tests_total: 0, avg_roas: 0 }
    }, ctx);
    readyPhotoSorted = [...readyPhotoAll].sort((a, b) => dnaScore(b) - dnaScore(a));
  } catch (e) {
    logger.warn(`[TESTING-AGENT] priorización DNA falló (FIFO fallback): ${e.message}`);
  }

  // Contar tests activos por ad set destino (para el cap por-adset de foto).
  const testCountByAdset = {};
  const existingTests = await TestRun.find({ phase: { $in: ['learning', 'evaluating'] } }).select('source_adset_id').lean();
  for (const t of existingTests) testCountByAdset[t.source_adset_id] = (testCountByAdset[t.source_adset_id] || 0) + 1;
  const MAX_TESTS_PER_ADSET = 2; // max 2 tests por ad set destino

  // AGRUPAR PRIMERO, capar por número de GRUPOS (fix 2026-06-13, extendido a video 2026-06-16).
  // Bug viejo: se tomaban solo N PROPOSALS y recién después se agrupaban → con margen para 2
  // adsets entraban 2 proposals → a lo más 1 grupo incompleto. Cada grupo consume `perAdset`
  // proposals, no 1. Ahora: agrupar TODO el pool por producto (orden preservado) en grupos de
  // hasta `perAdset`, y recién ahí capar a `maxLaunches` GRUPOS (= adsets = slots de budget).
  // Foto = PHOTO_ADS_PER_ADSET (3), video = VIDEO_ADS_PER_ADSET (2). Mismo producto → Meta
  // compara CREATIVOS y elige el ganador con el budget del adset.
  const groupByProduct = (list, perAdset) => {
    const out = [], open = {};
    for (const p of list) {
      const k = p.product_name || 'unknown';
      if (!open[k] || open[k].length >= perAdset) { open[k] = []; out.push(open[k]); }
      open[k].push(p);
    }
    return out;
  };

  // VIDEO — pares por producto, cap a maxVideoLaunches grupos (campaña/budget propios).
  // PERSONA FRONTAL (arquetipo `person`) va a una campaña SEPARADA (2026-06-16) → se agrupa
  // aparte para que ningún adset mezcle person con el resto (cada grupo es homogéneo en
  // arquetipo → se rutea entero a su campaña). El resto (classic + pov_hand) va a la regular.
  const personVid = readyVideoAll.filter(p => p.source_archetype === 'person');
  const otherVid = readyVideoAll.filter(p => p.source_archetype !== 'person');
  const videoGroups = [
    ...groupByProduct(otherVid, VIDEO_ADS_PER_ADSET),
    ...groupByProduct(personVid, VIDEO_ADS_PER_ADSET)
  ].slice(0, maxVideoLaunches);

  // FOTO — grupos de hasta PHOTO_ADS_PER_ADSET, filtro MAX_TESTS_PER_ADSET + cap.
  const cappedPhotoGroups = groupByProduct(readyPhotoSorted, PHOTO_ADS_PER_ADSET)
    .filter(g => {
      const src = g[0].adset_id;
      return !(src && src !== 'proactive' && (testCountByAdset[src] || 0) >= MAX_TESTS_PER_ADSET);
    })
    .slice(0, maxPhotoLaunches);

  // Grupos finales: video primero (suele haber pocos), luego foto.
  const groups = [...videoGroups, ...cappedPhotoGroups];

  if (groups.length === 0) {
    logger.info('[TESTING-AGENT] No hay propuestas "ready" con slot disponible en su track');
    return 0;
  }

  // Obtener campaign + pixel
  const campaignId = await getTestingCampaignId();
  const pixelInfo = await meta.getPixelId();
  let videoCampaignId = null;
  let videoPersonCampaignId = null; // campaña separada para arquetipo `person`

  const tmpDir = path.join(os.tmpdir(), 'testing-agent');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  let launched = 0;
  let loggedPixel = false;

  for (const group of groups) {
    const first = group[0];
    const isVideo = first.media_type === 'video' && !!first.video_url;

    // CLAIM ATÓMICO anti-doble-launch de TODOS los del grupo (flip ready→testing).
    const claimed = [];
    for (const p of group) {
      const c = await CreativeProposal.findOneAndUpdate(
        { _id: p._id, status: 'ready' }, { $set: { status: 'testing' } }
      ).lean();
      if (c) claimed.push(c);
    }
    if (!claimed.length) continue;

    let createdAdsetId = null;
    const adVariants = [];
    try {
      let targetCampaignId = campaignId;
      let dailyBudget = TEST_DAILY_BUDGET;
      const isPersonVideo = isVideo && first.source_archetype === 'person';
      if (isVideo) {
        // PERSONA FRONTAL → campaña separada (medir su performance aislada). Resto → regular.
        if (isPersonVideo) {
          if (!videoPersonCampaignId) videoPersonCampaignId = await getVideoPersonTestingCampaignId();
          targetCampaignId = videoPersonCampaignId;
        } else {
          if (!videoCampaignId) videoCampaignId = await getVideoTestingCampaignId();
          targetCampaignId = videoCampaignId;
        }
        dailyBudget = VIDEO_TEST_DAILY_BUDGET;
      }
      // Nombre del adset (2026-06-14): los headlines colisionan mucho (todos los
      // "Pickle Chamoy..." se ven iguales, sobre todo truncados en la UI) → imposible
      // encontrar un adset puntual. Ahora arranca con un TAG ÚNICO + PRODUCTO para que
      // sea distinguible y buscable: "[TEST] 🎬 MMDD-id4 · Producto · headline (+N)".
      //   - MMDD-id4: fecha (recencia) + 4 hex del proposal _id → único aunque el
      //     headline se repita. Visible temprano (no se pierde al truncar).
      //   - Producto: permite filtrar por producto en Meta Ads Manager.
      // [TEST] sigue al inicio (Athena/CBO-monitor excluyen por ese substring).
      const _d = new Date();
      const _stamp = `${String(_d.getMonth() + 1).padStart(2, '0')}${String(_d.getDate()).padStart(2, '0')}`;
      const _uid = String(first._id).slice(-4);
      const _prod = first.product_name ? `${first.product_name} · ` : '';
      const _grp = claimed.length > 1 ? ` (+${claimed.length - 1})` : '';
      const testName = `[TEST]${isVideo ? ' 🎬' : ''}${isPersonVideo ? ' 🧑' : ''} ${_stamp}-${_uid} · ${_prod}${first.headline}${_grp}`;

      if (!loggedPixel) { logger.info(`[TESTING-AGENT] pixelInfo: ${JSON.stringify(pixelInfo)}`); loggedPixel = true; }
      const adset = await meta.createAdSet({
        campaign_id: targetCampaignId,
        name: testName,
        daily_budget: dailyBudget,
        optimization_goal: pixelInfo.optimization_goal || 'OFFSITE_CONVERSIONS',
        billing_event: pixelInfo.billing_event || 'IMPRESSIONS',
        bid_strategy: pixelInfo.bid_strategy || 'LOWEST_COST_WITHOUT_CAP',
        promoted_object: pixelInfo.promoted_object || { pixel_id: pixelInfo.pixel_id, custom_event_type: 'PURCHASE' },
        targeting: { geo_locations: { countries: ['US'] }, age_min: 18, age_max: 65 },
        status: 'ACTIVE'
      });
      createdAdsetId = adset.adset_id;
      const pageId = await meta.getPageId();

      // Un ad por creativo del grupo (todos en el MISMO adset → Meta hace el A/B/C).
      for (const p of claimed) {
        try {
          const creative = await _buildCreativeForProposal(meta, p, pageId, tmpDir);
          const ad = await meta.createAd(adset.adset_id, creative.creative_id, `${p.headline} [TEST]`, 'ACTIVE');
          adVariants.push({ proposal_id: p._id, ad_id: ad.ad_id, creative_id: creative.creative_id, headline: p.headline });
        } catch (adErr) {
          logger.warn(`[TESTING-AGENT] ad falló para "${p.headline}" en grupo: ${adErr.message}`);
          await CreativeProposal.findByIdAndUpdate(p._id, { $set: { status: 'failed', rejection_reason: `ad create failed: ${adErr.message}` } }).catch(() => {});
        }
      }

      if (!adVariants.length) {
        // Ningún ad se creó → borrar el adset huérfano (los proposals ya quedaron failed).
        try { await meta.deleteObject(createdAdsetId); } catch (_) {}
        continue;
      }

      await TestRun.create({
        proposal_id: adVariants[0].proposal_id,   // principal (se re-apunta al ganador al graduar)
        source_adset_id: first.adset_id,
        source_adset_name: first.adset_name,
        test_adset_id: adset.adset_id,
        test_adset_name: testName,
        test_ad_id: adVariants[0].ad_id,
        test_creative_id: adVariants[0].creative_id,
        ad_variants: adVariants,
        campaign_id: targetCampaignId,
        daily_budget: dailyBudget,
        media_type: isVideo ? 'video' : 'image',
        max_days: TEST_MAX_DAYS,
        phase: 'learning',
        launched_at: new Date()
      });

      launched++;
      logger.info(`[TESTING-AGENT] Lanzado: "${first.headline}"${adVariants.length > 1 ? ` + ${adVariants.length - 1} variantes (${first.product_name})` : ''} → ${adset.adset_id}`);

    } catch (err) {
      const metaError = err.response?.data?.error;
      const detail = metaError ? `${metaError.message} (code: ${metaError.code}, subcode: ${metaError.error_subcode})` : err.message;
      logger.error(`[TESTING-AGENT] Error lanzando grupo "${first.headline}": ${detail}`);
      if (createdAdsetId && !adVariants.length) {
        try { await meta.deleteObject(createdAdsetId); logger.info(`[TESTING-AGENT] Adset huérfano ${createdAdsetId} borrado`); } catch (_) {}
      }
      // Marcar failed los del grupo que aún quedaron en 'testing' sin ad.
      for (const p of claimed) {
        if (!adVariants.some(v => String(v.proposal_id) === String(p._id))) {
          await CreativeProposal.findByIdAndUpdate(p._id, { $set: { status: 'failed', rejection_reason: `test launch failed: ${detail}` } }).catch(() => {});
        }
      }
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

  // Cash haircut de cuenta (Demeter) — graduar con cash-adjusted ROAS, no solo Meta.
  // Un graduate de Meta 2x pero cash 1.2x es un mal ganador que no debería pasar. (2026-05-26)
  let cashHaircut = 1;
  try {
    const { getAccountCashSignal } = require('./demeter-cash-signal');
    const cs = await getAccountCashSignal();
    if (cs.available) cashHaircut = cs.haircut_factor;
  } catch (_) { /* fail-open: haircut 1 = sin ajuste */ }

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

      // VIDEO: traer señales de engagement (hold/thumbstop) y mergearlas a metrics.
      let videoEng = null;
      if (test.media_type === 'video') {
        const { getMetaClient } = require('../../meta/client');
        videoEng = await getVideoEngagement(getMetaClient(), test.test_adset_id, test.launched_at);
        if (videoEng) Object.assign(metrics, videoEng);
      }

      // Actualizar metricas en TestRun
      await TestRun.findByIdAndUpdate(test._id, {
        $set: { metrics: { ...metrics, updated_at: new Date() } }
      });

      // ── POST-LAUNCH: ¿entregó? Un test con ≥30h y 0 impresiones/0 gasto no está
      // corriendo (Ad error / link roto / sin delivery). Matarlo libera el slot ya,
      // sin esperar al día 3 quemándolo en el limbo. (vale incluso en learning).
      if (daysActive >= DELIVERY_MIN_DAYS && (metrics.impressions || 0) === 0 && (metrics.spend || 0) === 0) {
        await killOrExpireTest(test, `No entregó: 0 impresiones / $0 gasto en ${Math.round(daysActive * 24)}h — posible Ad error / link roto / sin delivery`, 'killed');
        killed++;
        continue;
      }

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

      // VIDEO que engancha (hold alto): el lag ver→clic→compra es más largo que en foto.
      // Con atribución 7-day-click la compra se retro-atribuye DESPUÉS del día 3, así que
      // matar por "0 compras" al día 3 sobre-mata video que sí convierte (8/20 kills
      // históricos terminaron vendiendo, ~$679). Le damos runway completo hasta día 6 igual
      // que el kill agresivo de abajo; ahí el bloque de decisión final (día 6-7) lo expira si
      // sigue sin señal. Foto NO tiene este lag: muere al día 3 como siempre.
      const videoEngages = test.media_type === 'video' && videoEng && videoEng.hold_rate >= VIDEO_HOLD_GOOD;
      const videoGetsRunway = videoEngages && daysActive < 6;

      // KILL: 0 compras + gasto suficiente
      if (metrics.purchases === 0 && metrics.spend >= KILL_MIN_SPEND && !videoGetsRunway) {
        await killOrExpireTest(test, `0 compras con $${metrics.spend.toFixed(2)} spend, ${metrics.clicks || 0} clicks, ${metrics.add_to_cart || 0} ATC`, 'killed');
        killed++;
        continue;
      }
      if (videoGetsRunway && metrics.purchases === 0 && metrics.spend >= KILL_MIN_SPEND) {
        logger.info(`[TESTING-AGENT] ${test.test_adset_name}: 0 compras ($${metrics.spend.toFixed(2)}) pero video engancha (hold ${(videoEng.hold_rate * 100).toFixed(0)}%) — runway hasta día 6 por lag de atribución video`);
      }

      // KILL TEMPRANO: alto spend + clicks pero 0 ATC (funnel roto — el creativo atrae pero no convierte).
      // Mismo runway para video que engancha: ATC/compra también llegan con lag.
      if (metrics.spend >= 15 && metrics.clicks >= 20 && metrics.add_to_cart === 0 && metrics.purchases === 0 && daysActive >= 3 && !videoGetsRunway) {
        await killOrExpireTest(test, `Funnel roto: $${metrics.spend.toFixed(2)} spend, ${metrics.clicks} clicks, 0 ATC — creativo atrae pero no convierte`, 'killed');
        killed++;
        continue;
      }

      // KILL VIDEO: hook débil — nadie se queda a verlo (thumbstop bajo) con
      // impresiones suficientes y 0 compras. Mata creativos de video que no
      // enganchan ANTES de quemar todo el budget.
      if (test.media_type === 'video' && videoEng && videoEng.video_impressions >= VIDEO_ENGAGEMENT_MIN_IMPR
          && metrics.purchases === 0 && metrics.spend >= 15 && videoEng.thumbstop_rate < VIDEO_THUMBSTOP_MIN) {
        await killOrExpireTest(test, `Video no engancha: thumbstop ${(videoEng.thumbstop_rate * 100).toFixed(0)}% (<${(VIDEO_THUMBSTOP_MIN * 100).toFixed(0)}%) · hold ${(videoEng.hold_rate * 100).toFixed(0)}% · ${videoEng.video_impressions} impr · 0 compras`, 'killed');
        killed++;
        continue;
      }

      // Cash-adjusted ROAS: ajusta el Meta-ROAS por el haircut de cuenta (cash real).
      const cashAdjRoas = metrics.roas * cashHaircut;

      // ── GATES anti kill-prematuro (2026-06-20) ──
      // (1) MOMENTUM: ¿produce HOY sobre la vara? Si sí, no lo cortamos por el promedio
      //     acumulado — la atribución (sobre todo video) madura tarde, cortar a media tarde
      //     un día que viene a 5x es justo el error. (2) DAY-BOUNDARY: la expiración final
      //     solo en runs de la mañana (día anterior cerrado), nunca truncando un día en curso.
      const todayW = await getTodayWindow(test.test_adset_id).catch(() => null);
      const todayRoasCash = (todayW?.roas || 0) * cashHaircut;
      const hasMomentumToday = (todayW?.purchases || 0) >= 1
        && todayRoasCash >= GRADUATE_MIN_ROAS
        && (todayW?.spend || 0) >= MOMENTUM_MIN_SPEND
        && daysActive < RUNWAY_HARD_CAP_DAYS; // pasado el tope, ni el momentum lo salva
      let etHour = 12;
      try { etHour = require('moment-timezone')().tz('America/New_York').hour(); } catch (_) { /* fallback mediodía → difiere */ }
      const isDayBoundaryRun = etHour < EXPIRE_BOUNDARY_HOUR;

      // GRADUATE EARLY: rendimiento excepcional (cash-adjusted) — con piso de spend para
      // que sea señal real sostenida, no un fluke frontloaded de 2 ventas en $9.
      if (cashAdjRoas >= GRADUATE_EARLY_ROAS && metrics.purchases >= GRADUATE_EARLY_PURCHASES
          && metrics.spend >= GRADUATE_EARLY_MIN_SPEND) {
        await graduateTest(test, metrics);
        graduated++;
        continue;
      }
      if (cashAdjRoas >= GRADUATE_EARLY_ROAS && metrics.purchases >= GRADUATE_EARLY_PURCHASES
          && metrics.spend < GRADUATE_EARLY_MIN_SPEND) {
        logger.info(`[TESTING-AGENT] ${test.test_adset_name}: ${cashAdjRoas.toFixed(1)}x cash / ${metrics.purchases} compras pero solo $${metrics.spend.toFixed(2)} spend (<$${GRADUATE_EARLY_MIN_SPEND}) — espero más volumen antes de graduar (anti-fluke)`);
      }

      // KILL DECISIVO por significancia de CONVERSIÓN (no por días): $50 spend (≈2x CPA)
      // con 0 compras = perdedor real — un buen convertidor ya habría comprado a ese spend.
      // No esperar a día 3. Respeta el hold de video (lag ver→compra → no mata videos que
      // enganchan). Esto ataca el 71% de spend que se desperdiciaba en perdedores sin cortar.
      if (metrics.spend >= DECISIVE_KILL_SPEND && metrics.purchases === 0 && !videoEngages) {
        await killOrExpireTest(test, `kill decisivo: $${metrics.spend.toFixed(0)} spend (≥$${DECISIVE_KILL_SPEND}) + 0 compras — perdedor por significancia, no espera días`, 'killed');
        killed++;
        continue;
      }

      // Dia 6-7: Decision final
      if (daysActive >= 6) {
        // Cash-adjusted + sample mínimo: graduar exige señal real (≥2 compras), no 1 fluke.
        const meetsRoas = cashAdjRoas >= GRADUATE_MIN_ROAS && metrics.purchases >= GRADUATE_MIN_PURCHASES;
        const meetsCpa = metrics.purchases >= GRADUATE_MIN_PURCHASES && metrics.cpa <= GRADUATE_MAX_CPA && metrics.cpa > 0;

        if (meetsRoas || meetsCpa) {
          await graduateTest(test, metrics);
          graduated++;
          continue;
        }
        // No graduó por el promedio. Antes de expirar (decisión final, irreversible):
        //  · si HOY produce sobre la vara → runway, NO expirar (cae al assessment).
        //  · si no es corte de día → diferir al run de la mañana (no cortar a media jornada).
        if (hasMomentumToday) {
          logger.info(`[TESTING-AGENT] ${test.test_adset_name}: NO expiro (día ${daysActive}) — HOY ${todayW.purchases} compras a ${todayRoasCash.toFixed(1)}x cash sobre $${(todayW.spend || 0).toFixed(0)} → momentum, runway +1 día (atribución/video madura tarde)`);
        } else if (!isDayBoundaryRun) {
          logger.info(`[TESTING-AGENT] ${test.test_adset_name}: expiración diferida al corte de día (run de mañana, <${EXPIRE_BOUNDARY_HOUR}h ET) — no corto a media jornada (día ${daysActive}, cumulative ${metrics.roas.toFixed(2)}x)`);
        } else {
          await killOrExpireTest(test, `Dia ${daysActive}: ROAS ${metrics.roas.toFixed(2)}x, ${metrics.purchases} compras, CPA $${metrics.cpa.toFixed(2)}`, 'expired');
          expired++;
          continue;
        }
        // diferido → no continue: cae al assessment de abajo y se reevalúa el próximo ciclo
      }

      // Dia 3-5: Kill agresivo — 1 compra + $40+ spend + ROAS < 2x = no va a mejorar.
      // EXCEPCIÓN video: si engancha fuerte (hold alto), le damos el runway completo
      // hasta día 6-7 — el creativo gusta, dale tiempo a que las compras maduren.
      // (videoEngages ya definido arriba, en el bloque de kill de 0 compras.)
      if (daysActive >= 3 && metrics.purchases <= 1 && metrics.spend >= 40 && metrics.roas < 2.0 && !videoEngages && !hasMomentumToday) {
        await killOrExpireTest(test, `${metrics.purchases} compras con $${metrics.spend.toFixed(0)} spend, ROAS ${metrics.roas.toFixed(2)}x — CPA demasiado alto, no mejorara`, 'killed');
        killed++;
        continue;
      }
      if (daysActive >= 3 && metrics.purchases <= 1 && metrics.spend >= 40 && metrics.roas < 2.0 && (videoEngages || hasMomentumToday)) {
        const why = hasMomentumToday
          ? `HOY ${todayW.purchases} compras a ${todayRoasCash.toFixed(1)}x cash — momentum`
          : `video engancha (hold ${(videoEng.hold_rate * 100).toFixed(0)}%)`;
        logger.info(`[TESTING-AGENT] ${test.test_adset_name}: protegido del kill agresivo (${why}) — runway`);
      }

      // Dia 3-5: Esperar — guardar assessment
      const videoSuffix = videoEng ? ` · 🎬 thumbstop ${(videoEng.thumbstop_rate * 100).toFixed(0)}%, hold ${(videoEng.hold_rate * 100).toFixed(0)}%` : '';
      const assessment = `Dia ${daysActive}: $${metrics.spend.toFixed(2)} spend, ${metrics.purchases} compras, ROAS ${metrics.roas.toFixed(2)}x, CTR ${metrics.ctr.toFixed(1)}%, ${metrics.add_to_cart || 0} ATC, freq ${metrics.frequency.toFixed(1)}${videoSuffix}. Evaluando.`;
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

/**
 * Resuelve el ad GANADOR de un test multi-ad (foto, 3-por-adset) por ad-level insights.
 * Marca el ganador, PAUSA los perdedores, y atribuye al DNA de cada perdedor su propia
 * señal negativa (spend real, 0/pocas compras). Devuelve el variant ganador o null.
 * (2026-06-13) — así Apollo aprende QUÉ CREATIVO ganó, no solo "el adset graduó".
 */
async function _resolveMultiAdWinner(meta, test) {
  const { extractPurchaseCount, extractPurchaseValue } = require('../../meta/helpers');
  const variants = test.ad_variants || [];
  const since = new Date(test.launched_at || Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const until = new Date().toISOString().split('T')[0];
  const tr = JSON.stringify({ since, until });
  const scored = [];
  for (const v of variants) {
    let purchases = 0, value = 0, spend = 0;
    try {
      const ins = await meta.getInsights(v.ad_id, { time_range: tr });
      const row = (ins && ins[0]) || {};
      purchases = extractPurchaseCount(row.actions);
      value = extractPurchaseValue(row.action_values);
      spend = parseFloat(row.spend || 0);
    } catch (e) { logger.warn(`[TESTING-AGENT] insights ad ${v.ad_id} falló: ${e.message}`); }
    scored.push({ proposal_id: v.proposal_id, ad_id: v.ad_id, creative_id: v.creative_id, headline: v.headline, purchases, value, spend, roas: spend > 0 ? value / spend : 0 });
  }
  if (!scored.length) return null;
  // Ganador: más compras; desempate por revenue, luego ROAS.
  scored.sort((a, b) => (b.purchases - a.purchases) || (b.value - a.value) || (b.roas - a.roas));
  const winner = scored[0];

  for (const v of scored) {
    const won = String(v.proposal_id) === String(winner.proposal_id);
    if (won) continue;
    // Perdedor: pausar el ad + marcar proposal + señal negativa al DNA con SU spend real.
    try { await meta.updateStatus(v.ad_id, 'PAUSED'); } catch (_) {}
    await CreativeProposal.findByIdAndUpdate(v.proposal_id, { $set: { status: 'killed', decided_at: new Date() } }).catch(() => {});
    try {
      const lp = await CreativeProposal.findById(v.proposal_id).lean();
      if (lp) {
        const { updateDNAFitness, recordHeadToHead } = require('../creative/dna-helper');
        await updateDNAFitness(lp, 'killed', { spend: v.spend, revenue: v.value, purchases: v.purchases });
        await recordHeadToHead(lp, false); // C: perdió la pelea controlada del grupo
      }
    } catch (_) { /* non-fatal */ }
  }

  // C: el ganador venció a sus hermanos en condiciones idénticas → h2h_win en su DNA.
  if (scored.length > 1) {
    try {
      const wp = await CreativeProposal.findById(winner.proposal_id).lean();
      if (wp) {
        const { recordHeadToHead } = require('../creative/dna-helper');
        await recordHeadToHead(wp, true);
      }
    } catch (_) { /* non-fatal */ }
  }
  await TestRun.findByIdAndUpdate(test._id, {
    $set: {
      winner_resolved: true,
      ad_variants: scored.map(s => ({ proposal_id: s.proposal_id, ad_id: s.ad_id, creative_id: s.creative_id, headline: s.headline, won: String(s.proposal_id) === String(winner.proposal_id) }))
    }
  });
  logger.info(`[TESTING-AGENT] 🏆 multi-ad ganador: "${winner.headline}" (${winner.purchases}c, ROAS ${winner.roas.toFixed(2)}) — ${scored.length - 1} variante(s) pausada(s)`);
  return winner;
}

async function graduateTest(test, metrics) {
  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();

  // MULTI-AD: resolver el ganador por ad-level insights ANTES de promover/atribuir, para
  // que la promoción y el DNA usen el creativo que de verdad ganó (no el primero del grupo).
  if (Array.isArray(test.ad_variants) && test.ad_variants.length > 1 && !test.winner_resolved) {
    try {
      const winner = await _resolveMultiAdWinner(meta, test);
      if (winner) {
        test.proposal_id = winner.proposal_id;
        test.test_creative_id = winner.creative_id;
        test.test_ad_id = winner.ad_id;
      }
    } catch (e) { logger.warn(`[TESTING-AGENT] resolución multi-ad falló (uso el principal): ${e.message}`); }
  }

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
  // metrics_at_graduation = snapshot frozen para tracking post-grad
  // metrics = sigue actualizándose con data live (ad set sigue corriendo)
  const graduationSnapshot = {
    spend: metrics.spend || 0,
    purchases: metrics.purchases || 0,
    roas: metrics.roas || 0,
    cpa: metrics.cpa || 0,
    ctr: metrics.ctr || 0,
    impressions: metrics.impressions || 0,
    frequency: metrics.frequency || 0,
    snapshot_at: new Date()
  };
  await TestRun.findByIdAndUpdate(test._id, {
    $set: {
      phase: 'graduated',
      graduated_at: new Date(),
      test_adset_name: promotedName,
      metrics: { ...metrics, updated_at: new Date() },
      metrics_at_graduation: graduationSnapshot
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

  // 6. Update Creative DNA fitness (Fase 1 DNA system)
  try {
    const { updateDNAFitness } = require('../creative/dna-helper');
    await updateDNAFitness(proposal, 'graduated', {
      spend: metrics.spend || 0,
      revenue: (metrics.roas || 0) * (metrics.spend || 0),
      purchases: metrics.purchases || 0
    }, test._id);
  } catch (dnaErr) {
    logger.warn(`[TESTING-AGENT] DNA fitness update failed (non-fatal): ${dnaErr.message}`);
  }
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
  } catch (err) {
    // Silent failure acá rompe el feedback loop Prometheus→Apollo (scene ranking).
    // Sin log, el mismo test puede procesarse múltiples veces sin que feedback_saved
    // se marque — degrada aprendizaje creativo sin traza.
    logger.warn(`[TESTING-AGENT] Failed to mark feedback_saved for test ${test._id}: ${err.message} — scene feedback loop compromised`);
  }

  logger.info(`[TESTING-AGENT] ${phase.toUpperCase()}: "${test.test_adset_name}" — ${reason}`);

  // Cerrar directivas force_graduate pendientes de Zeus para este test (Zeus pidio graduar pero Prometheus mato/expiro)
  await _resolveForceGraduateDirectives(test, phase, test.metrics);

  // Update Creative DNA fitness (Fase 1 DNA system)
  try {
    const { updateDNAFitness } = require('../creative/dna-helper');
    const proposal = test.proposal_id ? await CreativeProposal.findById(test.proposal_id).lean() : null;
    if (proposal) {
      const m = test.metrics || {};
      await updateDNAFitness(proposal, phase, {
        spend: m.spend || 0,
        revenue: (m.roas || 0) * (m.spend || 0),
        purchases: m.purchases || 0
      }, test._id);
    }
  } catch (dnaErr) {
    logger.warn(`[TESTING-AGENT] DNA fitness update failed (non-fatal): ${dnaErr.message}`);
  }
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

      // Validacion — alineada con guardrails de Zeus (Abril 2026):
      // Force_graduate DEBE ser mas estricto que natural grad (que es 3d + 2 purch + 3x ROAS)
      // porque bypasses waiting time. Antes aceptaba 1 purch + 2x — demasiado laxo.
      const m = test.metrics || {};
      const daysActive = getDaysActive(test.launched_at);
      if (daysActive < 3) {
        logger.warn(`[TESTING-AGENT] force_graduate denegado: ${test.test_adset_name} solo ${daysActive.toFixed(1)}d activo (min 3d requerido)`);
        continue;
      }
      if ((m.purchases || 0) < 3 || (m.roas || 0) < 3.0) {
        logger.warn(`[TESTING-AGENT] force_graduate denegado: ${test.test_adset_name} no cumple minimos (${m.purchases || 0} compras vs 3+ requerido, ${(m.roas || 0).toFixed(2)}x ROAS vs 3x+ requerido)`);
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

  // Stance del día (gate de juicio). Si es observe-only/paused → no launches.
  // Si es aggressive/recovering → aplicamos teeth multiplier a los caps.
  let stanceTeeth = null;
  try {
    const { getStanceTeeth } = require('../zeus/agent-stance');
    stanceTeeth = await getStanceTeeth('prometheus');
    logger.info(`[TESTING] Stance actual: ${stanceTeeth.stance}${stanceTeeth.focus ? ` focus=${stanceTeeth.focus}` : ''}${stanceTeeth.stale ? ' (STALE)' : ''}`);
  } catch (err) {
    logger.warn(`[TESTING] stance lookup falló, default steady: ${err.message}`);
    stanceTeeth = { stance: 'steady', max_launches_multiplier: 1.0, block_all_writes: false };
  }

  // Chequear directivas avoid de Zeus + platform circuit breaker.
  let launchBlocked = false;
  let blockReason = '';

  // Stance teeth: si dice no lanzar, no lanzamos
  if (stanceTeeth.max_launches_multiplier === 0 || stanceTeeth.block_all_writes) {
    launchBlocked = true;
    blockReason = `stance: ${stanceTeeth.stance}`;
    logger.info(`[TESTING] Launches SKIP — stance ${stanceTeeth.stance}`);
  }

  if (!launchBlocked) {
    try {
      const { isDegraded } = require('../../safety/platform-circuit-breaker');
      const platform = await isDegraded();
      if (platform.degraded) {
        logger.warn(`[TESTING] Launches SKIP — plataforma degradada: ${platform.reason}`);
        launchBlocked = true;
        blockReason = `platform: ${platform.reason}`;
      }
    } catch (err) {
      logger.warn(`[TESTING] platform circuit breaker check falló: ${err.message}`);
    }
  }
  if (!launchBlocked) {
    try {
      const { isAgentBlocked } = require('../zeus/directive-guard');
      const block = await isAgentBlocked('prometheus');
      if (block.blocked) {
        logger.info(`[TESTING] Launches SKIP por directiva de Zeus: "${block.reason}"`);
        launchBlocked = true;
        blockReason = `directive: ${block.reason}`;
      }
    } catch (err) {
      logger.warn(`[TESTING] directive-guard check falló: ${err.message}`);
    }
  }

  // Fase 1: Lanzar tests nuevos (salvo que Zeus haya bloqueado)
  const launchResult = launchBlocked ? { launched: 0, results: [], blocked: true } : await launchTests();
  // Normaliza a número — launchTests() retorna number, el path bloqueado retorna objeto
  const launchedCount = typeof launchResult === 'number' ? launchResult : (launchResult?.launched ?? 0);
  // blockReason ya trae la causa real ('stance: X' | 'platform: X' | 'directive: X').
  // Antes el suffix decía siempre "directiva Zeus" — engañoso cuando el bloqueo
  // era el stance o la plataforma.
  const launchedSuffix = launchBlocked ? ` (launches blocked — ${blockReason})` : '';

  // Fase 2: Monitorear tests activos
  const { monitored, graduated, killed, expired } = await monitorTests();

  // Fase 3: Verificar pool de propuestas
  const readyPool = await checkReadyPool();

  const elapsed = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;

  logger.info(`═══ Testing Agent completado [${cycleId}]: ${launchedCount} lanzados${launchedSuffix}, ${monitored} monitoreados (${graduated} graduados, ${killed} killed, ${expired} expired), pool: ${readyPool} ready — ${elapsed} ═══`);

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
    let msg = `Ciclo completado: ${launchedCount} lanzados${launchedSuffix}, ${monitored} monitoreados.`;
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
        launched: launchedCount, launch_blocked: launchBlocked, monitored, graduated, killed, expired, pool: readyPool,
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
    launched: launchedCount,
    launch_blocked: launchBlocked,
    monitored,
    graduated,
    killed,
    expired,
    ready_pool: readyPool,
    elapsed,
    cycle_id: cycleId
  };
}

/**
 * Actualiza metrics de tests YA graduados (post-promotion tracking).
 *
 * Cuando un test gradúa, su metrics_at_graduation queda frozen como referencia.
 * Pero el adset original sigue corriendo en producción (renamed con sufijo
 * [Prometheus]). Esta función lo sigue pulleando para que el panel pueda mostrar
 * "ROAS al graduar 6.5x → ROAS hoy 4.2x" y detectar graduates desinflados.
 *
 * Se llama desde el cron principal (cada 30 min). Solo actualiza tests
 * graduados en últimos 30 días (después no vale la pena, lifecycle expira).
 */
/**
 * RESCATE post-decisión (Hilo de-lag): un test killed/expired que ahora resulta ser
 * winner real — la atribución llegó DESPUÉS de la decisión. Reactiva el adset y lo
 * gradúa. Distingue winner real (3d convierte) de loser real (3d en cero) usando la
 * ventana RECIENTE, así NO revive un adset que de verdad se murió (ej. 7d inflado por
 * ventas frontloaded pero 3d en 0).
 */
async function rescueExpiredWinner(test, freshMetrics) {
  const { getMetaClient } = require('../../meta/client');
  try {
    await getMetaClient().updateStatus(test.test_adset_id, 'ACTIVE');
  } catch (e) {
    logger.warn(`[TESTING-AGENT] rescate: no se pudo reactivar ${test.test_adset_id}: ${e.message}`);
    return false;
  }
  await TestRun.findByIdAndUpdate(test._id, { $unset: { expired_at: '', killed_at: '', kill_reason: '' } });
  await graduateTest({ ...test, expired_at: null, killed_at: null, phase: 'evaluating' }, freshMetrics);
  logger.info(`[TESTING-AGENT] 🛟 RESCATE: "${test.test_adset_name}" reactivado + graduado — era falso negativo por lag (${freshMetrics.purchases} compras, ROAS ${(freshMetrics.roas || 0).toFixed(2)}x)`);
  return true;
}

async function updateGraduatedMetrics() {
  // Graduados últimos 30d (para el panel "ROAS al graduar vs hoy") +
  // killed/expired últimos 7d (Pilar C: capturar conversiones que llegan con lag
  // de atribución DESPUÉS de la decisión, y re-alimentar el aprendizaje con la verdad).
  const grad30 = new Date(Date.now() - 30 * 86400000);
  const dec7 = new Date(Date.now() - 7 * 86400000);
  const tests = await TestRun.find({
    $or: [
      { phase: 'graduated', graduated_at: { $gte: grad30 } },
      { phase: 'killed', killed_at: { $gte: dec7 } },
      { phase: 'expired', expired_at: { $gte: dec7 } }
    ]
  }).lean();

  if (tests.length === 0) return { updated: 0, skipped: 0, reconciled: 0, total: 0 };

  const { updateDNAFitness } = require('../creative/dna-helper');
  // Sólo reconciliamos DNA en la ventana donde el lag importa (decisión ≤7d).
  const decidedAt = t => t.graduated_at || t.killed_at || t.expired_at || null;

  // Cash haircut para el bar de rescate (mismo criterio que graduación).
  let cashHaircut = 1;
  try {
    const { getAccountCashSignal } = require('./demeter-cash-signal');
    const cs = await getAccountCashSignal();
    if (cs.available) cashHaircut = cs.haircut_factor;
  } catch (_) { /* fail-open: haircut 1 */ }

  let updated = 0, skipped = 0, reconciled = 0, rescued = 0, deflated = 0;
  for (const test of tests) {
    try {
      const metrics = await getTestMetrics(test.test_adset_id);
      if (!metrics) { skipped++; continue; }
      // Misma protección anti-zero que monitorTests
      const oldMetrics = test.metrics || {};
      const newIsZero = (metrics.spend || 0) === 0 && (metrics.impressions || 0) === 0;
      const oldHadData = (oldMetrics.spend || 0) > 0;
      if (newIsZero && oldHadData) { skipped++; continue; }

      // VIDEO: mergear engagement (hold/thumbstop) — si no, el refresh PISARÍA el
      // hold_rate con un objeto sin él. Mantiene viva la señal de retención del DNA.
      if (test.media_type === 'video') {
        try {
          const { getMetaClient } = require('../../meta/client');
          const ve = await getVideoEngagement(getMetaClient(), test.test_adset_id, test.launched_at);
          if (ve) Object.assign(metrics, ve);
        } catch (_) { /* engagement opcional */ }
      }

      await TestRun.findByIdAndUpdate(test._id, {
        $set: { metrics: { ...metrics, updated_at: new Date() } }
      });
      updated++;

      const d = decidedAt(test);

      // RESCATE: killed/expired ≤7d que AHORA resulta winner real (la atribución
      // llegó tarde). El bar usa la ventana RECIENTE (3d) para distinguir un winner
      // que sigue convirtiendo de un loser cuyo 7d quedó inflado por ventas viejas.
      if ((test.phase === 'killed' || test.phase === 'expired') && d && d >= dec7) {
        const snap = await MetricSnapshot.findOne({ entity_type: 'adset', entity_id: test.test_adset_id }).sort({ snapshot_at: -1 }).lean();
        const m3 = snap?.metrics?.last_3d || {};
        const m7 = snap?.metrics?.last_7d || {};
        const recentWinner = (m3.purchases || 0) >= 1
          && ((m3.roas || 0) * cashHaircut) >= GRADUATE_MIN_ROAS
          && (m7.purchases || 0) >= GRADUATE_MIN_PURCHASES;
        if (recentWinner) {
          const ok = await rescueExpiredWinner(test, metrics);
          if (ok) { rescued++; continue; }
        }
      }

      // GUARD POST-GRADUACIÓN — política ESCALONADA con doble ventana (2026-06-11,
      // decisión del creador tras los apagados de graduates con historial de venta):
      //   PAUSAR solo si  cash-adj 3d < 1.2x  (perdiendo AHORA — el 3d dispara)
      //              Y    cash-adj 7d < 1.5x  (la semana completa tampoco da el mínimo
      //                                        viable — confirma que no es bache/lag de
      //                                        atribución 7-day-click)
      //   Banda 1.2x-2x: el adset sigue VIVO pero sin escalar — eso sale gratis: Athena
      //   y Ares exigen ROAS 3d ≥3x para subir budget, los mediocres nunca reciben más.
      // Lag-safe: ≥48h post-grad + spend real en la ventana. Cash-adj (haircut Demeter).
      if (test.phase === 'graduated' && test.graduated_at && !test.deflated_at && test.metrics_at_graduation) {
        const gradAgeH = (Date.now() - new Date(test.graduated_at).getTime()) / 3600000;
        if (gradAgeH >= DEFLATE_MIN_AGE_H) {
          const snap = await MetricSnapshot.findOne({ entity_type: 'adset', entity_id: test.test_adset_id }).sort({ snapshot_at: -1 }).lean();
          const m3 = snap?.metrics?.last_3d || {};
          const m7 = snap?.metrics?.last_7d || {};
          const cashAdj3 = (m3.roas || 0) * cashHaircut;
          const cashAdj7 = (m7.roas || 0) * cashHaircut;
          const gradRoas = test.metrics_at_graduation.roas || 0;
          const isDeflated = (m3.spend || 0) >= GRADUATED_BUDGET     // spend real en la ventana
            && cashAdj3 < DEFLATE_PAUSE_ROAS_3D                      // perdiendo AHORA
            && cashAdj7 < DEFLATE_PAUSE_ROAS_7D;                     // y el 7d lo confirma
          if (isDeflated) {
            try {
              const { getMetaClient } = require('../../meta/client');
              await getMetaClient().updateStatus(test.test_adset_id, 'PAUSED');
              await TestRun.findByIdAndUpdate(test._id, { $set: { deflated_at: new Date() } });
              await ActionLog.create({
                entity_type: 'adset', entity_id: test.test_adset_id, entity_name: test.test_adset_name,
                action: 'pause_adset', before_value: +gradRoas.toFixed(2), after_value: +cashAdj3.toFixed(2),
                reasoning: `[POST-GRAD DEFLATE] graduó a ${gradRoas.toFixed(2)}x; ahora cash-adj 3d ${cashAdj3.toFixed(2)}x (<${DEFLATE_PAUSE_ROAS_3D}) Y 7d ${cashAdj7.toFixed(2)}x (<${DEFLATE_PAUSE_ROAS_7D}) — perdiendo en ambas ventanas, no es bache. Pausado.`,
                confidence: 'high', agent_type: 'testing_agent', success: true, executed_at: new Date(),
                metadata: { post_grad_deflation: true, cash_adj_3d: +cashAdj3.toFixed(2), cash_adj_7d: +cashAdj7.toFixed(2) }
              });
              deflated++;
              logger.info(`[TESTING-AGENT] 📉 GRADUATE DEFLATÓ: "${test.test_adset_name}" ${gradRoas.toFixed(2)}x → 3d ${cashAdj3.toFixed(2)}x + 7d ${cashAdj7.toFixed(2)}x cash-adj — pausado (doble ventana)`);
              continue;
            } catch (e) {
              logger.warn(`[TESTING-AGENT] deflate pause falló ${test.test_adset_id}: ${e.message}`);
              // 400 de Meta = el adset ya no existe / no es pausable — marcar deflated_at
              // para cortar el retry infinito cada 30 min (caso 2026-06-11: un adset
              // borrado se reintentaba desde hacía 24h+).
              if (e.response?.status === 400 || /status code 400/.test(e.message || '')) {
                await TestRun.findByIdAndUpdate(test._id, { $set: { deflated_at: new Date() } }).catch(() => {});
                logger.info(`[TESTING-AGENT] deflate ${test.test_adset_id}: 400 de Meta → marcado deflated para no reintentar`);
              }
            }
          }
        }
      }

      // Reconciliar fitness con las métricas frescas (foto; video lo hace
      // solo vía getDimensionStats, que lee metrics en vivo). Sólo decisión ≤7d.
      if (test.media_type !== 'video' && d && d >= dec7 && test.proposal_id) {
        const proposal = await CreativeProposal.findById(test.proposal_id).lean();
        if (proposal) {
          await updateDNAFitness(proposal, test.phase, {
            spend: metrics.spend || 0,
            revenue: (metrics.roas || 0) * (metrics.spend || 0),
            purchases: metrics.purchases || 0
          }, test._id);
          reconciled++;
        }
      }
    } catch (err) {
      logger.warn(`[TESTING-AGENT] refresh ${test.test_adset_id} falló: ${err.message}`);
      skipped++;
    }
  }
  logger.info(`[TESTING-AGENT] metrics refresh: ${updated} actualizados, ${reconciled} DNA reconciliados, ${rescued} rescatados, ${deflated} graduates desinflados pausados, ${skipped} skipped (de ${tests.length})`);
  return { updated, skipped, reconciled, rescued, deflated, total: tests.length };
}

module.exports = { runTestingAgent, updateGraduatedMetrics, launchTests };
