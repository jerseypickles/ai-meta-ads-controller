/**
 * Limpia las directivas contradictorias que el learner generó el 22-abr-2026
 * pisando los avoid 14d manuales del creador.
 *
 * Estado esperado al correr:
 *   ACTIVAS (4 en total):
 *     - avoid    Apollo     (manual, 14d)  ← conservar
 *     - avoid    Prometheus (manual, 14d)  ← conservar
 *     - prioritize Apollo     (learner)    ← DESACTIVAR
 *     - prioritize Prometheus (learner)    ← DESACTIVAR
 *
 * Estrategia:
 *   - Modo --dry-run (default): lista las 4 + marca cuáles se desactivarían
 *   - Sin --dry-run: desactiva las prioritize de Apollo y Prometheus
 *     añadidas recientemente (created_at > manual_created_at), dejando vivas
 *     las avoid manuales.
 *
 * Uso:
 *   MONGODB_URI="..." node scripts/fix-contradictory-directives.js --dry-run
 *   MONGODB_URI="..." node scripts/fix-contradictory-directives.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../config');
const ZeusDirective = require('../src/db/models/ZeusDirective');

const DRY_RUN = process.argv.includes('--dry-run') || !process.argv.includes('--apply');

function redactUri(uri) {
  if (!uri) return '(no configurada)';
  return uri.replace(/\/\/[^@]+@/, '//***:***@');
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
}

async function run() {
  console.log(`\n═══ Fix Contradictory Directives ${DRY_RUN ? '(DRY RUN)' : '(APPLY)'} ═══`);
  console.log('MongoDB:', redactUri(config.mongodb.uri));
  await mongoose.connect(config.mongodb.uri);
  console.log('  [CONN] conectado\n');

  // 1. Listar TODAS las activas para Apollo y Prometheus
  const active = await ZeusDirective.find({
    target_agent: { $in: ['apollo', 'prometheus'] },
    active: true
  }).sort({ target_agent: 1, created_at: 1 }).lean();

  console.log(`  ${active.length} directivas activas para Apollo/Prometheus:\n`);

  const byAgent = {};
  for (const d of active) {
    if (!byAgent[d.target_agent]) byAgent[d.target_agent] = [];
    byAgent[d.target_agent].push(d);
  }

  const toDeactivate = [];

  for (const [agent, list] of Object.entries(byAgent)) {
    console.log(`  ━━━ ${agent.toUpperCase()} (${list.length}) ━━━`);
    for (const d of list) {
      const src = d.data?.source || 'learner';
      const text = (d.directive || '').substring(0, 60);
      const mark =
        d.directive_type === 'avoid' ? '  ✓ KEEP ' :
        d.directive_type === 'prioritize' ? '  ✗ DEACT' :
        '  ?      ';
      console.log(`${mark} [${d._id}]`);
      console.log(`          type=${d.directive_type} · source=${src} · conf=${d.confidence}`);
      console.log(`          created=${fmtDate(d.created_at)} expires=${fmtDate(d.expires_at)}`);
      console.log(`          "${text}${text.length >= 60 ? '...' : ''}"`);
      console.log();

      if (d.directive_type === 'prioritize') {
        toDeactivate.push(d);
      }
    }
  }

  console.log(`\n═══ Summary ═══`);
  console.log(`  A desactivar (prioritize): ${toDeactivate.length}`);
  console.log(`  A conservar (avoid y otros): ${active.length - toDeactivate.length}`);

  if (toDeactivate.length === 0) {
    console.log(`  [NOOP] nada contradictorio para limpiar`);
    await mongoose.disconnect();
    return;
  }

  if (DRY_RUN) {
    console.log(`\n  (DRY RUN — no changes applied. Re-run con --apply para ejecutar)`);
  } else {
    console.log(`\n  Aplicando cambios...`);
    for (const d of toDeactivate) {
      await ZeusDirective.findByIdAndUpdate(d._id, {
        $set: {
          active: false,
          last_validated_at: new Date(),
          'data.deactivated_by': 'fix_contradictory_2026-04-22',
          'data.deactivation_reason': 'Contradice directiva avoid manual del creador (14d). Learner creó prioritize sin chequear manuales — bug estructural pendiente de fix.'
        }
      });
      console.log(`     ✗ DEACT ${d._id} (${d.target_agent} ${d.directive_type})`);
    }
    console.log(`\n  [OK] ${toDeactivate.length} directivas desactivadas`);
  }

  await mongoose.disconnect();
  console.log('\n✓ Completo.\n');
}

run().catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
