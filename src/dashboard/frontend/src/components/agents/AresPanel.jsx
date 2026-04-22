import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { getAresIntelligence, runAresApi } from '../../api';
import api from '../../api';
import { ResponsiveContainer, LineChart, Line, YAxis } from 'recharts';

const ARES_COLOR = '#ef4444';

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  const diff = Date.now() - dt.getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return 'hace <1h';
  if (h < 24) return `hace ${h}h`;
  return `${dt.getDate()}/${dt.getMonth() + 1}`;
}

const roasColor = (r) => r >= 3 ? '#10b981' : r >= 1.5 ? '#f59e0b' : r > 0 ? '#ef4444' : 'var(--bos-text-dim)';

export default function AresPanel() {
  const [data, setData] = useState(null);
  const [cboHealth, setCboHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [activeSection, setActiveSection] = useState('overview');

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60000);
    return () => clearInterval(interval);
  }, []);

  async function loadData() {
    try {
      const [aresRes, healthRes] = await Promise.all([
        getAresIntelligence().catch(() => null),
        // Health monitor endpoint — nuevo
        api.get('/api/ares/cbo-health').then(r => r.data).catch(() => null)
      ]);
      setData(aresRes || {});
      setCboHealth(healthRes);
    } catch (err) {
      console.error('Ares load error:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleRun() {
    setRunning(true);
    try { await runAresApi(); await loadData(); }
    catch (err) { console.error(err); }
    finally { setRunning(false); }
  }

  if (loading && !data) {
    return <div className="bos-loading">Sintetizando inteligencia de Ares...</div>;
  }

  const cbo = data?.cbo || {};
  const cbo1 = data?.cbo1 || {};
  const cbo2 = data?.cbo2 || {};
  const cbo3 = data?.cbo3 || {};
  const candidates = data?.candidates || [];
  const dups = data?.recent_duplications || [];
  const allClones = (cbo1.active_clones || 0) + (cbo2.active_clones || 0) + (cbo3.active_clones || 0);

  return (
    <div>
      {/* HERO */}
      <div style={{
        background: 'radial-gradient(ellipse at top left, rgba(239, 68, 68, 0.12) 0%, transparent 50%), radial-gradient(ellipse at bottom right, rgba(245, 158, 11, 0.08) 0%, transparent 50%)',
        borderRadius: 16,
        padding: '20px 24px',
        marginBottom: 20,
        border: '1px solid rgba(239, 68, 68, 0.2)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <motion.div
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring' }}
            style={{
              width: 64, height: 64, borderRadius: '50%',
              background: `${ARES_COLOR}15`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `2px solid ${ARES_COLOR}40`,
              filter: `drop-shadow(0 0 20px ${ARES_COLOR})`,
              fontSize: '2rem'
            }}
          >
            ⚔️
          </motion.div>
          <div style={{ flex: 1 }}>
            <div style={{
              fontSize: '1.7rem',
              fontWeight: 800,
              background: 'linear-gradient(135deg, #ef4444, #dc2626, #f59e0b)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              lineHeight: 1
            }}>
              ARES
            </div>
            <div style={{
              fontSize: '0.7rem',
              color: 'var(--bos-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              marginTop: 4
            }}>
              Duplicador · 3 campañas CBO (scale + rescate)
            </div>
          </div>
          <div style={{ textAlign: 'right', marginRight: 14 }}>
            <div style={{ fontSize: '0.58rem', color: 'var(--bos-text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>ROAS total</div>
            <div style={{
              fontSize: '1.9rem',
              fontWeight: 800,
              color: roasColor(cbo.roas || 0),
              fontFamily: 'JetBrains Mono, monospace',
              lineHeight: 1,
              filter: `drop-shadow(0 0 12px ${roasColor(cbo.roas || 0)}60)`
            }}>
              {cbo.roas || 0}x
            </div>
          </div>
          <button
            onClick={handleRun}
            disabled={running}
            style={{
              padding: '8px 20px',
              background: `linear-gradient(90deg, ${ARES_COLOR}, #dc2626)`,
              border: 'none',
              borderRadius: 8,
              color: 'white',
              fontWeight: 700,
              fontSize: '0.78rem',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              cursor: running ? 'not-allowed' : 'pointer',
              opacity: running ? 0.5 : 1
            }}
          >
            {running ? 'Ejecutando...' : '⚡ Run Ares'}
          </button>
        </div>
      </div>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, marginBottom: 16 }}>
        {[
          { v: allClones, l: 'Clones activos', c: ARES_COLOR },
          { v: '$' + (cbo.revenue_7d || 0).toLocaleString(), l: 'Revenue 7d', c: '#10b981' },
          { v: '$' + (cbo.spend_7d || 0).toLocaleString(), l: 'Spend 7d', c: '#f59e0b' },
          { v: cbo.purchases_7d || 0, l: 'Compras 7d', c: '#60a5fa' },
          { v: candidates.length, l: 'Candidatos', c: candidates.length > 0 ? '#10b981' : 'var(--bos-text-dim)' },
          { v: data?.total_duplicated || 0, l: 'Total duplicados', c: '#8b5cf6' }
        ].map((s, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
            style={{
              background: 'rgba(10, 14, 39, 0.6)',
              border: '1px solid rgba(239, 68, 68, 0.1)',
              borderRadius: 10,
              padding: '10px 8px',
              textAlign: 'center',
              borderTop: `2px solid ${s.c}40`
            }}
          >
            <div style={{ fontSize: '1.2rem', fontWeight: 700, color: s.c, fontFamily: 'JetBrains Mono, monospace', lineHeight: 1 }}>
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
          { k: 'overview', l: 'Resumen', c: ARES_COLOR },
          { k: 'health', l: 'Salud CBOs', c: '#10b981', n: cboHealth?.summary?.total },
          { k: 'cbo1', l: 'CBO 1 · Probados', c: '#ef4444', n: cbo1.active_clones },
          { k: 'cbo2', l: 'CBO 2 · Nuevos', c: '#f59e0b', n: cbo2.active_clones },
          { k: 'cbo3', l: 'CBO 3 · Rescate', c: '#8b5cf6', n: cbo3.active_clones },
          { k: 'candidates', l: 'Candidatos', c: '#10b981', n: candidates.length },
          { k: 'history', l: 'Historial', c: '#6b7280', n: dups.length },
          { k: 'criteria', l: 'Criterios', c: '#60a5fa' }
        ].map(t => {
          const active = activeSection === t.k;
          return (
            <button
              key={t.k}
              onClick={() => setActiveSection(t.k)}
              style={{
                flex: '1 1 auto',
                padding: '8px 10px',
                background: active ? `linear-gradient(135deg, ${t.c}25, ${t.c}12)` : 'transparent',
                border: active ? `1px solid ${t.c}50` : '1px solid transparent',
                borderRadius: 6,
                color: active ? t.c : 'var(--bos-text-muted)',
                fontSize: '0.66rem',
                fontWeight: active ? 700 : 500,
                cursor: 'pointer',
                textTransform: 'uppercase',
                letterSpacing: '0.07em',
                whiteSpace: 'nowrap'
              }}
            >
              {t.l} {t.n != null && t.n > 0 && <span style={{ opacity: 0.6, marginLeft: 3 }}>{t.n}</span>}
            </button>
          );
        })}
      </div>

      {/* Content */}
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
              cbo1={cbo1} cbo2={cbo2} cbo3={cbo3}
              candidates={candidates}
              recentDups={dups.slice(0, 5)}
              hasCBO3={!!data?.campaign_3_id}
            />
          )}
          {activeSection === 'health' && (
            <CBOHealthSection health={cboHealth} />
          )}
          {activeSection === 'cbo1' && (
            <CBODetailSection label="CBO 1 — Ganadores Probados" color="#ef4444" stats={cbo1} campaignId={data?.campaign_id} />
          )}
          {activeSection === 'cbo2' && (
            <CBODetailSection label="CBO 2 — Nuevos Ganadores" color="#f59e0b" stats={cbo2} campaignId={data?.campaign_2_id} />
          )}
          {activeSection === 'cbo3' && (
            <CBODetailSection label="CBO 3 — Medición / Rescate" color="#8b5cf6" stats={cbo3} campaignId={data?.campaign_3_id} />
          )}
          {activeSection === 'candidates' && (
            <CandidatesSection candidates={candidates} />
          )}
          {activeSection === 'history' && (
            <HistorySection dups={dups} />
          )}
          {activeSection === 'criteria' && (
            <CriteriaSection />
          )}
        </motion.div>
      </AnimatePresence>

      {allClones === 0 && candidates.length === 0 && (
        <div style={{
          marginTop: 20,
          padding: '20px 24px',
          textAlign: 'center',
          background: 'rgba(239, 68, 68, 0.05)',
          border: '1px dashed rgba(239, 68, 68, 0.2)',
          borderRadius: 12,
          color: 'var(--bos-text-muted)',
          fontSize: '0.8rem'
        }}>
          Ares está esperando ganadores. Criterios endurecidos: ROAS ≥ 3x sostenido 14d, $500+ spend, 30+ compras, 21+ días, 40+ learning conv o SUCCESS.
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// OVERVIEW — 3 CBO cards + candidates preview
// ═══════════════════════════════════════════════════════════════════════════

function OverviewSection({ cbo1, cbo2, cbo3, candidates, recentDups, hasCBO3 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 3 CBO summary cards side-by-side */}
      <div style={{ display: 'grid', gridTemplateColumns: hasCBO3 ? 'repeat(3, 1fr)' : 'repeat(2, 1fr)', gap: 10 }}>
        <CBOSummaryCard label="CBO 1" sublabel="Probados" color="#ef4444" stats={cbo1} />
        <CBOSummaryCard label="CBO 2" sublabel="Nuevos" color="#f59e0b" stats={cbo2} />
        {hasCBO3 && <CBOSummaryCard label="CBO 3" sublabel="Rescate" color="#8b5cf6" stats={cbo3} />}
      </div>

      {/* Candidates ready to duplicate */}
      {candidates.length > 0 && (
        <div style={{
          background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.08), rgba(16, 185, 129, 0.02))',
          border: '1px solid rgba(16, 185, 129, 0.3)',
          borderLeft: '3px solid #10b981',
          borderRadius: 10,
          padding: '14px 16px'
        }}>
          <SectionHeader label={`🎯 Candidatos listos · ${candidates.length}`} color="#10b981" />
          {candidates.slice(0, 5).map((c, i) => (
            <CandidateRow key={i} c={c} index={i} />
          ))}
          {candidates.length > 5 && (
            <div style={{ fontSize: '0.66rem', color: 'var(--bos-text-muted)', textAlign: 'center', marginTop: 8, fontStyle: 'italic' }}>
              +{candidates.length - 5} más · ver tab Candidatos
            </div>
          )}
        </div>
      )}

      {/* Recent duplications */}
      {recentDups.length > 0 && (
        <div>
          <SectionHeader label="Duplicaciones recientes" count={recentDups.length} color="#8b5cf6" />
          {recentDups.map((d, i) => (
            <DuplicationRow key={i} dup={d} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}

function CBOSummaryCard({ label, sublabel, color, stats }) {
  const clones = stats.active_clones || 0;
  const dominantAdset = (stats.adsets || []).slice().sort((a, b) => b.roas_7d - a.roas_7d)[0];
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      style={{
        background: `linear-gradient(135deg, ${color}12, ${color}04)`,
        border: `1px solid ${color}30`,
        borderTop: `3px solid ${color}`,
        borderRadius: 12,
        padding: '14px 16px'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: '0.95rem', fontWeight: 700, color, letterSpacing: '0.05em' }}>{label}</div>
          <div style={{ fontSize: '0.6rem', color: 'var(--bos-text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{sublabel}</div>
        </div>
        <div style={{
          fontSize: '1.6rem',
          fontWeight: 800,
          color: roasColor(stats.roas || 0),
          fontFamily: 'JetBrains Mono, monospace',
          lineHeight: 1
        }}>
          {stats.roas || 0}x
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginBottom: 10 }}>
        {[
          { l: 'Revenue', v: '$' + (stats.revenue_7d || 0).toLocaleString() },
          { l: 'Spend', v: '$' + (stats.spend_7d || 0).toLocaleString() },
          { l: 'Compras', v: stats.purchases_7d || 0 },
          { l: 'CPA', v: stats.cpa ? '$' + stats.cpa : '—' }
        ].map((s, i) => (
          <div key={i} style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--bos-text)', fontFamily: 'JetBrains Mono, monospace' }}>{s.v}</div>
            <div style={{ fontSize: '0.52rem', color: 'var(--bos-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{s.l}</div>
          </div>
        ))}
      </div>
      <div style={{
        paddingTop: 8,
        borderTop: `1px solid ${color}20`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontSize: '0.66rem',
        color: 'var(--bos-text-muted)'
      }}>
        <span>{clones} clon{clones !== 1 ? 'es' : ''} activo{clones !== 1 ? 's' : ''}</span>
        {dominantAdset && (
          <span style={{ color: roasColor(dominantAdset.roas_7d), fontFamily: 'JetBrains Mono, monospace' }}>
            top · {dominantAdset.roas_7d}x
          </span>
        )}
      </div>
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CBO DETAIL — all adsets in a campaign with full breakdown
// ═══════════════════════════════════════════════════════════════════════════

function CBODetailSection({ label, color, stats, campaignId }) {
  const [sortBy, setSortBy] = useState('roas');
  const adsets = useMemo(() => {
    const list = [...(stats.adsets || [])];
    if (sortBy === 'roas') list.sort((a, b) => b.roas_7d - a.roas_7d);
    else if (sortBy === 'spend') list.sort((a, b) => b.spend_7d - a.spend_7d);
    else if (sortBy === 'purchases') list.sort((a, b) => b.purchases_7d - a.purchases_7d);
    else if (sortBy === 'freq') list.sort((a, b) => b.frequency - a.frequency);
    return list;
  }, [stats, sortBy]);

  if (!campaignId) {
    return <Empty>Esta campaña CBO no está configurada en SystemConfig.</Empty>;
  }
  if (adsets.length === 0) {
    return <Empty>Sin clones activos en {label}</Empty>;
  }

  return (
    <div>
      {/* Header with stats */}
      <div style={{
        background: `linear-gradient(135deg, ${color}10, ${color}03)`,
        border: `1px solid ${color}30`,
        borderRadius: 12,
        padding: '14px 18px',
        marginBottom: 12
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color, letterSpacing: '0.04em' }}>{label}</div>
            <div style={{ fontSize: '0.62rem', color: 'var(--bos-text-muted)', fontFamily: 'JetBrains Mono, monospace', marginTop: 3 }}>
              ID {campaignId}
            </div>
          </div>
          <div style={{
            fontSize: '1.8rem',
            fontWeight: 800,
            color: roasColor(stats.roas || 0),
            fontFamily: 'JetBrains Mono, monospace'
          }}>
            {stats.roas || 0}x
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
          {[
            { l: 'Clones', v: stats.active_clones || 0 },
            { l: 'Revenue 7d', v: '$' + (stats.revenue_7d || 0).toLocaleString() },
            { l: 'Spend 7d', v: '$' + (stats.spend_7d || 0).toLocaleString() },
            { l: 'Compras 7d', v: stats.purchases_7d || 0 },
            { l: 'CPA', v: stats.cpa ? '$' + stats.cpa : '—' }
          ].map((s, i) => (
            <div key={i} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--bos-text)', fontFamily: 'JetBrains Mono, monospace' }}>{s.v}</div>
              <div style={{ fontSize: '0.55rem', color: 'var(--bos-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 2 }}>{s.l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Sort controls */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center' }}>
        <span style={{ fontSize: '0.6rem', color: 'var(--bos-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Ordenar:</span>
        {[
          { k: 'roas', l: 'ROAS' },
          { k: 'spend', l: 'Spend' },
          { k: 'purchases', l: 'Compras' },
          { k: 'freq', l: 'Freq' }
        ].map(s => (
          <button
            key={s.k}
            onClick={() => setSortBy(s.k)}
            style={{
              padding: '3px 10px',
              fontSize: '0.62rem',
              borderRadius: 4,
              border: sortBy === s.k ? `1px solid ${color}` : '1px solid rgba(255, 255, 255, 0.08)',
              background: sortBy === s.k ? `${color}15` : 'transparent',
              color: sortBy === s.k ? color : 'var(--bos-text-muted)',
              cursor: 'pointer',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              fontWeight: sortBy === s.k ? 700 : 500
            }}
          >
            {s.l}
          </button>
        ))}
      </div>

      {/* Adset table */}
      <div style={{ background: 'rgba(17, 21, 51, 0.4)', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 80px 70px 70px 70px 70px',
          gap: 10,
          padding: '8px 14px',
          background: 'rgba(10, 14, 39, 0.5)',
          fontSize: '0.55rem',
          color: 'var(--bos-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          fontWeight: 700
        }}>
          <div>Ad set</div>
          <div style={{ textAlign: 'right' }}>Budget</div>
          <div style={{ textAlign: 'right' }}>Spend 7d</div>
          <div style={{ textAlign: 'right' }}>Compras</div>
          <div style={{ textAlign: 'right' }}>Freq</div>
          <div style={{ textAlign: 'right' }}>ROAS</div>
        </div>
        {adsets.map((a, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: Math.min(i * 0.02, 0.4) }}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 80px 70px 70px 70px 70px',
              gap: 10,
              padding: '8px 14px',
              borderTop: '1px solid rgba(255, 255, 255, 0.04)',
              fontSize: '0.72rem'
            }}
          >
            <div style={{ color: 'var(--bos-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.adset_name}</div>
            <div style={{ textAlign: 'right', color: 'var(--bos-text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>${a.daily_budget || '—'}</div>
            <div style={{ textAlign: 'right', color: 'var(--bos-text)', fontFamily: 'JetBrains Mono, monospace' }}>${a.spend_7d}</div>
            <div style={{ textAlign: 'right', color: a.purchases_7d > 0 ? '#10b981' : 'var(--bos-text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>{a.purchases_7d}</div>
            <div style={{ textAlign: 'right', color: a.frequency >= 2.5 ? '#f59e0b' : 'var(--bos-text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>{a.frequency}</div>
            <div style={{ textAlign: 'right', color: roasColor(a.roas_7d), fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>{a.roas_7d}x</div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CANDIDATES — ad sets ready for duplication
// ═══════════════════════════════════════════════════════════════════════════

function CandidatesSection({ candidates }) {
  if (candidates.length === 0) {
    return <Empty>Sin candidatos — ningún ad set cumple los criterios endurecidos aún</Empty>;
  }
  return (
    <div>
      <SectionHeader label="Ad sets cumplen criterios de Ares" count={candidates.length} color="#10b981" />
      {candidates.map((c, i) => <CandidateRow key={i} c={c} index={i} />)}
    </div>
  );
}

function CandidateRow({ c, index }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.4) }}
      style={{
        background: 'rgba(17, 21, 51, 0.5)',
        borderLeft: '3px solid #10b981',
        borderRadius: 6,
        padding: '10px 14px',
        marginBottom: 5,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 10
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.78rem', color: 'var(--bos-text)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {c.entity_name}
        </div>
        <div style={{ fontSize: '0.62rem', color: 'var(--bos-text-muted)', marginTop: 3, fontFamily: 'JetBrains Mono, monospace' }}>
          ${c.spend_7d} · {c.purchases_7d}c · freq {c.frequency}
        </div>
      </div>
      <div style={{
        fontSize: '1.15rem',
        fontWeight: 700,
        color: '#10b981',
        fontFamily: 'JetBrains Mono, monospace',
        filter: 'drop-shadow(0 0 8px rgba(16, 185, 129, 0.3))'
      }}>
        {c.roas_7d}x
      </div>
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// HISTORY — past duplications with context
// ═══════════════════════════════════════════════════════════════════════════

function HistorySection({ dups }) {
  if (dups.length === 0) return <Empty>Sin historial de duplicaciones</Empty>;
  return (
    <div>
      <SectionHeader label="Duplicaciones ejecutadas" count={dups.length} color="#8b5cf6" />
      {dups.map((d, i) => <DuplicationRow key={i} dup={d} index={i} />)}
    </div>
  );
}

function DuplicationRow({ dup, index }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.4) }}
      style={{
        background: 'rgba(17, 21, 51, 0.5)',
        borderLeft: '3px solid #8b5cf6',
        borderRadius: 6,
        padding: '10px 14px',
        marginBottom: 5
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.74rem', color: 'var(--bos-text)', fontWeight: 500 }}>
            <span style={{ color: 'var(--bos-text-muted)' }}>{dup.original_name}</span>
            <span style={{ margin: '0 6px', color: '#8b5cf6' }}>→</span>
            <span>{dup.clone_name}</span>
          </div>
          {dup.reasoning && (
            <div style={{ fontSize: '0.62rem', color: 'var(--bos-text-muted)', marginTop: 3, fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {dup.reasoning}
            </div>
          )}
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: '0.9rem', fontWeight: 700, color: roasColor(dup.roas_at_dup || 0), fontFamily: 'JetBrains Mono, monospace' }}>
            {(dup.roas_at_dup || 0).toFixed(1)}x
          </div>
          <div style={{ fontSize: '0.58rem', color: 'var(--bos-text-dim)', fontFamily: 'JetBrains Mono, monospace', marginTop: 2 }}>
            {formatDate(dup.executed_at)}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CRITERIA — hardened graduation rules doc
// ═══════════════════════════════════════════════════════════════════════════

function CriteriaSection() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ background: 'rgba(239, 68, 68, 0.06)', border: '1px solid rgba(239, 68, 68, 0.25)', borderRadius: 10, padding: '14px 18px' }}>
        <SectionHeader label="⚔️ Criterios de duplicación (endurecidos abril 2026)" color={ARES_COLOR} />
        <ul style={{ paddingLeft: 20, fontSize: '0.76rem', color: 'var(--bos-text-muted)', lineHeight: 1.8, margin: 0 }}>
          <li><strong style={{ color: '#10b981' }}>ROAS ≥ 3.0x</strong> sostenido 14 días (fallback 7d)</li>
          <li><strong style={{ color: '#10b981' }}>Spend ≥ $500</strong> en el período de medición</li>
          <li><strong style={{ color: '#10b981' }}>≥ 30 compras</strong> totales</li>
          <li><strong style={{ color: '#10b981' }}>Frequency &lt; 2.0</strong> (hay room para escalar)</li>
          <li><strong style={{ color: '#10b981' }}>Learning SUCCESS</strong> o <strong>≥ 40 learning conversions</strong></li>
          <li>Fast-track <strong style={{ color: '#ef4444' }}>disabled</strong> (100% fail rate histórico)</li>
        </ul>
      </div>

      <div style={{ background: 'rgba(107, 114, 128, 0.06)', border: '1px solid rgba(107, 114, 128, 0.25)', borderRadius: 10, padding: '14px 18px' }}>
        <SectionHeader label="🚫 Exclusiones automáticas" color="#6b7280" />
        <ul style={{ paddingLeft: 20, fontSize: '0.74rem', color: 'var(--bos-text-muted)', lineHeight: 1.8, margin: 0 }}>
          <li>Nombres con <code style={{ color: '#fbbf24', fontFamily: 'JetBrains Mono, monospace' }}>[TEST]</code>, <code style={{ color: '#fbbf24', fontFamily: 'JetBrains Mono, monospace' }}>AI -</code>, <code style={{ color: '#fbbf24', fontFamily: 'JetBrains Mono, monospace' }}>[ARES]</code></li>
          <li>Ad sets con <code style={{ color: '#fbbf24', fontFamily: 'JetBrains Mono, monospace' }}>DONT TOUCH</code>, <code style={{ color: '#fbbf24', fontFamily: 'JetBrains Mono, monospace' }}>EXCLUDE</code>, <code style={{ color: '#fbbf24', fontFamily: 'JetBrains Mono, monospace' }}>MANUAL ONLY</code></li>
          <li>Amazon / otras plataformas (<code style={{ color: '#fbbf24', fontFamily: 'JetBrains Mono, monospace' }}>AMAZON</code>)</li>
          <li>Ya duplicados (se mira ActionLog)</li>
        </ul>
      </div>

      <div style={{ background: 'rgba(139, 92, 246, 0.06)', border: '1px solid rgba(139, 92, 246, 0.25)', borderRadius: 10, padding: '14px 18px' }}>
        <SectionHeader label="3 campañas CBO" color="#8b5cf6" />
        <ul style={{ paddingLeft: 20, fontSize: '0.74rem', color: 'var(--bos-text-muted)', lineHeight: 1.8, margin: 0 }}>
          <li><strong style={{ color: '#ef4444' }}>CBO 1 · Probados</strong>: winners con track record estable</li>
          <li><strong style={{ color: '#f59e0b' }}>CBO 2 · Nuevos</strong>: clones recientes aún probándose</li>
          <li><strong style={{ color: '#8b5cf6' }}>CBO 3 · Rescate / Medición</strong>: clones starved por CBO auction loser (experimento abril 2026 con $200/d)</li>
        </ul>
      </div>

      <div style={{ background: 'rgba(16, 185, 129, 0.06)', border: '1px solid rgba(16, 185, 129, 0.25)', borderRadius: 10, padding: '14px 18px' }}>
        <SectionHeader label="Budget por clon" color="#10b981" />
        <div style={{ fontSize: '0.76rem', color: 'var(--bos-text-muted)', lineHeight: 1.7 }}>
          Budget inicial: <strong style={{ color: '#10b981' }}>$30/día</strong>. El CBO optimiza la distribución entre clones según performance. Ares no ajusta budget directamente — Athena/Zeus lo hacen vía directivas.
        </div>
      </div>
    </div>
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

// ═══════════════════════════════════════════════════════════════════════════
// CBOHealthSection — vista de salud por CBO con semáforo + sparkline
// ═══════════════════════════════════════════════════════════════════════════

function CBOHealthSection({ health }) {
  if (!health) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--bos-text-dim)' }}>
        Cargando salud de CBOs...
      </div>
    );
  }

  const snapshots = health.snapshots || [];
  const byCampaign = health.history_by_campaign || {};
  const summary = health.summary || {};

  if (snapshots.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--bos-text-dim)', fontStyle: 'italic' }}>
        Sin snapshots aún. El monitor corre cada 2h — esperá al próximo ciclo o dispará manual con <code>POST /api/ares/cbo-health/run</code>.
      </div>
    );
  }

  return (
    <div>
      {/* Resumen top */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 8,
        marginBottom: 14
      }}>
        <HealthSummaryCard label="CBOs activas" value={summary.total} color="#60a5fa" />
        <HealthSummaryCard label="Zombies" value={summary.zombies} color="#a78bfa" warn={summary.zombies > 0} />
        <HealthSummaryCard label="Colapsando" value={summary.collapse} color="#ef4444" warn={summary.collapse > 0} />
        <HealthSummaryCard label="Saturando" value={summary.saturating} color="#fbbf24" warn={summary.saturating > 0} />
      </div>

      {/* Cards por CBO */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {snapshots.map(s => (
          <CBOHealthCard key={s._id} snap={s} history={byCampaign[s.campaign_id] || []} />
        ))}
      </div>
    </div>
  );
}

function HealthSummaryCard({ label, value, color, warn }) {
  return (
    <div style={{
      background: warn ? `${color}15` : 'rgba(17, 21, 51, 0.4)',
      border: `1px solid ${warn ? color + '40' : 'rgba(255,255,255,0.05)'}`,
      borderRadius: 8,
      padding: '10px 12px',
      textAlign: 'center'
    }}>
      <div style={{ fontSize: '1.3rem', fontWeight: 700, color, fontFamily: 'JetBrains Mono, monospace', lineHeight: 1 }}>
        {value ?? 0}
      </div>
      <div style={{ fontSize: '0.56rem', color: 'var(--bos-text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: 4 }}>
        {label}
      </div>
    </div>
  );
}

function healthSemaphore(snap) {
  if (snap.is_zombie) return { bg: 'rgba(167, 139, 250, 0.1)', border: '#a78bfa', label: 'ZOMBIE', icon: '🧟' };
  if (snap.collapse_detected) return { bg: 'rgba(239, 68, 68, 0.12)', border: '#ef4444', label: 'COLAPSANDO', icon: '🔴' };
  if (snap.concentration_sustained_3d && snap.favorite_declining && snap.favorite_freq > 2) {
    return { bg: 'rgba(251, 191, 36, 0.1)', border: '#fbbf24', label: 'SATURANDO', icon: '⚠' };
  }
  if (snap.budget_pulse < 15 && snap.active_adsets_count >= 6) {
    return { bg: 'rgba(249, 115, 22, 0.1)', border: '#f97316', label: 'STARVATION', icon: '💸' };
  }
  if (snap.cbo_roas_3d >= 3) return { bg: 'rgba(16, 185, 129, 0.08)', border: '#10b981', label: 'HEALTHY', icon: '✓' };
  return { bg: 'rgba(96, 165, 250, 0.06)', border: '#60a5fa', label: 'OK', icon: '·' };
}

function CBOHealthCard({ snap, history }) {
  const [expanded, setExpanded] = useState(false);
  const sem = healthSemaphore(snap);

  return (
    <div style={{
      background: sem.bg,
      border: `1px solid ${sem.border}40`,
      borderLeft: `3px solid ${sem.border}`,
      borderRadius: 10,
      padding: 14,
      transition: 'all 0.2s'
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: '0.55rem',
          padding: '2px 8px',
          borderRadius: 4,
          background: `${sem.border}22`,
          color: sem.border,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          whiteSpace: 'nowrap'
        }}>
          {sem.icon} {sem.label}
        </span>
        <div style={{ flex: 1, minWidth: 0, fontSize: '0.82rem', color: 'var(--bos-text)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {snap.campaign_name}
        </div>
        <div style={{ fontSize: '0.65rem', color: 'var(--bos-text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
          ${snap.daily_budget}/d
        </div>
      </div>

      {snap.is_zombie ? (
        <div style={{ fontSize: '0.7rem', color: 'var(--bos-text-muted)', fontStyle: 'italic' }}>
          0 adsets activos. Budget asignado pero no genera spend. Considerar apagar campaña para liberar budget pool.
        </div>
      ) : (
        <>
          {/* Métricas clave en una fila */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: '0.68rem', fontFamily: 'JetBrains Mono, monospace', color: 'var(--bos-text)', marginBottom: 8 }}>
            <span style={{ color: roasColor(snap.cbo_roas_3d), fontWeight: 700 }}>
              {snap.cbo_roas_3d.toFixed(2)}x ROAS 3d
            </span>
            <span style={{ color: 'var(--bos-text-muted)' }}>·</span>
            <span>{snap.active_adsets_count} adsets</span>
            <span style={{ color: 'var(--bos-text-muted)' }}>·</span>
            <span style={{ color: snap.budget_pulse < 15 && snap.active_adsets_count >= 6 ? '#f97316' : 'inherit' }}>
              ${snap.budget_pulse.toFixed(0)}/adset pulse
            </span>
            <span style={{ color: 'var(--bos-text-muted)' }}>·</span>
            <span>conc {Math.round(snap.concentration_index_3d * 100)}% 3d</span>
            {snap.starved_count > 0 && (
              <>
                <span style={{ color: 'var(--bos-text-muted)' }}>·</span>
                <span style={{ color: '#f97316', fontWeight: 600 }}>{snap.starved_count} starved</span>
              </>
            )}
          </div>

          {/* Favorito */}
          {snap.favorite_adset_name && (
            <div style={{ fontSize: '0.66rem', color: 'var(--bos-text-muted)', marginBottom: 8 }}>
              <span style={{ color: '#fbbf24' }}>👑 {snap.favorite_adset_name}</span>
              <span style={{ color: 'var(--bos-text-dim)' }}> · {snap.favorite_tenure_days}d tenure · </span>
              <span style={{ color: snap.favorite_declining ? '#ef4444' : '#10b981' }}>
                {snap.favorite_roas_3d.toFixed(2)}x {snap.favorite_declining ? '↓' : '→'}
              </span>
              <span style={{ color: 'var(--bos-text-dim)' }}> · freq {snap.favorite_freq.toFixed(2)}</span>
            </div>
          )}

          {/* Sparkline */}
          {history.length >= 3 && (
            <div style={{ height: 30, marginBottom: 4 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={history} margin={{ top: 2, bottom: 2, left: 0, right: 0 }}>
                  <YAxis hide domain={[0, 'auto']} />
                  <Line
                    type="monotone"
                    dataKey="roas_3d"
                    stroke={sem.border}
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Expand */}
          <div
            onClick={() => setExpanded(!expanded)}
            style={{
              fontSize: '0.6rem',
              color: 'var(--bos-text-dim)',
              cursor: 'pointer',
              textAlign: 'center',
              paddingTop: 4,
              borderTop: '1px dashed rgba(255,255,255,0.05)'
            }}
          >
            {expanded ? '▲ ocultar detalle' : '▼ ver starved + detalles'}
          </div>

          {expanded && (
            <div style={{ marginTop: 8, fontSize: '0.64rem', color: 'var(--bos-text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
              <div style={{ marginBottom: 4 }}>spend: 1d ${snap.cbo_spend_1d.toFixed(0)} · 3d ${snap.cbo_spend_3d.toFixed(0)} · 7d ${snap.cbo_spend_7d.toFixed(0)}</div>
              <div style={{ marginBottom: 4 }}>revenue: 1d ${snap.cbo_revenue_1d.toFixed(0)} · 3d ${snap.cbo_revenue_3d.toFixed(0)} · 7d ${snap.cbo_revenue_7d.toFixed(0)}</div>
              <div style={{ marginBottom: 4 }}>roas: 1d {snap.cbo_roas_1d.toFixed(2)}x · 3d {snap.cbo_roas_3d.toFixed(2)}x · 7d {snap.cbo_roas_7d.toFixed(2)}x</div>
              {(snap.starved_adsets || []).filter(s => s.is_true_starved).length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ color: '#f97316', fontWeight: 700, textTransform: 'uppercase', fontSize: '0.56rem', letterSpacing: '0.1em', marginBottom: 4 }}>Starved adsets ({snap.starved_count})</div>
                  {snap.starved_adsets.filter(s => s.is_true_starved).map(s => (
                    <div key={s.adset_id} style={{ paddingLeft: 8, marginBottom: 2 }}>
                      · {s.adset_name} · edad {s.entity_age_days}d · {Math.round(s.spend_share_3d * 100)}% vs {Math.round(s.proportional_expected * 100)}% esperado
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
