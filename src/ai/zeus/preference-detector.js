/**
 * Zeus Preference Detector — auto-detecta patrones en las interacciones del
 * creador y propone drafts de preferencias que el creador aprueba/rechaza.
 *
 * Filosofía: no persistir nada sin confirmación del creador.
 *   - Detecta patrones en conversaciones, code-rec decisions, arch decisions.
 *   - Propone como ZeusPreference status='proposed'.
 *   - Solo status='active' se inyecta en el context del Oracle.
 *
 * Cron semanal (domingo 11:30am ET, junto al architect).
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');

const ZeusPreference = require('../../db/models/ZeusPreference');
const ZeusChatMessage = require('../../db/models/ZeusChatMessage');
const ZeusCodeRecommendation = require('../../db/models/ZeusCodeRecommendation');
const ZeusArchitectureProposal = require('../../db/models/ZeusArchitectureProposal');

const claude = new Anthropic({ apiKey: config.claude.apiKey });
const MODEL = 'claude-opus-4-7';
const MS_30D = 30 * 86400000;

/**
 * Construye el corpus de interacciones para que Claude detecte patrones.
 */
async function buildInteractionCorpus() {
  const since = new Date(Date.now() - MS_30D);

  const [chats, recDecisions, archDecisions, existingPrefs] = await Promise.all([
    ZeusChatMessage.find({
      role: 'user',
      created_at: { $gte: since }
    }).sort({ created_at: -1 }).limit(80).select('content created_at').lean(),

    ZeusCodeRecommendation.find({
      status: { $in: ['accepted', 'rejected', 'applied'] },
      reviewed_at: { $gte: since }
    }).limit(30).select('category severity status rationale review_note').lean(),

    ZeusArchitectureProposal.find({
      status: { $in: ['accepted', 'rejected', 'built'] },
      decided_at: { $gte: since }
    }).limit(15).select('bottleneck recommended creator_decision creator_note status').lean(),

    ZeusPreference.find({ status: { $in: ['active', 'rejected'] } })
      .select('key value status').lean()
  ]);

  return {
    user_messages: chats.map(c => ({
      at: c.created_at,
      text: (c.content || '').substring(0, 300)
    })),
    rec_decisions: recDecisions.map(r => ({
      category: r.category,
      severity: r.severity,
      verdict: r.status,
      about: (r.rationale || '').substring(0, 120),
      note: r.review_note || ''
    })),
    arch_decisions: archDecisions.map(a => ({
      bottleneck: a.bottleneck?.title,
      recommended: a.recommended,
      chose: a.creator_decision,
      note: a.creator_note || ''
    })),
    existing_preferences: existingPrefs
  };
}

const DETECT_PROMPT = `[ZEUS PREFERENCE DETECTOR]

Sos Zeus mirando 30 días de interacciones del creador. Tu tarea: detectar PATRONES DE PREFERENCIA que aún NO están explícitamente guardados, y proponer drafts.

CORPUS (JSON):
{{CORPUS}}

TU TAREA:
1. Leé los mensajes + decisiones + rechazos.
2. Detectá patrones REPETIDOS (≥3 observaciones convergentes) que sugieran una preferencia estable.
3. Propoené hasta 3 drafts de ZeusPreference.

QUÉ BUSCAR (ejemplos):
- Priorización: "rechaza recs de optimization pero acepta las de safety" → priorizá safety sobre optimization
- Estilo: "siempre pide discutir antes de implementar" → style: discusión antes de builds grandes
- Constraint operacional: "nunca aprueba planes con goals nocturnos" → constraint: no goals en horarios nocturnos
- Fase estratégica: menciones repetidas de "long-game" o "fase de inversión" → strategic: long-game sobre day-to-day
- Habit: pregunta siempre por ROAS antes que CPA → habit: chequear ROAS primero en briefings

REGLAS ESTRICTAS:
- Mínimo 3 observaciones concretas convergentes por draft. Si no hay evidencia, no propongas.
- NO propongas drafts que ya existen en existing_preferences (por key o valor equivalente).
- NO propongas drafts que ya fueron rechazados (status='rejected').
- Sé parsimonioso — mejor 0 drafts que 3 flojas.
- Preferencias deben ser ESTABLES (>30d de observación típicamente), no reacciones puntuales.

Respondé SOLO JSON válido (sin backticks):
{
  "drafts": [
    {
      "key": "snake_case_unique_identifier",
      "value": "string de 1-2 oraciones describiendo la preferencia",
      "category": "priority|style|strategic|operational|habit|constraint|other",
      "context": "por qué esta preferencia existe en base a lo observado",
      "confidence": 0.0,
      "evidence": {
        "summary": "resumen en 1 oración del patrón",
        "datapoints": ["observación concreta 1", "observación concreta 2", "observación concreta 3"],
        "observed_in": 3
      }
    }
  ]
}`;

async function detectPreferences() {
  const corpus = await buildInteractionCorpus();

  if (corpus.user_messages.length < 5) {
    logger.info('[PREF-DETECTOR] Corpus insuficiente (<5 mensajes user) — skip');
    return { drafts: [], skipped: 'corpus_too_small' };
  }

  const prompt = DETECT_PROMPT.replace('{{CORPUS}}', JSON.stringify(corpus, null, 2));

  let parsed;
  try {
    const response = await claude.messages.create({
      model: MODEL,
      max_tokens: 3500,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = response.content.find(b => b.type === 'text')?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON en respuesta');
    parsed = JSON.parse(match[0]);
  } catch (err) {
    logger.error(`[PREF-DETECTOR] Claude call falló: ${err.message}`);
    return { drafts: [], error: err.message };
  }

  const drafts = [];
  for (const d of parsed.drafts || []) {
    if (!d.key || !d.value) continue;

    // No duplicar keys ya existentes (active, proposed, o rejected)
    const existing = await ZeusPreference.findOne({ key: d.key });
    if (existing) {
      logger.info(`[PREF-DETECTOR] Skip duplicate key '${d.key}' (status: ${existing.status})`);
      continue;
    }

    const draft = await ZeusPreference.create({
      key: d.key,
      value: d.value,
      category: d.category || 'other',
      context: d.context || '',
      confidence: Math.min(1, Math.max(0, d.confidence || 0.6)),
      source: 'auto_detected',
      status: 'proposed',
      active: false, // NO se inyecta en context hasta que creator confirma
      evidence: {
        summary: d.evidence?.summary || '',
        datapoints: (d.evidence?.datapoints || []).slice(0, 5),
        observed_in: d.evidence?.observed_in || 0
      }
    });
    drafts.push(draft);
  }

  logger.info(`[PREF-DETECTOR] ${drafts.length} drafts propuestos`);
  return { drafts };
}

/**
 * Cron entry.
 */
async function runWeeklyDetectorCron() {
  try {
    return await detectPreferences();
  } catch (err) {
    logger.error(`[PREF-DETECTOR-CRON] ${err.message}`);
    return { error: err.message };
  }
}

module.exports = { detectPreferences, runWeeklyDetectorCron, buildInteractionCorpus };
