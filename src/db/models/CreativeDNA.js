const mongoose = require('mongoose');

/**
 * CreativeDNA — Fitness tracking por combinacion unica de dimensiones creativas.
 *
 * El DNA de un creativo son sus 5 dimensiones: scene, style, copy_angle, product, hook_type.
 * Cada combinacion unica (dna_hash) acumula fitness across tests multiples.
 * Foundation para Apollo Evolutivo (Fase 3): selection/mutation/crossover sobre winning DNAs.
 */
const creativeDNASchema = new mongoose.Schema({
  // Identificador unico de la combinacion (hash deterministico)
  dna_hash: { type: String, required: true, unique: true, index: true },

  // Las 5 dimensiones componentes
  dimensions: {
    scene: { type: String, default: '' },        // picnic-blanket | office-desk | game-night | pool-day | etc
    style: { type: String, default: '' },        // ugly-ad | pov-selfie | etc
    copy_angle: { type: String, default: '' },   // curiosity | social-proof | etc
    product: { type: String, default: '' },      // BYB | Hot Pickled Tomatoes | etc
    hook_type: { type: String, default: '' }     // question | statement | exclamation | number
  },

  // Fitness — agregado de todos los tests con este DNA
  fitness: {
    // Counters
    tests_total: { type: Number, default: 0 },
    tests_graduated: { type: Number, default: 0 },
    tests_killed: { type: Number, default: 0 },
    tests_expired: { type: Number, default: 0 },

    // Performance agregada
    total_spend: { type: Number, default: 0 },
    total_revenue: { type: Number, default: 0 },
    total_purchases: { type: Number, default: 0 },

    // Calculadas (derived, update on each test outcome)
    avg_roas: { type: Number, default: 0 },
    win_rate: { type: Number, default: 0 },         // graduated / total (0-1)
    avg_cpa: { type: Number, default: 0 },

    // Recency
    last_test_at: { type: Date, default: null },
    last_outcome: { type: String, enum: ['graduated', 'killed', 'expired', null], default: null },

    // Confidence signal — low samples = ruidoso
    sample_confidence: { type: Number, default: 0 }  // 0-1, asintotico a 1 con mas samples
  },

  // Linaje (para Fase 3 evolucion)
  generation: { type: Number, default: 0 },             // 0 = creado random, 1+ = producto de evolucion
  parent_dnas: [{ type: String }],                      // dna_hashes de padres si fue mutation/crossover
  created_via: { type: String, enum: ['random', 'mutation', 'crossover', 'manual'], default: 'random' },

  // Timestamps
  first_seen_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

// Indexes para queries de fitness (Top DNAs, ranking)
creativeDNASchema.index({ 'fitness.avg_roas': -1, 'fitness.tests_total': -1 });
creativeDNASchema.index({ 'fitness.win_rate': -1, 'fitness.tests_total': -1 });
creativeDNASchema.index({ 'fitness.last_test_at': -1 });

// Method: actualizar fitness tras un test outcome
creativeDNASchema.methods.recordOutcome = function(outcome, metrics) {
  const { spend = 0, revenue = 0, purchases = 0 } = metrics || {};

  this.fitness.tests_total += 1;
  if (outcome === 'graduated') this.fitness.tests_graduated += 1;
  else if (outcome === 'killed') this.fitness.tests_killed += 1;
  else if (outcome === 'expired') this.fitness.tests_expired += 1;

  this.fitness.total_spend += spend;
  this.fitness.total_revenue += revenue;
  this.fitness.total_purchases += purchases;

  this.fitness.avg_roas = this.fitness.total_spend > 0
    ? Math.round((this.fitness.total_revenue / this.fitness.total_spend) * 100) / 100
    : 0;

  this.fitness.win_rate = this.fitness.tests_total > 0
    ? this.fitness.tests_graduated / this.fitness.tests_total
    : 0;

  this.fitness.avg_cpa = this.fitness.total_purchases > 0
    ? Math.round((this.fitness.total_spend / this.fitness.total_purchases) * 100) / 100
    : 0;

  // Sample confidence — asintotico, requiere ~10 samples para llegar a 0.8
  this.fitness.sample_confidence = Math.min(1, this.fitness.tests_total / 12);

  this.fitness.last_test_at = new Date();
  this.fitness.last_outcome = outcome;
  this.updated_at = new Date();
};

module.exports = mongoose.model('CreativeDNA', creativeDNASchema);
