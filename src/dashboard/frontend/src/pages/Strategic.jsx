import React, { useState, useEffect, useCallback } from 'react';
import {
  Lightbulb, RefreshCw, Clock, AlertTriangle, CheckCircle, XCircle,
  ChevronDown, ChevronUp, Search, Zap, Palette, Layout, Users,
  FileText, Globe, TestTube, Calendar, DollarSign, TrendingUp, Eye, Target
} from 'lucide-react';
import {
  getStrategicLatest, runStrategicCycle, getStrategicRunStatus,
  getStrategicDirectives, acknowledgeInsight, implementInsight, dismissInsight
} from '../api';

const INSIGHT_TYPE_CONFIG = {
  creative_refresh:    { icon: Palette,    label: 'Creative Refresh',    color: '#f59e0b' },
  structure_change:    { icon: Layout,     label: 'Estructura',          color: '#8b5cf6' },
  audience_insight:    { icon: Users,      label: 'Audiencia',           color: '#06b6d4' },
  copy_strategy:       { icon: FileText,   label: 'Copy & Messaging',   color: '#ec4899' },
  platform_alert:      { icon: Globe,      label: 'Alerta Plataforma',  color: '#ef4444' },
  attribution_insight: { icon: Eye,        label: 'Atribucion',         color: '#6366f1' },
  testing_suggestion:  { icon: TestTube,   label: 'Test A/B',           color: '#14b8a6' },
  seasonal_strategy:   { icon: Calendar,   label: 'Estacional',         color: '#f97316' },
  budget_strategy:     { icon: DollarSign, label: 'Budget Strategy',    color: '#22c55e' },
  scaling_playbook:    { icon: TrendingUp, label: 'Scaling',            color: '#3b82f6' },
  competitive_insight: { icon: Target,     label: 'Competencia',        color: '#a855f7' },
  general:             { icon: Lightbulb,  label: 'General',            color: '#94a3b8' }
};

const SEVERITY_CONFIG = {
  critical: { color: '#ef4444', bg: '#7f1d1d30', label: 'CRITICO' },
  high:     { color: '#f59e0b', bg: '#78350f30', label: 'ALTO' },
  medium:   { color: '#3b82f6', bg: '#1e3a8a30', label: 'MEDIO' },
  low:      { color: '#6b7280', bg: '#37415130', label: 'BAJO' }
};

const HEALTH_CONFIG = {
  strong:   { color: '#10b981', label: 'Saludable' },
  stable:   { color: '#3b82f6', label: 'Estable' },
  warning:  { color: '#f59e0b', label: 'Atencion' },
  critical: { color: '#ef4444', label: 'Critico' }
};

export default function StrategicPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [expandedInsight, setExpandedInsight] = useState(null);
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [directives, setDirectives] = useState([]);

  const fetchData = useCallback(async () => {
    try {
      const [result, dirResult] = await Promise.all([
        getStrategicLatest(),
        getStrategicDirectives().catch(() => ({ directives: [] }))
      ]);
      setData(result);
      setDirectives(dirResult.directives || []);
    } catch (err) {
      console.error('Error fetching strategic data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleRunCycle = async () => {
    setRunning(true);
    setError(null);
    setElapsed(0);
    try {
      const startResult = await runStrategicCycle();
      if (startResult.status === 'running') {
        setError('Ya hay un ciclo en curso. Espera a que termine.');
        setRunning(false);
        return;
      }
      if (!startResult.success) {
        setError(startResult.error || 'No se pudo iniciar el ciclo');
        setRunning(false);
        return;
      }

      // Poll /run-status every 4 seconds until completed
      const poll = () => new Promise((resolve, reject) => {
        const interval = setInterval(async () => {
          try {
            const status = await getStrategicRunStatus();
            if (status.status === 'running') {
              setElapsed(status.elapsed_seconds || 0);
            } else if (status.status === 'completed') {
              clearInterval(interval);
              resolve(status.result);
            } else {
              // idle — shouldn't happen, but treat as done
              clearInterval(interval);
              resolve(null);
            }
          } catch (pollErr) {
            clearInterval(interval);
            reject(pollErr);
          }
        }, 4000);
      });

      const result = await poll();
      if (result && result.success === false) {
        setError(result.error || 'El ciclo fallo sin detalles');
      } else {
        await fetchData();
      }
    } catch (err) {
      console.error('Error running strategic cycle:', err);
      setError(err.response?.data?.error || err.message || 'Error de conexion');
    } finally {
      setRunning(false);
      setElapsed(0);
    }
  };

  const handleAction = async (insightId, action) => {
    try {
      if (action === 'acknowledge') await acknowledgeInsight(insightId);
      else if (action === 'implement') await implementInsight(insightId);
      else if (action === 'dismiss') await dismissInsight(insightId);
      await fetchData();
    } catch (err) {
      console.error(`Error ${action} insight:`, err);
    }
  };

  if (loading) {
    return <div style={{ color: '#888', padding: 40, fontFamily: 'Inter, system-ui, sans-serif' }}>Cargando analisis estrategico...</div>;
  }

  const insights = data?.insights || [];
  const filtered = filter === 'all' ? insights : insights.filter(i => i.insight_type === filter);
  const healthConf = HEALTH_CONFIG[data?.account_health] || HEALTH_CONFIG.stable;

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: '#e5e5e5' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: '#fff', margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            <Lightbulb size={24} color="#f59e0b" />
            Estrategia IA
          </h1>
          <p style={{ color: '#888', fontSize: 13, marginTop: 4 }}>
            Recomendaciones estrategicas de alto nivel impulsadas por Claude AI
          </p>
        </div>
        <button
          onClick={handleRunCycle}
          disabled={running}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 20px', borderRadius: 8,
            backgroundColor: running ? '#374151' : '#f59e0b',
            color: running ? '#9ca3af' : '#000',
            border: 'none', cursor: running ? 'not-allowed' : 'pointer',
            fontWeight: 600, fontSize: 13, fontFamily: 'Inter, system-ui, sans-serif'
          }}
        >
          <RefreshCw size={16} className={running ? 'spin' : ''} />
          {running ? `Analizando... ${elapsed > 0 ? `${elapsed}s` : ''}` : 'Ejecutar Analisis'}
        </button>
      </div>

      {/* Error display */}
      {error && (
        <div style={{
          backgroundColor: '#7f1d1d20', border: '1px solid #ef444440',
          borderRadius: 12, padding: 16, marginBottom: 24, color: '#fca5a5', fontSize: 13
        }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Account Health + Summary */}
      {data?.account_summary && (
        <div style={{
          backgroundColor: '#111', border: `1px solid ${healthConf.color}40`,
          borderRadius: 12, padding: 20, marginBottom: 24
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                padding: '4px 12px', borderRadius: 20,
                backgroundColor: `${healthConf.color}20`, color: healthConf.color,
                fontSize: 12, fontWeight: 700, textTransform: 'uppercase'
              }}>
                {healthConf.label}
              </div>
              <span style={{ color: '#888', fontSize: 12 }}>Salud de Cuenta</span>
            </div>
            {data?.created_at && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#666', fontSize: 12 }}>
                <Clock size={14} />
                {new Date(data.created_at).toLocaleString('es-US')}
              </div>
            )}
          </div>
          <p style={{ color: '#ccc', fontSize: 14, lineHeight: 1.6, margin: 0 }}>
            {data.account_summary}
          </p>
          <div style={{ display: 'flex', gap: 16, marginTop: 12 }}>
            <span style={{ color: '#888', fontSize: 12 }}>
              {data.total || 0} insights | {data.actionable || 0} accionables | {data.pending || 0} pendientes
            </span>
          </div>
        </div>
      )}

      {/* Active Directives */}
      {directives.length > 0 && (
        <div style={{
          backgroundColor: '#0f172a', border: '1px solid #1e3a8a40',
          borderRadius: 12, padding: 16, marginBottom: 24
        }}>
          <h3 style={{ color: '#93c5fd', fontSize: 13, fontWeight: 700, margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Zap size={16} color="#f59e0b" />
            Directivas Activas — Guiando al Algoritmo ({directives.length})
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {directives.map((d, i) => (
              <DirectiveRow key={d._id || i} directive={d} />
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        <FilterChip label="Todos" active={filter === 'all'} onClick={() => setFilter('all')} color="#888" />
        {Object.entries(INSIGHT_TYPE_CONFIG).map(([type, conf]) => {
          const count = insights.filter(i => i.insight_type === type).length;
          if (count === 0) return null;
          return (
            <FilterChip
              key={type}
              label={`${conf.label} (${count})`}
              active={filter === type}
              onClick={() => setFilter(type)}
              color={conf.color}
            />
          );
        })}
      </div>

      {/* Insights List */}
      {filtered.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: 60, color: '#666',
          backgroundColor: '#111', borderRadius: 12, border: '1px solid #222'
        }}>
          <Lightbulb size={40} style={{ marginBottom: 12, opacity: 0.3 }} />
          <p style={{ fontSize: 14 }}>No hay insights estrategicos disponibles.</p>
          <p style={{ fontSize: 12, color: '#555' }}>Ejecuta un ciclo de analisis para generar recomendaciones.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {filtered.map(insight => (
            <InsightCard
              key={insight._id}
              insight={insight}
              expanded={expandedInsight === insight._id}
              onToggle={() => setExpandedInsight(expandedInsight === insight._id ? null : insight._id)}
              onAction={handleAction}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({ label, active, onClick, color }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 14px', borderRadius: 20,
        backgroundColor: active ? `${color}20` : '#1a1a1a',
        border: `1px solid ${active ? color : '#333'}`,
        color: active ? color : '#888',
        fontSize: 12, fontWeight: 500, cursor: 'pointer',
        fontFamily: 'Inter, system-ui, sans-serif'
      }}
    >
      {label}
    </button>
  );
}

function InsightCard({ insight, expanded, onToggle, onAction }) {
  const typeConf = INSIGHT_TYPE_CONFIG[insight.insight_type] || INSIGHT_TYPE_CONFIG.general;
  const sevConf = SEVERITY_CONFIG[insight.severity] || SEVERITY_CONFIG.medium;
  const TypeIcon = typeConf.icon;

  const statusStyles = {
    pending:       { bg: '#1e3a8a20', color: '#93c5fd', label: 'Pendiente' },
    acknowledged:  { bg: '#78350f20', color: '#fcd34d', label: 'Visto' },
    implemented:   { bg: '#065f4620', color: '#6ee7b7', label: 'Implementado' },
    dismissed:     { bg: '#37415120', color: '#9ca3af', label: 'Descartado' }
  };
  const statusConf = statusStyles[insight.status] || statusStyles.pending;

  return (
    <div style={{
      backgroundColor: '#111', border: '1px solid #222',
      borderRadius: 12, overflow: 'hidden',
      borderLeft: `4px solid ${sevConf.color}`
    }}>
      {/* Header */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '16px 20px', cursor: 'pointer'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
          <TypeIcon size={20} color={typeConf.color} />
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{
                fontSize: 10, fontWeight: 700, color: sevConf.color,
                backgroundColor: sevConf.bg, padding: '2px 8px', borderRadius: 4,
                textTransform: 'uppercase'
              }}>
                {sevConf.label}
              </span>
              <span style={{
                fontSize: 10, fontWeight: 600, color: typeConf.color,
                backgroundColor: `${typeConf.color}15`, padding: '2px 8px', borderRadius: 4
              }}>
                {typeConf.label}
              </span>
              <span style={{
                fontSize: 10, fontWeight: 500, color: statusConf.color,
                backgroundColor: statusConf.bg, padding: '2px 8px', borderRadius: 4
              }}>
                {statusConf.label}
              </span>
            </div>
            <h3 style={{ color: '#fff', fontSize: 14, fontWeight: 600, margin: 0 }}>
              {insight.title}
            </h3>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {insight.actionable && (
            <Zap size={14} color="#f59e0b" title="Accionable automaticamente" />
          )}
          {expanded ? <ChevronUp size={18} color="#666" /> : <ChevronDown size={18} color="#666" />}
        </div>
      </div>

      {/* Expanded Content */}
      {expanded && (
        <div style={{ padding: '0 20px 20px', borderTop: '1px solid #1a1a1a' }}>
          {/* Analysis */}
          <div style={{ marginTop: 16 }}>
            <h4 style={{ color: '#888', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 8 }}>
              Analisis
            </h4>
            <p style={{ color: '#ccc', fontSize: 13, lineHeight: 1.7, margin: 0, whiteSpace: 'pre-wrap' }}>
              {insight.analysis}
            </p>
          </div>

          {/* Recommendation */}
          <div style={{ marginTop: 16 }}>
            <h4 style={{ color: '#888', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 8 }}>
              Recomendacion
            </h4>
            <div style={{
              backgroundColor: '#0a1628', border: '1px solid #1e3a8a40',
              borderRadius: 8, padding: 14
            }}>
              <p style={{ color: '#93c5fd', fontSize: 13, lineHeight: 1.7, margin: 0, whiteSpace: 'pre-wrap' }}>
                {insight.recommendation}
              </p>
            </div>
          </div>

          {/* Evidence */}
          {insight.evidence && insight.evidence.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h4 style={{ color: '#888', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 8 }}>
                Evidencia
              </h4>
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {insight.evidence.map((e, i) => (
                  <li key={i} style={{ color: '#aaa', fontSize: 12, lineHeight: 1.6 }}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Affected Entities */}
          {insight.affected_entities && insight.affected_entities.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h4 style={{ color: '#888', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 8 }}>
                Entidades Afectadas
              </h4>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {insight.affected_entities.map((e, i) => (
                  <span key={i} style={{
                    padding: '4px 10px', borderRadius: 6,
                    backgroundColor: '#1a1a1a', border: '1px solid #333',
                    color: '#aaa', fontSize: 11
                  }}>
                    {e.entity_type}: {e.entity_name || e.entity_id}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Creative Context */}
          {insight.creative_context && insight.creative_context.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h4 style={{ color: '#888', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 8 }}>
                Contexto Creativo
              </h4>
              {insight.creative_context.map((c, i) => (
                <div key={i} style={{
                  backgroundColor: '#0a0a0a', border: '1px solid #222',
                  borderRadius: 8, padding: 12, marginBottom: 8
                }}>
                  <div style={{ fontSize: 12, color: '#fff', fontWeight: 600 }}>{c.ad_name}</div>
                  {c.headline && <div style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>Headline: "{c.headline}"</div>}
                  {c.body && <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>Copy: "{c.body.substring(0, 120)}..."</div>}
                  {c.cta && <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>CTA: {c.cta}</div>}
                </div>
              ))}
            </div>
          )}

          {/* Research Sources */}
          {insight.research_sources && insight.research_sources.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h4 style={{ color: '#888', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Search size={12} /> Fuentes de Investigacion
              </h4>
              {insight.research_sources.map((s, i) => (
                <div key={i} style={{ marginBottom: 6 }}>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: '#3b82f6', fontSize: 12, textDecoration: 'none' }}
                  >
                    {s.title}
                  </a>
                  {s.snippet && <p style={{ color: '#666', fontSize: 11, margin: '2px 0 0' }}>{s.snippet.substring(0, 150)}</p>}
                </div>
              ))}
            </div>
          )}

          {/* Action Buttons */}
          {insight.status === 'pending' && (
            <div style={{ display: 'flex', gap: 8, marginTop: 20, borderTop: '1px solid #1a1a1a', paddingTop: 16 }}>
              <ActionButton
                icon={<CheckCircle size={14} />}
                label="Visto"
                color="#3b82f6"
                onClick={() => onAction(insight._id, 'acknowledge')}
              />
              <ActionButton
                icon={<Zap size={14} />}
                label="Implementado"
                color="#10b981"
                onClick={() => onAction(insight._id, 'implement')}
              />
              <ActionButton
                icon={<XCircle size={14} />}
                label="Descartar"
                color="#6b7280"
                onClick={() => onAction(insight._id, 'dismiss')}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const DIRECTIVE_CONFIG = {
  boost:    { color: '#22c55e', label: 'IMPULSAR', icon: TrendingUp },
  suppress: { color: '#ef4444', label: 'FRENAR',   icon: AlertTriangle },
  override: { color: '#f59e0b', label: 'FORZAR',   icon: Zap },
  protect:  { color: '#3b82f6', label: 'PROTEGER', icon: Eye }
};

function DirectiveRow({ directive }) {
  const conf = DIRECTIVE_CONFIG[directive.directive_type] || DIRECTIVE_CONFIG.boost;
  const DIcon = conf.icon;
  const timeLeft = directive.expires_at
    ? Math.max(0, Math.round((new Date(directive.expires_at) - Date.now()) / 60000))
    : 0;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 12px', borderRadius: 8,
      backgroundColor: '#111', border: `1px solid ${conf.color}30`
    }}>
      <DIcon size={14} color={conf.color} />
      <span style={{
        fontSize: 10, fontWeight: 700, color: conf.color,
        backgroundColor: `${conf.color}20`, padding: '2px 8px', borderRadius: 4,
        textTransform: 'uppercase', flexShrink: 0
      }}>
        {conf.label}
      </span>
      <span style={{ color: '#ccc', fontSize: 12, flex: 1 }}>
        <strong>{directive.entity_name || directive.entity_id}</strong>
        {directive.target_action !== 'any' && <span style={{ color: '#888' }}> ({directive.target_action})</span>}
        {' — '}{directive.reason}
      </span>
      <span style={{ color: '#666', fontSize: 10, flexShrink: 0 }}>
        {directive.status === 'applied' ? 'Aplicada' : `${timeLeft}m restante`}
      </span>
      {directive.score_modifier !== 0 && (
        <span style={{
          fontSize: 10, fontWeight: 600, flexShrink: 0,
          color: directive.score_modifier > 0 ? '#22c55e' : '#ef4444'
        }}>
          {directive.score_modifier > 0 ? '+' : ''}{directive.score_modifier.toFixed(2)}
        </span>
      )}
    </div>
  );
}

function ActionButton({ icon, label, color, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '8px 14px', borderRadius: 6,
        backgroundColor: `${color}15`, border: `1px solid ${color}40`,
        color, fontSize: 12, fontWeight: 500, cursor: 'pointer',
        fontFamily: 'Inter, system-ui, sans-serif'
      }}
    >
      {icon} {label}
    </button>
  );
}
