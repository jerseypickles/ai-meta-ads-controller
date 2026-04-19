require('dotenv').config();
const mongoose = require('mongoose');
const CreativeProposal = require('../src/db/models/CreativeProposal');
const CreativeDNA = require('../src/db/models/CreativeDNA');
const TestRun = require('../src/db/models/TestRun');
const {
  buildDNA,
  extractStyleFromPrompt,
  extractHookType,
  extractCopyAngle,
  extractFraming,
  computeDNAHash
} = require('../src/ai/creative/dna-helper');

const DRY_RUN = !process.argv.includes('--execute');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 5 });

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  CREATIVE DNA BACKFILL ' + (DRY_RUN ? '[DRY RUN]' : '[EXECUTE]'));
  console.log('════════════════════════════════════════════════════════════\n');

  // ═══ Paso 1: Backfill dimensiones en CreativeProposal ═══
  console.log('[1/3] Enriqueciendo CreativeProposals con DNA dimensions...\n');

  const proposals = await CreativeProposal.find({
    $or: [
      { dna_hash: '' },
      { dna_hash: { $exists: false } }
    ]
  }).lean();

  console.log('  ' + proposals.length + ' proposals sin dna_hash encontrados');

  let enriched = 0;
  const dimensionCounts = { styles: {}, angles: {}, framings: {}, hooks: {} };

  for (const p of proposals) {
    // Inferir cada dimension
    const style = p.style || extractStyleFromPrompt(p.prompt_used || '');
    const copyAngle = p.copy_angle || extractCopyAngle(p.headline || '');
    const framing = p.framing || extractFraming(p.headline || '');
    const hookType = p.hook_type || extractHookType(p.headline || '');

    const dnaHash = computeDNAHash({
      style,
      copy_angle: copyAngle,
      scene: p.scene_short || 'unknown',
      product: p.product_name || 'unknown',
      hook_type: hookType
    });

    // Contar distribuciones
    dimensionCounts.styles[style] = (dimensionCounts.styles[style] || 0) + 1;
    dimensionCounts.angles[copyAngle] = (dimensionCounts.angles[copyAngle] || 0) + 1;
    dimensionCounts.framings[framing] = (dimensionCounts.framings[framing] || 0) + 1;
    dimensionCounts.hooks[hookType] = (dimensionCounts.hooks[hookType] || 0) + 1;

    if (!DRY_RUN) {
      await CreativeProposal.updateOne(
        { _id: p._id },
        { $set: { style, copy_angle: copyAngle, framing, hook_type: hookType, dna_hash: dnaHash } }
      );
    }
    enriched++;
  }

  console.log('\n  Distribucion inferida:\n');
  const printDist = (title, obj) => {
    console.log('  ' + title + ':');
    Object.entries(obj).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
      console.log('    ' + k.padEnd(20) + v);
    });
  };
  printDist('Styles', dimensionCounts.styles);
  console.log('');
  printDist('Copy Angles', dimensionCounts.angles);
  console.log('');
  printDist('Framings', dimensionCounts.framings);
  console.log('');
  printDist('Hook Types', dimensionCounts.hooks);

  console.log('\n  ' + enriched + ' proposals ' + (DRY_RUN ? 'listos para enriquecer' : 'enriquecidos'));

  // ═══ Paso 2: Construir CreativeDNA records con fitness histórica ═══
  console.log('\n[2/3] Construyendo CreativeDNA records con fitness desde TestRuns finalizados...\n');

  // Buscar todos los TestRuns con outcome definitivo
  const finishedTests = await TestRun.find({
    phase: { $in: ['graduated', 'killed', 'expired'] }
  }).populate('proposal_id').lean();

  console.log('  ' + finishedTests.length + ' tests finalizados');

  // Agregar por DNA
  const dnaMap = {};
  let skipped = 0;

  for (const test of finishedTests) {
    const proposal = test.proposal_id;
    if (!proposal) { skipped++; continue; }

    const style = proposal.style || extractStyleFromPrompt(proposal.prompt_used || '');
    const angle = proposal.copy_angle || extractCopyAngle(proposal.headline || '');
    const hook = proposal.hook_type || extractHookType(proposal.headline || '');
    const scene = proposal.scene_short || 'unknown';
    const product = proposal.product_name || 'unknown';

    const dnaHash = computeDNAHash({ style, copy_angle: angle, scene, product, hook_type: hook });

    if (!dnaMap[dnaHash]) {
      dnaMap[dnaHash] = {
        dna_hash: dnaHash,
        dimensions: { scene, style, copy_angle: angle, product, hook_type: hook },
        fitness: {
          tests_total: 0, tests_graduated: 0, tests_killed: 0, tests_expired: 0,
          total_spend: 0, total_revenue: 0, total_purchases: 0,
          avg_roas: 0, win_rate: 0, avg_cpa: 0,
          last_test_at: null, last_outcome: null, sample_confidence: 0
        },
        first_seen_at: proposal.created_at || new Date()
      };
    }

    const entry = dnaMap[dnaHash];
    const m = test.metrics || {};
    const spend = m.spend || 0;
    const purchases = m.purchases || 0;
    const revenue = (m.roas || 0) * spend;

    entry.fitness.tests_total++;
    if (test.phase === 'graduated') entry.fitness.tests_graduated++;
    else if (test.phase === 'killed') entry.fitness.tests_killed++;
    else if (test.phase === 'expired') entry.fitness.tests_expired++;

    entry.fitness.total_spend += spend;
    entry.fitness.total_revenue += revenue;
    entry.fitness.total_purchases += purchases;

    const testDate = test.graduated_at || test.killed_at || test.expired_at || test.updated_at;
    if (testDate && (!entry.fitness.last_test_at || testDate > entry.fitness.last_test_at)) {
      entry.fitness.last_test_at = testDate;
      entry.fitness.last_outcome = test.phase;
    }
  }

  // Calcular derived fields
  Object.values(dnaMap).forEach(e => {
    e.fitness.avg_roas = e.fitness.total_spend > 0
      ? Math.round((e.fitness.total_revenue / e.fitness.total_spend) * 100) / 100 : 0;
    e.fitness.win_rate = e.fitness.tests_total > 0
      ? e.fitness.tests_graduated / e.fitness.tests_total : 0;
    e.fitness.avg_cpa = e.fitness.total_purchases > 0
      ? Math.round((e.fitness.total_spend / e.fitness.total_purchases) * 100) / 100 : 0;
    e.fitness.sample_confidence = Math.min(1, e.fitness.tests_total / 12);
  });

  console.log('  ' + Object.keys(dnaMap).length + ' DNAs unicos identificados');
  console.log('  ' + skipped + ' tests saltados (sin proposal linkeado)');

  // Mostrar top 10 DNAs
  const sorted = Object.values(dnaMap).sort((a, b) => {
    // Score: combine avg_roas * confidence
    const scoreA = a.fitness.avg_roas * a.fitness.sample_confidence;
    const scoreB = b.fitness.avg_roas * b.fitness.sample_confidence;
    return scoreB - scoreA;
  });

  console.log('\n  Top 10 DNAs (ranked por avg_roas × confidence):\n');
  sorted.slice(0, 10).forEach((e, i) => {
    const wr = (e.fitness.win_rate * 100).toFixed(0);
    console.log('    ' + (i + 1).toString().padStart(2) + '. ' + e.dna_hash.substring(0, 60));
    console.log('        ROAS ' + e.fitness.avg_roas + 'x | win ' + wr + '% | ' + e.fitness.tests_total + ' tests | conf ' + (e.fitness.sample_confidence * 100).toFixed(0) + '%');
  });

  // ═══ Paso 3: Guardar CreativeDNA records ═══
  if (!DRY_RUN) {
    console.log('\n[3/3] Guardando CreativeDNA records en DB...\n');
    let saved = 0;
    for (const entry of Object.values(dnaMap)) {
      await CreativeDNA.updateOne(
        { dna_hash: entry.dna_hash },
        { $set: entry },
        { upsert: true }
      );
      saved++;
    }
    console.log('  ' + saved + ' CreativeDNA records guardados');
  } else {
    console.log('\n[3/3] [DRY RUN] Skipping save — correr con --execute para guardar\n');
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  BACKFILL ' + (DRY_RUN ? 'PREVIEW COMPLETO' : 'COMPLETO'));
  console.log('════════════════════════════════════════════════════════════\n');

  if (DRY_RUN) {
    console.log('Para ejecutar: node scripts/dna-backfill.js --execute\n');
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error('ERROR:', err); process.exit(1); });
