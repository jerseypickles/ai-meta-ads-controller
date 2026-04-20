import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  getCreativeProposals,
  getApolloIntelligence,
  getProducts,
  getProposalImageUrl,
  getDNALab,
  setApolloEvolutionRatio,
  sendProposalFeedback
} from '../../api';

const APOLLO_COLOR = '#fbbf24';

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  const diff = Date.now() - dt.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export default function ApolloPanel() {
  const [intel, setIntel] = useState(null);
  const [dna, setDna] = useState(null);
  const [proposals, setProposals] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState('overview');
  const [lightboxImg, setLightboxImg] = useState(null);
  const [feedbackModal, setFeedbackModal] = useState(null);

  useEffect(() => {
    loadAll();
    const interval = setInterval(loadAll, 60000);
    return () => clearInterval(interval);
  }, []);

  async function loadAll() {
    try {
      const [intelR, dnaR, propsR, prodsR] = await Promise.all([
        getApolloIntelligence().catch(() => ({})),
        getDNALab({ limit: 50, min_samples: 1 }).catch(() => ({})),
        getCreativeProposals().catch(() => []),
        getProducts().catch(() => [])
      ]);
      setIntel(intelR);
      setDna(dnaR);
      setProposals(Array.isArray(propsR) ? propsR : (propsR?.proposals || []));
      setProducts(Array.isArray(prodsR) ? prodsR : (prodsR?.products || []));
    } catch (err) {
      console.error('Apollo load error:', err);
    } finally {
      setLoading(false);
    }
  }

  async function changeEvolutionRatio(ratio) {
    if (!window.confirm(`Cambiar Apollo evolution a ${Math.round(ratio * 100)}%?`)) return;
    try {
      await setApolloEvolutionRatio(ratio);
      loadAll();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  if (loading && !intel) return <div className="bos-loading">Sintetizando inteligencia de Apollo...</div>;

  const readyProposals = proposals.filter(p => p.status === 'ready');
  const evolution = dna?.evolution || {};
  const dnaSpace = evolution.dna_space || {};
  const ratio = evolution.active_ratio || 0;
  const globalStats = dna?.global_stats || {};
  const poolReady = intel?.production?.ready || readyProposals.length;
  const zeusDirectives = intel?.zeus_directives || [];
  const scenes = intel?.scenes || [];
  const feedbackStats = intel?.feedback || {};
  const production = intel?.production || {};

  return (
    <div>
      {/* HERO */}
      <div style={{
        background: 'radial-gradient(ellipse at top left, rgba(251, 191, 36, 0.12) 0%, transparent 50%), radial-gradient(ellipse at bottom right, rgba(236, 72, 153, 0.08) 0%, transparent 50%)',
        borderRadius: 16,
        padding: '20px 24px',
        marginBottom: 20,
        position: 'relative',
        border: '1px solid rgba(251, 191, 36, 0.2)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <motion.div
            initial={{ scale: 0.5, opacity: 0, rotate: -20 }}
            animate={{ scale: 1, opacity: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 200 }}
            style={{
              width: 64, height: 64, borderRadius: '50%',
              background: `${APOLLO_COLOR}15`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `2px solid ${APOLLO_COLOR}40`,
              filter: `drop-shadow(0 0 20px ${APOLLO_COLOR})`,
              fontSize: '2rem'
            }}
          >
            ☀️
          </motion.div>
          <div style={{ flex: 1 }}>
            <div style={{
              fontSize: '1.7rem',
              fontWeight: 800,
              background: 'linear-gradient(135deg, #fbbf24, #f97316, #ec4899)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              letterSpacing: '0.02em',
              lineHeight: 1
            }}>
              APOLLO
            </div>
            <div style={{
              fontSize: '0.7rem',
              color: 'var(--bos-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              marginTop: 4
            }}>
              Creator · Gemini 3 + DNA Evolution
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '0.58rem', color: 'var(--bos-text-muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 4 }}>
              Evolution Active
            </div>
            <div style={{
              fontSize: '1.6rem',
              fontWeight: 800,
              color: ratio > 0 ? '#ec4899' : 'var(--bos-text-dim)',
              fontFamily: 'JetBrains Mono, monospace',
              filter: ratio > 0 ? 'drop-shadow(0 0 12px rgba(236, 72, 153, 0.4))' : 'none',
              lineHeight: 1
            }}>
              {Math.round(ratio * 100)}%
            </div>
          </div>
        </div>
      </div>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, marginBottom: 16 }}>
        {[
          { v: poolReady, l: 'Pool ready', c: poolReady >= 60 ? '#ef4444' : poolReady >= 40 ? '#fbbf24' : '#10b981' },
          { v: globalStats.total_dnas || 0, l: 'DNAs', c: '#8b5cf6' },
          { v: globalStats.total_tests || 0, l: 'Tests', c: '#60a5fa' },
          { v: globalStats.overall_win_rate ? Math.round(globalStats.overall_win_rate * 100) + '%' : '—', l: 'Win rate', c: '#10b981' },
          { v: production.graduated || 0, l: 'Graduados', c: '#10b981' },
          { v: production.killed || 0, l: 'Killed', c: '#ef4444' }
        ].map((s, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
            style={{
              background: 'rgba(10, 14, 39, 0.6)',
              border: '1px solid rgba(251, 191, 36, 0.1)',
              borderRadius: 10,
              padding: '10px 8px',
              textAlign: 'center',
              borderTop: `2px solid ${s.c}40`
            }}
          >
            <div style={{ fontSize: '1.25rem', fontWeight: 700, color: s.c, fontFamily: 'JetBrains Mono, monospace', lineHeight: 1 }}>
              {s.v}
            </div>
            <div style={{ fontSize: '0.56rem', color: 'var(--bos-text-muted)', marginTop: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {s.l}
            </div>
          </motion.div>
        ))}
      </div>

      {/* Section tabs */}
      <div style={{
        display: 'flex',
        gap: 4,
        marginBottom: 16,
        padding: 4,
        background: 'rgba(10, 14, 39, 0.4)',
        borderRadius: 10,
        overflowX: 'auto'
      }}>
        {[
          { k: 'overview', l: 'Resumen', c: APOLLO_COLOR },
          { k: 'pipeline', l: 'Pipeline', c: '#fbbf24', n: readyProposals.length },
          { k: 'dna', l: '🧬 DNA Lab', c: '#8b5cf6', n: globalStats.total_dnas },
          { k: 'intelligence', l: 'Inteligencia', c: '#60a5fa' },
          { k: 'evolution', l: 'Evolution', c: '#ec4899' },
          { k: 'products', l: 'Productos', c: '#10b981', n: products.length }
        ].map(t => {
          const active = activeSection === t.k;
          return (
            <button
              key={t.k}
              onClick={() => setActiveSection(t.k)}
              style={{
                flex: '1 1 auto',
                padding: '8px 12px',
                background: active ? `linear-gradient(135deg, ${t.c}25, ${t.c}12)` : 'transparent',
                border: active ? `1px solid ${t.c}50` : '1px solid transparent',
                borderRadius: 6,
                color: active ? t.c : 'var(--bos-text-muted)',
                fontSize: '0.68rem',
                fontWeight: active ? 700 : 500,
                cursor: 'pointer',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                whiteSpace: 'nowrap'
              }}
            >
              {t.l} {t.n != null && t.n > 0 && <span style={{ opacity: 0.6, marginLeft: 3 }}>{t.n}</span>}
            </button>
          );
        })}
      </div>

      {/* Section content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={activeSection}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.25 }}
        >
          {activeSection === 'overview' && (
            <OverviewSection
              production={production}
              feedbackStats={feedbackStats}
              zeusDirectives={zeusDirectives}
              scenes={scenes.slice(0, 6)}
              topDnas={(dna?.dnas || []).slice(0, 3)}
              dnaSpace={dnaSpace}
              ratio={ratio}
            />
          )}
          {activeSection === 'pipeline' && (
            <PipelineSection proposals={readyProposals} setLightbox={setLightboxImg} setFeedbackModal={setFeedbackModal} />
          )}
          {activeSection === 'dna' && (
            <DNALabSection dna={dna} dnaSpace={dnaSpace} />
          )}
          {activeSection === 'intelligence' && (
            <IntelligenceSection
              production={production}
              zeusDirectives={zeusDirectives}
              scenes={scenes}
              feedbackStats={feedbackStats}
            />
          )}
          {activeSection === 'evolution' && (
            <EvolutionSection ratio={ratio} dnaSpace={dnaSpace} evolution={evolution} onChange={changeEvolutionRatio} />
          )}
          {activeSection === 'products' && (
            <ProductsSection products={products} />
          )}
        </motion.div>
      </AnimatePresence>

      {/* Lightbox */}
      <AnimatePresence>
        {lightboxImg && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setLightboxImg(null)}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0, 0, 0, 0.92)',
              zIndex: 100,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 40,
              cursor: 'zoom-out'
            }}
          >
            <img src={lightboxImg} alt="" style={{ maxWidth: '90%', maxHeight: '90%', borderRadius: 12 }} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Feedback modal */}
      <AnimatePresence>
        {feedbackModal && (
          <FeedbackModal
            proposal={feedbackModal}
            onClose={() => setFeedbackModal(null)}
            onSubmit={async (reason, note) => {
              try {
                await sendProposalFeedback(feedbackModal.id, 'bad', reason, note);
                setFeedbackModal(null);
                loadAll();
              } catch (err) { alert('Error: ' + err.message); }
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// OVERVIEW
// ═══════════════════════════════════════════════════════════════════════════

function OverviewSection({ production, feedbackStats, zeusDirectives, scenes, topDnas, dnaSpace, ratio }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Zeus directives */}
      {zeusDirectives.length > 0 && (
        <div style={{
          background: 'linear-gradient(135deg, rgba(251, 191, 36, 0.08), rgba(251, 146, 60, 0.04))',
          border: '1px solid rgba(251, 191, 36, 0.25)',
          borderLeft: '3px solid #fbbf24',
          borderRadius: 10,
          padding: '12px 16px'
        }}>
          <SectionHeader label="⚡ Directivas de Zeus" count={zeusDirectives.length} color="#fbbf24" />
          {zeusDirectives.map((d, i) => {
            const tcolor = d.directive_type === 'prioritize' ? '#10b981' : d.directive_type === 'avoid' ? '#ef4444' : '#3b82f6';
            return (
              <div key={i} style={{ fontSize: '0.8rem', color: 'var(--bos-text)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: '0.56rem', fontWeight: 700, padding: '2px 6px', borderRadius: 3, background: `${tcolor}20`, color: tcolor, textTransform: 'uppercase' }}>
                  {d.directive_type}
                </span>
                {d.directive}
              </div>
            );
          })}
        </div>
      )}

      {/* Grid: top DNAs + top scenes side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <SectionHeader label="Top 3 DNAs" color="#8b5cf6" />
          {topDnas.length === 0 ? (
            <Empty>Sin DNAs aún</Empty>
          ) : topDnas.map((d, i) => (
            <TopDnaCard key={d.dna_hash || i} d={d} index={i} />
          ))}
        </div>
        <div>
          <SectionHeader label="Top Scenes" color="#10b981" />
          {scenes.length === 0 ? (
            <Empty>Sin datos de scenes</Empty>
          ) : scenes.slice(0, 3).map((s, i) => (
            <SceneCard key={i} s={s} />
          ))}
        </div>
      </div>

      {/* Evolution quick control */}
      <div style={{
        background: 'linear-gradient(135deg, rgba(236, 72, 153, 0.06), rgba(139, 92, 246, 0.03))',
        border: '1px solid rgba(236, 72, 153, 0.2)',
        borderRadius: 10,
        padding: '12px 16px'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: '0.62rem', color: '#ec4899', textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700 }}>
              🧬 Evolution Status
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--bos-text)', marginTop: 4 }}>
              {ratio === 0 ? 'Apollo genera random (legacy mode)' : `${Math.round(ratio * 100)}% de proposals son evolutionary`}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '0.6rem', color: 'var(--bos-text-muted)' }}>Convergence</div>
            <div style={{ fontSize: '0.85rem', color: '#ec4899', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
              {dnaSpace.convergence_status || '—'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TopDnaCard({ d, index }) {
  const f = d.fitness || {};
  const color = f.avg_roas >= 5 ? '#10b981' : f.avg_roas >= 2 ? '#fbbf24' : '#ef4444';
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      style={{
        background: 'rgba(17, 21, 51, 0.5)',
        borderLeft: `3px solid ${color}`,
        borderRadius: 6,
        padding: '8px 12px',
        marginBottom: 5
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        <span style={{ fontSize: '0.62rem', color: 'var(--bos-text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>#{index + 1}</span>
        <span style={{ fontSize: '0.95rem', fontWeight: 700, color, fontFamily: 'JetBrains Mono, monospace' }}>
          {f.avg_roas}x
        </span>
        <span style={{ fontSize: '0.62rem', color: 'var(--bos-text-muted)' }}>
          {f.tests_graduated || 0}/{f.tests_total || 0} wins
        </span>
      </div>
      <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
        {['style', 'copy_angle', 'scene'].map(dim => (
          <span key={dim} style={{
            fontSize: '0.55rem',
            padding: '1px 5px',
            background: 'rgba(10, 14, 39, 0.7)',
            borderRadius: 3,
            color: 'var(--bos-text-muted)'
          }}>
            {(d.dimensions?.[dim] || '?').substring(0, 18)}
          </span>
        ))}
      </div>
    </motion.div>
  );
}

function SceneCard({ s }) {
  const c = s.win_rate >= 50 ? '#10b981' : s.win_rate > 0 ? '#fbbf24' : '#ef4444';
  return (
    <div style={{
      background: 'rgba(17, 21, 51, 0.5)',
      borderLeft: `3px solid ${c}`,
      borderRadius: 6,
      padding: '8px 12px',
      marginBottom: 5
    }}>
      <div style={{ fontSize: '0.72rem', color: 'var(--bos-text)', marginBottom: 3 }}>{(s.scene || '').substring(0, 36)}</div>
      <div style={{ display: 'flex', gap: 10, fontSize: '0.62rem', fontFamily: 'JetBrains Mono, monospace' }}>
        <span style={{ color: c, fontWeight: 700 }}>{s.win_rate}% win</span>
        <span style={{ color: 'var(--bos-text-muted)' }}>{s.avg_roas}x</span>
        <span style={{ color: 'var(--bos-text-dim)' }}>{s.wins}W/{s.total - s.wins}L</span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PIPELINE — ready proposals grid
// ═══════════════════════════════════════════════════════════════════════════

function PipelineSection({ proposals, setLightbox, setFeedbackModal }) {
  if (proposals.length === 0) {
    return (
      <Empty>
        Pipeline vacío. Apollo generará creativos en el próximo ciclo si el pool está bajo.
      </Empty>
    );
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
      gap: 10
    }}>
      {proposals.map((p, i) => (
        <motion.div
          key={p._id}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: Math.min(i * 0.02, 0.5) }}
          style={{
            background: 'rgba(17, 21, 51, 0.55)',
            border: '1px solid rgba(255, 255, 255, 0.06)',
            borderRadius: 10,
            overflow: 'hidden',
            cursor: 'pointer'
          }}
        >
          <div
            onClick={() => setLightbox(getProposalImageUrl(p._id))}
            style={{ position: 'relative', aspectRatio: '1', overflow: 'hidden' }}
          >
            <img
              src={getProposalImageUrl(p._id)}
              alt={p.headline}
              loading="lazy"
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
            <div style={{
              position: 'absolute',
              top: 6, right: 6,
              background: 'rgba(251, 191, 36, 0.9)',
              color: '#000',
              padding: '2px 6px',
              borderRadius: 4,
              fontSize: '0.55rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.08em'
            }}>
              Ready
            </div>
            {p.evolution_strategy && p.evolution_strategy !== 'random' && (
              <div style={{
                position: 'absolute',
                top: 6, left: 6,
                background: 'rgba(236, 72, 153, 0.9)',
                color: '#fff',
                padding: '2px 6px',
                borderRadius: 4,
                fontSize: '0.55rem',
                fontWeight: 700,
                textTransform: 'uppercase'
              }}>
                🧬 {p.evolution_strategy}
              </div>
            )}
          </div>
          <div style={{ padding: 10 }}>
            <div style={{ fontSize: '0.72rem', color: 'var(--bos-text)', fontWeight: 600, lineHeight: 1.3, marginBottom: 4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
              {p.headline}
            </div>
            <div style={{ fontSize: '0.6rem', color: 'var(--bos-text-muted)', marginBottom: 6, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
              {p.primary_text}
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
              <span style={{ fontSize: '0.55rem', padding: '1px 5px', background: 'rgba(251, 191, 36, 0.15)', color: '#fbbf24', borderRadius: 3 }}>
                {(p.product_name || '').substring(0, 20)}
              </span>
              <span style={{ fontSize: '0.55rem', padding: '1px 5px', background: 'rgba(16, 185, 129, 0.15)', color: '#10b981', borderRadius: 3 }}>
                {p.scene_short?.substring(0, 20) || 'scene'}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.55rem', color: 'var(--bos-text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
                {formatDate(p.created_at)}
              </span>
              {p.human_feedback?.rating === 'bad' ? (
                <span style={{ fontSize: '0.55rem', color: '#ef4444', background: 'rgba(239,68,68,0.1)', padding: '1px 5px', borderRadius: 3 }}>
                  {p.human_feedback.reason || 'flagged'}
                </span>
              ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); setFeedbackModal({ id: p._id, headline: p.headline }); }}
                  style={{
                    background: 'transparent',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: 3,
                    padding: '1px 6px',
                    fontSize: '0.55rem',
                    color: 'var(--bos-text-muted)',
                    cursor: 'pointer'
                  }}
                >
                  👎 report
                </button>
              )}
            </div>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DNA LAB — top DNAs + distributions
// ═══════════════════════════════════════════════════════════════════════════

function DNALabSection({ dna, dnaSpace }) {
  const dnas = dna?.dnas || [];
  const distributions = dna?.distributions || {};

  if (dnas.length === 0) {
    return <Empty>Sin DNAs aún. Se poblarán con cada test resuelto.</Empty>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Space metrics */}
      {dnaSpace.normalized_entropy != null && (
        <div style={{
          background: 'rgba(139, 92, 246, 0.05)',
          border: '1px solid rgba(139, 92, 246, 0.2)',
          borderRadius: 10,
          padding: '10px 14px',
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 12
        }}>
          {[
            { l: 'Entropy', v: dnaSpace.normalized_entropy, c: '#8b5cf6' },
            { l: 'DNAs únicos', v: dnaSpace.unique_dnas, c: 'var(--bos-text)' },
            { l: 'Dominant DNA', v: (dnaSpace.dominant_dna_pct || 0) + '%', c: '#ec4899' },
            { l: 'Status', v: dnaSpace.convergence_status, c: '#10b981', text: true }
          ].map((s, i) => (
            <div key={i} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: s.text ? '0.82rem' : '1.1rem', fontWeight: 700, color: s.c, fontFamily: s.text ? 'inherit' : 'JetBrains Mono, monospace' }}>
                {s.v}
              </div>
              <div style={{ fontSize: '0.58rem', color: 'var(--bos-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 3 }}>
                {s.l}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Dimension distributions */}
      {Object.keys(distributions).length > 0 && (
        <div style={{
          background: 'rgba(17, 21, 51, 0.4)',
          borderRadius: 10,
          padding: '10px 14px'
        }}>
          <SectionHeader label="Distribución por dimensión" color="#60a5fa" />
          {['style', 'angle', 'product', 'scene', 'hook'].map(dim => {
            const top = (distributions[dim] || []).slice(0, 8);
            if (top.length === 0) return null;
            return (
              <div key={dim} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: '0.58rem', color: 'var(--bos-text-muted)', marginBottom: 4, textTransform: 'capitalize' }}>{dim}:</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {top.map((item, i) => {
                    const c = item.avg_roas >= 5 ? '#10b981' : item.avg_roas >= 2 ? '#fbbf24' : '#ef4444';
                    return (
                      <span key={i} style={{
                        padding: '2px 8px',
                        borderRadius: 10,
                        fontSize: '0.6rem',
                        background: 'rgba(10, 14, 39, 0.6)',
                        border: '1px solid rgba(255, 255, 255, 0.06)'
                      }}>
                        <span style={{ color: 'var(--bos-text)' }}>{(item.value || '?').substring(0, 24)}</span>
                        <span style={{ color: 'var(--bos-text-muted)', marginLeft: 4 }}>{item.tests}t</span>
                        <span style={{ color: c, marginLeft: 4, fontFamily: 'JetBrains Mono, monospace' }}>{item.avg_roas}x</span>
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Top DNAs ranked */}
      <div>
        <SectionHeader label={`Top ${Math.min(dnas.length, 15)} DNAs`} count={dnas.length} color="#8b5cf6" />
        {dnas.slice(0, 15).map((d, i) => {
          const f = d.fitness || {};
          const roasColor = f.avg_roas >= 5 ? '#10b981' : f.avg_roas >= 2 ? '#fbbf24' : '#ef4444';
          return (
            <motion.div
              key={d.dna_hash || i}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.03 }}
              style={{
                background: 'rgba(17, 21, 51, 0.5)',
                borderLeft: `3px solid ${roasColor}`,
                borderRadius: 8,
                padding: '10px 14px',
                marginBottom: 5
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                <span style={{ fontSize: '0.62rem', color: 'var(--bos-text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>#{i + 1}</span>
                <span style={{ fontSize: '1rem', fontWeight: 700, color: roasColor, fontFamily: 'JetBrains Mono, monospace' }}>
                  {f.avg_roas}x
                </span>
                <span style={{ fontSize: '0.6rem', color: 'var(--bos-text)' }}>
                  {f.tests_graduated || 0}/{f.tests_total || 0} wins
                </span>
                <span style={{ fontSize: '0.58rem', color: 'var(--bos-text-muted)', marginLeft: 'auto', fontFamily: 'JetBrains Mono, monospace' }}>
                  conf {Math.round((f.sample_confidence || 0) * 100)}%
                </span>
                {d.generation > 0 && (
                  <span style={{ fontSize: '0.55rem', padding: '1px 5px', background: 'rgba(236, 72, 153, 0.15)', color: '#ec4899', borderRadius: 3, textTransform: 'uppercase' }}>
                    gen {d.generation}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {['style', 'copy_angle', 'scene', 'product', 'hook_type'].map(dim => (
                  <span key={dim} style={{
                    fontSize: '0.58rem',
                    padding: '1px 6px',
                    background: 'rgba(10, 14, 39, 0.8)',
                    borderRadius: 3,
                    color: 'var(--bos-text-muted)'
                  }}>
                    {(d.dimensions?.[dim] || '?').substring(0, 24)}
                  </span>
                ))}
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// INTELLIGENCE — scenes + feedback reasons
// ═══════════════════════════════════════════════════════════════════════════

function IntelligenceSection({ production, zeusDirectives, scenes, feedbackStats }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Production stats */}
      {production && Object.keys(production).length > 0 && (
        <div style={{
          background: 'rgba(17, 21, 51, 0.4)',
          borderRadius: 10,
          padding: '10px 14px'
        }}>
          <SectionHeader label="Producción histórica" color="#60a5fa" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
            {[
              { l: 'Total', v: production.total_generated, c: 'var(--bos-text)' },
              { l: 'Ready', v: production.ready, c: '#fbbf24' },
              { l: 'Testing', v: production.testing, c: '#f97316' },
              { l: 'Graduated', v: production.graduated, c: '#10b981' },
              { l: 'Killed', v: production.killed, c: '#ef4444' },
              { l: 'Bad feedback', v: feedbackStats.bad || 0, c: '#ef4444' }
            ].map((s, i) => (
              <div key={i} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '1.1rem', fontWeight: 700, color: s.c, fontFamily: 'JetBrains Mono, monospace' }}>
                  {s.v || 0}
                </div>
                <div style={{ fontSize: '0.55rem', color: 'var(--bos-text-muted)', marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  {s.l}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Zeus directives (full) */}
      {zeusDirectives.length > 0 && (
        <div>
          <SectionHeader label="Directivas de Zeus" count={zeusDirectives.length} color="#fbbf24" />
          {zeusDirectives.map((d, i) => {
            const tcolor = d.directive_type === 'prioritize' ? '#10b981' : d.directive_type === 'avoid' ? '#ef4444' : '#3b82f6';
            return (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.04 }}
                style={{
                  background: 'rgba(17, 21, 51, 0.5)',
                  borderLeft: `3px solid ${tcolor}`,
                  borderRadius: 8,
                  padding: '8px 14px',
                  marginBottom: 5
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                  <span style={{ fontSize: '0.56rem', fontWeight: 700, padding: '2px 6px', borderRadius: 3, background: `${tcolor}20`, color: tcolor, textTransform: 'uppercase' }}>
                    {d.directive_type}
                  </span>
                  <span style={{ fontSize: '0.55rem', color: 'var(--bos-text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
                    conf {Math.round((d.confidence || 0) * 100)}%
                  </span>
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--bos-text)' }}>{d.directive}</div>
              </motion.div>
            );
          })}
        </div>
      )}

      {/* Scene performance full */}
      {scenes.length > 0 && (
        <div>
          <SectionHeader label="Performance por escena" count={scenes.length} color="#10b981" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6 }}>
            {scenes.map((s, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: i * 0.02 }}
              >
                <SceneCard s={s} />
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {/* Feedback reasons */}
      {feedbackStats.reasons?.length > 0 && (
        <div>
          <SectionHeader label="Feedback humano" color="#ef4444" />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {feedbackStats.reasons.map((r, i) => (
              <span key={i} style={{
                fontSize: '0.7rem',
                padding: '5px 12px',
                borderRadius: 6,
                background: 'rgba(239, 68, 68, 0.1)',
                color: '#ef4444',
                border: '1px solid rgba(239, 68, 68, 0.2)',
                fontFamily: 'JetBrains Mono, monospace'
              }}>
                {r._id}: {r.count}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// EVOLUTION — feature flag control + strategy mix
// ═══════════════════════════════════════════════════════════════════════════

function EvolutionSection({ ratio, dnaSpace, evolution, onChange }) {
  const breakdown = evolution.proposals_last_7d?.strategy_ratios;
  const total7d = evolution.proposals_last_7d?.total || 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Main flag control */}
      <div style={{
        background: 'linear-gradient(135deg, rgba(236, 72, 153, 0.08), rgba(139, 92, 246, 0.05))',
        border: '1px solid rgba(236, 72, 153, 0.3)',
        borderRadius: 12,
        padding: '16px 20px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <span style={{ fontSize: '1.4rem' }}>🧬</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '0.75rem', color: '#ec4899', textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700 }}>
              Apollo Evolution Flag
            </div>
            <div style={{ fontSize: '0.65rem', color: 'var(--bos-text-muted)', marginTop: 2 }}>
              Controla qué % de generación usa DNA-driven vs random
            </div>
          </div>
          <div style={{
            fontSize: '1.9rem',
            fontWeight: 800,
            color: ratio > 0 ? '#ec4899' : 'var(--bos-text-dim)',
            fontFamily: 'JetBrains Mono, monospace',
            filter: ratio > 0 ? 'drop-shadow(0 0 10px #ec4899)' : 'none',
            lineHeight: 1
          }}>
            {Math.round(ratio * 100)}%
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[
            { r: 0, l: '0%', h: 'Legacy' },
            { r: 0.2, l: '20%', h: 'Gradual' },
            { r: 0.5, l: '50%', h: 'A/B' },
            { r: 0.8, l: '80%', h: 'Mostly' },
            { r: 1, l: '100%', h: 'Full' }
          ].map(o => {
            const active = Math.abs(ratio - o.r) < 0.01;
            return (
              <button
                key={o.r}
                onClick={() => onChange(o.r)}
                style={{
                  flex: 1,
                  padding: '10px 8px',
                  borderRadius: 8,
                  border: active ? '2px solid #ec4899' : '1px solid rgba(255, 255, 255, 0.1)',
                  background: active ? 'rgba(236, 72, 153, 0.15)' : 'rgba(10, 14, 39, 0.5)',
                  color: active ? '#ec4899' : 'var(--bos-text-muted)',
                  cursor: 'pointer'
                }}
              >
                <div style={{ fontSize: '0.85rem', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>{o.l}</div>
                <div style={{ fontSize: '0.55rem', marginTop: 2 }}>{o.h}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Strategy mix breakdown */}
      {breakdown && total7d > 0 && (
        <div>
          <SectionHeader label={`Strategy mix 7d · ${total7d} proposals`} color="#8b5cf6" />
          <div style={{ display: 'flex', height: 32, borderRadius: 8, overflow: 'hidden', marginBottom: 8 }}>
            {[
              { k: 'random', c: '#6b7280' },
              { k: 'exploit', c: '#10b981' },
              { k: 'mutate', c: '#fbbf24' },
              { k: 'crossover', c: '#ec4899' },
              { k: 'explore', c: '#3b82f6' }
            ].map(s => {
              const pct = breakdown[s.k] || 0;
              if (pct === 0) return null;
              return (
                <motion.div
                  key={s.k}
                  initial={{ width: 0 }}
                  animate={{ width: pct + '%' }}
                  transition={{ duration: 0.8 }}
                  style={{
                    background: s.c,
                    fontSize: '0.65rem',
                    color: 'white',
                    textAlign: 'center',
                    lineHeight: '32px',
                    fontWeight: 700,
                    fontFamily: 'JetBrains Mono, monospace'
                  }}
                >
                  {pct > 10 ? pct + '%' : ''}
                </motion.div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 14, fontSize: '0.65rem', color: 'var(--bos-text-muted)', flexWrap: 'wrap' }}>
            {['random', 'exploit', 'mutate', 'crossover', 'explore'].map(k => {
              const counts = evolution.proposals_last_7d?.by_strategy || {};
              return (
                <span key={k}>
                  ● {k}: <strong style={{ color: 'var(--bos-text)' }}>{counts[k] || 0}</strong> <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>({breakdown[k] || 0}%)</span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Explanation */}
      <div style={{
        background: 'rgba(10, 14, 39, 0.4)',
        borderRadius: 10,
        padding: '12px 16px',
        fontSize: '0.72rem',
        color: 'var(--bos-text-muted)',
        lineHeight: 1.6
      }}>
        <div style={{ color: 'var(--bos-text)', fontWeight: 600, marginBottom: 6 }}>Cómo funciona</div>
        <div><strong style={{ color: '#10b981' }}>Exploit</strong>: sample weighted desde top DNAs ganadores (60% default)</div>
        <div><strong style={{ color: '#fbbf24' }}>Mutate</strong>: toma un winner, cambia 1 dim random (25%)</div>
        <div><strong style={{ color: '#ec4899' }}>Crossover</strong>: combina 2 winners 50/50 (15%)</div>
        <div><strong style={{ color: '#3b82f6' }}>Explore</strong>: random del pool para diversidad (0%)</div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PRODUCTS — list
// ═══════════════════════════════════════════════════════════════════════════

function ProductsSection({ products }) {
  if (products.length === 0) return <Empty>Sin productos registrados</Empty>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
      {products.map((p, i) => (
        <motion.div
          key={p._id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.04 }}
          style={{
            background: 'rgba(17, 21, 51, 0.55)',
            border: '1px solid rgba(16, 185, 129, 0.15)',
            borderRadius: 10,
            padding: 12
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            {p.png_references?.[0] && (
              <div style={{ width: 44, height: 44, borderRadius: 8, overflow: 'hidden', background: 'rgba(10, 14, 39, 0.5)', flexShrink: 0 }}>
                {p.png_references[0].image_base64 ? (
                  <img src={`data:${p.png_references[0].mime_type || 'image/png'};base64,${p.png_references[0].image_base64}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: '1.4rem' }}>📦</div>
                )}
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.78rem', color: 'var(--bos-text)', fontWeight: 600 }}>{p.product_name}</div>
              <div style={{ fontSize: '0.6rem', color: 'var(--bos-text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>{p.product_slug}</div>
            </div>
          </div>
          <div style={{ fontSize: '0.62rem', color: 'var(--bos-text-muted)' }}>
            {p.png_references?.length || 0} refs · {p.prompt_type === 'custom' ? 'custom prompt' : 'generic'}
            {p.performance?.avg_roas && (
              <span style={{ float: 'right', color: '#10b981', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                {p.performance.avg_roas}x avg
              </span>
            )}
          </div>
        </motion.div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// FEEDBACK MODAL
// ═══════════════════════════════════════════════════════════════════════════

function FeedbackModal({ proposal, onClose, onSubmit }) {
  const [reason, setReason] = useState('bad_image');
  const [note, setNote] = useState('');
  const reasons = [
    { k: 'bad_image', l: 'Imagen mala' },
    { k: 'wrong_product', l: 'Producto equivocado' },
    { k: 'bad_copy', l: 'Copy malo' },
    { k: 'wrong_colors', l: 'Colores incorrectos' },
    { k: 'not_realistic', l: 'No realista' },
    { k: 'other', l: 'Otro' }
  ];
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        zIndex: 120,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40
      }}
    >
      <motion.div
        initial={{ scale: 0.9 }}
        animate={{ scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bos-bg-deep)',
          border: '1px solid rgba(239, 68, 68, 0.3)',
          borderRadius: 14,
          padding: '24px 28px',
          width: 420,
          maxWidth: '90vw'
        }}
      >
        <div style={{ fontSize: '1rem', color: 'var(--bos-text)', fontWeight: 600, marginBottom: 6 }}>
          Reportar creative
        </div>
        <div style={{ fontSize: '0.72rem', color: 'var(--bos-text-muted)', marginBottom: 16 }}>
          {proposal.headline}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
          {reasons.map(r => (
            <button
              key={r.k}
              onClick={() => setReason(r.k)}
              style={{
                padding: '8px 12px',
                textAlign: 'left',
                border: reason === r.k ? '1px solid #ef4444' : '1px solid rgba(255, 255, 255, 0.08)',
                background: reason === r.k ? 'rgba(239, 68, 68, 0.1)' : 'rgba(10, 14, 39, 0.5)',
                color: reason === r.k ? '#ef4444' : 'var(--bos-text)',
                borderRadius: 6,
                fontSize: '0.78rem',
                cursor: 'pointer'
              }}
            >
              {r.l}
            </button>
          ))}
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Nota opcional..."
          rows={3}
          style={{
            width: '100%',
            padding: 10,
            background: 'rgba(10, 14, 39, 0.5)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: 8,
            color: 'var(--bos-text)',
            fontSize: '0.76rem',
            resize: 'vertical',
            fontFamily: 'inherit',
            marginBottom: 14
          }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={{ flex: 1, padding: '10px', background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: 'var(--bos-text-muted)', cursor: 'pointer' }}>
            Cancelar
          </button>
          <button onClick={() => onSubmit(reason, note)} style={{ flex: 1, padding: '10px', background: 'linear-gradient(90deg, #ef4444, #dc2626)', border: 'none', borderRadius: 8, color: 'white', fontWeight: 600, cursor: 'pointer' }}>
            Reportar
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function SectionHeader({ label, count, color }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 10,
      fontSize: '0.65rem',
      color: color || 'var(--bos-text-muted)',
      textTransform: 'uppercase',
      letterSpacing: '0.12em',
      fontWeight: 700
    }}>
      <span>{label}</span>
      {count != null && (
        <span style={{
          background: `${color || '#6b7280'}15`,
          color: color || 'var(--bos-text-muted)',
          padding: '2px 8px',
          borderRadius: 10,
          fontSize: '0.58rem',
          fontFamily: 'JetBrains Mono, monospace'
        }}>
          {count}
        </span>
      )}
    </div>
  );
}

function Empty({ children }) {
  return (
    <div style={{
      padding: '24px',
      textAlign: 'center',
      color: 'var(--bos-text-dim)',
      fontSize: '0.82rem',
      fontStyle: 'italic',
      background: 'rgba(10, 14, 39, 0.3)',
      border: '1px dashed rgba(255, 255, 255, 0.08)',
      borderRadius: 10
    }}>
      {children}
    </div>
  );
}
