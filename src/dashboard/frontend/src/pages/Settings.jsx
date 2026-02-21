/**
 * Settings Page - Configuración
 * Permite editar guardas de seguridad y objetivos KPI
 */

import React, { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Save, Check } from 'lucide-react';
import { getSettings, updateSafety, updateKPI } from '../api';

const Settings = () => {
  // Estados para KPI targets
  const [kpiForm, setKpiForm] = useState({
    target_roas: 0,
    min_roas: 0,
    excellent_roas: 0,
    target_cpa: 0,
    max_cpa: 0,
    min_ctr: 0,
    frequency_warning: 0,
    frequency_critical: 0,
    daily_spend_target: 0,
    underpacing_threshold: 0,
    overpacing_threshold: 0,
  });

  // Estados para Safety guards
  const [safetyForm, setSafetyForm] = useState({
    daily_budget_ceiling: 0,
    min_adset_budget: 0,
    max_adset_budget: 0,
    max_increase_per_action: 0,
    max_decrease_per_action: 0,
    max_daily_total_change: 0,
    cooldown_hours: 0,
    learning_phase_protection: false,
    killswitch_min_roas: 0,
    killswitch_cpa_multiplier: 0,
    killswitch_daily_loss_threshold: 0,
    killswitch_enabled: false,
  });

  const [loading, setLoading] = useState(true);
  const [kpiSuccess, setKpiSuccess] = useState(false);
  const [safetySuccess, setSafetySuccess] = useState(false);
  const [error, setError] = useState(null);

  // Cargar configuración al montar
  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getSettings();

      // Mapear datos de KPI
      if (data.kpi) {
        setKpiForm({
          target_roas: data.kpi.target_roas || 0,
          min_roas: data.kpi.min_roas || 0,
          excellent_roas: data.kpi.excellent_roas || 0,
          target_cpa: data.kpi.target_cpa || 0,
          max_cpa: data.kpi.max_cpa || 0,
          min_ctr: data.kpi.min_ctr || 0,
          frequency_warning: data.kpi.frequency_warning || 0,
          frequency_critical: data.kpi.frequency_critical || 0,
          daily_spend_target: data.kpi.daily_spend_target || 0,
          underpacing_threshold: data.kpi.underpacing_threshold || 0,
          overpacing_threshold: data.kpi.overpacing_threshold || 0,
        });
      }

      // Mapear datos de Safety
      if (data.safety) {
        setSafetyForm({
          daily_budget_ceiling: data.safety.daily_budget_ceiling || 0,
          min_adset_budget: data.safety.min_adset_budget || 0,
          max_adset_budget: data.safety.max_adset_budget || 0,
          max_increase_per_action: data.safety.max_increase_per_action || 0,
          max_decrease_per_action: data.safety.max_decrease_per_action || 0,
          max_daily_total_change: data.safety.max_daily_total_change || 0,
          cooldown_hours: data.safety.cooldown_hours || 0,
          learning_phase_protection: data.safety.learning_phase_protection || false,
          killswitch_min_roas: data.safety.killswitch_min_roas || 0,
          killswitch_cpa_multiplier: data.safety.killswitch_cpa_multiplier || 0,
          killswitch_daily_loss_threshold: data.safety.killswitch_daily_loss_threshold || 0,
          killswitch_enabled: data.safety.killswitch_enabled || false,
        });
      }
    } catch (err) {
      console.error('Error cargando configuración:', err);
      setError('Error al cargar la configuración');
    } finally {
      setLoading(false);
    }
  };

  const handleKpiChange = (field, value) => {
    setKpiForm(prev => ({ ...prev, [field]: parseFloat(value) || 0 }));
  };

  const handleSafetyChange = (field, value) => {
    setSafetyForm(prev => ({ ...prev, [field]: value }));
  };

  const handleSafetyNumberChange = (field, value) => {
    setSafetyForm(prev => ({ ...prev, [field]: parseFloat(value) || 0 }));
  };

  const saveKPI = async () => {
    try {
      setError(null);
      await updateKPI(kpiForm);
      setKpiSuccess(true);
      setTimeout(() => setKpiSuccess(false), 3000);
    } catch (err) {
      console.error('Error guardando KPI:', err);
      setError('Error al guardar objetivos KPI');
    }
  };

  const saveSafety = async () => {
    try {
      setError(null);
      await updateSafety(safetyForm);
      setSafetySuccess(true);
      setTimeout(() => setSafetySuccess(false), 3000);
    } catch (err) {
      console.error('Error guardando Safety:', err);
      setError('Error al guardar guardas de seguridad');
    }
  };

  const styles = {
    container: {
      padding: '24px',
      maxWidth: '1400px',
      margin: '0 auto',
      backgroundColor: '#0f1117',
      minHeight: '100vh',
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      marginBottom: '32px',
    },
    title: {
      fontSize: '32px',
      fontWeight: '700',
      color: '#ffffff',
      margin: 0,
    },
    card: {
      backgroundColor: '#1a1d27',
      border: '1px solid #2a2d3a',
      borderRadius: '12px',
      padding: '24px',
      marginBottom: '24px',
    },
    cardTitle: {
      fontSize: '20px',
      fontWeight: '600',
      color: '#ffffff',
      marginBottom: '24px',
      marginTop: 0,
    },
    grid: {
      display: 'grid',
      gridTemplateColumns: 'repeat(2, 1fr)',
      gap: '20px',
      marginBottom: '24px',
    },
    fieldGroup: {
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    },
    label: {
      fontSize: '14px',
      fontWeight: '500',
      color: '#9ca3af',
    },
    input: {
      backgroundColor: '#0f1117',
      border: '1px solid #2a2d3a',
      borderRadius: '6px',
      padding: '10px 12px',
      fontSize: '14px',
      color: '#ffffff',
      width: '200px',
      outline: 'none',
      transition: 'border-color 0.2s',
    },
    inputFocusStyle: {
      borderColor: '#3b82f6',
    },
    toggleContainer: {
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
    },
    toggle: {
      position: 'relative',
      width: '48px',
      height: '24px',
      backgroundColor: '#2a2d3a',
      borderRadius: '12px',
      cursor: 'pointer',
      transition: 'background-color 0.2s',
    },
    toggleActive: {
      backgroundColor: '#3b82f6',
    },
    toggleCircle: {
      position: 'absolute',
      top: '2px',
      left: '2px',
      width: '20px',
      height: '20px',
      backgroundColor: '#ffffff',
      borderRadius: '50%',
      transition: 'transform 0.2s',
    },
    toggleCircleActive: {
      transform: 'translateX(24px)',
    },
    button: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      backgroundColor: '#3b82f6',
      color: '#ffffff',
      border: 'none',
      borderRadius: '6px',
      padding: '10px 20px',
      fontSize: '14px',
      fontWeight: '600',
      cursor: 'pointer',
      transition: 'background-color 0.2s',
    },
    buttonHover: {
      backgroundColor: '#2563eb',
    },
    successMessage: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      marginLeft: '16px',
      color: '#10b981',
      fontSize: '14px',
      fontWeight: '500',
    },
    subSection: {
      marginTop: '32px',
      paddingTop: '24px',
      borderTop: '1px solid #2a2d3a',
    },
    subSectionTitle: {
      fontSize: '16px',
      fontWeight: '600',
      color: '#ffffff',
      marginBottom: '16px',
      marginTop: 0,
    },
    error: {
      backgroundColor: '#991b1b',
      color: '#fecaca',
      padding: '12px 16px',
      borderRadius: '6px',
      marginBottom: '16px',
      fontSize: '14px',
    },
    loading: {
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      minHeight: '400px',
      color: '#9ca3af',
      fontSize: '16px',
    },
  };

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.loading}>Cargando configuración...</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <SettingsIcon size={36} color="#3b82f6" />
        <h1 style={styles.title}>Configuración</h1>
      </div>

      {/* Error global */}
      {error && <div style={styles.error}>{error}</div>}

      {/* KPI TARGETS SECTION */}
      <div style={styles.card}>
        <h2 style={styles.cardTitle}>Objetivos KPI</h2>

        <div style={styles.grid}>
          {/* ROAS Objetivo */}
          <div style={styles.fieldGroup}>
            <label style={styles.label}>ROAS Objetivo</label>
            <input
              type="number"
              step="0.1"
              value={kpiForm.target_roas}
              onChange={(e) => handleKpiChange('target_roas', e.target.value)}
              style={styles.input}
              onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
              onBlur={(e) => e.target.style.borderColor = '#2a2d3a'}
            />
          </div>

          {/* ROAS Mínimo */}
          <div style={styles.fieldGroup}>
            <label style={styles.label}>ROAS Mínimo</label>
            <input
              type="number"
              step="0.1"
              value={kpiForm.min_roas}
              onChange={(e) => handleKpiChange('min_roas', e.target.value)}
              style={styles.input}
              onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
              onBlur={(e) => e.target.style.borderColor = '#2a2d3a'}
            />
          </div>

          {/* ROAS Excelente */}
          <div style={styles.fieldGroup}>
            <label style={styles.label}>ROAS Excelente</label>
            <input
              type="number"
              step="0.1"
              value={kpiForm.excellent_roas}
              onChange={(e) => handleKpiChange('excellent_roas', e.target.value)}
              style={styles.input}
              onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
              onBlur={(e) => e.target.style.borderColor = '#2a2d3a'}
            />
          </div>

          {/* CPA Objetivo */}
          <div style={styles.fieldGroup}>
            <label style={styles.label}>CPA Objetivo $</label>
            <input
              type="number"
              step="0.01"
              value={kpiForm.target_cpa}
              onChange={(e) => handleKpiChange('target_cpa', e.target.value)}
              style={styles.input}
              onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
              onBlur={(e) => e.target.style.borderColor = '#2a2d3a'}
            />
          </div>

          {/* CPA Máximo */}
          <div style={styles.fieldGroup}>
            <label style={styles.label}>CPA Máximo $</label>
            <input
              type="number"
              step="0.01"
              value={kpiForm.max_cpa}
              onChange={(e) => handleKpiChange('max_cpa', e.target.value)}
              style={styles.input}
              onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
              onBlur={(e) => e.target.style.borderColor = '#2a2d3a'}
            />
          </div>

          {/* CTR Mínimo */}
          <div style={styles.fieldGroup}>
            <label style={styles.label}>CTR Mínimo %</label>
            <input
              type="number"
              step="0.01"
              value={kpiForm.min_ctr}
              onChange={(e) => handleKpiChange('min_ctr', e.target.value)}
              style={styles.input}
              onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
              onBlur={(e) => e.target.style.borderColor = '#2a2d3a'}
            />
          </div>

          {/* Frecuencia Warning */}
          <div style={styles.fieldGroup}>
            <label style={styles.label}>Frecuencia Warning</label>
            <input
              type="number"
              step="0.1"
              value={kpiForm.frequency_warning}
              onChange={(e) => handleKpiChange('frequency_warning', e.target.value)}
              style={styles.input}
              onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
              onBlur={(e) => e.target.style.borderColor = '#2a2d3a'}
            />
          </div>

          {/* Frecuencia Crítica */}
          <div style={styles.fieldGroup}>
            <label style={styles.label}>Frecuencia Crítica</label>
            <input
              type="number"
              step="0.1"
              value={kpiForm.frequency_critical}
              onChange={(e) => handleKpiChange('frequency_critical', e.target.value)}
              style={styles.input}
              onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
              onBlur={(e) => e.target.style.borderColor = '#2a2d3a'}
            />
          </div>

          {/* Gasto Diario Objetivo */}
          <div style={styles.fieldGroup}>
            <label style={styles.label}>Gasto Diario Objetivo $</label>
            <input
              type="number"
              step="0.01"
              value={kpiForm.daily_spend_target}
              onChange={(e) => handleKpiChange('daily_spend_target', e.target.value)}
              style={styles.input}
              onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
              onBlur={(e) => e.target.style.borderColor = '#2a2d3a'}
            />
          </div>

          {/* Umbral Underpacing */}
          <div style={styles.fieldGroup}>
            <label style={styles.label}>Umbral Underpacing</label>
            <input
              type="number"
              step="0.01"
              min="0"
              max="1"
              value={kpiForm.underpacing_threshold}
              onChange={(e) => handleKpiChange('underpacing_threshold', e.target.value)}
              style={styles.input}
              onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
              onBlur={(e) => e.target.style.borderColor = '#2a2d3a'}
            />
          </div>

          {/* Umbral Overpacing */}
          <div style={styles.fieldGroup}>
            <label style={styles.label}>Umbral Overpacing</label>
            <input
              type="number"
              step="0.01"
              min="1"
              max="2"
              value={kpiForm.overpacing_threshold}
              onChange={(e) => handleKpiChange('overpacing_threshold', e.target.value)}
              style={styles.input}
              onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
              onBlur={(e) => e.target.style.borderColor = '#2a2d3a'}
            />
          </div>
        </div>

        <div>
          <button
            onClick={saveKPI}
            style={styles.button}
            onMouseEnter={(e) => e.target.style.backgroundColor = '#2563eb'}
            onMouseLeave={(e) => e.target.style.backgroundColor = '#3b82f6'}
          >
            <Save size={16} />
            Guardar KPI
          </button>
          {kpiSuccess && (
            <span style={styles.successMessage}>
              <Check size={16} />
              Configuración guardada
            </span>
          )}
        </div>
      </div>

      {/* SAFETY GUARDS SECTION */}
      <div style={styles.card}>
        <h2 style={styles.cardTitle}>Guardas de Seguridad</h2>

        <div style={styles.grid}>
          {/* Techo Presupuesto Diario */}
          <div style={styles.fieldGroup}>
            <label style={styles.label}>Techo Presupuesto Diario $</label>
            <input
              type="number"
              step="0.01"
              value={safetyForm.daily_budget_ceiling}
              onChange={(e) => handleSafetyNumberChange('daily_budget_ceiling', e.target.value)}
              style={styles.input}
              onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
              onBlur={(e) => e.target.style.borderColor = '#2a2d3a'}
            />
          </div>

          {/* Min Presupuesto Ad Set */}
          <div style={styles.fieldGroup}>
            <label style={styles.label}>Min Presupuesto Ad Set $</label>
            <input
              type="number"
              step="0.01"
              value={safetyForm.min_adset_budget}
              onChange={(e) => handleSafetyNumberChange('min_adset_budget', e.target.value)}
              style={styles.input}
              onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
              onBlur={(e) => e.target.style.borderColor = '#2a2d3a'}
            />
          </div>

          {/* Max Presupuesto Ad Set */}
          <div style={styles.fieldGroup}>
            <label style={styles.label}>Max Presupuesto Ad Set $</label>
            <input
              type="number"
              step="0.01"
              value={safetyForm.max_adset_budget}
              onChange={(e) => handleSafetyNumberChange('max_adset_budget', e.target.value)}
              style={styles.input}
              onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
              onBlur={(e) => e.target.style.borderColor = '#2a2d3a'}
            />
          </div>

          {/* Max Incremento por Acción */}
          <div style={styles.fieldGroup}>
            <label style={styles.label}>Max Incremento por Acción %</label>
            <input
              type="number"
              step="1"
              value={safetyForm.max_increase_per_action}
              onChange={(e) => handleSafetyNumberChange('max_increase_per_action', e.target.value)}
              style={styles.input}
              onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
              onBlur={(e) => e.target.style.borderColor = '#2a2d3a'}
            />
          </div>

          {/* Max Reducción por Acción */}
          <div style={styles.fieldGroup}>
            <label style={styles.label}>Max Reducción por Acción %</label>
            <input
              type="number"
              step="1"
              value={safetyForm.max_decrease_per_action}
              onChange={(e) => handleSafetyNumberChange('max_decrease_per_action', e.target.value)}
              style={styles.input}
              onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
              onBlur={(e) => e.target.style.borderColor = '#2a2d3a'}
            />
          </div>

          {/* Max Cambio Diario Total */}
          <div style={styles.fieldGroup}>
            <label style={styles.label}>Max Cambio Diario Total %</label>
            <input
              type="number"
              step="1"
              value={safetyForm.max_daily_total_change}
              onChange={(e) => handleSafetyNumberChange('max_daily_total_change', e.target.value)}
              style={styles.input}
              onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
              onBlur={(e) => e.target.style.borderColor = '#2a2d3a'}
            />
          </div>

          {/* Horas de Cooldown */}
          <div style={styles.fieldGroup}>
            <label style={styles.label}>Horas de Cooldown</label>
            <input
              type="number"
              step="1"
              value={safetyForm.cooldown_hours}
              onChange={(e) => handleSafetyNumberChange('cooldown_hours', e.target.value)}
              style={styles.input}
              onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
              onBlur={(e) => e.target.style.borderColor = '#2a2d3a'}
            />
          </div>

          {/* Protección Fase Aprendizaje */}
          <div style={styles.fieldGroup}>
            <label style={styles.label}>Protección Fase Aprendizaje</label>
            <div style={styles.toggleContainer}>
              <div
                onClick={() => handleSafetyChange('learning_phase_protection', !safetyForm.learning_phase_protection)}
                style={{
                  ...styles.toggle,
                  ...(safetyForm.learning_phase_protection ? styles.toggleActive : {}),
                }}
              >
                <div
                  style={{
                    ...styles.toggleCircle,
                    ...(safetyForm.learning_phase_protection ? styles.toggleCircleActive : {}),
                  }}
                />
              </div>
              <span style={{ color: '#9ca3af', fontSize: '14px' }}>
                {safetyForm.learning_phase_protection ? 'Activado' : 'Desactivado'}
              </span>
            </div>
          </div>
        </div>

        {/* Kill Switch Sub-section */}
        <div style={styles.subSection}>
          <h3 style={styles.subSectionTitle}>Kill Switch</h3>

          <div style={styles.grid}>
            {/* ROAS Mínimo Kill Switch */}
            <div style={styles.fieldGroup}>
              <label style={styles.label}>ROAS Mínimo Kill Switch</label>
              <input
                type="number"
                step="0.1"
                value={safetyForm.killswitch_min_roas}
                onChange={(e) => handleSafetyNumberChange('killswitch_min_roas', e.target.value)}
                style={styles.input}
                onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
                onBlur={(e) => e.target.style.borderColor = '#2a2d3a'}
              />
            </div>

            {/* Multiplicador CPA Kill Switch */}
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Multiplicador CPA Kill Switch</label>
              <input
                type="number"
                step="0.1"
                value={safetyForm.killswitch_cpa_multiplier}
                onChange={(e) => handleSafetyNumberChange('killswitch_cpa_multiplier', e.target.value)}
                style={styles.input}
                onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
                onBlur={(e) => e.target.style.borderColor = '#2a2d3a'}
              />
            </div>

            {/* Umbral Pérdida Diaria */}
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Umbral Pérdida Diaria $</label>
              <input
                type="number"
                step="0.01"
                value={safetyForm.killswitch_daily_loss_threshold}
                onChange={(e) => handleSafetyNumberChange('killswitch_daily_loss_threshold', e.target.value)}
                style={styles.input}
                onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
                onBlur={(e) => e.target.style.borderColor = '#2a2d3a'}
              />
            </div>

            {/* Kill Switch Habilitado */}
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Kill Switch Habilitado</label>
              <div style={styles.toggleContainer}>
                <div
                  onClick={() => handleSafetyChange('killswitch_enabled', !safetyForm.killswitch_enabled)}
                  style={{
                    ...styles.toggle,
                    ...(safetyForm.killswitch_enabled ? styles.toggleActive : {}),
                  }}
                >
                  <div
                    style={{
                      ...styles.toggleCircle,
                      ...(safetyForm.killswitch_enabled ? styles.toggleCircleActive : {}),
                    }}
                  />
                </div>
                <span style={{ color: '#9ca3af', fontSize: '14px' }}>
                  {safetyForm.killswitch_enabled ? 'Activado' : 'Desactivado'}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div>
          <button
            onClick={saveSafety}
            style={styles.button}
            onMouseEnter={(e) => e.target.style.backgroundColor = '#2563eb'}
            onMouseLeave={(e) => e.target.style.backgroundColor = '#3b82f6'}
          >
            <Save size={16} />
            Guardar Seguridad
          </button>
          {safetySuccess && (
            <span style={styles.successMessage}>
              <Check size={16} />
              Configuración guardada
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export default Settings;
