/**
 * Zeus Hypothesis Engine (Level 2) — lifecycle de hipótesis + updates bayesianos.
 *
 * Cron semanal:
 * - Para cada hipótesis en 'testing', lee resultados de commissioned_tests
 * - Aplica update bayesiano sobre el prior
 * - Si evidencia es concluyente → status confirmed/rejected
 * - Si no hay suficientes samples → continúa en testing
 */

const ZeusHypothesis = require('../../db/models/ZeusHypothesis');
const TestRun = require('../../db/models/TestRun');
const CreativeProposal = require('../../db/models/CreativeProposal');
const logger = require('../../utils/logger');

// Simple update bayesiano: ratio likelihood × prior → posterior
function bayesianUpdate(prior, likelihoodConfirm, likelihoodReject) {
  // odds = prior / (1 - prior)
  // posterior_odds = odds × (likelihoodConfirm / likelihoodReject)
  const priorOdds = prior / (1 - prior);
  const ratio = likelihoodConfirm / Math.max(0.01, likelihoodReject);
  const posteriorOdds = priorOdds * ratio;
  const posterior = posteriorOdds / (1 + posteriorOdds);
  return Math.max(0.01, Math.min(0.99, posterior));
}

/**
 * Analiza resultados de tests commissioned para una hipótesis.
 * Retorna: { points_confirm, points_reject, samples_done, samples_pending }
 */
async function analyzeEvidence(hypothesis) {
  let confirmScore = 0;
  let rejectScore = 0;
  let samplesDone = 0;
  let samplesPending = 0;

  const controlResults = [];
  const treatmentResults = [];

  for (const ct of hypothesis.commissioned_tests || []) {
    if (ct.ref_type === 'test_run') {
      const tr = await TestRun.findById(ct.ref_id).lean();
      if (!tr) continue;
      if (['graduated', 'killed', 'expired'].includes(tr.phase)) {
        samplesDone++;
        const roas = tr.metrics?.roas || 0;
        const verdict = tr.phase === 'graduated' ? 1 : 0; // binary success
        if (ct.group === 'control') controlResults.push({ roas, verdict });
        else treatmentResults.push({ roas, verdict });
      } else {
        samplesPending++;
      }
    }
  }

  // Si tenemos samples en ambos grupos, comparar
  if (controlResults.length >= 2 && treatmentResults.length >= 2) {
    const avgControl = controlResults.reduce((s, r) => s + r.roas, 0) / controlResults.length;
    const avgTreatment = treatmentResults.reduce((s, r) => s + r.roas, 0) / treatmentResults.length;
    const gradRateControl = controlResults.reduce((s, r) => s + r.verdict, 0) / controlResults.length;
    const gradRateTreatment = treatmentResults.reduce((s, r) => s + r.verdict, 0) / treatmentResults.length;

    const roasDelta = avgTreatment - avgControl;
    const gradDelta = gradRateTreatment - gradRateControl;

    if (roasDelta > 0.3 || gradDelta > 0.15) confirmScore += 2;
    else if (roasDelta > 0.1) confirmScore += 1;
    else if (roasDelta < -0.3 || gradDelta < -0.15) rejectScore += 2;
    else if (roasDelta < -0.1) rejectScore += 1;
  }

  return { confirmScore, rejectScore, samplesDone, samplesPending, controlResults, treatmentResults };
}

/**
 * Revisa todas las hipótesis en testing, actualiza evidencia y status.
 */
async function runHypothesisReview() {
  const hyps = await ZeusHypothesis.find({
    status: { $in: ['testing', 'analyzing'] }
  }).lean();

  const updated = { reviewed: 0, confirmed: 0, rejected: 0, inconclusive: 0, still_testing: 0 };

  for (const h of hyps) {
    try {
      const ev = await analyzeEvidence(h);
      updated.reviewed++;

      // Necesitamos min samples antes de concluir
      if (ev.samplesDone < (h.min_samples_needed || 6)) {
        updated.still_testing++;
        continue;
      }

      // Hay evidencia — update bayesiano
      const confirmLikelihood = 0.2 + ev.confirmScore * 0.2;   // más confirmScore = más likelihood
      const rejectLikelihood = 0.2 + ev.rejectScore * 0.2;

      const priorBefore = h.prior_before ?? 0.5;
      const posterior = bayesianUpdate(priorBefore, confirmLikelihood, rejectLikelihood);

      let newStatus = 'inconclusive';
      if (posterior >= 0.8) newStatus = 'confirmed';
      else if (posterior <= 0.2) newStatus = 'rejected';

      await ZeusHypothesis.updateOne(
        { _id: h._id },
        {
          $set: {
            status: newStatus,
            prior_after: posterior,
            concluded_at: newStatus !== 'inconclusive' ? new Date() : null
          },
          $push: {
            evidence_log: {
              at: new Date(),
              source: 'hypothesis_review_cron',
              data: {
                samples_done: ev.samplesDone,
                confirmScore: ev.confirmScore,
                rejectScore: ev.rejectScore,
                prior_before: priorBefore,
                posterior,
                avg_control_roas: ev.controlResults.length > 0
                  ? +(ev.controlResults.reduce((s, r) => s + r.roas, 0) / ev.controlResults.length).toFixed(2) : null,
                avg_treatment_roas: ev.treatmentResults.length > 0
                  ? +(ev.treatmentResults.reduce((s, r) => s + r.roas, 0) / ev.treatmentResults.length).toFixed(2) : null
              },
              points_toward: newStatus === 'confirmed' ? 'confirm' : newStatus === 'rejected' ? 'reject' : 'inconclusive'
            }
          }
        }
      );

      updated[newStatus === 'confirmed' ? 'confirmed' : newStatus === 'rejected' ? 'rejected' : 'inconclusive']++;
    } catch (err) {
      logger.error(`[HYPOTHESIS-ENGINE] review failed id=${h._id}: ${err.message}`);
    }
  }

  logger.info(`[HYPOTHESIS-ENGINE] Review: ${JSON.stringify(updated)}`);
  return updated;
}

module.exports = { runHypothesisReview, analyzeEvidence, bayesianUpdate };
