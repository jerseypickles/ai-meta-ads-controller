import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  getTestRuns,
  getTestingStats,
  killTestRun,
  runTestingAgentApi,
  getTestImageUrl
} from '../../api';

const PROM_COLOR = '#fb923c';

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

export default function PrometheusPanel() {
  const [tests, setTests] = useState([]);
  const [stats, setStats] = useState({});
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [activeSection, setActiveSection] = useState('overview');
  const [lightbox, setLightbox] = useState(null);
  const [detailTest, setDetailTest] = useState(null);

  useEffect(() => {
    loadAll();
    const i = setInterval(loadAll, 60000);
    return () => clearInterval(i);
  }, []);

  async function loadAll() {
    try {
      const [testsR, statsR] = await Promise.all([
        getTestRuns().catch(() => ({ tests: [] })),
        getTestingStats().catch(() => ({}))
      ]);
      setTests(testsR.tests || []);
      setStats({ ...(testsR.stats || {}), ...(statsR || {}) });
    } catch (err) {
      console.error('Prometheus load error:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleRun() {
    setRunning(true);
    try { await runTestingAgentApi(); await loadAll(); }
    catch (err) { console.error(err); }
    finally { setRunning(false); }
  }

  async function handleKill(id) {
    if (!window.confirm('Matar este test?')) return;
    try { await killTestRun(id); await loadAll(); }
    catch (err) { alert('Error: ' + err.message); }
  }

  const activeTests = useMemo(() => tests.filter(t => ['learning', 'evaluating'].includes(t.phase)), [tests]);
  const graduatedTests = useMemo(() => tests.filter(t => t.phase === 'graduated'), [tests]);
  const killedTests = useMemo(() => tests.filter(t => t.phase === 'killed'), [tests]);
  const expiredTests = useMemo(() => tests.filter(t => t.phase === 'expired'), [tests]);

  if (loading && tests.length === 0) {
    return <div className="bos-loading">Sintetizando inteligencia de Prometheus...</div>;
  }

  return (
    <div>
      {/* HERO */}
      <div style={{
        background: 'radial-gradient(ellipse at top left, rgba(251, 146, 60, 0.12) 0%, transparent 50%), radial-gradient(ellipse at bottom right, rgba(239, 68, 68, 0.08) 0%, transparent 50%)',
        borderRadius: 16,
        padding: '20px 24px',
        marginBottom: 20,
        border: '1px solid rgba(251, 146, 60, 0.2)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <motion.div
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring' }}
            style={{
              width: 64, height: 64, borderRadius: '50%',
              background: `${PROM_COLOR}15`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `2px solid ${PROM_COLOR}40`,
              filter: `drop-shadow(0 0 20px ${PROM_COLOR})`,
              fontSize: '2rem'
            }}
          >
            🔥
          </motion.div>
          <div style={{ flex: 1 }}>
            <div style={{
              fontSize: '1.7rem',
              fontWeight: 800,
              background: 'linear-gradient(135deg, #fb923c, #f97316, #ef4444)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              lineHeight: 1
            }}>
              PROMETHEUS
            </div>
            <div style={{
              fontSize: '0.7rem',
              color: 'var(--bos-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              marginTop: 4
            }}>
              Evaluador · procedural testing + graduación
            </div>
          </div>
          <button
            onClick={handleRun}
            disabled={running}
            style={{
              padding: '8px 20px',
              background: `linear-gradient(90deg, ${PROM_COLOR}, #ef4444)`,
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
            {running ? 'Ejecutando...' : '⚡ Run Testing'}
          </button>
        </div>
      </div>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, marginBottom: 16 }}>
        {[
          { v: activeTests.length, l: 'Activos', c: PROM_COLOR },
          { v: graduatedTests.length, l: 'Graduados', c: '#10b981' },
          { v: killedTests.length, l: 'Killed', c: '#ef4444' },
          { v: expiredTests.length, l: 'Expirados', c: '#6b7280' },
          { v: (stats.graduation_rate || 0) + '%', l: 'Win rate', c: stats.graduation_rate >= 30 ? '#10b981' : stats.graduation_rate >= 15 ? '#fbbf24' : '#ef4444' },
          { v: '$' + (stats.daily_budget_exposure || 0), l: 'Spend/día', c: '#8b5cf6' }
        ].map((s, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
            style={{
              background: 'rgba(10, 14, 39, 0.6)',
              border: '1px solid rgba(251, 146, 60, 0.1)',
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
          { k: 'overview', l: 'Resumen', c: PROM_COLOR },
          { k: 'active', l: 'En testing', c: '#3b82f6', n: activeTests.length },
          { k: 'graduated', l: 'Graduados', c: '#10b981', n: graduatedTests.length },
          { k: 'killed', l: 'Killed', c: '#ef4444', n: killedTests.length },
          { k: 'analytics', l: 'Analytics', c: '#8b5cf6' },
          { k: 'criteria', l: 'Criterios', c: '#fbbf24' }
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
              stats={stats}
              activeTests={activeTests}
              graduatedTests={graduatedTests}
              killedTests={killedTests}
              onKill={handleKill}
              setLightbox={setLightbox}
              setDetail={setDetailTest}
            />
          )}
          {activeSection === 'active' && (
            <TestGrid
              tests={activeTests}
              mode="active"
              onKill={handleKill}
              setLightbox={setLightbox}
              setDetail={setDetailTest}
            />
          )}
          {activeSection === 'graduated' && (
            <TestGrid
              tests={graduatedTests}
              mode="graduated"
              setLightbox={setLightbox}
              setDetail={setDetailTest}
            />
          )}
          {activeSection === 'killed' && (
            <TestGrid
              tests={[...killedTests, ...expiredTests].sort((a, b) => new Date(b.killed_at || b.expired_at || b.launched_at) - new Date(a.killed_at || a.expired_at || a.launched_at))}
              mode="killed"
              setLightbox={setLightbox}
              setDetail={setDetailTest}
            />
          )}
          {activeSection === 'analytics' && (
            <AnalyticsSection tests={tests} />
          )}
          {activeSection === 'criteria' && (
            <CriteriaSection />
          )}
        </motion.div>
      </AnimatePresence>

      {/* Lightbox */}
      <AnimatePresence>
        {lightbox && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setLightbox(null)}
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
            <img src={lightbox} alt="" style={{ maxWidth: '90%', maxHeight: '90%', borderRadius: 12 }} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Detail modal */}
      <AnimatePresence>
        {detailTest && (
          <TestDetailModal test={detailTest} onClose={() => setDetailTest(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// OVERVIEW
// ═══════════════════════════════════════════════════════════════════════════

function OverviewSection({ stats, activeTests, graduatedTests, killedTests, onKill, setLightbox, setDetail }) {
  const recentActive = activeTests.slice(0, 4);
  const recentGraduated = graduatedTests.slice(0, 3);
  const winRate = stats.graduation_rate || 0;
  const winColor = winRate >= 30 ? '#10b981' : winRate >= 15 ? '#fbbf24' : '#ef4444';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Funnel */}
      <div style={{
        background: 'rgba(17, 21, 51, 0.4)',
        borderRadius: 10,
        padding: '14px 16px'
      }}>
        <SectionHeader label="Funnel de testing" color={PROM_COLOR} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <FunnelStep label="Learning" count={activeTests.filter(t => t.phase === 'learning').length} color="#3b82f6" />
          <span style={{ color: 'var(--bos-text-dim)' }}>→</span>
          <FunnelStep label="Evaluando" count={activeTests.filter(t => t.phase === 'evaluating').length} color="#f59e0b" />
          <span style={{ color: 'var(--bos-text-dim)' }}>→</span>
          <FunnelStep label="Graduados" count={graduatedTests.length} color="#10b981" />
          <span style={{ color: 'var(--bos-text-dim)' }}>·</span>
          <FunnelStep label="Killed" count={killedTests.length} color="#ef4444" />
          <div style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 14px',
            background: `${winColor}12`,
            borderRadius: 8,
            border: `1px solid ${winColor}40`
          }}>
            <span style={{ fontSize: '0.6rem', color: 'var(--bos-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Win rate</span>
            <span style={{ fontSize: '1.2rem', fontWeight: 700, color: winColor, fontFamily: 'JetBrains Mono, monospace' }}>{winRate}%</span>
          </div>
        </div>
      </div>

      {/* Recent active */}
      {recentActive.length > 0 && (
        <div>
          <SectionHeader label="Tests recientes activos" count={activeTests.length} color="#3b82f6" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
            {recentActive.map((t, i) => (
              <TestCard key={t._id} test={t} index={i} mode="active" onKill={onKill} setLightbox={setLightbox} setDetail={setDetail} />
            ))}
          </div>
        </div>
      )}

      {/* Recent graduated */}
      {recentGraduated.length > 0 && (
        <div>
          <SectionHeader label="Últimos graduados" count={graduatedTests.length} color="#10b981" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
            {recentGraduated.map((t, i) => (
              <TestCard key={t._id} test={t} index={i} mode="graduated" setLightbox={setLightbox} setDetail={setDetail} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FunnelStep({ label, count, color }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 12px',
      background: `${color}14`,
      borderRadius: 6,
      border: `1px solid ${color}30`
    }}>
      <span style={{ fontSize: '1rem', fontWeight: 700, color, fontFamily: 'JetBrains Mono, monospace' }}>{count}</span>
      <span style={{ fontSize: '0.62rem', color, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST GRID / CARD
// ═══════════════════════════════════════════════════════════════════════════

function TestGrid({ tests, mode, onKill, setLightbox, setDetail }) {
  if (tests.length === 0) {
    return <Empty>{mode === 'active' ? 'No hay tests activos' : mode === 'graduated' ? 'Sin graduados aún' : 'Sin tests terminados'}</Empty>;
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
      {tests.map((t, i) => (
        <TestCard key={t._id} test={t} index={i} mode={mode} onKill={onKill} setLightbox={setLightbox} setDetail={setDetail} />
      ))}
    </div>
  );
}

function TestCard({ test, index, mode, onKill, setLightbox, setDetail }) {
  const p = test.proposal || {};
  const m = test.metrics || {};
  const daysActive = Math.floor((Date.now() - new Date(test.launched_at).getTime()) / 86400000);

  const badgeConfig = {
    learning: { bg: '#3b82f6', text: `Learning · día ${daysActive}` },
    evaluating: { bg: '#f59e0b', text: `Evaluando · día ${daysActive}` },
    graduated: { bg: '#10b981', text: '✓ Graduado' },
    killed: { bg: '#ef4444', text: '✗ Killed' },
    expired: { bg: '#6b7280', text: '⏱ Expirado' }
  }[test.phase] || { bg: '#6b7280', text: test.phase };

  const roasColor = m.roas >= 3 ? '#10b981' : m.roas >= 1.5 ? '#f59e0b' : m.spend > 10 ? '#ef4444' : 'var(--bos-text-dim)';
  const lastAssessment = test.assessments?.[test.assessments.length - 1]?.assessment;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: Math.min(index * 0.03, 0.4) }}
      onClick={() => setDetail(test)}
      style={{
        background: 'rgba(17, 21, 51, 0.55)',
        border: '1px solid rgba(255, 255, 255, 0.06)',
        borderRadius: 10,
        overflow: 'hidden',
        cursor: 'pointer'
      }}
    >
      <div
        onClick={(e) => { e.stopPropagation(); setLightbox(getTestImageUrl(test._id)); }}
        style={{ position: 'relative', aspectRatio: '1', overflow: 'hidden' }}
      >
        <img
          src={getTestImageUrl(test._id)}
          alt={p.headline}
          loading="lazy"
          onError={(e) => {
            e.target.style.display = 'none';
            e.target.nextSibling?.style.setProperty('display', 'flex');
          }}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
        {/* Placeholder visible solo si <img> falla (imagen no recuperable) */}
        <div style={{
          display: 'none',
          position: 'absolute', inset: 0,
          flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: 16, gap: 8, textAlign: 'center',
          background: `linear-gradient(135deg, ${badgeConfig.bg}18 0%, rgba(15, 23, 42, 0.85) 100%)`,
          color: 'var(--bos-text-muted)'
        }}>
          <div style={{ fontSize: '1.6rem', opacity: 0.5 }}>🖼</div>
          <div style={{ fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--bos-text-dim)' }}>
            preview no disponible
          </div>
          {p.scene_short && (
            <div style={{ fontSize: '0.66rem', color: 'var(--bos-text)', lineHeight: 1.4, opacity: 0.7, fontStyle: 'italic' }}>
              "{p.scene_short.substring(0, 80)}{p.scene_short.length > 80 ? '...' : ''}"
            </div>
          )}
          {p.product_name && (
            <div style={{ fontSize: '0.6rem', color: badgeConfig.bg, fontWeight: 600 }}>
              {p.product_name}
            </div>
          )}
        </div>
        <div style={{
          position: 'absolute',
          top: 6, left: 6,
          background: badgeConfig.bg,
          color: 'white',
          padding: '2px 8px',
          borderRadius: 4,
          fontSize: '0.56rem',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          zIndex: 1
        }}>
          {badgeConfig.text}
        </div>
      </div>
      <div style={{ padding: 10 }}>
        <div style={{
          fontSize: '0.72rem',
          color: 'var(--bos-text)',
          fontWeight: 600,
          lineHeight: 1.3,
          marginBottom: 4,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden'
        }}>
          {p.headline || test.test_adset_name}
        </div>
        <div style={{ fontSize: '0.58rem', color: 'var(--bos-text-muted)', marginBottom: 6 }}>
          → {test.source_adset_name}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, marginBottom: 6 }}>
          {[
            { v: m.roas > 0 ? m.roas.toFixed(2) + 'x' : '—', l: 'ROAS', c: roasColor },
            { v: '$' + Math.round(m.spend || 0), l: 'Spend', c: 'var(--bos-text)' },
            { v: m.purchases || 0, l: 'Compras', c: m.purchases > 0 ? '#10b981' : 'var(--bos-text-dim)' },
            { v: m.ctr > 0 ? m.ctr.toFixed(1) + '%' : '—', l: 'CTR', c: 'var(--bos-text)' }
          ].map((x, i) => (
            <div key={i} style={{ textAlign: 'center', padding: '3px 1px', background: 'rgba(10, 14, 39, 0.4)', borderRadius: 4 }}>
              <div style={{ fontSize: '0.68rem', fontWeight: 700, color: x.c, fontFamily: 'JetBrains Mono, monospace' }}>{x.v}</div>
              <div style={{ fontSize: '0.5rem', color: 'var(--bos-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{x.l}</div>
            </div>
          ))}
        </div>

        {/* Comparativo "graduado con X / hoy Y" — solo para mode=graduated */}
        {mode === 'graduated' && test.metrics_at_graduation && test.metrics_at_graduation.snapshot_at && (() => {
          const grad = test.metrics_at_graduation;
          const gradRoas = grad.roas || 0;
          const gradSpend = grad.spend || 0;
          const gradPurch = grad.purchases || 0;
          const currRoas = m.roas || 0;
          const currSpend = m.spend || 0;
          const currPurch = m.purchases || 0;
          // Delta porcentual ROAS
          const roasDelta = gradRoas > 0 ? ((currRoas - gradRoas) / gradRoas) * 100 : null;
          // Spend post-grad = spend actual - spend al graduar (cuánto facturó después de promover)
          const postGradSpend = Math.max(0, currSpend - gradSpend);
          const postGradPurch = Math.max(0, currPurch - gradPurch);
          // Color del delta
          const deltaColor = roasDelta == null ? 'var(--bos-text-dim)'
            : roasDelta >= 5 ? '#10b981'
            : roasDelta >= -5 ? '#f59e0b'
            : '#ef4444';
          return (
            <div style={{
              padding: '5px 7px',
              background: 'rgba(16, 185, 129, 0.06)',
              border: '1px solid rgba(16, 185, 129, 0.15)',
              borderRadius: 4,
              marginBottom: 6,
              fontSize: '0.6rem',
              fontFamily: 'JetBrains Mono, monospace',
              lineHeight: 1.5
            }}>
              <div style={{ color: 'var(--bos-text-muted)', fontSize: '0.55rem', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>
                post-graduación
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ color: 'var(--bos-text-muted)' }}>
                  graduó {gradRoas.toFixed(2)}x
                </span>
                <span style={{ color: 'var(--bos-text-dim)' }}>→</span>
                <span style={{ color: deltaColor, fontWeight: 700 }}>
                  hoy {currRoas.toFixed(2)}x
                </span>
                {roasDelta != null && (
                  <span style={{ color: deltaColor, fontSize: '0.58rem' }}>
                    {roasDelta >= 0 ? '+' : ''}{roasDelta.toFixed(0)}%
                  </span>
                )}
              </div>
              {(postGradSpend > 0 || postGradPurch > 0) && (
                <div style={{ color: 'var(--bos-text-dim)', fontSize: '0.56rem', marginTop: 2 }}>
                  desde grad: +${Math.round(postGradSpend)} spend, +{postGradPurch} compras
                </div>
              )}
            </div>
          );
        })()}
        {lastAssessment && (
          <div style={{
            fontSize: '0.62rem',
            color: 'var(--bos-text-muted)',
            fontStyle: 'italic',
            marginBottom: 6,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden'
          }}>
            💭 {lastAssessment}
          </div>
        )}
        {test.kill_reason && (
          <div style={{ fontSize: '0.6rem', color: '#ef4444', marginBottom: 6 }}>
            Kill: {test.kill_reason}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '0.55rem', color: 'var(--bos-text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
            {formatDate(test.launched_at)}
          </span>
          {mode === 'active' && onKill && (
            <button
              onClick={(e) => { e.stopPropagation(); onKill(test._id); }}
              style={{
                background: 'rgba(239, 68, 68, 0.12)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                color: '#ef4444',
                borderRadius: 4,
                padding: '2px 8px',
                fontSize: '0.56rem',
                fontWeight: 700,
                cursor: 'pointer',
                textTransform: 'uppercase'
              }}
            >
              Kill
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════

function AnalyticsSection({ tests }) {
  const breakdown = useMemo(() => computeBreakdown(tests), [tests]);
  const finished = tests.filter(t => ['graduated', 'killed', 'expired'].includes(t.phase));
  if (finished.length === 0) return <Empty>Aún no hay tests terminados para analizar</Empty>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        {[
          { l: 'Tests terminados', v: finished.length, c: 'var(--bos-text)' },
          { l: 'Avg spend/test', v: '$' + Math.round(finished.reduce((s, t) => s + (t.metrics?.spend || 0), 0) / finished.length), c: '#8b5cf6' },
          { l: 'Avg ROAS graduados', v: breakdown.avgGradROAS.toFixed(2) + 'x', c: '#10b981' },
          { l: 'Avg días a decisión', v: breakdown.avgDaysToDecision.toFixed(1) + 'd', c: '#3b82f6' }
        ].map((s, i) => (
          <div key={i} style={{ padding: '12px 14px', background: 'rgba(17, 21, 51, 0.4)', borderRadius: 10, textAlign: 'center' }}>
            <div style={{ fontSize: '1.3rem', fontWeight: 700, color: s.c, fontFamily: 'JetBrains Mono, monospace' }}>{s.v}</div>
            <div style={{ fontSize: '0.58rem', color: 'var(--bos-text-muted)', marginTop: 3, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{s.l}</div>
          </div>
        ))}
      </div>

      <BreakdownList title="Graduation rate por escena" color="#10b981" data={breakdown.scenes} />
      <BreakdownList title="Graduation rate por producto" color="#fbbf24" data={breakdown.products} />

      {breakdown.killReasons.length > 0 && (
        <div>
          <SectionHeader label="Razones de kill" count={breakdown.killReasons.length} color="#ef4444" />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {breakdown.killReasons.slice(0, 10).map((r, i) => (
              <span key={i} style={{
                fontSize: '0.72rem',
                padding: '5px 10px',
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.2)',
                color: '#ef4444',
                borderRadius: 6,
                fontFamily: 'JetBrains Mono, monospace'
              }}>
                {r.reason.substring(0, 40)}: {r.count}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BreakdownList({ title, color, data }) {
  if (!data || data.length === 0) return null;
  return (
    <div>
      <SectionHeader label={title} count={data.length} color={color} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 6 }}>
        {data.slice(0, 12).map((d, i) => {
          const rate = d.total > 0 ? Math.round((d.graduated / d.total) * 100) : 0;
          const rColor = rate >= 40 ? '#10b981' : rate >= 20 ? '#fbbf24' : '#ef4444';
          return (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.03 }}
              style={{
                background: 'rgba(17, 21, 51, 0.5)',
                borderLeft: `3px solid ${rColor}`,
                borderRadius: 6,
                padding: '8px 12px'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                <span style={{ fontSize: '0.72rem', color: 'var(--bos-text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 8 }}>
                  {d.key || '(sin datos)'}
                </span>
                <span style={{ fontSize: '0.8rem', fontWeight: 700, color: rColor, fontFamily: 'JetBrains Mono, monospace' }}>
                  {rate}%
                </span>
              </div>
              <div style={{ fontSize: '0.6rem', color: 'var(--bos-text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
                {d.graduated}W · {d.killed}K · {d.expired}E · ${Math.round(d.spend)} · {d.purchases}p
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function computeBreakdown(tests) {
  const finished = tests.filter(t => ['graduated', 'killed', 'expired'].includes(t.phase));
  const graduated = finished.filter(t => t.phase === 'graduated');
  const avgGradROAS = graduated.length > 0
    ? graduated.reduce((s, t) => s + (t.metrics?.roas || 0), 0) / graduated.length
    : 0;

  const daysToDecision = finished.map(t => {
    const end = new Date(t.graduated_at || t.killed_at || t.expired_at || Date.now());
    return (end - new Date(t.launched_at)) / 86400000;
  });
  const avgDaysToDecision = daysToDecision.length > 0
    ? daysToDecision.reduce((s, d) => s + d, 0) / daysToDecision.length
    : 0;

  const groupByKey = (keyFn) => {
    const map = {};
    for (const t of finished) {
      const k = keyFn(t);
      if (!k) continue;
      if (!map[k]) map[k] = { key: k, total: 0, graduated: 0, killed: 0, expired: 0, spend: 0, purchases: 0 };
      map[k].total += 1;
      if (t.phase === 'graduated') map[k].graduated += 1;
      if (t.phase === 'killed') map[k].killed += 1;
      if (t.phase === 'expired') map[k].expired += 1;
      map[k].spend += t.metrics?.spend || 0;
      map[k].purchases += t.metrics?.purchases || 0;
    }
    return Object.values(map).sort((a, b) => b.total - a.total);
  };

  const killReasons = {};
  for (const t of finished.filter(t => t.phase === 'killed' && t.kill_reason)) {
    const r = t.kill_reason.split('.')[0].substring(0, 60);
    killReasons[r] = (killReasons[r] || 0) + 1;
  }

  return {
    avgGradROAS,
    avgDaysToDecision,
    scenes: groupByKey(t => t.proposal?.scene_short),
    products: groupByKey(t => t.proposal?.product_name),
    killReasons: Object.entries(killReasons).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count)
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CRITERIA
// ═══════════════════════════════════════════════════════════════════════════

function CriteriaSection() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ background: 'rgba(16, 185, 129, 0.06)', border: '1px solid rgba(16, 185, 129, 0.25)', borderRadius: 10, padding: '14px 18px' }}>
        <SectionHeader label="✓ Graduación (winner)" color="#10b981" />
        <div style={{ fontSize: '0.78rem', color: 'var(--bos-text)', lineHeight: 1.7 }}>
          Un test gradúa cuando acumula señal positiva consistente:
        </div>
        <ul style={{ paddingLeft: 20, fontSize: '0.75rem', color: 'var(--bos-text-muted)', lineHeight: 1.8, margin: '6px 0 0' }}>
          <li><strong style={{ color: '#10b981' }}>≥3 días</strong> de vida del test</li>
          <li><strong style={{ color: '#10b981' }}>≥3 compras</strong> con ROAS ≥ 3x</li>
          <li>O <strong>ROAS ≥ 4x</strong> con ≥2 compras</li>
          <li>Fast-track legacy <strong style={{ color: '#ef4444' }}>disabled</strong> (100% fail rate histórico)</li>
        </ul>
      </div>

      <div style={{ background: 'rgba(239, 68, 68, 0.06)', border: '1px solid rgba(239, 68, 68, 0.25)', borderRadius: 10, padding: '14px 18px' }}>
        <SectionHeader label="✗ Kill (loser)" color="#ef4444" />
        <ul style={{ paddingLeft: 20, fontSize: '0.75rem', color: 'var(--bos-text-muted)', lineHeight: 1.8, margin: 0 }}>
          <li><strong style={{ color: '#ef4444' }}>$20+ spend</strong> sin ninguna compra</li>
          <li><strong style={{ color: '#ef4444' }}>CTR &lt; 0.5%</strong> persistente tras día 2</li>
          <li><strong style={{ color: '#ef4444' }}>ROAS &lt; 0.8x</strong> después de ≥5 días</li>
          <li>Kill manual desde dashboard</li>
        </ul>
      </div>

      <div style={{ background: 'rgba(107, 114, 128, 0.06)', border: '1px solid rgba(107, 114, 128, 0.25)', borderRadius: 10, padding: '14px 18px' }}>
        <SectionHeader label="⏱ Expira" color="#6b7280" />
        <div style={{ fontSize: '0.76rem', color: 'var(--bos-text-muted)', lineHeight: 1.7 }}>
          Llega a <strong>7 días</strong> sin cumplir criterios de graduación ni kill. Se considera "sin señal clara" — se retira de testing.
        </div>
      </div>

      <div style={{ background: 'rgba(139, 92, 246, 0.06)', border: '1px solid rgba(139, 92, 246, 0.25)', borderRadius: 10, padding: '14px 18px' }}>
        <SectionHeader label="Budget y ciclo" color="#8b5cf6" />
        <ul style={{ paddingLeft: 20, fontSize: '0.75rem', color: 'var(--bos-text-muted)', lineHeight: 1.8, margin: 0 }}>
          <li>Budget por test: <strong>$10/día</strong></li>
          <li>Corre cada ciclo de testing para chequear fases y actualizar métricas</li>
          <li>Al graduar, el creative se copia al ad set original (source_adset_id)</li>
        </ul>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DETAIL MODAL
// ═══════════════════════════════════════════════════════════════════════════

function TestDetailModal({ test, onClose }) {
  const p = test.proposal || {};
  const m = test.metrics || {};
  const assessments = test.assessments || [];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.88)',
        zIndex: 110,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 30
      }}
    >
      <motion.div
        initial={{ scale: 0.95, y: 10 }}
        animate={{ scale: 1, y: 0 }}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bos-bg-deep, #0a0e27)',
          border: '1px solid rgba(251, 146, 60, 0.3)',
          borderRadius: 14,
          padding: '24px 28px',
          width: 640,
          maxWidth: '92vw',
          maxHeight: '90vh',
          overflowY: 'auto'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: '0.6rem', color: '#fb923c', textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700, marginBottom: 4 }}>
              {test.phase}
            </div>
            <div style={{ fontSize: '1.05rem', color: 'var(--bos-text)', fontWeight: 600 }}>
              {p.headline || test.test_adset_name}
            </div>
            <div style={{ fontSize: '0.66rem', color: 'var(--bos-text-muted)', marginTop: 4 }}>
              → {test.source_adset_name}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--bos-text-muted)', fontSize: '1.5rem', cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ display: 'flex', gap: 14, marginBottom: 14 }}>
          <img
            src={getTestImageUrl(test._id)}
            alt=""
            style={{ width: 160, height: 160, objectFit: 'cover', borderRadius: 8, flexShrink: 0 }}
            onError={(e) => { e.target.style.display = 'none'; }}
          />
          <div style={{ flex: 1 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
              {[
                { l: 'ROAS', v: m.roas ? m.roas.toFixed(2) + 'x' : '—' },
                { l: 'Spend', v: '$' + Math.round(m.spend || 0) },
                { l: 'Compras', v: m.purchases || 0 },
                { l: 'CTR', v: m.ctr ? m.ctr.toFixed(2) + '%' : '—' },
                { l: 'CPA', v: m.cpa ? '$' + m.cpa.toFixed(0) : '—' },
                { l: 'Impressions', v: (m.impressions || 0).toLocaleString() }
              ].map((x, i) => (
                <div key={i} style={{ padding: '6px 10px', background: 'rgba(17, 21, 51, 0.4)', borderRadius: 6 }}>
                  <div style={{ fontSize: '0.55rem', color: 'var(--bos-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{x.l}</div>
                  <div style={{ fontSize: '0.88rem', color: 'var(--bos-text)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>{x.v}</div>
                </div>
              ))}
            </div>
            {p.product_name && (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 8 }}>
                <span style={{ fontSize: '0.6rem', padding: '2px 8px', background: 'rgba(251, 191, 36, 0.15)', color: '#fbbf24', borderRadius: 4 }}>{p.product_name}</span>
                {p.scene_short && <span style={{ fontSize: '0.6rem', padding: '2px 8px', background: 'rgba(16, 185, 129, 0.15)', color: '#10b981', borderRadius: 4 }}>{p.scene_short}</span>}
              </div>
            )}
          </div>
        </div>

        {p.primary_text && (
          <div style={{ fontSize: '0.75rem', color: 'var(--bos-text-muted)', marginBottom: 14, fontStyle: 'italic', padding: '8px 12px', background: 'rgba(10, 14, 39, 0.5)', borderRadius: 6 }}>
            {p.primary_text}
          </div>
        )}

        {assessments.length > 0 && (
          <div>
            <SectionHeader label="Timeline de evaluaciones" count={assessments.length} color="#fb923c" />
            {assessments.slice().reverse().map((a, i) => (
              <div key={i} style={{
                padding: '8px 12px',
                borderLeft: '3px solid #fb923c',
                background: 'rgba(17, 21, 51, 0.4)',
                borderRadius: 6,
                marginBottom: 5
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                  <span style={{ fontSize: '0.62rem', color: '#fb923c', textTransform: 'uppercase', fontWeight: 700 }}>
                    Día {a.day_number} · {a.phase}
                  </span>
                  <span style={{ fontSize: '0.56rem', color: 'var(--bos-text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
                    {a.date ? new Date(a.date).toLocaleDateString() : ''}
                  </span>
                </div>
                <div style={{ fontSize: '0.74rem', color: 'var(--bos-text)' }}>{a.assessment}</div>
              </div>
            ))}
          </div>
        )}

        {test.kill_reason && (
          <div style={{
            marginTop: 12,
            padding: '10px 14px',
            background: 'rgba(239, 68, 68, 0.08)',
            borderLeft: '3px solid #ef4444',
            borderRadius: 6
          }}>
            <div style={{ fontSize: '0.58rem', color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700, marginBottom: 3 }}>Kill reason</div>
            <div style={{ fontSize: '0.76rem', color: 'var(--bos-text)' }}>{test.kill_reason}</div>
          </div>
        )}
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
