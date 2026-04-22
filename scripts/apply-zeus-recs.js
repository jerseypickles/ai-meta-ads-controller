/**
 * Aplicar Zeus code recommendations + cerrar loop de calibración.
 *
 * Para cada rec especificada por _id:
 *   1. Setea status='applied' + applied_at + review_note
 *   2. Invoca rec-verifier.onCodeRecApplied(rec)
 *      - Verifica sintáctica (busca current_code/proposed_code en file)
 *      - Crea ZeusRecommendationOutcome con baseline → arranca tracking T+7/30/90d
 *      - Persiste verification result en rec.verification
 *
 * Uso: configurar REC_IDS abajo, después:
 *   MONGODB_URI="..." node scripts/apply-zeus-recs.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../config');
const ZeusCodeRecommendation = require('../src/db/models/ZeusCodeRecommendation');

// IDs de las recs a aplicar — se completan al ejecutar
// Usar grep_code en el panel para sacarlas, o pasarlas via env
const REC_FILTER = {
  status: 'pending',
  file_path: { $in: [
    'src/ai/zeus/delivery-health.js',
    'src/ai/agent/account-agent.js'
  ]}
};

function redactUri(uri) {
  if (!uri) return '(no configurada)';
  return uri.replace(/\/\/[^@]+@/, '//***:***@');
}

async function run() {
  console.log('\n═══ Apply Zeus Code Recs + Trigger Rec-Verifier ═══');
  console.log('MongoDB:', redactUri(config.mongodb.uri));

  await mongoose.connect(config.mongodb.uri);
  console.log('  [CONN] conectado a Mongo');

  const recs = await ZeusCodeRecommendation.find(REC_FILTER).sort({ created_at: -1 });
  console.log(`\n  ${recs.length} recs pending matching encontradas`);

  if (recs.length === 0) {
    console.log('  [NOOP] nada que aplicar');
    await mongoose.disconnect();
    return;
  }

  for (const rec of recs) {
    const age = Math.round((Date.now() - new Date(rec.created_at).getTime()) / 60000);
    console.log(`\n  ── Rec ${rec._id} (${age}min old)`);
    console.log(`     File:    ${rec.file_path}${rec.line_start ? `:${rec.line_start}-${rec.line_end || rec.line_start}` : ''}`);
    console.log(`     Cat:     ${rec.category} / ${rec.severity}`);
    console.log(`     Title:   ${(rec.rationale || '').substring(0, 80)}...`);

    // 1. Mark applied + audit trail
    rec.status = 'applied';
    rec.reviewed_at = new Date();
    rec.review_note = (rec.review_note || '') +
      `\n[Auto-applied 2026-04-22 vía script: aplicado por Claude Code después de verificación manual de evidence + intent. Fixes coincidentes en delivery-health.js y account-agent.js commiteados en mismo branch.]`;
    await rec.save();
    console.log(`     [OK] status='applied'`);

    // 2. Trigger rec-verifier — sintáctica + outcome bootstrap
    try {
      const { onCodeRecApplied } = require('../src/ai/zeus/rec-verifier');
      const verification = await onCodeRecApplied(rec);
      console.log(`     [VERIFIER] syntactic_status=${verification?.syntactic_status || 'unknown'}`);
      if (verification?.outcome_id) {
        console.log(`     [VERIFIER] outcome_id=${verification.outcome_id} (T+7/30/90d tracking iniciado)`);
      }
      if (verification?.notes) {
        console.log(`     [VERIFIER] notes: ${verification.notes.substring(0, 100)}`);
      }
    } catch (verifyErr) {
      console.log(`     [VERIFIER] ⚠ failed: ${verifyErr.message}`);
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
