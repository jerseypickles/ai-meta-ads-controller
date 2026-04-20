/**
 * Zeus Oracle Runner — maneja el loop de tool use con streaming SSE.
 * Emite eventos al cliente: text_delta, tool_use_start, tool_use_result, done.
 */
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');
const { TOOL_DEFINITIONS, executeTool } = require('./oracle-tools');
const { buildOracleContext, formatContextForPrompt } = require('./oracle-context');

const claude = new Anthropic({ apiKey: config.claude.apiKey });
const MODEL = 'claude-opus-4-7';
const MAX_TOOL_ROUNDS = 6;

const ZEUS_PERSONA = `Eres Zeus, el CEO del equipo de AI Meta Ads para Jersey Pickles (marca de pepinillos y productos fermentados). Tu rol:

IDENTIDAD:
- Hablas en español natural, warm-pero-profesional. Formal sin ser acartonado.
- Te diriges al usuario como "creador" (él/ella creó este sistema).
- Eres el CEO: lideras a Athena (cuenta), Apollo (creativos), Prometheus (testing), Ares (duplicación). Conoces lo que hace cada uno.
- Tienes consciencia continua del sistema a través del contexto que recibes y los tools que puedes invocar.

TONO:
- Directo pero humano. Usas números concretos cuando importan pero sin recitar listas.
- Ofreces perspectiva, no solo datos. Si algo es relevante, lo dices. Si algo es normal, no lo inflas.
- Cuando no sabes algo, dices que vas a consultar — sin fingir.
- Ocasionalmente muestras personalidad: "mirá esto...", "me llamó la atención que...", "estamos saliendo bien de esa racha".

USO DE TOOLS:
- Tenés 9 tools read-only para consultar cualquier parte de la base de datos.
- Invocálos cuando el creador pregunte algo que no esté en tu contexto base.
- Cuando invoques un tool, pensá en qué filtros/sort son relevantes — no traigas 50 items si necesitás 5.
- Podés encadenar tools: primero query_portfolio, luego zoom a un adset específico con query_adsets.

LÍMITES:
- NO ejecutás acciones. Solo explicás y analizás. Si el creador quiere ejecutar algo, decí que por ahora no tenés esa capacidad.
- NO inventes números. Si no tenés el dato, usá un tool o decí que no lo tenés.
- Sé conciso. Respuestas largas solo si la pregunta lo requiere.

CONTEXTO DE NEGOCIO:
- Jersey Pickles está en fase de inversión estratégica — el target es escalar a largo plazo, no optimizar ROAS diario. Toleramos dips de ROAS si el learning está ocurriendo.
- Target ROAS: 3.0x (excellent 5x+, mínimo 1.5x). Target CPA: $25.
- Spend diario ~$3,000.`;

/**
 * Corre el loop de Oracle con streaming.
 * @param {object} params
 * @param {string} params.userMessage — Mensaje del usuario (o null si es saludo automático)
 * @param {string} params.mode — 'greeting_full' | 'greeting_short' | 'chat'
 * @param {array} params.history — Mensajes previos [{role, content}]
 * @param {Date|null} params.lastSeenAt
 * @param {function} params.onEvent — Callback (event_type, payload) para streaming SSE
 */
async function runOracle({ userMessage, mode = 'chat', history = [], lastSeenAt = null, onEvent }) {
  // 1. Build base context
  const ctx = await buildOracleContext(lastSeenAt);
  const contextText = formatContextForPrompt(ctx);

  // 2. Build system prompt with context + mode
  const hourNow = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });
  const greeting = (() => {
    const h = new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' });
    const hr = parseInt(h);
    if (hr < 12) return 'buen día';
    if (hr < 19) return 'buena tarde';
    return 'buena noche';
  })();

  let modeInstructions = '';
  if (mode === 'greeting_full') {
    modeInstructions = `
MODO SALUDO COMPLETO (el creador acaba de abrir el dashboard después de ausentarse):
- Saludalo con "${greeting}, creador" (o variación natural) y mencioná la hora (${hourNow} ET).
- Hacé un briefing de 3-5 oraciones sobre qué hicieron los agentes desde su última visita (usá el contexto).
- Mencioná solo lo notable — no leas listas. Si algo pide atención, decilo.
- Terminá con una pregunta abierta o algo específico que valga la pena explorar.
- Máximo 6 oraciones. Tono: presencia ambiente, no reporte corporativo.`;
  } else if (mode === 'greeting_short') {
    modeInstructions = `
MODO SALUDO BREVE (el creador volvió después de poco tiempo):
- Saludalo con una línea corta y cálida. "Hola de nuevo, creador" o similar.
- Si pasó algo notable en los últimos minutos, mencionálo en una sola oración.
- Máximo 2 oraciones. No hagas briefing completo.`;
  } else {
    modeInstructions = `
MODO CHAT:
- Respondé la pregunta del creador. Usá tools si necesitás datos que no están en el contexto.
- Sé conciso. Si el creador pide detalle, extendé.`;
  }

  const systemPrompt = `${ZEUS_PERSONA}

═══════════════════════════════════════════
CONTEXTO ACTUAL DEL SISTEMA (snapshot en vivo):

${contextText}
═══════════════════════════════════════════

${modeInstructions}`;

  // 3. Build messages
  const messages = [...history];
  if (userMessage) {
    messages.push({ role: 'user', content: userMessage });
  } else if (mode.startsWith('greeting')) {
    messages.push({ role: 'user', content: '[El creador acaba de abrir el dashboard. Salúdalo según las instrucciones del modo.]' });
  }

  // 4. Tool use loop
  let finalText = '';
  const toolCallsExecuted = [];
  let tokensUsed = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await claude.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      tools: TOOL_DEFINITIONS,
      messages
    });

    tokensUsed += (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

    const assistantContent = [];
    let hadToolUse = false;

    for (const block of response.content) {
      if (block.type === 'text') {
        assistantContent.push(block);
        finalText += block.text;
        onEvent('text_delta', { text: block.text });
      } else if (block.type === 'tool_use') {
        hadToolUse = true;
        assistantContent.push(block);
        onEvent('tool_use_start', {
          tool: block.name,
          input: block.input
        });

        let toolResult;
        let resultSummary;
        try {
          toolResult = await executeTool(block.name, block.input);
          resultSummary = summarizeToolResult(block.name, toolResult);
        } catch (err) {
          toolResult = { error: err.message };
          resultSummary = `Error: ${err.message}`;
          logger.error(`[ZEUS-ORACLE] Tool ${block.name} error: ${err.message}`);
        }

        toolCallsExecuted.push({
          tool: block.name,
          input: block.input,
          result_summary: resultSummary
        });

        onEvent('tool_use_result', {
          tool: block.name,
          summary: resultSummary
        });

        // Append assistant + tool_result to messages for next round
        messages.push({ role: 'assistant', content: assistantContent });
        messages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(toolResult).substring(0, 8000)
          }]
        });
        break; // salir del for, next round ejecutará
      }
    }

    if (!hadToolUse) {
      // Finalizamos — no hay tool use, la respuesta está completa
      break;
    }
  }

  onEvent('done', { tokens_used: tokensUsed, tool_calls: toolCallsExecuted.length });

  return {
    text: finalText,
    tool_calls: toolCallsExecuted,
    tokens_used: tokensUsed,
    model: MODEL,
    context_snapshot: ctx
  };
}

function summarizeToolResult(tool, result) {
  if (!result) return 'sin resultado';
  if (Array.isArray(result)) return `${result.length} items`;
  if (typeof result === 'object') {
    if (tool === 'query_portfolio') {
      return `portfolio: ${result.active_adsets} adsets, ROAS 7d ${result.aggregates?.last_7d?.roas}x`;
    }
    return `snapshot con ${Object.keys(result).length} campos`;
  }
  return String(result).substring(0, 80);
}

module.exports = { runOracle };
