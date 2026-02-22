import React, { useState, useEffect, useCallback } from 'react';
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  Eye,
  Gauge,
  Clock,
  CheckCircle,
  AlertTriangle,
  BarChart3,
  ArrowRight,
  Zap,
  Minus,
  Copy,
  PlusCircle,
  Target,
  ToggleRight,
  ArrowLeftRight,
  Palette,
  Ban
} from 'lucide-react';
import { getActionsWithImpact, getBrainReadiness, getAutonomyConfig, updateAutonomyConfig } from '../api';

const AGENT_CONFIG = {
  brain: { label: 'Cerebro IA', color: '#3b82f6', bg: '#1e3a8a' },
  scaling: { label: 'Escalamiento', color: '#10b981', bg: '#065f46' },
  performance: { label: 'Rendimiento', color: '#3b82f6', bg: '#1e3a8a' },
  creative: { label: 'Creativos', color: '#f59e0b', bg: '#78350f' },
  pacing: { label: 'Pacing', color: '#8b5cf6', bg: '#4c1d95' },
  ai_manager: { label: 'AI Manager', color: '#ec4899', bg: '#831843' },
  unknown: { label: 'Sin etiqueta', color: '#9ca3af', bg: '#374151' }
};

const ACTION_LABELS = {
  scale_up: { label: 'Subir Budget', color: '#10b981', icon: TrendingUp },
  scale_down: { label: 'Bajar Budget', color: '#f59e0b', icon: TrendingDown },
  pause: { label: 'Pausar', color: '#ef4444', icon: Minus },
  reactivate: { label: 'Reactivar', color: '#3b82f6', icon: Zap },
  duplicate_adset: { label: 'Duplicar Ad Set', color: '#8b5cf6', icon: Copy },
  create_ad: { label: 'Crear Anuncio', color: '#06b6d4', icon: PlusCircle },
  update_bid_strategy: { label: 'Cambiar Puja', color: '#f97316', icon: Target },
  update_ad_status: { label: 'Estado Anuncio', color: '#a78bfa', icon: ToggleRight },
  move_budget: { label: 'Mover Budget', color: '#14b8a6', icon: ArrowLeftRight },
  update_ad_creative: { label: 'Cambiar Creativo', color: '#ec4899', icon: Palette },
  no_action: { label: 'Sin Accion', color: '#6b7280', icon: Ban }
};

const formatCurrency = (v) => {
  if (v == null) return '$0.00';
  return `$${Number(v).toFixed(2)}`;
};

const normalizeAgentType = (action) => {
  const raw = String(
    action?.agent_type
    || (action?.reasoning || '').match(/^\[(\w+)\]/)?.[1]
    || ''
  ).toLowerCase();
  if (raw === 'brain') return 'brain';
  if (['scaling', 'budget'].includes(raw)) return 'scaling';
  if (raw === 'performance') return 'performance';
  if (raw === 'creative') return 'creative';
  if (raw === 'pacing') return 'pacing';
  if (raw === 'ai_manager') return 'ai_manager';
  if (['unified_policy', 'unified'].includes(raw)) return 'scaling';
  return 'unknown';
};

// Stat card for top section
const StatCard = ({ icon: Icon, iconColor, label, value, subValue, subColor }) => (
  <div style={{
    backgroundColor: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: '12px',
    padding: '20px', display: 'flex', flexDirection: 'column', gap: '8px'
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <Icon size={16} color={iconColor} />
      <span style={{ fontSize: '12px', color: '#9ca3af', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </span>
    </div>
    <div style={{ fontSize: '28px', fontWeight: '700', color: '#fff', letterSpacing: '-0.02em' }}>
      {value}
    </div>
    {subValue && (
      <div style={{ fontSize: '12px', color: subColor || '#9ca3af' }}>
        {subValue}
      </div>
    )}
  </div>
);

// Individual action card in the timeline
const ActionCard = ({ action, isLast }) => {
  const agentType = normalizeAgentType(action);
  const agentConf = AGENT_CONFIG[agentType] || {};
  const actionInfo = ACTION_LABELS[action.action] || {};
  const ActionIcon = actionInfo.icon || ArrowRight;
  const isMeasuring = action.result === 'measuring';
  const isImproved = action.result === 'improved';
  const isWorsened = action.result === 'worsened';
  const isAuto = (action.reasoning || '').includes('[AUTO_');

  const before = action.metrics_at_execution || {};
  const after1d = action.metrics_after_1d || {};
  const after3d = action.metrics_after_3d || {};
  const after7d = action.metrics_after_7d || {};

  const date = action.executed_at
    ? new Date(action.executed_at).toLocaleDateString('es-CL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '--';

  // Result styling
  let resultBg, resultColor, resultLabel;
  if (isMeasuring) {
    resultBg = '#78350f'; resultColor = '#fcd34d'; resultLabel = `Midiendo... (${action.days_remaining || 0}d restantes)`;
  } else if (isImproved) {
    resultBg = '#065f46'; resultColor = '#6ee7b7'; resultLabel = 'Mejoro';
  } else if (isWorsened) {
    resultBg = '#7f1d1d'; resultColor = '#fca5a5'; resultLabel = 'Empeoro';
  } else {
    resultBg = '#374151'; resultColor = '#9ca3af'; resultLabel = 'Sin cambio significativo';
  }

  return (
    <div style={{ display: 'flex', gap: '16px' }}>
      {/* Timeline line */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '20px', flexShrink: 0 }}>
        <div style={{
          width: '12px', height: '12px', borderRadius: '50%',
          backgroundColor: isMeasuring ? '#fcd34d' : (isImproved ? '#6ee7b7' : (isWorsened ? '#fca5a5' : '#6b7280')),
          border: '2px solid #0f1117', zIndex: 1
        }} />
        {!isLast && (
          <div style={{ width: '2px', flex: 1, backgroundColor: '#2a2d3a', marginTop: '2px' }} />
        )}
      </div>

      {/* Card */}
      <div style={{
        flex: 1, backgroundColor: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: '10px',
        padding: '16px', marginBottom: '12px'
      }}>
        {/* Header row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{
              padding: '3px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: '700',
              backgroundColor: agentConf.bg || '#333', color: agentConf.color || '#fff'
            }}>
              {agentConf.label || agentType || '?'}
            </span>
            <span style={{
              display: 'flex', alignItems: 'center', gap: '4px',
              fontSize: '12px', fontWeight: '600', color: actionInfo.color || '#9ca3af'
            }}>
              <ActionIcon size={12} />
              {actionInfo.label || action.action}
            </span>
            {isAuto && (
              <span style={{
                padding: '2px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: '700',
                backgroundColor: '#1e3a8a', color: '#93c5fd'
              }}>
                AUTO
              </span>
            )}
          </div>
          <span style={{ fontSize: '11px', color: '#6b7280' }}>{date}</span>
        </div>

        {/* Entity name + action detail */}
        <div style={{ marginBottom: '12px' }}>
          <div style={{ fontSize: '14px', fontWeight: '600', color: '#e5e7eb', marginBottom: '4px' }}>
            {action.entity_name}
          </div>
          {['scale_up', 'scale_down'].includes(action.action) && (
            <div style={{ fontSize: '12px', color: '#9ca3af', display: 'flex', alignItems: 'center', gap: '6px' }}>
              {formatCurrency(action.before_value)}
              <ArrowRight size={12} color="#6b7280" />
              {formatCurrency(action.after_value)}
              <span style={{
                padding: '1px 6px', borderRadius: '4px', fontSize: '10px', fontWeight: '600',
                backgroundColor: action.change_percent > 0 ? '#065f4630' : '#7f1d1d30',
                color: action.change_percent > 0 ? '#6ee7b7' : '#fca5a5'
              }}>
                {action.change_percent > 0 ? '+' : ''}{(action.change_percent || 0).toFixed(0)}%
              </span>
            </div>
          )}
          {action.action === 'update_ad_status' && (
            <div style={{ fontSize: '12px', color: '#9ca3af', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{
                padding: '2px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: '700',
                backgroundColor: action.after_value === 0 || action.after_value === '0' ? '#7f1d1d30' : '#065f4630',
                color: action.after_value === 0 || action.after_value === '0' ? '#fca5a5' : '#6ee7b7'
              }}>
                {action.after_value === 0 || action.after_value === '0' ? 'PAUSADO' : 'ACTIVADO'}
              </span>
            </div>
          )}
          {action.action === 'pause' && (
            <div style={{ fontSize: '12px', color: '#ef4444', fontWeight: '600' }}>Pausado</div>
          )}
          {action.action === 'reactivate' && (
            <div style={{ fontSize: '12px', color: '#3b82f6', fontWeight: '600' }}>Reactivado</div>
          )}
          {action.action === 'move_budget' && (
            <div style={{ fontSize: '12px', color: '#9ca3af', display: 'flex', alignItems: 'center', gap: '6px' }}>
              {formatCurrency(action.before_value)} <ArrowRight size={12} color="#6b7280" /> {formatCurrency(action.after_value)}
              <span style={{ color: '#14b8a6', fontSize: '11px' }}>(movido)</span>
            </div>
          )}
          {action.action === 'duplicate_adset' && (
            <div style={{ fontSize: '12px', color: '#8b5cf6', fontWeight: '600' }}>
              Duplicado con ${action.after_value || '?'}/dia
            </div>
          )}
          {action.action === 'create_ad' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{
                padding: '2px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: '700',
                backgroundColor: '#06b6d420', color: '#06b6d4'
              }}>
                CREATIVO
              </span>
              <span style={{ fontSize: '12px', color: '#06b6d4', fontWeight: '600' }}>
                Nuevo ad creado
              </span>
            </div>
          )}
        </div>

        {/* Metrics grid — different layout for create_ad vs other actions */}
        {action.is_create_ad ? (
          /* === CREATE_AD: Show the new ad's own metrics progression === */
          <div style={{
            padding: '12px', backgroundColor: '#06b6d408', borderRadius: '8px',
            marginBottom: '12px', border: '1px solid #06b6d420'
          }}>
            <div style={{
              fontSize: '10px', color: '#06b6d4', fontWeight: '700', textTransform: 'uppercase',
              marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px'
            }}>
              <PlusCircle size={12} />
              Rendimiento del Ad Nuevo
              {action.ad_metrics?.status && (
                <span style={{
                  padding: '1px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: '700',
                  backgroundColor: action.ad_metrics.status === 'ACTIVE' ? '#065f4630' : '#7f1d1d30',
                  color: action.ad_metrics.status === 'ACTIVE' ? '#6ee7b7' : '#fca5a5',
                  marginLeft: 'auto'
                }}>
                  {action.ad_metrics.status}
                </span>
              )}
            </div>

            <div style={{
              display: 'grid', gridTemplateColumns: '1fr auto 1fr auto 1fr auto 1fr', gap: '6px',
              backgroundColor: '#13151d', borderRadius: '8px', padding: '12px'
            }}>
              {/* Inicio (nuevo ad = 0) */}
              <div>
                <div style={{ fontSize: '10px', color: '#6b7280', fontWeight: '600', textTransform: 'uppercase', marginBottom: '8px' }}>
                  Al crear
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <MetricLine label="ROAS" value="0.00x" />
                  <MetricLine label="Spend" value="$0.00" />
                  <MetricLine label="CTR" value="0.00%" />
                  <MetricLine label="Compras" value="0" />
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center' }}>
                <ArrowRight size={14} color="#2a2d3a" />
              </div>

              {/* 24h checkpoint */}
              <div>
                <div style={{ fontSize: '10px', color: '#a78bfa', fontWeight: '600', textTransform: 'uppercase', marginBottom: '8px' }}>
                  24 horas
                </div>
                {action.ad_metrics_1d ? (() => {
                  const am = action.ad_metrics_1d;
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <MetricLine label="ROAS" value={am.roas_7d != null ? `${am.roas_7d.toFixed(2)}x` : '--'} />
                      <MetricLine label="Spend" value={am.spend_7d != null ? formatCurrency(am.spend_7d) : '--'} />
                      <MetricLine label="CTR" value={am.ctr_7d != null ? `${am.ctr_7d.toFixed(2)}%` : '--'} />
                      <MetricLine label="Compras" value={am.purchases_7d != null ? String(am.purchases_7d) : '--'} />
                    </div>
                  );
                })() : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '80px', color: '#6b7280', fontSize: '11px' }}>
                    <Clock size={12} style={{ marginRight: '4px' }} />
                    {action.hours_elapsed != null ? `${action.hours_elapsed}h` : 'Pendiente'}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center' }}>
                <ArrowRight size={14} color="#2a2d3a" />
              </div>

              {/* 3d checkpoint */}
              <div>
                <div style={{ fontSize: '10px', color: '#f59e0b', fontWeight: '600', textTransform: 'uppercase', marginBottom: '8px' }}>
                  3 dias
                </div>
                {action.ad_metrics_3d ? (() => {
                  const am = action.ad_metrics_3d;
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <MetricLine label="ROAS" value={am.roas_7d != null ? `${am.roas_7d.toFixed(2)}x` : (am.roas_3d != null ? `${am.roas_3d.toFixed(2)}x` : '--')} />
                      <MetricLine label="Spend" value={am.spend_7d != null ? formatCurrency(am.spend_7d) : (am.spend_3d != null ? formatCurrency(am.spend_3d) : '--')} />
                      <MetricLine label="CTR" value={am.ctr_7d != null ? `${am.ctr_7d.toFixed(2)}%` : (am.ctr_3d != null ? `${am.ctr_3d.toFixed(2)}%` : '--')} />
                      <MetricLine label="Compras" value={am.purchases_7d != null ? String(am.purchases_7d) : '--'} />
                    </div>
                  );
                })() : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '80px', color: '#6b7280', fontSize: '11px' }}>
                    <Clock size={12} style={{ marginRight: '4px' }} />
                    {action.days_remaining_3d != null ? `${action.days_remaining_3d}d` : 'Pendiente'}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center' }}>
                <ArrowRight size={14} color="#2a2d3a" />
              </div>

              {/* 7d checkpoint */}
              <div>
                <div style={{ fontSize: '10px', color: '#10b981', fontWeight: '600', textTransform: 'uppercase', marginBottom: '8px' }}>
                  7 dias
                  {action.ad_metrics_7d && <span style={{ marginLeft: '4px', fontSize: '8px' }}>final</span>}
                </div>
                {action.ad_metrics_7d ? (() => {
                  const am = action.ad_metrics_7d;
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <MetricLine label="ROAS" value={am.roas_7d != null ? `${am.roas_7d.toFixed(2)}x` : '--'} />
                      <MetricLine label="Spend" value={am.spend_7d != null ? formatCurrency(am.spend_7d) : '--'} />
                      <MetricLine label="CTR" value={am.ctr_7d != null ? `${am.ctr_7d.toFixed(2)}%` : '--'} />
                      <MetricLine label="Compras" value={am.purchases_7d != null ? String(am.purchases_7d) : '--'} />
                    </div>
                  );
                })() : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '80px', color: '#6b7280', fontSize: '11px' }}>
                    <Clock size={12} style={{ marginRight: '4px' }} />
                    {action.days_remaining_7d != null ? `${action.days_remaining_7d}d` : 'Pendiente'}
                  </div>
                )}
              </div>
            </div>

            {/* Ad name if available */}
            {action.ad_metrics?.ad_name && (
              <div style={{ marginTop: '8px', fontSize: '10px', color: '#6b7280' }}>
                Ad: <span style={{ color: '#9ca3af' }}>{action.ad_metrics.ad_name}</span>
              </div>
            )}
          </div>
        ) : (
          /* === STANDARD ACTIONS: Before / 24h / 3d / 7d metrics grid === */
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr auto 1fr auto 1fr auto 1fr', gap: '6px',
            padding: '12px', backgroundColor: '#13151d', borderRadius: '8px', marginBottom: '12px'
          }}>
            {/* Before (Al ejecutar) */}
            <div>
              <div style={{ fontSize: '10px', color: '#6b7280', fontWeight: '600', textTransform: 'uppercase', marginBottom: '8px' }}>
                Al ejecutar
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <MetricLine label="ROAS" value={before.roas_7d ? `${before.roas_7d.toFixed(2)}x` : '--'} />
                <MetricLine label="CPA" value={before.cpa_7d ? formatCurrency(before.cpa_7d) : '--'} />
                <MetricLine label="Budget" value={before.daily_budget ? formatCurrency(before.daily_budget) : '--'} />
                <MetricLine label="CTR" value={before.ctr ? `${before.ctr.toFixed(2)}%` : '--'} />
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center' }}>
              <ArrowRight size={14} color="#2a2d3a" />
            </div>

            {/* 24h checkpoint */}
            <div>
              <div style={{ fontSize: '10px', color: '#a78bfa', fontWeight: '600', textTransform: 'uppercase', marginBottom: '8px' }}>
                24 horas
              </div>
              {action.has_1d_data ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <MetricLine label="ROAS" value={after1d.roas_7d ? `${after1d.roas_7d.toFixed(2)}x` : '--'} delta={action.delta_roas_1d_pct} />
                  <MetricLine label="CPA" value={after1d.cpa_7d ? formatCurrency(after1d.cpa_7d) : '--'} delta={action.delta_cpa_1d_pct} invertDelta />
                  <MetricLine label="Budget" value={after1d.daily_budget ? formatCurrency(after1d.daily_budget) : '--'} />
                  <MetricLine label="CTR" value={after1d.ctr ? `${after1d.ctr.toFixed(2)}%` : '--'} />
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '80px', color: '#6b7280', fontSize: '11px' }}>
                  <Clock size={12} style={{ marginRight: '4px' }} />
                  {action.hours_elapsed != null ? `${action.hours_elapsed}h` : 'Pendiente'}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center' }}>
              <ArrowRight size={14} color="#2a2d3a" />
            </div>

            {/* 3d checkpoint */}
            <div>
              <div style={{ fontSize: '10px', color: '#f59e0b', fontWeight: '600', textTransform: 'uppercase', marginBottom: '8px' }}>
                3 dias
              </div>
              {action.has_3d_data ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <MetricLine label="ROAS" value={after3d.roas_7d ? `${after3d.roas_7d.toFixed(2)}x` : '--'} delta={action.delta_roas_3d_pct} />
                  <MetricLine label="CPA" value={after3d.cpa_7d ? formatCurrency(after3d.cpa_7d) : '--'} delta={action.delta_cpa_3d_pct} invertDelta />
                  <MetricLine label="Budget" value={after3d.daily_budget ? formatCurrency(after3d.daily_budget) : '--'} />
                  <MetricLine label="CTR" value={after3d.ctr ? `${after3d.ctr.toFixed(2)}%` : '--'} />
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '80px', color: '#6b7280', fontSize: '11px' }}>
                  <Clock size={12} style={{ marginRight: '4px' }} />
                  {action.days_remaining_3d != null ? `${action.days_remaining_3d}d` : 'Pendiente'}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center' }}>
              <ArrowRight size={14} color="#2a2d3a" />
            </div>

            {/* 7d checkpoint */}
            <div>
              <div style={{ fontSize: '10px', color: '#10b981', fontWeight: '600', textTransform: 'uppercase', marginBottom: '8px' }}>
                7 dias
                {action.has_7d_data && <span style={{ marginLeft: '4px', fontSize: '8px' }}>final</span>}
              </div>
              {action.has_7d_data ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <MetricLine label="ROAS" value={after7d.roas_7d ? `${after7d.roas_7d.toFixed(2)}x` : '--'} delta={action.delta_roas_7d_pct} />
                  <MetricLine label="CPA" value={after7d.cpa_7d ? formatCurrency(after7d.cpa_7d) : '--'} delta={action.delta_cpa_7d_pct} invertDelta />
                  <MetricLine label="Budget" value={after7d.daily_budget ? formatCurrency(after7d.daily_budget) : '--'} />
                  <MetricLine label="CTR" value={after7d.ctr ? `${after7d.ctr.toFixed(2)}%` : '--'} />
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '80px', color: '#6b7280', fontSize: '11px' }}>
                  <Clock size={12} style={{ marginRight: '4px' }} />
                  {action.days_remaining_7d != null ? `${action.days_remaining_7d}d` : 'Pendiente'}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Result badge */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{
            padding: '4px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: '700',
            backgroundColor: resultBg, color: resultColor
          }}>
            {resultLabel}
          </span>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            {action.is_create_ad ? (
              /* For create_ad: show the new ad's ROAS instead of parent delta */
              (() => {
                const adBest = action.ad_metrics || action.ad_metrics_1d;
                if (!adBest) return null;
                const adRoas = adBest.roas_7d ?? adBest.roas_3d ?? null;
                if (adRoas == null) return null;
                return (
                  <span style={{
                    fontSize: '13px', fontWeight: '700',
                    color: adRoas >= 1 ? '#6ee7b7' : (adRoas > 0 ? '#fca5a5' : '#9ca3af')
                  }}>
                    ROAS: {adRoas.toFixed(2)}x
                  </span>
                );
              })()
            ) : (
              <>
                {action.has_1d_data && action.delta_roas_1d_pct != null && (
                  <span style={{
                    fontSize: '10px', fontWeight: '600',
                    color: action.delta_roas_1d_pct > 5 ? '#a78bfa' : (action.delta_roas_1d_pct < -5 ? '#fca5a5' : '#9ca3af')
                  }}>
                    24h: {action.delta_roas_1d_pct > 0 ? '+' : ''}{action.delta_roas_1d_pct.toFixed(1)}%
                  </span>
                )}
                {action.has_3d_data && action.delta_roas_3d_pct != null && (
                  <span style={{
                    fontSize: '11px', fontWeight: '600',
                    color: action.delta_roas_3d_pct > 5 ? '#f59e0b' : (action.delta_roas_3d_pct < -5 ? '#fca5a5' : '#9ca3af')
                  }}>
                    3d: {action.delta_roas_3d_pct > 0 ? '+' : ''}{action.delta_roas_3d_pct.toFixed(1)}%
                  </span>
                )}
                {action.has_7d_data && action.delta_roas_7d_pct != null && (
                  <span style={{
                    fontSize: '13px', fontWeight: '700',
                    color: action.delta_roas_7d_pct > 5 ? '#6ee7b7' : (action.delta_roas_7d_pct < -5 ? '#fca5a5' : '#9ca3af')
                  }}>
                    7d: {action.delta_roas_7d_pct > 0 ? '+' : ''}{action.delta_roas_7d_pct.toFixed(1)}%
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// Small metric line
const MetricLine = ({ label, value, delta, invertDelta }) => {
  let deltaColor = '#9ca3af';
  if (delta != null) {
    if (invertDelta) {
      deltaColor = delta < -5 ? '#6ee7b7' : (delta > 5 ? '#fca5a5' : '#9ca3af');
    } else {
      deltaColor = delta > 5 ? '#6ee7b7' : (delta < -5 ? '#fca5a5' : '#9ca3af');
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: '11px', color: '#6b7280' }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ fontSize: '12px', color: '#e5e7eb', fontWeight: '600' }}>{value}</span>
        {delta != null && (
          <span style={{ fontSize: '10px', fontWeight: '600', color: deltaColor }}>
            {delta > 0 ? '+' : ''}{delta.toFixed(1)}%
          </span>
        )}
      </div>
    </div>
  );
};

// Performance breakdown by action type
const ActionTypeBreakdown = ({ measured }) => {
  const actionTypes = [...new Set(measured.map(a => a.action))];

  const stats = actionTypes.map(actionType => {
    const actions = measured.filter(a => a.action === actionType);
    const improved = actions.filter(a => a.result === 'improved').length;
    const worsened = actions.filter(a => a.result === 'worsened').length;
    const neutral = actions.filter(a => a.result === 'neutral').length;
    const avgDelta = actions.length > 0
      ? actions.reduce((sum, a) => sum + (a.delta_roas_pct || 0), 0) / actions.length
      : 0;

    return { actionType, total: actions.length, improved, worsened, neutral, avgDelta };
  }).filter(s => s.total > 0).sort((a, b) => b.total - a.total);

  if (stats.length === 0) {
    return (
      <div style={{
        backgroundColor: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: '12px',
        padding: '32px', textAlign: 'center', color: '#6b7280', fontSize: '13px'
      }}>
        Sin datos suficientes por tipo de accion
      </div>
    );
  }

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: `repeat(${Math.min(stats.length, 4)}, 1fr)`, gap: '12px'
    }}>
      {stats.map(s => {
        const actionConf = ACTION_LABELS[s.actionType] || ACTION_LABELS.no_action;
        const ActionIcon = actionConf.icon || ArrowRight;
        const successRate = s.total > 0 ? ((s.improved / s.total) * 100).toFixed(0) : 0;

        return (
          <div key={s.actionType} style={{
            backgroundColor: '#1a1d27', border: `1px solid ${actionConf.color}30`, borderRadius: '10px',
            padding: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
              <ActionIcon size={14} color={actionConf.color} />
              <span style={{ fontSize: '14px', fontWeight: '600', color: '#e5e7eb' }}>
                {actionConf.label}
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '12px', color: '#6b7280' }}>Total acciones</span>
                <span style={{ fontSize: '13px', fontWeight: '700', color: '#fff' }}>{s.total}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '12px', color: '#6b7280' }}>Mejoraron</span>
                <span style={{ fontSize: '13px', fontWeight: '700', color: '#6ee7b7' }}>{s.improved}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '12px', color: '#6b7280' }}>Empeoraron</span>
                <span style={{ fontSize: '13px', fontWeight: '700', color: '#fca5a5' }}>{s.worsened}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '12px', color: '#6b7280' }}>Tasa de exito</span>
                <span style={{ fontSize: '13px', fontWeight: '700', color: successRate >= 50 ? '#6ee7b7' : '#fca5a5' }}>
                  {successRate}%
                </span>
              </div>

              {/* Progress bar */}
              <div style={{ marginTop: '4px' }}>
                <div style={{
                  height: '6px', borderRadius: '3px', backgroundColor: '#2a2d3a', overflow: 'hidden',
                  display: 'flex'
                }}>
                  {s.improved > 0 && (
                    <div style={{
                      width: `${(s.improved / s.total) * 100}%`,
                      backgroundColor: '#10b981', height: '100%'
                    }} />
                  )}
                  {s.neutral > 0 && (
                    <div style={{
                      width: `${(s.neutral / s.total) * 100}%`,
                      backgroundColor: '#6b7280', height: '100%'
                    }} />
                  )}
                  {s.worsened > 0 && (
                    <div style={{
                      width: `${(s.worsened / s.total) * 100}%`,
                      backgroundColor: '#ef4444', height: '100%'
                    }} />
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                <span style={{ fontSize: '12px', color: '#6b7280' }}>Avg ROAS delta</span>
                <span style={{
                  fontSize: '13px', fontWeight: '700',
                  color: s.avgDelta > 5 ? '#6ee7b7' : (s.avgDelta < -5 ? '#fca5a5' : '#9ca3af')
                }}>
                  {s.avgDelta > 0 ? '+' : ''}{s.avgDelta.toFixed(1)}%
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

// Main Impact Report Page
const ImpactReport = () => {
  const [impactData, setImpactData] = useState({ measured: [], pending: [] });
  const [readiness, setReadiness] = useState(null);
  const [autonomy, setAutonomy] = useState({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all'); // all, improved, worsened, measuring

  const fetchData = useCallback(async () => {
    try {
      const [data, readinessData, autonomyCfg] = await Promise.all([
        getActionsWithImpact(100),
        getBrainReadiness().catch(() => null),
        getAutonomyConfig().catch(() => ({}))
      ]);
      setImpactData(data);
      setReadiness(readinessData);
      setAutonomy(autonomyCfg || {});
    } catch (error) {
      console.error('Error cargando datos de impacto:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleAutonomyChange = async (mode) => {
    if (mode === 'semi_auto' || mode === 'auto') {
      const ri = readiness?.readiness_index || 0;
      const minForSemi = 70;
      const minForAuto = 85;

      if (mode === 'semi_auto' && ri < minForSemi) {
        alert(`Brain Readiness: ${ri}% — necesita ${minForSemi}%+ para Semi-Auto.\n\n${readiness?.hard_block || 'El Brain necesita mas experiencia.'}`);
        return;
      }
      if (mode === 'auto' && ri < minForAuto) {
        alert(`Brain Readiness: ${ri}% — necesita ${minForAuto}%+ para Auto.\n\n${readiness?.hard_block || 'El Brain aun no es experto.'}`);
        return;
      }

      const confirmMsg = mode === 'auto'
        ? `MODO AUTO: El Brain ejecutara TODAS las recomendaciones automaticamente.\n\nReadiness: ${ri}% (${readiness?.level_label})\nWin Rate: ${readiness?.breakdown?.win_rate?.overall || 0}%\nAcciones medidas: ${readiness?.breakdown?.action_volume?.total_measured || 0}\n\nConfirmar?`
        : `MODO SEMI-AUTO: El Brain auto-ejecutara acciones de alta confianza (budget +/- <= 20%).\n\nReadiness: ${ri}% (${readiness?.level_label})\nWin Rate: ${readiness?.breakdown?.win_rate?.overall || 0}%\n\nConfirmar?`;

      if (!window.confirm(confirmMsg)) return;
    }

    try {
      await updateAutonomyConfig({ mode });
      await fetchData();
    } catch (error) {
      alert(`Error: ${error.response?.data?.error || error.message}`);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 120000); // 2 min
    return () => clearInterval(interval);
  }, [fetchData]);

  const measured = impactData.measured || [];
  const pending = impactData.pending || [];

  // Summary stats
  const totalExecuted = measured.length + pending.length;
  const improved = measured.filter(a => a.result === 'improved').length;
  const worsened = measured.filter(a => a.result === 'worsened').length;
  const neutral = measured.filter(a => a.result === 'neutral').length;
  const successRate = measured.length > 0 ? ((improved / measured.length) * 100).toFixed(0) : 0;
  const avgRoasDelta = measured.length > 0
    ? measured.reduce((sum, a) => sum + (a.delta_roas_pct || 0), 0) / measured.length
    : 0;

  // Filter actions
  let allActions = [...pending, ...measured];
  if (filter === 'improved') allActions = measured.filter(a => a.result === 'improved');
  else if (filter === 'worsened') allActions = measured.filter(a => a.result === 'worsened');
  else if (filter === 'measuring') allActions = pending;

  // Sort by date descending
  allActions.sort((a, b) => new Date(b.executed_at) - new Date(a.executed_at));

  if (loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '60vh', color: '#9ca3af', fontSize: '16px',
        fontFamily: 'Inter, system-ui, sans-serif'
      }}>
        Cargando reporte de impacto...
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: '#fff' }}>
      {/* Header */}
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: '28px', fontWeight: '700', margin: 0, letterSpacing: '-0.02em' }}>
          Reporte de Impacto
        </h1>
        <p style={{ color: '#9ca3af', fontSize: '13px', margin: '4px 0 0' }}>
          Resultados de las acciones ejecutadas por el Cerebro IA. Cada accion se mide a las 24h, 3 dias y 7 dias. Este feedback alimenta las decisiones futuras.
        </p>
      </div>

      {/* ========= BRAIN READINESS PANEL ========= */}
      {readiness && (
        <div style={{
          backgroundColor: '#1a1d27', border: `1px solid ${readiness.level_color}30`, borderRadius: '12px',
          padding: '20px', marginBottom: '28px'
        }}>
          {/* Header row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
            <Gauge size={18} color={readiness.level_color} />
            <span style={{ fontSize: '18px', fontWeight: '700', color: '#e5e7eb' }}>
              Brain Readiness
            </span>
            <span style={{
              padding: '3px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: '800',
              backgroundColor: readiness.level_color + '20', color: readiness.level_color
            }}>
              {readiness.level_label}
            </span>
            <span style={{
              marginLeft: 'auto', fontSize: '11px', fontWeight: '600',
              color: (autonomy?.mode || 'manual') === 'auto' ? '#6ee7b7' : (autonomy?.mode || 'manual') === 'semi_auto' ? '#fcd34d' : '#93c5fd'
            }}>
              Modo actual: {(autonomy?.mode || 'manual').replace('_', '-')}
            </span>
            <span style={{ fontSize: '28px', fontWeight: '800', color: readiness.level_color, letterSpacing: '-0.02em' }}>
              {readiness.readiness_index}%
            </span>
          </div>

          {/* Main progress bar */}
          <div style={{ marginBottom: '20px' }}>
            <div style={{ position: 'relative', height: '10px', borderRadius: '5px', backgroundColor: '#2a2d3a', overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: '5px', width: `${readiness.readiness_index}%`,
                background: readiness.readiness_index >= 85
                  ? 'linear-gradient(90deg, #10b981, #8b5cf6)'
                  : readiness.readiness_index >= 70
                    ? 'linear-gradient(90deg, #3b82f6, #10b981)'
                    : readiness.readiness_index >= 50
                      ? 'linear-gradient(90deg, #f59e0b, #3b82f6)'
                      : readiness.readiness_index >= 30
                        ? 'linear-gradient(90deg, #ef4444, #f59e0b)'
                        : '#ef4444',
                transition: 'width 0.5s ease'
              }} />
              {/* Threshold markers with labels */}
              {[
                { pct: 30, label: '30%' },
                { pct: 50, label: '50%' },
                { pct: 70, label: '70% Semi-Auto' },
                { pct: 85, label: '85% Auto' }
              ].map(t => (
                <div key={t.pct} style={{
                  position: 'absolute', top: 0, left: `${t.pct}%`, width: '1px', height: '100%',
                  backgroundColor: '#4b5563'
                }} />
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px', fontSize: '10px', color: '#4b5563', fontWeight: '600' }}>
              <span style={{ color: '#ef4444' }}>Aprendiendo</span>
              <span style={{ color: '#f59e0b' }}>Desarrollando</span>
              <span style={{ color: '#3b82f6' }}>Capaz</span>
              <span style={{ color: '#10b981' }}>Listo (70%+)</span>
              <span style={{ color: '#8b5cf6' }}>Experto (85%+)</span>
            </div>
          </div>

          {/* Hard block warning */}
          {readiness.hard_block && (
            <div style={{
              padding: '10px 14px', borderRadius: '8px', marginBottom: '16px',
              backgroundColor: '#7f1d1d15', border: '1px solid #ef444430',
              fontSize: '12px', color: '#fca5a5', display: 'flex', alignItems: 'center', gap: '8px'
            }}>
              <AlertTriangle size={14} color="#ef4444" />
              <strong>Bloqueado:</strong> {readiness.hard_block}
            </div>
          )}

          {/* Breakdown grid — 6 criteria */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '16px' }}>
            {readiness.breakdown && Object.entries(readiness.breakdown).map(([key, item]) => {
              const score = item.score || 0;
              const barColor = score >= 80 ? '#10b981' : score >= 50 ? '#3b82f6' : score >= 30 ? '#f59e0b' : '#ef4444';
              return (
                <div key={key} style={{
                  padding: '12px 14px', borderRadius: '10px', backgroundColor: '#13151d',
                  border: '1px solid #2a2d3a'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                    <span style={{ fontSize: '11px', fontWeight: '600', color: '#9ca3af' }}>{item.label}</span>
                    <span style={{ fontSize: '14px', fontWeight: '800', color: barColor }}>{score}%</span>
                  </div>
                  <div style={{ height: '4px', borderRadius: '2px', backgroundColor: '#2a2d3a', marginBottom: '6px' }}>
                    <div style={{ height: '100%', borderRadius: '2px', width: `${score}%`, backgroundColor: barColor, transition: 'width 0.3s' }} />
                  </div>
                  <div style={{ fontSize: '10px', color: '#6b7280' }}>
                    {key === 'data_history' && `${item.days} de ${item.required} dias requeridos`}
                    {key === 'action_volume' && `${item.total_measured}/${item.required_total} medidas (${item.budget_measured}/${item.required_budget} budget)`}
                    {key === 'win_rate' && `${item.overall}% global, ${item.budget}% budget (${item.wins}W / ${item.losses}L)`}
                    {key === 'learner_maturity' && `${item.buckets} buckets, ${item.total_samples} samples, reward ${item.avg_reward}`}
                    {key === 'consistency' && `${item.recent_win_rate}% win rate ultimos 7d (${item.recent_total} acciones)`}
                    {key === 'safety' && (item.catastrophic_losses > 0 ? `${item.catastrophic_losses} perdida(s) catastrofica(s) recientes` : 'Sin perdidas catastroficas recientes')}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Autonomy recommendation + toggle */}
          <div style={{
            padding: '12px 16px', borderRadius: '10px',
            backgroundColor: readiness.recommended_mode === 'auto' ? '#065f4615' : readiness.recommended_mode === 'semi_auto' ? '#78350f15' : '#1e3a8a15',
            border: `1px solid ${readiness.recommended_mode === 'auto' ? '#10b98130' : readiness.recommended_mode === 'semi_auto' ? '#f59e0b30' : '#3b82f630'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px'
          }}>
            <div>
              <div style={{ fontSize: '10px', fontWeight: '700', color: '#6b7280', marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Modo recomendado por el sistema
              </div>
              <div style={{ fontSize: '14px', fontWeight: '700', color: readiness.recommended_mode === 'auto' ? '#6ee7b7' : readiness.recommended_mode === 'semi_auto' ? '#fcd34d' : '#93c5fd' }}>
                {readiness.recommended_mode === 'auto' ? 'Auto' : readiness.recommended_mode === 'semi_auto' ? 'Semi-Auto' : 'Manual'}
                <span style={{ fontSize: '12px', fontWeight: '400', color: '#6b7280', marginLeft: '10px' }}>
                  {readiness.recommended_mode === 'auto' && '— El Brain puede manejar budget de forma autonoma'}
                  {readiness.recommended_mode === 'semi_auto' && '— Solo auto-ejecutar budget con alta confianza (<= 20%)'}
                  {readiness.recommended_mode === 'manual' && '— Aun necesita supervision humana para decisiones de budget'}
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              {readiness.recommended_mode !== (autonomy?.mode || 'manual') && readiness.recommended_mode !== 'manual' && (
                <button
                  onClick={() => handleAutonomyChange(readiness.recommended_mode)}
                  style={{
                    padding: '8px 18px', borderRadius: '8px', border: 'none', cursor: 'pointer',
                    fontSize: '12px', fontWeight: '700',
                    backgroundColor: readiness.recommended_mode === 'auto' ? '#065f46' : '#78350f',
                    color: readiness.recommended_mode === 'auto' ? '#6ee7b7' : '#fcd34d'
                  }}
                >
                  Activar {readiness.recommended_mode === 'auto' ? 'Auto' : 'Semi-Auto'}
                </button>
              )}
              {(autonomy?.mode === 'semi_auto' || autonomy?.mode === 'auto') && (
                <button
                  onClick={() => handleAutonomyChange('manual')}
                  style={{
                    padding: '8px 18px', borderRadius: '8px', border: 'none', cursor: 'pointer',
                    fontSize: '12px', fontWeight: '700', backgroundColor: '#1e3a8a', color: '#93c5fd'
                  }}
                >
                  Volver a Manual
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Summary Cards */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '12px', marginBottom: '28px'
      }}>
        <StatCard
          icon={BarChart3} iconColor="#3b82f6"
          label="Total Ejecutadas"
          value={totalExecuted}
          subValue={`${measured.length} medidas, ${pending.length} midiendo`}
        />
        <StatCard
          icon={CheckCircle} iconColor="#10b981"
          label="Mejoraron"
          value={improved}
          subValue={`${successRate}% tasa de exito`}
          subColor={successRate >= 50 ? '#6ee7b7' : '#fca5a5'}
        />
        <StatCard
          icon={AlertTriangle} iconColor="#ef4444"
          label="Empeoraron"
          value={worsened}
          subValue={neutral > 0 ? `${neutral} sin cambio` : null}
        />
        <StatCard
          icon={TrendingUp} iconColor={avgRoasDelta > 0 ? '#10b981' : '#ef4444'}
          label="Avg Delta ROAS"
          value={`${avgRoasDelta > 0 ? '+' : ''}${avgRoasDelta.toFixed(1)}%`}
          subValue="Promedio de todas las acciones medidas"
        />
        <StatCard
          icon={Clock} iconColor="#fcd34d"
          label="Midiendo"
          value={pending.length}
          subValue={pending.length > 0 ? `Prox medicion en ${Math.min(...pending.map(p => p.days_remaining || 3))}d` : 'Sin pendientes'}
        />
      </div>

      {/* Action Type Breakdown */}
      <div style={{ marginBottom: '28px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: '600', margin: '0 0 16px' }}>
          Rendimiento por Tipo de Accion
        </h2>
        <ActionTypeBreakdown measured={measured} />
      </div>

      {/* Timeline Filter */}
      <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ fontSize: '18px', fontWeight: '600', margin: 0 }}>
          Timeline de Acciones
          <span style={{
            marginLeft: '10px', padding: '2px 10px', borderRadius: '10px',
            fontSize: '12px', fontWeight: '700', backgroundColor: '#1e3a8a20', color: '#93c5fd'
          }}>
            {allActions.length}
          </span>
        </h2>
        <div style={{ display: 'flex', gap: '6px' }}>
          {[
            { key: 'all', label: 'Todas', count: totalExecuted },
            { key: 'improved', label: 'Mejoraron', count: improved },
            { key: 'worsened', label: 'Empeoraron', count: worsened },
            { key: 'measuring', label: 'Midiendo', count: pending.length }
          ].map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                padding: '5px 12px', borderRadius: '6px', border: 'none',
                fontSize: '11px', fontWeight: '600', cursor: 'pointer',
                backgroundColor: filter === f.key ? '#1e3a8a' : '#1a1d27',
                color: filter === f.key ? '#93c5fd' : '#6b7280'
              }}
            >
              {f.label} ({f.count})
            </button>
          ))}
        </div>
      </div>

      {/* Actions Timeline */}
      {allActions.length === 0 ? (
        <div style={{
          backgroundColor: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: '12px',
          padding: '60px', textAlign: 'center', color: '#6b7280', fontSize: '14px'
        }}>
          {totalExecuted === 0
            ? 'No hay acciones ejecutadas aun. Aprueba y ejecuta recomendaciones de los agentes para ver su impacto aqui.'
            : 'Sin acciones en este filtro.'}
        </div>
      ) : (
        <div style={{ maxWidth: '960px' }}>
          {allActions.map((action, i) => (
            <ActionCard key={action._id || i} action={action} isLast={i === allActions.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
};

export default ImpactReport;
