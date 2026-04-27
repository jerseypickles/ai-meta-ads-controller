import { useState, useEffect } from 'react';
import api from '../api';

const COLOR_AMBER = '#f59e0b';
const COLOR_OK = '#10b981';
const COLOR_RECOVERY = '#3b82f6';

function fmtMoney(n) {
  if (n == null) return '—';
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

export default function WarehouseThrottleControl() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  async function load() {
    try {
      const r = await api.get('/api/system/warehouse-throttle');
      setData(r.data);
    } catch (err) {
      console.error('warehouse-throttle load error:', err);
    } finally {
      setLoading(false);
    }
  }

  async function action(path, body = {}) {
    setBusy(true);
    try {
      await api.post(`/api/system/warehouse-throttle${path}`, body);
      await load();
    } catch (err) {
      alert('Error: ' + (err.response?.data?.error || err.message));
    } finally {
      setBusy(false);
    }
  }

  async function handleEnable() {
    const target = prompt('Target spend diario en USD:', String(data?.config?.target_daily_spend || 2500));
    if (!target) return;
    const reason = prompt('Razón (visible en logs y panel):', 'Warehouse capacity bottleneck');
    await action('/enable', { target_daily_spend: parseFloat(target), reason: reason || undefined });
  }
  async function handleDisable() {
    if (!confirm('¿Desactivar warehouse throttle? Sistema vuelve a operación normal.')) return;
    await action('/disable');
  }
  async function handleRecovery() {
    const target = prompt('Target spend para recovery (cuando llegue, throttle se desactiva):',
      String(data?.config?.recovery_target_daily_spend || 3000));
    if (!target) return;
    if (!confirm(`Activar recovery mode → escalar gradualmente hasta $${target}/d?`)) return;
    await action('/recovery', { recovery_target_daily_spend: parseFloat(target) });
  }
  async function handleExtend() {
    const days = prompt('Días extra para auto-disable:', '7');
    if (!days) return;
    await action('/extend', { days: parseInt(days, 10) });
  }
  async function handleUpdateTarget() {
    const target = prompt('Nuevo target diario:', String(data?.config?.target_daily_spend || 2500));
    if (!target) return;
    await action('/update', { target_daily_spend: parseFloat(target) });
  }
  async function handleRunNow() {
    if (!confirm('¿Ejecutar ciclo manual ahora? (Aplica scale ups/downs basados en estado actual)')) return;
    setBusy(true);
    try {
      const r = await api.post('/api/system/warehouse-throttle/run-now');
      alert(`Ciclo ejecutado: ${JSON.stringify(r.data.result, null, 2).substring(0, 400)}`);
      await load();
    } catch (err) {
      alert('Error: ' + (err.response?.data?.error || err.message));
    } finally {
      setBusy(false);
    }
  }

  if (loading || !data) return null;

  const { status, config } = data;

  // Si está OFF, mostrar solo botón discreto para activar
  if (!status?.enabled) {
    return (
      <div style={{
        marginBottom: 14, padding: '10px 14px',
        background: 'rgba(17, 21, 51, 0.4)',
        border: '1px solid rgba(255,255,255,0.05)',
        borderRadius: 10,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontSize: '0.74rem', color: 'var(--bos-text-muted)'
      }}>
        <span>⚙️ Warehouse Throttle: <strong style={{ color: COLOR_OK }}>OFF</strong> · sistema en operación normal</span>
        <button onClick={handleEnable} disabled={busy} style={{
          padding: '4px 12px', fontSize: '0.7rem', borderRadius: 6,
          background: 'rgba(245, 158, 11, 0.15)', border: '1px solid rgba(245, 158, 11, 0.4)',
          color: COLOR_AMBER, cursor: 'pointer', fontWeight: 600
        }}>
          Activar throttle
        </button>
      </div>
    );
  }

  // Estado activo
  const accent = status.recovery_mode ? COLOR_RECOVERY : COLOR_AMBER;
  const arrow = status.recovery_mode ? '🔺' : '🔻';
  const modeLabel = status.recovery_mode ? 'RECOVERY MODE' : 'WAREHOUSE THROTTLE';
  const target = status.recovery_mode ? status.recovery_target_daily_spend : status.target_daily_spend;
  const spend = status.yesterday_spend;
  const excess = status.excess;
  const progressPct = Math.min(100, (spend / target) * 100);

  return (
    <div style={{
      marginBottom: 16,
      background: `linear-gradient(135deg, ${accent}11 0%, rgba(11, 17, 32, 0.6) 100%)`,
      border: `1px solid ${accent}55`,
      borderRadius: 12,
      overflow: 'hidden'
    }}>
      {/* Header */}
      <div style={{ padding: '12px 16px', borderBottom: `1px solid ${accent}22`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: '0.78rem', fontWeight: 700, color: accent, letterSpacing: '0.06em', display: 'flex', alignItems: 'center', gap: 8 }}>
            {arrow} {modeLabel}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--bos-text-muted)', marginTop: 3 }}>
            {status.reason || 'Logistics capacity bottleneck'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {!status.recovery_mode && (
            <button onClick={handleRecovery} disabled={busy} style={btnStyle(COLOR_RECOVERY)}>
              ▶ Recovery (subir gradual)
            </button>
          )}
          <button onClick={handleExtend} disabled={busy} style={btnStyle(accent)}>
            +7 días
          </button>
          <button onClick={() => setShowSettings(!showSettings)} disabled={busy} style={btnStyle('#94a3b8')}>
            ⚙ Settings
          </button>
          <button onClick={handleDisable} disabled={busy} style={btnStyle('#ef4444')}>
            ✕ Desactivar
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 10, padding: '12px 16px'
      }}>
        <Stat label="Spend ayer" value={fmtMoney(spend)} color="var(--bos-text)" />
        <Stat label={status.recovery_mode ? 'Target recovery' : 'Target throttle'} value={fmtMoney(target)} color={accent} />
        <Stat
          label={status.recovery_mode ? 'Falta para recovery' : 'Exceso a reducir'}
          value={fmtMoney(excess)}
          color={excess > 0 ? accent : COLOR_OK}
        />
        <Stat label="Días activo" value={`${Math.floor(status.days_active)}/${Math.floor(status.days_active + status.days_remaining)}`} />
        <Stat label="Auto-disable" value={`${Math.floor(status.days_remaining)}d`} color="var(--bos-text-muted)" />
      </div>

      {/* Progress bar */}
      <div style={{ padding: '0 16px 12px' }}>
        <div style={{
          height: 6, background: 'rgba(0,0,0,0.4)', borderRadius: 3, overflow: 'hidden', position: 'relative'
        }}>
          <div style={{
            position: 'absolute', left: 0, top: 0, height: '100%',
            width: `${progressPct}%`,
            background: status.recovery_mode
              ? `linear-gradient(90deg, ${COLOR_RECOVERY}, ${COLOR_OK})`
              : `linear-gradient(90deg, ${COLOR_OK}, ${COLOR_AMBER})`,
            transition: 'width 0.4s'
          }} />
          {/* Marker target */}
          <div style={{
            position: 'absolute', left: '100%', top: -2, width: 2, height: 10,
            background: accent, marginLeft: -1
          }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: '0.62rem', color: 'var(--bos-text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
          <span>$0</span>
          <span>{fmtMoney(target)} target</span>
        </div>
      </div>

      {/* Settings expandible */}
      {showSettings && (
        <div style={{ padding: '12px 16px', borderTop: `1px solid ${accent}22`, fontSize: '0.74rem', background: 'rgba(0,0,0,0.2)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 10 }}>
            <SettingRow label="Floor CBO" value={`$${config.floor_per_cbo}/d`} />
            <SettingRow label="Floor adset" value={`$${config.floor_per_adset}/d`} />
            <SettingRow label="Apollo paused" value={config.pause_apollo ? '✓ sí' : 'no'} color={config.pause_apollo ? accent : 'var(--bos-text-muted)'} />
            <SettingRow label="Prometheus paused" value={config.pause_prometheus ? '✓ sí' : 'no'} color={config.pause_prometheus ? accent : 'var(--bos-text-muted)'} />
            <SettingRow label="Ares scale_up bloqueado" value={config.pause_ares_scaling ? '✓ sí' : 'no'} color={config.pause_ares_scaling ? accent : 'var(--bos-text-muted)'} />
          </div>

          <div style={{ marginTop: 10, marginBottom: 6, fontSize: '0.66rem', color: 'var(--bos-text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            ROAS tiers (% de cambio diario por nivel)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 6 }}>
            {(config.roas_tiers || []).map((t, i) => (
              <div key={i} style={{
                background: 'rgba(17, 21, 51, 0.6)',
                padding: '6px 8px', borderRadius: 6, fontSize: '0.7rem',
                fontFamily: 'JetBrains Mono, monospace'
              }}>
                <div style={{ color: 'var(--bos-text-muted)', fontSize: '0.6rem' }}>
                  ROAS &lt;{t.roas_max === Infinity || t.roas_max === null ? '∞' : t.roas_max}x
                </div>
                <div style={{ color: '#ef4444' }}>−{(t.scale_down_pct * 100).toFixed(0)}%</div>
                <div style={{ color: COLOR_OK }}>+{(t.scale_up_pct * 100).toFixed(0)}%</div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={handleUpdateTarget} disabled={busy} style={btnStyle(accent)}>Cambiar target</button>
            <button onClick={handleRunNow} disabled={busy} style={btnStyle('#94a3b8')}>Run ciclo ahora</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color = 'var(--bos-text)' }) {
  return (
    <div>
      <div style={{ fontSize: '0.58rem', color: 'var(--bos-text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: '1.05rem', fontWeight: 700, color, fontFamily: 'JetBrains Mono, monospace' }}>
        {value}
      </div>
    </div>
  );
}

function SettingRow({ label, value, color = 'var(--bos-text)' }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.7rem' }}>
      <span style={{ color: 'var(--bos-text-muted)' }}>{label}</span>
      <span style={{ color, fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function btnStyle(color) {
  return {
    padding: '5px 12px', fontSize: '0.7rem', fontWeight: 600,
    borderRadius: 6, cursor: 'pointer',
    background: `${color}22`, border: `1px solid ${color}55`, color
  };
}
