/**
 * Limpia duplicados activos de ZeusDirective — pattern hash por
 * (target_agent, directive_type, key-words del texto).
 *
 * Uso: MONGODB_URI="..." node scripts/dedup-active-directives.js [--dry-run]
 *
 * Dry-run muestra qué se deduplicaría sin ejecutar. Sin flag, desactiva
 * duplicados dejando solo la MÁS RECIENTE (created_at DESC).
 */

require('dotenv').config();
const mongoose = require('mongoose');
const crypto = require('crypto');
const config = require('../config');
const ZeusDirective = require('../src/db/models/ZeusDirective');

const DRY_RUN = process.argv.includes('--dry-run');

const DIRECTIVE_STOPWORDS = new Set([
  'para','con','sobre','desde','hasta','pero','cuando','aunque','solo','esta','este','esto','esos','eso',
  'the','for','with','from','until','when','while','only','this','that','these','those',
  'que','porque','entonces','luego','después','antes','ahora','siempre','nunca',
  'because','then','after','before','now','always','never',
  'más','menos','muy','mucho','poco','todo','nada','algo','algunos',
  'more','less','much','little','all','nothing','something','some',
  'ejecutar','hacer','tener','estar','haber','ser','poder','deber',
  'execute','make','have','can','must','should','will'
]);

function computeHash(directive, target_agent, directive_type) {
  const textKey = (directive || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !DIRECTIVE_STOPWORDS.has(w))
    .slice(0, 12)
    .sort()
    .join('_');
  const raw = `${target_agent}::${directive_type}::${textKey}`;
  return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16);
}

function redactUri(uri) {
  if (!uri) return '(no configurada)';
  return uri.replace(/\/\/[^@]+@/, '//***:***@');
}

async function run() {
  console.log(`\n═══ Dedup Active Directives ${DRY_RUN ? '(DRY RUN)' : '(APPLY)'} ═══`);
  console.log('MongoDB:', redactUri(config.mongodb.uri));
  await mongoose.connect(config.mongodb.uri);
  console.log('  [CONN] conectado');

  const actives = await ZeusDirective.find({ active: true }).sort({ created_at: -1 }).lean();
  console.log(`\n  ${actives.length} directivas activas`);

  // Agrupar por hash
  const byHash = {};
  for (const d of actives) {
    const h = computeHash(d.directive, d.target_agent, d.directive_type);
    if (!byHash[h]) byHash[h] = [];
    byHash[h].push(d);
  }

  const duplicateGroups = Object.entries(byHash).filter(([, recs]) => recs.length > 1);
  console.log(`  ${duplicateGroups.length} grupos con duplicados\n`);

  if (duplicateGroups.length === 0) {
    console.log('  [NOOP] nada que deduplicar');
    await mongoose.disconnect();
    return;
  }

  let totalToDeactivate = 0;
  for (const [hash, group] of duplicateGroups) {
    console.log(`  ┏━━ Group (${group.length} dups) hash=${hash}`);
    console.log(`     target=${group[0].target_agent} · type=${group[0].directive_type}`);
    // Keep el más reciente (group[0] by created_at DESC), desactivar el resto
    const keeper = group[0];
    const toDeactivate = group.slice(1);
    console.log(`     → KEEP ${keeper._id} (${new Date(keeper.created_at).toISOString()})`);
    for (const dup of toDeactivate) {
      console.log(`     → DEACTIVATE ${dup._id} (${new Date(dup.created_at).toISOString()})`);
      totalToDeactivate++;
      if (!DRY_RUN) {
        await ZeusDirective.findByIdAndUpdate(dup._id, {
          $set: {
            active: false,
            last_validated_at: new Date(),
            'data.deactivated_by': 'dedup_script_2026-04-22',
            'data.deactivation_reason': `Duplicate of ${keeper._id} (identical pattern hash). Keeper is most recent.`
          }
        });
      }
    }
  }

  console.log(`\n═══ Summary ═══`);
  console.log(`  Duplicate groups: ${duplicateGroups.length}`);
  console.log(`  Directivas a desactivar: ${totalToDeactivate}`);
  if (DRY_RUN) console.log(`  (DRY RUN — no changes applied. Re-run sin --dry-run para ejecutar)`);
  else console.log(`  [OK] ${totalToDeactivate} deactivated`);

  await mongoose.disconnect();
  console.log('\n✓ Completo.\n');
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
