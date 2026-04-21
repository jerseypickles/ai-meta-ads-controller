const mongoose = require('mongoose');

/**
 * ZeusAgentStance — postura operativa de un agente por ventana temporal.
 *
 * Reemplaza "cada ciclo decide desde cero" por "el agente forma opinión
 * del día una vez, la justifica, y los ciclos la consultan".
 *
 * Stances (volumen/agresividad):
 *   aggressive, steady, observe-only, paused, recovering
 *
 * Focus (ortogonal, qué mirás): free-text, optional.
 *
 * Calibración retroactiva (Fase 2): cada stance cierra a 7d con verdict
 * measurado contra baseline rolling de 14d.
 */
const STANCES = ['aggressive', 'steady', 'observe-only', 'paused', 'recovering'];
const AGENTS = ['prometheus', 'athena', 'apollo', 'ares'];

const zeusAgentStanceSchema = new mongoose.Schema({
  agent: { type: String, enum: AGENTS, required: true, index: true },
  stance: { type: String, enum: STANCES, required: true, index: true },
  focus: { type: String, default: '' },   // thematic attention, ortogonal al stance
  rationale: { type: String, default: '' },

  // El briefing obliga a listar 2 pros + 2 cons antes de elegir (antihysteresis)
  pros: [{ type: String }],
  cons: [{ type: String }],

  // Context snapshot al momento de decidir — para auditoría + verdict retro
  context_snapshot: { type: mongoose.Schema.Types.Mixed, default: {} },

  // De dónde vino esta postura
  source: {
    type: String,
    enum: ['briefing', 'override_creator', 'override_zeus', 'fallback_stale', 'fallback_default'],
    default: 'briefing',
    index: true
  },

  // Override tracking (Zeus o creador pueden intervenir)
  override_by: { type: String, enum: ['creator', 'zeus', null], default: null },
  override_reason: { type: String, default: '' },

  // Si el briefing falló y estamos usando el stance de ayer
  stale: { type: Boolean, default: false },

  // Lifecycle
  created_at: { type: Date, default: Date.now, index: true },
  expires_at: { type: Date, required: true, index: true },   // obligatorio, max 72h
  superseded_at: { type: Date, default: null },               // cuando un nuevo stance lo reemplazó
  superseded_by: { type: mongoose.Schema.Types.ObjectId, ref: 'ZeusAgentStance', default: null },

  // ═══ Verdict calibration (Fase 2) ═══
  verdict: {
    type: String,
    enum: ['correct', 'wrong', 'inconclusive', null],
    default: null,
    index: true
  },
  verdict_measured_at: { type: Date, default: null },
  verdict_definition_version: { type: String, default: null },  // si cambia, resetea cal
  verdict_metrics: { type: mongoose.Schema.Types.Mixed, default: null }
});

// Active stance lookup — el más reciente no superseded + no expirado
zeusAgentStanceSchema.index({ agent: 1, superseded_at: 1, expires_at: 1, created_at: -1 });
// Para historia
zeusAgentStanceSchema.index({ agent: 1, created_at: -1 });
// Para verdict cron (busca los ≥7d sin verdict)
zeusAgentStanceSchema.index({ verdict: 1, created_at: 1 });

zeusAgentStanceSchema.statics.STANCES = STANCES;
zeusAgentStanceSchema.statics.AGENTS = AGENTS;

module.exports = mongoose.model('ZeusAgentStance', zeusAgentStanceSchema);
