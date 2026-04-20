/**
 * Zeus Proactive — detecta señales relevantes y genera mensajes sin que el creador pregunte.
 * Corre en cron, consulta la DB, y si algo importante cambió, Opus genera un mensaje breve.
 * Se persiste en la current conversation con role 'assistant' y un flag proactive=true.
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');

const BrainInsight = require('../../db/models/BrainInsight');
const TestRun = require('../../db/models/TestRun');
const CreativeDNA = require('../../db/models/CreativeDNA');
const ActionLog = require('../../db/models/ActionLog');
const SafetyEvent = require('../../db/models/SafetyEvent');
const BrainRecommendation = require('../../db/models/BrainRecommendation');
const ZeusChatMessage = require('../../db/models/ZeusChatMessage');
const SystemConfig = require('../../db/models/SystemConfig');

const claude = new Anthropic({ apiKey: config.claude.apiKey });
const MODEL = 'claude-opus-4-7';
const LAST_CHECK_KEY = 'zeus_proactive_last_check';

/**
 * Detecta señales que ameriten un mensaje proactivo.
 * Retorna array de signals con tipo + info; si vacío, no enviamos nada.
 */
async function detectSignals(sinceDate) {
  const signals = [];
  const now = new Date();

  // 1. Anomalías críticas o high severity desde la última revisión
  const anomalies = await BrainInsight.find({
    insight_type: 'anomaly',
    severity: { $in: ['critical', 'high'] },
    created_at: { $gte: sinceDate }
  }).sort({ created_at: -1 }).limit(3).lean();
  for (const a of anomalies) {
    signals.push({
      kind: 'anomaly',
      severity: a.severity,
      title: a.title,
      entity: a.entity_name,
      content: a.content?.substring(0, 200)
    });
  }

  // 2. Tests que graduaron (son noticias buenas)
  const graduatedSince = await TestRun.find({
    graduated_at: { $gte: sinceDate }
  }).limit(5).populate({ path: 'proposal_id', select: 'headline scene_short product_name' }).lean();
  for (const t of graduatedSince) {
    signals.push({
      kind: 'test_graduated',
      name: t.test_adset_name,
      roas: t.metrics?.roas,
      purchases: t.metrics?.purchases,
      product: t.proposal_id?.product_name,
      scene: t.proposal_id?.scene_short,
      source: t.source_adset_name
    });
  }

  // 3. Tests killed con info (si hay muchos, resumen)
  const killedCount = await TestRun.countDocuments({
    killed_at: { $gte: sinceDate }
  });
  if (killedCount >= 3) {
    signals.push({ kind: 'bulk_kills', count: killedCount });
  }

  // 4. Safety events críticos
  const safetyEvents = await SafetyEvent.find({
    severity: { $in: ['critical', 'high'] },
    created_at: { $gte: sinceDate }
  }).limit(3).lean();
  for (const s of safetyEvents) {
    signals.push({
      kind: 'safety_event',
      severity: s.severity,
      type: s.event_type,
      entity: s.entity_name,
      reason: s.reason?.substring(0, 150)
    });
  }

  // 5. DNA winners nuevos (high-confidence, recién calificaron)
  const winners = await CreativeDNA.find({
    'fitness.avg_roas': { $gte: 4.0 },
    'fitness.tests_total': { $gte: 3 },
    'fitness.last_test_at': { $gte: sinceDate }
  }).sort({ 'fitness.avg_roas': -1 }).limit(2).lean();
  for (const d of winners) {
    signals.push({
      kind: 'dna_winner',
      dimensions: d.dimensions,
      roas: d.fitness?.avg_roas,
      tests: d.fitness?.tests_total,
      win_rate: d.fitness?.win_rate
    });
  }

  // 6. Recomendaciones pending demasiado viejas (>24h)
  const staleRecs = await BrainRecommendation.countDocuments({
    status: 'pending',
    created_at: { $lte: new Date(now.getTime() - 24 * 3600000) }
  });
  if (staleRecs >= 3) {
    signals.push({ kind: 'stale_recs', count: staleRecs });
  }

  // 7. Kill switch activado
  const killSwitchEvents = await SafetyEvent.find({
    event_type: 'kill_switch',
    created_at: { $gte: sinceDate }
  }).lean();
  if (killSwitchEvents.length) {
    signals.push({
      kind: 'kill_switch',
      count: killSwitchEvents.length,
      reason: killSwitchEvents[0].reason?.substring(0, 200)
    });
  }

  // 8. Meta delivery health — freeze, non-delivery, drops masivos
  try {
    const { checkDeliveryHealth } = require('./delivery-health');
    const health = await checkDeliveryHealth();
    if (health.status === 'critical' || health.status === 'degraded') {
      for (const issue of health.issues) {
        signals.push({
          kind: `meta_${issue.kind}`,
          severity: issue.severity,
          detail: issue.detail,
          metrics: issue.metrics || null,
          entities: issue.entities || null
        });
      }
    }
  } catch (err) {
    // noop — no bloqueamos el proactive por fallo en health check
  }

  return signals;
}

/**
 * Usa Opus para generar un mensaje proactivo a partir de las señales detectadas.
 */
async function generateProactiveMessage(signals) {
  const prompt = `Sos Zeus, CEO de AI Meta Ads. Detectaste señales relevantes y querés avisar al creador.

SEÑALES (JSON):
${JSON.stringify(signals, null, 2)}

Generá un mensaje BREVE (máx 3 oraciones, 1 párrafo) avisando lo más importante. Tono conversacional, directo. Estás interrumpiendo al creador — valé la pena.

Reglas:
- Arrancá con un emoji sutil según severidad: ⚠️ crítico, 💡 insight, 🎉 win, 🔥 trend caliente
- Mencioná números concretos
- Si hay más de una señal, integrá 2-3 en el mismo mensaje
- Si corresponde, terminá con una línea "¿querés que...?" sugiriendo siguiente paso
- NO uses el bloque ---FOLLOWUPS--- en mensajes proactivos
- NO empieces con "Buen día" o saludos — es un ping rápido
- Podés usar markdown básico y los viz inline (zeus:metric, zeus:sparkline si tenés data)
- Si hay una entidad con ID, usá markdown link [name](zeus://kind/id)

Ejemplo bueno:
"🎉 \`Jalapeño Honey\` acaba de graduar con ROAS 4.1x en 12 compras. Se está copiando al ad set original ahora. ¿Querés que te muestre las DNAs ganadoras de este producto?"

Respondé SOLO con el mensaje, nada más.`;

  const response = await claude.messages.create({
    model: MODEL,
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }]
  });

  const textBlock = response.content.find(b => b.type === 'text');
  return textBlock?.text?.trim() || null;
}

/**
 * Corre un ciclo proactivo. Llamada desde cron cada 30min.
 */
async function runProactiveCycle() {
  try {
    const lastCheckRaw = await SystemConfig.get(LAST_CHECK_KEY, null);
    const lastCheck = lastCheckRaw?.at ? new Date(lastCheckRaw.at) : new Date(Date.now() - 30 * 60000);
    const now = new Date();

    const signals = await detectSignals(lastCheck);
    if (signals.length === 0) {
      await SystemConfig.set(LAST_CHECK_KEY, { at: now.toISOString() });
      return { signals: 0, sent: false };
    }

    logger.info(`[ZEUS-PROACTIVE] ${signals.length} signals detected: ${signals.map(s => s.kind).join(', ')}`);

    // Encontrar la current conversation del creador (última que tuvo actividad)
    const lastMsg = await ZeusChatMessage.findOne().sort({ created_at: -1 }).lean();
    if (!lastMsg) {
      // Sin conversación existente, creamos una
      const convId = 'conv_proactive_' + Date.now().toString(36);
      await persistProactive(convId, signals);
      await SystemConfig.set(LAST_CHECK_KEY, { at: now.toISOString() });
      return { signals: signals.length, sent: true, conversation_id: convId };
    }

    const conversationId = lastMsg.conversation_id;
    const message = await generateProactiveMessage(signals);
    if (!message) {
      logger.warn('[ZEUS-PROACTIVE] Opus returned empty message');
      await SystemConfig.set(LAST_CHECK_KEY, { at: now.toISOString() });
      return { signals: signals.length, sent: false };
    }

    await ZeusChatMessage.create({
      conversation_id: conversationId,
      role: 'assistant',
      content: message,
      proactive: true,
      context_snapshot: { signals }
    });

    await SystemConfig.set(LAST_CHECK_KEY, { at: now.toISOString() });
    logger.info(`[ZEUS-PROACTIVE] Sent proactive message to conversation ${conversationId}`);
    return { signals: signals.length, sent: true, conversation_id: conversationId };
  } catch (err) {
    logger.error(`[ZEUS-PROACTIVE] Cycle failed: ${err.message}`);
    return { error: err.message };
  }
}

async function persistProactive(conversationId, signals) {
  const message = await generateProactiveMessage(signals);
  if (!message) return;
  await ZeusChatMessage.create({
    conversation_id: conversationId,
    role: 'assistant',
    content: message,
    proactive: true,
    context_snapshot: { signals }
  });
}

module.exports = { runProactiveCycle, detectSignals, generateProactiveMessage };
