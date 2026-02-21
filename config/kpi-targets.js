module.exports = {
  // KPI Primario
  roas_target: 3.0,                  // Objetivo ROAS 3x
  roas_minimum: 1.5,                 // Debajo de esto = bajo rendimiento
  roas_excellent: 5.0,               // Arriba de esto = escalar agresivamente

  // KPIs Secundarios
  cpa_target: 25.00,                 // Costo por compra objetivo
  cpa_maximum: 50.00,                // Arriba de esto = considerar pausar
  ctr_minimum: 1.0,                  // Debajo de 1% CTR = problema creativo
  frequency_warning: 2.5,            // Audiencia empezando a fatigarse
  frequency_critical: 4.0,           // Debe pausar o refrescar audiencia
  cpm_benchmark: 15.00,              // CPM esperado para food/ecommerce

  // Pacing
  daily_spend_target: 3000,          // $3,000/día (~$90k/mes)
  underpacing_threshold: 0.7,        // Alerta si gasta < 70% del objetivo
  overpacing_threshold: 1.2,         // Alerta si gasta > 120% del objetivo

  // Calendario estacional — eventos donde se afloja la seguridad
  seasonal_events: [
    { name: 'Presidents Day', date: '02-17', budget_multiplier: 1.3 },
    { name: 'St Patricks Day', date: '03-17', budget_multiplier: 1.2 },
    { name: 'Memorial Day', start: '05-22', end: '05-26', budget_multiplier: 1.3 },
    { name: '4th of July', start: '06-28', end: '07-05', budget_multiplier: 1.5 },
    { name: 'Labor Day', start: '08-28', end: '09-02', budget_multiplier: 1.3 },
    { name: 'National Pickle Day', date: '11-14', budget_multiplier: 1.5 },
    { name: 'Thanksgiving Week', start: '11-22', end: '11-30', budget_multiplier: 1.5 },
    { name: 'Black Friday', date: '11-28', budget_multiplier: 2.0 },
    { name: 'Cyber Monday', date: '12-01', budget_multiplier: 2.0 },
    { name: 'Holiday Season', start: '12-01', end: '12-23', budget_multiplier: 1.5 },
    { name: 'Super Bowl Week', start: '02-01', end: '02-10', budget_multiplier: 1.3 }
  ]
};
