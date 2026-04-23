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
const ZeusCodeRecommendation = require('../../db/models/ZeusCodeRecommendation');
const ZeusChatMessage = require('../../db/models/ZeusChatMessage');
const SystemConfig = require('../../db/models/SystemConfig');

const claude = new Anthropic({ apiKey: config.claude.apiKey });
const MODEL = 'claude-opus-4-7';
const LAST_CHECK_KEY = 'zeus_proactive_last_check';

// Quiet hours ET — emitir solo casos verdaderamente críticos entre 23:00–07:00
// (kill switch, circuit breaker abierto, etc). Lo demás acumula y se consolida
// a las 07:00 en un solo ping. Fix 2026-04-23: el creador recibió 5 pings entre
// 04:30 y 07:00 por repetición de insights de los mismos ads. Quieter por default
// nocturno + dedup por entidad previene eso.
const QUIET_HOUR_START_ET = 23;  // 11pm ET
const QUIET_HOUR_END_ET = 7;     // 7am ET
// Ventana de dedup por entidad — si ya alertamos sobre la misma entidad en
// este lapso, skip ese signal. 4h balancea "no spammear" vs "si algo se agrava
// realmente diferente, poder alertar".
const ENTITY_DEDUP_WINDOW_HOURS = 4;

/**
 * Retorna true si estamos dentro de las quiet hours ET.
 */
function isQuietHoursET() {
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hour = nowET.getHours();
  if (QUIET_HOUR_START_ET > QUIET_HOUR_END_ET) {
    return hour >= QUIET_HOUR_START_ET || hour < QUIET_HOUR_END_ET;
  }
  return hour >= QUIET_HOUR_START_ET && hour < QUIET_HOUR_END_ET;
}

/**
 * Signals "verdaderamente críticos" que rompen quiet hours. Solo los que
 * requieren acción inmediata del creador, no insights de performance.
 */
function isCriticalEnoughToBreakQuiet(signal) {
  if (signal.kind === 'safety_event' && signal.severity === 'critical') return true;
  if (signal.kind === 'watcher_triggered') return true; // el creador explícitamente lo pidió
  return false;
}

/**
 * Retorna las entidades que YA fueron mencionadas en pings recientes.
 * Extrae entity_name / entity_id / ids de mensajes proactive con
 * context_snapshot.signals en los últimos ENTITY_DEDUP_WINDOW_HOURS.
 */
async function getRecentlyAlertedEntities() {
  const since = new Date(Date.now() - ENTITY_DEDUP_WINDOW_HOURS * 3600000);
  const recent = await ZeusChatMessage.find({
    proactive: true,
    role: 'assistant',
    created_at: { $gte: since }
  }).lean();

  const names = new Set();
  for (const msg of recent) {
    const signals = msg.context_snapshot?.signals || [];
    for (const s of signals) {
      if (s.entity) names.add(String(s.entity).toLowerCase());
      if (s.title) {
        // Heurística: extraer nombre de entity de titles como "Colapso ROAS: <name>"
        const match = s.title.match(/:\s*([^·]+?)(?:\s*·|$)/);
        if (match) names.add(match[1].trim().toLowerCase());
      }
    }
    // También del content del mensaje, extraer nombres entre backticks o comillas
    const content = msg.content || '';
    const backticks = content.match(/`([^`]+)`/g) || [];
    for (const b of backticks) names.add(b.replace(/`/g, '').toLowerCase());
  }
  return names;
}

/**
 * Filtra signals: si la entidad ya fue alertada recientemente, skip.
 */
function filterDedupedSignals(signals, recentEntities) {
  return signals.filter(s => {
    const entityKey = (s.entity || '').toLowerCase();
    if (!entityKey) return true; // sin entidad concreta, no se puede dedup
    if (recentEntities.has(entityKey)) return false;
    return true;
  });
}

/**
 * Consolida signals del mismo kind si son 3+, convirtiéndolos en un solo
 * signal agregado. Evita que 5 "anomaly" críticas se reporten como 5 pings.
 */
function consolidateSignals(signals) {
  const byKind = {};
  for (const s of signals) {
    if (!byKind[s.kind]) byKind[s.kind] = [];
    byKind[s.kind].push(s);
  }
  const out = [];
  for (const [kind, list] of Object.entries(byKind)) {
    if (list.length >= 3) {
      // Consolidar — usar el primero como representativo + agregar count/summary
      out.push({
        kind,
        consolidated: true,
        severity: list.some(s => s.severity === 'critical') ? 'critical' : list[0].severity || 'high',
        count: list.length,
        entities: list.slice(0, 5).map(s => s.entity || s.title || s.name).filter(Boolean),
        sample_titles: list.slice(0, 3).map(s => s.title || s.reason || '').filter(Boolean)
      });
    } else {
      out.push(...list);
    }
  }
  return out;
}

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

  // 6. Code recommendations pending demasiado viejas (>24h)
  // Cambio 22-abr-2026: antes contaba BrainRecommendation (pipeline dark desde 10-mar,
  // contaba fósiles de mediados de marzo). Ahora cuenta las ZeusCodeRecommendation que
  // Zeus mismo genera — esas son las vivas y accionables hoy.
  const staleRecs = await ZeusCodeRecommendation.countDocuments({
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

  // 16. Override de agent stance vieja — ping al creador para renewal
  try {
    const ZeusAgentStance = require('../../db/models/ZeusAgentStance');
    const cutoff = new Date(Date.now() - 20 * 3600000);
    const aging = await ZeusAgentStance.find({
      source: { $in: ['override_creator', 'override_zeus'] },
      superseded_at: null,
      created_at: { $lte: cutoff },
      expires_at: { $gt: new Date() }
    }).lean();
    for (const s of aging) {
      const hrs_old = Math.round((Date.now() - new Date(s.created_at).getTime()) / 3600000);
      const hrs_left = Math.round((new Date(s.expires_at).getTime() - Date.now()) / 3600000);
      signals.push({
        kind: 'stance_override_aging',
        severity: 'medium',
        agent: s.agent,
        stance: s.stance,
        override_by: s.override_by,
        reason: s.override_reason,
        hours_old: hrs_old,
        hours_left: hrs_left,
        detail: `${s.agent} en override ${s.stance} hace ${hrs_old}h por ${s.override_by}. Expira en ${hrs_left}h — renová o dejá expirar.`
      });
    }
  } catch (_) {}

  // 17. Stance briefing fallado (fallback stale activo)
  try {
    const ZeusAgentStance = require('../../db/models/ZeusAgentStance');
    const recentStale = await ZeusAgentStance.find({
      source: { $in: ['fallback_stale', 'fallback_default'] },
      superseded_at: null,
      created_at: { $gte: sinceDate }
    }).lean();
    for (const s of recentStale) {
      signals.push({
        kind: 'stance_briefing_failed',
        severity: s.source === 'fallback_default' ? 'high' : 'medium',
        agent: s.agent,
        fallback: s.source,
        stance: s.stance,
        detail: `${s.agent}: briefing matutino falló, fallback ${s.source === 'fallback_stale' ? 'usando stance de ayer' : 'default steady'}. Revisá logs.`
      });
    }
  } catch (_) {}

  // 15. Platform degraded enter/exit events (circuit breaker)
  try {
    const events = await SafetyEvent.find({
      event_type: { $in: ['platform_degraded_enter', 'platform_degraded_exit'] },
      created_at: { $gte: sinceDate }
    }).sort({ created_at: -1 }).limit(2).lean();
    for (const e of events) {
      signals.push({
        kind: e.event_type,
        severity: e.severity,
        reason: (e.reason || '').substring(0, 200),
        detail: e.event_type === 'platform_degraded_enter'
          ? 'Entré en modo degradado — todos los agentes con writes pausados'
          : 'Salí de modo degradado — operación normal reanudada'
      });
    }
  } catch (err) {
    // noop
  }

  // 14. Preference drafts nuevos (auto-detected — esperando confirmación)
  try {
    const ZeusPreference = require('../../db/models/ZeusPreference');
    const newDrafts = await ZeusPreference.find({
      status: 'proposed',
      source: 'auto_detected',
      created_at: { $gte: sinceDate }
    }).sort({ confidence: -1 }).limit(3).lean();
    if (newDrafts.length) {
      signals.push({
        kind: 'preference_drafts',
        severity: 'medium',
        count: newDrafts.length,
        samples: newDrafts.map(d => ({
          key: d.key,
          value: (d.value || '').substring(0, 120),
          evidence: (d.evidence?.summary || '').substring(0, 120),
          confidence: d.confidence
        }))
      });
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

    let signals = [...watcherSignals, ...await detectSignals(lastCheck)];
    if (signals.length === 0) {
      await SystemConfig.set(LAST_CHECK_KEY, { at: now.toISOString() });
      return { signals: 0, sent: false };
    }

    const initialCount = signals.length;

    // Gate 1: dedup por entidad — skip signals de entidades ya mencionadas en
    // los últimos ENTITY_DEDUP_WINDOW_HOURS en pings proactivos.
    try {
      const recentEntities = await getRecentlyAlertedEntities();
      if (recentEntities.size > 0) {
        const before = signals.length;
        signals = filterDedupedSignals(signals, recentEntities);
        const deduped = before - signals.length;
        if (deduped > 0) logger.info(`[ZEUS-PROACTIVE] dedup: ${deduped} signals skipped (entidades alertadas en últimas ${ENTITY_DEDUP_WINDOW_HOURS}h)`);
      }
    } catch (err) {
      logger.warn(`[ZEUS-PROACTIVE] dedup falló (non-critical): ${err.message}`);
    }

    // Gate 2: quiet hours — solo emitir si hay signal verdaderamente crítico.
    // El resto acumula (se emite cuando salga de quiet hours con la consolidación).
    if (isQuietHoursET()) {
      const critical = signals.filter(isCriticalEnoughToBreakQuiet);
      if (critical.length === 0) {
        logger.info(`[ZEUS-PROACTIVE] quiet hours (${QUIET_HOUR_START_ET}-${QUIET_HOUR_END_ET}h ET) · ${signals.length} signals acumulados sin emitir (ninguno crítico enough)`);
        // NO avanzamos LAST_CHECK_KEY — así los signals quedan disponibles para
        // el primer ciclo fuera de quiet hours, que los consolidará.
        return { signals: signals.length, sent: false, quiet_hours: true };
      }
      signals = critical;
      logger.info(`[ZEUS-PROACTIVE] quiet hours · ${critical.length} signals críticos rompen el silencio`);
    }

    // Gate 3: consolidación — si hay 3+ signals mismo kind, agregarlos en uno.
    signals = consolidateSignals(signals);

    if (signals.length === 0) {
      await SystemConfig.set(LAST_CHECK_KEY, { at: now.toISOString() });
      return { signals: 0, sent: false, filtered_out: initialCount };
    }

    logger.info(`[ZEUS-PROACTIVE] ${signals.length} signals post-gates (${initialCount} inicial): ${signals.map(s => s.kind + (s.consolidated ? `×${s.count}` : '')).join(', ')}`);

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
