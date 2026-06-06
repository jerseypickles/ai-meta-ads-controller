// Fuente única de los agentes para la vista Galaxia: orbe + panel + leyenda.
// El color sale de las variables CSS (--ag-<id>) definidas en index.css.
// angle = posición en el anillo orbital (grados, 0 = arriba, horario).

export const AGENTS = [
  { id: 'athena',     label: 'Athena',     role: 'Scaling',           icon: '🛡️', angle: 0,     awareness: false },
  { id: 'apollo',     label: 'Apollo',     role: 'Creative Generador', icon: '🎨', angle: 51.4,  awareness: false },
  { id: 'dionisio',   label: 'Dionisio',   role: 'Video Creator',     icon: '🎬', angle: 102.9, awareness: false },
  { id: 'hermes',     label: 'Hermes',     role: 'Store CEO',         icon: '🛒', angle: 154.3, awareness: true  },
  { id: 'ares',       label: 'Ares',       role: 'CBO CEO',           icon: '⚔️', angle: 205.7, awareness: false },
  { id: 'demeter',    label: 'Demeter',    role: 'Cash ROAS',         icon: '💲', angle: 257.1, awareness: false },
  { id: 'prometheus', label: 'Prometheus', role: 'Tester Ads',        icon: '🧪', angle: 308.6, awareness: false }
];

export const ZEUS = { id: 'zeus', label: 'Zeus', role: 'Cerebro', icon: '🧠' };

// Mapa id → metadata (incluye Zeus)
export const AGENT_MAP = Object.fromEntries([ZEUS, ...AGENTS].map(a => [a.id, a]));

// color CSS de un agente
export const agentColor = (id) => `var(--ag-${id})`;

// KPIs que muestra cada orbe (label + key dentro de agent.kpis del /api/overview).
// Para el slice solo Ares trae kpis reales; el resto cae a actions_today.
export const AGENT_KPIS = {
  ares:       [{ key: 'cbos_activos', label: 'CBOs' }, { key: 'spend_hoy', label: 'Spend hoy', money: true }],
  athena:     [{ key: 'actions_today', label: 'Acciones hoy' }],
  apollo:     [{ key: 'creativos_7d', label: 'Creativos 7d' }],
  prometheus: [{ key: 'tests_activos', label: 'Tests' }, { key: 'win_rate', label: 'Win rate', suffix: '%' }],
  demeter:    [{ key: 'cash_roas', label: 'Cash ROAS', suffix: 'x' }],
  dionisio:   [{ key: 'actions_today', label: 'Acciones hoy' }],
  hermes:     [{ key: 'actions_today', label: 'Publicaciones', awareness: true }]
};
