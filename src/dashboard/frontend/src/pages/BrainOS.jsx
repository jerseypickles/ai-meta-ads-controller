import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import '../brain-os.css';
import ZeusSpeaks from '../components/ZeusSpeaks';
import NeuralCommandCenter from '../components/NeuralCommandCenter';
import DemeterWidget from '../components/DemeterWidget';
import TemporalSpine from '../components/TemporalSpine';
import DNAGenomeSpace from '../components/DNAGenomeSpace';
import ZeusPanel from '../components/agents/ZeusPanel';
import AthenaPanel from '../components/agents/AthenaPanel';
import ApolloPanel from '../components/agents/ApolloPanel';
import PrometheusPanel from '../components/agents/PrometheusPanel';
import AresPanel from '../components/agents/AresPanel';

export default function BrainOS() {
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [showGenome, setShowGenome] = useState(false);
  const [focusRequest, setFocusRequest] = useState(null); // { kind, id, ts }

  // Exportamos el contexto actual del dashboard al window para que ZeusSpeaks
  // lo pueda leer y mandar en cada request — Zeus sabe qué panel estás viendo.
  useEffect(() => {
    const ctx = selectedAgent
      ? { view: `agent_panel:${selectedAgent}` }
      : showGenome
      ? { view: 'dna_genome_space' }
      : { view: 'brain_os_home' };
    window.__zeusUiContext = ctx;
  }, [selectedAgent, showGenome]);

  useEffect(() => {
    function handleNavigate(e) {
      const { kind, id } = e.detail || {};
      if (!kind) return;

      const agentMap = {
        agent: id,
        adset: 'athena',       // ad sets viven en el panel de Athena
        ad: 'athena',
        campaign: 'athena',
        test: 'prometheus',
        dna: 'apollo',
        product: 'apollo',
        rec: 'zeus',
      };

      const targetAgent = agentMap[kind];
      if (targetAgent && ['zeus', 'athena', 'apollo', 'prometheus', 'ares'].includes(targetAgent)) {
        setSelectedAgent(targetAgent);
        if (id) setFocusRequest({ kind, id, ts: Date.now() });
      }
    }
    window.addEventListener('zeus-navigate', handleNavigate);
    return () => window.removeEventListener('zeus-navigate', handleNavigate);
  }, []);

  return (
    <div className="brain-os">
      <div className="brain-os-content">
        {/* Zeus — voice of the system */}
        <ZeusSpeaks />

        {/* Neural Command Center */}
        <NeuralCommandCenter onAgentClick={setSelectedAgent} />

        {/* Demeter — Cash Reconciliation Widget */}
        <DemeterWidget />

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
            <AgentDetailPanel
              agent={selectedAgent}
              focusRequest={focusRequest}
              onClose={() => setSelectedAgent(null)}
              onFocused={() => setFocusRequest(null)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function AgentDetailPanel({ agent, focusRequest, onClose, onFocused }) {
  // focusRequest solo aplica a Athena por ahora (adset/ad/campaign)
  const athenaFocus = agent === 'athena' && focusRequest && ['adset', 'ad', 'campaign'].includes(focusRequest.kind)
    ? focusRequest
    : null;

  const panels = {
    zeus: <ZeusPanel />,
    athena: <AthenaPanel focusRequest={athenaFocus} onFocused={onFocused} />,
    apollo: <ApolloPanel />,
    prometheus: <PrometheusPanel />,
    ares: <AresPanel />
  };

  return (
    <div>
      {/* Close button — floating top right */}
      <button
        onClick={onClose}
        style={{
          position: 'absolute',
          top: 20,
          right: 20,
          background: 'rgba(17, 21, 51, 0.9)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          color: 'var(--bos-text-muted)',
          fontSize: '1.2rem',
          cursor: 'pointer',
          width: 36,
          height: 36,
          borderRadius: 18,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 5,
          transition: 'all 0.2s'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--bos-text)';
          e.currentTarget.style.borderColor = 'var(--bos-synapse)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--bos-text-muted)';
          e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
        }}
      >
        ✕
      </button>

      {panels[agent] || <div className="bos-loading">Panel no disponible</div>}
    </div>
  );
}
