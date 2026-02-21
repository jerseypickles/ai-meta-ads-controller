import React, { useState, useEffect } from 'react';
import {
  TrendingUp,
  TrendingDown,
  Minus,
  DollarSign,
  Target,
  Activity,
  Zap,
  ShieldCheck,
  ShieldAlert,
  Brain,
  Radio,
  Clock,
  BarChart3,
  CircleDollarSign
} from 'lucide-react';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Area,
  AreaChart
} from 'recharts';
import { getOverview, getTopPerformers, getDecisionStats, getAdSets, getOverviewHistory, getControlsStatus } from '../api';

// ═══ FORMATTERS ═══

const formatCurrency = (value) => {
  if (value === null || value === undefined) return '$0';
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(value);
};

const formatNumber = (value) => {
  if (value === null || value === undefined) return '0';
  return new Intl.NumberFormat('es-CL').format(value);
};

const formatTime = (date) => {
  if (!date) return '--:--';
  const d = new Date(date);
  return d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
};

// ═══ COMPONENTES ═══

// Barra de estado del sistema
const StatusBar = ({ controls, lastUpdate }) => {
  const aiEnabled = controls?.ai_enabled ?? false;
  const killSwitch = controls?.kill_switch_active ?? false;
  const mode = controls?.decision_engine_mode || 'unknown';

  const modeLabels = {
    'unified_live': 'Auto',
    'unified_shadow': 'Shadow',
    'manual': 'Manual'
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '16px',
      padding: '12px 20px',
      backgroundColor: '#1a1d27',
      border: '1px solid #2a2d3a',
      borderRadius: '10px',
      marginBottom: '24px',
      flexWrap: 'wrap'
    }}>
      {/* IA Status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Brain size={16} color={aiEnabled ? '#10b981' : '#6b7280'} />
        <span style={{
          fontSize: '13px',
          fontWeight: '600',
          color: aiEnabled ? '#10b981' : '#6b7280'
        }}>
          IA {aiEnabled ? 'Activa' : 'Inactiva'}
        </span>
        <span style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          backgroundColor: aiEnabled ? '#10b981' : '#6b7280',
          animation: aiEnabled ? 'pulse 2s ease-in-out infinite' : 'none'
        }} />
      </div>

      <div style={{ width: '1px', height: '20px', backgroundColor: '#2a2d3a' }} />

      {/* Kill Switch */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {killSwitch
          ? <ShieldAlert size={16} color="#ef4444" />
          : <ShieldCheck size={16} color="#10b981" />
        }
        <span style={{
          fontSize: '13px',
          fontWeight: '600',
          color: killSwitch ? '#ef4444' : '#9ca3af'
        }}>
          Kill Switch {killSwitch ? 'ACTIVO' : 'OK'}
        </span>
      </div>

      <div style={{ width: '1px', height: '20px', backgroundColor: '#2a2d3a' }} />

      {/* Modo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Radio size={16} color="#3b82f6" />
        <span style={{ fontSize: '13px', color: '#9ca3af' }}>Modo:</span>
        <span style={{
          fontSize: '12px',
          fontWeight: '600',
          padding: '2px 10px',
          borderRadius: '4px',
          backgroundColor: mode === 'unified_live' ? '#065f46' : '#1e3a5f',
          color: mode === 'unified_live' ? '#6ee7b7' : '#93c5fd'
        }}>
          {modeLabels[mode] || mode}
        </span>
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Última actualización */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Clock size={14} color="#6b7280" />
        <span style={{ fontSize: '12px', color: '#6b7280' }}>
          Actualizado: {formatTime(lastUpdate)}
        </span>
      </div>
    </div>
  );
};

// Tarjeta KPI mejorada
const KPICard = ({ icon, title, value, subtitle, indicator, pacingBar }) => {
  return (
    <div style={{
      backgroundColor: '#1a1d27',
      border: '1px solid #2a2d3a',
      borderRadius: '12px',
      padding: '20px',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      transition: 'border-color 0.2s, box-shadow 0.2s',
      cursor: 'default'
    }}
    onMouseEnter={e => {
      e.currentTarget.style.borderColor = '#3b4a6b';
      e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
    }}
    onMouseLeave={e => {
      e.currentTarget.style.borderColor = '#2a2d3a';
      e.currentTarget.style.boxShadow = 'none';
    }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        <span style={{
          fontSize: '13px',
          color: '#9ca3af',
          fontWeight: '500',
          letterSpacing: '0.02em'
        }}>
          {title}
        </span>
        {icon && (
          <div style={{
            width: '32px',
            height: '32px',
            borderRadius: '8px',
            backgroundColor: '#242838',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            {icon}
          </div>
        )}
      </div>

      <div style={{
        fontSize: '28px',
        fontWeight: '700',
        color: '#fff',
        letterSpacing: '-0.02em',
        lineHeight: 1
      }}>
        {value}
      </div>

      {subtitle && (
        <div style={{
          fontSize: '12px',
          color: '#6b7280',
          display: 'flex',
          alignItems: 'center',
          gap: '6px'
        }}>
          {subtitle}
        </div>
      )}

      {indicator && (
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          padding: '4px 10px',
          borderRadius: '6px',
          fontSize: '12px',
          fontWeight: '600',
          backgroundColor: indicator.color === 'green' ? '#065f46' :
                          indicator.color === 'yellow' ? '#78350f' : '#7f1d1d',
          color: indicator.color === 'green' ? '#6ee7b7' :
                indicator.color === 'yellow' ? '#fcd34d' : '#fca5a5',
          alignSelf: 'flex-start'
        }}>
          {indicator.icon}
          {indicator.label}
        </div>
      )}

      {pacingBar && (
        <div>
          <div style={{
            fontSize: '12px',
            color: '#6b7280',
            marginBottom: '6px'
          }}>
            Ritmo: {pacingBar.percentage}%
          </div>
          <div style={{
            width: '100%',
            height: '6px',
            backgroundColor: '#2a2d3a',
            borderRadius: '3px',
            overflow: 'hidden'
          }}>
            <div style={{
              width: `${Math.min(pacingBar.percentage, 100)}%`,
              height: '100%',
              backgroundColor: pacingBar.percentage > 120 ? '#ef4444' :
                              pacingBar.percentage > 80 ? '#3b82f6' : '#10b981',
              transition: 'width 0.3s ease',
              borderRadius: '3px'
            }} />
          </div>
        </div>
      )}
    </div>
  );
};

// Tabla de performance mejorada
const PerformanceTable = ({ title, data, loading, variant }) => {
  const isBottom = variant === 'bottom';

  const getTrendIcon = (trend) => {
    if (!trend || trend === 'flat' || trend === 'stable') return <Minus size={16} color="#6b7280" />;
    if (trend === 'up' || trend === 'improving') return <TrendingUp size={16} color="#10b981" />;
    return <TrendingDown size={16} color="#ef4444" />;
  };

  return (
    <div style={{
      backgroundColor: '#1a1d27',
      border: `1px solid ${isBottom ? '#3b1c1c' : '#2a2d3a'}`,
      borderRadius: '12px',
      padding: '20px',
      display: 'flex',
      flexDirection: 'column',
      gap: '16px'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <h3 style={{
          fontSize: '15px',
          fontWeight: '600',
          color: '#fff',
          margin: 0
        }}>
          {title}
        </h3>
        <span style={{
          fontSize: '11px',
          fontWeight: '700',
          padding: '2px 8px',
          borderRadius: '4px',
          backgroundColor: isBottom ? '#7f1d1d' : '#065f46',
          color: isBottom ? '#fca5a5' : '#6ee7b7',
          textTransform: 'uppercase',
          letterSpacing: '0.05em'
        }}>
          {isBottom ? 'Bajo' : 'Top'}
        </span>
      </div>

      {loading ? (
        <div style={{ color: '#6b7280', fontSize: '14px' }}>Cargando...</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={tableHeaderStyle}>Nombre</th>
                <th style={tableHeaderStyle}>ROAS 7d</th>
                <th style={tableHeaderStyle}>Gasto 7d</th>
                <th style={tableHeaderStyle}>CPA</th>
                <th style={{ ...tableHeaderStyle, textAlign: 'center' }}>Trend</th>
              </tr>
            </thead>
            <tbody>
              {data && data.length > 0 ? (
                data.map((item, index) => (
                  <tr key={index}>
                    <td style={tableCellStyle}>
                      {item.name
                        ? (item.name.length > 25 ? item.name.substring(0, 25) + '...' : item.name)
                        : 'Sin nombre'}
                    </td>
                    <td style={tableCellStyle}>
                      <span style={{
                        color: item.roas_7d > 3 ? '#10b981' :
                              item.roas_7d > 1.5 ? '#fcd34d' : '#ef4444',
                        fontWeight: '600'
                      }}>
                        {item.roas_7d ? item.roas_7d.toFixed(2) + 'x' : 'N/A'}
                      </span>
                    </td>
                    <td style={tableCellStyle}>{formatCurrency(item.spend_7d)}</td>
                    <td style={tableCellStyle}>{formatCurrency(item.cpa)}</td>
                    <td style={{ ...tableCellStyle, textAlign: 'center' }}>
                      {getTrendIcon(item.trend)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="5" style={{ ...tableCellStyle, textAlign: 'center', color: '#6b7280' }}>
                    No hay datos disponibles
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

const tableHeaderStyle = {
  textAlign: 'left',
  padding: '10px 14px',
  fontSize: '11px',
  fontWeight: '600',
  color: '#9ca3af',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  borderBottom: '1px solid #2a2d3a'
};

const tableCellStyle = {
  padding: '12px 14px',
  fontSize: '13px',
  color: '#e5e7eb',
  borderBottom: '1px solid #2a2d3a'
};

// ═══ COMPONENTE PRINCIPAL ═══

const Dashboard = () => {
  const [overview, setOverview] = useState(null);
  const [topPerformers, setTopPerformers] = useState([]);
  const [bottomPerformers, setBottomPerformers] = useState([]);
  const [aiStats, setAiStats] = useState(null);
  const [adSetsData, setAdSetsData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [chartData, setChartData] = useState([]);
  const [spendData, setSpendData] = useState([]);
  const [controls, setControls] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);

  const fetchData = async () => {
    try {
      setLoading(true);

      const [overviewData, performersData, statsData, adsetsData, historyData, controlsData] = await Promise.all([
        getOverview().catch(() => null),
        getTopPerformers({ limit: 10 }).catch(() => []),
        getDecisionStats().catch(() => null),
        getAdSets().catch(() => []),
        getOverviewHistory(7).catch(() => []),
        getControlsStatus().catch(() => null)
      ]);

      if (overviewData) setOverview(overviewData);
      if (controlsData) setControls(controlsData);
      setLastUpdate(new Date());

      // Procesar performers
      if (performersData && performersData.length > 0) {
        const sorted = [...performersData].sort((a, b) =>
          (b.metrics?.roas_7d || 0) - (a.metrics?.roas_7d || 0)
        );

        const mapItem = (item) => ({
          name: item.name,
          roas_7d: item.metrics?.roas_7d || 0,
          spend_7d: item.metrics?.spend_7d || 0,
          cpa: item.metrics?.cpa || 0,
          trend: item.metrics?.trend || 'flat'
        });

        setTopPerformers(sorted.slice(0, 5).map(mapItem));
        setBottomPerformers(sorted.slice(-5).reverse().map(mapItem));

        // Datos para gráfico de gasto (Top 5 por gasto)
        const bySpend = [...performersData]
          .sort((a, b) => (b.metrics?.spend_7d || 0) - (a.metrics?.spend_7d || 0))
          .slice(0, 5);
        setSpendData(bySpend.map(item => ({
          name: item.name.length > 20 ? item.name.substring(0, 20) + '...' : item.name,
          gasto: item.metrics?.spend_7d || 0
        })));
      }

      if (statsData) setAiStats(statsData);
      if (adsetsData) setAdSetsData(adsetsData);

      // Datos del gráfico de tendencia — reales del backend
      if (historyData && historyData.length > 0) {
        setChartData(historyData.map(d => ({
          date: new Date(d.date).toLocaleDateString('es-CL', { month: 'short', day: 'numeric' }),
          roas_7d: d.roas_7d,
          roas_3d: d.roas_3d
        })));
      }

    } catch (error) {
      console.error('Error al cargar datos del dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, []);

  // Métricas KPI
  const spendToday = overview?.spend_today || 0;
  const dailyBudget = overview?.daily_budget || 1000000;
  const pacingPercentage = dailyBudget > 0 ? (spendToday / dailyBudget * 100) : 0;
  const revenueToday = overview?.today_revenue || 0;
  const roasToday = overview?.today_roas || 0;
  const roas7d = overview?.roas_7d || 0;
  const roas3d = overview?.roas_3d || 0;
  const activeAdSets = adSetsData.filter(as => as.status === 'ACTIVE').length;
  const pausedAdSets = adSetsData.filter(as => as.status === 'PAUSED').length;

  const getRoasIndicator = (roas) => {
    if (roas >= 3) return { color: 'green', icon: <TrendingUp size={14} />, label: 'Excelente' };
    if (roas >= 1.5) return { color: 'yellow', icon: <Minus size={14} />, label: 'Bueno' };
    return { color: 'red', icon: <TrendingDown size={14} />, label: 'Bajo' };
  };

  // Stats IA
  const cyclesTotal = aiStats?.cycles_today || 0;
  const actionsToday = aiStats?.actions_today || 0;
  const actionsWeek = aiStats?.actions_week || 0;
  const successRate = aiStats?.success_rate || 0;

  if (loading && !overview) {
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
        Cargando datos del dashboard...
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
      {/* Encabezado */}
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{
          fontSize: '28px',
          fontWeight: '700',
          marginBottom: '6px',
          letterSpacing: '-0.02em'
        }}>
          Resumen General
        </h1>
        <p style={{ color: '#9ca3af', fontSize: '14px', margin: 0 }}>
          Vista general de rendimiento, métricas clave y estado del sistema
        </p>
      </div>

      {/* ROW 0: Barra de estado */}
      <StatusBar controls={controls} lastUpdate={lastUpdate} />

      {/* ROW 1: KPIs principales — 6 cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(6, 1fr)',
        gap: '16px',
        marginBottom: '24px'
      }}>
        <KPICard
          icon={<DollarSign size={16} color="#3b82f6" />}
          title="Gasto Hoy"
          value={formatCurrency(spendToday)}
          pacingBar={{ percentage: pacingPercentage.toFixed(1) }}
        />
        <KPICard
          icon={<CircleDollarSign size={16} color="#10b981" />}
          title="Revenue Hoy"
          value={formatCurrency(revenueToday)}
          subtitle={revenueToday > spendToday ? 'Rentable' : 'Bajo costo'}
        />
        <KPICard
          icon={<BarChart3 size={16} color="#f59e0b" />}
          title="ROAS Hoy"
          value={roasToday > 0 ? roasToday.toFixed(2) + 'x' : 'N/A'}
          indicator={roasToday > 0 ? getRoasIndicator(roasToday) : undefined}
        />
        <KPICard
          icon={<TrendingUp size={16} color="#3b82f6" />}
          title="ROAS 7d"
          value={roas7d.toFixed(2) + 'x'}
          indicator={getRoasIndicator(roas7d)}
        />
        <KPICard
          icon={<TrendingUp size={16} color="#06b6d4" />}
          title="ROAS 3d"
          value={roas3d.toFixed(2) + 'x'}
          indicator={getRoasIndicator(roas3d)}
        />
        <KPICard
          icon={<Target size={16} color="#8b5cf6" />}
          title="Ad Sets Activos"
          value={activeAdSets.toString()}
          subtitle={`${pausedAdSets} pausados`}
        />
      </div>

      {/* ROW 2: Gráficos */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '20px',
        marginBottom: '24px'
      }}>
        {/* Tendencia ROAS — datos reales */}
        <div style={{
          backgroundColor: '#1a1d27',
          border: '1px solid #2a2d3a',
          borderRadius: '12px',
          padding: '20px'
        }}>
          <h3 style={{
            fontSize: '15px',
            fontWeight: '600',
            color: '#fff',
            marginBottom: '16px',
            marginTop: 0
          }}>
            Tendencia ROAS (7 días)
          </h3>

          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="gradRoas7d" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradRoas3d" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3a" />
                <XAxis dataKey="date" stroke="#6b7280" style={{ fontSize: '12px' }} />
                <YAxis stroke="#6b7280" style={{ fontSize: '12px' }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1a1d27',
                    border: '1px solid #2a2d3a',
                    borderRadius: '8px',
                    color: '#fff',
                    fontSize: '13px'
                  }}
                  formatter={(value) => value + 'x'}
                />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                <Area
                  type="monotone"
                  dataKey="roas_7d"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  fill="url(#gradRoas7d)"
                  dot={{ fill: '#3b82f6', r: 3 }}
                  name="ROAS 7d"
                />
                <Area
                  type="monotone"
                  dataKey="roas_3d"
                  stroke="#06b6d4"
                  strokeWidth={2}
                  fill="url(#gradRoas3d)"
                  dot={{ fill: '#06b6d4', r: 3 }}
                  name="ROAS 3d"
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div style={{
              height: '260px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#6b7280',
              fontSize: '14px'
            }}>
              Sin datos históricos disponibles
            </div>
          )}
        </div>

        {/* Distribución de Gasto */}
        <div style={{
          backgroundColor: '#1a1d27',
          border: '1px solid #2a2d3a',
          borderRadius: '12px',
          padding: '20px'
        }}>
          <h3 style={{
            fontSize: '15px',
            fontWeight: '600',
            color: '#fff',
            marginBottom: '16px',
            marginTop: 0
          }}>
            Top 5 — Gasto 7d
          </h3>

          {spendData.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={spendData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3a" />
                <XAxis
                  type="number"
                  stroke="#6b7280"
                  style={{ fontSize: '11px' }}
                  tickFormatter={(value) => formatCurrency(value)}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  stroke="#6b7280"
                  style={{ fontSize: '11px' }}
                  width={120}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1a1d27',
                    border: '1px solid #2a2d3a',
                    borderRadius: '8px',
                    color: '#fff',
                    fontSize: '13px'
                  }}
                  formatter={(value) => formatCurrency(value)}
                />
                <Bar dataKey="gasto" fill="#3b82f6" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div style={{
              height: '260px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#6b7280',
              fontSize: '14px'
            }}>
              Sin datos de gasto disponibles
            </div>
          )}
        </div>
      </div>

      {/* ROW 3: Tablas de performance */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '20px',
        marginBottom: '24px'
      }}>
        <PerformanceTable
          title="Mejores Ad Sets"
          data={topPerformers}
          loading={loading}
          variant="top"
        />
        <PerformanceTable
          title="Peores Ad Sets"
          data={bottomPerformers}
          loading={loading}
          variant="bottom"
        />
      </div>

      {/* ROW 4: Actividad de la IA — 2 columnas */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '20px'
      }}>
        {/* Columna izquierda: Stats */}
        <div style={{
          backgroundColor: '#1a1d27',
          border: '1px solid #2a2d3a',
          borderRadius: '12px',
          padding: '20px'
        }}>
          <h3 style={{
            fontSize: '15px',
            fontWeight: '600',
            color: '#fff',
            marginBottom: '20px',
            marginTop: 0,
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}>
            <Brain size={18} color="#3b82f6" />
            Actividad IA
          </h3>

          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '16px'
          }}>
            <div style={{
              backgroundColor: '#242838',
              borderRadius: '10px',
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#9ca3af', fontSize: '12px' }}>
                <Activity size={14} />
                Ciclos Hoy
              </div>
              <div style={{ fontSize: '24px', fontWeight: '700', color: '#3b82f6' }}>
                {formatNumber(cyclesTotal)}
              </div>
            </div>

            <div style={{
              backgroundColor: '#242838',
              borderRadius: '10px',
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#9ca3af', fontSize: '12px' }}>
                <Zap size={14} />
                Acciones Hoy
              </div>
              <div style={{ fontSize: '24px', fontWeight: '700', color: '#10b981' }}>
                {formatNumber(actionsToday)}
              </div>
            </div>

            <div style={{
              backgroundColor: '#242838',
              borderRadius: '10px',
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#9ca3af', fontSize: '12px' }}>
                <Zap size={14} />
                Acciones Semana
              </div>
              <div style={{ fontSize: '24px', fontWeight: '700', color: '#06b6d4' }}>
                {formatNumber(actionsWeek)}
              </div>
            </div>

            <div style={{
              backgroundColor: '#242838',
              borderRadius: '10px',
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#9ca3af', fontSize: '12px' }}>
                <Target size={14} />
                Tasa de Éxito
              </div>
              <div style={{ fontSize: '24px', fontWeight: '700', color: '#fbbf24' }}>
                {successRate > 0 ? `${successRate.toFixed(1)}%` : 'N/A'}
              </div>
            </div>
          </div>
        </div>

        {/* Columna derecha: Resumen rápido de la cuenta */}
        <div style={{
          backgroundColor: '#1a1d27',
          border: '1px solid #2a2d3a',
          borderRadius: '12px',
          padding: '20px'
        }}>
          <h3 style={{
            fontSize: '15px',
            fontWeight: '600',
            color: '#fff',
            marginBottom: '20px',
            marginTop: 0,
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}>
            <BarChart3 size={18} color="#8b5cf6" />
            Métricas Extendidas
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {/* ROAS 14d */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '12px 16px',
              backgroundColor: '#242838',
              borderRadius: '8px'
            }}>
              <span style={{ fontSize: '13px', color: '#9ca3af' }}>ROAS 14d</span>
              <span style={{
                fontSize: '16px',
                fontWeight: '700',
                color: (overview?.roas_14d || 0) >= 3 ? '#10b981' :
                       (overview?.roas_14d || 0) >= 1.5 ? '#fcd34d' : '#ef4444'
              }}>
                {overview?.roas_14d ? overview.roas_14d.toFixed(2) + 'x' : 'N/A'}
              </span>
            </div>

            {/* ROAS 30d */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '12px 16px',
              backgroundColor: '#242838',
              borderRadius: '8px'
            }}>
              <span style={{ fontSize: '13px', color: '#9ca3af' }}>ROAS 30d</span>
              <span style={{
                fontSize: '16px',
                fontWeight: '700',
                color: (overview?.roas_30d || 0) >= 3 ? '#10b981' :
                       (overview?.roas_30d || 0) >= 1.5 ? '#fcd34d' : '#ef4444'
              }}>
                {overview?.roas_30d ? overview.roas_30d.toFixed(2) + 'x' : 'N/A'}
              </span>
            </div>

            {/* Gasto 14d */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '12px 16px',
              backgroundColor: '#242838',
              borderRadius: '8px'
            }}>
              <span style={{ fontSize: '13px', color: '#9ca3af' }}>Gasto 14d</span>
              <span style={{ fontSize: '16px', fontWeight: '700', color: '#e5e7eb' }}>
                {formatCurrency(overview?.spend_14d)}
              </span>
            </div>

            {/* Gasto 30d */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '12px 16px',
              backgroundColor: '#242838',
              borderRadius: '8px'
            }}>
              <span style={{ fontSize: '13px', color: '#9ca3af' }}>Gasto 30d</span>
              <span style={{ fontSize: '16px', fontWeight: '700', color: '#e5e7eb' }}>
                {formatCurrency(overview?.spend_30d)}
              </span>
            </div>

            {/* Total Ad Sets */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '12px 16px',
              backgroundColor: '#242838',
              borderRadius: '8px'
            }}>
              <span style={{ fontSize: '13px', color: '#9ca3af' }}>Total Ad Sets</span>
              <span style={{ fontSize: '16px', fontWeight: '700', color: '#e5e7eb' }}>
                {overview?.total_adsets || adSetsData.length || 0}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
