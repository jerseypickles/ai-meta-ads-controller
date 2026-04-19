const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');
const BrainInsight = require('../../db/models/BrainInsight');
const TestRun = require('../../db/models/TestRun');
const MetricSnapshot = require('../../db/models/MetricSnapshot');
const ActionLog = require('../../db/models/ActionLog');

const claude = new Anthropic({ apiKey: config.claude.apiKey });

// Haiku 4.5 — barato y suficiente para un juicio de validacion
const VALIDATOR_MODEL = 'claude-haiku-4-5-20251001';

// Hipotesis se validan 7 dias despues de emitidas
const HYPOTHESIS_AGE_DAYS = 7;

// Ventana para capturar hipotesis que ya pasaron la edad pero aun no se validaron
// (si el cron fallo un dia, aun capturar al dia siguiente hasta 14d)
const HYPOTHESIS_MAX_AGE_DAYS = 14;

/**
 * Construye el contexto de data que necesita el LLM para juzgar una hipotesis.
 * Retorna un resumen compacto de TODO lo que paso DESDE que se emitio la hipotesis.
 */
async function _gatherValidationContext(hypothesis) {
  const createdAt = new Date(hypothesis.created_at);
  const now = new Date();

  // 1. Account ROAS antes (ventana 7d alrededor de createdAt) vs ahora (ultimos 7d)
  // Query snapshots de ad-set con los 7d pasados al momento createdAt
  const snapsAtCreation = await MetricSnapshot.aggregate([
    { $match: {
      entity_type: 'adset',
      snapshot_at: {
        $gte: new Date(createdAt.getTime() - 86400000),
        $lte: new Date(createdAt.getTime() + 86400000)
      }
    }},
    { $sort: { entity_id: 1, snapshot_at: -1 } },
    { $group: {
      _id: '$entity_id',
      spend: { $first: '$metrics.last_7d.spend' },
      revenue: { $first: '$metrics.last_7d.purchase_value' },
      purchases: { $first: '$metrics.last_7d.purchases' }
    }},
    { $group: {
      _id: null,
      total_spend: { $sum: '$spend' },
      total_rev: { $sum: '$revenue' },
      total_purch: { $sum: '$purchases' }
    }}
  ]);

  const snapsNow = await MetricSnapshot.aggregate([
    { $match: {
      entity_type: 'adset',
      snapshot_at: { $gte: new Date(now.getTime() - 86400000) }
    }},
    { $sort: { entity_id: 1, snapshot_at: -1 } },
    { $group: {
      _id: '$entity_id',
      spend: { $first: '$metrics.last_7d.spend' },
      revenue: { $first: '$metrics.last_7d.purchase_value' },
      purchases: { $first: '$metrics.last_7d.purchases' }
    }},
    { $group: {
      _id: null,
      total_spend: { $sum: '$spend' },
      total_rev: { $sum: '$revenue' },
      total_purch: { $sum: '$purchases' }
    }}
  ]);

  const before = snapsAtCreation[0] || { total_spend: 0, total_rev: 0, total_purch: 0 };
  const now_ = snapsNow[0] || { total_spend: 0, total_rev: 0, total_purch: 0 };
  const roasBefore = before.total_spend > 0 ? before.total_rev / before.total_spend : 0;
  const roasNow = now_.total_spend > 0 ? now_.total_rev / now_.total_spend : 0;

  // 2. TestRuns con transicion DESDE que se creo la hipotesis
  const testsInWindow = await TestRun.find({
    $or: [
      { graduated_at: { $gte: createdAt } },
      { killed_at: { $gte: createdAt } },
      { expired_at: { $gte: createdAt } }
    ]
  }).populate('proposal_id', 'scene_short headline style angle').lean();

  // Agregar por scene
  const sceneStats = {};
  for (const t of testsInWindow) {
    const scene = t.proposal_id?.scene_short || 'unknown';
    if (!sceneStats[scene]) sceneStats[scene] = { graduated: 0, killed: 0, total_roas: 0, count: 0 };
    sceneStats[scene].count++;
    sceneStats[scene].total_roas += t.metrics?.roas || 0;
    if (t.phase === 'graduated') sceneStats[scene].graduated++;
    if (t.phase === 'killed') sceneStats[scene].killed++;
  }
  const scenesArr = Object.entries(sceneStats)
    .map(([scene, s]) => ({
      scene,
      avg_roas: s.count > 0 ? (s.total_roas / s.count).toFixed(2) : '0',
      graduated: s.graduated,
      killed: s.killed,
      total: s.count
    }))
    .sort((a, b) => parseFloat(b.avg_roas) - parseFloat(a.avg_roas));

  // 3. Acciones de Athena con reward medido desde la hipotesis
  const actionsSince = await ActionLog.aggregate([
    { $match: {
      agent_type: 'unified_agent',
      executed_at: { $gte: createdAt },
      learned_reward: { $ne: null }
    }},
    { $group: {
      _id: '$action',
      count: { $sum: 1 },
      avg_reward: { $avg: '$learned_reward' }
    }}
  ]);

  // 4. Graduates que salieron de learning en este periodo
  const recentGrads = await TestRun.countDocuments({
    graduated_at: { $gte: createdAt }
  });
  const recentKills = await TestRun.countDocuments({
    killed_at: { $gte: createdAt }
  });

  // 5. Ares CBO performance
  const cboSnapsNow = await MetricSnapshot.aggregate([
    { $match: {
      entity_type: 'adset',
      entity_name: { $regex: '\\[Ares\\]' },
      snapshot_at: { $gte: new Date(now.getTime() - 86400000) }
    }},
    { $sort: { entity_id: 1, snapshot_at: -1 } },
    { $group: {
      _id: '$entity_id',
      spend: { $first: '$metrics.last_7d.spend' },
      revenue: { $first: '$metrics.last_7d.purchase_value' }
    }},
    { $group: {
      _id: null,
      total_spend: { $sum: '$spend' },
      total_rev: { $sum: '$revenue' }
    }}
  ]);
  const cbo = cboSnapsNow[0] || { total_spend: 0, total_rev: 0 };
  const cboRoas = cbo.total_spend > 0 ? cbo.total_rev / cbo.total_spend : 0;

  const daysAgo = Math.floor((now.getTime() - createdAt.getTime()) / 86400000);

  return {
    days_ago: daysAgo,
    account: {
      roas_then: roasBefore.toFixed(2),
      roas_now: roasNow.toFixed(2),
      spend_then: Math.round(before.total_spend),
      spend_now: Math.round(now_.total_spend),
      purchases_then: before.total_purch,
      purchases_now: now_.total_purch
    },
    scenes_performance: scenesArr.slice(0, 10),
    actions_since: actionsSince.map(a => ({
      action: a._id,
      count: a.count,
      avg_reward: a.avg_reward.toFixed(3)
    })),
    test_outcomes: {
      graduated: recentGrads,
      killed: recentKills
    },
    cbo_vs_abo: {
      cbo_roas_now: cboRoas.toFixed(2),
      abo_roas_now: roasNow.toFixed(2)
    }
  };
}

/**
 * Llama a Claude Haiku con la hipotesis + contexto y pide un veredicto.
 * Retorna { verdict, evidence, recommendation }.
 */
async function _validateWithClaude(hypothesis, context) {
  const hypText = hypothesis.body || hypothesis.title || '';

  const prompt = `You are a hypothesis validator for an autonomous Meta Ads system. Your job is to judge whether a hypothesis made ${context.days_ago} days ago held up based on what actually happened since.

HYPOTHESIS (emitted ${context.days_ago} days ago):
"${hypText}"

DATA SINCE THEN:

Account-level (7d windows):
- ROAS when emitted: ${context.account.roas_then}x
- ROAS now: ${context.account.roas_now}x
- Spend then: $${context.account.spend_then} | now: $${context.account.spend_now}
- Purchases then: ${context.account.purchases_then} | now: ${context.account.purchases_now}

Scene performance (tests resolved since):
${context.scenes_performance.length > 0
  ? context.scenes_performance.map(s => `- "${s.scene}": ${s.total} tests, ${s.graduated} grad, ${s.killed} killed, avg ROAS ${s.avg_roas}x`).join('\n')
  : '(no resolved tests in this window)'}

Athena action rewards since:
${context.actions_since.length > 0
  ? context.actions_since.map(a => `- ${a.action}: n=${a.count}, avg reward ${a.avg_reward}`).join('\n')
  : '(no measured actions)'}

Test outcomes: ${context.test_outcomes.graduated} graduated, ${context.test_outcomes.killed} killed

CBO vs ABO: CBO ROAS ${context.cbo_vs_abo.cbo_roas_now}x, ABO ROAS ${context.cbo_vs_abo.abo_roas_now}x

INSTRUCTIONS:
- Read the hypothesis carefully. What specifically was predicted?
- Look at the data. Does it support, contradict, or simply not address the prediction?
- Be HONEST. If the data cannot resolve the hypothesis, say "inconclusive" — do not force a verdict.
- Evidence must be specific (quote numbers).
- Recommendation: what should Zeus do differently next time? One concrete sentence.

Respond ONLY in valid JSON (no prose before or after):
{
  "verdict": "confirmed" | "rejected" | "inconclusive",
  "evidence": "1-2 sentences with specific numbers from the data above",
  "recommendation": "1 concrete sentence for Zeus about what to change or continue"
}`;

  const response = await claude.messages.create({
    model: VALIDATOR_MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content[0].text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Could not extract JSON from validator response: ${text.substring(0, 200)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]);
  const validVerdicts = ['confirmed', 'rejected', 'inconclusive'];
  if (!validVerdicts.includes(parsed.verdict)) {
    throw new Error(`Invalid verdict: ${parsed.verdict}`);
  }

  return {
    verdict: parsed.verdict,
    evidence: (parsed.evidence || '').substring(0, 300),
    recommendation: (parsed.recommendation || '').substring(0, 200),
    tokens_in: response.usage?.input_tokens || 0,
    tokens_out: response.usage?.output_tokens || 0
  };
}

/**
 * Ejecuta el ciclo del validator: encuentra hipotesis viejas sin resolver,
 * las evalua contra la data real, y guarda el veredicto en BrainInsight.
 */
async function runHypothesisValidator() {
  const startedAt = Date.now();
  const minAge = new Date(Date.now() - HYPOTHESIS_AGE_DAYS * 86400000);
  const maxAge = new Date(Date.now() - HYPOTHESIS_MAX_AGE_DAYS * 86400000);

  const unresolved = await BrainInsight.find({
    insight_type: 'hypothesis',
    is_resolved: { $ne: true },
    created_at: { $gte: maxAge, $lte: minAge }
  }).sort({ created_at: 1 }).limit(20).lean();

  if (unresolved.length === 0) {
    logger.info('[HYP-VALIDATOR] No unresolved hypotheses to validate.');
    return { total: 0, confirmed: 0, rejected: 0, inconclusive: 0, errors: 0 };
  }

  logger.info(`[HYP-VALIDATOR] Validating ${unresolved.length} hypotheses (aged ${HYPOTHESIS_AGE_DAYS}-${HYPOTHESIS_MAX_AGE_DAYS}d)...`);

  const counters = { total: unresolved.length, confirmed: 0, rejected: 0, inconclusive: 0, errors: 0 };
  let tokensIn = 0, tokensOut = 0;

  for (const h of unresolved) {
    try {
      const context = await _gatherValidationContext(h);
      const result = await _validateWithClaude(h, context);

      await BrainInsight.updateOne(
        { _id: h._id },
        {
          $set: {
            is_resolved: true,
            resolved_at: new Date(),
            diagnosis: result.verdict,
            data_points: {
              ...(h.data_points || {}),
              verdict: result.verdict,
              evidence: result.evidence,
              recommendation: result.recommendation,
              validated_at: new Date().toISOString(),
              validator_model: VALIDATOR_MODEL
            }
          }
        }
      );

      counters[result.verdict]++;
      tokensIn += result.tokens_in;
      tokensOut += result.tokens_out;
      logger.info(`[HYP-VALIDATOR] ${result.verdict.toUpperCase()}: "${(h.title || h.body || '').substring(0, 60)}" — ${result.evidence.substring(0, 80)}`);
    } catch (err) {
      counters.errors++;
      logger.warn(`[HYP-VALIDATOR] Error validating ${h._id}: ${err.message}`);
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  logger.info(`[HYP-VALIDATOR] Done in ${elapsed}s — confirmed=${counters.confirmed} rejected=${counters.rejected} inconclusive=${counters.inconclusive} errors=${counters.errors} tokens=${tokensIn}in/${tokensOut}out`);
  return counters;
}

module.exports = { runHypothesisValidator };
