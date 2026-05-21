import { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, Cell, Tooltip, XAxis, YAxis, PieChart, Pie } from 'recharts';
import {
  Store, MapPin, Activity, Zap, Check, X, Send, RefreshCw, ExternalLink,
  DollarSign, Eye, MousePointerClick, Users, TrendingUp, Layers, Sparkles,
  FileText, BarChart3, DoorOpen, Plus, Loader2, AlertCircle, Trash2,
  Image as ImageIcon, Camera, MessageSquare, ThumbsUp, AlertTriangle,
  HelpCircle, ThumbsDown, Ban, Bot
} from 'lucide-react';
import api from '../../api';

// ═══════════════════════════════════════════════════════════════════════
// DESIGN SYSTEM
// ═══════════════════════════════════════════════════════════════════════
const COLORS = {
  hermes: '#f59e0b',          // amber-500
  hermesSoft: '#f59e0b22',
  bg: '#0a0a0f',
  surface: 'rgba(255,255,255,0.025)',
  surfaceHover: 'rgba(255,255,255,0.045)',
  border: 'rgba(255,255,255,0.06)',
  borderStrong: 'rgba(255,255,255,0.10)',
  text: '#e2e8f0',
  textMuted: '#94a3b8',
  textDim: '#64748b',
  success: '#10b981',
  warning: '#fbbf24',
  error: '#f43f5e',
  info: '#3b82f6'
};

const OFFER_META = {
  free_chamoy:      { color: '#ef4444', label: 'Free Chamoy', icon: '🌶' },
  free_tajin:       { color: '#f97316', label: 'Free Tajín', icon: '🍋' },
  free_olive:       { color: '#10b981', label: 'Free Olive', icon: '🫒' },
  bring_your_jar:   { color: '#14b8a6', label: 'Bring Your Jar', icon: '🏺' },
  tasting_flight:   { color: '#a855f7', label: 'Tasting Flight', icon: '🍴' },
  build_your_box:   { color: '#06b6d4', label: 'Build Your Box', icon: '📦' },
  pull_up_pour:     { color: '#ec4899', label: 'Pull Up', icon: '🍸' },
  nj_locals:        { color: '#3b82f6', label: 'NJ Locals', icon: '🗽' },
  first_timer_perk: { color: '#fbbf24', label: '1st-Timer Perk', icon: '🎁' },
  // Legacy
  free_pickle:      { color: '#22c55e', label: 'Free Pickle', icon: '🥒' },
  big_dill_chamoy:  { color: '#ef4444', label: 'Big Dill', icon: '🌶' },
  mystery_pickle:   { color: '#a855f7', label: 'Mystery', icon: '❓' }
};

const STATUS_META = {
  pending:   { color: COLORS.warning, label: 'Pending' },
  approved:  { color: COLORS.success, label: 'Approved' },
  rejected:  { color: COLORS.error,   label: 'Rejected' },
  live:      { color: COLORS.info,    label: 'Live' },
  paused:    { color: COLORS.textDim, label: 'Paused' },
  completed: { color: '#a78bfa',      label: 'Completed' },
  expired:   { color: COLORS.textDim, label: 'Expired' }
};

// ═══════════════════════════════════════════════════════════════════════
// PRIMITIVES
// ═══════════════════════════════════════════════════════════════════════

function GlassCard({ children, padding = 16, hover = false, accent, style = {}, ...rest }) {
  return (
    <motion.div
      whileHover={hover ? { y: -2, borderColor: accent || COLORS.borderStrong } : undefined}
      transition={{ duration: 0.15 }}
      style={{
        background: COLORS.surface,
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: `1px solid ${COLORS.border}`,
        borderRadius: 12,
        padding,
        ...style
      }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

function OfferBadge({ type, size = 'md' }) {
  const meta = OFFER_META[type] || { color: COLORS.textDim, label: type, icon: '·' };
  const padding = size === 'sm' ? '2px 7px' : '4px 10px';
  const fontSize = size === 'sm' ? '0.65rem' : '0.7rem';
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding,
      borderRadius: 999,
      background: `${meta.color}1a`,
      color: meta.color,
      fontSize,
      fontWeight: 600,
      letterSpacing: 0.3,
      border: `1px solid ${meta.color}33`
    }}>
      <span style={{ fontSize: '0.9em' }}>{meta.icon}</span>
      {meta.label}
    </span>
  );
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { color: COLORS.textDim, label: status };
  const isLive = status === 'live';
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      padding: '3px 9px',
      borderRadius: 6,
      background: `${meta.color}1a`,
      color: meta.color,
      fontSize: '0.65rem',
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      border: `1px solid ${meta.color}33`
    }}>
      {isLive && (
        <motion.span
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 1.8, repeat: Infinity }}
          style={{ width: 6, height: 6, borderRadius: 999, background: meta.color }}
        />
      )}
      {meta.label}
    </span>
  );
}

function Button({ children, onClick, variant = 'primary', loading, disabled, icon: Icon, fullWidth, size = 'md' }) {
  const styles = {
    primary: { bg: COLORS.hermes, color: '#0a0a0a', hoverBg: '#fbbf24' },
    secondary: { bg: 'transparent', color: COLORS.text, hoverBg: COLORS.surfaceHover, border: `1px solid ${COLORS.borderStrong}` },
    success: { bg: COLORS.success, color: '#000', hoverBg: '#34d399' },
    danger: { bg: COLORS.error, color: '#fff', hoverBg: '#fb7185' },
    ghost: { bg: 'transparent', color: COLORS.textMuted, hoverBg: COLORS.surface }
  };
  const s = styles[variant];
  const sz = size === 'sm' ? { p: '5px 10px', fs: '0.72rem' } : { p: '8px 14px', fs: '0.82rem' };

  return (
    <motion.button
      whileHover={!disabled && !loading ? { scale: 1.02 } : undefined}
      whileTap={!disabled && !loading ? { scale: 0.97 } : undefined}
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        background: s.bg,
        color: s.color,
        border: s.border || 'none',
        padding: sz.p,
        borderRadius: 8,
        fontWeight: 600,
        fontSize: sz.fs,
        cursor: (disabled || loading) ? 'wait' : 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        width: fullWidth ? '100%' : 'auto',
        justifyContent: fullWidth ? 'center' : 'flex-start',
        opacity: disabled ? 0.5 : 1,
        transition: 'background 0.15s'
      }}
    >
      {loading ? <Loader2 size={14} className="spin" /> : Icon ? <Icon size={14} /> : null}
      {children}
    </motion.button>
  );
}

function Toast({ message, type = 'info', onClose }) {
  const styles = {
    info: { bg: '#3b82f622', border: COLORS.info, text: COLORS.info, icon: AlertCircle },
    success: { bg: '#10b98122', border: COLORS.success, text: COLORS.success, icon: Check },
    error: { bg: '#f43f5e22', border: COLORS.error, text: COLORS.error, icon: AlertCircle },
    warning: { bg: '#fbbf2422', border: COLORS.warning, text: COLORS.warning, icon: AlertCircle }
  };
  const s = styles[type];
  const Icon = s.icon;
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 20, scale: 0.95 }}
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        background: s.bg,
        backdropFilter: 'blur(16px)',
        border: `1px solid ${s.border}66`,
        borderRadius: 12,
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        color: s.text,
        fontSize: '0.85rem',
        fontWeight: 500,
        zIndex: 9999,
        maxWidth: 420,
        boxShadow: `0 10px 40px -10px ${s.border}40`
      }}
    >
      <Icon size={16} />
      <span>{message}</span>
      <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'currentColor', cursor: 'pointer', marginLeft: 8, opacity: 0.5 }}>
        <X size={14} />
      </button>
    </motion.div>
  );
}

function useToast() {
  const [toast, setToast] = useState(null);
  const show = (message, type = 'info') => {
    setToast({ message, type, id: Date.now() });
    setTimeout(() => setToast(null), 4000);
  };
  return [toast, show, () => setToast(null)];
}

// ═══════════════════════════════════════════════════════════════════════
// FORMATTERS
// ═══════════════════════════════════════════════════════════════════════
const fmt = {
  money: (n) => {
    if (n == null || isNaN(n)) return '—';
    if (n === 0) return '$0';
    if (n < 1) return `$${n.toFixed(2)}`;
    if (n < 100) return `$${n.toFixed(2)}`;
    if (n < 1000) return `$${Math.round(n)}`;
    return `$${(n / 1000).toFixed(1)}k`;
  },
  num: (n) => {
    if (n == null || isNaN(n)) return '—';
    if (n === 0) return '0';
    if (n < 1000) return `${Math.round(n)}`;
    if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1000000).toFixed(2)}M`;
  },
  pct: (n) => {
    if (n == null || isNaN(n)) return '—';
    return `${n.toFixed(2)}%`;
  }
};

// ═══════════════════════════════════════════════════════════════════════
// PROPOSALS TAB
// ═══════════════════════════════════════════════════════════════════════

function ProposalsTab({ onToast }) {
  const [proposals, setProposals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('pending');
  const [triggering, setTriggering] = useState(false);

  async function fetchProposals() {
    setLoading(true);
    try {
      const { data } = await api.get(`/api/hermes/proposals?status=${filter}`);
      setProposals(data.proposals || []);
    } finally { setLoading(false); }
  }

  useEffect(() => { fetchProposals(); }, [filter]);

  async function approve(p) {
    try {
      const { data } = await api.post(`/api/hermes/proposals/${p._id}/approve`, {}, { timeout: 60000 });
      if (data.proposal?.status === 'live') onToast(`Publicado a Meta · ad_id: ${data.proposal.meta_ad_id}`, 'success');
      else if (data.proposal?.rejection_reason?.startsWith('publish_failed')) onToast(`Aprobado pero publish falló: ${data.proposal.rejection_reason}`, 'warning');
      fetchProposals();
    } catch (err) {
      onToast(err.response?.data?.error || err.message, 'error');
      fetchProposals();
    }
  }

  async function reject(p) {
    const reason = prompt('Razón de rechazo (opcional):') || '';
    await api.post(`/api/hermes/proposals/${p._id}/reject`, { reason });
    fetchProposals();
  }

  async function publish(p) {
    try {
      const { data } = await api.post(`/api/hermes/proposals/${p._id}/publish`, {}, { timeout: 60000 });
      if (data.proposal?.status === 'live') onToast(`Publicado · ad_id: ${data.proposal.meta_ad_id}`, 'success');
      fetchProposals();
    } catch (err) {
      onToast(err.response?.data?.error || err.message, 'error');
      fetchProposals();
    }
  }

  async function triggerCycle() {
    setTriggering(true);
    try {
      const { data } = await api.post('/api/hermes/trigger-cycle', {}, { timeout: 180000 });
      if (data.skipped) onToast(`Skipped: ${data.reason}`, 'warning');
      else if (data.generated) onToast(`Generado · ${data.offer_type}`, 'success');
      fetchProposals();
    } catch (err) {
      const isTimeout = err.code === 'ECONNABORTED' || /timeout/i.test(err.message);
      if (isTimeout) {
        onToast('Generando en background, refresca en 1-2 min', 'info');
        fetchProposals();
      } else onToast(err.response?.data?.error || err.message, 'error');
    } finally { setTriggering(false); }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {['pending', 'approved', 'live', 'rejected', 'all'].map(s => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              style={{
                padding: '6px 14px',
                fontSize: '0.78rem',
                fontWeight: filter === s ? 700 : 500,
                background: filter === s ? `${COLORS.hermes}22` : 'transparent',
                color: filter === s ? COLORS.hermes : COLORS.textMuted,
                border: `1px solid ${filter === s ? COLORS.hermes + '66' : COLORS.border}`,
                borderRadius: 8,
                cursor: 'pointer',
                textTransform: 'capitalize',
                transition: 'all 0.15s'
              }}
            >{s}</button>
          ))}
        </div>
        <Button onClick={triggerCycle} loading={triggering} icon={Sparkles}>
          {triggering ? 'Generando...' : 'Generar ahora'}
        </Button>
      </div>

      {loading ? (
        <SkeletonGrid count={6} />
      ) : proposals.length === 0 ? (
        <EmptyState icon={ImageIcon} title="Sin proposals" message={`No hay proposals en estado "${filter}"`} />
      ) : (
        <motion.div
          initial="hidden"
          animate="visible"
          variants={{ visible: { transition: { staggerChildren: 0.04 } } }}
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 18 }}
        >
          {proposals.map(p => (
            <motion.div
              key={p._id}
              variants={{
                hidden: { opacity: 0, y: 12 },
                visible: { opacity: 1, y: 0 }
              }}
            >
              <ProposalCard p={p} onApprove={() => approve(p)} onReject={() => reject(p)} onPublish={() => publish(p)} />
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}

function ProposalCard({ p, onApprove, onReject, onPublish }) {
  const meta = OFFER_META[p.offer_type] || {};
  const [view, setView] = useState('feed');  // 'feed' (2:3) | 'story' (9:16)
  const token = localStorage.getItem('auth_token') || '';
  const imgSrc = view === 'story'
    ? `${api.defaults.baseURL}/api/hermes/proposals/${p._id}/image-story?token=${token}`
    : `${api.defaults.baseURL}/api/hermes/proposals/${p._id}/image?token=${token}`;

  const toggleBtn = (id, label) => (
    <button
      onClick={() => setView(id)}
      style={{
        padding: '3px 9px', fontSize: '0.62rem', fontWeight: 700,
        letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer',
        border: 'none', borderRadius: 5,
        background: view === id ? meta.color || COLORS.info : 'rgba(0,0,0,0.55)',
        color: view === id ? '#000' : '#fff'
      }}
    >{label}</button>
  );

  return (
    <GlassCard padding={0} hover accent={meta.color} style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ position: 'relative', background: '#000' }}>
        <img
          src={imgSrc}
          alt={`composed ad ${view}`}
          style={{ width: '100%', display: 'block' }}
        />
        <div style={{ position: 'absolute', top: 10, left: 10 }}>
          <OfferBadge type={p.offer_type} size="sm" />
        </div>
        <div style={{ position: 'absolute', top: 10, right: 10 }}>
          <StatusBadge status={p.status} />
        </div>
        <div style={{ position: 'absolute', bottom: 10, left: 10, display: 'flex', gap: 5 }}>
          {toggleBtn('feed', 'Feed 2:3')}
          {toggleBtn('story', 'Story 9:16')}
        </div>
      </div>
      <div style={{ padding: 14, flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontWeight: 700, fontSize: '0.95rem', marginBottom: 4 }}>{p.headline}</div>
        <div style={{ fontSize: '0.78rem', color: COLORS.textMuted, lineHeight: 1.45, marginBottom: 12 }}>
          {p.primary_text}
        </div>
        <div style={{ fontSize: '0.68rem', color: COLORS.textDim, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          {new Date(p.generated_at).toLocaleString()}
        </div>
        {p.status === 'pending' && (
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="success" fullWidth size="sm" icon={Check} onClick={onApprove}>Aprobar</Button>
            <Button variant="danger" size="sm" icon={X} onClick={onReject}>Rechazar</Button>
          </div>
        )}
        {p.status === 'approved' && !p.meta_ad_id && (
          <Button variant="primary" fullWidth size="sm" icon={Send} onClick={onPublish}>Publicar a Meta</Button>
        )}
        {p.status === 'live' && p.meta_ad_id && (
          <a
            href={`https://business.facebook.com/adsmanager/manage/ads/edit?selected_ad_ids=${p.meta_ad_id}`}
            target="_blank" rel="noopener noreferrer"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontSize: '0.74rem', color: COLORS.info, textDecoration: 'none'
            }}
          >
            <ExternalLink size={12} /> ad_id: {p.meta_ad_id}
          </a>
        )}
        {p.rejection_reason && (
          <div style={{
            fontSize: '0.72rem',
            color: p.rejection_reason.startsWith('publish_failed') ? COLORS.warning : COLORS.error,
            marginTop: 8,
            padding: 8,
            background: p.rejection_reason.startsWith('publish_failed') ? `${COLORS.warning}1a` : `${COLORS.error}1a`,
            borderRadius: 6
          }}>{p.rejection_reason}</div>
        )}
      </div>
    </GlassCard>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// PERFORMANCE TAB
// ═══════════════════════════════════════════════════════════════════════

function PerformanceTab({ onToast }) {
  const [proposals, setProposals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [autoSynced, setAutoSynced] = useState(false);

  async function fetchLive() {
    setLoading(true);
    try {
      const { data } = await api.get('/api/hermes/proposals?status=all&limit=200');
      setProposals((data.proposals || []).filter(p => p.meta_ad_id));
    } finally { setLoading(false); }
  }
  async function syncAll(silent = false) {
    setSyncing(true);
    try {
      const { data } = await api.post('/api/hermes/sync-all-metrics', {}, { timeout: 120000 });
      if (!silent) onToast(`Sync OK · ${data.synced} ads`, 'success');
      await fetchLive();
    } catch (err) {
      if (!silent) onToast(err.response?.data?.error || err.message, 'error');
    } finally { setSyncing(false); }
  }

  // Auto-sync una vez al mount — para que el user no tenga que apretar
  // el botón manualmente cada vez que entra al tab. Silent (sin toast).
  useEffect(() => {
    fetchLive().then(() => {
      if (!autoSynced) {
        setAutoSynced(true);
        syncAll(true);
      }
    });
  }, []);

  const totals = useMemo(() => proposals.reduce((acc, p) => {
    const perf = p.performance || {};
    acc.spend += (perf.spend || 0);
    acc.reach += (perf.reach || 0);
    acc.impressions += (perf.impressions || 0);
    acc.link_clicks += (perf.link_clicks || 0);
    acc.manual_visits += (perf.manual_visits_reported || 0);
    return acc;
  }, { spend: 0, reach: 0, impressions: 0, link_clicks: 0, manual_visits: 0 }), [proposals]);

  const avgCtr = totals.impressions > 0 ? (totals.link_clicks / totals.impressions) * 100 : 0;
  const costPerVisit = totals.manual_visits > 0 ? totals.spend / totals.manual_visits : 0;

  // Donut data — distribution by offer
  const offerDistribution = useMemo(() => {
    const groups = {};
    for (const p of proposals) {
      const key = p.offer_type;
      if (!groups[key]) groups[key] = 0;
      groups[key] += (p.performance?.spend || 0) + 1;  // +1 fallback para que no quede vacío con $0 spend
    }
    return Object.entries(groups).map(([key, value]) => ({
      key, value, color: OFFER_META[key]?.color || COLORS.textDim, label: OFFER_META[key]?.label || key
    }));
  }, [proposals]);

  // Breakdowns — filtran proposals legacy sin pov_id/typography_id (pre-13-may)
  function groupBy(field) {
    const groups = {};
    for (const p of proposals) {
      const rawKey = field === 'offer' ? p.offer_type : p.overlay_config?.[field];
      // Skip los que no tienen el field (proposals pre-refactor del 13-may)
      if (field !== 'offer' && !rawKey) continue;
      const key = rawKey || p.offer_type;
      if (!groups[key]) groups[key] = { spend: 0, link_clicks: 0, impressions: 0, count: 0, manual_visits: 0 };
      groups[key].spend += (p.performance?.spend || 0);
      groups[key].link_clicks += (p.performance?.link_clicks || 0);
      groups[key].impressions += (p.performance?.impressions || 0);
      groups[key].manual_visits += (p.performance?.manual_visits_reported || 0);
      groups[key].count++;
    }
    return Object.entries(groups)
      .map(([k, v]) => ({ key: k, ...v, ctr: v.impressions > 0 ? (v.link_clicks / v.impressions) * 100 : 0 }))
      .sort((a, b) => b.spend - a.spend);
  }
  const byOffer = useMemo(() => groupBy('offer'), [proposals]);
  const byPov = useMemo(() => groupBy('pov_id'), [proposals]);
  const byTypo = useMemo(() => groupBy('typography_id'), [proposals]);
  const byBg = useMemo(() => groupBy('background_color'), [proposals]);

  const lastSync = proposals.find(p => p.performance?.measured_at)?.performance?.measured_at;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div style={{ color: COLORS.textMuted, fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Activity size={14} />
          <span><strong style={{ color: COLORS.text }}>{proposals.length}</strong> ads con datos · last sync: {lastSync ? new Date(lastSync).toLocaleString() : 'nunca'}</span>
        </div>
        <Button onClick={syncAll} loading={syncing} icon={RefreshCw}>
          {syncing ? 'Sincronizando...' : 'Pull métricas Meta'}
        </Button>
      </div>

      {loading ? (
        <SkeletonGrid count={4} />
      ) : proposals.length === 0 ? (
        <EmptyState icon={BarChart3} title="Sin ads live aún" message="Aprobá una proposal en el tab Proposals para que se publique a Meta y empiecen las métricas." />
      ) : (
        <>
          {/* KPI grid — bento style */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 14, marginBottom: 20 }}>
            <KpiCard icon={DollarSign} label="Spend total" value={fmt.money(totals.spend)} accent={COLORS.success} />
            <KpiCard icon={Eye} label="Reach" value={fmt.num(totals.reach)} accent={COLORS.info} />
            <KpiCard icon={Layers} label="Impressions" value={fmt.num(totals.impressions)} accent="#a855f7" />
            <KpiCard icon={MousePointerClick} label="Link clicks" value={fmt.num(totals.link_clicks)} accent="#ec4899" />
            <KpiCard icon={TrendingUp} label="CTR" value={fmt.pct(avgCtr)} accent={avgCtr > 1 ? COLORS.success : COLORS.warning} />
            <KpiCard icon={Users} label="Cost / visit" value={totals.manual_visits > 0 ? fmt.money(costPerVisit) : '—'} subtitle={`${totals.manual_visits} visits`} accent={COLORS.hermes} />
          </div>

          {/* Charts row principal — distribución + performance por oferta */}
          <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 12, marginBottom: 12 }}>
            <GlassCard padding={14}>
              <SectionTitle icon={Layers}>Distribución por oferta</SectionTitle>
              <DonutChart data={offerDistribution} />
            </GlassCard>
            <GlassCard padding={14}>
              <SectionTitle icon={BarChart3}>Performance por oferta</SectionTitle>
              <BreakdownChart rows={byOffer} accent={COLORS.hermes} />
            </GlassCard>
          </div>

          {/* Breakdowns secundarios — solo mostrar si hay AL MENOS 2 grupos
              (sino significa que es legacy sin rotation data) */}
          {(byPov.length > 1 || byTypo.length > 1 || byBg.length > 1) ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 12 }}>
              <GlassCard padding={14}>
                <SectionTitle icon={Camera}>Por POV</SectionTitle>
                {byPov.length >= 2 ? (
                  <BreakdownChart rows={byPov} accent={COLORS.info} compact />
                ) : <NeedsMoreData />}
              </GlassCard>
              <GlassCard padding={14}>
                <SectionTitle icon={FileText}>Por tipografía</SectionTitle>
                {byTypo.length >= 2 ? (
                  <BreakdownChart rows={byTypo} accent="#a855f7" compact />
                ) : <NeedsMoreData />}
              </GlassCard>
              <GlassCard padding={14}>
                <SectionTitle icon={Sparkles}>Por background</SectionTitle>
                {byBg.length >= 2 ? (
                  <BreakdownChart rows={byBg} accent="#10b981" compact />
                ) : <NeedsMoreData />}
              </GlassCard>
            </div>
          ) : (
            <GlassCard style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 8 }}>
                <Sparkles size={20} style={{ color: COLORS.hermes, flexShrink: 0 }} />
                <div style={{ fontSize: '0.82rem', color: COLORS.textMuted, lineHeight: 1.5 }}>
                  <strong style={{ color: COLORS.text }}>Breakdowns por POV / Tipografía / Background pendientes.</strong> Los ads pre-refactor (13-may) no tienen estos campos persistidos. A medida que se publiquen nuevos ads con las rotaciones nuevas, aparecerán los breakdowns acá.
                </div>
              </div>
            </GlassCard>
          )}

          {/* Tabla detalle */}
          <GlassCard>
            <SectionTitle icon={Layers}>Ads individuales ({proposals.length})</SectionTitle>
            <div style={{ display: 'grid', gap: 6, marginTop: 12 }}>
              {proposals.map(p => <AdRow key={p._id} p={p} />)}
            </div>
          </GlassCard>
        </>
      )}
    </div>
  );
}

function KpiCard({ icon: Icon, label, value, subtitle, accent }) {
  return (
    <GlassCard hover accent={accent} padding={14}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: '0.68rem', color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
        <Icon size={14} style={{ color: accent || COLORS.textDim }} />
      </div>
      <div style={{ fontSize: '1.55rem', fontWeight: 700, color: COLORS.text, fontFamily: 'JetBrains Mono, ui-monospace, monospace', letterSpacing: -0.5 }}>
        {value ?? '—'}
      </div>
      {subtitle && <div style={{ fontSize: '0.68rem', color: COLORS.textDim, marginTop: 2 }}>{subtitle}</div>}
    </GlassCard>
  );
}

function SectionTitle({ children, icon: Icon }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, color: COLORS.text, fontSize: '0.85rem', fontWeight: 600 }}>
      {Icon && <Icon size={15} style={{ color: COLORS.hermes }} />}
      {children}
    </div>
  );
}

function DonutChart({ data }) {
  if (!data || data.length === 0) return <p style={{ color: COLORS.textMuted, fontSize: '0.78rem' }}>Sin data</p>;
  return (
    <div style={{ height: 200 }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="label" innerRadius={50} outerRadius={80} paddingAngle={2}>
            {data.map((entry, i) => <Cell key={i} fill={entry.color} stroke="none" />)}
          </Pie>
          <Tooltip
            contentStyle={{ background: 'rgba(15,23,42,0.95)', border: `1px solid ${COLORS.border}`, borderRadius: 8, fontSize: '0.78rem' }}
            formatter={(v, n) => [`${v}`, n]}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

function BreakdownChart({ rows, accent, compact }) {
  if (!rows || rows.length === 0) return <p style={{ color: COLORS.textMuted, fontSize: '0.78rem' }}>Sin data</p>;

  // Truncar labels largos (background_color names son verbose)
  const truncate = (s, n = 18) => s && s.length > n ? s.slice(0, n) + '…' : s;

  const chartData = rows.map(r => ({
    name: truncate(OFFER_META[r.key]?.label || r.key),
    spend: r.spend,
    clicks: r.link_clicks,
    ctr: r.ctr,
    color: OFFER_META[r.key]?.color || accent
  }));

  const height = compact ? 140 : 200;
  const width = compact ? 80 : 100;

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <XAxis type="number" hide />
          <YAxis dataKey="name" type="category" tick={{ fill: COLORS.textMuted, fontSize: compact ? 10 : 11 }} axisLine={false} tickLine={false} width={width} />
          <Tooltip
            contentStyle={{ background: 'rgba(15,23,42,0.95)', border: `1px solid ${COLORS.border}`, borderRadius: 8, fontSize: '0.78rem' }}
            formatter={(v, n) => [n === 'spend' ? fmt.money(v) : fmt.num(v), n]}
            cursor={{ fill: 'rgba(255,255,255,0.03)' }}
          />
          <Bar dataKey="spend" radius={[0, 4, 4, 0]}>
            {chartData.map((d, i) => <Cell key={i} fill={d.color} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function NeedsMoreData() {
  return (
    <div style={{
      padding: '20px 8px',
      textAlign: 'center',
      color: COLORS.textDim,
      fontSize: '0.75rem',
      lineHeight: 1.4
    }}>
      <Sparkles size={14} style={{ color: COLORS.hermes, marginBottom: 6 }} />
      <div>Necesita más data</div>
      <div style={{ fontSize: '0.68rem', marginTop: 2, opacity: 0.7 }}>(post-refactor 13-may)</div>
    </div>
  );
}

function AdRow({ p }) {
  return (
    <motion.div
      whileHover={{ background: COLORS.surfaceHover, x: 2 }}
      transition={{ duration: 0.12 }}
      style={{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 8,
        padding: '10px 12px',
        display: 'grid',
        gridTemplateColumns: '1.4fr 0.8fr 1fr 1fr 0.7fr 70px',
        gap: 10,
        fontSize: '0.78rem',
        alignItems: 'center'
      }}
    >
      <div>
        <OfferBadge type={p.offer_type} size="sm" />
        <div style={{ fontSize: '0.65rem', color: COLORS.textDim, marginTop: 4 }}>
          {p.overlay_config?.variant_id || '—'}
        </div>
      </div>
      <Stat label="spend" value={fmt.money(p.performance?.spend || 0)} />
      <Stat label="reach / clk" value={`${fmt.num(p.performance?.reach || 0)} / ${fmt.num(p.performance?.link_clicks || 0)}`} />
      <Stat label="CTR / CPC" value={`${fmt.pct(p.performance?.ctr || 0)} / ${fmt.money(p.performance?.cost_per_click || 0)}`} />
      <Stat label="visits" value={p.performance?.manual_visits_reported || 0} />
      <a
        href={`https://business.facebook.com/adsmanager/manage/ads/edit?selected_ad_ids=${p.meta_ad_id}`}
        target="_blank" rel="noopener noreferrer"
        style={{ color: COLORS.info, textDecoration: 'none', textAlign: 'right', fontSize: '0.72rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 3 }}
      >
        <ExternalLink size={11} />
      </a>
    </motion.div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div style={{ color: COLORS.textDim, fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontWeight: 600, fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}>{value}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// VISITS TAB
// ═══════════════════════════════════════════════════════════════════════

function VisitsTab({ onToast }) {
  const [visits, setVisits] = useState([]);
  const [stats, setStats] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    source_offer: 'free_chamoy',
    source_platform: 'facebook',
    converted_to_purchase: false,
    purchase_amount: 0,
    customer_zip: '',
    visitor_party_size: 1,
    notes: ''
  });

  async function fetchAll() {
    const [v, s] = await Promise.all([
      api.get('/api/hermes/visits?days=30'),
      api.get('/api/hermes/stats?days=30')
    ]);
    setVisits(v.data.visits || []);
    setStats(s.data);
  }
  useEffect(() => { fetchAll(); }, []);

  async function logVisit(e) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.post('/api/hermes/visits', form);
      setForm({
        source_offer: 'free_chamoy', source_platform: 'facebook',
        converted_to_purchase: false, purchase_amount: 0,
        customer_zip: '', visitor_party_size: 1, notes: ''
      });
      fetchAll();
      onToast('Visita registrada', 'success');
    } catch (err) {
      onToast(err.response?.data?.error || err.message, 'error');
    } finally { setSubmitting(false); }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 18 }}>
      {/* Form */}
      <GlassCard padding={20}>
        <SectionTitle icon={DoorOpen}>Registrar visita</SectionTitle>
        <form onSubmit={logVisit} style={{ display: 'grid', gap: 12, marginTop: 4 }}>
          <Field label="¿Qué oferta mencionó?">
            <select value={form.source_offer} onChange={e => setForm({ ...form, source_offer: e.target.value })} style={selectStyle}>
              {Object.entries(OFFER_META).map(([k, v]) => (
                <option key={k} value={k}>{v.icon} {v.label}</option>
              ))}
              <option value="other">Otra</option>
              <option value="unknown">No supo decir</option>
            </select>
          </Field>
          <Field label="Plataforma">
            <select value={form.source_platform} onChange={e => setForm({ ...form, source_platform: e.target.value })} style={selectStyle}>
              <option value="facebook">Facebook</option>
              <option value="instagram">Instagram</option>
              <option value="unknown">No supo</option>
            </select>
          </Field>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, background: COLORS.surface, borderRadius: 8, border: `1px solid ${COLORS.border}`, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.converted_to_purchase} onChange={e => setForm({ ...form, converted_to_purchase: e.target.checked })} />
            <span style={{ fontSize: '0.85rem' }}>¿Compró algo?</span>
          </label>
          {form.converted_to_purchase && (
            <Field label="Monto compra $">
              <input type="number" step="0.01" value={form.purchase_amount} onChange={e => setForm({ ...form, purchase_amount: parseFloat(e.target.value) || 0 })} style={inputStyle} />
            </Field>
          )}
          <Field label="Zip cliente (opcional)">
            <input type="text" value={form.customer_zip} onChange={e => setForm({ ...form, customer_zip: e.target.value })} style={inputStyle} placeholder="07601" />
          </Field>
          <Field label="Notas (opcional)">
            <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows="2" style={inputStyle} />
          </Field>
          <Button onClick={null} fullWidth loading={submitting} icon={Plus}>
            {submitting ? 'Registrando...' : 'Registrar'}
          </Button>
        </form>
      </GlassCard>

      {/* Right side */}
      <div>
        <GlassCard padding={18}>
          <SectionTitle icon={BarChart3}>Últimos 30 días</SectionTitle>
          {stats?.visits?.by_offer?.length > 0 ? (
            <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
              {stats.visits.by_offer.map(s => (
                <div key={s._id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 12px', background: COLORS.surface, borderRadius: 8,
                  border: `1px solid ${COLORS.border}`
                }}>
                  <OfferBadge type={s._id} size="sm" />
                  <div style={{ display: 'flex', gap: 16, fontSize: '0.78rem', fontFamily: 'JetBrains Mono, monospace' }}>
                    <span><strong>{s.count}</strong> <span style={{ color: COLORS.textDim }}>visits</span></span>
                    <span style={{ color: COLORS.success }}>{s.converted} comp</span>
                    <span style={{ color: COLORS.hermes }}>${Math.round(s.revenue)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={DoorOpen} title="Sin visitas" message="Cuando alguien llegue a la tienda, registra la visita acá para empezar a trackear performance real." compact />
          )}
        </GlassCard>

        <GlassCard padding={18} style={{ marginTop: 14 }}>
          <SectionTitle icon={Activity}>Timeline reciente</SectionTitle>
          {visits.length === 0 ? (
            <p style={{ color: COLORS.textMuted, fontSize: '0.78rem', marginTop: 8 }}>Sin actividad.</p>
          ) : (
            <div style={{ display: 'grid', gap: 6, marginTop: 8, maxHeight: 320, overflowY: 'auto' }}>
              {visits.slice(0, 15).map(v => (
                <div key={v._id} style={{
                  padding: '8px 12px',
                  background: COLORS.surface,
                  borderLeft: `3px solid ${OFFER_META[v.source_offer]?.color || COLORS.textDim}`,
                  borderRadius: 6,
                  fontSize: '0.75rem',
                  display: 'flex', justifyContent: 'space-between'
                }}>
                  <span>
                    <strong>{OFFER_META[v.source_offer]?.label || v.source_offer}</strong>
                    {v.converted_to_purchase && <span style={{ color: COLORS.hermes, marginLeft: 8 }}>${v.purchase_amount}</span>}
                  </span>
                  <span style={{ color: COLORS.textDim }}>{new Date(v.visited_at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </GlassCard>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// REFERENCES TAB — imágenes que gpt-image-2 usa como ancla visual
// ═══════════════════════════════════════════════════════════════════════

const REF_OFFER_OPTIONS = [
  { value: 'any', label: 'Todas las ofertas' },
  { value: 'free_chamoy', label: 'Free Chamoy Pickle' },
  { value: 'free_tajin', label: 'Free Tajín Pickle' },
  { value: 'free_olive_flight', label: 'Free Olive Flight' },
  { value: 'free_olive', label: 'Free Stuffed Olive' },
  { value: 'free_pickle_flight', label: 'Free Pickle Flight' },
  { value: 'free_big_dill', label: 'Free Big Dill' },
  { value: 'free_pickle_juice', label: 'Free Pickle Juice' }
];
const REF_PURPOSE_LABEL = { product: 'Producto', style: 'Estilo', color: 'Color' };

function ReferencesTab({ onToast }) {
  const [refs, setRefs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [file, setFile] = useState(null);
  const [offerMatch, setOfferMatch] = useState('any');
  const [purpose, setPurpose] = useState('product');
  const [notes, setNotes] = useState('');
  const fileInputRef = useRef(null);

  async function fetchRefs() {
    setLoading(true);
    try {
      const { data } = await api.get('/api/hermes/references');
      setRefs(data.references || []);
    } catch (err) {
      onToast(err.response?.data?.error || err.message, 'error');
    } finally { setLoading(false); }
  }
  useEffect(() => { fetchRefs(); }, []);

  async function upload(e) {
    e.preventDefault();
    if (!file) { onToast('Elegí una imagen primero', 'error'); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('image', file);
      fd.append('offer_match', offerMatch);
      fd.append('purpose', purpose);
      fd.append('notes', notes);
      await api.post('/api/hermes/references/upload', fd, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setFile(null); setNotes(''); setOfferMatch('any'); setPurpose('product');
      if (fileInputRef.current) fileInputRef.current.value = '';
      fetchRefs();
      onToast('Referencia subida', 'success');
    } catch (err) {
      onToast(err.response?.data?.error || err.message, 'error');
    } finally { setUploading(false); }
  }

  async function toggleActive(ref) {
    try {
      await api.patch(`/api/hermes/references/${ref._id}`, { active: !ref.active });
      fetchRefs();
    } catch (err) { onToast(err.response?.data?.error || err.message, 'error'); }
  }

  async function remove(ref) {
    try {
      await api.delete(`/api/hermes/references/${ref._id}`);
      fetchRefs();
      onToast('Referencia eliminada', 'success');
    } catch (err) { onToast(err.response?.data?.error || err.message, 'error'); }
  }

  const token = localStorage.getItem('auth_token') || '';

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 18 }}>
      {/* Upload form */}
      <GlassCard padding={20}>
        <SectionTitle icon={Camera}>Subir referencia</SectionTitle>
        <form onSubmit={upload} style={{ display: 'grid', gap: 12, marginTop: 4 }}>
          <Field label="Imagen (producto real / estilo / color)">
            <input ref={fileInputRef} type="file" accept="image/*"
              onChange={e => setFile(e.target.files[0] || null)} style={inputStyle} />
          </Field>
          <Field label="¿Para qué oferta aplica?">
            <select value={offerMatch} onChange={e => setOfferMatch(e.target.value)} style={selectStyle}>
              {REF_OFFER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          <Field label="Propósito">
            <select value={purpose} onChange={e => setPurpose(e.target.value)} style={selectStyle}>
              <option value="product">Producto — el pickle/oliva real</option>
              <option value="style">Estilo visual</option>
              <option value="color">Paleta de color</option>
            </select>
          </Field>
          <Field label="Notas (opcional)">
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows="2" style={inputStyle} />
          </Field>
          <Button onClick={null} fullWidth loading={uploading} icon={Plus}>
            {uploading ? 'Subiendo...' : 'Subir referencia'}
          </Button>
        </form>
        <p style={{ fontSize: '0.72rem', color: COLORS.textDim, marginTop: 14, lineHeight: 1.55 }}>
          gpt-image-2 usa estas imágenes como ancla visual al generar. Subí fotos
          del producto real de Jersey Pickles para que los creativos lo muestren
          fiel — no uno inventado.
        </p>
      </GlassCard>

      {/* Grid */}
      <div>
        {loading ? (
          <SkeletonGrid count={4} />
        ) : refs.length === 0 ? (
          <EmptyState icon={ImageIcon} title="Sin referencias"
            message="Subí fotos del producto real para que gpt-image-2 genere creativos fieles a tu marca." />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14 }}>
            {refs.map(ref => (
              <GlassCard key={ref._id} padding={0}
                style={{ overflow: 'hidden', opacity: ref.active ? 1 : 0.45 }}>
                <img
                  src={`${api.defaults.baseURL}/api/hermes/references/${ref._id}/image?token=${token}`}
                  alt={ref.filename}
                  style={{ width: '100%', display: 'block', aspectRatio: '1', objectFit: 'cover' }}
                />
                <div style={{ padding: 10 }}>
                  <div style={{ fontSize: '0.68rem', color: COLORS.textMuted, marginBottom: 8, lineHeight: 1.4 }}>
                    <strong style={{ color: COLORS.text }}>{REF_PURPOSE_LABEL[ref.purpose] || ref.purpose}</strong>
                    {' · '}{(ref.offer_match || []).join(', ')}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Button size="sm" variant={ref.active ? 'success' : 'secondary'}
                      onClick={() => toggleActive(ref)} fullWidth>
                      {ref.active ? 'Activa' : 'Inactiva'}
                    </Button>
                    <Button size="sm" variant="danger" icon={Trash2} onClick={() => remove(ref)} />
                  </div>
                </div>
              </GlassCard>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const inputStyle = {
  background: COLORS.surface,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 8,
  padding: '8px 12px',
  color: COLORS.text,
  fontSize: '0.85rem',
  fontFamily: 'inherit',
  outline: 'none',
  width: '100%'
};
const selectStyle = { ...inputStyle, cursor: 'pointer' };

function Field({ label, children }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: '0.7rem', color: COLORS.textMuted, marginBottom: 4, fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      {children}
    </label>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

function SkeletonGrid({ count = 6 }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
      {Array.from({ length: count }).map((_, i) => (
        <motion.div
          key={i}
          animate={{ opacity: [0.4, 0.6, 0.4] }}
          transition={{ duration: 1.5, repeat: Infinity, delay: i * 0.1 }}
          style={{ height: 280, background: COLORS.surface, borderRadius: 12, border: `1px solid ${COLORS.border}` }}
        />
      ))}
    </div>
  );
}

function EmptyState({ icon: Icon, title, message, compact }) {
  return (
    <div style={{
      textAlign: 'center', padding: compact ? '24px' : '60px 24px',
      color: COLORS.textMuted
    }}>
      <div style={{
        width: 56, height: 56, borderRadius: 14,
        background: `${COLORS.hermes}1a`, border: `1px solid ${COLORS.hermes}33`,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 12, color: COLORS.hermes
      }}>
        <Icon size={24} />
      </div>
      <div style={{ fontSize: '0.95rem', fontWeight: 600, color: COLORS.text, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: '0.82rem', maxWidth: 420, margin: '0 auto', lineHeight: 1.5 }}>{message}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// COMMENTS TAB — inteligencia de comentarios (medir + detectar + responder)
// ═══════════════════════════════════════════════════════════════════════

const CLASS_META = {
  intent_visit:       { color: '#10b981', label: 'Quiere ir', Icon: MapPin },
  visit_reported:     { color: '#3b82f6', label: 'Ya fue', Icon: Check },
  question_logistics: { color: '#fbbf24', label: 'Pregunta', Icon: HelpCircle },
  resonance:          { color: '#94a3b8', label: 'Resonancia', Icon: ThumbsUp },
  negative_creative:  { color: '#f43f5e', label: 'Visual confunde', Icon: AlertTriangle },
  negative_other:     { color: '#fb7185', label: 'Queja', Icon: ThumbsDown },
  spam:               { color: '#64748b', label: 'Spam', Icon: Ban },
  other:              { color: '#64748b', label: 'Otro', Icon: MessageSquare },
  unclassified:       { color: '#64748b', label: 'Sin clasificar', Icon: MessageSquare }
};

function ClassBadge({ cls }) {
  const m = CLASS_META[cls] || CLASS_META.other;
  const Icon = m.Icon;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0,
      fontSize: '0.68rem', fontWeight: 600, padding: '3px 8px', borderRadius: 999,
      background: `${m.color}1a`, color: m.color, border: `1px solid ${m.color}33`,
      whiteSpace: 'nowrap'
    }}><Icon size={11} /> {m.label}</span>
  );
}

// Color del score de intención según nivel (verde alto / amber medio / gris bajo)
function intentColor(score) {
  if (score >= 60) return COLORS.success;
  if (score >= 35) return COLORS.warning;
  return COLORS.textMuted;
}

// Chip compacto métrica (icono + valor + label) — reemplaza el monospace crudo
function StatChip({ icon: Icon, value, label, color }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap',
      padding: '4px 9px', borderRadius: 7, background: `${color}12`,
      border: `1px solid ${color}22`, fontSize: '0.72rem', color: COLORS.textMuted
    }}>
      <Icon size={12} style={{ color }} />
      <strong style={{ color, fontWeight: 700 }}>{value}</strong> {label}
    </span>
  );
}

// Mini-stat del resumen del tab
function MiniStat({ label, value, color, icon: Icon }) {
  return (
    <div style={{
      padding: '12px 14px', background: COLORS.surface, border: `1px solid ${COLORS.border}`,
      borderRadius: 10, borderTop: `2px solid ${color}`, minWidth: 0
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: COLORS.textMuted, fontSize: '0.7rem', fontWeight: 500, marginBottom: 4 }}>
        <Icon size={12} style={{ color }} /> {label}
      </div>
      <div style={{ fontSize: '1.4rem', fontWeight: 700, color, lineHeight: 1, fontFamily: "'Fira Code', 'JetBrains Mono', monospace" }}>{value}</div>
    </div>
  );
}

function CommentsTab({ onToast }) {
  const [summary, setSummary] = useState([]);
  const [flagged, setFlagged] = useState([]);
  const [queue, setQueue] = useState([]);
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [edits, setEdits] = useState({});

  async function fetchAll() {
    setLoading(true);
    try {
      const [sum, flg, q, rec] = await Promise.all([
        api.get('/api/hermes/comments/intent-summary?days=30'),
        api.get('/api/hermes/comments/flagged-creatives'),
        api.get('/api/hermes/comments?reply_status=drafted&limit=50'),
        api.get('/api/hermes/comments?limit=80')
      ]);
      setSummary(sum.data.summary || []);
      setFlagged(flg.data.flagged || []);
      setQueue(q.data.comments || []);
      setRecent(rec.data.comments || []);
    } catch (err) {
      onToast(err.response?.data?.error || err.message, 'error');
    } finally { setLoading(false); }
  }
  useEffect(() => { fetchAll(); }, []);

  async function runCycle() {
    setRunning(true);
    try {
      const { data } = await api.post('/api/hermes/comments/run-cycle', {}, { timeout: 180000 });
      onToast(`Ciclo OK: ${data.sync?.new_comments || 0} nuevos, ${data.classified || 0} clasificados`, 'success');
      fetchAll();
    } catch (err) {
      onToast(err.response?.data?.error || err.message, 'error');
    } finally { setRunning(false); }
  }

  async function approve(c) {
    const text = edits[c._id] != null ? edits[c._id] : c.reply_text;
    try {
      if (edits[c._id] != null && edits[c._id] !== c.reply_text) {
        await api.patch(`/api/hermes/comments/${c._id}/reply`, { reply_text: text });
      }
      await api.post(`/api/hermes/comments/${c._id}/approve-reply`, {}, { timeout: 30000 });
      onToast('Respuesta publicada', 'success');
      fetchAll();
    } catch (err) {
      onToast(err.response?.data?.error || err.message, 'error');
    }
  }

  async function skip(c) {
    try {
      await api.post(`/api/hermes/comments/${c._id}/skip-reply`);
      fetchAll();
    } catch (err) {
      onToast(err.response?.data?.error || err.message, 'error');
    }
  }

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: COLORS.textMuted }}><Loader2 size={20} className="spin" /></div>;

  // Totales para el resumen del tab
  const sortedSummary = [...summary].sort((a, b) => (b.avg_intent || 0) - (a.avg_intent || 0));
  const totals = summary.reduce((acc, s) => ({
    comments: acc.comments + (s.total || 0),
    intent: acc.intent + (s.intent_visit || 0),
    questions: acc.questions + (s.questions || 0)
  }), { comments: 0, intent: 0, questions: 0 });

  return (
    <div style={{ display: 'grid', gap: 18, maxWidth: '100%' }}>
      {/* Header + run */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ fontSize: '0.82rem', color: COLORS.textMuted, flex: '1 1 260px', minWidth: 0, lineHeight: 1.5 }}>
          Señal de foot traffic leída de los comentarios — sin depender de la tienda.
        </div>
        <div style={{ flexShrink: 0 }}>
          <Button onClick={runCycle} loading={running} icon={RefreshCw}>
            {running ? 'Procesando...' : 'Sincronizar ahora'}
          </Button>
        </div>
      </div>

      {/* Resumen del tab */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
        <MiniStat label="Comentarios" value={totals.comments} color={COLORS.info} icon={MessageSquare} />
        <MiniStat label="Quieren ir" value={totals.intent} color={COLORS.success} icon={MapPin} />
        <MiniStat label="Preguntas" value={totals.questions} color={COLORS.warning} icon={HelpCircle} />
        <MiniStat label="Creativos flaggeados" value={flagged.length} color={flagged.length > 0 ? COLORS.error : COLORS.textDim} icon={AlertTriangle} />
      </div>

      {/* Flagged creatives — alerta */}
      {flagged.length > 0 && (
        <GlassCard padding={18} style={{ borderColor: `${COLORS.error}44` }}>
          <SectionTitle icon={AlertTriangle}>Creativos con problema de percepción</SectionTitle>
          <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
            {flagged.map(f => (
              <div key={String(f.proposal_id)} style={{
                padding: '12px 14px', background: `${COLORS.error}0d`, borderRadius: 10,
                border: `1px solid ${COLORS.error}22`
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                  <OfferBadge type={f.offer_type} size="sm" />
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0,
                    fontSize: '0.68rem', fontWeight: 700, color: COLORS.error, padding: '2px 8px',
                    borderRadius: 999, background: `${COLORS.error}1a`, border: `1px solid ${COLORS.error}33`
                  }}>
                    <AlertTriangle size={11} /> {f.negative_count} negativos del visual
                  </span>
                </div>
                <div style={{ display: 'grid', gap: 5 }}>
                  {(f.samples || []).map((s, i) => (
                    <div key={i} style={{
                      fontSize: '0.78rem', color: COLORS.textMuted, fontStyle: 'italic',
                      paddingLeft: 10, borderLeft: `2px solid ${COLORS.error}44`, lineHeight: 1.45,
                      overflowWrap: 'anywhere'
                    }}>“{s}”</div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </GlassCard>
      )}

      {/* Intención por oferta — barras de progreso */}
      <GlassCard padding={18}>
        <SectionTitle icon={TrendingUp}>Intención por oferta (30d)</SectionTitle>
        {sortedSummary.length > 0 ? (
          <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
            {sortedSummary.map(s => {
              const score = Math.round(s.avg_intent || 0);
              const col = intentColor(score);
              return (
                <div key={s._id || 'none'} style={{
                  padding: '12px 14px', background: COLORS.surface, borderRadius: 10, border: `1px solid ${COLORS.border}`
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
                    <OfferBadge type={s._id} size="sm" />
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                      <span style={{ fontSize: '1.15rem', fontWeight: 700, color: col, lineHeight: 1, fontFamily: "'Fira Code', 'JetBrains Mono', monospace" }}>{score}</span>
                      <span style={{ fontSize: '0.7rem', color: COLORS.textDim }}>/ 100 intención</span>
                    </div>
                  </div>
                  {/* Barra de progreso */}
                  <div style={{ height: 6, background: COLORS.border, borderRadius: 999, overflow: 'hidden', marginBottom: 10 }}>
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.min(100, score)}%` }}
                      transition={{ duration: 0.6, ease: 'easeOut' }}
                      style={{ height: '100%', background: col, borderRadius: 999 }}
                    />
                  </div>
                  {/* Chips de breakdown */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <StatChip icon={MapPin} value={s.intent_visit || 0} label="quieren ir" color={COLORS.success} />
                    <StatChip icon={HelpCircle} value={s.questions || 0} label="preguntas" color={COLORS.warning} />
                    <StatChip icon={Check} value={s.visits_reported || 0} label="fueron" color={COLORS.info} />
                    {s.creative_issues > 0 && <StatChip icon={AlertTriangle} value={s.creative_issues} label="visual" color={COLORS.error} />}
                    <StatChip icon={MessageSquare} value={s.total || 0} label="total" color={COLORS.textMuted} />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState icon={MessageSquare} title="Sin comentarios clasificados" message="Cuando los ads junten comentarios, acá ves qué oferta genera más intención de visita." compact />
        )}
      </GlassCard>

      {/* Cola de respuestas pendientes */}
      <GlassCard padding={18}>
        <SectionTitle icon={Send}>Respuestas pendientes de aprobar ({queue.length})</SectionTitle>
        {queue.length > 0 ? (
          <div style={{ display: 'grid', gap: 12, marginTop: 10 }}>
            {queue.map(c => (
              <div key={c._id} style={{ padding: 14, background: COLORS.surface, borderRadius: 10, border: `1px solid ${COLORS.border}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
                    <ClassBadge cls={c.classification} />
                    <span style={{ fontSize: '0.74rem', color: COLORS.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.author_name}</span>
                  </div>
                  {c.reply_confidence === 'low' && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0, fontSize: '0.66rem', fontWeight: 600, color: COLORS.warning, padding: '2px 7px', borderRadius: 999, background: `${COLORS.warning}1a`, border: `1px solid ${COLORS.warning}33` }}>
                      <AlertCircle size={10} /> baja confianza
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '0.82rem', color: COLORS.text, marginBottom: 10, lineHeight: 1.45, overflowWrap: 'anywhere' }}>“{c.message}”</div>
                <textarea
                  defaultValue={c.reply_text}
                  onChange={e => setEdits({ ...edits, [c._id]: e.target.value })}
                  rows="2"
                  style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', marginBottom: 10, resize: 'vertical' }}
                  placeholder="Respuesta a publicar..."
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button onClick={() => approve(c)} icon={Check}>Publicar</Button>
                  <Button onClick={() => skip(c)} variant="secondary" icon={X}>Descartar</Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={Check} title="Cola vacía" message="No hay respuestas esperando aprobación." compact />
        )}
      </GlassCard>

      {/* Feed reciente */}
      <GlassCard padding={18}>
        <SectionTitle icon={MessageSquare}>Comentarios recientes</SectionTitle>
        {recent.length > 0 ? (
          <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
            {recent.map(c => (
              <div key={c._id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                padding: '9px 12px', background: COLORS.surface, borderRadius: 8, border: `1px solid ${COLORS.border}`
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: '0.8rem', color: COLORS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.message}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.68rem', color: COLORS.textDim, marginTop: 2 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.author_name}</span>
                    {c.reply_status === 'auto_posted' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: COLORS.success, flexShrink: 0 }}><Bot size={10} /> auto</span>}
                    {c.reply_status === 'posted' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: COLORS.success, flexShrink: 0 }}><Check size={10} /> respondido</span>}
                  </div>
                </div>
                <ClassBadge cls={c.classification} />
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={MessageSquare} title="Sin comentarios aún" message="El ciclo corre cada 3h. Usá 'Sincronizar ahora' para traerlos al toque." compact />
        )}
      </GlassCard>
    </div>
  );
}

export default function HermesPanel() {
  const [tab, setTab] = useState('proposals');
  const [stats, setStats] = useState(null);
  const [toast, showToast, dismissToast] = useToast();

  useEffect(() => {
    api.get('/api/hermes/stats').then(r => setStats(r.data)).catch(() => {});
    const t = setInterval(() => {
      api.get('/api/hermes/stats').then(r => setStats(r.data)).catch(() => {});
    }, 30000);
    return () => clearInterval(t);
  }, []);

  const enabled = stats?.config?.enabled;
  const mode = stats?.config?.mode || 'manual_approval';
  const pendingCount = stats?.proposals?.pending || 0;
  const liveCount = stats?.proposals?.live || 0;
  const visitsCount = (stats?.visits?.by_offer || []).reduce((s, o) => s + (o.count || 0), 0);

  const tabs = [
    { id: 'proposals', label: 'Proposals', icon: FileText, badge: pendingCount > 0 ? pendingCount : null },
    { id: 'references', label: 'Referencias', icon: ImageIcon, badge: null },
    { id: 'performance', label: 'Performance', icon: BarChart3, badge: liveCount > 0 ? liveCount : null },
    { id: 'comments', label: 'Comentarios', icon: MessageSquare, badge: null },
    { id: 'visits', label: 'Store Visits', icon: DoorOpen, badge: visitsCount > 0 ? visitsCount : null }
  ];

  return (
    <div style={{
      padding: 20,
      color: COLORS.text,
      fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
      background: `radial-gradient(ellipse at top, ${COLORS.hermes}08 0%, transparent 50%), ${COLORS.bg}`,
      width: '100%',
      maxWidth: '100%',
      boxSizing: 'border-box',
      overflowX: 'hidden'
    }}>
      <style>{`
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        input::placeholder, textarea::placeholder { color: ${COLORS.textDim}; }
        input:focus, textarea:focus, select:focus { border-color: ${COLORS.hermes}66 !important; }
      `}</style>

      {/* Hero header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ marginBottom: 28 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
              <div style={{
                width: 42, height: 42, borderRadius: 12,
                background: `linear-gradient(135deg, ${COLORS.hermes}, #fbbf24)`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#0a0a0a',
                boxShadow: `0 8px 24px -8px ${COLORS.hermes}66`
              }}>
                <Store size={22} strokeWidth={2.5} />
              </div>
              <div>
                <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700, letterSpacing: -0.5 }}>Hermes</h1>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: COLORS.textMuted, marginTop: 2 }}>
                  <MapPin size={11} />
                  9 Romanelli Ave · South Hackensack, NJ
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 14px', borderRadius: 8,
              background: enabled ? `${COLORS.success}1a` : `${COLORS.textDim}1a`,
              border: `1px solid ${enabled ? COLORS.success + '33' : COLORS.border}`,
              color: enabled ? COLORS.success : COLORS.textMuted,
              fontSize: '0.78rem', fontWeight: 600
            }}>
              {enabled && <motion.span
                animate={{ opacity: [0.4, 1, 0.4] }}
                transition={{ duration: 1.8, repeat: Infinity }}
                style={{ width: 6, height: 6, borderRadius: 999, background: COLORS.success }}
              />}
              {enabled ? 'Active' : 'Disabled'}
            </div>
            <div style={{
              padding: '7px 14px', borderRadius: 8,
              background: COLORS.surface, border: `1px solid ${COLORS.border}`,
              color: COLORS.textMuted, fontSize: '0.78rem', fontWeight: 500
            }}>
              {mode === 'auto' ? '⚡ Auto' : '👤 Manual approval'}
            </div>
          </div>
        </div>

        {/* Hero KPIs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12, marginTop: 16 }}>
          <HeroKpi label="Pending approval" value={pendingCount} accent={pendingCount > 0 ? COLORS.warning : COLORS.textDim} />
          <HeroKpi label="Live ads" value={liveCount} accent={COLORS.info} />
          <HeroKpi label="Visitas 30d" value={visitsCount} accent={COLORS.hermes} />
          <HeroKpi label="Ofertas activas" value="9" subtitle="3 free + 6 hooks" accent={COLORS.success} />
        </div>
      </motion.div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: `1px solid ${COLORS.border}`, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '10px 14px',
              background: 'transparent',
              border: 'none',
              borderBottom: tab === t.id ? `2px solid ${COLORS.hermes}` : '2px solid transparent',
              color: tab === t.id ? COLORS.hermes : COLORS.textMuted,
              cursor: 'pointer',
              fontWeight: tab === t.id ? 600 : 500,
              fontSize: '0.85rem',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              flexShrink: 0,
              whiteSpace: 'nowrap',
              transition: 'color 0.15s',
              fontFamily: 'inherit'
            }}
          >
            <t.icon size={15} />
            {t.label}
            {t.badge != null && (
              <span style={{
                fontSize: '0.65rem', padding: '2px 6px', borderRadius: 999,
                background: tab === t.id ? COLORS.hermes : `${COLORS.textMuted}22`,
                color: tab === t.id ? '#0a0a0a' : COLORS.textMuted,
                fontWeight: 700,
                minWidth: 18, textAlign: 'center'
              }}>{t.badge}</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content with transition */}
      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2 }}
        >
          {tab === 'proposals' && <ProposalsTab onToast={showToast} />}
          {tab === 'references' && <ReferencesTab onToast={showToast} />}
          {tab === 'performance' && <PerformanceTab onToast={showToast} />}
          {tab === 'comments' && <CommentsTab onToast={showToast} />}
          {tab === 'visits' && <VisitsTab onToast={showToast} />}
        </motion.div>
      </AnimatePresence>

      {/* Toast */}
      <AnimatePresence>
        {toast && <Toast key={toast.id} message={toast.message} type={toast.type} onClose={dismissToast} />}
      </AnimatePresence>
    </div>
  );
}

function HeroKpi({ label, value, subtitle, accent }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      style={{
        background: COLORS.surface,
        backdropFilter: 'blur(12px)',
        border: `1px solid ${COLORS.border}`,
        borderRadius: 12,
        padding: 14,
        position: 'relative',
        overflow: 'hidden'
      }}
    >
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 2,
        background: `linear-gradient(90deg, ${accent}, transparent)`
      }} />
      <div style={{ fontSize: '0.68rem', color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: '1.8rem', fontWeight: 700, color: accent, fontFamily: 'JetBrains Mono, ui-monospace, monospace', lineHeight: 1, letterSpacing: -1 }}>
        {value ?? '—'}
      </div>
      {subtitle && <div style={{ fontSize: '0.7rem', color: COLORS.textDim, marginTop: 4 }}>{subtitle}</div>}
    </motion.div>
  );
}
