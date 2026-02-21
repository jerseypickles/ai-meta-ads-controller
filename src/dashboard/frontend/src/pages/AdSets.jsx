import React, { useState, useEffect } from 'react';
import {
  Search,
  TrendingUp,
  TrendingDown,
  Minus,
  Play,
  Pause,
  ChevronDown,
  ChevronUp,
  Layers,
  DollarSign,
  BarChart3,
  ShoppingCart,
  Copy,
  PlusCircle,
  Target,
  ToggleRight,
  ArrowLeftRight,
  Palette,
  Ban,
  Zap,
  Lock,
  RefreshCw
} from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer
} from 'recharts';
import { getAdSets, getHistory, pauseEntity, activateEntity, getAdsForAdSet, getAdSetActions } from '../api';

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

// Formatear numero
const formatNumber = (value, decimals = 2) => {
  if (value === null || value === undefined) return '0';
  return Number(value).toFixed(decimals);
};

// Config de agentes (4 agentes reales)
const AGENT_CONFIG = {
  scaling: { color: '#10b981', bg: '#065f46', label: 'Scaling' },
  performance: { color: '#3b82f6', bg: '#1e3a8a', label: 'Perform' },
  creative: { color: '#f59e0b', bg: '#78350f', label: 'Creative' },
  pacing: { color: '#8b5cf6', bg: '#4c1d95', label: 'Pacing' },
  unknown: { color: '#6b7280', bg: '#374151', label: 'AI' }
};

// Config de acciones (11 tipos)
const ACTION_LABELS = {
  scale_up: { icon: '\u2191', color: '#10b981', label: 'Scale Up' },
  scale_down: { icon: '\u2193', color: '#f59e0b', label: 'Scale Down' },
  pause: { icon: '\u23F8', color: '#ef4444', label: 'Pausado' },
  reactivate: { icon: '\u25B6', color: '#10b981', label: 'Reactivado' },
  duplicate_adset: { icon: '\u2398', color: '#8b5cf6', label: 'Duplicado' },
  create_ad: { icon: '+', color: '#06b6d4', label: 'Nuevo Ad' },
  update_bid_strategy: { icon: '\u2295', color: '#f97316', label: 'Bid' },
  update_ad_status: { icon: '\u21C4', color: '#a78bfa', label: 'Status Ad' },
  move_budget: { icon: '\u21C6', color: '#14b8a6', label: 'Mover $' },
  update_ad_creative: { icon: '\u270E', color: '#ec4899', label: 'Creative' },
  no_action: { icon: '\u2013', color: '#6b7280', label: 'Sin accion' }
};

const normalizeAgentType = (rawType) => {
  const type = String(rawType || '').toLowerCase();
  if (['scaling', 'budget'].includes(type)) return 'scaling';
  if (type === 'performance') return 'performance';
  if (type === 'creative') return 'creative';
  if (type === 'pacing') return 'pacing';
  if (['unified_policy', 'unified'].includes(type)) return 'scaling';
  return 'unknown';
};

// Mapeo de time windows
const TIME_WINDOWS = {
  'today': 'Hoy',
  'last_3d': '3D',
  'last_7d': '7D',
  'last_14d': '14D',
  'last_30d': '30D'
};

// Componente principal AdSets
const AdSets = () => {
  const [adSets, setAdSets] = useState([]);
  const [filteredAdSets, setFilteredAdSets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('Todos');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortConfig, setSortConfig] = useState({ key: 'roas', direction: 'desc' });
  const [expandedRow, setExpandedRow] = useState(null);
  const [historyData, setHistoryData] = useState({});
  const [actionLoading, setActionLoading] = useState(null);
  const [timeWindow, setTimeWindow] = useState('last_7d');
  const [adsData, setAdsData] = useState({});
  const [adsLoading, setAdsLoading] = useState({});
  const [adsSortConfig, setAdsSortConfig] = useState({ key: 'roas', direction: 'desc' });
  const [agentActions, setAgentActions] = useState({});

  // Cargar datos
  const fetchAdSets = async () => {
    try {
      setLoading(true);
      const data = await getAdSets();
      setAdSets(data || []);
    } catch (error) {
      console.error('Error al cargar ad sets:', error);
      setAdSets([]);
    } finally {
      setLoading(false);
    }
  };

  const fetchHistory = async (adsetId) => {
    if (historyData[adsetId]) return;
    try {
      const data = await getHistory(adsetId, 7);
      setHistoryData(prev => ({ ...prev, [adsetId]: data || [] }));
    } catch (error) {
      setHistoryData(prev => ({ ...prev, [adsetId]: [] }));
    }
  };

  const fetchAdsForAdSet = async (adsetId) => {
    if (adsData[adsetId]) return;
    try {
      setAdsLoading(prev => ({ ...prev, [adsetId]: true }));
      const data = await getAdsForAdSet(adsetId);
      setAdsData(prev => ({ ...prev, [adsetId]: data || [] }));
    } catch (error) {
      setAdsData(prev => ({ ...prev, [adsetId]: [] }));
    } finally {
      setAdsLoading(prev => ({ ...prev, [adsetId]: false }));
    }
  };

  const fetchAgentActions = async () => {
    try {
      const data = await getAdSetActions(30);
      setAgentActions(data || {});
    } catch (error) {
      console.error('Error al cargar acciones:', error);
    }
  };

  const handleToggleStatus = async (adset, e) => {
    e.stopPropagation();
    try {
      setActionLoading(adset.id);
      const action = adset.status === 'ACTIVE' ? pauseEntity : activateEntity;
      await action(adset.id, {
        entity_type: 'adset',
        reason: `Accion manual desde dashboard`
      });
      await fetchAdSets();
    } catch (error) {
      console.error('Error al cambiar estado:', error);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRowClick = async (adset) => {
    if (expandedRow === adset.id) {
      setExpandedRow(null);
    } else {
      setExpandedRow(adset.id);
      await fetchHistory(adset.id);
      await fetchAdsForAdSet(adset.id);
    }
  };

  useEffect(() => {
    fetchAdSets();
    fetchAgentActions();
    const interval = setInterval(() => {
      fetchAdSets();
      fetchAgentActions();
    }, 120000);
    return () => clearInterval(interval);
  }, []);

  // Filtrar y ordenar
  useEffect(() => {
    let filtered = [...adSets];

    if (statusFilter === 'Activos') {
      filtered = filtered.filter(as => as.status === 'ACTIVE');
    } else if (statusFilter === 'Pausados') {
      filtered = filtered.filter(as => as.status === 'PAUSED');
    }

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(as => as.name?.toLowerCase().includes(query));
    }

    if (sortConfig.key) {
      filtered.sort((a, b) => {
        let aVal, bVal;
        switch (sortConfig.key) {
          case 'name': aVal = a.name || ''; bVal = b.name || ''; break;
          case 'status': aVal = a.status || ''; bVal = b.status || ''; break;
          case 'budget': aVal = a.daily_budget || 0; bVal = b.daily_budget || 0; break;
          case 'spend': aVal = a.metrics?.[timeWindow]?.spend || 0; bVal = b.metrics?.[timeWindow]?.spend || 0; break;
          case 'roas': aVal = a.metrics?.[timeWindow]?.roas || 0; bVal = b.metrics?.[timeWindow]?.roas || 0; break;
          case 'cpa': aVal = a.metrics?.[timeWindow]?.cpa || 0; bVal = b.metrics?.[timeWindow]?.cpa || 0; break;
          case 'purchases': aVal = a.metrics?.[timeWindow]?.purchases || 0; bVal = b.metrics?.[timeWindow]?.purchases || 0; break;
          case 'ctr': aVal = a.metrics?.[timeWindow]?.ctr || 0; bVal = b.metrics?.[timeWindow]?.ctr || 0; break;
          case 'frequency': aVal = a.metrics?.[timeWindow]?.frequency || 0; bVal = b.metrics?.[timeWindow]?.frequency || 0; break;
          default: aVal = 0; bVal = 0;
        }
        if (typeof aVal === 'string') {
          return sortConfig.direction === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
        }
        return sortConfig.direction === 'asc' ? aVal - bVal : bVal - aVal;
      });
    }

    setFilteredAdSets(filtered);
  }, [adSets, statusFilter, searchQuery, sortConfig, timeWindow]);

  const handleSort = (key) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc'
    }));
  };

  const handleAdsSort = (key) => {
    setAdsSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc'
    }));
  };

  const getSortedAds = (adsetId) => {
    const ads = adsData[adsetId] || [];
    if (!adsSortConfig.key) return ads;
    return [...ads].sort((a, b) => {
      let aVal, bVal;
      switch (adsSortConfig.key) {
        case 'name': aVal = a.entity_name || ''; bVal = b.entity_name || ''; break;
        case 'spend': aVal = a.metrics?.[timeWindow]?.spend || 0; bVal = b.metrics?.[timeWindow]?.spend || 0; break;
        case 'roas': aVal = a.metrics?.[timeWindow]?.roas || 0; bVal = b.metrics?.[timeWindow]?.roas || 0; break;
        case 'cpa': aVal = a.metrics?.[timeWindow]?.cpa || 0; bVal = b.metrics?.[timeWindow]?.cpa || 0; break;
        case 'ctr': aVal = a.metrics?.[timeWindow]?.ctr || 0; bVal = b.metrics?.[timeWindow]?.ctr || 0; break;
        default: aVal = 0; bVal = 0;
      }
      if (typeof aVal === 'string') {
        return adsSortConfig.direction === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return adsSortConfig.direction === 'asc' ? aVal - bVal : bVal - aVal;
    });
  };

  const getRoasColor = (roas) => {
    if (roas >= 3) return '#10b981';
    if (roas >= 1.5) return '#fbbf24';
    return '#ef4444';
  };

  const getTrendIcon = (trend) => {
    if (trend === 'improving') return <TrendingUp size={14} color="#10b981" />;
    if (trend === 'declining') return <TrendingDown size={14} color="#ef4444" />;
    return <Minus size={14} color="#6b7280" />;
  };

  // Resumen
  const activeCount = adSets.filter(as => as.status === 'ACTIVE').length;
  const pausedCount = adSets.filter(as => as.status === 'PAUSED').length;
  const activeBudgetTotal = adSets
    .filter(as => as.status === 'ACTIVE')
    .reduce((sum, as) => sum + (as.daily_budget || 0), 0);
  const totalSpend = adSets.reduce((sum, as) => sum + (as.metrics?.[timeWindow]?.spend || 0), 0);
  const totalPurchases = adSets.reduce((sum, as) => sum + (as.metrics?.[timeWindow]?.purchases || 0), 0);
  const weightedRoas = adSets.reduce((acc, as) => {
    const spend = as.metrics?.[timeWindow]?.spend || 0;
    const roas = as.metrics?.[timeWindow]?.roas || 0;
    return { totalSpend: acc.totalSpend + spend, weightedSum: acc.weightedSum + (spend * roas) };
  }, { totalSpend: 0, weightedSum: 0 });
  const avgWeightedRoas = weightedRoas.totalSpend > 0 ? weightedRoas.weightedSum / weightedRoas.totalSpend : 0;

  const renderSortIcon = (columnKey) => {
    if (sortConfig.key !== columnKey) return null;
    return sortConfig.direction === 'asc'
      ? <ChevronUp size={12} style={{ marginLeft: '2px' }} />
      : <ChevronDown size={12} style={{ marginLeft: '2px' }} />;
  };

  const renderAdsSortIcon = (columnKey) => {
    if (adsSortConfig.key !== columnKey) return null;
    return adsSortConfig.direction === 'asc'
      ? <ChevronUp size={12} style={{ marginLeft: '2px' }} />
      : <ChevronDown size={12} style={{ marginLeft: '2px' }} />;
  };

  // Helpers agentes
  const getActionsForAdSet = (adsetId) => {
    const data = agentActions[adsetId];
    if (!data) return [];
    return data.actions || data;
  };

  const getCooldown = (adsetId) => {
    const data = agentActions[adsetId];
    if (!data || !data.cooldown) return null;
    return data.cooldown.active ? data.cooldown : null;
  };

  const formatCooldownTime = (hoursLeft) => {
    if (hoursLeft >= 24) {
      const days = Math.floor(hoursLeft / 24);
      const hrs = hoursLeft % 24;
      return hrs > 0 ? `${days}d ${hrs}h` : `${days}d`;
    }
    return `${hoursLeft}h`;
  };

  const getLastAction = (adsetId) => {
    const actions = getActionsForAdSet(adsetId);
    return actions.length > 0 ? actions[0] : null;
  };

  const timeAgo = (dateStr) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  };

  if (loading && adSets.length === 0) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '60vh', color: '#9ca3af', fontSize: '14px',
        fontFamily: 'Inter, system-ui, sans-serif'
      }}>
        Cargando ad sets...
      </div>
    );
  }

  return (
    <div className="adsets-page" style={{ fontFamily: 'Inter, system-ui, sans-serif', color: '#fff' }}>

      {/* ====== HEADER ====== */}
      <div className="adsets-header" style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: '16px', flexWrap: 'wrap', gap: '10px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '36px', height: '36px', borderRadius: '8px',
            backgroundColor: '#1e3a8a', display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            <Layers size={18} color="#93c5fd" />
          </div>
          <div>
            <h1 style={{ fontSize: '22px', fontWeight: '700', margin: 0, letterSpacing: '-0.02em' }}>
              Ad Sets
            </h1>
            <p style={{ color: '#6b7280', fontSize: '12px', margin: 0 }}>
              {filteredAdSets.length} de {adSets.length} &middot; {activeCount} activos &middot; {pausedCount} pausados
            </p>
          </div>
        </div>

        {/* Search + Refresh */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <div className="adsets-search" style={{ position: 'relative', width: '220px' }}>
            <Search size={14} style={{
              position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: '#6b7280'
            }} />
            <input
              type="text"
              placeholder="Buscar..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: '100%', padding: '7px 10px 7px 32px', borderRadius: '8px',
                border: '1px solid #2a2d3a', backgroundColor: '#1a1d27', color: '#fff',
                fontSize: '12px', fontFamily: 'Inter, system-ui, sans-serif', outline: 'none'
              }}
            />
          </div>
          <button
            onClick={() => { fetchAdSets(); fetchAgentActions(); }}
            style={{
              padding: '7px', borderRadius: '8px', border: '1px solid #2a2d3a',
              backgroundColor: '#1a1d27', color: '#6b7280', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}
            title="Refrescar"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* ====== SUMMARY CARDS ====== */}
      <div className="adsets-summary" style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px', marginBottom: '14px'
      }}>
        <div style={summaryCardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
            <DollarSign size={14} color="#3b82f6" />
            <span style={summaryLabelStyle}>Budget Diario</span>
          </div>
          <div style={summaryValueStyle}>{formatCurrency(activeBudgetTotal)}</div>
        </div>
        <div style={summaryCardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
            <BarChart3 size={14} color={getRoasColor(avgWeightedRoas)} />
            <span style={summaryLabelStyle}>ROAS Ponderado</span>
          </div>
          <div style={{ ...summaryValueStyle, color: getRoasColor(avgWeightedRoas) }}>
            {formatNumber(avgWeightedRoas)}x
          </div>
        </div>
        <div style={summaryCardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
            <DollarSign size={14} color="#f59e0b" />
            <span style={summaryLabelStyle}>Gasto ({TIME_WINDOWS[timeWindow]})</span>
          </div>
          <div style={summaryValueStyle}>{formatCurrency(totalSpend)}</div>
        </div>
        <div style={summaryCardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
            <ShoppingCart size={14} color="#10b981" />
            <span style={summaryLabelStyle}>Compras ({TIME_WINDOWS[timeWindow]})</span>
          </div>
          <div style={summaryValueStyle}>{totalPurchases}</div>
        </div>
      </div>

      {/* ====== FILTERS ROW ====== */}
      <div className="adsets-filters" style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: '12px', flexWrap: 'wrap', gap: '8px'
      }}>
        {/* Status filter */}
        <div style={{ display: 'flex', gap: '4px' }}>
          {['Todos', 'Activos', 'Pausados'].map(f => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              style={{
                padding: '5px 12px', borderRadius: '6px', border: 'none',
                fontSize: '11px', fontWeight: '600', cursor: 'pointer',
                backgroundColor: statusFilter === f ? '#1e3a8a' : '#1a1d27',
                color: statusFilter === f ? '#93c5fd' : '#6b7280',
                fontFamily: 'Inter, system-ui, sans-serif'
              }}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Time window */}
        <div style={{ display: 'flex', gap: '4px' }}>
          {Object.entries(TIME_WINDOWS).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTimeWindow(key)}
              style={{
                padding: '5px 10px', borderRadius: '6px', border: 'none',
                fontSize: '11px', fontWeight: '600', cursor: 'pointer',
                backgroundColor: timeWindow === key ? '#3b82f6' : '#1a1d27',
                color: timeWindow === key ? '#fff' : '#6b7280',
                fontFamily: 'Inter, system-ui, sans-serif'
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ====== TABLE ====== */}
      <div style={{
        backgroundColor: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: '10px',
        overflow: 'hidden'
      }}>
        <div className="adsets-table-wrap" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '900px' }}>
            <thead>
              <tr>
                {[
                  { key: 'name', label: 'Nombre', w: '180px', align: 'left' },
                  { key: 'status', label: 'Estado', w: '60px' },
                  { key: 'budget', label: 'Budget', w: '85px' },
                  { key: 'spend', label: 'Spend', w: '85px' },
                  { key: 'roas', label: 'ROAS', w: '70px' },
                  { key: 'cpa', label: 'CPA', w: '80px' },
                  { key: 'purchases', label: 'Compras', w: '70px' },
                  { key: 'ctr', label: 'CTR', w: '60px' },
                  { key: 'frequency', label: 'Freq', w: '60px' },
                ].map(col => (
                  <th
                    key={col.key}
                    onClick={() => handleSort(col.key)}
                    style={{ ...thStyle, cursor: 'pointer', width: col.w, textAlign: col.align || 'left' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      {col.label}{renderSortIcon(col.key)}
                    </div>
                  </th>
                ))}
                <th style={{ ...thStyle, width: '40px', textAlign: 'center' }}>Trend</th>
                <th style={{ ...thStyle, width: '130px' }}>Agente IA</th>
                <th style={{ ...thStyle, width: '65px', textAlign: 'center' }}>Accion</th>
              </tr>
            </thead>
            <tbody>
              {filteredAdSets.length === 0 ? (
                <tr>
                  <td colSpan="12" style={{ ...tdStyle, textAlign: 'center', color: '#6b7280', padding: '40px' }}>
                    {searchQuery || statusFilter !== 'Todos'
                      ? 'Sin resultados con los filtros aplicados'
                      : 'No hay ad sets disponibles'}
                  </td>
                </tr>
              ) : (
                filteredAdSets.map(adset => {
                  const m = adset.metrics?.[timeWindow] || {};
                  const lastAction = getLastAction(adset.id);
                  const cooldown = getCooldown(adset.id);
                  const totalActions = getActionsForAdSet(adset.id).length;
                  const isExpanded = expandedRow === adset.id;

                  return (
                    <React.Fragment key={adset.id}>
                      <tr
                        onClick={() => handleRowClick(adset)}
                        className="adset-row"
                        style={{
                          cursor: 'pointer',
                          backgroundColor: isExpanded ? '#1f2230' : 'transparent',
                          transition: 'background-color 0.1s'
                        }}
                        onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.backgroundColor = '#16181f'; }}
                        onMouseLeave={(e) => { if (!isExpanded) e.currentTarget.style.backgroundColor = 'transparent'; }}
                      >
                        {/* Nombre */}
                        <td style={tdStyle}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            {lastAction && (
                              <div style={{
                                width: '5px', height: '5px', borderRadius: '50%', flexShrink: 0,
                                backgroundColor: (AGENT_CONFIG[normalizeAgentType(lastAction.agent)] || AGENT_CONFIG.unknown).color
                              }} />
                            )}
                            <div style={{
                              maxWidth: '170px', overflow: 'hidden', textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap', fontWeight: '500', fontSize: '12px'
                            }} title={adset.name}>
                              {adset.name || 'Sin nombre'}
                            </div>
                          </div>
                        </td>

                        {/* Estado */}
                        <td style={tdStyle}>
                          <span style={{
                            padding: '2px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: '700',
                            backgroundColor: adset.status === 'ACTIVE' ? '#065f46' : '#374151',
                            color: adset.status === 'ACTIVE' ? '#6ee7b7' : '#9ca3af'
                          }}>
                            {adset.status === 'ACTIVE' ? 'On' : 'Off'}
                          </span>
                        </td>

                        {/* Budget */}
                        <td style={tdStyle}>{formatCurrency(adset.daily_budget)}</td>

                        {/* Spend */}
                        <td style={tdStyle}>{formatCurrency(m.spend)}</td>

                        {/* ROAS */}
                        <td style={tdStyle}>
                          <span style={{ fontWeight: '700', color: getRoasColor(m.roas || 0) }}>
                            {formatNumber(m.roas || 0)}x
                          </span>
                        </td>

                        {/* CPA */}
                        <td style={tdStyle}>{formatCurrency(m.cpa)}</td>

                        {/* Purchases */}
                        <td style={tdStyle}>{m.purchases || 0}</td>

                        {/* CTR */}
                        <td style={tdStyle}>{(m.ctr || 0).toFixed(2)}%</td>

                        {/* Frequency */}
                        <td style={tdStyle}>
                          <span style={{ color: (m.frequency || 0) > 2.5 ? '#ef4444' : '#e5e7eb' }}>
                            {formatNumber(m.frequency || 0)}
                          </span>
                        </td>

                        {/* Trend */}
                        <td style={{ ...tdStyle, textAlign: 'center' }}>
                          {getTrendIcon(adset.analysis?.roas_trend)}
                        </td>

                        {/* Agente IA */}
                        <td style={tdStyle}>
                          {!lastAction && !cooldown ? (
                            <span style={{ color: '#4b5563', fontSize: '10px' }}>--</span>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                              {cooldown && (
                                <div style={{
                                  display: 'inline-flex', alignItems: 'center', gap: '3px',
                                  padding: '1px 5px', borderRadius: '3px',
                                  backgroundColor: '#7f1d1d', width: 'fit-content'
                                }}>
                                  <Lock size={8} color="#fca5a5" />
                                  <span style={{ fontSize: '9px', color: '#fca5a5', fontWeight: '600' }}>
                                    {formatCooldownTime(cooldown.hours_left)}
                                  </span>
                                </div>
                              )}
                              {lastAction && (() => {
                                const agCfg = AGENT_CONFIG[normalizeAgentType(lastAction.agent)] || AGENT_CONFIG.unknown;
                                const actCfg = ACTION_LABELS[lastAction.action] || ACTION_LABELS.no_action;
                                return (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                                      <span style={{
                                        padding: '1px 5px', borderRadius: '3px', fontSize: '9px', fontWeight: '700',
                                        backgroundColor: agCfg.bg, color: agCfg.color
                                      }}>
                                        {agCfg.label}
                                      </span>
                                      <span style={{ fontSize: '9px', color: actCfg.color, fontWeight: '600' }}>
                                        {actCfg.icon} {actCfg.label}
                                      </span>
                                    </div>
                                    <span style={{ fontSize: '9px', color: '#6b7280' }}>
                                      {timeAgo(lastAction.executed_at)} ago{totalActions > 1 && ` \u00B7 ${totalActions} total`}
                                    </span>
                                  </div>
                                );
                              })()}
                            </div>
                          )}
                        </td>

                        {/* Accion */}
                        <td style={{ ...tdStyle, textAlign: 'center' }}>
                          <button
                            onClick={(e) => handleToggleStatus(adset, e)}
                            disabled={actionLoading === adset.id}
                            style={{
                              padding: '4px 8px', borderRadius: '4px', border: 'none',
                              cursor: actionLoading === adset.id ? 'not-allowed' : 'pointer',
                              backgroundColor: adset.status === 'ACTIVE' ? '#78350f' : '#065f46',
                              color: adset.status === 'ACTIVE' ? '#fcd34d' : '#6ee7b7',
                              fontSize: '10px', fontWeight: '700',
                              display: 'inline-flex', alignItems: 'center', gap: '3px',
                              fontFamily: 'Inter, system-ui, sans-serif',
                              opacity: actionLoading === adset.id ? 0.5 : 1
                            }}
                          >
                            {actionLoading === adset.id ? '...' : adset.status === 'ACTIVE' ? (
                              <><Pause size={10} /> Pause</>
                            ) : (
                              <><Play size={10} /> Play</>
                            )}
                          </button>
                        </td>
                      </tr>

                      {/* ====== EXPANDED ROW ====== */}
                      {isExpanded && (
                        <tr>
                          <td colSpan="12" style={{ padding: 0, backgroundColor: '#13151d', borderTop: '1px solid #2a2d3a' }}>
                            <div className="expanded-content" style={{ padding: '16px' }}>
                              <div className="expanded-grid" style={{
                                display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: '16px', marginBottom: '16px'
                              }}>
                                {/* Chart */}
                                <div style={{
                                  backgroundColor: '#1a1d27', borderRadius: '8px', padding: '14px',
                                  border: '1px solid #2a2d3a'
                                }}>
                                  <h4 style={{ fontSize: '12px', fontWeight: '600', color: '#9ca3af', marginBottom: '12px', marginTop: 0 }}>
                                    ROAS ultimos 7 dias
                                  </h4>
                                  {historyData[adset.id] && historyData[adset.id].length > 0 ? (
                                    <ResponsiveContainer width="100%" height={170}>
                                      <LineChart data={historyData[adset.id]}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3a" />
                                        <XAxis dataKey="date" stroke="#6b7280" style={{ fontSize: '10px' }} />
                                        <YAxis stroke="#6b7280" style={{ fontSize: '10px' }} />
                                        <Tooltip
                                          contentStyle={{
                                            backgroundColor: '#1a1d27', border: '1px solid #2a2d3a',
                                            borderRadius: '6px', color: '#fff', fontSize: '11px'
                                          }}
                                        />
                                        <Line type="monotone" dataKey="roas" stroke="#3b82f6" strokeWidth={2} dot={{ fill: '#3b82f6', r: 2 }} />
                                      </LineChart>
                                    </ResponsiveContainer>
                                  ) : (
                                    <div style={{ height: '170px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280', fontSize: '12px' }}>
                                      Cargando...
                                    </div>
                                  )}
                                </div>

                                {/* Metrics + Agent history */}
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                  {/* Detailed metrics */}
                                  <div style={{
                                    backgroundColor: '#1a1d27', borderRadius: '8px', padding: '14px',
                                    border: '1px solid #2a2d3a'
                                  }}>
                                    <h4 style={{ fontSize: '12px', fontWeight: '600', color: '#9ca3af', marginBottom: '10px', marginTop: 0 }}>
                                      Metricas ({TIME_WINDOWS[timeWindow]})
                                    </h4>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                      <MetricRow label="Gasto" value={formatCurrency(m.spend)} />
                                      <MetricRow label="Compras" value={m.purchases || 0} />
                                      <MetricRow label="Alcance" value={new Intl.NumberFormat('es-CL').format(m.reach || 0)} />
                                      <MetricRow label="Impresiones" value={new Intl.NumberFormat('es-CL').format(m.impressions || 0)} />
                                      <MetricRow label="Clicks" value={new Intl.NumberFormat('es-CL').format(m.clicks || 0)} />
                                    </div>
                                  </div>

                                  {/* Agent actions history */}
                                  <div style={{
                                    backgroundColor: '#1a1d27', borderRadius: '8px', padding: '14px',
                                    border: '1px solid #2a2d3a', flex: 1
                                  }}>
                                    <h4 style={{ fontSize: '12px', fontWeight: '600', color: '#9ca3af', marginBottom: '10px', marginTop: 0 }}>
                                      Historial Agentes IA
                                    </h4>
                                    {(() => {
                                      const actions = getActionsForAdSet(adset.id);
                                      if (actions.length === 0) {
                                        return <div style={{ fontSize: '11px', color: '#4b5563' }}>Sin acciones de agentes</div>;
                                      }
                                      return (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '140px', overflowY: 'auto' }}>
                                          {actions.slice(0, 10).map((act, i) => {
                                            const agCfg = AGENT_CONFIG[normalizeAgentType(act.agent)] || AGENT_CONFIG.unknown;
                                            const actCfg = ACTION_LABELS[act.action] || ACTION_LABELS.no_action;
                                            return (
                                              <div key={i} style={{
                                                display: 'flex', alignItems: 'center', gap: '6px',
                                                fontSize: '10px', padding: '3px 0'
                                              }}>
                                                <span style={{
                                                  padding: '1px 5px', borderRadius: '3px', fontSize: '9px', fontWeight: '700',
                                                  backgroundColor: agCfg.bg, color: agCfg.color, minWidth: '48px', textAlign: 'center'
                                                }}>
                                                  {agCfg.label}
                                                </span>
                                                <span style={{ color: actCfg.color, fontWeight: '600', minWidth: '65px' }}>
                                                  {actCfg.icon} {actCfg.label}
                                                </span>
                                                <span style={{ color: '#e5e7eb' }}>
                                                  ${act.before_value} → ${act.after_value}
                                                </span>
                                                <span style={{ color: '#6b7280', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                                                  {new Date(act.executed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                                </span>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      );
                                    })()}
                                  </div>
                                </div>
                              </div>

                              {/* Ads table */}
                              <div style={{
                                backgroundColor: '#1a1d27', borderRadius: '8px', padding: '14px',
                                border: '1px solid #2a2d3a'
                              }}>
                                <h4 style={{ fontSize: '12px', fontWeight: '600', color: '#9ca3af', marginBottom: '10px', marginTop: 0 }}>
                                  Ads en este Ad Set ({TIME_WINDOWS[timeWindow]})
                                </h4>
                                {adsLoading[adset.id] ? (
                                  <div style={{ padding: '20px', textAlign: 'center', color: '#6b7280', fontSize: '12px' }}>Cargando ads...</div>
                                ) : !adsData[adset.id] || adsData[adset.id].length === 0 ? (
                                  <div style={{ padding: '20px', textAlign: 'center', color: '#6b7280', fontSize: '12px' }}>No hay ads</div>
                                ) : (
                                  <div style={{ overflowX: 'auto' }}>
                                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                      <thead>
                                        <tr>
                                          {[
                                            { key: 'name', label: 'Nombre' },
                                            { key: 'spend', label: 'Spend', w: '100px' },
                                            { key: 'roas', label: 'ROAS', w: '80px' },
                                            { key: 'cpa', label: 'CPA', w: '90px' },
                                            { key: 'ctr', label: 'CTR', w: '70px' }
                                          ].map(col => (
                                            <th
                                              key={col.key}
                                              onClick={() => handleAdsSort(col.key)}
                                              style={{ ...adsThStyle, cursor: 'pointer', width: col.w || 'auto' }}
                                            >
                                              <div style={{ display: 'flex', alignItems: 'center' }}>
                                                {col.label}{renderAdsSortIcon(col.key)}
                                              </div>
                                            </th>
                                          ))}
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {getSortedAds(adset.id).map(ad => {
                                          const am = ad.metrics?.[timeWindow] || {};
                                          return (
                                            <tr key={ad.entity_id}>
                                              <td style={adsTdStyle}>
                                                <div style={{
                                                  maxWidth: '250px', overflow: 'hidden', textOverflow: 'ellipsis',
                                                  whiteSpace: 'nowrap', fontWeight: '500'
                                                }} title={ad.entity_name}>
                                                  {ad.entity_name || 'Sin nombre'}
                                                </div>
                                              </td>
                                              <td style={adsTdStyle}>{formatCurrency(am.spend)}</td>
                                              <td style={adsTdStyle}>
                                                <span style={{ fontWeight: '700', color: getRoasColor(am.roas || 0) }}>
                                                  {formatNumber(am.roas || 0)}x
                                                </span>
                                              </td>
                                              <td style={adsTdStyle}>{formatCurrency(am.cpa)}</td>
                                              <td style={adsTdStyle}>{(am.ctr || 0).toFixed(2)}%</td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
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

      {/* ====== RESPONSIVE CSS ====== */}
      <style>{`
        @media (max-width: 1100px) {
          .adsets-summary {
            grid-template-columns: repeat(2, 1fr) !important;
          }
        }
        @media (max-width: 768px) {
          .adsets-header {
            flex-direction: column !important;
            align-items: flex-start !important;
          }
          .adsets-search {
            width: 100% !important;
          }
          .adsets-summary {
            grid-template-columns: 1fr 1fr !important;
          }
          .adsets-filters {
            flex-direction: column !important;
            align-items: flex-start !important;
          }
          .adsets-table-wrap {
            margin: 0 -16px;
          }
          .expanded-grid {
            grid-template-columns: 1fr !important;
          }
        }
        @media (max-width: 480px) {
          .adsets-summary {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  );
};

// Componente MetricRow
const MetricRow = ({ label, value }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
    <span style={{ fontSize: '11px', color: '#6b7280' }}>{label}</span>
    <span style={{ fontSize: '12px', color: '#e5e7eb', fontWeight: '600' }}>{value}</span>
  </div>
);

// Estilos tabla principal
const thStyle = {
  textAlign: 'left',
  padding: '8px 10px',
  fontSize: '10px',
  fontWeight: '600',
  color: '#9ca3af',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  borderBottom: '2px solid #2a2d3a',
  backgroundColor: '#1a1d27'
};

const tdStyle = {
  padding: '7px 10px',
  fontSize: '12px',
  color: '#e5e7eb',
  borderBottom: '1px solid #1f2230'
};

// Estilos tabla ads
const adsThStyle = {
  textAlign: 'left',
  padding: '6px 10px',
  fontSize: '9px',
  fontWeight: '600',
  color: '#9ca3af',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  borderBottom: '1px solid #2a2d3a',
  backgroundColor: '#13151d'
};

const adsTdStyle = {
  padding: '5px 10px',
  fontSize: '11px',
  color: '#e5e7eb',
  borderBottom: '1px solid #1f2230'
};

// Estilos summary cards
const summaryCardStyle = {
  backgroundColor: '#1a1d27',
  border: '1px solid #2a2d3a',
  borderRadius: '10px',
  padding: '14px'
};

const summaryLabelStyle = {
  fontSize: '11px',
  color: '#6b7280',
  fontWeight: '600',
  textTransform: 'uppercase',
  letterSpacing: '0.04em'
};

const summaryValueStyle = {
  fontSize: '22px',
  fontWeight: '700',
  color: '#fff',
  letterSpacing: '-0.02em'
};

export default AdSets;
