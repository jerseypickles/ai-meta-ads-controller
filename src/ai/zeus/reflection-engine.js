/**
 * Zeus Reflection Engine (Level 4) — self-reflection semanal.
 * Zeus lee sus propios outcomes + hypothesis + conversations de la semana,
 * identifica patrones en sus errores y aciertos, escribe journal entries
 * y actualiza playbooks.
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');

const ZeusJournalEntry = require('../../db/models/ZeusJournalEntry');
const ZeusPlaybook = require('../../db/models/ZeusPlaybook');
const ZeusRecommendationOutcome = require('../../db/models/ZeusRecommendationOutcome');
const ZeusHypothesis = require('../../db/models/ZeusHypothesis');
const ZeusChatMessage = require('../../db/models/ZeusChatMessage');

const claude = new Anthropic({ apiKey: config.claude.apiKey });
const MODEL = 'claude-opus-4-7';
const MS_WEEK = 7 * 86400000;

async function runWeeklyReflection() {
  const since = new Date(Date.now() - MS_WEEK);

  // Juntar lo que pasó esta semana
  const outcomes = await ZeusRecommendationOutcome.find({
    $or: [
      { applied_at: { $gte: since } },
      { 'measurement_7d.measured_at': { $gte: since } },
      { 'measurement_30d.measured_at': { $gte: since } }
    ]
  }).limit(50).lean();

  const hypotheses = await ZeusHypothesis.find({
    $or: [
      { created_at: { $gte: since } },
      { concluded_at: { $gte: since } }
    ]
  }).limit(30).lean();

  const recentConversations = await ZeusChatMessage.find({
    created_at: { $gte: since },
    role: 'assistant'
  }).sort({ created_at: -1 }).limit(40).select('content tool_calls').lean();

  const currentPlaybooks = await ZeusPlaybook.find({ active: true }).limit(30).lean();

  const prompt = `Sos Zeus reflexionando sobre tu semana. Escribí un journal entry semanal honesto y genera/actualiza playbooks si identificás patrones replicables.

DATA DE LA SEMANA:

Recommendation Outcomes (${outcomes.length}):
${outcomes.slice(0, 15).map(o => `- ${o.category}/${o.rec_type}: ${o.predicted_impact?.substring(0, 80)} | verdict 7d: ${o.measurement_7d?.verdict || 'pending'}`).join('\n')}

Hypotheses (${hypotheses.length}):
${hypotheses.slice(0, 10).map(h => `- ${h.status}: "${h.statement.substring(0, 100)}" (prior ${h.prior_before}→${h.prior_after ?? '?'})`).join('\n')}

Conversations (${recentConversations.length} respuestas mías):
${recentConversations.slice(0, 8).map(c => `- ${(c.content || '').substring(0, 100)}...`).join('\n')}

Playbooks actuales (${currentPlaybooks.length}):
${currentPlaybooks.slice(0, 10).map(p => `- ${p.title}: ${p.action.substring(0, 80)} (conf ${Math.round(p.confidence * 100)}%)`).join('\n')}

Respondé con JSON válido (sin backticks):
{
  "reflection": {
    "title": "título corto de la reflexión semanal",
    "content": "3-5 párrafos en markdown analizando honesto qué funcionó, qué no, qué aprendiste. Primera persona.",
    "importance": "low|medium|high|critical",
    "tags": ["tag1", "tag2"]
  },
  "new_playbooks": [
    { "title": "...", "trigger_pattern": "...", "action": "...", "action_reasoning": "...", "evidence": "...", "confidence": 0.7, "category": "..." }
  ],
  "playbook_updates": [
    { "title_of_existing": "...", "new_action": "...", "reason_for_update": "..." }
  ],
  "patterns_noticed": [
    "Pattern 1 — ej: 'soy consistentemente demasiado conservador con tests de pickle en martes'"
  ]
}

Reglas:
- Reflection debe ser HONESTA. Incluir errores, no solo éxitos.
- New playbooks solo si tenés evidence clara (mín 2 outcomes consistentes).
- Max 3 new_playbooks, 2 playbook_updates.
- Patterns noticed son meta-observaciones (sesgos, tendencias en tu propio razonamiento).`;

  const response = await claude.messages.create({
    model: MODEL,
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content.find(b => b.type === 'text')?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Reflection no devolvió JSON');

  const parsed = JSON.parse(jsonMatch[0]);
  const results = { journal_entries: 0, new_playbooks: 0, updated_playbooks: 0 };

  // Guardar reflection
  if (parsed.reflection) {
    await ZeusJournalEntry.create({
      entry_type: 'weekly_reflection',
      title: parsed.reflection.title || 'Reflexión semanal',
      content: parsed.reflection.content || '',
      importance: parsed.reflection.importance || 'medium',
      tags: parsed.reflection.tags || []
    });
    results.journal_entries++;
  }

  // Patterns noticed → journal entries individuales
  for (const p of (parsed.patterns_noticed || []).slice(0, 5)) {
    await ZeusJournalEntry.create({
      entry_type: 'pattern',
      title: p.substring(0, 100),
      content: p,
      importance: 'medium',
      tags: ['self_observation']
    });
    results.journal_entries++;
  }

  // New playbooks
  for (const pb of (parsed.new_playbooks || []).slice(0, 3)) {
    await ZeusPlaybook.create({
      title: pb.title,
      trigger_pattern: pb.trigger_pattern,
      action: pb.action,
      action_reasoning: pb.action_reasoning || '',
      evidence: pb.evidence || '',
      confidence: pb.confidence ?? 0.7,
      category: pb.category || 'other',
      active: true
    });
    results.new_playbooks++;
  }

  // Updates
  for (const upd of (parsed.playbook_updates || []).slice(0, 2)) {
    const existing = await ZeusPlaybook.findOne({ title: upd.title_of_existing, active: true });
    if (!existing) continue;
    const newVersion = await ZeusPlaybook.create({
      title: existing.title,
      trigger_pattern: existing.trigger_pattern,
      action: upd.new_action,
      action_reasoning: upd.reason_for_update,
      evidence: existing.evidence,
      confidence: existing.confidence,
      category: existing.category,
      version: existing.version + 1,
      supersedes: existing._id,
      active: true
    });
    existing.active = false;
    existing.superseded_by = newVersion._id;
    await existing.save();
    results.updated_playbooks++;
  }

  logger.info(`[ZEUS-REFLECTION] ${JSON.stringify(results)}`);
  return results;
}

module.exports = { runWeeklyReflection };
