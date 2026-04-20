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
const MAX_TOOL_ROUNDS = 4;
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

    const assistantContent = [];
    let hadToolUse = false;

    for (const block of response.content) {
      if (block.type === 'text') {
        assistantContent.push(block);
        finalText += block.text;
      } else if (block.type === 'tool_use') {
        hadToolUse = true;
        assistantContent.push(block);
        let toolResult;
        try {
          toolResult = await executeTool(block.name, block.input);
        } catch (err) {
          toolResult = { error: err.message };
        }
        toolsUsed.push(block.name);
        messages.push({ role: 'assistant', content: assistantContent });
        messages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(toolResult).substring(0, 6000)
          }]
        });
        break;
      }
    }

    if (!hadToolUse) break;
  }

  return {
    agent: agentKey,
    agent_name: cfg.name,
    agent_emoji: cfg.emoji,
    response: finalText.trim(),
    tools_used: toolsUsed
  };
}

module.exports = { askAgent, AGENT_CONFIGS };
