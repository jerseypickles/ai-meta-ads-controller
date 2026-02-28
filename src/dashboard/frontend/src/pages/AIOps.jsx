import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Activity, Brain, Bot, Clock, AlertTriangle, CheckCircle, XCircle,
  TrendingUp, TrendingDown, DollarSign, Eye, Zap, RefreshCw,
  ChevronDown, ChevronRight, Image, Pause, Play, Target, Skull,
  ArrowDown, Shield, Timer, Power, Filter, Palette
} from 'lucide-react';
import { getAIOpsStatus, runAIManager, runAgents, refreshAIOpsMetrics } from '../api';

// ═══ HELPERS ═══
const fmt = (v, d = 2) => v != null ? Number(v).toFixed(d) : '0';
const fmtCurrency = (v) => `$${fmt(v, 2)}`;
const timeAgo = (minutes) => {
  if (minutes == null) return 'Never';
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
};

const URGENCY_COLORS = {
  critical: { bg: '#7f1d1d', border: '#dc2626', text: '#fca5a5' },
  high: { bg: '#78350f', border: '#f59e0b', text: '#fde68a' },
  medium: { bg: '#1e3a5f', border: '#3b82f6', text: '#93c5fd' },
  low: { bg: '#14532d', border: '#22c55e', text: '#86efac' }
};

const CATEGORY_LABELS = {
  low_roas: 'ROAS Bajo', high_cpa: 'CPA Alto', creative_fatigue: 'Fatiga Creativa',
  no_conversions: 'Sin Conversiones', budget_waste: 'Desperdicio', strong_performer: 'Buen Rendimiento',
  recovery_signal: 'Recuperacion', learning_phase: 'Learning', audience_saturation: 'Saturacion', other: 'Otro'
};

const PHASE_COLORS = {
  learning: '#3b82f6', evaluating: '#f59e0b', scaling: '#10b981',
  stable: '#22c55e', killing: '#ef4444', dead: '#6b7280', activating: '#8b5cf6'
};

const STATUS_CONFIG = {
  ACTIVE: { label: 'ACTIVE', color: '#22c55e', bg: '#14532d', icon: Play },
  PAUSED: { label: 'PAUSED', color: '#ef4444', bg: '#7f1d1d', icon: Pause },
  DELETED: { label: 'DELETED', color: '#6b7280', bg: '#374151', icon: XCircle },
  ARCHIVED: { label: 'ARCHIVED', color: '#6b7280', bg: '#374151', icon: XCircle }
};

const FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused / Off' },
  { value: 'dead', label: 'Dead / Killing' }
];

// ═══ STAT BADGE ═══
const StatBadge = ({ icon: Icon, iconColor, label, value, subValue, subColor }) => (
  <div style={{
    backgroundColor: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: '12px',
    padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '160px'
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <Icon size={15} color={iconColor} />
      <span style={{ fontSize: '11px', color: '#9ca3af', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </span>
    </div>
    <div style={{ fontSize: '22px', fontWeight: '700', color: '#fff' }}>{value}</div>
    {subValue && <div style={{ fontSize: '12px', color: subColor || '#6b7280' }}>{subValue}</div>}
  </div>
);

// ═══ AD ROW (creative inside an ad set) ═══
const AdRow = ({ ad }) => {
  const isActive = ad.status === 'ACTIVE';
  const m = ad.metrics_7d || {};
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '24px 1fr 70px 70px 60px 55px 60px',
      gap: '8px', alignItems: 'center', padding: '8px 12px',
      backgroundColor: isActive ? '#111827' : '#0d0d12',
      borderRadius: '6px', opacity: isActive ? 1 : 0.6
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {isActive
          ? <Play size={12} color="#22c55e" fill="#22c55e" />
          : <Pause size={12} color="#ef4444" />
        }
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
        <span style={{ fontSize: '12px', color: '#e5e7eb', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ad.ad_name || ad.ad_id}
        </span>
        {ad.creative && (
          <span style={{ fontSize: '10px', color: '#6b7280', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Image size={10} /> {ad.creative.style || 'N/A'} — {ad.creative.headline?.substring(0, 40) || ''}
          </span>
        )}
      </div>
      <span style={{ fontSize: '12px', color: '#9ca3af', textAlign: 'right' }}>{fmtCurrency(m.spend)}</span>
      <span style={{
        fontSize: '12px', fontWeight: '600', textAlign: 'right',
        color: (m.roas || 0) >= 3 ? '#22c55e' : (m.roas || 0) >= 1.5 ? '#f59e0b' : '#ef4444'
      }}>{fmt(m.roas)}x</span>
      <span style={{ fontSize: '12px', color: '#9ca3af', textAlign: 'right' }}>{m.purchases || 0}</span>
      <span style={{ fontSize: '12px', color: '#9ca3af', textAlign: 'right' }}>{fmt(m.ctr, 1)}%</span>
      <span style={{
        fontSize: '12px', textAlign: 'right',
        color: (m.frequency || 0) > 4 ? '#ef4444' : (m.frequency || 0) > 3 ? '#f59e0b' : '#9ca3af'
      }}>{fmt(m.frequency, 1)}</span>
    </div>
  );
};

// ═══ AD SET CARD ═══
const AdSetCard = ({ adset }) => {
  const [expanded, setExpanded] = useState(false);
  const m7 = adset.metrics_7d || {};
  const phase = adset.phase || 'unknown';
  const phaseColor = PHASE_COLORS[phase] || '#6b7280';
  const activeAds = (adset.ads || []).filter(a => a.status === 'ACTIVE');
  const pausedAds = (adset.ads || []).filter(a => a.status !== 'ACTIVE');
  const hasDirectives = (adset.directives || []).length > 0;
  const criticalDirectives = (adset.directives || []).filter(d => d.urgency === 'critical');

  const isActive = adset.status === 'ACTIVE';
  const isDead = phase === 'dead' || phase === 'killing';
  const isPaused = !isActive;
  const statusCfg = STATUS_CONFIG[adset.status] || STATUS_CONFIG.PAUSED;
  const isStale = adset.snapshot_age_min != null && adset.snapshot_age_min > 120;

  // Card border and glow based on status
  const cardBorder = isDead ? '#6b728044' : isPaused ? '#ef444466' : criticalDirectives.length > 0 ? '#dc2626' : '#2a2d3a';
  const cardGlow = isDead ? 'none' : isPaused ? '0 0 8px rgba(239,68,68,0.1)' : criticalDirectives.length > 0 ? '0 0 12px rgba(220,38,38,0.15)' : 'none';

  return (
    <div style={{
      backgroundColor: isDead ? '#0a0b10' : isPaused ? '#12141d' : '#12141d',
      border: `1px solid ${cardBorder}`,
      borderRadius: '12px', overflow: 'hidden',
      boxShadow: cardGlow,
      opacity: isDead ? 0.55 : isPaused ? 0.85 : 1
    }}>
      {/* PAUSED / OFF Banner — prominent visual indicator */}
      {isPaused && (
        <div style={{
          padding: '6px 16px', display: 'flex', alignItems: 'center', gap: '8px',
          backgroundColor: isDead ? '#1f2937' : '#7f1d1d',
          borderBottom: `1px solid ${isDead ? '#374151' : '#dc262666'}`
        }}>
          <Power size={13} color={isDead ? '#6b7280' : '#fca5a5'} />
          <span style={{
            fontSize: '11px', fontWeight: '700', color: isDead ? '#9ca3af' : '#fca5a5',
            textTransform: 'uppercase', letterSpacing: '0.08em'
          }}>
            {isDead ? 'DEAD — Ad Set eliminado o agotado' : `AD SET ${statusCfg.label} — No esta corriendo en Meta`}
          </span>
          {adset.verdict && (
            <span style={{ fontSize: '10px', color: '#6b7280', marginLeft: 'auto' }}>
              Verdict: {adset.verdict}
            </span>
          )}
        </div>
      )}

      {/* Header */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '14px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px',
          borderBottom: expanded ? '1px solid #2a2d3a' : 'none'
        }}
      >
        {expanded ? <ChevronDown size={16} color="#6b7280" /> : <ChevronRight size={16} color="#6b7280" />}

        {/* Phase badge */}
        <span style={{
          fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '4px',
          backgroundColor: phaseColor + '22', color: phaseColor, border: `1px solid ${phaseColor}44`,
          textTransform: 'uppercase', letterSpacing: '0.05em'
        }}>{phase}</span>

        {/* Status badge — clear ACTIVE/PAUSED indicator */}
        <span style={{
          fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '4px',
          backgroundColor: statusCfg.bg, color: statusCfg.color,
          border: `1px solid ${statusCfg.color}66`,
          textTransform: 'uppercase', letterSpacing: '0.05em',
          display: 'flex', alignItems: 'center', gap: '4px'
        }}>
          {isActive
            ? <Play size={9} color="#22c55e" fill="#22c55e" />
            : <Pause size={9} color="#ef4444" />
          }
          {statusCfg.label}
        </span>

        {/* Stale data warning */}
        {isStale && (
          <span title={`Data is ${timeAgo(adset.snapshot_age_min)} old`} style={{
            fontSize: '9px', fontWeight: '700', padding: '2px 6px', borderRadius: '4px',
            backgroundColor: '#78350f', color: '#fde68a', border: '1px solid #f59e0b44',
            display: 'flex', alignItems: 'center', gap: '3px'
          }}>
            <AlertTriangle size={9} /> STALE
          </span>
        )}

        {/* Name */}
        <span style={{
          fontSize: '14px', fontWeight: '600', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: isDead ? '#6b7280' : isPaused ? '#9ca3af' : '#e5e7eb',
          textDecoration: isDead ? 'line-through' : 'none'
        }}>
          {adset.adset_name}
        </span>

        {/* Quick metrics */}
        <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexShrink: 0 }}>
          <span style={{ fontSize: '12px', color: '#9ca3af' }}>
            <DollarSign size={11} style={{ display: 'inline' }} /> {fmtCurrency(m7.spend)}
          </span>
          <span style={{
            fontSize: '13px', fontWeight: '700',
            color: (m7.roas || 0) >= 3 ? '#22c55e' : (m7.roas || 0) >= 1.5 ? '#f59e0b' : '#ef4444'
          }}>{fmt(m7.roas)}x</span>
          <span style={{ fontSize: '12px', color: '#9ca3af' }}>{m7.purchases || 0} purch</span>
          <span style={{ fontSize: '12px', color: '#6b7280' }}>
            {activeAds.length} ON / {pausedAds.length} OFF
          </span>
          {adset.frequency_status && adset.frequency_status !== 'unknown' && adset.frequency_status !== 'ok' && (
            <span style={{
              fontSize: '10px', fontWeight: '700', padding: '2px 6px', borderRadius: '4px',
              backgroundColor: adset.frequency_status === 'critical' ? '#7f1d1d' : adset.frequency_status === 'high' ? '#78350f' : '#1e3a5f',
              color: adset.frequency_status === 'critical' ? '#fca5a5' : adset.frequency_status === 'high' ? '#fde68a' : '#93c5fd',
              border: `1px solid ${adset.frequency_status === 'critical' ? '#dc2626' : adset.frequency_status === 'high' ? '#f59e0b' : '#3b82f6'}`
            }}>
              FREQ {adset.frequency_status.toUpperCase()}
            </span>
          )}
          {hasDirectives && (
            <span style={{
              fontSize: '10px', fontWeight: '700', padding: '2px 6px', borderRadius: '4px',
              backgroundColor: criticalDirectives.length > 0 ? '#7f1d1d' : '#1e3a5f',
              color: criticalDirectives.length > 0 ? '#fca5a5' : '#93c5fd',
              border: `1px solid ${criticalDirectives.length > 0 ? '#dc2626' : '#3b82f6'}`
            }}>
              {adset.directives.length} DIR
            </span>
          )}
        </div>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div style={{ padding: '0 16px 16px' }}>
          {/* Stale data warning */}
          {isStale && (
            <div style={{
              padding: '8px 12px', backgroundColor: '#78350f22', border: '1px solid #f59e0b33',
              borderRadius: '6px', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '8px',
              fontSize: '12px', color: '#fde68a'
            }}>
              <AlertTriangle size={14} color="#f59e0b" />
              Datos desactualizados — ultima actualizacion hace {timeAgo(adset.snapshot_age_min)}. Las metricas pueden no reflejar el estado real.
            </div>
          )}

          {/* Last action / breathing indicator */}
          {(adset.recent_actions || []).length > 0 && (() => {
            const lastAction = adset.recent_actions[0];
            const hoursAgo = lastAction.hours_ago || 0;
            const isBreathing = hoursAgo < 12;
            return isBreathing ? (
              <div style={{
                padding: '8px 12px', backgroundColor: '#1e3a5f22', border: '1px solid #3b82f633',
                borderRadius: '6px', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '8px',
                fontSize: '12px', color: '#93c5fd'
              }}>
                <Timer size={14} color="#3b82f6" />
                Respirando — ultima accion hace {hoursAgo}h ({lastAction.action}). Proximo analisis de Claude en ~{Math.max(1, 12 - hoursAgo)}h. (Decision tree sigue activo)
              </div>
            ) : null;
          })()}

          {/* Info row */}
          <div style={{
            display: 'flex', gap: '20px', padding: '12px 0', fontSize: '12px', color: '#9ca3af',
            borderBottom: '1px solid #1f2937', marginBottom: '12px', flexWrap: 'wrap'
          }}>
            <span>Budget: <b style={{ color: '#e5e7eb' }}>{fmtCurrency(adset.budget)}/d</b></span>
            <span>Days: <b style={{ color: '#e5e7eb' }}>{fmt(adset.days_active, 1)}</b></span>
            <span>CPA: <b style={{ color: '#e5e7eb' }}>{fmtCurrency(m7.cpa)}</b></span>
            <span>Freq: <b style={{
              color: (m7.frequency || 0) > 4 ? '#ef4444' : (m7.frequency || 0) > 3 ? '#f59e0b' : '#e5e7eb'
            }}>{fmt(m7.frequency, 1)}</b></span>
            <span>CTR: <b style={{ color: '#e5e7eb' }}>{fmt(m7.ctr, 2)}%</b></span>
            <span>3d ROAS: <b style={{ color: '#e5e7eb' }}>{fmt(adset.metrics_3d?.roas)}x</b></span>
            <span>Today: <b style={{ color: '#e5e7eb' }}>{fmtCurrency(adset.metrics_today?.spend)} / {fmt(adset.metrics_today?.roas)}x</b></span>
            <span>Meta Status: <b style={{ color: isActive ? '#22c55e' : '#ef4444' }}>{adset.status || 'UNKNOWN'}</b></span>
            {adset.last_manager_check && (
              <span>Last check: <b style={{ color: '#e5e7eb' }}>{timeAgo(Math.round((Date.now() - new Date(adset.last_manager_check)) / 60000))}</b></span>
            )}
          </div>

          {/* Assessment */}
          {adset.last_assessment && (
            <div style={{
              padding: '8px 12px', backgroundColor: '#0d0f17', borderRadius: '6px',
              fontSize: '12px', color: '#9ca3af', marginBottom: '12px', lineHeight: '1.5'
            }}>
              <b style={{ color: '#6b7280' }}>AI Assessment:</b> {adset.last_assessment.substring(0, 300)}
            </div>
          )}

          {/* Creative Health */}
          {adset.creative_health && (
            <div style={{
              padding: '8px 12px', backgroundColor: '#1a0d2e', border: '1px solid #7c3aed33',
              borderRadius: '6px', fontSize: '12px', color: '#c4b5fd', marginBottom: '12px', lineHeight: '1.5'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                <Palette size={13} color="#a78bfa" />
                <b style={{ color: '#a78bfa' }}>Creative Health:</b>
              </div>
              {adset.creative_health}
            </div>
          )}

          {/* Ads / Creatives */}
          <div style={{ marginBottom: '12px' }}>
            <div style={{
              display: 'grid', gridTemplateColumns: '24px 1fr 70px 70px 60px 55px 60px',
              gap: '8px', padding: '4px 12px', fontSize: '10px', color: '#6b7280',
              fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em'
            }}>
              <span></span><span>Ad / Creative</span>
              <span style={{ textAlign: 'right' }}>Spend</span>
              <span style={{ textAlign: 'right' }}>ROAS</span>
              <span style={{ textAlign: 'right' }}>Purch</span>
              <span style={{ textAlign: 'right' }}>CTR</span>
              <span style={{ textAlign: 'right' }}>Freq</span>
            </div>
            {(adset.ads || []).map((ad, i) => <AdRow key={ad.ad_id || i} ad={ad} />)}
            {(!adset.ads || adset.ads.length === 0) && (
              <div style={{ padding: '12px', textAlign: 'center', fontSize: '12px', color: '#4b5563' }}>
                No ads found
              </div>
            )}
          </div>

          {/* Directives from Brain */}
          {hasDirectives && (
            <div style={{ marginBottom: '12px' }}>
              <div style={{ fontSize: '11px', fontWeight: '700', color: '#6b7280', textTransform: 'uppercase', marginBottom: '6px', letterSpacing: '0.05em' }}>
                Brain Directives ({adset.directives.length})
              </div>
              {adset.directives.map((d, i) => {
                const urg = URGENCY_COLORS[d.urgency] || URGENCY_COLORS.medium;
                return (
                  <div key={i} style={{
                    padding: '8px 12px', backgroundColor: urg.bg + '44', border: `1px solid ${urg.border}33`,
                    borderRadius: '6px', marginBottom: '4px', display: 'flex', gap: '8px', alignItems: 'flex-start'
                  }}>
                    <span style={{
                      fontSize: '9px', fontWeight: '700', padding: '2px 6px', borderRadius: '3px',
                      backgroundColor: urg.bg, color: urg.text, border: `1px solid ${urg.border}`,
                      flexShrink: 0, textTransform: 'uppercase'
                    }}>{d.urgency}</span>
                    <span style={{
                      fontSize: '10px', padding: '2px 6px', borderRadius: '3px',
                      backgroundColor: '#1f2937', color: '#9ca3af', flexShrink: 0
                    }}>{CATEGORY_LABELS[d.category] || d.category}</span>
                    <span style={{ fontSize: '11px', color: '#d1d5db', flex: 1, lineHeight: '1.4' }}>
                      {d.type}/{d.target_action} — {d.reason?.replace('[BRAIN→AI-MANAGER] ', '').substring(0, 150)}
                    </span>
                    <span style={{ fontSize: '10px', color: '#6b7280', flexShrink: 0 }}>{d.hours_ago}h ago</span>
                    {d.consecutive_count > 1 && (
                      <span style={{
                        fontSize: '9px', fontWeight: '700', padding: '2px 6px', borderRadius: '3px',
                        backgroundColor: '#78350f', color: '#fde68a', flexShrink: 0
                      }}>x{d.consecutive_count}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Recent actions */}
          {(adset.recent_actions || []).length > 0 && (
            <div>
              <div style={{ fontSize: '11px', fontWeight: '700', color: '#6b7280', textTransform: 'uppercase', marginBottom: '6px', letterSpacing: '0.05em' }}>
                Recent Actions ({adset.recent_actions.length})
              </div>
              {adset.recent_actions.slice(0, 5).map((a, i) => (
                <div key={i} style={{
                  padding: '6px 12px', backgroundColor: '#111827', borderRadius: '6px', marginBottom: '3px',
                  display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px'
                }}>
                  <span style={{
                    color: a.success ? '#22c55e' : '#ef4444', flexShrink: 0
                  }}>{a.success ? <CheckCircle size={12} /> : <XCircle size={12} />}</span>
                  <span style={{ color: '#e5e7eb', fontWeight: '600' }}>{a.action}</span>
                  {a.change_pct != null && (
                    <span style={{ color: a.change_pct > 0 ? '#22c55e' : '#ef4444', fontSize: '11px' }}>
                      {a.change_pct > 0 ? '+' : ''}{a.change_pct}%
                    </span>
                  )}
                  <span style={{ color: '#6b7280', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.reasoning?.replace(/\[.*?\]\s*/g, '').substring(0, 100)}
                  </span>
                  <span style={{ color: '#4b5563', flexShrink: 0 }}>{a.hours_ago}h ago</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ═══ TIMELINE EVENT ═══
const TimelineEvent = ({ event }) => {
  const typeConfig = {
    ai_manager_action: { icon: Bot, color: '#ec4899', label: 'AI Manager' },
    decision_tree: { icon: Skull, color: '#ef4444', label: 'Decision Tree' },
    brain_directive: { icon: Brain, color: '#3b82f6', label: 'Brain' },
    safety_event: { icon: Shield, color: '#f59e0b', label: 'Safety' }
  };
  const cfg = typeConfig[event.type] || typeConfig.ai_manager_action;
  const Icon = cfg.icon;
  const ts = new Date(event.timestamp);
  const minsAgo = Math.round((Date.now() - ts) / 60000);

  return (
    <div style={{
      display: 'flex', gap: '10px', padding: '8px 0',
      borderBottom: '1px solid #1f293722'
    }}>
      <div style={{
        width: '28px', height: '28px', borderRadius: '50%',
        backgroundColor: cfg.color + '22', border: `1px solid ${cfg.color}44`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
      }}>
        <Icon size={13} color={cfg.color} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '2px' }}>
          <span style={{ fontSize: '10px', fontWeight: '700', color: cfg.color, textTransform: 'uppercase' }}>{cfg.label}</span>
          <span style={{ fontSize: '12px', fontWeight: '600', color: '#e5e7eb' }}>{event.entity_name}</span>
          <span style={{ fontSize: '11px', color: '#9ca3af' }}>{event.action}</span>
          {event.change && <span style={{ fontSize: '11px', color: String(event.change).startsWith('+') ? '#22c55e' : '#ef4444', fontWeight: '600' }}>{event.change}</span>}
          {event.urgency && event.urgency !== 'medium' && (
            <span style={{
              fontSize: '9px', fontWeight: '700', padding: '1px 5px', borderRadius: '3px',
              backgroundColor: (URGENCY_COLORS[event.urgency] || {}).bg || '#1e3a5f',
              color: (URGENCY_COLORS[event.urgency] || {}).text || '#93c5fd',
              textTransform: 'uppercase'
            }}>{event.urgency}</span>
          )}
        </div>
        <div style={{ fontSize: '11px', color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {event.detail?.replace(/\[.*?\]\s*/g, '').substring(0, 200)}
        </div>
      </div>
      <span style={{ fontSize: '11px', color: '#4b5563', flexShrink: 0, whiteSpace: 'nowrap' }}>
        {timeAgo(minsAgo)}
      </span>
    </div>
  );
};

// ═══ DECISION TREE EVENTS ═══
const DecisionTreeCard = ({ events }) => {
  if (!events || events.length === 0) return null;
  return (
    <div style={{
      backgroundColor: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: '12px',
      padding: '16px', marginBottom: '16px'
    }}>
      <div style={{
        fontSize: '13px', fontWeight: '700', color: '#ef4444', marginBottom: '12px',
        display: 'flex', alignItems: 'center', gap: '8px'
      }}>
        <Skull size={16} /> Decision Tree — Forced Actions (7d)
      </div>
      {events.map((e, i) => (
        <div key={i} style={{
          padding: '10px 12px', backgroundColor: '#1c0d0d', border: '1px solid #dc262633',
          borderRadius: '8px', marginBottom: '6px'
        }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px' }}>
            <span style={{
              fontSize: '11px', fontWeight: '700', padding: '2px 8px', borderRadius: '4px',
              backgroundColor: e.action === 'pause' ? '#7f1d1d' : '#78350f',
              color: e.action === 'pause' ? '#fca5a5' : '#fde68a'
            }}>{e.action === 'pause' ? 'KILL' : 'SCALE DOWN'}</span>
            <span style={{ fontSize: '13px', fontWeight: '600', color: '#e5e7eb' }}>{e.entity_name}</span>
            {e.change_pct != null && (
              <span style={{ fontSize: '12px', color: '#ef4444' }}>{e.change_pct}%</span>
            )}
            <span style={{ fontSize: '11px', color: '#4b5563', marginLeft: 'auto' }}>{e.hours_ago}h ago</span>
          </div>
          <div style={{ fontSize: '11px', color: '#9ca3af', lineHeight: '1.4' }}>
            {e.reasoning?.replace(/\[.*?\]\s*/g, '')}
          </div>
        </div>
      ))}
    </div>
  );
};

// ═══ MAIN PAGE ═══
export default function AIOps() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(null); // 'manager' | 'brain' | null
  const [statusFilter, setStatusFilter] = useState('all');

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const result = await getAIOpsStatus();
      if (result && result.ai_manager) {
        setData(result);
      } else if (result && result.error) {
        setError(result.error);
      } else {
        setData(result || {});
      }
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000); // Auto-refresh every 60s
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleRunManager = async () => {
    setRunning('manager');
    try {
      await runAIManager();
      await fetchData();
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(null);
    }
  };

  const handleRunBrain = async () => {
    setRunning('brain');
    try {
      await runAgents();
      await fetchData();
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(null);
    }
  };

  const handleRefreshMetrics = async () => {
    setRunning('refresh');
    try {
      await refreshAIOpsMetrics();
      await fetchData();
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(null);
    }
  };

  const mgr = data?.ai_manager || {};
  const brain = data?.brain || {};
  const compliance = data?.compliance || {};
  const dirSummary = data?.directive_summary || {};
  const adSets = data?.adsets || [];
  const timeline = data?.timeline || [];
  const dtEvents = data?.decision_tree_events || [];

  // Status counts for stat badge
  const statusCounts = useMemo(() => {
    const counts = { active: 0, paused: 0, dead: 0, total: adSets.length };
    for (const as of adSets) {
      if (as.phase === 'dead' || as.phase === 'killing') counts.dead++;
      else if (as.status === 'ACTIVE') counts.active++;
      else counts.paused++;
    }
    return counts;
  }, [adSets]);

  // Filtered and sorted ad sets: active first, then paused, then dead
  const filteredAdSets = useMemo(() => {
    let filtered = adSets;
    if (statusFilter === 'active') {
      filtered = adSets.filter(as => as.status === 'ACTIVE' && as.phase !== 'dead' && as.phase !== 'killing');
    } else if (statusFilter === 'paused') {
      filtered = adSets.filter(as => as.status !== 'ACTIVE' && as.phase !== 'dead' && as.phase !== 'killing');
    } else if (statusFilter === 'dead') {
      filtered = adSets.filter(as => as.phase === 'dead' || as.phase === 'killing');
    }
    // Sort: active first, then paused, then dead/killing
    return [...filtered].sort((a, b) => {
      const order = (as) => {
        if (as.phase === 'dead' || as.phase === 'killing') return 2;
        if (as.status !== 'ACTIVE') return 1;
        return 0;
      };
      return order(a) - order(b);
    });
  }, [adSets, statusFilter]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: '#6b7280' }}>
        <RefreshCw size={20} style={{ animation: 'spin 1s linear infinite' }} />
        <span style={{ marginLeft: '10px' }}>Loading AI Operations...</span>
      </div>
    );
  }

  if (!data && error) {
    return (
      <div style={{ maxWidth: '1400px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#fff', margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Activity size={22} color="#3b82f6" /> AI Operations
        </h1>
        <div style={{ padding: '20px', backgroundColor: '#7f1d1d', border: '1px solid #dc2626', borderRadius: '12px', color: '#fca5a5', fontSize: '14px' }}>
          Error loading data: {error}
          <button onClick={() => { setLoading(true); fetchData(); }} style={{
            marginLeft: '16px', padding: '6px 12px', borderRadius: '6px', border: '1px solid #dc2626',
            backgroundColor: '#991b1b', color: '#fca5a5', cursor: 'pointer', fontSize: '12px'
          }}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '1400px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#fff', margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Activity size={22} color="#3b82f6" /> AI Operations
          </h1>
          <p style={{ fontSize: '13px', color: '#6b7280', margin: '4px 0 0' }}>
            Brain + AI Manager: todo lo que esta pasando en tiempo real
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={handleRunManager}
            disabled={running != null}
            style={{
              padding: '8px 16px', borderRadius: '8px', border: '1px solid #ec489944',
              backgroundColor: running === 'manager' ? '#831843' : '#12141d',
              color: '#ec4899', fontSize: '12px', fontWeight: '600', cursor: running ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: '6px', opacity: running && running !== 'manager' ? 0.5 : 1
            }}
          >
            {running === 'manager' ? <RefreshCw size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Bot size={13} />}
            Run AI Manager
          </button>
          <button
            onClick={handleRunBrain}
            disabled={running != null}
            style={{
              padding: '8px 16px', borderRadius: '8px', border: '1px solid #3b82f644',
              backgroundColor: running === 'brain' ? '#1e3a8a' : '#12141d',
              color: '#3b82f6', fontSize: '12px', fontWeight: '600', cursor: running ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: '6px', opacity: running && running !== 'brain' ? 0.5 : 1
            }}
          >
            {running === 'brain' ? <RefreshCw size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Brain size={13} />}
            Run Brain
          </button>
          <button
            onClick={handleRefreshMetrics}
            disabled={running != null}
            style={{
              padding: '8px 16px', borderRadius: '8px', border: '1px solid #10b98144',
              backgroundColor: running === 'refresh' ? '#064e3b' : '#12141d',
              color: '#10b981', fontSize: '12px', fontWeight: '600', cursor: running ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: '6px', opacity: running && running !== 'refresh' ? 0.5 : 1
            }}
          >
            {running === 'refresh' ? <RefreshCw size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Zap size={13} />}
            Refresh Metrics
          </button>
          <button
            onClick={() => { setLoading(true); fetchData(); }}
            style={{
              padding: '8px 12px', borderRadius: '8px', border: '1px solid #2a2d3a',
              backgroundColor: '#12141d', color: '#6b7280', cursor: 'pointer', display: 'flex', alignItems: 'center'
            }}
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: '12px 16px', backgroundColor: '#7f1d1d', border: '1px solid #dc2626', borderRadius: '8px', marginBottom: '16px', color: '#fca5a5', fontSize: '13px' }}>
          Error: {error}
        </div>
      )}

      {/* Top stat badges */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatBadge
          icon={Bot} iconColor="#ec4899" label="AI Manager"
          value={mgr.minutes_since_last_run != null ? timeAgo(mgr.minutes_since_last_run) : 'Never'}
          subValue={`${mgr.actions_48h || 0} actions (48h)`}
          subColor="#9ca3af"
        />
        <StatBadge
          icon={Brain} iconColor="#3b82f6" label="Brain"
          value={brain.minutes_ago != null ? timeAgo(brain.minutes_ago) : 'Never'}
          subValue={brain.status || 'N/A'}
          subColor={brain.status === 'critical' ? '#ef4444' : brain.status === 'warning' ? '#f59e0b' : '#22c55e'}
        />
        <StatBadge
          icon={Target} iconColor="#f59e0b" label="Compliance"
          value={`${compliance.rate || 0}%`}
          subValue={`${compliance.acted_on || 0} acted / ${compliance.ignored || 0} ignored`}
          subColor={compliance.rate < 50 ? '#ef4444' : compliance.rate < 80 ? '#f59e0b' : '#22c55e'}
        />
        <StatBadge
          icon={Zap} iconColor="#a78bfa" label="Directives"
          value={dirSummary.total_active || 0}
          subValue={`${dirSummary.by_urgency?.critical || 0} critical, ${dirSummary.by_urgency?.high || 0} high`}
          subColor={(dirSummary.by_urgency?.critical || 0) > 0 ? '#ef4444' : '#9ca3af'}
        />
        <StatBadge
          icon={Eye} iconColor="#22c55e" label="Ad Sets"
          value={`${statusCounts.active} ON / ${statusCounts.paused + statusCounts.dead} OFF`}
          subValue={`${statusCounts.total} total — ${statusCounts.dead} dead — ${dtEvents.length} forced (7d)`}
          subColor={statusCounts.paused > 0 || statusCounts.dead > 0 ? '#f59e0b' : '#9ca3af'}
        />
      </div>

      {/* Decision tree forced events */}
      <DecisionTreeCard events={dtEvents} />

      {/* Ad Sets detail */}
      <div style={{ marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <h2 style={{ fontSize: '15px', fontWeight: '700', color: '#e5e7eb', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Bot size={16} color="#ec4899" /> Managed Ad Sets
            <span style={{ fontSize: '12px', color: '#6b7280', fontWeight: '400' }}>
              — click to expand
            </span>
          </h2>

          {/* Status filter */}
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <Filter size={13} color="#6b7280" />
            {FILTER_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setStatusFilter(opt.value)}
                style={{
                  padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: '600',
                  cursor: 'pointer', border: '1px solid',
                  backgroundColor: statusFilter === opt.value ? '#1e3a5f' : '#12141d',
                  borderColor: statusFilter === opt.value ? '#3b82f6' : '#2a2d3a',
                  color: statusFilter === opt.value ? '#93c5fd' : '#6b7280'
                }}
              >
                {opt.label}
                {opt.value === 'active' && ` (${statusCounts.active})`}
                {opt.value === 'paused' && ` (${statusCounts.paused})`}
                {opt.value === 'dead' && ` (${statusCounts.dead})`}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {filteredAdSets.map((as, i) => <AdSetCard key={as.adset_id || i} adset={as} />)}
          {filteredAdSets.length === 0 && (
            <div style={{ padding: '40px', textAlign: 'center', color: '#4b5563', fontSize: '14px', backgroundColor: '#12141d', borderRadius: '12px' }}>
              {statusFilter === 'all' ? 'No managed ad sets' : `No ad sets with filter "${statusFilter}"`}
            </div>
          )}
        </div>
      </div>

      {/* Timeline */}
      <div style={{
        backgroundColor: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: '12px',
        padding: '16px'
      }}>
        <h2 style={{ fontSize: '15px', fontWeight: '700', color: '#e5e7eb', margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Clock size={16} color="#3b82f6" /> Activity Timeline
        </h2>
        <div style={{ maxHeight: '500px', overflowY: 'auto' }}>
          {timeline.map((event, i) => <TimelineEvent key={i} event={event} />)}
          {timeline.length === 0 && (
            <div style={{ padding: '20px', textAlign: 'center', color: '#4b5563', fontSize: '13px' }}>
              No activity yet
            </div>
          )}
        </div>
      </div>

      {/* Spin keyframe */}
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
