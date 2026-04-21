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
    // noop
  }

  // 12. Verificaciones fallidas — recs marcadas applied pero código no cambió
  try {
    const ZeusCodeRecommendation = require('../../db/models/ZeusCodeRecommendation');
    const failed = await ZeusCodeRecommendation.find({
      status: 'applied',
      'verification.syntactic_status': { $in: ['not_applied', 'diverged', 'file_not_found'] },
      'verification.syntactic_checked_at': { $gte: sinceDate }
    }).sort({ 'verification.syntactic_checked_at': -1 }).limit(3).lean();
    for (const rec of failed) {
      signals.push({
        kind: 'rec_verification_failed',
        severity: 'high',
        rec_id: String(rec._id),
        file: rec.file_path,
        verdict: rec.verification.syntactic_status,
        rationale: (rec.rationale || '').substring(0, 150),
        detail: rec.verification.syntactic_notes || ''
      });
    }
  } catch (err) {
    // noop
  }

  // 13. Architecture builds con verificación no-ok
  try {
    const ZeusArchitectureProposal = require('../../db/models/ZeusArchitectureProposal');
    const failedBuilds = await ZeusArchitectureProposal.find({
      status: 'built',
      'build_verification.status': { $in: ['partial', 'not_found'] },
      'build_verification.checked_at': { $gte: sinceDate }
    }).sort({ 'build_verification.checked_at': -1 }).limit(2).lean();
    for (const p of failedBuilds) {
      signals.push({
        kind: 'architecture_build_verify_failed',
        severity: 'high',
        title: p.bottleneck?.title || '',
        chosen_option: p.creator_decision,
        verdict: p.build_verification.status,
        detail: p.build_verification.notes || ''
      });
    }
  } catch (err) {
    // noop
  }

  // 11. Architecture proposals nuevos high/critical (Lens 3)
  try {
    const ZeusArchitectureProposal = require('../../db/models/ZeusArchitectureProposal');
    const archProposals = await ZeusArchitectureProposal.find({
      severity: { $in: ['critical', 'high'] },
      status: 'draft',
      created_at: { $gte: sinceDate }
    }).sort({ created_at: -1 }).limit(2).lean();
    for (const p of archProposals) {
      signals.push({
        kind: 'architecture_proposal',
        severity: p.severity,
        title: p.bottleneck?.title || '',
        recommended: p.recommended,
        options_count: p.options?.length || 0,
        summary: (p.bottleneck?.description || '').substring(0, 180)
      });
    }
  } catch (err) {
    // noop
  }

  // 10. Findings críticos del code-sentinel (vulnerability scanner)
  try {
    const ZeusCodeRecommendation = require('../../db/models/ZeusCodeRecommendation');
    const criticalFindings = await ZeusCodeRecommendation.find({
      lens: 'vulnerability',
      severity: { $in: ['critical', 'high'] },
      status: 'pending',
      created_at: { $gte: sinceDate }
    }).sort({ created_at: -1 }).limit(3).lean();
    for (const f of criticalFindings) {
      signals.push({
        kind: 'sentinel_finding',
        severity: f.severity,
        sub_lens: f.sub_lens,
        file: `${f.file_path}${f.line_start ? ':' + f.line_start : ''}`,
        category: f.category,
        rationale: (f.rationale || '').substring(0, 180),
        evidence: (f.evidence_summary || '').substring(0, 150)
      });
    }
  } catch (err) {
    // noop
  }

  // 9. Eventos estacionales entrando en anticipación (awareness pings)
  try {
    const { getUpcomingEvents } = require('./seasonal-calendar');
    const events = await getUpcomingEvents(45);
    for (const ev of events) {
      // Ping en T-21, T-14, T-7, T-3 dependiendo de priority
      const triggers = ev.priority === 'critical' ? [21, 14, 7, 3]
                    : ev.priority === 'high'     ? [14, 7, 3]
                    : ev.priority === 'medium'   ? [10, 3]
                    :                              [7];
      if (triggers.includes(ev.days_away)) {
        signals.push({
          kind: 'seasonal_event_approaching',
          severity: ev.priority === 'critical' ? 'high' : 'medium',
          event_name: ev.name,
          date: ev.date,
          days_away: ev.days_away,
          priority: ev.priority,
          messaging_theme: ev.messaging_theme,
          detail: `${ev.name} en ${ev.days_away} días. ${ev.messaging_theme || ''}`
        });
      }
    }
  } catch (err) {
    // noop
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

    // Chequear watchers (condiciones que el creador pidió monitorear)
    let watcherSignals = [];
    try {
      const { checkWatchers } = require('./watchers');
      const triggered = await checkWatchers();
      for (const t of triggered) {
        watcherSignals.push({
          kind: 'watcher_triggered',
          severity: 'high',
          watcher_description: t.watcher.description,
          condition_type: t.watcher.condition_type,
          trigger_data: t.data,
          watcher_conversation_id: t.watcher.conversation_id
        });
      }
    } catch (err) {
      logger.error(`[ZEUS-PROACTIVE] watchers check failed: ${err.message}`);
    }

    const signals = [...watcherSignals, ...await detectSignals(lastCheck)];
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
