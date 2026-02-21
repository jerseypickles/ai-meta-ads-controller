import React, { useState, useEffect } from 'react';
import {
  Activity,
  TrendingUp,
  TrendingDown,
  Pause,
  Play,
  CheckCircle,
  XCircle,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { getActions } from '../api';

// Formatear moneda
const formatCurrency = (value) => {
  if (value === null || value === undefined) return '$0.00';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
};

// Formatear fecha y hora
const formatDateTime = (dateString) => {
  if (!dateString) return '-';
  const date = new Date(dateString);
  const months = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const day = date.getDate();
  const month = months[date.getMonth()];
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${day} ${month} ${hours}:${minutes}`;
};

// Obtener configuración de acción (color, icono, texto)
const getActionConfig = (action, changePercent) => {
  const percent = changePercent ? Math.abs(changePercent) : 0;
  const percentText = percent > 0 ? `${percent > 0 ? '+' : ''}${percent}%` : '';

  switch (action) {
    case 'scale_up':
      return {
        text: `Escalar ${percentText}`,
        color: '#10b981',
        bg: '#064e3b',
        icon: <TrendingUp size={14} />
      };
    case 'scale_down':
      return {
        text: `Reducir ${percentText}`,
        color: '#fb923c',
        bg: '#7c2d12',
        icon: <TrendingDown size={14} />
      };
    case 'pause':
      return {
        text: 'Pausar',
        color: '#ef4444',
        bg: '#7f1d1d',
        icon: <Pause size={14} />
      };
    case 'reactivate':
      return {
        text: 'Reactivar',
        color: '#3b82f6',
        bg: '#1e3a8a',
        icon: <Play size={14} />
      };
    default:
      return {
        text: action || 'Desconocida',
        color: '#9ca3af',
        bg: '#374151',
        icon: null
      };
  }
};

// Obtener configuración de confianza
const getConfidenceConfig = (confidence) => {
  switch (confidence) {
    case 'alta':
    case 'high':
      return { text: 'Alta', color: '#10b981' };
    case 'media':
    case 'medium':
      return { text: 'Media', color: '#fbbf24' };
    case 'baja':
    case 'low':
      return { text: 'Baja', color: '#ef4444' };
    default:
      return { text: confidence || '-', color: '#9ca3af' };
  }
};

// Componente principal Actions
const Actions = () => {
  const [actions, setActions] = useState([]);
  const [filteredActions, setFilteredActions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionTypeFilter, setActionTypeFilter] = useState('Todas');
  const [successFilter, setSuccessFilter] = useState(false);
  const [expandedRow, setExpandedRow] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const itemsPerPage = 50;

  // Cargar acciones
  const fetchActions = async () => {
    try {
      setLoading(true);
      const data = await getActions(currentPage, itemsPerPage);

      // Manejar diferentes estructuras de respuesta
      if (data.actions) {
        setActions(data.actions || []);
        setTotalPages(Math.ceil((data.total || data.actions.length) / itemsPerPage));
      } else if (Array.isArray(data)) {
        setActions(data);
        setTotalPages(1);
      } else {
        setActions([]);
        setTotalPages(1);
      }
    } catch (error) {
      console.error('Error al cargar acciones:', error);
      setActions([]);
      setTotalPages(1);
    } finally {
      setLoading(false);
    }
  };

  // Cargar datos inicial y auto-refresh
  useEffect(() => {
    fetchActions();
    const interval = setInterval(fetchActions, 120000); // 2 minutos
    return () => clearInterval(interval);
  }, [currentPage]);

  // Filtrar acciones
  useEffect(() => {
    let filtered = [...actions];

    // Filtro por tipo de acción
    if (actionTypeFilter !== 'Todas') {
      const actionMap = {
        'Escalar': 'scale_up',
        'Reducir': 'scale_down',
        'Pausar': 'pause',
        'Reactivar': 'reactivate'
      };
      filtered = filtered.filter(a => a.action === actionMap[actionTypeFilter]);
    }

    // Filtro por éxito
    if (successFilter) {
      filtered = filtered.filter(a => a.success === true);
    }

    setFilteredActions(filtered);
  }, [actions, actionTypeFilter, successFilter]);

  // Manejar expansión de fila
  const handleRowClick = (actionId) => {
    setExpandedRow(expandedRow === actionId ? null : actionId);
  };

  // Truncar texto
  const truncateText = (text, maxLength = 60) => {
    if (!text) return '-';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  };

  if (loading && actions.length === 0) {
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
        Cargando acciones...
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
      {/* HEADER */}
      <div style={{
        marginBottom: '32px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <Activity size={32} color="#3b82f6" />
          <div>
            <h1 style={{
              fontSize: '32px',
              fontWeight: '700',
              marginBottom: '8px',
              letterSpacing: '-0.02em',
              margin: 0
            }}>
              Registro de Acciones
            </h1>
            <p style={{
              color: '#9ca3af',
              fontSize: '14px',
              margin: '8px 0 0 0'
            }}>
              {filteredActions.length} de {actions.length} acciones ejecutadas
            </p>
          </div>
        </div>
      </div>

      {/* FILTER ROW */}
      <div style={{
        marginBottom: '24px',
        display: 'flex',
        gap: '16px',
        alignItems: 'center',
        flexWrap: 'wrap'
      }}>
        {/* Filtro por tipo de acción */}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {['Todas', 'Escalar', 'Reducir', 'Pausar', 'Reactivar'].map(filter => (
            <button
              key={filter}
              onClick={() => setActionTypeFilter(filter)}
              style={{
                padding: '8px 16px',
                borderRadius: '20px',
                border: 'none',
                fontSize: '13px',
                fontWeight: '600',
                cursor: 'pointer',
                backgroundColor: actionTypeFilter === filter ? '#3b82f6' : '#1a1d27',
                color: actionTypeFilter === filter ? '#fff' : '#9ca3af',
                transition: 'all 0.2s',
                fontFamily: 'Inter, system-ui, sans-serif'
              }}
            >
              {filter}
            </button>
          ))}
        </div>

        {/* Filtro por éxito */}
        <button
          onClick={() => setSuccessFilter(!successFilter)}
          style={{
            padding: '8px 16px',
            borderRadius: '20px',
            border: 'none',
            fontSize: '13px',
            fontWeight: '600',
            cursor: 'pointer',
            backgroundColor: successFilter ? '#10b981' : '#1a1d27',
            color: successFilter ? '#fff' : '#9ca3af',
            transition: 'all 0.2s',
            fontFamily: 'Inter, system-ui, sans-serif'
          }}
        >
          {successFilter ? 'Solo exitosas' : 'Todas'}
        </button>
      </div>

      {/* TABLA PRINCIPAL */}
      <div style={{
        backgroundColor: '#1a1d27',
        border: '1px solid #2a2d3a',
        borderRadius: '12px',
        overflow: 'hidden',
        marginBottom: '24px'
      }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{
            width: '100%',
            borderCollapse: 'collapse'
          }}>
            <thead style={{
              position: 'sticky',
              top: 0,
              backgroundColor: '#1a1d27',
              zIndex: 10
            }}>
              <tr>
                <th style={{ ...tableHeaderStyle, width: '130px' }}>Fecha</th>
                <th style={{ ...tableHeaderStyle, minWidth: '180px' }}>Entidad</th>
                <th style={{ ...tableHeaderStyle, width: '140px' }}>Acción</th>
                <th style={{ ...tableHeaderStyle, width: '180px' }}>Antes → Después</th>
                <th style={{ ...tableHeaderStyle, width: '90px' }}>Confianza</th>
                <th style={{ ...tableHeaderStyle, width: '90px' }}>Resultado</th>
                <th style={{ ...tableHeaderStyle, width: '110px' }}>Modo</th>
                <th style={{ ...tableHeaderStyle, minWidth: '220px' }}>Razón</th>
              </tr>
            </thead>
            <tbody>
              {filteredActions.length === 0 ? (
                <tr>
                  <td
                    colSpan="8"
                    style={{
                      ...tableCellStyle,
                      textAlign: 'center',
                      color: '#6b7280',
                      padding: '48px'
                    }}
                  >
                    {actions.length === 0
                      ? 'No se han ejecutado acciones aún.'
                      : 'No se encontraron acciones con los filtros aplicados.'}
                  </td>
                </tr>
              ) : (
                filteredActions.map(action => {
                  const actionConfig = getActionConfig(action.action, action.change_percent);
                  const confidenceConfig = getConfidenceConfig(action.confidence);
                  const isExpanded = expandedRow === action.id;
                  const isFailed = action.success === false;

                  return (
                    <React.Fragment key={action.id}>
                      <tr
                        onClick={() => handleRowClick(action.id)}
                        style={{
                          cursor: 'pointer',
                          backgroundColor: isFailed
                            ? '#2d1515'
                            : isExpanded
                              ? '#1f2230'
                              : 'transparent'
                        }}
                        onMouseEnter={(e) => {
                          if (!isExpanded && !isFailed) {
                            e.currentTarget.style.backgroundColor = '#1f2230';
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (!isExpanded && !isFailed) {
                            e.currentTarget.style.backgroundColor = 'transparent';
                          } else if (isFailed && !isExpanded) {
                            e.currentTarget.style.backgroundColor = '#2d1515';
                          }
                        }}
                      >
                        {/* Fecha */}
                        <td style={tableCellStyle}>
                          <div style={{ fontSize: '13px', color: '#e5e7eb' }}>
                            {formatDateTime(action.executed_at)}
                          </div>
                        </td>

                        {/* Entidad */}
                        <td style={tableCellStyle}>
                          <div
                            style={{
                              maxWidth: '180px',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              fontWeight: '500'
                            }}
                            title={action.entity_name}
                          >
                            {action.entity_name || 'Sin nombre'}
                          </div>
                        </td>

                        {/* Acción */}
                        <td style={tableCellStyle}>
                          <span style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '4px 10px',
                            borderRadius: '12px',
                            fontSize: '12px',
                            fontWeight: '600',
                            backgroundColor: actionConfig.bg,
                            color: actionConfig.color
                          }}>
                            {actionConfig.icon}
                            {actionConfig.text}
                          </span>
                        </td>

                        {/* Antes → Después */}
                        <td style={tableCellStyle}>
                          {action.before_value !== null && action.after_value !== null ? (
                            <div style={{ fontSize: '13px' }}>
                              <span style={{ color: '#9ca3af' }}>
                                {formatCurrency(action.before_value)}
                              </span>
                              <span style={{ margin: '0 6px', color: '#6b7280' }}>→</span>
                              <span style={{ color: '#e5e7eb', fontWeight: '600' }}>
                                {formatCurrency(action.after_value)}
                              </span>
                            </div>
                          ) : (
                            <span style={{ color: '#6b7280', fontSize: '13px' }}>-</span>
                          )}
                        </td>

                        {/* Confianza */}
                        <td style={tableCellStyle}>
                          <span style={{
                            fontSize: '12px',
                            fontWeight: '600',
                            color: confidenceConfig.color
                          }}>
                            {confidenceConfig.text}
                          </span>
                        </td>

                        {/* Resultado */}
                        <td style={tableCellStyle}>
                          {action.success ? (
                            <div style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              color: '#10b981',
                              fontSize: '13px',
                              fontWeight: '600'
                            }}>
                              <CheckCircle size={16} />
                              Éxito
                            </div>
                          ) : (
                            <div style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              color: '#ef4444',
                              fontSize: '13px',
                              fontWeight: '600'
                            }}>
                              <XCircle size={16} />
                              Error
                            </div>
                          )}
                        </td>

                        {/* Modo */}
                        <td style={tableCellStyle}>
                          <span style={{
                            padding: '4px 10px',
                            borderRadius: '12px',
                            fontSize: '12px',
                            fontWeight: '600',
                            backgroundColor: '#1e3a8a',
                            color: '#60a5fa'
                          }}>
                            Ejecutado
                          </span>
                        </td>

                        {/* Razón */}
                        <td style={tableCellStyle}>
                          <div
                            style={{
                              fontSize: '13px',
                              color: '#9ca3af',
                              maxWidth: '220px',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap'
                            }}
                            title={action.reasoning}
                          >
                            {truncateText(action.reasoning, 60)}
                          </div>
                          {isExpanded ? (
                            <ChevronUp size={16} style={{ marginLeft: '8px', color: '#6b7280' }} />
                          ) : (
                            <ChevronDown size={16} style={{ marginLeft: '8px', color: '#6b7280' }} />
                          )}
                        </td>
                      </tr>

                      {/* FILA EXPANDIDA */}
                      {isExpanded && (
                        <tr>
                          <td
                            colSpan="8"
                            style={{
                              padding: '24px',
                              backgroundColor: '#16181f',
                              borderTop: '1px solid #2a2d3a'
                            }}
                          >
                            <div style={{
                              display: 'grid',
                              gridTemplateColumns: '1fr 1fr',
                              gap: '24px'
                            }}>
                              {/* Columna izquierda - Detalles completos */}
                              <div>
                                <h4 style={{
                                  fontSize: '14px',
                                  fontWeight: '600',
                                  color: '#9ca3af',
                                  marginBottom: '16px',
                                  marginTop: 0
                                }}>
                                  Detalles de la Acción
                                </h4>
                                <div style={{
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: '12px'
                                }}>
                                  <DetailRow label="ID de Acción" value={action.id} />
                                  <DetailRow label="Tipo de Entidad" value={action.entity_type || '-'} />
                                  <DetailRow label="ID de Entidad" value={action.entity_id || '-'} />
                                  <DetailRow label="ID de Ciclo" value={action.cycle_id || '-'} />

                                  <div style={{
                                    marginTop: '12px',
                                    paddingTop: '12px',
                                    borderTop: '1px solid #2a2d3a'
                                  }}>
                                    <div style={{
                                      fontSize: '12px',
                                      color: '#9ca3af',
                                      marginBottom: '8px',
                                      fontWeight: '600'
                                    }}>
                                      Razonamiento Completo
                                    </div>
                                    <div style={{
                                      fontSize: '13px',
                                      color: '#e5e7eb',
                                      lineHeight: '1.6',
                                      whiteSpace: 'pre-wrap'
                                    }}>
                                      {action.reasoning || 'Sin razonamiento proporcionado'}
                                    </div>
                                  </div>
                                </div>
                              </div>

                              {/* Columna derecha - Errores y respuesta */}
                              <div>
                                <h4 style={{
                                  fontSize: '14px',
                                  fontWeight: '600',
                                  color: '#9ca3af',
                                  marginBottom: '16px',
                                  marginTop: 0
                                }}>
                                  Respuesta del Sistema
                                </h4>

                                {/* Error message si existe */}
                                {!action.success && action.error_message && (
                                  <div style={{
                                    padding: '12px',
                                    backgroundColor: '#2d1515',
                                    border: '1px solid #7f1d1d',
                                    borderRadius: '8px',
                                    marginBottom: '16px'
                                  }}>
                                    <div style={{
                                      fontSize: '12px',
                                      color: '#ef4444',
                                      fontWeight: '600',
                                      marginBottom: '6px'
                                    }}>
                                      Mensaje de Error
                                    </div>
                                    <div style={{
                                      fontSize: '13px',
                                      color: '#fca5a5',
                                      lineHeight: '1.5'
                                    }}>
                                      {action.error_message}
                                    </div>
                                  </div>
                                )}

                                {/* Respuesta de Meta API */}
                                {action.meta_response && (
                                  <div>
                                    <div style={{
                                      fontSize: '12px',
                                      color: '#9ca3af',
                                      marginBottom: '8px',
                                      fontWeight: '600'
                                    }}>
                                      Respuesta de Meta API
                                    </div>
                                    <div style={{
                                      fontSize: '12px',
                                      color: '#e5e7eb',
                                      backgroundColor: '#0f1117',
                                      padding: '12px',
                                      borderRadius: '6px',
                                      fontFamily: 'monospace',
                                      overflow: 'auto',
                                      maxHeight: '200px',
                                      border: '1px solid #2a2d3a'
                                    }}>
                                      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>
                                        {typeof action.meta_response === 'object'
                                          ? JSON.stringify(action.meta_response, null, 2)
                                          : action.meta_response}
                                      </pre>
                                    </div>
                                  </div>
                                )}

                                {/* Estado de éxito adicional */}
                                {action.success && !action.meta_response && (
                                  <div style={{
                                    padding: '12px',
                                    backgroundColor: '#064e3b',
                                    border: '1px solid #065f46',
                                    borderRadius: '8px',
                                    fontSize: '13px',
                                    color: '#6ee7b7'
                                  }}>
                                    Acción ejecutada exitosamente sin respuesta adicional de la API.
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* PAGINACIÓN */}
      {totalPages > 1 && (
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: '12px',
          marginTop: '24px'
        }}>
          <button
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              border: '1px solid #2a2d3a',
              backgroundColor: currentPage === 1 ? '#1a1d27' : '#3b82f6',
              color: currentPage === 1 ? '#6b7280' : '#fff',
              fontSize: '14px',
              fontWeight: '600',
              cursor: currentPage === 1 ? 'not-allowed' : 'pointer',
              fontFamily: 'Inter, system-ui, sans-serif'
            }}
          >
            Anterior
          </button>

          <span style={{
            fontSize: '14px',
            color: '#9ca3af'
          }}>
            Página {currentPage} de {totalPages}
          </span>

          <button
            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              border: '1px solid #2a2d3a',
              backgroundColor: currentPage === totalPages ? '#1a1d27' : '#3b82f6',
              color: currentPage === totalPages ? '#6b7280' : '#fff',
              fontSize: '14px',
              fontWeight: '600',
              cursor: currentPage === totalPages ? 'not-allowed' : 'pointer',
              fontFamily: 'Inter, system-ui, sans-serif'
            }}
          >
            Siguiente
          </button>
        </div>
      )}
    </div>
  );
};

// Componente DetailRow
const DetailRow = ({ label, value }) => (
  <div style={{
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center'
  }}>
    <span style={{
      fontSize: '13px',
      color: '#9ca3af'
    }}>
      {label}
    </span>
    <span style={{
      fontSize: '13px',
      color: '#e5e7eb',
      fontWeight: '600',
      fontFamily: 'monospace'
    }}>
      {value || '-'}
    </span>
  </div>
);

// Estilos de tabla
const tableHeaderStyle = {
  textAlign: 'left',
  padding: '16px',
  fontSize: '12px',
  fontWeight: '600',
  color: '#9ca3af',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  borderBottom: '2px solid #2a2d3a',
  backgroundColor: '#1a1d27'
};

const tableCellStyle = {
  padding: '16px',
  fontSize: '14px',
  color: '#e5e7eb',
  borderBottom: '1px solid #2a2d3a'
};

export default Actions;
