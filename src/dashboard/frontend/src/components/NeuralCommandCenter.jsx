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

export default function NeuralCommandCenter({ onAgentClick }) {
  const [account, setAccount] = useState(null);

  useEffect(() => {
    loadAccount();
    const t = setInterval(loadAccount, 30000);
    return () => clearInterval(t);
  }, []);

  async function loadAccount() {
    try {
      const res = await api.get('/api/brain/briefing');
      setAccount(res.data.context?.account || null);
    } catch (err) {
      console.error('NeuralCommandCenter header error:', err);
    }
  }

  return (
    <div className="neural-command">
      <div className="neural-command-header">
        <div className="neural-command-title">
          🧠 Neural Command Center
        </div>
        <div style={{ fontSize: '0.72rem', color: 'var(--bos-text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
          ROAS hoy <span style={{ color: 'var(--bos-bio)' }}>{account?.roas_today || '—'}x</span>
          {' · '}
          Revenue <span style={{ color: 'var(--bos-synapse)' }}>${account?.revenue_today?.toLocaleString() || 0}</span>
        </div>
      </div>
      <div className="neural-canvas">
        <GraphErrorBoundary>
          <NeuralGraphView onAgentClick={onAgentClick} />
        </GraphErrorBoundary>
      </div>
    </div>
  );
}
