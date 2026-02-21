/**
 * Panel de Control - Gestión de Controles de Seguridad
 * Kill Switch, Estado del Sistema, Eventos de Seguridad, Cooldowns
 */

import { useState, useEffect } from 'react';
import {
  Shield,
  AlertTriangle,
  Power,
  CheckCircle,
  XCircle,
  Clock,
  Activity,
  AlertCircle,
  Info,
  Zap
} from 'lucide-react';
import { getControlsStatus, triggerKillSwitch, toggleAI } from '../api';

const Controls = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Cargar datos de controles
  const loadControlsData = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await getControlsStatus();
      setData(response);
    } catch (err) {
      console.error('Error cargando controles:', err);
      setError(err.response?.data?.message || 'Error al cargar datos de controles');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadControlsData();
    // Auto-refresh cada 60 segundos
    const interval = setInterval(loadControlsData, 60000);
    return () => clearInterval(interval);
  }, []);

  // Manejar toggle de IA
  const handleAIToggle = async () => {
    const currentEnabled = data?.ai_enabled || false;
    const newEnabled = !currentEnabled;

    const confirmMessage = newEnabled
      ? 'ACTIVAR CONTROL DE IA?\n\nLa IA comenzara a tomar decisiones y ejecutar acciones sobre las campanas.'
      : 'DESACTIVAR CONTROL DE IA?\n\nLa IA dejara de tomar decisiones. Los datos se seguiran recolectando.';

    if (!window.confirm(confirmMessage)) return;

    try {
      setActionLoading(true);
      await toggleAI(newEnabled);
      await loadControlsData();
    } catch (err) {
      console.error('Error al cambiar estado de IA:', err);
      alert('Error: ' + (err.response?.data?.error || 'No se pudo cambiar el estado'));
    } finally {
      setActionLoading(false);
    }
  };

  // Manejar activación/desactivación del kill switch
  const handleKillSwitch = async (action) => {
    const isActivating = action === 'activate';

    const confirmMessage = isActivating
      ? '¿CONFIRMAR ACTIVACIÓN DEL KILL SWITCH?\n\nEsto pausará TODAS las campañas inmediatamente.\nEsta acción debe usarse solo en emergencias.'
      : '¿CONFIRMAR DESACTIVACIÓN DEL KILL SWITCH?\n\nEsto permitirá que el sistema vuelva a operar normalmente.';

    if (!window.confirm(confirmMessage)) {
      return;
    }

    const reason = window.prompt(
      isActivating
        ? 'Razón para activar el kill switch:'
        : 'Razón para desactivar el kill switch:',
      isActivating ? 'Emergencia detectada' : 'Situación resuelta'
    );

    if (!reason) {
      return;
    }

    try {
      setActionLoading(true);
      await triggerKillSwitch(action, reason);
      await loadControlsData();
      alert(
        isActivating
          ? 'Kill switch ACTIVADO. Todas las campañas han sido pausadas.'
          : 'Kill switch DESACTIVADO. El sistema puede operar normalmente.'
      );
    } catch (err) {
      console.error('Error en kill switch:', err);
      alert('Error: ' + (err.response?.data?.message || 'No se pudo ejecutar la acción'));
    } finally {
      setActionLoading(false);
    }
  };

  // Formatear fecha/hora
  const formatDateTime = (dateString) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleString('es-ES', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  // Formatear tiempo relativo
  const formatTimeAgo = (dateString) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'Ahora mismo';
    if (diffMins < 60) return `Hace ${diffMins} min`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `Hace ${diffHours}h`;
    const diffDays = Math.floor(diffHours / 24);
    return `Hace ${diffDays}d`;
  };

  // Calcular minutos restantes de cooldown
  const calculateCooldownRemaining = (cooldownUntil) => {
    if (!cooldownUntil) return 0;
    const until = new Date(cooldownUntil);
    const now = new Date();
    const diffMs = until - now;
    return Math.max(0, Math.ceil(diffMs / 60000));
  };

  // Iconos de severidad para eventos
  const getSeverityIcon = (severity) => {
    switch (severity) {
      case 'critical':
        return <XCircle size={20} style={{ color: '#ef4444' }} />;
      case 'warning':
        return <AlertTriangle size={20} style={{ color: '#f59e0b' }} />;
      case 'info':
        return <Info size={20} style={{ color: '#3b82f6' }} />;
      default:
        return <AlertCircle size={20} style={{ color: '#6b7280' }} />;
    }
  };

  // Estilos base
  const styles = {
    container: {
      minHeight: '100vh',
      backgroundColor: '#0f1117',
      color: '#e5e7eb',
      padding: '24px',
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      marginBottom: '32px',
    },
    headerTitle: {
      fontSize: '32px',
      fontWeight: 'bold',
      color: '#f9fafb',
      margin: 0,
    },
    card: {
      backgroundColor: '#1a1d27',
      border: '1px solid #2a2d3a',
      borderRadius: '8px',
      padding: '24px',
      marginBottom: '24px',
    },
    cardTitle: {
      fontSize: '18px',
      fontWeight: '600',
      color: '#f9fafb',
      marginBottom: '16px',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
    },
    loadingContainer: {
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      minHeight: '400px',
      fontSize: '18px',
      color: '#9ca3af',
    },
    errorContainer: {
      backgroundColor: '#1a1d27',
      border: '1px solid #ef4444',
      borderRadius: '8px',
      padding: '24px',
      color: '#ef4444',
      textAlign: 'center',
    },
  };

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.loadingContainer}>
          <Activity className="animate-spin" size={32} />
          <span style={{ marginLeft: '12px' }}>Cargando controles...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.container}>
        <div style={styles.errorContainer}>
          <AlertTriangle size={48} style={{ marginBottom: '16px' }} />
          <h2 style={{ margin: '0 0 8px 0' }}>Error al Cargar Controles</h2>
          <p style={{ margin: 0 }}>{error}</p>
          <button
            onClick={loadControlsData}
            style={{
              marginTop: '16px',
              padding: '8px 24px',
              backgroundColor: '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: '500',
            }}
          >
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  const aiEnabled = data?.ai_enabled || false;
  const killSwitchActive = data?.kill_switch_active || false;
  const safetyEvents = data?.safety_events || [];
  const cooldowns = data?.cooldowns || [];

  return (
    <div style={styles.container}>
      {/* HEADER */}
      <div style={styles.header}>
        <Shield size={40} style={{ color: '#3b82f6' }} />
        <h1 style={styles.headerTitle}>Panel de Control</h1>
      </div>

      {/* AI CONTROL SWITCH */}
      <div style={{
        ...styles.card,
        background: 'linear-gradient(135deg, #1a1d27 0%, #1f2230 100%)',
        border: `1px solid ${aiEnabled ? '#3b82f6' : '#4b5563'}`,
        marginBottom: '32px',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <div>
            <div style={{
              fontSize: '16px',
              color: '#9ca3af',
              marginBottom: '8px',
              fontWeight: '500',
            }}>
              Control de Inteligencia Artificial
            </div>
            <div style={{
              fontSize: '28px',
              fontWeight: 'bold',
              color: aiEnabled ? '#3b82f6' : '#6b7280',
              letterSpacing: '0.5px',
            }}>
              {aiEnabled ? 'IA ACTIVA' : 'IA INACTIVA'}
            </div>
            <div style={{
              marginTop: '8px',
              fontSize: '14px',
              color: '#9ca3af',
            }}>
              {aiEnabled
                ? 'La IA toma decisiones y ejecuta acciones sobre las campanas'
                : 'Solo se recolectan datos — la IA no toma decisiones'}
            </div>
          </div>

          <button
            onClick={handleAIToggle}
            disabled={actionLoading}
            style={{
              padding: '16px 32px',
              backgroundColor: aiEnabled ? '#374151' : '#1d4ed8',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              fontSize: '16px',
              fontWeight: 'bold',
              cursor: actionLoading ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              opacity: actionLoading ? 0.6 : 1,
              transition: 'all 0.2s',
              minWidth: '200px',
              justifyContent: 'center',
            }}
          >
            <Power size={20} />
            {actionLoading ? 'Procesando...' : aiEnabled ? 'DESACTIVAR IA' : 'ACTIVAR IA'}
          </button>
        </div>
      </div>

      {/* KILL SWITCH SECTION */}
      <div style={{
        ...styles.card,
        backgroundColor: killSwitchActive ? '#7f1d1d' : '#064e3b',
        border: killSwitchActive ? '2px solid #ef4444' : '2px solid #10b981',
        padding: '32px',
        marginBottom: '32px',
        animation: killSwitchActive ? 'pulse 2s ease-in-out infinite' : 'none',
      }}>
        {!killSwitchActive ? (
          // Sistema operando normalmente
          <>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '24px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <CheckCircle size={48} style={{ color: '#10b981' }} />
                <div>
                  <div style={{
                    fontSize: '28px',
                    fontWeight: 'bold',
                    color: '#f9fafb',
                    marginBottom: '4px',
                  }}>
                    Sistema Operando Normalmente
                  </div>
                  <div style={{ fontSize: '14px', color: '#9ca3af' }}>
                    Todas las campañas están bajo control normal de la IA
                  </div>
                </div>
              </div>
            </div>

            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '16px',
              paddingTop: '24px',
              borderTop: '1px solid #065f46',
            }}>
              <button
                onClick={() => handleKillSwitch('activate')}
                disabled={actionLoading}
                style={{
                  padding: '16px 32px',
                  backgroundColor: '#dc2626',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  fontSize: '16px',
                  fontWeight: 'bold',
                  cursor: actionLoading ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  opacity: actionLoading ? 0.6 : 1,
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => {
                  if (!actionLoading) e.target.style.backgroundColor = '#b91c1c';
                }}
                onMouseLeave={(e) => {
                  if (!actionLoading) e.target.style.backgroundColor = '#dc2626';
                }}
              >
                <AlertTriangle size={20} />
                {actionLoading ? 'Procesando...' : 'ACTIVAR KILL SWITCH'}
              </button>
              <div style={{ fontSize: '14px', color: '#fca5a5' }}>
                <AlertTriangle size={16} style={{ display: 'inline', marginRight: '6px' }} />
                Esto pausará TODAS las campañas inmediatamente
              </div>
            </div>
          </>
        ) : (
          // Kill switch activo
          <>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '24px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <XCircle size={48} style={{ color: '#ef4444' }} />
                <div>
                  <div style={{
                    fontSize: '28px',
                    fontWeight: 'bold',
                    color: '#f9fafb',
                    marginBottom: '4px',
                  }}>
                    KILL SWITCH ACTIVO
                  </div>
                  <div style={{ fontSize: '14px', color: '#fca5a5' }}>
                    Todas las campañas han sido pausadas
                  </div>
                </div>
              </div>
            </div>

            <div style={{
              backgroundColor: '#7f1d1d',
              border: '1px solid #991b1b',
              borderRadius: '6px',
              padding: '16px',
              marginBottom: '24px',
            }}>
              <div style={{ marginBottom: '12px' }}>
                <div style={{ fontSize: '12px', color: '#fca5a5', marginBottom: '4px' }}>
                  RAZÓN:
                </div>
                <div style={{ fontSize: '16px', color: '#f9fafb', fontWeight: '500' }}>
                  {safetyEvents.find(e => e.event_type === 'kill_switch_triggered')?.description || 'No especificada'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '12px', color: '#fca5a5', marginBottom: '4px' }}>
                  ACTIVADO:
                </div>
                <div style={{ fontSize: '14px', color: '#f9fafb' }}>
                  {formatDateTime(safetyEvents.find(e => e.event_type === 'kill_switch_triggered')?.created_at)}
                </div>
              </div>
            </div>

            <button
              onClick={() => handleKillSwitch('deactivate')}
              disabled={actionLoading}
              style={{
                padding: '16px 32px',
                backgroundColor: '#f59e0b',
                color: '#1f2937',
                border: 'none',
                borderRadius: '6px',
                fontSize: '16px',
                fontWeight: 'bold',
                cursor: actionLoading ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                opacity: actionLoading ? 0.6 : 1,
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                if (!actionLoading) e.target.style.backgroundColor = '#d97706';
              }}
              onMouseLeave={(e) => {
                if (!actionLoading) e.target.style.backgroundColor = '#f59e0b';
              }}
            >
              <Power size={20} />
              {actionLoading ? 'Procesando...' : 'DESACTIVAR KILL SWITCH'}
            </button>
          </>
        )}
      </div>

      {/* SAFETY EVENTS */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>
          <AlertTriangle size={22} style={{ color: '#f59e0b' }} />
          Eventos de Seguridad No Resueltos
        </div>
        {safetyEvents && safetyEvents.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {safetyEvents.map((event, idx) => (
              <div
                key={idx}
                style={{
                  backgroundColor: '#0f1117',
                  border: `1px solid ${
                    event.severity === 'critical' ? '#ef4444' :
                    event.severity === 'warning' ? '#f59e0b' : '#3b82f6'
                  }`,
                  borderRadius: '6px',
                  padding: '16px',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '12px',
                }}
              >
                {getSeverityIcon(event.severity)}
                <div style={{ flex: 1 }}>
                  <div style={{
                    fontSize: '14px',
                    fontWeight: '600',
                    color: '#f9fafb',
                    marginBottom: '4px',
                  }}>
                    {event.type || 'Evento de Seguridad'}
                  </div>
                  <div style={{ fontSize: '14px', color: '#d1d5db', marginBottom: '8px' }}>
                    {event.description || 'Sin descripción'}
                  </div>
                  <div style={{ fontSize: '12px', color: '#6b7280' }}>
                    <Clock size={12} style={{ display: 'inline', marginRight: '4px' }} />
                    {formatDateTime(event.timestamp)}
                  </div>
                </div>
                <div style={{
                  padding: '4px 12px',
                  borderRadius: '12px',
                  fontSize: '12px',
                  fontWeight: '600',
                  textTransform: 'uppercase',
                  backgroundColor:
                    event.severity === 'critical' ? '#7f1d1d' :
                    event.severity === 'warning' ? '#78350f' : '#1e3a8a',
                  color:
                    event.severity === 'critical' ? '#fca5a5' :
                    event.severity === 'warning' ? '#fcd34d' : '#93c5fd',
                }}>
                  {event.severity === 'critical' ? 'Crítico' :
                   event.severity === 'warning' ? 'Alerta' : 'Info'}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{
            textAlign: 'center',
            padding: '32px',
            color: '#6b7280',
            fontSize: '14px',
          }}>
            <CheckCircle size={48} style={{ color: '#10b981', margin: '0 auto 12px' }} />
            <div>Sin eventos de seguridad pendientes</div>
          </div>
        )}
      </div>

      {/* ACTIVE COOLDOWNS */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>
          <Clock size={22} style={{ color: '#3b82f6' }} />
          Cooldowns Activos
        </div>
        {cooldowns && cooldowns.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '14px',
            }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #2a2d3a' }}>
                  <th style={{
                    textAlign: 'left',
                    padding: '12px 16px',
                    color: '#9ca3af',
                    fontWeight: '600',
                    fontSize: '12px',
                    textTransform: 'uppercase',
                  }}>
                    Entidad
                  </th>
                  <th style={{
                    textAlign: 'left',
                    padding: '12px 16px',
                    color: '#9ca3af',
                    fontWeight: '600',
                    fontSize: '12px',
                    textTransform: 'uppercase',
                  }}>
                    Última Acción
                  </th>
                  <th style={{
                    textAlign: 'left',
                    padding: '12px 16px',
                    color: '#9ca3af',
                    fontWeight: '600',
                    fontSize: '12px',
                    textTransform: 'uppercase',
                  }}>
                    Cooldown Hasta
                  </th>
                  <th style={{
                    textAlign: 'right',
                    padding: '12px 16px',
                    color: '#9ca3af',
                    fontWeight: '600',
                    fontSize: '12px',
                    textTransform: 'uppercase',
                  }}>
                    Minutos Restantes
                  </th>
                </tr>
              </thead>
              <tbody>
                {cooldowns.map((cooldown, idx) => {
                  const minutesRemaining = calculateCooldownRemaining(cooldown.cooldownUntil);
                  return (
                    <tr
                      key={idx}
                      style={{
                        borderBottom: idx < cooldowns.length - 1 ? '1px solid #2a2d3a' : 'none',
                      }}
                    >
                      <td style={{ padding: '16px', color: '#f9fafb', fontWeight: '500' }}>
                        {cooldown.entityName || cooldown.entityId}
                      </td>
                      <td style={{ padding: '16px', color: '#d1d5db' }}>
                        {cooldown.lastAction || 'N/A'}
                      </td>
                      <td style={{ padding: '16px', color: '#d1d5db' }}>
                        {formatDateTime(cooldown.cooldownUntil)}
                      </td>
                      <td style={{
                        padding: '16px',
                        textAlign: 'right',
                        color: minutesRemaining < 30 ? '#10b981' : '#f59e0b',
                        fontWeight: '600',
                      }}>
                        {minutesRemaining} min
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{
            textAlign: 'center',
            padding: '32px',
            color: '#6b7280',
            fontSize: '14px',
          }}>
            <CheckCircle size={48} style={{ color: '#10b981', margin: '0 auto 12px' }} />
            <div>Sin cooldowns activos</div>
          </div>
        )}
      </div>

      {/* QUICK STATS */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
        gap: '16px',
      }}>
        {/* Total Safety Events */}
        <div style={{
          ...styles.card,
          margin: 0,
          textAlign: 'center',
        }}>
          <div style={{ fontSize: '14px', color: '#9ca3af', marginBottom: '8px' }}>
            Eventos de Seguridad
          </div>
          <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#f59e0b' }}>
            {safetyEvents.length}
          </div>
        </div>

        {/* Active Cooldowns */}
        <div style={{
          ...styles.card,
          margin: 0,
          textAlign: 'center',
        }}>
          <div style={{ fontSize: '14px', color: '#9ca3af', marginBottom: '8px' }}>
            Cooldowns Activos
          </div>
          <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#ef4444' }}>
            {cooldowns.length}
          </div>
        </div>

        {/* Kill Switch Status */}
        <div style={{
          ...styles.card,
          margin: 0,
          textAlign: 'center',
        }}>
          <div style={{ fontSize: '14px', color: '#9ca3af', marginBottom: '8px' }}>
            Kill Switch
          </div>
          <div style={{ fontSize: '32px', fontWeight: 'bold', color: killSwitchActive ? '#ef4444' : '#10b981' }}>
            {killSwitchActive ? 'ACTIVO' : 'OK'}
          </div>
        </div>
      </div>

      {/* Pulse animation for kill switch */}
      <style>
        {`
          @keyframes pulse {
            0%, 100% {
              opacity: 1;
            }
            50% {
              opacity: 0.85;
            }
          }
        `}
      </style>
    </div>
  );
};

export default Controls;
