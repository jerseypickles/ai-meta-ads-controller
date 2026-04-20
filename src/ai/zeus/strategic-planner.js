/**
 * Zeus Strategic Planner (Level 3) — genera/refresca planes multi-horizonte.
 *
 * Cron lunes 8am ET — regenera plan semanal (draft, requiere aprobación).
 * Cron día 1 mes 8am ET — regenera plan mensual.
 * Cron día 1 trimestre 9am ET — regenera plan trimestral.
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');

const ZeusStrategicPlan = require('../../db/models/ZeusStrategicPlan');
const SystemConfig = require('../../db/models/SystemConfig');
const { buildOracleContext, formatContextForPrompt } = require('./oracle-context');

const claude = new Anthropic({ apiKey: config.claude.apiKey });
const MODEL = 'claude-opus-4-7';

const NORTH_STAR_KEY = 'zeus_north_star';

async function getNorthStar() {
  return await SystemConfig.get(NORTH_STAR_KEY, {
    metric: 'monthly_revenue',
    target: null,
    direction: 'maximize',
    context: 'Default: maximizar revenue mensual. El creador puede cambiarlo.'
  });
}

async function setNorthStar(northStar) {
  await SystemConfig.set(NORTH_STAR_KEY, northStar);
  return northStar;
}

function getPeriodBounds(horizon, now = new Date()) {
  const d = new Date(now);
  if (horizon === 'weekly') {
    const day = d.getDay();
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((day + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 7);
    return { period_start: monday, period_end: sunday };
  }
  if (horizon === 'monthly') {
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    return { period_start: start, period_end: end };
  }
  if (horizon === 'quarterly') {
    const q = Math.floor(d.getMonth() / 3);
    const start = new Date(d.getFullYear(), q * 3, 1);
    const end = new Date(d.getFullYear(), (q + 1) * 3, 1);
    return { period_start: start, period_end: end };
  }
  throw new Error(`Horizon inválido: ${horizon}`);
}

async function generatePlan(horizon, options = {}) {
  const bounds = getPeriodBounds(horizon);
  const northStar = await getNorthStar();
  const ctx = await buildOracleContext(null);
  const contextText = formatContextForPrompt(ctx);

  const horizonLabel = {
    weekly: 'semanal (próximos 7 días)',
    monthly: 'mensual (próximos 30 días)',
    quarterly: 'trimestral (próximos 90 días)'
  }[horizon];

  const todayISO = new Date().toISOString().substring(0, 10);
  const periodStartISO = bounds.period_start.toISOString().substring(0, 10);
  const periodEndISO = bounds.period_end.toISOString().substring(0, 10);

  const prompt = `Genera un plan estratégico ${horizonLabel} para Jersey Pickles.

═══ FECHAS (CRÍTICO — usá AÑO ACTUAL) ═══
- HOY es: ${todayISO}
- Período del plan: ${periodStartISO} al ${periodEndISO}
- TODAS las fechas de goals y milestones DEBEN estar entre ${periodStartISO} y ${periodEndISO}
- USA SIEMPRE el año actual. NO uses años del pasado.

NORTH STAR METRIC (métrica que guía todo):
- Métrica: ${northStar.metric}
- Target: ${northStar.target ?? 'no definido'}
- Dirección: ${northStar.direction}
${northStar.context ? `- Contexto: ${northStar.context}` : ''}

CONTEXTO ACTUAL DEL SISTEMA:
${contextText}

Generá el plan en JSON VÁLIDO exacto (sin backticks, solo JSON):

{
  "summary": "1-2 oraciones resumen del foco del período",
  "narrative": "3-5 párrafos en markdown con el plan narrativo — qué vamos a lograr, por qué, cómo, qué evitar",
  "goals": [
    { "metric": "string", "target": number, "current": number, "priority": "critical|high|medium|low", "by_date": "YYYY-MM-DD" }
  ],
  "milestones": [
    { "description": "string corta accionable", "by_date": "YYYY-MM-DD" }
  ],
  "risks": [
    { "description": "riesgo concreto", "likelihood": "low|medium|high", "impact": "low|medium|high|critical", "mitigation": "cómo evitar/reducir" }
  ]
}

Reglas:
- Max 5 goals, max 5 milestones, max 4 risks
- Goals deben ser SMART (específicos, medibles, attainable, relevantes, time-bound)
- Milestones son logros binarios achieved/missed
- Risks reales del contexto actual, no genéricos
- Narrative en markdown con párrafos, no bullets

Respondé SOLO con el JSON.`;

  const response = await claude.messages.create({
    model: MODEL,
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content.find(b => b.type === 'text')?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON en respuesta del planner');
  const parsed = JSON.parse(jsonMatch[0]);

  // Supersedear plan anterior del mismo horizon si existe activo
  await ZeusStrategicPlan.updateMany(
    { horizon, status: 'active' },
    { $set: { status: 'superseded' } }
  );

  // Validador de fechas — clampea al período si Opus genera fechas fuera de rango
  // (o si usa año equivocado por knowledge cutoff)
  const clampDate = (d) => {
    if (!d) return null;
    const parsed = new Date(d);
    if (isNaN(parsed.getTime())) return null;
    if (parsed < bounds.period_start) {
      // Si fecha está en el pasado, ajustar al mismo mes/día pero año actual
      const adjusted = new Date(bounds.period_start);
      adjusted.setMonth(parsed.getMonth(), parsed.getDate());
      if (adjusted < bounds.period_start || adjusted > bounds.period_end) {
        // Si sigue fuera de rango, poner a mediados del período
        return new Date((bounds.period_start.getTime() + bounds.period_end.getTime()) / 2);
      }
      return adjusted;
    }
    if (parsed > bounds.period_end) return bounds.period_end;
    return parsed;
  };

  const plan = await ZeusStrategicPlan.create({
    horizon,
    period_start: bounds.period_start,
    period_end: bounds.period_end,
    north_star: northStar,
    summary: parsed.summary || '',
    narrative: parsed.narrative || '',
    goals: (parsed.goals || []).slice(0, 5).map(g => ({
      metric: g.metric,
      target: g.target,
      current: g.current ?? null,
      priority: g.priority || 'medium',
      by_date: clampDate(g.by_date)
    })),
    milestones: (parsed.milestones || []).slice(0, 5).map(m => ({
      description: m.description,
      by_date: clampDate(m.by_date),
      status: 'pending'
    })),
    risks: (parsed.risks || []).slice(0, 4).map(r => ({
      description: r.description,
      likelihood: r.likelihood || 'medium',
      impact: r.impact || 'medium',
      mitigation: r.mitigation || ''
    })),
    status: 'draft',
    approved_by_creator: false
  });

  logger.info(`[ZEUS-PLANNER] Generated ${horizon} plan ${plan._id}`);
  return plan;
}

async function runWeeklyPlanCron() {
  try { return await generatePlan('weekly'); } catch (err) { logger.error(`[ZEUS-PLANNER] weekly failed: ${err.message}`); return null; }
}
async function runMonthlyPlanCron() {
  try { return await generatePlan('monthly'); } catch (err) { logger.error(`[ZEUS-PLANNER] monthly failed: ${err.message}`); return null; }
}
async function runQuarterlyPlanCron() {
  try { return await generatePlan('quarterly'); } catch (err) { logger.error(`[ZEUS-PLANNER] quarterly failed: ${err.message}`); return null; }
}

module.exports = {
  generatePlan,
  runWeeklyPlanCron,
  runMonthlyPlanCron,
  runQuarterlyPlanCron,
  getNorthStar,
  setNorthStar,
  getPeriodBounds
};
