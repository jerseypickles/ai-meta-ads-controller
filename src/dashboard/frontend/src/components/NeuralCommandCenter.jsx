import { useState, useEffect, Component } from 'react';
import NeuralGraphView from './NeuralGraphView';
import api from '../api';

// ErrorBoundary para aislar crashes del graph — si react-force-graph o
// el render custom fallan, mostramos fallback en vez de tumbar /brain
class GraphErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('[NeuralGraph crash]', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          width: '100%', height: '100%', display: 'flex', alignItems: 'center',
          justifyContent: 'center', flexDirection: 'column', gap: 12, padding: 32,
          background: 'radial-gradient(ellipse at center, #0b1120 0%, #050816 70%)'
        }}>
          <div style={{ fontSize: '0.85rem', color: '#f87171', fontFamily: 'JetBrains Mono, monospace' }}>
            ⚠ Graph view crash
          </div>
          <div style={{ fontSize: '0.72rem', color: '#94a3b8', maxWidth: 560, textAlign: 'center' }}>
            {String(this.state.error?.message || this.state.error)}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: 8, padding: '6px 16px', fontSize: '0.7rem',
              background: 'rgba(59, 130, 246, 0.15)', border: '1px solid rgba(59, 130, 246, 0.3)',
              color: '#60a5fa', borderRadius: 6, cursor: 'pointer'
            }}>
            retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// NEURAL COMMAND CENTER — wrapper que agrega header con KPIs + graph view
// El canvas real ahora vive en NeuralGraphView (force-directed, Obsidian style)
// ═══════════════════════════════════════════════════════════════════════════

export default function NeuralCommandCenter({ onAgentClick, hideHeader = false }) {
  const [account, setAccount] = useState(null);
  const [cash, setCash] = useState(null); // Demeter /today: cash REAL de Shopify

  useEffect(() => {
    loadAccount();
    const t = setInterval(loadAccount, 30000);
    return () => clearInterval(t);
  }, []);

  async function loadAccount() {
    try {
      const [b, d] = await Promise.all([
        api.get('/api/brain/briefing'),
        api.get('/api/demeter/today').catch(() => null) // cash real; si falla, mostramos solo Meta
      ]);
      setAccount(b.data.context?.account || null);
      setCash(d?.data?.snapshot || null);
    } catch (err) {
      console.error('NeuralCommandCenter header error:', err);
    }
  }

  // Cash real de Shopify (verdad de caja). Meta = atribución (suele correr +30-40%).
  const cashRev = cash?.total_sales;
  const hasCash = typeof cashRev === 'number' && cashRev > 0;
  const cashRoas = cash?.cash_roas;

  return (
    <div className="neural-command">
      {!hideHeader && (
        <div className="neural-command-header">
          <div className="neural-command-title">
            🧠 Neural Command Center
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--bos-text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
            {hasCash ? (
              <>
                ROAS hoy <span style={{ color: 'var(--bos-bio)' }} title="cash-ROAS real (Demeter/Shopify)">{cashRoas ? Number(cashRoas).toFixed(2) : '—'}x</span>
                {' · '}
                Revenue <span style={{ color: 'var(--bos-synapse)' }} title="Cash real de Shopify hoy (total sales)">${Math.round(cashRev).toLocaleString()}</span>
                <span style={{ opacity: 0.55 }}> · Meta atrib. ${account?.revenue_today?.toLocaleString() || 0}</span>
              </>
            ) : (
              <>
                {/* Sin cash real disponible → mostramos Meta claramente etiquetado */}
                ROAS hoy <span style={{ color: 'var(--bos-bio)' }}>{account?.roas_today || '—'}x</span>
                {' · '}
                Revenue <span style={{ opacity: 0.7 }} title="Atribución de Meta (no cash real — Demeter sin dato hoy)">${account?.revenue_today?.toLocaleString() || 0} <span style={{ fontSize: '0.62rem' }}>(Meta atrib.)</span></span>
              </>
            )}
          </div>
        </div>
      )}
      <div className="neural-canvas">
        <GraphErrorBoundary>
          <NeuralGraphView onAgentClick={onAgentClick} />
        </GraphErrorBoundary>
      </div>
    </div>
  );
}
