/**
 * athena-targets.js — TARGET POR-ADSET (2026-06-05).
 *
 * Athena usaba umbrales GLOBALES (scale ≥3x, scale_down <1.5x, pause <1.0x) para TODOS
 * los adsets. Eso es tosco: un winner que probó rendir 5x y cae a 2.5x está degradando
 * (aunque 2.5 > 1.5 global) y un adset modesto estable a 1.8x está perfecto. Esto deriva,
 * de la HISTORIA del propio adset, un baseline + piso adaptados — para que Athena juzgue
 * cada adset contra SU propio nivel probado, no una vara única.
 *
 * Todo en cash-adjusted (haircut corregido de Demeter). No toca Meta — es solo lógica de
 * decisión que se inyecta al contexto del LLM.
 */

const GLOBAL_MIN = 1.5;       // piso de ROAS global (kpi-targets)
const FLOOR_MIN = 1.3;        // ningún piso por-adset baja de acá (rentabilidad mínima)
const FLOOR_CAP = 3.0;        // ni sube de acá (= target global): cualquier adset >3x es keeper,
                              // no lo bajes aunque su baseline sea altísimo (ej. 15x → no actuar a 7x)
const FLOOR_RATIO = 0.5;      // piso del adset = mitad de su baseline probado
const DEGRADE_RATIO = 0.8;    // actual < baseline×0.8 (cayó ≥20%) = degradando vs sí mismo
const MIN_SPEND_14D = 100;    // spend mínimo para un baseline 14d confiable
const MIN_SPEND_7D = 50;      // fallback 7d

/**
 * Deriva el target/piso del adset de su propia historia.
 * @returns null si es muy nuevo / poca data → el caller usa los umbrales globales.
 */
function computeAdsetTarget(snap, cashHaircut = 1) {
  const m = snap?.metrics || {};
  const r14 = m.last_14d || {}, r7 = m.last_7d || {}, r3 = m.last_3d || {};
  const sp14 = r14.spend || 0, sp7 = r7.spend || 0;

  // Baseline = ROAS establecido sobre la ventana más larga con spend real (cash-adj).
  let baseMeta, basis;
  if (sp14 >= MIN_SPEND_14D) { baseMeta = r14.roas || 0; basis = '14d'; }
  else if (sp7 >= MIN_SPEND_7D) { baseMeta = r7.roas || 0; basis = '7d'; }
  else return null; // sin historia suficiente → globales

  const baseline = +(baseMeta * cashHaircut).toFixed(2);
  if (baseline <= 0) return null;

  // Piso del adset: mitad de su baseline, clampeado a [FLOOR_MIN, FLOOR_CAP]. Así un winner
  // de 5x exige ~2.5x (más estricto que el global) pero un monstruo de 15x no fuerza acción a 7x.
  const floor = +Math.max(FLOOR_MIN, Math.min(FLOOR_CAP, baseline * FLOOR_RATIO)).toFixed(2);
  const cur7 = +((r7.roas || 0) * cashHaircut).toFixed(2);
  const cur3 = +((r3.roas || 0) * cashHaircut).toFixed(2);
  const degrading = cur7 > 0 && cur7 < baseline * DEGRADE_RATIO;
  const belowFloor = cur7 > 0 && cur7 < floor;

  return { baseline, floor, basis, cur7, cur3, degrading, belowFloor, cashAdjusted: cashHaircut !== 1 };
}

/** Texto para inyectar al contexto del LLM de Athena. '' si no hay target (usar globales). */
function buildTargetContext(target) {
  if (!target) return '';
  const t = target;
  let state;
  if (t.belowFloor) state = `🔴 BAJO SU PISO (${t.cur7}x < ${t.floor}x) — actuá (scale_down/pausa), no esperés al 1.5x global.`;
  else if (t.degrading) state = `⚠️ DEGRADANDO vs su baseline (7d ${t.cur7}x cayó ≥20% de ${t.baseline}x) — vigilá, considerá scale_down aunque siga sobre el mínimo global.`;
  else state = `🟢 en línea con su baseline — si freq sana, escalá con confianza.`;
  return `\n\n## TARGET POR-ADSET (juzgá contra ESTO, no los umbrales globales):\n` +
    `Este adset PROBÓ rendir ~${t.baseline}x${t.cashAdjusted ? ' (cash-adj)' : ''} (baseline ${t.basis}). Su piso: ${t.floor}x. Actual: 7d ${t.cur7}x · 3d ${t.cur3}x. ${state}`;
}

module.exports = { computeAdsetTarget, buildTargetContext };
