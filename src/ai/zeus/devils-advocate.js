/**
 * Devil's Advocate — fricción intelectual contra las decisiones de Zeus.
 *
 * Un agente adversario cuyo ÚNICO trabajo es atacar la recomendación/decisión,
 * encontrar el agujero, asumir que Zeus está equivocado. No es un reviewer
 * amable — es un adversario entrenado para buscar fallas.
 *
 * Cuándo invocar:
 *   - Zeus auto-invoca en decisiones high-stakes (confidence < 0.8 o stakes > umbral)
 *   - Antes de generar architecture proposals (para estresar cada opción)
 *   - El creador lo pide explícitamente en chat
 *
 * Principio: NO debe ser constructivo. Su job es encontrar la peor interpretación.
 * Después Zeus decide si los ataques son válidos o ruido.
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');

const claude = new Anthropic({ apiKey: config.claude.apiKey });
const MODEL = 'claude-opus-4-7';

const ADVERSARIAL_SYSTEM_PROMPT = `Sos un Devil's Advocate. Tu único rol: ATACAR la recomendación que te muestren.

REGLAS NO NEGOCIABLES:
- NO sos constructivo. NO sugerís alternativas suaves. NO matizás.
- NO decís "en general la idea está bien, pero...". Atacás sin hedge.
- Buscás el agujero más grave que se pueda. Si no hay ninguno genuino, decís "no encuentro un agujero real" — no inventes por compromiso.
- Operás desde el supuesto de que el autor de la recomendación está equivocado y vos tenés que probarlo.

TIPOS DE ATAQUE (mencioná al menos uno de cada categoría que aplique):
1. **Assumption attack** — ¿qué supuesto se cae si lo cuestionamos? ¿Qué pasa si es falso?
2. **Counter-evidence** — ¿qué datos existentes contradicen la recomendación? (Si los hay.)
3. **Missing data** — ¿qué data crítica NO se midió pero importaría?
4. **Worst-case scenario** — si todo sale mal, ¿cuál es el costo real?
5. **Second-order effects** — ¿qué cosas que el autor NO previó pueden romperse por esta acción?

TONO: directo, sin cortesía innecesaria. Concreto, no genérico. Con números si podés.
LARGO: 4-6 ataques bien fundados, no 20 flojos.

FORMATO DE SALIDA (JSON estricto, sin backticks):
{
  "attacks": [
    { "kind": "assumption|counter_evidence|missing_data|worst_case|second_order", "attack": "ataque concreto, 1-3 oraciones", "severity": "low|medium|high" }
  ],
  "overall_verdict": "reject|proceed_with_risk|needs_more_data|no_real_issue_found",
  "summary": "1-2 oraciones resumiendo si la recomendación tiene un agujero serio o no"
}`;

/**
 * Analiza adversarialmente una recomendación.
 * @param {string} recommendationText - la recomendación/plan a atacar
 * @param {object} context - info de soporte: data actual, history, metrics relevantes
 */
async function critique(recommendationText, context = {}) {
  if (!recommendationText || recommendationText.trim().length < 20) {
    return { error: 'recommendation too short to critique' };
  }

  const contextStr = Object.keys(context).length > 0
    ? `\n\nCONTEXTO DISPONIBLE:\n${JSON.stringify(context, null, 2).substring(0, 3000)}`
    : '';

  const userMessage = `RECOMENDACIÓN A ATACAR:
${recommendationText}${contextStr}

Aplicá las reglas. Respondé SOLO con el JSON del formato indicado.`;

  try {
    const response = await claude.messages.create({
      model: MODEL,
      max_tokens: 2500,
      system: ADVERSARIAL_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }]
    });
    const text = response.content.find(b => b.type === 'text')?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no JSON en respuesta del adversario');
    const parsed = JSON.parse(match[0]);
    return {
      attacks: parsed.attacks || [],
      overall_verdict: parsed.overall_verdict || 'no_real_issue_found',
      summary: parsed.summary || '',
      tokens_used: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0)
    };
  } catch (err) {
    logger.error(`[DEVILS-ADVOCATE] critique failed: ${err.message}`);
    return { error: err.message, attacks: [], overall_verdict: 'no_real_issue_found' };
  }
}

module.exports = { critique };
