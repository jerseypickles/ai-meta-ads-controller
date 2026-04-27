import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import api from '../api';

// ═══════════════════════════════════════════════════════════════════════════
// NEURAL GRAPH VIEW — Obsidian vault style
// Canvas rendering via D3 force simulation. Nodes con glow radial,
// particles flowing por edges activos, hover highlight de neighbors.
// ═══════════════════════════════════════════════════════════════════════════

const AGENT_COLORS = {
  zeus: '#60a5fa',       // blue-400 — CEO
  athena: '#34d399',     // emerald-400 — Account
  apollo: '#fbbf24',     // amber-400 — Creator
  prometheus: '#f87171', // red-400 — Testing
  ares: '#a78bfa',       // violet-400 — Portfolio
  satellite: '#94a3b8',  // slate-400 — sub-nodes
  cbo: '#c084fc',        // purple-400 — CBOs (Ares children)
  directive: '#38bdf8',  // sky-400 — directives

  // ─── Planned / coming soon ───
  hermes: '#06b6d4',     // cyan-500 — Comms/Ops (Slack, alerts)
  artemis: '#ec4899',    // pink-500 — Audiences (lookalike, custom)
  hefesto: '#f97316',    // orange-500 — Platform Eng (infra, deploys)
  demeter: '#14b8a6',    // teal-500 — Analytics (LTV, reports)
  planned: '#475569'     // slate-600 — fallback para planned features
};

const AGENT_ICONS = {
  zeus: '⚡', athena: '🦉', apollo: '☀️',
  prometheus: '🔥', ares: '⚔️',
  cbo: '◎', test: '⚗', directive: '▣', pool: '✦',

  // Planned
  hermes: '✉', artemis: '☽', hefesto: '⚒', demeter: '✿',
  video: '▶', audio: '♪', crossplatform: '⊛', memory: '◈'
};

export default function NeuralGraphView({ onAgentClick }) {
  const fgRef = useRef(null);
  const containerRef = useRef(null);
  const [status, setStatus] = useState(null);
  const [demeter, setDemeter] = useState(null);
  const [hoverNode, setHoverNode] = useState(null);
  const [hoverLinks, setHoverLinks] = useState(new Set());
  const [hoverNeighbors, setHoverNeighbors] = useState(new Set());
  const [dims, setDims] = useState({ width: 800, height: 600 });
  const [hasInitialZoom, setHasInitialZoom] = useState(false);

  useEffect(() => {
    loadStatus();
    loadDemeter();
    const t = setInterval(() => { loadStatus(); loadDemeter(); }, 30000);
    return () => clearInterval(t);
  }, []);

  async function loadDemeter() {
    try {
      const [mtdRes, rollingRes] = await Promise.all([
        api.get('/api/demeter/summary?range=mtd'),
        api.get('/api/demeter/summary?days=7')
      ]);
      const mtd = mtdRes.data?.summary || null;
      const rolling7d = rollingRes.data?.summary || null;
      setDemeter({
        ...(mtd || {}),
        count: mtdRes.data?.count || rollingRes.data?.count || 0,
        roas_7d: rolling7d?.avg_cash_roas
      });
    } catch {
      setDemeter({ count: 0, error: true });
    }
  }

  useEffect(() => {
    if (!containerRef.current) return;
    const update = () => {
      const r = containerRef.current.getBoundingClientRect();
      setDims({ width: r.width, height: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  async function loadStatus() {
    try {
      const res = await api.get('/api/brain/briefing');
      const ctx = res.data.context;
      if (!ctx) return;
      setStatus(ctx);
    } catch (err) {
      console.error('NeuralGraphView error:', err);
    }
  }

  // ─── Build graph data from status ───────────────────────────────────────
  const graphData = useMemo(() => {
    // Fallback mientras loadea — todos los counts en 0 para que sea obvio
    // que está cargando. Hardcoded "real-looking" values eran engañosos
    // (ej. 145 en apollo confundía con valor real cuando el endpoint fallaba).
    const fallback = {
      zeus: { directives_24h: 0 },
      agents: { unified_agent: { actions: 0 }, ares_agent: { actions: 0 } },
      apollo: { ready_pool: 0 },
      prometheus: { active_tests: 0 },
      ares: { active_cbos: 0 }
    };
    const s = status || fallback;

    const zeusDirectives = s.zeus?.directives_24h || 0;
    const athenaOps = s.agents?.unified_agent?.actions || 0;
    const apolloPool = s.apollo?.ready_pool || 0;
    const prometheusTests = s.prometheus?.active_tests || 0;
    const aresOps = s.agents?.ares_agent?.actions || 0;
    const activeCBOs = s.ares?.active_cbos || s.account?.active_cbos || 3;

    const nodes = [
      // Tier 0 — Zeus core
      {
        id: 'zeus', group: 'zeus', tier: 0, size: 18,
        label: 'ZEUS', sub: 'CEO · Opus 4.7',
        metric: `${zeusDirectives}`, metricLabel: 'directivas 24h',
        status: 'running', color: AGENT_COLORS.zeus, icon: AGENT_ICONS.zeus
      },

      // Tier 1 — 4 agentes
      {
        id: 'athena', group: 'athena', tier: 1, size: 13,
        label: 'ATHENA', sub: 'Account',
        metric: `${athenaOps}`, metricLabel: 'ops',
        status: athenaOps > 0 ? 'running' : 'idle',
        color: AGENT_COLORS.athena, icon: AGENT_ICONS.athena
      },
      {
        id: 'apollo', group: 'apollo', tier: 1, size: 13,
        label: 'APOLLO', sub: 'Creator',
        metric: `${apolloPool}`, metricLabel: 'ready',
        status: apolloPool >= 60 ? 'paused' : (apolloPool > 0 ? 'running' : 'idle'),
        color: AGENT_COLORS.apollo, icon: AGENT_ICONS.apollo
      },
      {
        id: 'prometheus', group: 'prometheus', tier: 1, size: 13,
        label: 'PROMETHEUS', sub: 'Testing',
        metric: `${prometheusTests}`, metricLabel: 'tests',
        status: prometheusTests > 0 ? 'running' : 'idle',
        color: AGENT_COLORS.prometheus, icon: AGENT_ICONS.prometheus
      },
      {
        id: 'ares', group: 'ares', tier: 1, size: 13,
        label: 'ARES', sub: 'Portfolio',
        metric: `${aresOps}`, metricLabel: 'ops',
        status: aresOps > 0 ? 'running' : 'idle',
        color: AGENT_COLORS.ares, icon: AGENT_ICONS.ares
      }
    ];

    // Tier 2 — satélites
    // Zeus → directivas (mostrar cantidad simbólica)
    const nDirs = Math.min(Math.max(Math.floor(zeusDirectives / 3), 1), 5);
    for (let i = 0; i < nDirs; i++) {
      nodes.push({
        id: `dir-${i}`, group: 'directive', tier: 2, size: 4,
        label: '', sub: '', color: AGENT_COLORS.directive,
        icon: '', parent: 'zeus'
      });
    }

    // Apollo → pool de creativos ready
    nodes.push({
      id: 'apollo-pool', group: 'apollo-sat', tier: 2, size: 7,
      label: `${apolloPool}`, sub: 'pool',
      color: AGENT_COLORS.apollo, icon: AGENT_ICONS.pool, parent: 'apollo'
    });

    // Prometheus → tests activos (representados como cluster pequeño)
    const nTests = Math.min(Math.max(Math.floor(prometheusTests / 3), 1), 6);
    for (let i = 0; i < nTests; i++) {
      nodes.push({
        id: `test-${i}`, group: 'test', tier: 2, size: 4,
        label: '', sub: '',
        color: AGENT_COLORS.prometheus, icon: '', parent: 'prometheus'
      });
    }

    // Ares → CBOs (Duplicados Ganadores / CBO 2 / Medicion)
    const cboList = [
      { id: 'cbo-dup', label: 'Duplicados', sub: 'Ganadores', size: 9 },
      { id: 'cbo-2', label: 'CBO 2', sub: 'Nuevos', size: 7 },
      { id: 'cbo-med', label: 'Medición', sub: '2nda Opp', size: 6 }
    ];
    cboList.forEach(c => {
      nodes.push({
        id: c.id, group: 'cbo', tier: 2, size: c.size,
        label: c.label, sub: c.sub,
        color: AGENT_COLORS.cbo, icon: AGENT_ICONS.cbo, parent: 'ares'
      });
    });

    // ─── DEMETER — agente activo (cash reconciliation) ────────────────────
    // Métrica primaria = cash ROAS month-to-date (matchea panel Demeter en tab "Este Mes").
    // Métrica secundaria = cash ROAS últimos 7d (indicador de tendencia reciente).
    const demeterCount = demeter?.count || 0;
    const demeterRoasMtd = demeter?.avg_cash_roas;
    const demeterRoas7d = demeter?.roas_7d;
    const demeterStatus = demeterCount > 0 ? 'running' : 'idle';

    let demeterMetric, demeterMetricLabel;
    if (demeterRoasMtd != null && demeterRoasMtd > 0) {
      demeterMetric = `${demeterRoasMtd.toFixed(2)}x`;
      // Sub muestra mes en curso + tendencia 7d con arrow si difiere ≥0.1x
      const monthAbbr = new Date().toLocaleString('es', { month: 'short' }).replace('.', '');
      if (demeterRoas7d != null && demeterRoas7d > 0) {
        const delta = demeterRoas7d - demeterRoasMtd;
        const arrow = Math.abs(delta) < 0.1 ? '·' : (delta > 0 ? '↑' : '↓');
        demeterMetricLabel = `${monthAbbr} mtd · ${arrow} ${demeterRoas7d.toFixed(2)}x 7d`;
      } else {
        demeterMetricLabel = `${monthAbbr} mtd · cash roas`;
      }
    } else {
      demeterMetric = `${demeterCount}`;
      demeterMetricLabel = 'snapshots';
    }

    nodes.push({
      id: 'demeter', group: 'demeter', tier: 1, size: 13,
      label: 'DEMETER', sub: 'Cash Recon',
      metric: demeterMetric, metricLabel: demeterMetricLabel,
      status: demeterStatus,
      color: AGENT_COLORS.demeter, icon: AGENT_ICONS.demeter
    });

    // ─── PLANNED AGENTS (coming soon — ghosted) ───────────────────────────
    const plannedAgents = [
      { id: 'hermes', label: 'HERMES', sub: 'Comms · Slack', color: AGENT_COLORS.hermes, icon: AGENT_ICONS.hermes },
      { id: 'artemis', label: 'ARTEMIS', sub: 'Audiences · LAL', color: AGENT_COLORS.artemis, icon: AGENT_ICONS.artemis },
      { id: 'hefesto', label: 'HEFESTO', sub: 'Infra · Deploys', color: AGENT_COLORS.hefesto, icon: AGENT_ICONS.hefesto }
    ];
    plannedAgents.forEach(a => {
      nodes.push({
        id: a.id, group: 'planned', tier: 1, size: 11,
        label: a.label, sub: a.sub, color: a.color, icon: a.icon,
        planned: true, status: 'planned'
      });
    });

    // ─── PLANNED SUB-FEATURES (future extensions) ────────────────────────
    const plannedFeatures = [
      { id: 'video-pipeline', parent: 'apollo', label: 'Video', sub: 'pipeline', icon: AGENT_ICONS.video, color: AGENT_COLORS.apollo },
      { id: 'audio-pipeline', parent: 'apollo', label: 'Audio', sub: 'pipeline', icon: AGENT_ICONS.audio, color: AGENT_COLORS.apollo },
      { id: 'crossplatform', parent: 'ares', label: 'TikTok', sub: '+ Google', icon: AGENT_ICONS.crossplatform, color: AGENT_COLORS.ares },
      { id: 'memory-db', parent: 'zeus', label: 'Memory', sub: 'Vector DB', icon: AGENT_ICONS.memory, color: AGENT_COLORS.zeus }
    ];
    plannedFeatures.forEach(f => {
      nodes.push({
        id: f.id, group: 'planned-feature', tier: 2, size: 7,
        label: f.label, sub: f.sub, color: f.color, icon: f.icon,
        planned: true, status: 'planned', parent: f.parent
      });
    });

    // ─── Links ────────────────────────────────────────────────────────────
    const links = [
      { source: 'zeus', target: 'athena', kind: 'primary', active: athenaOps > 0 },
      { source: 'zeus', target: 'apollo', kind: 'primary', active: apolloPool > 0 },
      { source: 'zeus', target: 'prometheus', kind: 'primary', active: prometheusTests > 0 },
      { source: 'zeus', target: 'ares', kind: 'primary', active: aresOps > 0 },

      // Cross-agent (workflows: apollo feeds prometheus, prometheus feeds ares)
      { source: 'apollo', target: 'prometheus', kind: 'workflow', active: apolloPool > 0 },
      { source: 'prometheus', target: 'ares', kind: 'workflow', active: prometheusTests > 0 },

      // Demeter — agente activo (cash reconciliation)
      { source: 'zeus', target: 'demeter', kind: 'primary', active: demeterCount > 0 },
      { source: 'athena', target: 'demeter', kind: 'workflow', active: demeterCount > 0 },
      { source: 'ares', target: 'demeter', kind: 'workflow', active: demeterCount > 0 }
    ];

    // Planned agent links — Zeus como hub también de los futuros
    plannedAgents.forEach(a => {
      links.push({ source: 'zeus', target: a.id, kind: 'primary', planned: true });
    });
    // Cross-agent planned workflows (Hermes recibe signals de todos, Artemis informa Apollo)
    links.push({ source: 'artemis', target: 'apollo', kind: 'workflow', planned: true });

    // Satellite links
    for (let i = 0; i < nDirs; i++) links.push({ source: 'zeus', target: `dir-${i}`, kind: 'satellite' });
    links.push({ source: 'apollo', target: 'apollo-pool', kind: 'satellite' });
    for (let i = 0; i < nTests; i++) links.push({ source: 'prometheus', target: `test-${i}`, kind: 'satellite' });
    cboList.forEach(c => links.push({ source: 'ares', target: c.id, kind: 'satellite', active: c.id === 'cbo-dup' }));

    // Planned feature links
    plannedFeatures.forEach(f => {
      links.push({ source: f.parent, target: f.id, kind: 'satellite', planned: true });
    });

    // Index neighbors para highlight
    const neighborIndex = {};
    const linksIndex = {};
    links.forEach(l => {
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      neighborIndex[s] = neighborIndex[s] || new Set();
      neighborIndex[t] = neighborIndex[t] || new Set();
      neighborIndex[s].add(t);
      neighborIndex[t].add(s);
      linksIndex[s] = linksIndex[s] || new Set();
      linksIndex[t] = linksIndex[t] || new Set();
      linksIndex[s].add(l);
      linksIndex[t].add(l);
    });
    // Arrays no Sets — Sets pueden romper cuando react-force-graph
    // hace operaciones internas sobre los nodes (copy, serialize)
    nodes.forEach(n => {
      n.neighbors = Array.from(neighborIndex[n.id] || []);
      n.linkset = Array.from(linksIndex[n.id] || []);
    });

    return { nodes, links };
  }, [status, demeter]);

  // Configurar physics forces vía ref (API de react-force-graph)
  // NO es una prop del componente — debe llamarse post-mount
  useEffect(() => {
    if (!fgRef.current || graphData.nodes.length === 0) return;
    try {
      const fg = fgRef.current;
      fg.d3Force('charge')?.strength((n) =>
        n.tier === 0 ? -900 : n.tier === 1 ? -600 : -120
      );
      fg.d3Force('link')?.distance((l) => {
        if (l.kind === 'primary') return 180;
        if (l.kind === 'workflow') return 200;
        return 45;
      });
    } catch (err) {
      console.warn('[NeuralGraphView] d3Force config failed:', err);
    }
  }, [graphData.nodes.length]);

  // Auto-zoom via onEngineStop — corre cuando la simulación converge
  const handleEngineStop = useCallback(() => {
    if (!hasInitialZoom && fgRef.current) {
      try {
        fgRef.current.zoomToFit(400, 120);  // más padding (120 vs 60)
        setHasInitialZoom(true);
      } catch (_) {}
    }
  }, [hasInitialZoom]);

  // ─── Custom node rendering con glow radial ──────────────────────────────
  const drawNode = useCallback((node, ctx, globalScale) => {
    // Guard: al inicio antes que la simulación asigne posiciones,
    // x/y pueden ser undefined o NaN
    if (!node || typeof node.x !== 'number' || typeof node.y !== 'number' ||
        !isFinite(node.x) || !isFinite(node.y)) return;

    const { x, y, size = 8, color = '#94a3b8', icon, label, sub, status, tier = 2, planned } = node;
    const isHover = hoverNode === node || hoverNeighbors.has(node.id);
    const isFaded = hoverNode && !isHover;
    // Planned nodes SIEMPRE a 45% opacidad (más atenuados aún si están faded)
    const opacity = planned ? (isFaded ? 0.18 : 0.5) : (isFaded ? 0.25 : 1);

    // Glow radial — para planned es más tenue
    const glowR = size * 3;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, glowR);
    const baseAlphaRaw = isHover ? 0.55 : (tier === 0 ? 0.45 : (tier === 1 ? 0.35 : 0.18));
    const baseAlpha = planned ? baseAlphaRaw * 0.35 : baseAlphaRaw;
    gradient.addColorStop(0, hexToRgba(color, baseAlpha * opacity));
    gradient.addColorStop(0.5, hexToRgba(color, baseAlpha * 0.4 * opacity));
    gradient.addColorStop(1, hexToRgba(color, 0));
    ctx.beginPath();
    ctx.arc(x, y, glowR, 0, 2 * Math.PI);
    ctx.fillStyle = gradient;
    ctx.fill();

    // Core — planned es hueco con dashed outline (estilo wireframe)
    if (planned) {
      ctx.beginPath();
      ctx.arc(x, y, size, 0, 2 * Math.PI);
      ctx.fillStyle = hexToRgba(color, 0.08 * opacity);  // fill tenue
      ctx.fill();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = hexToRgba(color, 0.7 * opacity);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      // Normal: gradient fill sólido
      ctx.beginPath();
      ctx.arc(x, y, size, 0, 2 * Math.PI);
      const coreGrad = ctx.createRadialGradient(x - size * 0.3, y - size * 0.3, 0, x, y, size);
      coreGrad.addColorStop(0, hexToRgba(lightenColor(color, 30), opacity));
      coreGrad.addColorStop(1, hexToRgba(color, opacity));
      ctx.fillStyle = coreGrad;
      ctx.fill();

      const border = isHover
        ? '#ffffff'
        : status === 'running'
          ? lightenColor(color, 40)
          : status === 'paused'
            ? hexToRgba(color, 0.4 * opacity)
            : hexToRgba(color, 0.7 * opacity);
      ctx.strokeStyle = border;
      ctx.lineWidth = isHover ? 2.5 : (tier === 0 ? 2 : 1.2);
      ctx.stroke();
    }

    // Icon/emoji dentro del nodo
    if (icon) {
      const fontSize = tier === 0 ? 16 : tier === 1 ? 13 : 8;
      ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = `rgba(255,255,255,${opacity})`;
      ctx.fillText(icon, x, y);
    }

    // Label debajo (solo tier 0 y 1 siempre, tier 2 solo en hover)
    if (label && (tier < 2 || isHover)) {
      const lblSize = Math.max(tier === 0 ? 13 : tier === 1 ? 11 : 9, 8 / globalScale * (tier === 0 ? 13 : 11));
      const fixedSize = tier === 0 ? 13 : tier === 1 ? 11 : 9;
      ctx.font = `${tier === 0 ? 'bold ' : ''}${fixedSize}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = `rgba(226, 232, 240, ${opacity})`;
      ctx.fillText(label, x, y + size + 4);

      if (sub) {
        ctx.font = `${Math.max(fixedSize - 3, 7)}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
        ctx.fillStyle = `rgba(148, 163, 184, ${opacity})`;
        ctx.fillText(sub, x, y + size + 4 + fixedSize + 2);
      }

      // Metric badge (solo tier 1 core agents)
      if (tier === 1 && node.metric !== undefined) {
        const metricY = y + size + 4 + fixedSize + (sub ? 18 : 2);
        ctx.font = `bold 11px JetBrains Mono, ui-monospace, monospace`;
        ctx.fillStyle = hexToRgba(color, opacity);
        ctx.fillText(node.metric, x, metricY);
        if (node.metricLabel) {
          ctx.font = `7px -apple-system, system-ui, sans-serif`;
          ctx.fillStyle = `rgba(100, 116, 139, ${opacity})`;
          ctx.fillText(node.metricLabel.toUpperCase(), x, metricY + 12);
        }
      }

      // Status dot pequeño (running/idle/paused) para core. Planned = dashed
      if (tier <= 1 && status) {
        const statusColor = status === 'running' ? '#34d399'
          : status === 'paused' ? '#fbbf24'
          : status === 'planned' ? hexToRgba(color, 0.8)
          : '#64748b';
        ctx.beginPath();
        ctx.arc(x + size - 2, y - size + 2, 2.5, 0, 2 * Math.PI);
        ctx.fillStyle = statusColor;
        ctx.fill();
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.8)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Badge "soon" debajo de planned agents (tier 1 solamente)
      if (planned && tier === 1) {
        const badgeY = y + size + 4 + 11 + (sub ? 12 : 0) + 8;
        const badgeText = 'SOON';
        ctx.font = `bold 7px JetBrains Mono, ui-monospace, monospace`;
        const bw = ctx.measureText(badgeText).width + 8;
        const bh = 10;
        ctx.fillStyle = hexToRgba(color, 0.15 * opacity);
        ctx.strokeStyle = hexToRgba(color, 0.5 * opacity);
        ctx.lineWidth = 0.8;
        roundRect(ctx, x - bw / 2, badgeY, bw, bh, 3);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = hexToRgba(color, opacity);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(badgeText, x, badgeY + bh / 2 + 0.5);
      }
    }
  }, [hoverNode, hoverNeighbors]);

  // Pointer area igual al glow expandido — click tolerance mayor
  const drawPointerArea = useCallback((node, color, ctx) => {
    const { x, y, size = 8 } = node;
    ctx.beginPath();
    ctx.arc(x, y, size + 6, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  }, []);

  // Link rendering
  const linkColor = useCallback((link) => {
    const src = typeof link.source === 'object' ? link.source : null;
    const tgt = typeof link.target === 'object' ? link.target : null;
    if (!src || !tgt) return 'rgba(148, 163, 184, 0.2)';

    const isHover = hoverLinks.has(link);
    const isFaded = hoverNode && !isHover && !(
      (hoverNeighbors.has(src.id) && hoverNeighbors.has(tgt.id)) ||
      src === hoverNode || tgt === hoverNode
    );

    const baseColor = src.color || '#94a3b8';
    if (isFaded) return hexToRgba(baseColor, 0.08);
    if (isHover) return hexToRgba(baseColor, 0.9);

    // Planned links — más tenues siempre
    if (link.planned) {
      const plannedAlpha = link.kind === 'primary' ? 0.22 : 0.15;
      return hexToRgba(baseColor, plannedAlpha);
    }
    const kindAlpha = link.kind === 'primary' ? 0.5 : link.kind === 'workflow' ? 0.3 : 0.15;
    return hexToRgba(baseColor, kindAlpha);
  }, [hoverLinks, hoverNode, hoverNeighbors]);

  // Render custom para links — nos permite dashed en planned
  const drawLink = useCallback((link, ctx) => {
    const src = typeof link.source === 'object' ? link.source : null;
    const tgt = typeof link.target === 'object' ? link.target : null;
    if (!src || !tgt || typeof src.x !== 'number' || typeof tgt.x !== 'number') return;

    const color = linkColor(link);
    const width = hoverLinks.has(link) ? 2.5
      : link.planned ? 0.8
      : link.kind === 'primary' ? 1.2
      : link.kind === 'workflow' ? 0.8
      : 0.5;

    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (link.planned) ctx.setLineDash([4, 4]);

    if (link.kind === 'workflow') {
      // Curvar links workflow levemente
      const mx = (src.x + tgt.x) / 2;
      const my = (src.y + tgt.y) / 2;
      const dx = tgt.x - src.x;
      const dy = tgt.y - src.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const nx = -dy / dist;
      const ny = dx / dist;
      const cx = mx + nx * dist * 0.18;
      const cy = my + ny * dist * 0.18;
      ctx.beginPath();
      ctx.moveTo(src.x, src.y);
      ctx.quadraticCurveTo(cx, cy, tgt.x, tgt.y);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(src.x, src.y);
      ctx.lineTo(tgt.x, tgt.y);
      ctx.stroke();
    }
    if (link.planned) ctx.setLineDash([]);
  }, [linkColor, hoverLinks]);

  const handleHover = useCallback((node) => {
    const neighbors = new Set();
    const links = new Set();
    if (node) {
      neighbors.add(node.id);
      node.neighbors?.forEach(n => neighbors.add(n));
      node.linkset?.forEach(l => links.add(l));
    }
    setHoverNode(node || null);
    setHoverNeighbors(neighbors);
    setHoverLinks(links);
  }, []);

  const handleClick = useCallback((node) => {
    if (!node) return;
    if (onAgentClick && ['zeus', 'athena', 'apollo', 'prometheus', 'ares', 'demeter'].includes(node.id)) {
      onAgentClick(node.id);
    }
  }, [onAgentClick]);

  return (
    <div ref={containerRef} className="neural-graph-canvas" style={{ position: 'relative', width: '100%', height: '100%', background: 'radial-gradient(ellipse at center, #0b1120 0%, #050816 70%)' }}>
      <ForceGraph2D
        ref={fgRef}
        graphData={graphData}
        width={dims.width}
        height={dims.height}
        backgroundColor="rgba(0,0,0,0)"
        nodeCanvasObject={drawNode}
        nodePointerAreaPaint={drawPointerArea}
        nodeRelSize={1}
        linkCanvasObjectMode={() => 'replace'}
        linkCanvasObject={drawLink}
        linkDirectionalParticles={(link) => (link.active && !link.planned) ? 3 : 0}
        linkDirectionalParticleSpeed={() => 0.008}
        linkDirectionalParticleWidth={(link) => hoverLinks.has(link) ? 3 : 2}
        linkDirectionalParticleColor={(link) => {
          const src = typeof link.source === 'object' ? link.source : null;
          return src?.color || '#60a5fa';
        }}
        onNodeHover={handleHover}
        onNodeClick={handleClick}
        cooldownTicks={120}
        d3AlphaDecay={0.025}
        d3VelocityDecay={0.35}
        onEngineStop={handleEngineStop}
        enableNodeDrag
        enableZoomInteraction
        enablePanInteraction
        minZoom={0.5}
        maxZoom={4}
      />

      {/* HUD overlay — hint + stats live */}
      <div style={{ position: 'absolute', bottom: 12, left: 16, pointerEvents: 'none', fontSize: '0.68rem', color: 'rgba(148, 163, 184, 0.55)', fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.05em' }}>
        drag · zoom · hover · click
      </div>
      {hoverNode && (
        <div style={{
          position: 'absolute', top: 16, right: 16, pointerEvents: 'none',
          background: 'rgba(11, 17, 32, 0.92)', border: `1px solid ${hexToRgba(hoverNode.color, 0.4)}`,
          borderRadius: 8, padding: '10px 14px', fontSize: '0.78rem', color: '#e2e8f0',
          fontFamily: '-apple-system, system-ui, sans-serif', maxWidth: 260,
          backdropFilter: 'blur(8px)', boxShadow: `0 0 24px ${hexToRgba(hoverNode.color, 0.15)}`
        }}>
          <div style={{ fontWeight: 600, color: hoverNode.color, letterSpacing: '0.02em', display: 'flex', alignItems: 'center', gap: 6 }}>
            {hoverNode.label || hoverNode.id}
            {hoverNode.planned && (
              <span style={{ fontSize: '0.55rem', padding: '2px 6px', borderRadius: 3, background: hexToRgba(hoverNode.color, 0.15), border: `1px solid ${hexToRgba(hoverNode.color, 0.35)}`, letterSpacing: '0.1em' }}>ROADMAP</span>
            )}
          </div>
          {hoverNode.sub && <div style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: 2 }}>{hoverNode.sub}</div>}
          {hoverNode.metric !== undefined && hoverNode.metricLabel && (
            <div style={{ marginTop: 6, fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem' }}>
              <span style={{ color: hoverNode.color }}>{hoverNode.metric}</span>
              <span style={{ color: '#64748b', marginLeft: 4 }}>{hoverNode.metricLabel}</span>
            </div>
          )}
          {hoverNode.status && (
            <div style={{ marginTop: 6, fontSize: '0.65rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {hoverNode.status === 'running' ? '● running'
                : hoverNode.status === 'paused' ? '◌ paused'
                : hoverNode.status === 'planned' ? '◇ coming soon'
                : '○ idle'}
            </div>
          )}
          {hoverNode.planned && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(71, 85, 105, 0.3)', fontSize: '0.65rem', color: '#64748b', lineHeight: 1.5 }}>
              Planeado para roadmap futuro. No operativo aún.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function hexToRgba(hex, alpha = 1) {
  if (!hex) return `rgba(148, 163, 184, ${alpha})`;
  if (hex.startsWith('rgba') || hex.startsWith('rgb')) return hex;
  const h = hex.replace('#', '');
  const bigint = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function lightenColor(hex, amount = 20) {
  const h = hex.replace('#', '');
  const bigint = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  const r = Math.min(255, ((bigint >> 16) & 255) + amount);
  const g = Math.min(255, ((bigint >> 8) & 255) + amount);
  const b = Math.min(255, (bigint & 255) + amount);
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}
