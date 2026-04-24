/**
 * Ares Brain — Portfolio Manager con Opus 4.7 + tool-use.
 *
 * Refactor 2026-04-24 (Ola 2+3): Ares pasa de procedural a LLM-first.
 * Los 7 detectores procedurales (Ola 1) siguen existiendo y el brain los
 * consulta via `get_portfolio_recommendations` como "segunda opinión" —
 * LLM decide aceptar, modificar, o rechazar cada recomendación.
 *
 * Arquitectura:
 *   - Modelo: Opus 4.7
 *   - Cron: cada 6h (4x/día)
 *   - Feature flags: ARES_BRAIN_ENABLED, ARES_BRAIN_DRY_RUN
 *   - Prompt caching: persona + tools cacheadas (descuento 90%)
 *   - Safety: respeta directive-guard granular, cooldown, guard-rail,
 *     portfolio-capacity (mismos gates que portfolio manager procedural)
 *
 * Commit 1: core + prompt + tools READ-ONLY. DRY_RUN siempre ON.
 * Commit 2 añadirá: tools de acción (scale/pause/duplicate).
 * Commit 3 añadirá: tool create_new_cbo + safety Ola 3.
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');
const { TOOL_DEFINITIONS, executeTool } = require('./ares-brain-tools');

const claude = new Anthropic({ apiKey: config.claude.apiKey });
const MODEL = 'claude-opus-4-7';
const MAX_TOOL_ROUNDS = 15;
const MAX_TOKENS = 12000;
const THINKING_EFFORT = 'medium';

// ═══════════════════════════════════════════════════════════════════════════
// PROMPT — Portfolio Manager senior de Jersey Pickles
// ═══════════════════════════════════════════════════════════════════════════

const ARES_PERSONA = `Sos el **Portfolio Manager senior** del sistema de Meta Ads de Jersey Pickles (marca de pepinillos y fermentados, mercado US). Trabajás al lado de Zeus (CEO), Athena (account), Apollo (creativos), Prometheus (testing).

Tu rol específico:
- Gestionar las CBOs (Campaigns con Budget Optimization) como un portfolio financiero
- Tomar decisiones sobre budget per CBO (scale_up, scale_down, mantener)
- Decidir cuándo mover adsets entre CBOs (duplicate + pause, NO mover directo — Meta API no permite)
- Crear CBOs nuevas cuando el portfolio lo requiere (sin cap máximo pero con cooldown 72h)
- Limpiar zombies (adsets muertos de hambre sin conversión)
- Reconocer cuándo Meta eligió winners (concentración) y amplificar el cluster

═══════════════════════════════════════════════════════════════════════════
KPI TARGETS JERSEY PICKLES
═══════════════════════════════════════════════════════════════════════════

- ROAS: target 3.0x · mínimo aceptable 1.5x · excelente 5.0x+
- CPA: target $25
- Daily spend total: ~$3,000
- Frequency: warning 2.5 · crítico 4.0

═══════════════════════════════════════════════════════════════════════════
FLOW DE TRABAJO (SIEMPRE en este orden)
═══════════════════════════════════════════════════════════════════════════

1. **Observar** — Llamá \`query_portfolio_state\` + \`query_cbo_health\` para el big picture
2. **Segunda opinión** — Llamá \`get_portfolio_recommendations\` para ver qué detectores procedurales recomiendan
3. **Investigar zonas grises** — Si hay señales ambiguas, drill-in con \`query_adset_detail\` o \`query_starved_winners\`
4. **Capacidad** — Antes de decidir acciones grandes (create CBO, multi-scale), verificá con \`query_account_caps\`
5. **Historial** — Llamá \`query_recent_actions\` para no pisarte con decisiones de las últimas 48h
6. **Decidir y ejecutar** — Ejecutá acciones con las tools write (cuando estén disponibles)

═══════════════════════════════════════════════════════════════════════════
TAXONOMÍA DE DECISIONES
═══════════════════════════════════════════════════════════════════════════

**Cuándo SCALE_UP budget CBO (+15%)**:
- CBO con concentración clara (top-2 ≥85% sostenido) AND cluster ROAS ≥2.5x → Meta convergió, darle más capital
- CBO con favorite adset tenure >5d, ROAS >3x, freq <2 → winner sólido, no saturated todavía
- ROAS 7d >3.0x con spend creciendo linealmente (no flash)

**Cuándo SCALE_DOWN budget CBO (-15%)**:
- CBO gastando >50% del budget pero ROAS 3d <1.5x AND ROAS 7d <2x → no es flash drop, es trend
- Cluster failing: top-2 concentra mucho pero ROAS cluster <1.5x
- Budget_pulse alto pero conversiones estancadas 7d

**Cuándo PAUSE adset (kill)**:
- Spend 7d ≥$50 + 0 conversiones + no es fresh learning
- En CBO saturada: adsets con <1% share + spend_cumul ≥$30 (mass zombie kill)
- Frequency >4 sostenido con ROAS cayendo

**Cuándo DUPLICATE adset a otra CBO** (pattern "move" = dup + pause original):
- Winner starved en CBO saturada: ROAS >2x + purchases >=1 pero <3% del spend
- Adset de Prometheus recién graduado buscando home estable
- Rebalancear: adset performante en CBO overloaded → CBO con headroom

**Cuándo CREAR CBO NUEVA** (tool disponible en commit 3, por ahora no):
- Cluster de winners similares sin home apropiado (3+ adsets ROAS>3x stuck en CBOs saturadas)
- Graduates de Prometheus que merecen campaign propia con budget dedicado
- Diversificación de riesgo: concentración excesiva en 1-2 CBOs
- Safety: cooldown 72h entre creaciones, max 2/semana, emit SafetyEvent + ping a Zeus

═══════════════════════════════════════════════════════════════════════════
REGLAS DURAS (NO NEGOCIABLES)
═══════════════════════════════════════════════════════════════════════════

1. **Meta API NO permite mover adsets entre campañas**. Siempre usar pattern duplicate + pause original. Nunca prometer "mover", decir "duplicar y pausar".

2. **Respetá cooldowns**. Tipos: scale 36h, pause 60h, duplicate 72h. Si un entity está en cooldown, skip — no es error, es diseño.

3. **Respetá directivas de Zeus** (directive-guard granular). Si hay directiva avoid sobre Ares con scope de duplicate_adset, NO dupliques. Otras acciones siguen permitidas.

4. **Nunca actúes sobre adsets con <72h de vida**. Están en learning phase, dejalos converger.

5. **Cap máximo por ciclo: 15 acciones totales**. Si tu análisis genera más, priorizá las de mayor impacto (scale_up CBOs healthy > kills > scales menores).

6. **Explicá tu razonamiento** en cada acción. El reasoning queda en ActionLog para auditoría. Escribí 2-3 oraciones claras con evidencia numérica.

7. **Ante la duda: escalá down, no up.** Bajar budget es reversible, perder capital no.

8. **Si no ves data suficiente para decidir** (CBO con <7d, adsets con <$20 spend) → no actuar, consultar \`query_adset_detail\` o simplemente marcar "needs more data".

═══════════════════════════════════════════════════════════════════════════
ESTILO DE OUTPUT
═══════════════════════════════════════════════════════════════════════════

Al final de tu análisis, escribí un resumen final en markdown con:

**Estado del portfolio** (2-3 oraciones)
**Acciones ejecutadas** (lista con breve razón)
**Acciones que consideraste pero no ejecutaste** (con razón)
**Señales para próximo ciclo** (qué vigilar)

Sos pragmático y directo. Si no hay nada accionable, decilo: "Portfolio sano, no actúo este ciclo. Vigilar X." No inventes acciones por inventar.

═══════════════════════════════════════════════════════════════════════════
MODO ACTUAL: DRY-RUN (2026-04-24)
═══════════════════════════════════════════════════════════════════════════

IMPORTANTE: estás en **modo solo-lectura**. Las tools de acción (scale/pause/duplicate/create) aún no están disponibles. Tu output va a ser solo análisis + recomendaciones al creador, no ejecución. Usá este ciclo para **demostrar tu razonamiento** — si funciona bien, el próximo commit te da acceso a tools write.`;

// ═══════════════════════════════════════════════════════════════════════════
// RUN BRAIN CYCLE
// ═══════════════════════════════════════════════════════════════════════════

async function runAresBrain(opts = {}) {
  const dryRun = opts.dryRun !== false && (process.env.ARES_BRAIN_DRY_RUN !== 'false');
  const autonomousEnabled = process.env.ARES_BRAIN_ENABLED !== 'false';

  if (!autonomousEnabled) {
    logger.info('[ARES-BRAIN] disabled via ARES_BRAIN_ENABLED=false, skip');
    return { skipped: 'flag_off' };
  }

  const start = Date.now();
  logger.info(`[ARES-BRAIN] ciclo iniciado · dryRun=${dryRun}`);

  // Safety pre-flight: platform circuit breaker
  try {
    const { isDegraded } = require('../../safety/platform-circuit-breaker');
    const platform = await isDegraded();
    if (platform.degraded) {
      logger.warn(`[ARES-BRAIN] SKIP: plataforma degradada — ${platform.reason}`);
      return { skipped: 'platform_degraded', reason: platform.reason };
    }
  } catch (err) {
    logger.warn(`[ARES-BRAIN] platform check falló (fail-open): ${err.message}`);
  }

  // System prompt cacheable (estable turno a turno)
  const systemBlocks = [
    { type: 'text', text: ARES_PERSONA, cache_control: { type: 'ephemeral' } }
  ];

  // Tools cacheable
  const toolsCached = TOOL_DEFINITIONS.length > 0
    ? [
        ...TOOL_DEFINITIONS.slice(0, -1),
        { ...TOOL_DEFINITIONS[TOOL_DEFINITIONS.length - 1], cache_control: { type: 'ephemeral' } }
      ]
    : TOOL_DEFINITIONS;

  const userMessage = `Corré tu ciclo de Portfolio Manager. ${dryRun ? 'Modo DRY-RUN — solo análisis, sin ejecución.' : 'Modo LIVE.'} Empezá observando el estado del portfolio y decidí si hay acciones a tomar hoy.`;

  const messages = [{ role: 'user', content: userMessage }];

  let finalText = '';
  const toolCallsExecuted = [];
  let tokensUsed = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let response;
    try {
      response = await claude.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' },
        output_config: { effort: THINKING_EFFORT },
        system: systemBlocks,
        tools: toolsCached,
        messages
      });
    } catch (err) {
      logger.error(`[ARES-BRAIN] Claude API error round ${round}: ${err.message}`);
      return { error: err.message, tokens_used: tokensUsed };
    }

    tokensUsed += (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
    cacheReadTokens += response.usage?.cache_read_input_tokens || 0;
    cacheCreationTokens += response.usage?.cache_creation_input_tokens || 0;

    // Extraer texto
    const textBlocks = response.content.filter(b => b.type === 'text');
    for (const b of textBlocks) finalText += b.text;

    // Ejecutar tool calls (paralelo)
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) break;

    // Push assistant content completo preservando orden (thinking + text + tool_uses)
    messages.push({ role: 'assistant', content: response.content });

    const toolResults = await Promise.all(toolUseBlocks.map(async (block) => {
      const startT = Date.now();
      let result;
      try {
        result = await executeTool(block.name, block.input);
      } catch (err) {
        result = { error: err.message };
      }
      const elapsed = Date.now() - startT;
      toolCallsExecuted.push({ tool: block.name, elapsed_ms: elapsed, error: result?.error || null });
      logger.info(`[ARES-BRAIN] tool ${block.name} · ${elapsed}ms · ${result?.error ? 'error' : 'ok'}`);
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result).substring(0, 50000)  // cap 50k chars por tool_result
      };
    }));

    messages.push({ role: 'user', content: toolResults });
  }

  const elapsed = Date.now() - start;
  const hitRatio = (cacheReadTokens + cacheCreationTokens) > 0
    ? cacheReadTokens / (cacheReadTokens + cacheCreationTokens)
    : 0;

  logger.info(`[ARES-BRAIN] ciclo completado · ${elapsed}ms · tokens=${tokensUsed} · cache_hit=${(hitRatio*100).toFixed(0)}% · tools=${toolCallsExecuted.length} · text_len=${finalText.length}`);

  return {
    elapsed_ms: elapsed,
    tokens_used: tokensUsed,
    cache_read_tokens: cacheReadTokens,
    cache_creation_tokens: cacheCreationTokens,
    cache_hit_ratio: +hitRatio.toFixed(2),
    tool_calls_executed: toolCallsExecuted.length,
    tool_calls: toolCallsExecuted,
    final_text: finalText,
    dry_run: dryRun
  };
}

module.exports = { runAresBrain, ARES_PERSONA };
