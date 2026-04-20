import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import '../brain-os.css';
import MorningBriefing from '../components/MorningBriefing';
import NeuralCommandCenter from '../components/NeuralCommandCenter';
import TemporalSpine from '../components/TemporalSpine';
import DNAGenomeSpace from '../components/DNAGenomeSpace';

export default function BrainOS() {
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [showGenome, setShowGenome] = useState(false);
  const navigate = useNavigate();

  return (
    <div className="brain-os">
      {/* Toggle para legacy dashboard */}
      <button
        className="legacy-toggle"
        onClick={() => navigate('/brain')}
      >
        ⟵ Legacy dashboard
      </button>

      <div className="brain-os-content">
        {/* Morning Briefing */}
        <MorningBriefing />

        {/* Neural Command Center */}
        <NeuralCommandCenter onAgentClick={setSelectedAgent} />

        {/* Toggle DNA Genome */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.9 }}
          style={{ display: 'flex', justifyContent: 'center', marginBottom: 24 }}
        >
          <button
            onClick={() => setShowGenome(!showGenome)}
            style={{
              background: 'linear-gradient(90deg, rgba(139, 92, 246, 0.12), rgba(236, 72, 153, 0.12))',
              border: '1px solid var(--bos-electric)',
              color: 'var(--bos-text)',
              padding: '12px 28px',
              borderRadius: 40,
              fontSize: '0.82rem',
              fontWeight: 500,
              cursor: 'pointer',
              letterSpacing: '0.05em',
              textTransform: 'uppercase'
            }}
          >
            {showGenome ? '▲ Cerrar' : '▼ Explorar Genome Space'}
          </button>
        </motion.div>

        {/* DNA Genome Space */}
        <AnimatePresence>
          {showGenome && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.4 }}
              style={{ overflow: 'hidden', marginBottom: 32 }}
            >
              <DNAGenomeSpace />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Temporal Spine (always visible bottom) */}
      <TemporalSpine />

      {/* Agent detail panel */}
      <AnimatePresence>
        {selectedAgent && (
          <motion.div
            className="agent-detail-overlay"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
          >
            <AgentDetailPanel agent={selectedAgent} onClose={() => setSelectedAgent(null)} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function AgentDetailPanel({ agent, onClose }) {
  const agentInfo = {
    zeus: { icon: '⚡', name: 'Zeus', role: 'CEO Strategic', desc: 'Analiza cuenta completa cada 6h. Opus 4.7. Emite directivas para los 4 agentes. 4 ciclos/día.' },
    athena: { icon: '🦉', name: 'Athena', role: 'Account Manager', desc: 'Gestiona ABO production cada 2h. Sonnet 4.6. 13 tools: scale, pause, reactivate. Excluye [TEST] y [Ares].' },
    apollo: { icon: '☀️', name: 'Apollo', role: 'Creator', desc: 'Genera creativos 3x/día. Gemini 3 + Claude. Persiste DNA completo. Fase 3 evolution ready (flag 0%).' },
    prometheus: { icon: '🔥', name: 'Prometheus', role: 'Tester', desc: 'Testea creativos en [TESTING] campaign 5x/día. Procedural. Graduate ≥3x ROAS + 2 purch. Kill agresivo.' },
    ares: { icon: '⚔️', name: 'Ares', role: 'Portfolio Manager', desc: '3 CBOs (Production, Rising, Medición). Criterios endurecidos. Retirement auto. Futuro: migración a Claude.' }
  };

  const info = agentInfo[agent] || { icon: '?', name: agent, role: '', desc: '' };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: '2.4rem' }}>{info.icon}</span>
          <div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--bos-text)' }}>{info.name}</div>
            <div style={{ fontSize: '0.78rem', color: 'var(--bos-text-muted)' }}>{info.role}</div>
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'transparent', border: 'none',
            color: 'var(--bos-text-muted)', fontSize: '1.5rem',
            cursor: 'pointer', padding: 8
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.2)', borderRadius: 12, padding: 16, fontSize: '0.85rem', color: 'var(--bos-text)', lineHeight: 1.6 }}>
        {info.desc}
      </div>

      <div style={{ marginTop: 24 }}>
        <div style={{ fontSize: '0.7rem', color: 'var(--bos-text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
          Ver detalle completo
        </div>
        <button
          onClick={() => { window.location.href = '/brain?tab=' + agent; }}
          style={{
            background: 'linear-gradient(90deg, var(--bos-synapse), var(--bos-electric))',
            color: 'white', border: 'none', borderRadius: 10,
            padding: '12px 20px', fontSize: '0.85rem', fontWeight: 600,
            cursor: 'pointer', width: '100%'
          }}
        >
          Abrir panel completo de {info.name} →
        </button>
      </div>
    </div>
  );
}
