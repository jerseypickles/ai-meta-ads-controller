module.exports = {
  // Límites de presupuesto
  budget_ceiling_daily: 5000,        // Máximo gasto diario total en la cuenta ($)
  min_adset_budget: 10,              // Nunca bajar de $10/día por ad set
  max_single_adset_budget: 500,      // Ningún ad set recibe más de $500/día

  // Límites de cambio por acción
  max_budget_increase_pct: 25,       // Máximo +25% por ajuste
  max_budget_decrease_pct: 30,       // Máximo -30% por ajuste
  max_total_daily_change_pct: 20,    // Máximo 20% de cambio total diario en la cuenta (alineado con limite de Meta para no resetear learning phase)

  // Períodos de enfriamiento
  cooldown_hours: 6,                 // No tocar la misma entidad por 6 horas (suficiente para que Meta procese)
  learning_phase_protection: true,   // No modificar entidades en fase de aprendizaje

  // Kill switch — disparadores de emergencia
  kill_switch: {
    account_roas_below: 0.5,           // Pausar todo si ROAS cae debajo de 0.5x
    account_cpa_above_multiplier: 3,   // 3x el CPA objetivo activa kill switch
    daily_loss_threshold: 1000,        // $1000 de pérdida en un día activa revisión
    enabled: true
  },

  // Horas de operación (ET) — la IA solo hace cambios durante estas horas
  active_hours: {
    start: 6,     // 6 AM ET
    end: 23,      // 11 PM ET
    timezone: 'America/New_York'
  },

  // Enfoque cauteloso: análisis de tendencia antes de actuar
  trend_analysis: {
    min_data_days: 3,                  // Mínimo 3 días de datos antes de actuar
    min_spend_for_decision: 20,        // Mínimo $20 gastados antes de evaluar
    confirm_trend_windows: 2           // Confirmar tendencia en al menos 2 ventanas de tiempo
  },

  // Detección de anomalías por entidad — corre cada 10 minutos
  anomaly_detection: {
    enabled: true,
    // Umbral de caída de ROAS: si ROAS actual < ROAS 7d * (1 - threshold), anomalía
    roas_drop_threshold: 0.50,         // Caída >50% vs promedio 7d
    // Umbral de spike de gasto: gasto hoy > presupuesto diario * multiplier
    spend_spike_multiplier: 2.5,       // Gasto >2.5x del presupuesto diario
    // Mínimo de gasto para considerar una entidad (evitar falsos positivos con $2)
    min_spend_for_anomaly: 15,
    // Cooldown entre detecciones sobre la misma entidad (horas)
    cooldown_hours: 6,
    // Auto-pausar entidades anómalas (si false, solo alerta)
    auto_pause: true
  },

  // Modo de autonomía global del Cerebro IA: 'manual' | 'semi_auto' | 'auto'
  // manual     = requiere aprobación + ejecución humana
  // semi_auto  = auto-ejecuta si confidence=high Y cambio <= max_auto_change_pct
  // auto       = ejecuta todo automáticamente, solo notifica
  autonomy: {
    mode: 'manual',
    max_auto_change_pct: 20            // En semi_auto, solo auto-ejecutar cambios <= 20%
  }
};
