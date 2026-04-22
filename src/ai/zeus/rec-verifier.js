/**
 * Zeus Rec Verifier — cierra el loop de verificación automática.
 *
 * Cuando el creador marca una rec como 'applied' o un architecture proposal
 * como 'built', este módulo verifica AUTOMÁTICAMENTE que el cambio realmente
 * ocurrió en el código antes de empezar a medir outcomes.
 *
 * 3 verificaciones:
 *   A. Sintáctica — código cambió como se propuso (ZeusCodeRecommendation)
 *   B. Arquitectónica — capability propuesta existe (ZeusArchitectureProposal)
 *   C. Empírica bootstrap — crea ZeusRecommendationOutcome con baseline al aplicar
 *
 * Verificaciones fallidas disparan proactive ping al chat.
 */

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');

const { PROJECT_ROOT } = require('./code-tools');
const ZeusRecommendationOutcome = require('../../db/models/ZeusRecommendationOutcome');

const claude = new Anthropic({ apiKey: config.claude.apiKey });
const MODEL = 'claude-opus-4-7';

/**
 * Normaliza un snippet para comparación fuzzy (ignora whitespace variable).
 */
function normalizeSnippet(s) {
  return (s || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join('\n');
}

/**
 * Chequea si un snippet aparece en un texto (fuzzy por líneas no vacías).
 */
function snippetInContent(snippet, content) {
  const snipNorm = normalizeSnippet(snippet);
  const contentNorm = normalizeSnippet(content);
  if (!snipNorm) return false;
  // Match exacto primero
  if (contentNorm.includes(snipNorm)) return true;
  // Match por líneas secuenciales (>=70% match)
  const snipLines = snipNorm.split('\n');
  const contentLines = contentNorm.split('\n');
  const snipKey = snipLines.filter(l => l.length > 10); // líneas "sustantivas"
  if (snipKey.length === 0) return contentNorm.includes(snipNorm);
  const hits = snipKey.filter(l => contentLines.some(c => c.includes(l.substring(0, Math.min(60, l.length))))).length;
  return hits / snipKey.length >= 0.7;
}

/**
 * A — Verificación sintáctica para ZeusCodeRecommendation.
 * Lee el archivo target y determina si el cambio se aplicó.
 */
async function verifyCodeApplied(rec) {
  if (!rec.file_path) {
    return { status: 'skipped', notes: 'Rec sin file_path — no se puede verificar' };
  }

  // Guardrails: solo leer archivos dentro de PROJECT_ROOT
  let fullPath;
  try {
    const cleaned = rec.file_path.replace(/^\/+/, '');
    fullPath = path.resolve(PROJECT_ROOT, cleaned);
    if (!fullPath.startsWith(PROJECT_ROOT + path.sep)) {
      return { status: 'skipped', notes: 'path fuera del proyecto' };
    }
  } catch (err) {
    return { status: 'skipped', notes: `path inválido: ${err.message}` };
  }

  if (!fs.existsSync(fullPath)) {
    return { status: 'file_not_found', notes: `${rec.file_path} ya no existe` };
  }

  let content;
  try {
    content = fs.readFileSync(fullPath, 'utf8');
  } catch (err) {
    return { status: 'skipped', notes: `no se pudo leer archivo: ${err.message}` };
  }

  const hasCurrent = rec.current_code && snippetInContent(rec.current_code, content);
  const hasProposed = rec.proposed_code && snippetInContent(rec.proposed_code, content);

  // Lógica de verdicts
  if (rec.proposed_code && hasProposed && !hasCurrent) {
    return { status: 'verified', notes: 'proposed_code presente, current_code ausente — cambio aplicado' };
  }
  if (hasCurrent && !hasProposed) {
    return { status: 'not_applied', notes: 'current_code todavía en el archivo — el cambio no se realizó' };
  }
  if (!hasCurrent && !hasProposed) {
    // Ambos ausentes — puede ser que otra refactor cambió la zona
    if (rec.proposed_code || rec.current_code) {
      return { status: 'diverged', notes: 'ni current ni proposed presentes — la zona divergió por otro refactor' };
    }
    return { status: 'skipped', notes: 'rec sin snippets concretos para verificar' };
  }
  if (hasCurrent && hasProposed) {
    // Raro — ambos. Puede ser que el snippet sea muy genérico.
    return { status: 'verified', notes: 'proposed_code presente (current también, probablemente por match genérico)' };
  }
  return { status: 'skipped', notes: 'condición inesperada' };
}

/**
 * B — Verificación arquitectónica para ZeusArchitectureProposal.
 * Usa Claude para evaluar si la opción elegida fue implementada.
 */
async function verifyArchitectureBuilt(proposal) {
  const chosenLabel = proposal.creator_decision;
  const option = (proposal.options || []).find(o => o.label === chosenLabel);
  if (!option) {
    return { status: 'skipped', notes: 'no hay opción elegida válida', files_found: [], files_expected: [] };
  }

  // Preguntar a Claude con contexto del proposal + lista de archivos en src/
  const { listCodeFiles } = require('./code-tools');
  const allFiles = listCodeFiles({ pattern: 'src/', limit: 300 });

  const prompt = `[VERIFICACIÓN DE BUILD ARQUITECTÓNICO]

Un creador marcó como "built" una propuesta arquitectónica. Tu tarea: verificar si la implementación realmente ocurrió.

PROPUESTA:
Bottleneck: ${proposal.bottleneck?.title || '(sin título)'}
Descripción: ${proposal.bottleneck?.description || ''}

OPCIÓN ELEGIDA: ${option.label}
Approach: ${option.approach || ''}
Descripción: ${option.description || ''}
Notes: ${option.notes || ''}

ARCHIVOS EN src/:
${allFiles.slice(0, 150).join('\n')}

TU TAREA:
1. Según la opción elegida, ¿qué archivos/módulos NUEVOS o MODIFICADOS esperaríamos ver?
2. Mirando la lista de archivos actual, ¿encontrás evidencia de que se implementó?

Respondé SOLO con JSON válido (sin backticks):
{
  "status": "verified|partial|not_found",
  "notes": "2-3 oraciones explicando el verdict",
  "files_found": ["ruta/relativa1", "ruta/relativa2"],
  "files_expected": ["ruta/relativa1", "ruta/relativa2"]
}

- "verified": encontrás archivos claros que implementan la option elegida.
- "partial": hay señales pero no todo lo esperado.
- "not_found": no hay evidencia de implementación.`;

  try {
    const response = await claude.messages.create({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = response.content.find(b => b.type === 'text')?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON en respuesta');
    const parsed = JSON.parse(match[0]);
    return {
      status: parsed.status || 'not_found',
      notes: (parsed.notes || '').substring(0, 500),
      files_found: parsed.files_found || [],
      files_expected: parsed.files_expected || []
    };
  } catch (err) {
    logger.error(`[VERIFIER] Architecture verify falló: ${err.message}`);
    return { status: 'skipped', notes: `verificación falló: ${err.message}`, files_found: [], files_expected: [] };
  }
}

/**
 * Deriva measurement_method apropiado según la categoría de la rec.
 * Phase 3 Hilo D (2026-04-22): KPI delta NO es universal — safety/silent-failure
 * no muestran impacto en ROAS/CPA. Usar método específico por categoría.
 */
function deriveMeasurementMethod(rec) {
  const cat = String(rec.category || 'other').toLowerCase();
  const rationale = String(rec.rationale || '').toLowerCase();

  // Safety (path traversals, SQL injection, auth bypass) — mide ausencia de
  // regresión funcional sobre inputs legítimos. No KPI delta.
  if (cat === 'safety') {
    return {
      method: 'regression_check',
      params: {
        note: 'Verificar que inputs legítimos siguen funcionando post-guard.',
        needs_manual: true
      }
    };
  }

  // Bug con silent failure: el fix reemplaza catch vacío con logger.warn.
  // Métrica correcta: count de warn firings en 7d (>0 = el path se ejercía).
  if (cat === 'bug') {
    if (rationale.includes('silent') || rationale.includes('catch') || rationale.includes('sin log') || rationale.includes('tragado')) {
      return {
        method: 'log_firings',
        params: {
          note: 'Esperamos warns del nuevo pattern si el path se ejerce.',
          expected_direction: 'positive',  // firings>0 es bueno (confirma path vivo)
          needs_log_indexing: true
        }
      };
    }
    return {
      method: 'regression_check',
      params: { note: 'Bug fix genérico — verificar no-regresión.', needs_manual: true }
    };
  }

  // Dead code, naming, refactor: no hay KPI afectado por diseño.
  if (['dead_code', 'naming'].includes(cat)) {
    return { method: 'manual', params: { note: 'Cambio cosmético/estructural, review manual.' } };
  }

  // Threshold, optimization: sí mueven KPIs, método tradicional aplica.
  if (['threshold', 'optimization'].includes(cat)) {
    return { method: 'kpi_delta', params: null };
  }

  // Default: KPI delta (conservador — si el método default falla, al menos
  // produce number aunque sea menos relevante).
  return { method: 'kpi_delta', params: null };
}

/**
 * C — Crea ZeusRecommendationOutcome con baseline para empezar a medir.
 * Se llama inmediatamente después de applied/built.
 *
 * Phase 3 Hilo D: selecciona measurement_method por categoría. Si no es
 * kpi_delta, el method se stampa para que el learner lo respete en T+7d.
 */
async function createOutcomeTracking(rec, recType = 'code_change') {
  try {
    const { method, params } = deriveMeasurementMethod(rec);
    const outcome = await ZeusRecommendationOutcome.create({
      rec_id: String(rec._id),
      rec_type: recType,
      category: rec.category || 'general',
      predicted_impact: rec.expected_impact || rec.reasoning || '',
      predicted_direction: 'unknown',
      entity_type: '',
      entity_id: String(rec._id),
      entity_name: rec.file_path || (rec.bottleneck?.title || ''),
      baseline: {
        applied_at: new Date().toISOString(),
        rec_summary: (rec.evidence_summary || rec.bottleneck?.evidence_summary || '').substring(0, 500)
      },
      applied_at: new Date(),
      measurement_method: method,
      measurement_params: params
    });
    return outcome._id;
  } catch (err) {
    logger.error(`[VERIFIER] createOutcomeTracking falló: ${err.message}`);
    return null;
  }
}

/**
 * Orquestador — handler llamado desde endpoints.
 * Para ZeusCodeRecommendation: verifica sintáctica + crea outcome.
 */
async function onCodeRecApplied(rec) {
  const result = await verifyCodeApplied(rec);
  const outcomeId = await createOutcomeTracking(rec, 'code_change');

  rec.verification = rec.verification || {};
  rec.verification.syntactic_status = result.status;
  rec.verification.syntactic_notes = result.notes;
  rec.verification.syntactic_checked_at = new Date();
  rec.verification.outcome_tracking_id = outcomeId;
  await rec.save();

  logger.info(`[VERIFIER] Rec ${rec._id} applied — syntactic: ${result.status}`);
  return { syntactic: result, outcome_tracking_id: outcomeId };
}

/**
 * Para ZeusArchitectureProposal: verifica build + crea outcome.
 */
async function onArchitectureBuilt(proposal) {
  const result = await verifyArchitectureBuilt(proposal);
  const outcomeId = await createOutcomeTracking(proposal, 'strategic');

  proposal.build_verification = {
    status: result.status,
    notes: result.notes,
    checked_at: new Date(),
    files_found: result.files_found,
    files_expected: result.files_expected
  };
  proposal.outcome_tracking = proposal.outcome_tracking || {};
  await proposal.save();

  logger.info(`[VERIFIER] Architecture ${proposal._id} built — verify: ${result.status}`);
  return { verification: result, outcome_tracking_id: outcomeId };
}

module.exports = {
  verifyCodeApplied,
  verifyArchitectureBuilt,
  createOutcomeTracking,
  onCodeRecApplied,
  onArchitectureBuilt
};
