/**
 * Weekly Code Audit — corre domingos 9am ET.
 * Zeus revisa el codebase cruzándolo con los datos de los últimos 14 días
 * y genera recomendaciones concretas (propose_code_change) que se acumulan
 * en el panel 💡 para que el creador las revise.
 */

const logger = require('../../utils/logger');
const { runOracle } = require('./oracle-runner');
const SystemConfig = require('../../db/models/SystemConfig');
const ZeusCodeRecommendation = require('../../db/models/ZeusCodeRecommendation');

const LAST_AUDIT_KEY = 'zeus_weekly_audit_last';

const AUDIT_PROMPT = `[AUDITORÍA SEMANAL AUTOMÁTICA]

Revisá el codebase del sistema buscando mejoras concretas basadas en la data de los últimos 14 días. Sé riguroso — NO inventes recomendaciones por cumplir. Solo reportá lo que tenga evidencia sólida.

Áreas de foco:

1. **Thresholds mal calibrados**: comparaciones con umbrales hardcodeados (ROAS mínimos, spend caps, confidence scores, cooldowns) donde la data muestra que están cortando casos que deberían pasar o dejando pasar casos que no deberían.

2. **Kill/graduation criteria**: en \`src/ai/agent/testing-agent.js\` — ¿están matando winners tempranos? ¿graduando perdedores?

3. **Duplication criteria**: en \`src/ai/agent/ares-agent.js\` — ¿los criterios endurecidos son demasiado restrictivos según los candidatos recientes?

4. **Bugs potenciales**: divisiones por cero, edge cases sin guard, validaciones faltantes que podrían causar los errores que viste en los logs/anomalías.

5. **Dead code**: funciones que según ActionLog/MetricSnapshot nunca se ejecutaron en las últimas semanas.

Flujo por cada hallazgo:
- grep_code / read_code_file para ubicar la lógica
- Correlacioná con data usando los query_* tools (query_overview_history, query_tests, query_dnas, query_actions, etc)
- Si encontrás algo concreto con EVIDENCIA NUMÉRICA → invocá propose_code_change

Reglas estrictas:
- Mínimo 2 datapoints que respalden cada recomendación. Si no tenés evidencia, no propongas.
- NO propongas cambios a tu propio cerebro (oracle-runner.js, oracle-tools.js, agent-brains.js, code-tools.js, oracle-proactive.js) ni a src/safety/*.
- Preferí cambios SMALL y SAFE (ajustar thresholds, agregar guards) sobre reescrituras.
- Máximo 5 recomendaciones por auditoría. Si encontrás más, priorizá las más impactantes.

Al terminar, respondé UNA línea de resumen: "Auditoría completa. Generé N recomendaciones: [categorías]." No más texto.`;

async function runWeeklyAudit() {
  const startedAt = new Date();
  logger.info('[ZEUS-AUDIT] Iniciando auditoría semanal');

  const recsBefore = await ZeusCodeRecommendation.countDocuments({});

  let summary = '';
  const toolCalls = [];

  try {
    const result = await runOracle({
      userMessage: AUDIT_PROMPT,
      mode: 'chat',
      history: [],
      lastSeenAt: null,
      onEvent: (type, data) => {
        if (type === 'tool_use_start') toolCalls.push(data.tool);
      }
    });
    summary = result.text || '';
  } catch (err) {
    logger.error(`[ZEUS-AUDIT] Falló: ${err.message}`);
    return { error: err.message };
  }

  const recsAfter = await ZeusCodeRecommendation.countDocuments({});
  const newRecsCount = recsAfter - recsBefore;

  await SystemConfig.set(LAST_AUDIT_KEY, {
    at: startedAt.toISOString(),
    new_recs: newRecsCount,
    total_tool_calls: toolCalls.length,
    summary: summary.substring(0, 500)
  });

  logger.info(`[ZEUS-AUDIT] Completa. ${newRecsCount} recomendaciones nuevas, ${toolCalls.length} tool calls`);

  return {
    new_recs: newRecsCount,
    tool_calls: toolCalls.length,
    summary
  };
}

module.exports = { runWeeklyAudit };
