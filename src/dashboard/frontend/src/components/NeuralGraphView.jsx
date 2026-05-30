import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import * as THREE from 'three';
import api from '../api';

// ═══════════════════════════════════════════════════════════════════════════
// NEURAL GRAPH VIEW — 3D deep-space style
// Three.js force simulation. Nodos = esferas con glow emisivo + bloom,
// links 3D con partículas de flujo, cámara orbital con auto-rotación sutil.
// ═══════════════════════════════════════════════════════════════════════════

const AGENT_COLORS = {
  zeus: '#60a5fa',       // blue-400 — CEO
  athena: '#34d399',     // emerald-400 — Account
  apollo: '#fbbf24',     // amber-400 — Creator
  prometheus: '#f87171', // red-400 — Testing
  ares: '#a78bfa',       // violet-400 — Portfolio
  hermes: '#f59e0b',      // amber-500 — Foot traffic NJ store
  demeter: '#14b8a6',    // teal-500 — Cash reconciliation
  dionysus: '#c026d3',   // fuchsia-600 — Video (vino/teatro)
  satellite: '#94a3b8',  // slate-400 — sub-nodes
  cbo: '#c084fc',        // purple-400 — CBOs (Ares children)
  directive: '#38bdf8',  // sky-400 — directives

  // ─── Planned / coming soon ───
  artemis: '#ec4899',    // pink-500 — Audiences (lookalike, custom)
  hefesto: '#f97316',    // orange-500 — Platform Eng (infra, deploys)
  planned: '#475569'     // slate-600 — fallback para planned features
};

const AGENT_ICONS = {
  zeus: '⚡', athena: '🦉', apollo: '☀️',
  prometheus: '🔥', ares: '⚔️',
  hermes: '🏪', demeter: '✿', dionysus: '🎭',
  cbo: '◎', test: '⚗', directive: '▣', pool: '✦',

  // Planned
  artemis: '☽', hefesto: '⚒',
  video: '▶', audio: '♪', crossplatform: '⊛', memory: '◈'
};

export default function NeuralGraphView({ onAgentClick }) {
  const fgRef = useRef(null);
  const containerRef = useRef(null);
  const [status, setStatus] = useState(null);
  const [demeter, setDemeter] = useState(null);
  const [hermes, setHermes] = useState(null);
  const [hoverNode, setHoverNode] = useState(null);
  const [dims, setDims] = useState({ width: 800, height: 600 });
  const [hasInitialZoom, setHasInitialZoom] = useState(false);

  useEffect(() => {
    loadStatus();
    loadDemeter();
    loadHermes();
    const t = setInterval(() => { loadStatus(); loadDemeter(); loadHermes(); }, 30000);
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

  async function loadHermes() {
    try {
      const res = await api.get('/api/hermes/stats?days=30');
      setHermes(res.data);
    } catch {
      setHermes({ photos: { total: 0 }, proposals: { pending: 0 }, visits: { by_offer: [] }, config: { enabled: false }, error: true });
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
        id: 'dionysus', group: 'dionysus', tier: 1, size: 12,
        label: 'DIONISIO', sub: 'Video',
        status: 'idle',
        color: AGENT_COLORS.dionysus, icon: AGENT_ICONS.dionysus
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

    // ─── HERMES — agente activo (foot traffic NJ store) ───────────────────
    // Métrica primaria: pending approvals (lo accionable) → visits 30d → fotos
    const hermesEnabled = hermes?.config?.enabled || false;
    const hermesPending = hermes?.proposals?.pending || 0;
    const hermesPhotos = hermes?.photos?.active || 0;
    const hermesVisits = (hermes?.visits?.by_offer || []).reduce((s, o) => s + (o.count || 0), 0);

    let hermesMetric, hermesMetricLabel, hermesStatus;
    if (!hermesEnabled) {
      hermesMetric = '○';
      hermesMetricLabel = 'disabled';
      hermesStatus = 'paused';
    } else if (hermesPending > 0) {
      hermesMetric = `${hermesPending}`;
      hermesMetricLabel = 'pending approval';
      hermesStatus = 'running';
    } else if (hermesVisits > 0) {
      hermesMetric = `${hermesVisits}`;
      hermesMetricLabel = 'visits 30d';
      hermesStatus = 'running';
    } else {
      hermesMetric = `${hermesPhotos}`;
      hermesMetricLabel = hermesPhotos > 0 ? 'fotos en banco' : 'sin fotos';
      hermesStatus = 'idle';
    }

    nodes.push({
      id: 'hermes', group: 'hermes', tier: 1, size: 13,
      label: 'HERMES', sub: 'NJ Store',
      metric: hermesMetric, metricLabel: hermesMetricLabel,
      status: hermesStatus,
      color: AGENT_COLORS.hermes, icon: AGENT_ICONS.hermes
    });

    // ─── PLANNED AGENTS (coming soon — ghosted) ───────────────────────────
    const plannedAgents = [
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
      // 'Video' ya no es placeholder de Apollo — es Dionisio (agente real). Ver nodos tier-1.
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
      // Dionisio (video): Zeus lo coordina; Apollo le pasa winners; sus videos van a Prometheus.
      { source: 'zeus', target: 'dionysus', kind: 'primary', active: false },
      { source: 'apollo', target: 'dionysus', kind: 'workflow', active: apolloPool > 0 },
      { source: 'dionysus', target: 'prometheus', kind: 'workflow', active: false },

      // Demeter — agente activo (cash reconciliation)
      { source: 'zeus', target: 'demeter', kind: 'primary', active: demeterCount > 0 },
      { source: 'athena', target: 'demeter', kind: 'workflow', active: demeterCount > 0 },
      { source: 'ares', target: 'demeter', kind: 'workflow', active: demeterCount > 0 },

      // Hermes — agente activo (foot traffic NJ store, separado del flujo online)
      { source: 'zeus', target: 'hermes', kind: 'primary', active: hermesEnabled }
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

    // Index neighbors para tooltip
    const neighborIndex = {};
    links.forEach(l => {
      const s2 = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      neighborIndex[s2] = neighborIndex[s2] || new Set();
      neighborIndex[t] = neighborIndex[t] || new Set();
      neighborIndex[s2].add(t);
      neighborIndex[t].add(s2);
    });
    nodes.forEach(n => {
      n.neighbors = Array.from(neighborIndex[n.id] || []);
    });

    return { nodes, links };
  }, [status, demeter, hermes]);

  // Configurar physics forces vía ref (API de react-force-graph) — post-mount
  useEffect(() => {
    if (!fgRef.current || graphData.nodes.length === 0) return;
    try {
      const fg = fgRef.current;
      fg.d3Force('charge')?.strength((n) =>
        n.tier === 0 ? -1400 : n.tier === 1 ? -900 : -180
      );
      fg.d3Force('link')?.distance((l) => {
        if (l.kind === 'primary') return 190;
        if (l.kind === 'workflow') return 210;
        return 50;
      });
    } catch (err) {
      console.warn('[NeuralGraphView] d3Force config failed:', err);
    }
  }, [graphData.nodes.length]);

  // Cámara orbital con auto-rotación sutil (sin bloom postprocessing —
  // el glow de los nodos lo dan los sprites additive, no un pass global
  // que lavaba el render entero a blanco)
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const id = setTimeout(() => {
      try {
        const ctrl = fg.controls?.();
        if (ctrl) {
          ctrl.autoRotate = true;
          ctrl.autoRotateSpeed = 0.3;
        }
      } catch (_) {}
    }, 500);
    return () => clearTimeout(id);
  }, []);

  // Auto-encuadre cuando la simulación converge
  const handleEngineStop = useCallback(() => {
    if (!hasInitialZoom && fgRef.current) {
      try {
        fgRef.current.zoomToFit(700, 55);
        setHasInitialZoom(true);
      } catch (_) {}
    }
  }, [hasInitialZoom]);

  // ─── 3D node object — esfera emisiva + glow + label sprite ──────────────
  const buildNodeObject = useCallback((node) => {
    const group = new THREE.Group();
    const color = node.color || '#94a3b8';
    const size = node.size || 6;
    const planned = node.planned;

    // Core sphere
    const geo = new THREE.SphereGeometry(size, planned ? 14 : 28, planned ? 14 : 28);
    let mat;
    if (planned) {
      mat = new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.42 });
    } else {
      mat = new THREE.MeshLambertMaterial({
        color,
        emissive: new THREE.Color(color),
        emissiveIntensity: node.tier === 0 ? 0.5 : node.tier === 1 ? 0.4 : 0.32
      });
    }
    const sphere = new THREE.Mesh(geo, mat);
    group.add(sphere);

    // Glow halo (sprite con textura radial, additive)
    const glowMat = new THREE.SpriteMaterial({
      map: glowTexture(),
      color,
      transparent: true,
      opacity: planned ? 0.16 : (node.tier === 0 ? 0.5 : node.tier === 1 ? 0.4 : 0.28),
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const glow = new THREE.Sprite(glowMat);
    const gs = size * (node.tier === 0 ? 4.6 : node.tier === 1 ? 4 : 3.2);
    glow.scale.set(gs, gs, 1);
    glow.raycast = () => {};
    group.add(glow);

    // Icon — sprite siempre de frente, sobre la esfera
    if (node.icon) {
      const icon = makeIconSprite(node.icon);
      const is = size * 1.5;
      icon.scale.set(is, is, 1);
      group.add(icon);
    }

    // Label — tier 0/1 siempre, tier 2 solo si tiene label real
    if (node.label && (node.tier < 2 || node.label.trim())) {
      const label = makeLabelSprite(node);
      label.position.set(0, -(size + (node.tier === 0 ? 16 : node.tier === 1 ? 13 : 9)), 0);
      group.add(label);
    }

    return group;
  }, []);

  const handleHover = useCallback((node) => {
    setHoverNode(node || null);
  }, []);

  const handleClick = useCallback((node) => {
    if (!node) return;
    if (onAgentClick && ['zeus', 'athena', 'apollo', 'prometheus', 'ares', 'demeter', 'hermes'].includes(node.id)) {
      onAgentClick(node.id);
    }
  }, [onAgentClick]);

  return (
    <div ref={containerRef} className="neural-graph-canvas" style={{ position: 'relative', width: '100%', height: '100%' }}>
      <ForceGraph3D
        ref={fgRef}
        graphData={graphData}
        width={dims.width}
        height={dims.height}
        backgroundColor="#04060f"
        showNavInfo={false}
        controlType="orbit"
        nodeThreeObject={buildNodeObject}
        nodeThreeObjectExtend={false}
        linkColor={(link) => {
          const src = typeof link.source === 'object' ? link.source : null;
          const base = src?.color || '#94a3b8';
          if (link.planned) return hexToRgba(base, 0.16);
          const alpha = link.kind === 'primary' ? 0.5 : link.kind === 'workflow' ? 0.32 : 0.16;
          return hexToRgba(base, alpha);
        }}
        linkWidth={(link) => link.planned ? 0 : link.kind === 'primary' ? 1.1 : link.kind === 'workflow' ? 0.6 : 0}
        linkOpacity={0.55}
        linkResolution={4}
        linkDirectionalParticles={(link) => (link.active && !link.planned) ? 4 : 0}
        linkDirectionalParticleSpeed={() => 0.006}
        linkDirectionalParticleWidth={2.2}
        linkDirectionalParticleColor={(link) => {
          const src = typeof link.source === 'object' ? link.source : null;
          return src?.color || '#60a5fa';
        }}
        onNodeHover={handleHover}
        onNodeClick={handleClick}
        onEngineStop={handleEngineStop}
        cooldownTicks={140}
        d3AlphaDecay={0.022}
        d3VelocityDecay={0.38}
        enableNodeDrag
      />

      {/* HUD overlay — hint + tooltip */}
      <div style={{ position: 'absolute', bottom: 12, left: 16, pointerEvents: 'none', fontSize: '0.68rem', color: 'rgba(148, 163, 184, 0.55)', fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.05em' }}>
        orbita · zoom · hover · click
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

// ─── Three.js helpers ───────────────────────────────────────────────────────

// Textura radial reutilizable para el glow de los nodos
let _glowTex = null;
function glowTexture() {
  if (_glowTex) return _glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,0.8)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.3)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  _glowTex = new THREE.CanvasTexture(c);
  return _glowTex;
}

function makeIconSprite(icon) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.font = '84px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(icon, 64, 70);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 12;
  sprite.raycast = () => {};
  return sprite;
}

function makeLabelSprite(node) {
  const W = 512, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.textAlign = 'center';

  const labelSize = node.tier === 0 ? 60 : node.tier === 1 ? 50 : 40;
  ctx.font = `bold ${labelSize}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
  ctx.fillStyle = '#e2e8f0';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 8;
  ctx.fillText(node.label, W / 2, labelSize + 6);

  let y = labelSize + 14;
  if (node.sub) {
    const subSize = Math.max(labelSize - 16, 26);
    y += subSize + 6;
    ctx.font = `${subSize}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(node.sub, W / 2, y);
  }

  if (node.tier === 1 && node.metric !== undefined) {
    y += 50;
    ctx.font = 'bold 44px JetBrains Mono, ui-monospace, monospace';
    ctx.fillStyle = node.color || '#e2e8f0';
    ctx.fillText(node.metric, W / 2, y);
    if (node.metricLabel) {
      y += 30;
      ctx.font = '24px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.fillStyle = '#64748b';
      ctx.fillText(node.metricLabel.toUpperCase(), W / 2, y);
    }
  }

  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 11;
  sprite.raycast = () => {};
  const scale = node.tier === 0 ? 64 : node.tier === 1 ? 56 : 40;
  sprite.scale.set(scale, scale * (H / W), 1);
  return sprite;
}

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
