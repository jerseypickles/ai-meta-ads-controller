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
  directive: '#38bdf8'   // sky-400 — directives
};

const AGENT_ICONS = {
  zeus: '⚡', athena: '🦉', apollo: '☀️',
  prometheus: '🔥', ares: '⚔️',
  cbo: '◎', test: '⚗', directive: '▣', pool: '✦'
};

export default function NeuralGraphView({ onAgentClick }) {
  const fgRef = useRef(null);
  const containerRef = useRef(null);
  const [status, setStatus] = useState(null);
  const [hoverNode, setHoverNode] = useState(null);
  const [hoverLinks, setHoverLinks] = useState(new Set());
  const [hoverNeighbors, setHoverNeighbors] = useState(new Set());
  const [dims, setDims] = useState({ width: 800, height: 600 });
  const [hasInitialZoom, setHasInitialZoom] = useState(false);

  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 30000);
    return () => clearInterval(t);
  }, []);

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
    // Fallback mock mientras loadea — el graph nunca debe estar vacío (UX)
    const fallback = {
      zeus: { directives_24h: 23 },
      agents: { unified_agent: { actions: 41 }, ares_agent: { actions: 0 } },
      apollo: { ready_pool: 145 },
      prometheus: { active_tests: 18 },
      ares: { active_cbos: 3 }
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

    // ─── Links ────────────────────────────────────────────────────────────
    const links = [
      { source: 'zeus', target: 'athena', kind: 'primary', active: athenaOps > 0 },
      { source: 'zeus', target: 'apollo', kind: 'primary', active: apolloPool > 0 },
      { source: 'zeus', target: 'prometheus', kind: 'primary', active: prometheusTests > 0 },
      { source: 'zeus', target: 'ares', kind: 'primary', active: aresOps > 0 },

      // Cross-agent (workflows: apollo feeds prometheus, prometheus feeds ares)
      { source: 'apollo', target: 'prometheus', kind: 'workflow', active: apolloPool > 0 },
      { source: 'prometheus', target: 'ares', kind: 'workflow', active: prometheusTests > 0 }
    ];

    // Satellite links
    for (let i = 0; i < nDirs; i++) links.push({ source: 'zeus', target: `dir-${i}`, kind: 'satellite' });
    links.push({ source: 'apollo', target: 'apollo-pool', kind: 'satellite' });
    for (let i = 0; i < nTests; i++) links.push({ source: 'prometheus', target: `test-${i}`, kind: 'satellite' });
    cboList.forEach(c => links.push({ source: 'ares', target: c.id, kind: 'satellite', active: c.id === 'cbo-dup' }));

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
    nodes.forEach(n => {
      n.neighbors = neighborIndex[n.id] || new Set();
      n.linkset = linksIndex[n.id] || new Set();
    });

    return { nodes, links };
  }, [status]);

  // Auto-zoom inicial una vez que hay data
  useEffect(() => {
    if (!hasInitialZoom && graphData.nodes.length > 0 && fgRef.current) {
      const t = setTimeout(() => {
        try { fgRef.current.zoomToFit(600, 60); setHasInitialZoom(true); } catch (_) {}
      }, 500);
      return () => clearTimeout(t);
    }
  }, [graphData.nodes.length, hasInitialZoom]);

  // ─── Custom node rendering con glow radial ──────────────────────────────
  const drawNode = useCallback((node, ctx, globalScale) => {
    const { x, y, size = 8, color, icon, label, sub, status, tier } = node;
    const isHover = hoverNode === node || hoverNeighbors.has(node.id);
    const isFaded = hoverNode && !isHover;
    const opacity = isFaded ? 0.25 : 1;

    // Glow radial — el alma del look Obsidian
    const glowR = size * 3;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, glowR);
    const baseAlpha = isHover ? 0.55 : (tier === 0 ? 0.45 : (tier === 1 ? 0.35 : 0.18));
    gradient.addColorStop(0, hexToRgba(color, baseAlpha * opacity));
    gradient.addColorStop(0.5, hexToRgba(color, baseAlpha * 0.4 * opacity));
    gradient.addColorStop(1, hexToRgba(color, 0));
    ctx.beginPath();
    ctx.arc(x, y, glowR, 0, 2 * Math.PI);
    ctx.fillStyle = gradient;
    ctx.fill();

    // Core circle
    ctx.beginPath();
    ctx.arc(x, y, size, 0, 2 * Math.PI);
    const coreGrad = ctx.createRadialGradient(x - size * 0.3, y - size * 0.3, 0, x, y, size);
    coreGrad.addColorStop(0, hexToRgba(lightenColor(color, 30), opacity));
    coreGrad.addColorStop(1, hexToRgba(color, opacity));
    ctx.fillStyle = coreGrad;
    ctx.fill();

    // Border brighter si hover o status running
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

      // Status dot pequeño (running/idle/paused) para core
      if (tier <= 1 && status) {
        const statusColor = status === 'running' ? '#34d399' : status === 'paused' ? '#fbbf24' : '#64748b';
        ctx.beginPath();
        ctx.arc(x + size - 2, y - size + 2, 2.5, 0, 2 * Math.PI);
        ctx.fillStyle = statusColor;
        ctx.fill();
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.8)';
        ctx.lineWidth = 1;
        ctx.stroke();
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

    const kindAlpha = link.kind === 'primary' ? 0.5 : link.kind === 'workflow' ? 0.3 : 0.15;
    return hexToRgba(baseColor, kindAlpha);
  }, [hoverLinks, hoverNode, hoverNeighbors]);

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
    if (onAgentClick && ['zeus', 'athena', 'apollo', 'prometheus', 'ares'].includes(node.id)) {
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
        linkColor={linkColor}
        linkWidth={(link) => hoverLinks.has(link) ? 2.5 : link.kind === 'primary' ? 1.2 : link.kind === 'workflow' ? 0.8 : 0.5}
        linkDirectionalParticles={(link) => link.active ? 3 : 0}
        linkDirectionalParticleSpeed={() => 0.008}
        linkDirectionalParticleWidth={(link) => hoverLinks.has(link) ? 3 : 2}
        linkDirectionalParticleColor={(link) => {
          const src = typeof link.source === 'object' ? link.source : null;
          return src?.color || '#60a5fa';
        }}
        linkCurvature={(link) => link.kind === 'workflow' ? 0.25 : 0}
        onNodeHover={handleHover}
        onNodeClick={handleClick}
        cooldownTicks={80}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.3}
        d3Force={(engine) => {
          // Zeus al centro, agents en un ring, satellites afuera
          engine('charge')?.strength((n) => n.tier === 0 ? -450 : n.tier === 1 ? -280 : -60);
          engine('link')?.distance((l) => {
            if (l.kind === 'primary') return 110;
            if (l.kind === 'workflow') return 130;
            return 35;  // satellites pegados al parent
          });
        }}
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
          <div style={{ fontWeight: 600, color: hoverNode.color, letterSpacing: '0.02em' }}>{hoverNode.label || hoverNode.id}</div>
          {hoverNode.sub && <div style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: 2 }}>{hoverNode.sub}</div>}
          {hoverNode.metric !== undefined && hoverNode.metricLabel && (
            <div style={{ marginTop: 6, fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem' }}>
              <span style={{ color: hoverNode.color }}>{hoverNode.metric}</span>
              <span style={{ color: '#64748b', marginLeft: 4 }}>{hoverNode.metricLabel}</span>
            </div>
          )}
          {hoverNode.status && (
            <div style={{ marginTop: 6, fontSize: '0.65rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {hoverNode.status === 'running' ? '● running' : hoverNode.status === 'paused' ? '◌ paused' : '○ idle'}
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

function lightenColor(hex, amount = 20) {
  const h = hex.replace('#', '');
  const bigint = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  const r = Math.min(255, ((bigint >> 16) & 255) + amount);
  const g = Math.min(255, ((bigint >> 8) & 255) + amount);
  const b = Math.min(255, (bigint & 255) + amount);
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}
