/**
 * Pattern Enricher (hueco #2 del Zeus diagnosis).
 *
 * La capa de aprendizaje actual es táctica — cada agente aprende su oficio.
 * Faltan variables de segunda derivada (timing, concurrencia, cohorte) para
 * que el hypothesis engine pueda correlacionar patrones cross-dominio tipo:
 *   - "los clones de 20h convierten 23% peor"
 *   - "scaling >3 adsets el mismo día colapsa el pixel"
 *   - "tests lanzados jueves gradúan 2 días antes"
 *
 * Este módulo:
 *  - `computeTimeContext(date)` — deriva hour_et, dow_et, is_weekend, etc.
 *  - `enrichActionContext(action)` — agrega concurrencia + ventana + cohorte
 *  - Pre-save hooks (instalados al requerir este módulo) que enriquecen
 *    automáticamente ActionLog + TestRun al insertarse.
 */

const TZ = 'America/New_York';

const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function computeTimeContext(date) {
  const d = date ? new Date(date) : new Date();
  // Computamos componentes en ET usando Intl (funciona confiable en Node 18+)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour12: false,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric'
  }).formatToParts(d);

  const hourStr = parts.find(p => p.type === 'hour')?.value || '0';
  const weekdayStr = (parts.find(p => p.type === 'weekday')?.value || 'Sun').toLowerCase().substring(0, 3);
  const hour = parseInt(hourStr, 10);
  const dowIdx = DOW_NAMES.indexOf(weekdayStr);

  return {
    hour_et: hour,
    dow_et: dowIdx === -1 ? 0 : dowIdx,
    dow_name: weekdayStr,
    is_weekend: dowIdx === 0 || dowIdx === 6,
    is_business_hours: hour >= 9 && hour < 18,
    is_evening: hour >= 18 && hour < 23,
    is_overnight: hour >= 23 || hour < 6,
    bucket_4h: Math.floor(hour / 4)  // 0-5, útil para segmentar
  };
}

/**
 * Enriquece una acción con:
 *   - time context (hour/dow/etc)
 *   - concurrency (# acciones del mismo agente en ventana reciente)
 *   - cohort_date (YYYY-MM-DD en ET — para agrupar lanzamientos/scales del mismo día)
 */
async function enrichActionContext(action) {
  const ActionLog = require('../../db/models/ActionLog');
  const now = action.executed_at ? new Date(action.executed_at) : new Date();
  const timeCtx = computeTimeContext(now);

  let concurrent5m = 0;
  let concurrent1h = 0;
  try {
    const win5 = new Date(now.getTime() - 5 * 60000);
    const win1h = new Date(now.getTime() - 60 * 60000);
    [concurrent5m, concurrent1h] = await Promise.all([
      ActionLog.countDocuments({
        agent_type: action.agent_type,
        executed_at: { $gte: win5, $lt: now }
      }),
      ActionLog.countDocuments({
        agent_type: action.agent_type,
        executed_at: { $gte: win1h, $lt: now }
      })
    ]);
  } catch (_) {
    // Si Mongo falla, enriquecemos solo con time context
  }

  const cohortDate = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

  return {
    ...timeCtx,
    cohort_date: cohortDate,       // "2026-04-21"
    concurrent_actions_5min: concurrent5m,
    concurrent_actions_1h: concurrent1h
  };
}

/**
 * Enriquece un TestRun — similar pero usa launched_at.
 */
async function enrichTestRunContext(testRun) {
  const TestRun = require('../../db/models/TestRun');
  const launchedAt = testRun.launched_at ? new Date(testRun.launched_at) : new Date();
  const timeCtx = computeTimeContext(launchedAt);

  let concurrentTests = 0;
  try {
    const win1h = new Date(launchedAt.getTime() - 60 * 60000);
    concurrentTests = await TestRun.countDocuments({
      launched_at: { $gte: win1h, $lt: launchedAt }
    });
  } catch (_) {}

  const cohortDate = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(launchedAt);

  return {
    ...timeCtx,
    cohort_date: cohortDate,
    concurrent_launches_1h: concurrentTests
  };
}

module.exports = { computeTimeContext, enrichActionContext, enrichTestRunContext };
