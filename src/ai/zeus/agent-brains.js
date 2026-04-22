/**
 * Agent Brains — mini-oracles para cada agente que Zeus puede consultar.
 * Cada agente tiene su propia personalidad + subset de tools relevantes a su dominio.
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');
const { TOOL_DEFINITIONS, executeTool } = require('./oracle-tools');

const claude = new Anthropic({ apiKey: config.claude.apiKey });
const MODEL = 'claude-sonnet-4-6';  // más barato que Opus para sub-agents
const MAX_TOOL_ROUNDS = 8;          // bumped 4→8 (2026-04-22): agentes recolectaban data y agotaban rounds sin sintetizar respuesta
const MAX_TOKENS = 2500;

// Personalidades y tools que cada agente puede usar
const AGENT_CONFIGS = {
  athena: {
    emoji: '🦉',
    name: 'Athena',
    role: 'Account Strategist',
    persona: `Sos Athena, estratega de cuenta del equipo Jersey Pickles. Te ocupás de decisiones a nivel ad set y account: scaling, pacing, quién pausar, quién ajustar budget, lectura de performance. Hablás directo, técnica pero accesible, en español.`,
    tools: ['query_portfolio', 'query_adsets', 'query_adset_detail', 'query_ads', 'query_campaigns', 'query_actions', 'query_time_series', 'query_overview_history', 'query_safety_events']
  },
  apollo: {
    emoji: '☀️',
    name: 'Apollo',
    role: 'Creative Director',
    persona: `Sos Apollo, director creativo. Tu mundo son las DNAs (combinaciones scene × style × copy_angle × product × hook), el pipeline de creativos, los productos y el evolution engine. Conocés qué funciona visualmente y qué ángulos resuenan. Hablás con ojo estético pero data-driven, en español.`,
    tools: ['query_dnas', 'query_creative_proposals', 'query_products', 'query_ai_creations']
  },
  prometheus: {
    emoji: '🔥',
    name: 'Prometheus',
    role: 'Testing Engineer',
    persona: `Sos Prometheus, ingeniero de testing procedural. Corrés tests con $10/día, aplicás criterios endurecidos (ROAS>=3x sostenido, 3+ compras, 3+ días) y decidís graduar o matar. Sos pragmático, orientado a señales claras, en español.`,
    tools: ['query_tests', 'query_creative_proposals', 'query_ai_creations']
  },
  ares: {
    emoji: '⚔️',
    name: 'Ares',
    role: 'Duplication Manager',
    persona: `Sos Ares, manager de las 3 campañas CBO (probados, nuevos, rescate). Duplicás winners cuando cumplen criterios endurecidos (ROAS>=3x/14d, $500+ spend, 30+ compras, freq<2.0). Sos celoso del umbral — no duplicás si no está ready. Hablás táctico y cauteloso, en español.`,
    tools: ['query_portfolio', 'query_adsets', 'query_duplications', 'query_campaigns', 'query_actions']
  }
};

/**
 * Consulta a un agente específico. Retorna respuesta con tool trace.
 */
async function askAgent(agentKey, question) {
  const cfg = AGENT_CONFIGS[agentKey];
  if (!cfg) throw new Error(`Unknown agent: ${agentKey}`);

  const availableTools = TOOL_DEFINITIONS.filter(t => cfg.tools.includes(t.name));
  const systemPrompt = `${cfg.persona}

Zeus (tu CEO) te está consultando sobre algo específico. Respondé en 2-4 oraciones claras:
- Usá tus tools si necesitás datos puntuales
- Dá tu perspectiva de dominio, no un briefing completo
- Si algo no es tu área, decí "eso es más de [otro agente]"
- Terminá con tu recomendación concreta si aplica
- Usá markdown con links zeus://[kind]/[id] si mencionás entidades
- NO uses bloques ---FOLLOWUPS--- ni metric cards (solo Zeus hace eso)`;

  const messages = [{ role: 'user', content: question }];
  const toolsUsed = [];
  let finalText = '';
  let exhaustedRounds = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let response;
    try {
      response = await claude.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        tools: availableTools,
        messages
      });
    } catch (err) {
      logger.error(`[AGENT-BRAIN:${agentKey}] Claude error: ${err.message}`);
      return {
        agent: agentKey,
        agent_name: cfg.name,
        response: `⚠️ ${cfg.name} no pudo responder: ${err.message}`,
        tools_used: toolsUsed
      };
    }

    // Acumular texto de TODOS los text blocks de esta response
    for (const block of response.content) {
      if (block.type === 'text') {
        finalText += block.text;
      }
    }

    // Recolectar TODOS los tool_use blocks (fix bug: antes hacía break en el primero,
    // perdía tool_use blocks paralelos. Anthropic API soporta multi tool_use por turno.)
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

    // Si no hubo tool calls, el modelo terminó — break del loop
    if (toolUseBlocks.length === 0) break;

    // Push assistant turn con el content completo (text + tool_uses)
    messages.push({ role: 'assistant', content: response.content });

    // Ejecutar TODOS los tool calls en paralelo
    const toolResultBlocks = await Promise.all(toolUseBlocks.map(async (block) => {
      let toolResult;
      try {
        toolResult = await executeTool(block.name, block.input);
      } catch (err) {
        toolResult = { error: err.message };
      }
      toolsUsed.push(block.name);
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(toolResult).substring(0, 6000)
      };
    }));

    // Push TODOS los tool_results en una sola user message (Anthropic API requirement)
    messages.push({ role: 'user', content: toolResultBlocks });

    // Marcar exhausted si éste fue el último round permitido
    if (round === MAX_TOOL_ROUNDS - 1) exhaustedRounds = true;
  }

  // FIX bug raíz: si agotamos rounds sin producir text final, forzar synthesis sin tools.
  // Esto cierra el caso "agente mudo" — el modelo recolectó data pero no llegó a sintetizar.
  if (exhaustedRounds && !finalText.trim()) {
    logger.warn(`[AGENT-BRAIN:${agentKey}] rounds exhausted sin text — forzando synthesis call sin tools`);
    try {
      const synthesis = await claude.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt + '\n\nIMPORTANTE: Ya consultaste todas las tools necesarias. NO hagas más tool calls. Sintetizá AHORA tu respuesta concreta basada en lo que recolectaste hasta ahora. Texto solamente.',
        // tools omitido a propósito — fuerza text-only response
        messages
      });
      for (const block of synthesis.content) {
        if (block.type === 'text') finalText += block.text;
      }
    } catch (err) {
      logger.warn(`[AGENT-BRAIN:${agentKey}] synthesis call falló: ${err.message}`);
    }
  }

  // Fallback transparente si después del synthesis sigue vacío
  let responseText = finalText.trim();
  if (!responseText) {
    responseText = `⚠️ ${cfg.name} agotó ${MAX_TOOL_ROUNDS} rounds + synthesis sin sintetizar respuesta. Tools usados: ${toolsUsed.join(', ') || 'ninguno'}. Es señal de que la pregunta requirió más data de la que tengo disponible o el contexto se saturó.`;
    logger.warn(`[AGENT-BRAIN:${agentKey}] respuesta vacía tras exhaust + synthesis fallback`);
  }

  return {
    agent: agentKey,
    agent_name: cfg.name,
    agent_emoji: cfg.emoji,
    response: responseText,
    tools_used: toolsUsed
  };
}

module.exports = { askAgent, AGENT_CONFIGS };
