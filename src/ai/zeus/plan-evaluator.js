/**
 * Plan Evaluator — computa valor actual de cada goal, status de milestones,
 * health del plan activo. Corre en cron diario.
 */

const ZeusStrategicPlan = require('../../db/models/ZeusStrategicPlan');
const TestRun = require('../../db/models/TestRun');
const CreativeDNA = require('../../db/models/CreativeDNA');
const { getLatestSnapshots } = require('../../db/queries');
const logger = require('../../utils/logger');

/**
 * Computa el valor actual de un goal basado en su metric name.
 * Rule-based — mapeo de nombres de métrica conocidos a fuente de data.
 */
async function computeGoalValue(metric, plan) {
  const metricLower = (metric || '').toLowerCase();
  const snapshots = await getLatestSnapshots('adset');
  const active = snapshots.filter(s => s.status === 'ACTIVE');

  // Portfolio aggregates reusables
  const spend7d = active.reduce((s, a) => s + (a.metrics?.last_7d?.spend || 0), 0);
  const rev7d = active.reduce((s, a) => s + ((a.metrics?.last_7d?.roas || 0) * (a.metrics?.last_7d?.spend || 0)), 0);
  const spend14d = active.reduce((s, a) => s + (a.metrics?.last_14d?.spend || 0), 0);
  const rev14d = active.reduce((s, a) => s + ((a.metrics?.last_14d?.roas || 0) * (a.metrics?.last_14d?.spend || 0)), 0);
  const purch14d = active.reduce((s, a) => s + (a.metrics?.last_14d?.purchases || 0), 0);

  // monthly_revenue: extrapolar desde 14d * 30/14
  if (metricLower.includes('monthly_revenue') || metricLower.includes('revenue_mensual')) {
    return { value: Math.round(rev14d * 30 / 14), unit: 'usd', source: '14d extrapolated' };
  }

  // portfolio_roas variations
  if (metricLower.includes('roas') && metricLower.includes('14')) {
    return { value: +(rev14d > 0 && spend14d > 0 ? rev14d / spend14d : 0).toFixed(2), unit: 'x', source: 'last_14d' };
  }
  if (metricLower.includes('roas') && metricLower.includes('7')) {
    return { value: +(rev7d > 0 && spend7d > 0 ? rev7d / spend7d : 0).toFixed(2), unit: 'x', source: 'last_7d' };
  }
  if (metricLower.includes('portfolio_roas') || metricLower === 'roas') {
    return { value: +(rev14d > 0 && spend14d > 0 ? rev14d / spend14d : 0).toFixed(2), unit: 'x', source: 'last_14d' };
  }

  // daily_spend
  if (metricLower.includes('daily_spend') || metricLower.includes('spend_capacity')) {
    return { value: Math.round(spend7d / 7), unit: 'usd/day', source: 'last_7d avg' };
  }

  // graduated_ad_sets desde period_start del plan
  if (metricLower.includes('graduated')) {
    const since = plan.period_start || new Date(Date.now() - 90 * 86400000);
    const count = await TestRun.countDocuments({ graduated_at: { $gte: since } });
    return { value: count, unit: 'count', source: `graduated since ${since.toISOString().substring(0,10)}` };
  }

  // active_winner_dnas (ROAS >= 5x)
  if (metricLower.includes('winner_dna') || metricLower.includes('dna_5x')) {
    const count = await CreativeDNA.countDocuments({
      'fitness.avg_roas': { $gte: 5 },
      'fitness.tests_total': { $gte: 2 }
    });
    return { value: count, unit: 'count', source: 'DNA with avg_roas>=5x & tests>=2' };
  }

  // cpa
  if (metricLower.includes('cpa')) {
    const cpa = purch14d > 0 ? spend14d / purch14d : 0;
    return { value: +cpa.toFixed(2), unit: 'usd', source: 'last_14d' };
  }

  // active_adsets count
  if (metricLower.includes('active_adset') || metricLower === 'adsets') {
    return { value: active.length, unit: 'count', source: 'current active' };
  }

  // total purchases
  if (metricLower.includes('purchase')) {
    return { value: purch14d, unit: 'count', source: 'last_14d' };
  }

  return { value: null, unit: null, source: 'no matcher' };
}

/**
 * Para cada goal, calcula current + progress % + trajectory + status.
 */
function evaluateGoal(goal, current, plan) {
  if (goal.target == null || current == null) {
    return { ...goal, current, progress_pct: null, trajectory_pct: null, status: 'unknown' };
  }

  const baseline = goal.baseline ?? 0;
  const progress = goal.target === baseline ? 100 : ((current - baseline) / (goal.target - baseline)) * 100;

  // Trajectory esperado basado en tiempo transcurrido vs fecha objetivo
  let trajectoryExpected = 100;
  if (goal.by_date) {
    const now = Date.now();
    const start = (plan.period_start || plan.generated_at || new Date()).getTime();
    const end = new Date(goal.by_date).getTime();
    const totalMs = end - start;
    const elapsed = now - start;
    trajectoryExpected = totalMs > 0 ? Math.min(100, Math.max(0, (elapsed / totalMs) * 100)) : 100;
  }

  // Status
  let status = 'on_track';
  const ratio = trajectoryExpected > 0 ? (progress / trajectoryExpected) : 1;
  if (progress >= 100) status = 'achieved';
  else if (goal.by_date && new Date(goal.by_date).getTime() < Date.now()) status = 'missed';
  else if (ratio < 0.5) status = 'off_track';
  else if (ratio < 0.8) status = 'behind';

  return {
    ...goal,
    current,
    progress_pct: +progress.toFixed(1),
    trajectory_pct: +trajectoryExpected.toFixed(1),
    status
  };
}

/**
 * Evalúa un plan completo — actualiza goals con current + status, computa health.
 */
async function evaluatePlan(plan) {
  const goalsEvaluated = [];
  for (const g of plan.goals || []) {
    const { value } = await computeGoalValue(g.metric, plan);
    const eval_ = evaluateGoal(g, value, plan);
    goalsEvaluated.push(eval_);
  }

  // Milestones — solo marcar missed si su by_date pasó y status sigue pending
  const now = Date.now();
  const milestonesEvaluated = (plan.milestones || []).map(m => {
    if (m.status === 'pending' && m.by_date && new Date(m.by_date).getTime() < now) {
      return { ...m, status: 'missed', _auto_evaluated: true };
    }
    return m;
  });

  // Health score 0-100
  const statusScores = { achieved: 1, on_track: 0.85, behind: 0.5, off_track: 0.2, missed: 0, unknown: 0.5 };
  const goalScores = goalsEvaluated.map(g => statusScores[g.status] ?? 0.5);
  const milestoneAchieved = milestonesEvaluated.filter(m => m.status === 'achieved').length;
  const milestoneTotal = milestonesEvaluated.length || 1;
  const avgGoalScore = goalScores.length > 0 ? goalScores.reduce((a, b) => a + b, 0) / goalScores.length : 0.5;
  const milestoneScore = milestoneAchieved / milestoneTotal;
  const healthScore = Math.round((avgGoalScore * 0.7 + milestoneScore * 0.3) * 100);

  let healthStatus = 'on_track';
  if (healthScore >= 85) healthStatus = 'on_track';
  else if (healthScore >= 60) healthStatus = 'behind';
  else if (healthScore >= 30) healthStatus = 'off_track';
  else healthStatus = 'at_risk';

  return {
    plan_id: plan._id,
    evaluated_at: new Date(),
    goals: goalsEvaluated,
    milestones: milestonesEvaluated,
    health_score: healthScore,
    health_status: healthStatus,
    summary: {
      goals_achieved: goalsEvaluated.filter(g => g.status === 'achieved').length,
      goals_on_track: goalsEvaluated.filter(g => g.status === 'on_track').length,
      goals_behind: goalsEvaluated.filter(g => g.status === 'behind').length,
      goals_off_track: goalsEvaluated.filter(g => g.status === 'off_track').length,
      goals_missed: goalsEvaluated.filter(g => g.status === 'missed').length,
      milestones_achieved: milestonesEvaluated.filter(m => m.status === 'achieved').length,
      milestones_missed: milestonesEvaluated.filter(m => m.status === 'missed').length,
      milestones_pending: milestonesEvaluated.filter(m => m.status === 'pending').length
    }
  };
}

/**
 * Cron diario — evalúa todos los planes activos y persiste goal.current + milestone.status.
 */
async function runPlanEvaluationCron() {
  const plans = await ZeusStrategicPlan.find({ status: 'active' }).lean();
  const results = { evaluated: 0, plans: [] };

  for (const plan of plans) {
    try {
      const evaluation = await evaluatePlan(plan);

      // Persistir current + trajectory + status en cada goal
      const updatedGoals = evaluation.goals.map(g => ({
        metric: g.metric,
        target: g.target,
        current: g.current,
        progress_pct: g.progress_pct,
        trajectory_pct: g.trajectory_pct,
        status: g.status,
        priority: g.priority,
        by_date: g.by_date,
        baseline: g.baseline
      }));

      // Persistir milestones missed por tiempo
      const updatedMilestones = evaluation.milestones.map(m => ({
        description: m.description,
        by_date: m.by_date,
        status: m.status,
        achieved_at: m.achieved_at
      }));

      await ZeusStrategicPlan.updateOne(
        { _id: plan._id },
        {
          $set: {
            goals: updatedGoals,
            milestones: updatedMilestones,
            last_evaluation: {
              at: evaluation.evaluated_at,
              health_score: evaluation.health_score,
              health_status: evaluation.health_status,
              summary: evaluation.summary
            }
          }
        }
      );

      results.plans.push({
        id: plan._id.toString(),
        horizon: plan.horizon,
        health_score: evaluation.health_score,
        health_status: evaluation.health_status
      });
      results.evaluated++;
    } catch (err) {
      logger.error(`[PLAN-EVAL] Plan ${plan._id} eval failed: ${err.message}`);
    }
  }

  logger.info(`[PLAN-EVAL] ${JSON.stringify(results).substring(0, 500)}`);
  return results;
}

module.exports = { computeGoalValue, evaluateGoal, evaluatePlan, runPlanEvaluationCron };
