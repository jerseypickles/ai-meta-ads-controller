/**
 * Apply Batch 1 (path traversals) + Batch 2 (silent failures) — 8 recs total.
 *
 * Marca applied las recs pending que matchean los files de los batches y
 * dispara el rec-verifier (verificación sintáctica + outcome tracking).
 *
 * Uso: MONGODB_URI="..." node scripts/apply-batch12-recs.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../config');
const ZeusCodeRecommendation = require('../src/db/models/ZeusCodeRecommendation');

// Files tocados en Batch 1 (path traversals — safety) y Batch 2 (silent failures)
const TARGET_FILES = [
  'src/dashboard/routes/video.js',
  'src/dashboard/routes/creatives.js',
  'src/dashboard/routes/creative-agent.js',
  'src/meta/data-collector.js',
  'src/ai/brain/zeus-learner.js',
  'src/ai/agent/testing-agent.js'
];

function redactUri(uri) {
  if (!uri) return '(no configurada)';
  return uri.replace(/\/\/[^@]+@/, '//***:***@');
}

async function run() {
  console.log('\n═══ Apply Batch 1+2 (path traversal + silent failures) ═══');
  console.log('MongoDB:', redactUri(config.mongodb.uri));
  await mongoose.connect(config.mongodb.uri);
  console.log('  [CONN] conectado');

  const recs = await ZeusCodeRecommendation.find({
    status: 'pending',
    file_path: { $in: TARGET_FILES },
    // Solo safety + bug (path traversals + silent failures), NO other categories
    category: { $in: ['safety', 'bug'] }
  }).sort({ severity: 1, created_at: 1 });

  console.log(`\n  ${recs.length} recs pending matching`);
  if (recs.length === 0) {
    await mongoose.disconnect();
    return;
  }

  for (const rec of recs) {
    console.log(`\n  ── ${rec._id} · ${rec.severity}/${rec.category}`);
    console.log(`     ${rec.file_path}${rec.line_start ? ':' + rec.line_start : ''}`);

    rec.status = 'applied';
    rec.reviewed_at = new Date();
    rec.review_note = (rec.review_note || '') +
      `\n[Auto-applied 2026-04-22: Batch 1+2 (path traversal + silent failures). Fix aplicado en mismo commit. Claude Code implementó con guard contra '..' / '/' / '\\\\' + path.basename para path traversals, y reemplazó catch(()=>{}) por catch(err){logger.warn(...)} con contexto específico para silent failures.]`;
    await rec.save();
    console.log(`     [OK] status='applied'`);

    try {
      const { onCodeRecApplied } = require('../src/ai/zeus/rec-verifier');
      const verification = await onCodeRecApplied(rec);
      console.log(`     [VERIFIER] ${verification?.syntactic_status || 'unknown'}`);
    } catch (err) {
      console.log(`     [VERIFIER] ⚠ ${err.message}`);
    }
  }

  // Estado final
  const stillPending = await ZeusCodeRecommendation.countDocuments({ status: 'pending' });
  const applied = await ZeusCodeRecommendation.countDocuments({ status: 'applied' });
  console.log(`\n═══ Estado final ═══`);
  console.log(`  pending: ${stillPending}`);
  console.log(`  applied: ${applied}`);

  await mongoose.disconnect();
  console.log('\n✓ Completo.\n');
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
