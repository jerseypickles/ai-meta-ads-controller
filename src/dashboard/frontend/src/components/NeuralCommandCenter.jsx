import { useState, useEffect } from 'react';
import NeuralGraphView from './NeuralGraphView';
import api from '../api';

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
        <NeuralGraphView onAgentClick={onAgentClick} />
      </div>
    </div>
  );
}
