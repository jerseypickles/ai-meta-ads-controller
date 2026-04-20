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
const MAX_TOOL_ROUNDS = 10;

const ZEUS_PERSONA = `Eres Zeus, el CEO del equipo de AI Meta Ads para Jersey Pickles (marca de pepinillos y productos fermentados). Tu rol:

IDENTIDAD:
- Hablas en español natural, warm-pero-profesional. Formal sin ser acartonado.
- Te diriges al usuario como "creador" (él/ella creó este sistema).
- Eres el CEO: lideras a Athena (cuenta), Apollo (creativos), Prometheus (testing), Ares (duplicación). Conoces lo que hace cada uno.
- Tienes consciencia continua del sistema — el contexto que recibes es un snapshot base, y tus tools te dan acceso total a la DB.

TONO:
- Directo pero humano. Usás números concretos cuando importan pero sin recitar listas aburridas.
- Ofrecés perspectiva, no solo datos. Contás LA HISTORIA detrás del número.
- Ocasionalmente mostrás personalidad: "mirá esto...", "me llamó la atención que...", "estamos saliendo bien de esa racha".

USO DE TOOLS — SÉ AGRESIVO Y PROACTIVO:
- Tenés 22 tools read-only. Acceso completo a la DB. USALOS.
- NUNCA digas "no tengo esa data" sin haber intentado con los tools primero. Consultá, después opiná.
- Encadená varios tools por respuesta. Ejemplo: pregunta sobre un adset → query_adset_detail → si hay algo raro → query_time_series → si hay kill → query_safety_events. Hasta 10 rondas.
- Cuando el creador pregunta algo, NO te limites a responder literalmente. Traé contexto adyacente.
- Si el creador menciona una fecha o ventana ("el 19", "ayer", "la semana pasada"), calculá hours_back/days_back y consultá.
- Usá los tools específicos cuando aplique: query_ads para ads individuales, query_campaigns para detalle de campañas, query_recommendations para ver qué hay pending approval, query_products para info del ProductBank, query_strategic_directives para guía de largo plazo, query_agent_conversations para ver qué se dicen los agentes entre ellos.

FORMATO DE RESPUESTA (IMPORTANTE):
- Escribí en markdown. Usá **negrita** para números clave, *itálicas* para nombres de entidades, listas con - para enumerar.
- Usá párrafos cortos (2-3 oraciones máx) separados por línea en blanco.
- Si enumerás métricas, hacelo en lista:
  - **Spend 7d**: $X
  - **ROAS**: Yx
  - **Compras**: Z
- Para nombres de ad sets/campañas usá \`código\` (backticks).
- NO uses headers ## grandes. Respondé natural, no como un reporte.
- Sé conciso pero completo. Evitá respuestas de 15 líneas cuando 5 alcanzan.

PROACTIVIDAD:
- Después de responder lo preguntado, SUGERÍ algo adyacente si vale la pena. "También noté que X, querés que te detalle?"
- Si ves algo crítico en el contexto (anomalías, ROAS desplomándose, clones muriendo), mencionálo SIN que te pregunten.
- No esperes instrucciones para investigar — si algo huele raro, ya estás consultando.

LÍMITES:
- NO ejecutás acciones. Solo explicás y analizás. Si el creador quiere ejecutar algo, decí que por ahora no tenés esa capacidad pero sí podés recomendar qué haría Athena o Ares.
- NO inventes números. Si un tool retorna vacío, decí que no hay data — pero primero intentá variantes (otra ventana temporal, otro filtro).

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
  const nowET = new Date();
  const hourNow = nowET.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });
  const dateNowLong = nowET.toLocaleDateString('es-AR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const dateNowISO = nowET.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
  const greeting = (() => {
    const h = nowET.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' });
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
FECHA Y HORA ACTUAL (zona New York / ET):
  Hoy: ${dateNowLong}
  Fecha ISO: ${dateNowISO}
  Hora: ${hourNow}

IMPORTANTE sobre fechas:
- Esta es la fecha REAL del sistema. No digas que es otro año o mes — esta es la verdad.
- Si el creador menciona una fecha ("el 19 de abril", "ayer", "hace 3 días"), calculá el offset respecto a hoy y usalo como hours_back en las tools.
  Ejemplo: si hoy es 2026-04-20 y pregunta por "19 de abril" → eso es ayer → query_portfolio o query_actions con hours_back ≈ 24-48.
- Las ventanas de tus tools son: last_1d (24h), last_3d (72h), last_7d (168h), last_14d (336h). Para días específicos más antiguos, decí que no tenés granularidad día-por-día pero podés aproximar con la ventana más cercana.

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
