import React, { useState, useEffect } from 'react';
import {
  Brain,
  TrendingUp,
  TrendingDown,
  Pause,
  Play,
  ChevronDown,
  ChevronRight,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  Activity,
  Zap,
  Target,
  ChevronLeft,
  ChevronRight as ChevronRightIcon
} from 'lucide-react';
import {
  getDecisions,
  getDecisionStats,
  approveDecisionRecommendation,
  rejectDecisionRecommendation,
  executeDecisionRecommendation
} from '../api';

// Formatear moneda
const formatCurrency = (value) => {
  if (value === null || value === undefined) return '$0.00';
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(value);
};

// Formatear número
const formatNumber = (value) => {
  if (value === null || value === undefined) return '0';
  return new Intl.NumberFormat('es-CL').format(value);
};

// Formatear timestamp en español
const formatTimestamp = (timestamp) => {
  if (!timestamp) return 'Fecha desconocida';

  const date = new Date(timestamp);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const time = date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

  if (dateOnly.getTime() === today.getTime()) {
    return `Hoy ${time}`;
  } else if (dateOnly.getTime() === yesterday.getTime()) {
    return `Ayer ${time}`;
  } else {
    return date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
};

// Obtener color del badge de acción
const getActionBadge = (action) => {
  const badges = {
    scale_up: { label: 'Escalar', color: '#10b981', bg: '#065f46' },
    scale_down: { label: 'Reducir', color: '#fb923c', bg: '#7c2d12' },
    pause: { label: 'Pausar', color: '#ef4444', bg: '#7f1d1d' },
    reactivate: { label: 'Reactivar', color: '#3b82f6', bg: '#1e3a8a' },
    no_action: { label: 'Sin acción', color: '#6b7280', bg: '#374151' }
  };
  return badges[action] || badges.no_action;
};

// Obtener color del badge de confianza
const getConfidenceBadge = (confidence) => {
  if (confidence === 'high') {
    return { label: 'Alta', color: '#10b981', bg: '#065f46' };
  } else if (confidence === 'medium') {
    return { label: 'Media', color: '#fbbf24', bg: '#78350f' };
  } else {
    return { label: 'Baja', color: '#ef4444', bg: '#7f1d1d' };
  }
};

// Detectar si un ciclo fue generado por la IA Estrategica
const isStrategicCycle = (cycle) => {
  return (cycle.cycle_id || '').startsWith('strategic_') ||
    (cycle.analysis_summary || '').includes('[IA ESTRATEGICA]');
};

// Obtener badge de status de recomendacion
const getStatusBadge = (status) => {
  const badges = {
    pending: { label: 'Pendiente', color: '#fbbf24', bg: '#78350f' },
    approved: { label: 'Aprobada', color: '#10b981', bg: '#065f46' },
    rejected: { label: 'Rechazada', color: '#ef4444', bg: '#7f1d1d' },
    executed: { label: 'Ejecutada', color: '#3b82f6', bg: '#1e3a8a' }
  };
  return badges[status] || badges.pending;
};

// Obtener icono de safety check
const getSafetyIcon = (status) => {
  if (status === 'approved') {
    return <CheckCircle size={16} color="#10b981" />;
  } else if (status === 'rejected') {
    return <XCircle size={16} color="#ef4444" />;
  } else if (status === 'modified') {
    return <AlertTriangle size={16} color="#fbbf24" />;
  }
  return null;
};

// Componente de tarjeta de estadísticas
const StatCard = ({ title, value, icon, color }) => {
  return (
    <div style={{
      backgroundColor: '#1a1d27',
      border: '1px solid #2a2d3a',
      borderRadius: '12px',
      padding: '20px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px'
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        fontSize: '13px',
        color: '#9ca3af'
      }}>
        {icon}
        {title}
      </div>
      <div style={{
        fontSize: '32px',
        fontWeight: '700',
        color: color || '#fff'
      }}>
        {value}
      </div>
    </div>
  );
};

// Componente de tarjeta de ciclo de decisión
const DecisionCycleCard = ({ cycle, isExpanded, onToggle, onAction }) => {
  const isStrategic = isStrategicCycle(cycle);

  // Determinar color del borde izquierdo
  let borderColor = isStrategic ? '#a855f7' : '#3b82f6'; // Morado para estrategico, azul por defecto
  if (cycle.has_critical_alerts) {
    borderColor = '#ef4444'; // Rojo para alertas críticas
  } else if (cycle.all_healthy && !isStrategic) {
    borderColor = '#10b981'; // Verde si todo está saludable
  }

  const actionCount = cycle.decisions?.length || 0;

  return (
    <div style={{
      backgroundColor: '#1a1d27',
      border: '1px solid #2a2d3a',
      borderLeft: `4px solid ${borderColor}`,
      borderRadius: '12px',
      overflow: 'hidden',
      marginBottom: '16px'
    }}>
      {/* Header - clickeable */}
      <div
        onClick={onToggle}
        style={{
          padding: '20px',
          cursor: 'pointer',
          transition: 'background-color 0.2s',
          ':hover': { backgroundColor: '#1f2937' }
        }}
      >
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '12px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {isExpanded ? (
              <ChevronDown size={20} color="#9ca3af" />
            ) : (
              <ChevronRight size={20} color="#9ca3af" />
            )}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              color: '#6b7280',
              fontSize: '13px'
            }}>
              <Clock size={16} />
              {formatTimestamp(cycle.timestamp || cycle.created_at)}
            </div>
            {isStrategic && (
              <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                padding: '3px 10px',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: '700',
                backgroundColor: '#581c87',
                color: '#c084fc',
                letterSpacing: '0.03em'
              }}>
                <Brain size={12} />
                IA ESTRATEGICA
              </div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {/* Badge de acciones */}
            <div style={{
              padding: '4px 10px',
              borderRadius: '6px',
              fontSize: '12px',
              fontWeight: '600',
              backgroundColor: isStrategic ? '#581c87' : '#1e3a8a',
              color: isStrategic ? '#c084fc' : '#60a5fa'
            }}>
              {actionCount} {actionCount === 1 ? 'acción' : 'acciones'}
            </div>

          </div>
        </div>

        {/* Resumen del análisis */}
        <div style={{
          fontSize: '14px',
          color: '#e5e7eb',
          marginBottom: '12px',
          lineHeight: '1.5',
          marginLeft: '32px'
        }}>
          {cycle.analysis_summary || 'Sin resumen de análisis disponible.'}
        </div>

        {/* ROAS de la cuenta */}
        {cycle.account_roas !== null && cycle.account_roas !== undefined && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginLeft: '32px'
          }}>
            <div style={{ fontSize: '13px', color: '#9ca3af' }}>
              ROAS de la cuenta:
            </div>
            <div style={{
              fontSize: '14px',
              fontWeight: '600',
              color: cycle.account_roas >= 3 ? '#10b981' :
                     cycle.account_roas >= 1.5 ? '#fbbf24' : '#ef4444'
            }}>
              {cycle.account_roas.toFixed(2)}x
            </div>
          </div>
        )}
      </div>

      {/* Contenido expandido - tabla de decisiones */}
      {isExpanded && cycle.decisions && cycle.decisions.length > 0 && (
        <div style={{
          borderTop: '1px solid #2a2d3a',
          padding: '20px',
          backgroundColor: '#16181f'
        }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{
              width: '100%',
              borderCollapse: 'collapse'
            }}>
              <thead>
                <tr>
                  <th style={tableHeaderStyle}>Entidad</th>
                  <th style={tableHeaderStyle}>Acción</th>
                  <th style={tableHeaderStyle}>Cambio</th>
                  <th style={tableHeaderStyle}>Confianza</th>
                  <th style={tableHeaderStyle}>Estado</th>
                  <th style={tableHeaderStyle}>Razonamiento</th>
                  <th style={tableHeaderStyle}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {cycle.decisions.map((decision, idx) => {
                  const actionBadge = getActionBadge(decision.action);
                  const confidenceBadge = getConfidenceBadge(decision.confidence);
                  const status = decision.recommendation_status || 'pending';
                  const statusBadge = getStatusBadge(status);
                  const cycleDocId = cycle._id || cycle.id;
                  const itemId = decision._id;

                  return (
                    <tr key={idx}>
                      {/* Nombre de la entidad */}
                      <td style={tableCellStyle}>
                        <div style={{
                          maxWidth: '200px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}>
                          {decision.entity_name || decision.entity_id || 'Desconocido'}
                        </div>
                      </td>

                      {/* Acción */}
                      <td style={tableCellStyle}>
                        <div style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '4px 10px',
                          borderRadius: '6px',
                          fontSize: '12px',
                          fontWeight: '600',
                          backgroundColor: actionBadge.bg,
                          color: actionBadge.color
                        }}>
                          {actionBadge.label}
                        </div>
                      </td>

                      {/* Cambio de presupuesto */}
                      <td style={tableCellStyle}>
                        {decision.current_value && decision.new_value &&
                         decision.action !== 'pause' && decision.action !== 'reactivate' ? (
                          <div style={{ fontSize: '13px' }}>
                            <div style={{ color: '#9ca3af' }}>
                              {formatCurrency(decision.current_value)}
                              {' → '}
                              <span style={{ color: '#e5e7eb', fontWeight: '600' }}>
                                {formatCurrency(decision.new_value)}
                              </span>
                            </div>
                            {decision.change_percent != null && (
                              <div style={{
                                color: decision.change_percent > 0 ? '#10b981' : '#ef4444',
                                fontSize: '12px',
                                marginTop: '2px'
                              }}>
                                {decision.change_percent > 0 ? '+' : ''}
                                {Number(decision.change_percent).toFixed(1)}%
                              </div>
                            )}
                          </div>
                        ) : (
                          <span style={{ color: '#6b7280', fontSize: '13px' }}>
                            {decision.action === 'pause' ? 'ACTIVE → PAUSED' :
                             decision.action === 'reactivate' ? 'PAUSED → ACTIVE' : '—'}
                          </span>
                        )}
                      </td>

                      {/* Confianza */}
                      <td style={tableCellStyle}>
                        <div style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          padding: '4px 10px',
                          borderRadius: '6px',
                          fontSize: '12px',
                          fontWeight: '600',
                          backgroundColor: confidenceBadge.bg,
                          color: confidenceBadge.color
                        }}>
                          {confidenceBadge.label}
                        </div>
                      </td>

                      {/* Estado */}
                      <td style={tableCellStyle}>
                        <div style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          padding: '4px 10px',
                          borderRadius: '6px',
                          fontSize: '12px',
                          fontWeight: '600',
                          backgroundColor: statusBadge.bg,
                          color: statusBadge.color
                        }}>
                          {statusBadge.label}
                        </div>
                      </td>

                      {/* Razonamiento */}
                      <td style={tableCellStyle}>
                        <div style={{
                          maxWidth: '300px',
                          fontSize: '13px',
                          color: '#9ca3af',
                          lineHeight: '1.4'
                        }}>
                          {decision.reasoning || 'Sin razonamiento proporcionado'}
                        </div>
                      </td>

                      {/* Botones de accion */}
                      <td style={tableCellStyle}>
                        {decision.action !== 'no_action' && (
                          <div style={{ display: 'flex', gap: '6px', flexWrap: 'nowrap' }}>
                            {status === 'pending' && (
                              <>
                                <button
                                  onClick={(e) => { e.stopPropagation(); onAction && onAction('approve', cycleDocId, itemId); }}
                                  style={{
                                    padding: '5px 10px', borderRadius: '6px', border: 'none',
                                    fontSize: '11px', fontWeight: '600', cursor: 'pointer',
                                    backgroundColor: '#065f46', color: '#10b981'
                                  }}
                                >
                                  Aprobar
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); onAction && onAction('reject', cycleDocId, itemId); }}
                                  style={{
                                    padding: '5px 10px', borderRadius: '6px', border: 'none',
                                    fontSize: '11px', fontWeight: '600', cursor: 'pointer',
                                    backgroundColor: '#7f1d1d', color: '#ef4444'
                                  }}
                                >
                                  Rechazar
                                </button>
                              </>
                            )}
                            {status === 'approved' && (
                              <button
                                onClick={(e) => { e.stopPropagation(); onAction && onAction('execute', cycleDocId, itemId); }}
                                style={{
                                  padding: '5px 10px', borderRadius: '6px', border: 'none',
                                  fontSize: '11px', fontWeight: '600', cursor: 'pointer',
                                  backgroundColor: '#1e3a8a', color: '#60a5fa'
                                }}
                              >
                                Ejecutar
                              </button>
                            )}
                            {status === 'executed' && (
                              <CheckCircle size={16} color="#10b981" />
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

const tableHeaderStyle = {
  textAlign: 'left',
  padding: '12px 16px',
  fontSize: '12px',
  fontWeight: '600',
  color: '#9ca3af',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  borderBottom: '1px solid #2a2d3a'
};

const tableCellStyle = {
  padding: '16px',
  fontSize: '14px',
  color: '#e5e7eb',
  borderBottom: '1px solid #2a2d3a'
};

// Componente principal
const Decisions = () => {
  const [stats, setStats] = useState(null);
  const [decisions, setDecisions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [expandedCycles, setExpandedCycles] = useState(new Set());
  const [actionLoading, setActionLoading] = useState(null);
  const limit = 20;

  // Manejar approve/reject/execute de un decision item
  const handleAction = async (actionType, decisionId, itemId) => {
    if (!decisionId || !itemId) return;
    setActionLoading(`${decisionId}_${itemId}_${actionType}`);
    try {
      if (actionType === 'approve') {
        await approveDecisionRecommendation(decisionId, itemId);
      } else if (actionType === 'reject') {
        await rejectDecisionRecommendation(decisionId, itemId);
      } else if (actionType === 'execute') {
        await executeDecisionRecommendation(decisionId, itemId);
      }
      // Recargar datos despues de la accion
      await fetchData();
    } catch (err) {
      console.error(`Error en ${actionType}:`, err);
    } finally {
      setActionLoading(null);
    }
  };

  // Cargar datos
  const fetchData = async () => {
    try {
      setLoading(true);

      const [statsData, decisionsData] = await Promise.all([
        getDecisionStats().catch(() => null),
        getDecisions(page, limit).catch(() => ({ decisions: [], total: 0, page: 1, total_pages: 1 }))
      ]);

      if (statsData) {
        setStats(statsData);
      }

      if (decisionsData) {
        setDecisions(decisionsData.decisions || []);
        setTotalPages(decisionsData.total_pages || decisionsData.pages || 1);
      }
    } catch (error) {
      console.error('Error al cargar decisiones:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [page]);

  // Toggle expansión de ciclo
  const toggleCycle = (cycleId) => {
    setExpandedCycles(prev => {
      const newSet = new Set(prev);
      if (newSet.has(cycleId)) {
        newSet.delete(cycleId);
      } else {
        newSet.add(cycleId);
      }
      return newSet;
    });
  };

  // Navegación de páginas
  const goToNextPage = () => {
    if (page < totalPages) {
      setPage(page + 1);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const goToPreviousPage = () => {
    if (page > 1) {
      setPage(page - 1);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  if (loading && !stats) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '60vh',
        color: '#9ca3af',
        fontSize: '16px',
        fontFamily: 'Inter, system-ui, sans-serif'
      }}>
        Cargando decisiones...
      </div>
    );
  }

  return (
    <div style={{
      fontFamily: 'Inter, system-ui, sans-serif',
      color: '#fff',
      backgroundColor: '#0f1117',
      minHeight: '100vh'
    }}>
      {/* Header */}
      <div style={{ marginBottom: '32px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
          <Brain size={32} color="#3b82f6" />
          <h1 style={{
            fontSize: '32px',
            fontWeight: '700',
            margin: 0,
            letterSpacing: '-0.02em'
          }}>
            Decisiones de la IA
          </h1>
        </div>
        <p style={{ color: '#9ca3af', fontSize: '14px', margin: 0 }}>
          Historial completo de análisis y decisiones del sistema autónomo
        </p>
      </div>

      {/* Stats Row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: '20px',
        marginBottom: '32px'
      }}>
        <StatCard
          title="Ciclos Hoy"
          value={formatNumber(stats?.cycles_today || stats?.total_cycles_today || 0)}
          icon={<Activity size={16} />}
          color="#3b82f6"
        />
        <StatCard
          title="Acciones Propuestas"
          value={formatNumber(stats?.actions_today || stats?.total_actions_today || 0)}
          icon={<Zap size={16} />}
          color="#10b981"
        />
        <StatCard
          title="Aprobadas"
          value={formatNumber(stats?.approved_today || 0)}
          icon={<CheckCircle size={16} />}
          color="#10b981"
        />
        <StatCard
          title="Ejecutadas"
          value={formatNumber(stats?.actions_week || stats?.executed_today || 0)}
          icon={<Target size={16} />}
          color="#fbbf24"
        />
      </div>

      {/* Decision List */}
      <div style={{ marginBottom: '32px' }}>
        {decisions.length === 0 ? (
          // Estado vacío
          <div style={{
            backgroundColor: '#1a1d27',
            border: '1px solid #2a2d3a',
            borderRadius: '12px',
            padding: '60px 40px',
            textAlign: 'center'
          }}>
            <Brain size={48} color="#3b82f6" style={{ margin: '0 auto 16px' }} />
            <div style={{
              fontSize: '18px',
              fontWeight: '600',
              color: '#e5e7eb',
              marginBottom: '8px'
            }}>
              La IA aún no ha tomado decisiones
            </div>
            <div style={{
              fontSize: '14px',
              color: '#9ca3af'
            }}>
              El primer ciclo de análisis comenzará pronto.
            </div>
          </div>
        ) : (
          // Lista de ciclos de decisión
          <>
            {decisions.map((cycle, idx) => {
              const cycleKey = cycle._id || cycle.id || idx;
              return (
                <DecisionCycleCard
                  key={cycleKey}
                  cycle={cycle}
                  isExpanded={expandedCycles.has(cycleKey)}
                  onToggle={() => toggleCycle(cycleKey)}
                  onAction={handleAction}
                />
              );
            })}
          </>
        )}
      </div>

      {/* Pagination */}
      {decisions.length > 0 && totalPages > 1 && (
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: '16px',
          paddingBottom: '32px'
        }}>
          <button
            onClick={goToPreviousPage}
            disabled={page === 1}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '10px 20px',
              backgroundColor: page === 1 ? '#1a1d27' : '#3b82f6',
              color: page === 1 ? '#6b7280' : '#fff',
              border: '1px solid #2a2d3a',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: '600',
              cursor: page === 1 ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s',
              opacity: page === 1 ? 0.5 : 1
            }}
          >
            <ChevronLeft size={16} />
            Anterior
          </button>

          <div style={{
            fontSize: '14px',
            color: '#9ca3af'
          }}>
            Página {page} de {totalPages}
          </div>

          <button
            onClick={goToNextPage}
            disabled={page === totalPages}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '10px 20px',
              backgroundColor: page === totalPages ? '#1a1d27' : '#3b82f6',
              color: page === totalPages ? '#6b7280' : '#fff',
              border: '1px solid #2a2d3a',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: '600',
              cursor: page === totalPages ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s',
              opacity: page === totalPages ? 0.5 : 1
            }}
          >
            Siguiente
            <ChevronRightIcon size={16} />
          </button>
        </div>
      )}
    </div>
  );
};

export default Decisions;
