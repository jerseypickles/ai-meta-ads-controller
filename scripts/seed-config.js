require('dotenv').config();
const config = require('../config');
const safetyGuards = require('../config/safety-guards');
const kpiTargets = require('../config/kpi-targets');

console.log('\n╔══════════════════════════════════════╗');
console.log('║  CONFIGURACIÓN ACTUAL DEL SISTEMA    ║');
console.log('╚══════════════════════════════════════╝\n');

console.log('═══ CONEXIONES ═══');
console.log(`  Meta API Version: ${config.meta.apiVersion}`);
console.log(`  Meta Ad Account: ${config.meta.adAccountId}`);
console.log(`  Meta Token: ${config.meta.accessToken ? 'Configurado' : 'NO CONFIGURADO'}`);
console.log(`  Claude Model: ${config.claude.model}`);
console.log(`  Claude Key: ${config.claude.apiKey ? 'Configurada' : 'NO CONFIGURADA'}`);
console.log(`  MongoDB: ${config.mongodb.uri}`);


console.log('\n═══ KPI TARGETS ═══');
console.log(`  ROAS Objetivo: ${kpiTargets.roas_target}x`);
console.log(`  ROAS Mínimo: ${kpiTargets.roas_minimum}x`);
console.log(`  ROAS Excelente: ${kpiTargets.roas_excellent}x`);
console.log(`  CPA Objetivo: $${kpiTargets.cpa_target}`);
console.log(`  CPA Máximo: $${kpiTargets.cpa_maximum}`);
console.log(`  CTR Mínimo: ${kpiTargets.ctr_minimum}%`);
console.log(`  Frecuencia Warning: ${kpiTargets.frequency_warning}`);
console.log(`  Frecuencia Crítica: ${kpiTargets.frequency_critical}`);
console.log(`  Gasto Diario Objetivo: $${kpiTargets.daily_spend_target}`);

console.log('\n═══ SAFETY GUARDS ═══');
console.log(`  Techo presupuesto diario: $${safetyGuards.budget_ceiling_daily}`);
console.log(`  Min presupuesto ad set: $${safetyGuards.min_adset_budget}`);
console.log(`  Max presupuesto ad set: $${safetyGuards.max_single_adset_budget}`);
console.log(`  Max incremento por acción: ${safetyGuards.max_budget_increase_pct}%`);
console.log(`  Max reducción por acción: ${safetyGuards.max_budget_decrease_pct}%`);
console.log(`  Max cambio diario total: ${safetyGuards.max_total_daily_change_pct}%`);
console.log(`  Cooldown: ${safetyGuards.cooldown_hours} horas`);
console.log(`  Kill Switch: ${safetyGuards.kill_switch.enabled ? 'ACTIVO' : 'DESACTIVADO'}`);
console.log(`  Horas activas: ${safetyGuards.active_hours.start}:00 - ${safetyGuards.active_hours.end}:00 ET`);

console.log('\n═══ EVENTOS ESTACIONALES ═══');
kpiTargets.seasonal_events.forEach(e => {
  const dateStr = e.date || `${e.start} a ${e.end}`;
  console.log(`  ${e.name}: ${dateStr} (${e.budget_multiplier}x presupuesto)`);
});

console.log('\n  Configuración verificada.\n');
