/**
 * Zeus Architect — Lens 3 del Code Sentinel.
 *
 * Una vez por semana (domingo 11:30am ET, 30min después de self-reflection),
 * Zeus toma una postura de arquitecto: mira 30 días de data + findings de
 * Lens 2 + journal entries recientes, identifica bottlenecks estructurales,
 * y genera ZeusArchitectureProposal con 2-3 opciones + tradeoffs.
 *
 * También se dispara ad-hoc cuando Lens 2 detecta el MISMO patrón
 * (mismo archivo/categoría) 3+ veces consecutivas en pasadas weekly —
 * señal de que ya no es bug suelto, es fricción arquitectónica.
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');

const ZeusArchitectureProposal = require('../../db/models/ZeusArchitectureProposal');
const ZeusAuditRun = require('../../db/models/ZeusAuditRun');
const ZeusCodeRecommendation = require('../../db/models/ZeusCodeRecommendation');
const ZeusRecommendationOutcome = require('../../db/models/ZeusRecommendationOutcome');
const ZeusJournalEntry = require('../../db/models/ZeusJournalEntry');
const ZeusPlaybook = require('../../db/models/ZeusPlaybook');
const ActionLog = require('../../db/models/ActionLog');
const TestRun = require('../../db/models/TestRun');

const claude = new Anthropic({ apiKey: config.claude.apiKey });
const MODEL = 'claude-opus-4-7';
const MS_30D = 30 * 86400000;

/**
 * Construye el "state of the system" — qué pasó en 30 días a nivel macro.
 */
async function buildSystemState() {
  const since = new Date(Date.now() - MS_30D);

  const [
    actions,
    tests,
    sentinelFindings,
    recentOutcomes,
    journalEntries,
    playbooks
  ] = await Promise.all([
    ActionLog.countDocuments({ executed_at: { $gte: since } }),
    TestRun.find({ $or: [{ created_at: { $gte: since } }, { graduated_at: { $gte: since } }, { killed_at: { $gte: since } }] }).lean(),
    ZeusCodeRecommendation.find({ lens: 'vulnerability', created_at: { $gte: since } }).lean(),
    ZeusRecommendationOutcome.find({ applied_at: { $gte: since } }).limit(20).lean(),
    ZeusJournalEntry.find({ created_at: { $gte: since } }).limit(10).lean(),
    ZeusPlaybook.find({ active: true }).limit(15).lean()
  ]);

  // Agrupar findings por archivo para detectar patterns recurrentes
  const findingsByFile = {};
  for (const f of sentinelFindings) {
    if (!findingsByFile[f.file_path]) findingsByFile[f.file_path] = [];
    findingsByFile[f.file_path].push({ sub_lens: f.sub_lens, severity: f.severity, rationale: (f.rationale || '').substring(0, 120) });
  }
  const recurrentFiles = Object.entries(findingsByFile)
    .filter(([_, arr]) => arr.length >= 3)
    .map(([file, arr]) => ({ file, occurrences: arr.length, samples: arr.slice(0, 3) }));

  // Test funnel summary
  const graduated = tests.filter(t => t.graduated_at).length;
  const killed = tests.filter(t => t.killed_at).length;
  const totalTests = tests.length;

  return {
    window: '30d',
    actions_total: actions,
    tests: { total: totalTests, graduated, killed, kill_rate: totalTests ? Math.round((killed / totalTests) * 100) : 0 },
    sentinel_findings_total: sentinelFindings.length,
    recurrent_files: recurrentFiles,
    recent_outcomes_sample: recentOutcomes.slice(0, 5).map(o => ({
      rec_type: o.rec_type,
      category: o.category,
      entity: o.entity_name || '',
      verdict_7d: o.measurement_7d?.verdict || null,
      actual_magnitude: o.measurement_7d?.actual_magnitude || ''
    })),
    journal_entries: journalEntries.map(j => ({
      title: j.title || '',
      entry_type: j.entry_type,
      content: (j.content || '').substring(0, 200)
    })),
    active_playbooks: playbooks.map(p => ({
      title: p.title || '',
      trigger: (p.trigger_pattern || '').substring(0, 120),
      action: (p.action || '').substring(0, 150)
    }))
  };
}

function buildArchitectPrompt(state, triggerContext) {
  return `[SENTINEL — LENS 3: ARCHITECTURE EVOLUTION]

Sos Zeus en modo ARQUITECTO. Una vez por semana (o cuando un patrón se repite), tomás distancia del día-a-día y mirás el sistema desde arriba. Tu pregunta: ¿hay bottlenecks estructurales, no bugs sueltos, que pidan una respuesta arquitectónica?

DISPARADOR: ${triggerContext?.kind || 'weekly_reflection'}
${triggerContext?.pattern ? `PATRÓN RECURRENTE: ${triggerContext.pattern}` : ''}

ESTADO DEL SISTEMA (últimos 30 días):
${JSON.stringify(state, null, 2)}

TU TAREA:
1. Identificá hasta **2 bottlenecks estructurales** — NO bugs sueltos, sino fricciones repetidas. Ejemplos válidos:
   - "Apollo genera mucho, approval rate baja, quemamos tokens en rejects → falta filtro pre-publicación"
   - "Ares duplica pero post-duplicación el budget no se ajusta → falta un supervisor"
   - "Muchos findings críticos en src/X.js → ese módulo ya pide split/refactor"
   - "No tenemos feedback loop X → podría justificar nuevo agente"
2. Para cada bottleneck, generá 2-3 **opciones con tradeoffs**. Siempre incluí la opción "no-op" (no hacer nada ahora, re-evaluar en X semanas).
3. Recomendá UNA de las opciones con reasoning.

RESPONDÉ SOLO CON JSON VÁLIDO (sin backticks):
{
  "proposals": [
    {
      "bottleneck": {
        "title": "string corto (<60 chars)",
        "description": "2-3 oraciones del problema",
        "evidence_summary": "data concreta — números, counts, trends"
      },
      "options": [
        {
          "label": "A",
          "approach": "string corto (<80 chars)",
          "description": "detalle de la propuesta",
          "cost": "bajo|medio|alto",
          "risk": "bajo|medio|alto",
          "expected_value": "bajo|medio|alto",
          "effort_days": 3,
          "notes": "detalles relevantes"
        }
      ],
      "recommended": "A",
      "reasoning": "por qué esta opción",
      "severity": "low|medium|high|critical"
    }
  ]
}

REGLAS ESTRICTAS:
- Máximo 2 proposals por pasada. Preferí 0 antes que forzadas.
- Cada proposal debe tener evidencia numérica CONCRETA en evidence_summary.
- Opciones deben incluir "no-op" como una de ellas.
- severity=critical SOLO si no actuar costaría >$1000/semana documentable.
- Si mirás el estado y no hay bottleneck real, respondé {"proposals": []}.

Respondé SOLO con el JSON.`;
}

/**
 * Detecta patterns recurrentes en las pasadas del sentinel.
 * Retorna los archivos que aparecieron ≥3 veces en las últimas 4 pasadas weekly.
 */
async function detectRecurrentPatterns() {
  const fourWeeksAgo = new Date(Date.now() - 4 * 7 * 86400000);
  const findings = await ZeusCodeRecommendation.find({
    lens: 'vulnerability',
    created_at: { $gte: fourWeeksAgo }
  }).lean();

  const byFile = {};
  for (const f of findings) {
    if (!byFile[f.file_path]) byFile[f.file_path] = [];
    byFile[f.file_path].push(f.sub_lens);
  }

  return Object.entries(byFile)
    .filter(([_, arr]) => arr.length >= 3)
    .map(([file, subLenses]) => ({ file, occurrences: subLenses.length, sub_lenses: [...new Set(subLenses)] }));
}

/**
 * Corre la reflexión arquitectónica. Persiste ZeusArchitectureProposal.
 */
async function runArchitectReflection(triggerContext = { kind: 'weekly_reflection' }) {
  const startedAt = new Date();
  const run = await ZeusAuditRun.create({
    lens: 'architecture',
    sub_lens: null,
    mode: triggerContext.kind === 'weekly_reflection' ? 'weekly' : 'on_demand',
    started_at: startedAt,
    status: 'running'
  });

  logger.info(`[LENS3-ARCHITECT] Run iniciado (trigger: ${triggerContext.kind})`);

  let state;
  try {
    state = await buildSystemState();
  } catch (err) {
    logger.error(`[LENS3-ARCHITECT] buildSystemState falló: ${err.message}`);
    run.status = 'failed';
    run.error = err.message;
    run.finished_at = new Date();
    await run.save();
    return { error: err.message };
  }

  let parsed;
  try {
    const response = await claude.messages.create({
      model: MODEL,
      max_tokens: 6000,
      messages: [{ role: 'user', content: buildArchitectPrompt(state, triggerContext) }]
    });
    const text = response.content.find(b => b.type === 'text')?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON en respuesta del architect');
    parsed = JSON.parse(match[0]);
    run.tokens_used = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
  } catch (err) {
    logger.error(`[LENS3-ARCHITECT] Claude call falló: ${err.message}`);
    run.status = 'failed';
    run.error = err.message;
    run.finished_at = new Date();
    await run.save();
    return { error: err.message };
  }

  const proposalDocs = [];
  for (const p of parsed.proposals || []) {
    if (!p.bottleneck || !p.options?.length) continue;
    const doc = await ZeusArchitectureProposal.create({
      bottleneck: {
        title: p.bottleneck.title || 'Sin título',
        description: p.bottleneck.description || '',
        evidence_summary: p.bottleneck.evidence_summary || '',
        evidence: p.bottleneck.evidence || {}
      },
      options: (p.options || []).slice(0, 4),
      recommended: p.recommended || '',
      reasoning: p.reasoning || '',
      severity: p.severity || 'medium',
      triggered_by: triggerContext.kind === 'pattern_repeat' ? 'pattern_repeat' : 'weekly_reflection',
      triggered_context: triggerContext,
      status: 'draft'
    });
    proposalDocs.push(doc);

    // Devil's Advocate automático — cada proposal recibe crítica adversaria
    try {
      const { critique } = require('./devils-advocate');
      const recText = `Bottleneck: ${p.bottleneck.title}\n${p.bottleneck.description}\n\nOpciones:\n${p.options.map(o => `${o.label}: ${o.approach} — ${o.description} (cost ${o.cost}, risk ${o.risk}, EV ${o.expected_value})`).join('\n')}\n\nRecomendada: ${p.recommended}. Razón: ${p.reasoning}`;
      const c = await critique(recText, { evidence: p.bottleneck.evidence_summary, system_state: state });
      if (c && !c.error) {
        doc.devils_critique = {
          attacks: c.attacks || [],
          overall_verdict: c.overall_verdict,
          summary: c.summary,
          generated_at: new Date()
        };
        await doc.save();
        logger.info(`[LENS3-ARCHITECT] devil's advocate on proposal ${doc._id}: ${c.overall_verdict} (${c.attacks?.length || 0} attacks)`);
      }
    } catch (err) {
      logger.warn(`[LENS3-ARCHITECT] devil's advocate falló para proposal ${doc._id}: ${err.message}`);
    }
  }

  const finishedAt = new Date();
  run.status = 'completed';
  run.finished_at = finishedAt;
  run.duration_ms = finishedAt - startedAt;
  run.findings_count = proposalDocs.length;
  run.critical_count = proposalDocs.filter(p => p.severity === 'critical').length;
  run.high_count = proposalDocs.filter(p => p.severity === 'high').length;
  run.summary = `Generé ${proposalDocs.length} architecture proposals`;
  await run.save();

  logger.info(`[LENS3-ARCHITECT] Completo — ${proposalDocs.length} proposals generadas`);

  return {
    proposals: proposalDocs,
    run_id: run._id
  };
}

/**
 * Cron entry — domingos 11:30am ET.
 * Primero chequea patrones recurrentes; si hay, pasa como trigger context.
 */
async function runWeeklyArchitectCron() {
  try {
    const patterns = await detectRecurrentPatterns();
    const triggerContext = patterns.length
      ? { kind: 'pattern_repeat', pattern: `${patterns.length} archivos con patrones recurrentes`, files: patterns.slice(0, 5) }
      : { kind: 'weekly_reflection' };
    return await runArchitectReflection(triggerContext);
  } catch (err) {
    logger.error(`[LENS3-ARCHITECT-CRON] ${err.message}`);
    return { error: err.message };
  }
}

module.exports = { runArchitectReflection, runWeeklyArchitectCron, detectRecurrentPatterns };
