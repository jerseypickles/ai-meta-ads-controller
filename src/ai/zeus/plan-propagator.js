/**
 * Plan Propagator — traduce el plan estratégico en directivas operativas
 * que cada agente consume. Es el puente entre nivel estratégico (Zeus)
 * y nivel táctico (Athena/Apollo/Prometheus/Ares).
 *
 * Cuando un plan se aprueba:
 * 1. Se desactivan las directivas derivadas del plan anterior
 * 2. Se generan directivas nuevas por cada goal relevante
 * 3. Se marcan con data.source='strategic_plan' + data.plan_id
 */

const ZeusDirective = require('../../db/models/ZeusDirective');
const ZeusStrategicPlan = require('../../db/models/ZeusStrategicPlan');
const logger = require('../../utils/logger');

/**
 * Mapeo de goal metrics → directivas por agente.
 * Retorna array de objetos { target_agent, directive_type, directive, data, confidence }
 */
function deriveDirectives(plan) {
  const derived = [];
  const planId = plan._id.toString();
  const horizonLabel = plan.horizon;

  // Strategic insight umbrella — lo ven todos los agentes
  if (plan.summary) {
    derived.push({
      target_agent: 'all',
      directive_type: 'insight',
      directive: `[PLAN ${horizonLabel.toUpperCase()}] ${plan.summary}`,
      data: {
        source: 'strategic_plan',
        plan_id: planId,
        horizon: horizonLabel,
        north_star: plan.north_star?.metric,
        role: 'umbrella_context'
      },
      confidence: 0.9
    });
  }

  // Por cada goal, deriva directiva específica
  for (const g of plan.goals || []) {
    const metric = (g.metric || '').toLowerCase();

    // ROAS targets → Athena (mantener/elevar)
    if (metric.includes('roas')) {
      derived.push({
        target_agent: 'athena',
        directive_type: 'prioritize',
        directive: `Mantener ${g.metric} ≥ ${g.target}${metric.includes('roas') ? 'x' : ''}. Priorizar decisiones que eleven ROAS del portfolio. Pausar agresivo bajo ROAS ${(g.target * 0.65).toFixed(2)}x.`,
        data: {
          source: 'strategic_plan',
          plan_id: planId,
          goal_metric: g.metric,
          target: g.target,
          by_date: g.by_date
        },
        confidence: 0.9,
        category: 'account_pattern'
      });
    }

    // Daily spend → Athena (ramp-up)
    if (metric.includes('daily_spend') || metric.includes('spend_capacity')) {
      derived.push({
        target_agent: 'athena',
        directive_type: 'adjust',
        directive: `Ramp-up budget del portfolio hacia $${g.target}/día de forma gradual (≤10% daily increase), respetando learning phases.`,
        data: {
          source: 'strategic_plan',
          plan_id: planId,
          goal_metric: g.metric,
          target: g.target,
          current: g.current,
          by_date: g.by_date,
          max_daily_increase_pct: 10
        },
        confidence: 0.85,
        category: 'account_pattern'
      });
    }

    // CPA cap → Athena (respetar cap)
    if (metric.includes('cpa')) {
      derived.push({
        target_agent: 'athena',
        directive_type: 'avoid',
        directive: `No escalar ad sets con CPA > $${g.target} sostenido. Priorizar eficiencia sobre volumen durante el trimestre.`,
        data: {
          source: 'strategic_plan',
          plan_id: planId,
          goal_metric: g.metric,
          cpa_cap: g.target,
          by_date: g.by_date
        },
        confidence: 0.9,
        category: 'account_pattern'
      });
    }

    // Graduations → Prometheus
    if (metric.includes('graduated')) {
      derived.push({
        target_agent: 'prometheus',
        directive_type: 'prioritize',
        directive: `Target de graduations: ${g.target} en el período. Priorizar testing acelerado de proposals con DNAs validados >3x.`,
        data: {
          source: 'strategic_plan',
          plan_id: planId,
          goal_metric: g.metric,
          target: g.target,
          current: g.current,
          by_date: g.by_date
        },
        confidence: 0.85,
        category: 'test_signal'
      });
    }

    // Winner DNAs → Apollo
    if (metric.includes('winner_dna') || metric.includes('dna_5x')) {
      derived.push({
        target_agent: 'apollo',
        directive_type: 'prioritize',
        directive: `Target: ${g.target} DNAs con avg_roas ≥ 5x. Generar variantes derivadas de winners actuales + exploración moderada. Mantén 20% exploratorio fuera de cluster ganador.`,
        data: {
          source: 'strategic_plan',
          plan_id: planId,
          goal_metric: g.metric,
          target: g.target,
          current: g.current,
          by_date: g.by_date,
          exploratory_ratio: 0.2
        },
        confidence: 0.85,
        category: 'creative_pattern'
      });
    }

    // Revenue → all (contexto general)
    if (metric.includes('revenue')) {
      derived.push({
        target_agent: 'all',
        directive_type: 'alert',
        directive: `Target revenue ${horizonLabel}: $${g.target?.toLocaleString() || 'TBD'}. Decisiones deben contribuir a cumplirlo${g.by_date ? ` por ${new Date(g.by_date).toISOString().substring(0,10)}` : ''}.`,
        data: {
          source: 'strategic_plan',
          plan_id: planId,
          goal_metric: g.metric,
          target: g.target,
          by_date: g.by_date,
          role: 'revenue_north_star'
        },
        confidence: 0.85
      });
    }
  }

  // Risks → alerts para agentes relevantes
  for (const r of plan.risks || []) {
    if (!r.description || !r.mitigation) continue;

    // Heurística: mapear risks a agentes por keywords
    const desc = r.description.toLowerCase();
    let target = 'all';
    if (desc.includes('cpm') || desc.includes('ramp-up') || desc.includes('learning')) target = 'athena';
    else if (desc.includes('dna') || desc.includes('creativo') || desc.includes('cluster')) target = 'apollo';
    else if (desc.includes('test') || desc.includes('graduate')) target = 'prometheus';
    else if (desc.includes('duplic') || desc.includes('cbo')) target = 'ares';

    derived.push({
      target_agent: target,
      directive_type: 'alert',
      directive: `[RISK ${r.impact}/${r.likelihood}] ${r.description}. Mitigación: ${r.mitigation}`,
      data: {
        source: 'strategic_plan',
        plan_id: planId,
        role: 'risk_mitigation',
        likelihood: r.likelihood,
        impact: r.impact
      },
      confidence: 0.8
    });
  }

  return derived;
}

/**
 * Propaga el plan aprobado a directivas operativas.
 * Desactiva las del plan anterior (del mismo horizon), crea las nuevas.
 */
async function propagatePlan(plan) {
  if (!plan || plan.status !== 'active') {
    throw new Error('Plan debe estar active para propagar');
  }

  // 1. Desactivar directivas derivadas del plan anterior (mismo horizon)
  const deactivatedCount = await ZeusDirective.updateMany(
    {
      'data.source': 'strategic_plan',
      'data.horizon': plan.horizon,
      'data.plan_id': { $ne: plan._id.toString() },
      active: true
    },
    { $set: { active: false } }
  );

  // 2. Generar directivas nuevas
  const derived = deriveDirectives(plan);
  const expiresAt = plan.period_end ? new Date(plan.period_end) : null;

  const created = [];
  for (const d of derived) {
    try {
      const dir = await ZeusDirective.create({
        target_agent: d.target_agent,
        directive_type: d.directive_type,
        directive: d.directive,
        data: { ...d.data, horizon: plan.horizon },
        confidence: d.confidence,
        category: d.category || 'cross_agent',
        active: true,
        expires_at: expiresAt
      });
      created.push({ id: dir._id.toString(), target: d.target_agent, type: d.directive_type });
    } catch (err) {
      logger.error(`[PLAN-PROPAGATOR] Create directive failed: ${err.message}`);
    }
  }

  logger.info(`[PLAN-PROPAGATOR] Plan ${plan._id} propagated — ${deactivatedCount.modifiedCount} deactivated, ${created.length} created`);

  return {
    plan_id: plan._id.toString(),
    horizon: plan.horizon,
    deactivated: deactivatedCount.modifiedCount || 0,
    created_count: created.length,
    directives: created
  };
}

module.exports = { propagatePlan, deriveDirectives };
