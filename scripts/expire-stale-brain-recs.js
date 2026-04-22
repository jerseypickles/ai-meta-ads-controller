/**
 * Expirar BrainRecommendations pending viejas (one-off, 22-abr-2026).
 *
 * Contexto: después del refactor 3124601 del 10-mar-2026, el pipeline de
 * escritura de BrainRecommendation quedó dark en producción (agent_mode
 * 'unified' → analyzeAndLearn() que no llama _saveToBrainRecommendations).
 *
 * Las 18 recs status='pending' de hoy son del 15-16 marzo — fósiles de
 * data podrida que ensucian el proactive ping de Zeus.
 *
 * Este script marca status='expired' (preserva audit trail) con decision_note
 * indicando la razón. Idempotente — si no hay pending viejas, no hace nada.
 *
 * Ejecutar: node scripts/expire-stale-brain-recs.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../config');
const BrainRecommendation = require('../src/db/models/BrainRecommendation');

function redactUri(uri) {
  if (!uri) return '(no configurada)';
  return uri.replace(/\/\/[^@]+@/, '//***:***@');
}

async function run() {
  console.log('\n═══ Expire Stale BrainRecommendations ═══');
  console.log('MongoDB:', redactUri(config.mongodb.uri));

  await mongoose.connect(config.mongodb.uri);
  console.log('  [CONN] conectado a Mongo');

  const cutoff = new Date(Date.now() - 14 * 86400000);  // >14 días es stale

  const pending = await BrainRecommendation.find({
    status: 'pending',
    created_at: { $lte: cutoff }
  }).select('_id created_at priority action_type').lean();

  console.log(`\n  ${pending.length} pending >14d encontradas`);
  if (pending.length === 0) {
    console.log('  [NOOP] nada que expirar');
    await mongoose.disconnect();
    return;
  }

  // Mostrar las primeras 5 para confirmación visual
  pending.slice(0, 5).forEach(r => {
    const age = Math.round((Date.now() - new Date(r.created_at).getTime()) / 86400000);
    console.log(`    · ${r._id} · ${r.priority}/${r.action_type} · ${age}d old`);
  });
  if (pending.length > 5) console.log(`    · ... y ${pending.length - 5} más`);

  const result = await BrainRecommendation.updateMany(
    {
      status: 'pending',
      created_at: { $lte: cutoff }
    },
    {
      $set: {
        status: 'expired',
        decided_at: new Date(),
        decision_note: 'auto-expired: stale >14d, BrainRecommendation writes dark desde 10-mar-2026 por agent_mode=unified — pipeline dormant, recs no fueron regeneradas. Archivadas el 22-abr-2026 para limpiar proactive ping.'
      }
    }
  );

  console.log(`\n  [OK] ${result.modifiedCount} recomendaciones marcadas como expired`);

  // Verify final state
  const stillPending = await BrainRecommendation.countDocuments({ status: 'pending' });
  const expired = await BrainRecommendation.countDocuments({ status: 'expired' });
  console.log(`\n  Estado final:`);
  console.log(`    pending: ${stillPending}`);
  console.log(`    expired: ${expired}`);

  await mongoose.disconnect();
  console.log('\n✓ Completo.\n');
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
