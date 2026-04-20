/**
 * Zeus Oracle Tools — 9 tools read-only que Claude puede invocar para consultar
 * la base de datos durante una conversación con el creador.
 */
const MetricSnapshot = require('../../db/models/MetricSnapshot');
const TestRun = require('../../db/models/TestRun');
const CreativeDNA = require('../../db/models/CreativeDNA');
const CreativeProposal = require('../../db/models/CreativeProposal');
const ActionLog = require('../../db/models/ActionLog');
const ZeusDirective = require('../../db/models/ZeusDirective');
const ZeusConversation = require('../../db/models/ZeusConversation');
const BrainInsight = require('../../db/models/BrainInsight');
const BrainMemory = require('../../db/models/BrainMemory');
const BrainRecommendation = require('../../db/models/BrainRecommendation');
const SafetyEvent = require('../../db/models/SafetyEvent');
const AICreation = require('../../db/models/AICreation');
const ProductBank = require('../../db/models/ProductBank');
const StrategicDirective = require('../../db/models/StrategicDirective');
const SystemConfig = require('../../db/models/SystemConfig');
const ZeusCodeRecommendation = require('../../db/models/ZeusCodeRecommendation');
const ZeusPreference = require('../../db/models/ZeusPreference');
const ZeusWatcher = require('../../db/models/ZeusWatcher');
const { getLatestSnapshots, getSnapshotHistory, getOverviewHistory } = require('../../db/queries');

// ═══════════════════════════════════════════════════════════════════════════
// Tool definitions (Anthropic format)
// ═══════════════════════════════════════════════════════════════════════════

const TOOL_DEFINITIONS = [
  {
    name: 'query_portfolio',
    description: 'Devuelve un snapshot agregado del portfolio: spend/revenue/ROAS/CPA últimos 1d/3d/7d/14d + conteo de ad sets activos por campaña.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'query_adsets',
    description: 'Lista ad sets filtrados por rango de ROAS, spend mínimo, o nombre. Devuelve métricas 7d + status.',
    input_schema: {
      type: 'object',
      properties: {
        min_roas: { type: 'number', description: 'ROAS mínimo 7d' },
        max_roas: { type: 'number', description: 'ROAS máximo 7d' },
        min_spend_7d: { type: 'number', description: 'Spend mínimo últimos 7 días' },
        name_contains: { type: 'string', description: 'Substring en el nombre (case-insensitive)' },
        sort_by: { type: 'string', enum: ['roas', 'spend', 'purchases', 'frequency'], default: 'roas' },
        limit: { type: 'number', default: 20, description: 'Máximo 50' }
      },
      required: []
    }
  },
  {
    name: 'query_tests',
    description: 'Lista TestRuns de Prometheus por fase (learning/evaluating/graduated/killed/expired). Incluye métricas y assessments.',
    input_schema: {
      type: 'object',
      properties: {
        phase: { type: 'string', enum: ['learning', 'evaluating', 'graduated', 'killed', 'expired', 'active'] },
        limit: { type: 'number', default: 15 }
      },
      required: []
    }
  },
  {
    name: 'query_dnas',
    description: 'Top DNAs de Apollo ordenados por fitness (ROAS × confidence × recency). Muestra qué combos creativos ganan.',
    input_schema: {
      type: 'object',
      properties: {
        min_samples: { type: 'number', default: 2, description: 'Mínimo de tests por DNA' },
        sort_by: { type: 'string', enum: ['roas', 'score', 'win_rate', 'generation'], default: 'score' },
        limit: { type: 'number', default: 10 }
      },
      required: []
    }
  },
  {
    name: 'query_actions',
    description: 'ActionLog: acciones ejecutadas por los agentes (pause, scale_up, duplicate_adset, etc.) con impacto medido.',
    input_schema: {
      type: 'object',
      properties: {
        agent_type: { type: 'string', enum: ['account_agent', 'ares_agent', 'creative_agent', 'testing_agent', 'any'], default: 'any' },
        action: { type: 'string', description: 'Tipo específico de acción' },
        hours_back: { type: 'number', default: 48, description: 'Ventana temporal' },
        limit: { type: 'number', default: 15 }
      },
      required: []
    }
  },
  {
    name: 'query_directives',
    description: 'Directivas activas de Zeus (prioritize/avoid/tune) con confidence y scope.',
    input_schema: {
      type: 'object',
      properties: {
        active_only: { type: 'boolean', default: true }
      },
      required: []
    }
  },
  {
    name: 'query_insights',
    description: 'BrainInsights recientes: observaciones del análisis continuo (brain_thinking, anomaly, opportunity, pattern).',
    input_schema: {
      type: 'object',
      properties: {
        insight_type: { type: 'string', description: 'Filtrar por tipo (brain_thinking, hypothesis, anomaly, etc.)' },
        hours_back: { type: 'number', default: 24 },
        limit: { type: 'number', default: 15 }
      },
      required: []
    }
  },
  {
    name: 'query_hypotheses',
    description: 'Hipótesis que Zeus ha formulado con su estado (pending, confirmed, rejected, inconclusive).',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['all', 'pending', 'confirmed', 'rejected', 'inconclusive'], default: 'all' },
        limit: { type: 'number', default: 15 }
      },
      required: []
    }
  },
  {
    name: 'query_duplications',
    description: 'Duplicaciones que Ares ejecutó: original → clone con ROAS at_dup + reasoning.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 15 }
      },
      required: []
    }
  },
  {
    name: 'query_adset_detail',
    description: 'Zoom-in completo a UN ad set específico: métricas actuales + historia últimos 30 días + tests asociados + acciones ejecutadas + memoria del brain. Usa esta cuando el usuario pregunte por algo específico.',
    input_schema: {
      type: 'object',
      properties: {
        adset_query: { type: 'string', description: 'ID o substring del nombre del ad set' },
        days_back: { type: 'number', default: 14, description: 'Cuántos días de historia traer' }
      },
      required: ['adset_query']
    }
  },
  {
    name: 'query_overview_history',
    description: 'Time-series día-por-día del portfolio completo: spend, revenue, ROAS, CPA diarios. Úsalo para responder "cómo fue el día X", "cómo venimos la semana", trends.',
    input_schema: {
      type: 'object',
      properties: {
        days_back: { type: 'number', default: 14, description: 'Número de días hacia atrás (max 90)' }
      },
      required: []
    }
  },
  {
    name: 'query_time_series',
    description: 'Time-series día-por-día de UNA entidad específica. Útil para trackear evolución de un ad set o campaña.',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Entity ID de Meta' },
        days_back: { type: 'number', default: 14, description: 'Días hacia atrás' }
      },
      required: ['entity_id']
    }
  },
  {
    name: 'query_brain_memory',
    description: 'Memoria que el Brain tiene sobre una entidad: patrones aprendidos, preferencias, historial de acciones, notas.',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Entity ID o name substring' }
      },
      required: ['entity_id']
    }
  },
  {
    name: 'query_safety_events',
    description: 'Eventos de safety: kill switch triggers, anomalías detectadas, cooldown hits. Histórico de "qué se evitó hacer y por qué".',
    input_schema: {
      type: 'object',
      properties: {
        days_back: { type: 'number', default: 7 },
        severity: { type: 'string', enum: ['all', 'critical', 'high', 'medium'], default: 'all' },
        limit: { type: 'number', default: 15 }
      },
      required: []
    }
  },
  {
    name: 'query_creative_proposals',
    description: 'Pipeline de creativos de Apollo: proposals generadas, ready, testing, graduados, killed. Filtros por status y ventana temporal.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['all', 'pending', 'ready', 'testing', 'graduated', 'killed', 'rejected'], default: 'all' },
        hours_back: { type: 'number', default: 48 },
        limit: { type: 'number', default: 20 }
      },
      required: []
    }
  },
  {
    name: 'query_ai_creations',
    description: 'Entidades creadas por AI (ad sets, ads) con su ciclo de vida: learning/testing/scaling/killed + verdict measurable a 1d/3d/7d.',
    input_schema: {
      type: 'object',
      properties: {
        phase: { type: 'string', enum: ['all', 'learning', 'testing', 'scaling', 'killed', 'graduated'], default: 'all' },
        days_back: { type: 'number', default: 14 },
        limit: { type: 'number', default: 15 }
      },
      required: []
    }
  },
  {
    name: 'query_ads',
    description: 'Ads individuales (creativas dentro de ad sets). Filtros por adset, ROAS, spend. Devuelve métricas 7d + creative info.',
    input_schema: {
      type: 'object',
      properties: {
        parent_adset_id: { type: 'string', description: 'Filtrar solo ads de un ad set específico' },
        min_roas: { type: 'number' },
        min_spend_7d: { type: 'number' },
        sort_by: { type: 'string', enum: ['roas', 'spend', 'purchases'], default: 'roas' },
        limit: { type: 'number', default: 20 }
      },
      required: []
    }
  },
  {
    name: 'query_campaigns',
    description: 'Campañas con detalle: nombre, objetivo, bid strategy, CBO/ABO, status, budget, performance agregado.',
    input_schema: {
      type: 'object',
      properties: {
        name_contains: { type: 'string' },
        active_only: { type: 'boolean', default: true },
        limit: { type: 'number', default: 20 }
      },
      required: []
    }
  },
  {
    name: 'query_recommendations',
    description: 'BrainRecommendations: recomendaciones pendientes de aprobación del creador + histórico ejecutadas con follow-up phases.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['all', 'pending', 'approved', 'rejected', 'executed'], default: 'pending' },
        hours_back: { type: 'number', default: 48 },
        limit: { type: 'number', default: 15 }
      },
      required: []
    }
  },
  {
    name: 'query_products',
    description: 'ProductBank: productos registrados con PNG refs, custom prompts, performance por producto y por escena.',
    input_schema: {
      type: 'object',
      properties: {
        active_only: { type: 'boolean', default: true }
      },
      required: []
    }
  },
  {
    name: 'query_strategic_directives',
    description: 'Directivas estratégicas de largo plazo + strategic insights que alimentan a Zeus.',
    input_schema: {
      type: 'object',
      properties: {
        active_only: { type: 'boolean', default: true },
        limit: { type: 'number', default: 10 }
      },
      required: []
    }
  },
  {
    name: 'query_agent_conversations',
    description: 'Comunicaciones entre Zeus y los demás agentes (directivas enviadas, reports, acknowledgments, alerts).',
    input_schema: {
      type: 'object',
      properties: {
        from_agent: { type: 'string', enum: ['zeus', 'athena', 'apollo', 'prometheus', 'ares', 'any'], default: 'any' },
        hours_back: { type: 'number', default: 24 },
        limit: { type: 'number', default: 20 }
      },
      required: []
    }
  },
  {
    name: 'ask_athena',
    description: 'Delegá a Athena (estratega de cuenta — scaling, pacing, pausas, adjustments) una pregunta concreta sobre decisiones a nivel account/adset. Athena consulta sus propios datos y responde con perspectiva de dominio.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Pregunta específica para Athena' }
      },
      required: ['question']
    }
  },
  {
    name: 'ask_apollo',
    description: 'Delegá a Apollo (director creativo — DNAs, pipeline, productos, evolution engine) una pregunta sobre creativos, combinaciones ganadoras, ángulos.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Pregunta específica para Apollo' }
      },
      required: ['question']
    }
  },
  {
    name: 'ask_prometheus',
    description: 'Delegá a Prometheus (ingeniero de testing — criterios de graduación, kills, qué testear) una pregunta sobre tests, fases, decisiones de testing.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Pregunta específica para Prometheus' }
      },
      required: ['question']
    }
  },
  {
    name: 'ask_ares',
    description: 'Delegá a Ares (duplicador CBO — 3 campañas: probados, nuevos, rescate) una pregunta sobre duplicaciones, candidatos, criterios de escala.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Pregunta específica para Ares' }
      },
      required: ['question']
    }
  },
  {
    name: 'code_overview',
    description: 'Overview de la estructura del código del proyecto (árbol de directorios hasta 2 niveles + info de package.json). Llamala al principio si vas a navegar código, para orientarte.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'list_code_files',
    description: 'Lista archivos del código que matchean un pattern en el path. Ej: pattern="brain-analyzer" o pattern="src/ai/". Devuelve paths, tamaños y modificación.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Substring que debe estar en el path' },
        extensions: { type: 'array', items: { type: 'string' }, description: 'Filtrar por extensiones, ej [".js", ".jsx"]' },
        limit: { type: 'number', default: 50 }
      },
      required: []
    }
  },
  {
    name: 'read_code_file',
    description: 'Lee un archivo del código (read-only, sandboxeado al proyecto). Soporta rango de líneas para archivos grandes.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relativo al root del proyecto (ej "src/ai/brain/zeus-learner.js")' },
        start_line: { type: 'number', default: 1, description: 'Línea de inicio (1-indexed)' },
        limit_lines: { type: 'number', default: 300, description: 'Cantidad máxima de líneas a leer' }
      },
      required: ['path']
    }
  },
  {
    name: 'grep_code',
    description: 'Busca pattern (regex-compatible) en archivos del código. Devuelve file+line+snippet con contexto.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Pattern a buscar (regex o literal)' },
        file_glob: { type: 'string', description: 'Filtra archivos cuyo path contenga este substring (ej "src/ai")' },
        extensions: { type: 'array', items: { type: 'string' } },
        max_matches: { type: 'number', default: 30 },
        context_lines: { type: 'number', default: 1, description: 'Líneas de contexto antes/después del match' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'remember_preference',
    description: 'Guardá una preferencia/prioridad/fact del creador que debería persistir entre conversaciones. Úsala solo para cosas genuinamente estables (no para respuestas puntuales): prioridades de negocio, estilos de comunicación, decisiones estratégicas, fases actuales. Ejemplos: "creador prioriza CPA sobre ROAS durante fase de inversión", "responder en párrafos cortos", "no duplicar en CBO 1 hasta julio".',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Identificador único (snake_case): ej priority_metric, response_style, freeze_window' },
        value: { type: 'string', description: 'La preferencia en sí, frase corta clara' },
        category: { type: 'string', enum: ['priority', 'style', 'strategic', 'operational', 'habit', 'constraint', 'other'], default: 'other' },
        context: { type: 'string', description: 'Por qué esta preferencia existe / de dónde salió' },
        confidence: { type: 'number', default: 0.8, description: '0-1, qué tan seguro estás' }
      },
      required: ['key', 'value', 'category']
    }
  },
  {
    name: 'forget_preference',
    description: 'Marca una preferencia como inactiva (la "olvida"). Úsala si el creador explícitamente dice que algo ya no aplica.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key de la preferencia a olvidar' }
      },
      required: ['key']
    }
  },
  {
    name: 'list_preferences',
    description: 'Lista las preferencias actuales. Usala si el creador pregunta qué recordás de él o para auto-introspección.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['all', 'priority', 'style', 'strategic', 'operational', 'habit', 'constraint', 'other'], default: 'all' }
      },
      required: []
    }
  },
  {
    name: 'create_watcher',
    description: 'Creá un watcher — condición que Zeus monitorea cada 30min y dispara un ping proactivo al chat cuando se cumple. Usala cuando el creador pida "avisame cuando X" o "monitoreá Y". Ejemplos: "avisame cuando vuelva a gastar" → delivery_resumed; "pingame si ROAS cae bajo 2x" → roas_below con threshold=2; "decime si este adset llega a $100" → adset_spend_above.',
    input_schema: {
      type: 'object',
      properties: {
        condition_type: {
          type: 'string',
          enum: ['delivery_resumed', 'spend_above', 'roas_above', 'roas_below', 'adset_spend_above', 'adset_roas_above', 'test_graduates', 'test_count'],
          description: 'Tipo de condición'
        },
        description: {
          type: 'string',
          description: 'Descripción humana de qué monitorea (ej: "Cuando el spend_today cruce $100 después del billing freeze")'
        },
        amount: { type: 'number', description: 'Para spend_above/adset_spend_above: monto en USD' },
        threshold: { type: 'number', description: 'Para roas_*/test_count: valor a cruzar' },
        window: { type: 'string', enum: ['last_1d', 'last_7d', 'last_14d'], description: 'Para roas_*: ventana temporal' },
        adset_id: { type: 'string', description: 'Para adset_*: entity_id del adset' },
        count: { type: 'number', description: 'Para test_graduates: cantidad mínima' },
        min_spend_today: { type: 'number', description: 'Para delivery_resumed: mínimo de spend hoy para considerar reanudado (default 100)' },
        op: { type: 'string', enum: ['gte', 'lte', 'eq'], description: 'Para test_count' },
        expires_in_hours: { type: 'number', description: 'Cuántas horas desde ahora permanece activo. null = no expira (recomendado max 48)' },
        conversation_id: { type: 'string', description: 'ID de la conversación actual (para pingear ahí). Si no se pasa, usa la última activa.' }
      },
      required: ['condition_type', 'description']
    }
  },
  {
    name: 'cancel_watcher',
    description: 'Cancela un watcher activo. Úsala si el creador dice "cancelá el aviso" o cuando ya no aplica.',
    input_schema: {
      type: 'object',
      properties: {
        watcher_id: { type: 'string', description: 'ID del watcher' }
      },
      required: ['watcher_id']
    }
  },
  {
    name: 'list_watchers',
    description: 'Lista watchers activos + los últimos que dispararon. Úsala si el creador pregunta qué estás monitoreando.',
    input_schema: {
      type: 'object',
      properties: {
        include_triggered: { type: 'boolean', default: false }
      },
      required: []
    }
  },
  {
    name: 'query_delivery_health',
    description: 'Chequea la salud de entrega de Meta — detecta billing freeze, campañas que no gastan, drops masivos de spend, ad sets con 0 impressions, safety events recientes, anomalías críticas. USALA apenas el creador pregunte "cómo venimos" o "hay algún problema" o menciones billing/delivery. También ideal al comienzo del día.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'create_directive',
    description: 'Creá una directiva operativa en el sistema que los agentes (Athena, Apollo, Prometheus, Ares) leerán en sus próximos ciclos. Usala cuando el creador te pida que el equipo actúe de cierta forma. Ejemplos: "decile a Ares que no duplique nada hasta las 17:00 por billing issue", "pedile a Apollo que solo genere escena X esta semana", "que Prometheus pause todos los tests nuevos hasta mañana".',
    input_schema: {
      type: 'object',
      properties: {
        directive: { type: 'string', description: 'El texto de la directiva (imperativo, claro, corto). Ej: "No duplicar ningún ad set hasta las 17:00 ET del día de hoy por billing pending con Meta."' },
        directive_type: { type: 'string', enum: ['prioritize', 'avoid', 'adjust', 'alert', 'insight', 'pause_clone'], description: 'prioritize=hacé esto; avoid=no hagas esto; adjust=ajustá umbral/config; alert=atención; insight=info; pause_clone=pausar clones específicos' },
        target_agent: { type: 'string', enum: ['apollo', 'prometheus', 'athena', 'ares', 'all'], description: 'Qué agente debe leerla' },
        reasoning: { type: 'string', description: 'Por qué esta directiva (el contexto que la motiva)' },
        confidence: { type: 'number', default: 0.9, description: '0-1, típicamente alto cuando viene del creador' },
        expires_in_hours: { type: 'number', description: 'Si la directiva tiene ventana temporal (ej billing freeze), poné cuántas horas desde ahora. null = no expira.' },
        category: { type: 'string', enum: ['creative_pattern', 'test_signal', 'account_pattern', 'cross_agent', 'general'], default: 'general' },
        data: { type: 'object', description: 'Datos estructurados opcionales para que el agente consuma (ej { min_roas: 3.5, until: "17:00" })', additionalProperties: true }
      },
      required: ['directive', 'directive_type', 'target_agent', 'reasoning']
    }
  },
  {
    name: 'deactivate_directive',
    description: 'Desactivá una directiva existente (marcar active=false). Úsala cuando el creador diga que algo ya no aplica o cuando la ventana temporal expiró.',
    input_schema: {
      type: 'object',
      properties: {
        directive_id: { type: 'string', description: 'ID de la directiva a desactivar (sacalo de query_directives)' },
        reason: { type: 'string', description: 'Por qué se desactiva' }
      },
      required: ['directive_id']
    }
  },
  {
    name: 'propose_code_change',
    description: 'Persiste una recomendación concreta de cambio al código. Úsala cuando hayas detectado algo específico (threshold mal calibrado, bug, optimización) con evidencia de los datos. No la uses para comentarios generales — solo cuando tenés un cambio concreto que proponer, file:line específicos, y justificación numérica. El creador lo va a ver como card para revisar/aceptar/rechazar.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path relativo al root (ej "src/ai/agent/testing-agent.js")' },
        line_start: { type: 'number', description: 'Primera línea del bloque afectado' },
        line_end: { type: 'number', description: 'Última línea del bloque afectado (puede ser igual a line_start)' },
        current_code: { type: 'string', description: 'Snippet del código ACTUAL (lo que querés cambiar)' },
        proposed_code: { type: 'string', description: 'Snippet del código PROPUESTO (como debería quedar)' },
        rationale: { type: 'string', description: 'Por qué este cambio mejora el sistema (2-4 oraciones, markdown OK)' },
        evidence_summary: { type: 'string', description: 'Resumen en 1-2 líneas de la evidencia de datos que soporta el cambio (ej: "de 40 tests killed últimos 30 días, 12 tenían ROAS 1.2-1.8 antes del kill — umbral está matando winners en zona gris")' },
        evidence: { type: 'object', description: 'Data estructurada que soporta (métricas, counts, etc)', additionalProperties: true },
        expected_impact: { type: 'string', description: 'Qué debería cambiar después del fix (opcional)' },
        category: { type: 'string', enum: ['threshold', 'bug', 'optimization', 'dead_code', 'refactor', 'safety', 'naming', 'other'], default: 'other' },
        severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], default: 'medium' }
      },
      required: ['file_path', 'rationale', 'evidence_summary', 'category', 'severity']
    }
  }
];

// ═══════════════════════════════════════════════════════════════════════════
// Tool handlers
// ═══════════════════════════════════════════════════════════════════════════

async function handleQueryPortfolio() {
  const snapshots = await getLatestSnapshots('adset');
  const active = snapshots.filter(s => s.status === 'ACTIVE');

  const windows = ['last_1d', 'last_3d', 'last_7d', 'last_14d'];
  const aggregates = {};
  for (const w of windows) {
    const spend = active.reduce((s, a) => s + (a.metrics?.[w]?.spend || 0), 0);
    const revenue = active.reduce((s, a) => {
      const m = a.metrics?.[w] || {};
      return s + ((m.roas || 0) * (m.spend || 0));
    }, 0);
    const purchases = active.reduce((s, a) => s + (a.metrics?.[w]?.purchases || 0), 0);
    aggregates[w] = {
      spend: Math.round(spend),
      revenue: Math.round(revenue),
      roas: spend > 0 ? +(revenue / spend).toFixed(2) : 0,
      cpa: purchases > 0 ? +(spend / purchases).toFixed(2) : 0,
      purchases
    };
  }

  // By campaign
  const byCampaign = {};
  for (const s of active) {
    const cid = s.campaign_id || 'unknown';
    if (!byCampaign[cid]) byCampaign[cid] = { campaign_id: cid, campaign_name: s.campaign_name || '', adsets: 0, spend_7d: 0, revenue_7d: 0 };
    byCampaign[cid].adsets += 1;
    byCampaign[cid].spend_7d += s.metrics?.last_7d?.spend || 0;
    byCampaign[cid].revenue_7d += (s.metrics?.last_7d?.roas || 0) * (s.metrics?.last_7d?.spend || 0);
  }
  const campaigns = Object.values(byCampaign).map(c => ({
    ...c,
    spend_7d: Math.round(c.spend_7d),
    revenue_7d: Math.round(c.revenue_7d),
    roas_7d: c.spend_7d > 0 ? +(c.revenue_7d / c.spend_7d).toFixed(2) : 0
  })).sort((a, b) => b.spend_7d - a.spend_7d);

  return {
    active_adsets: active.length,
    aggregates,
    campaigns: campaigns.slice(0, 10)
  };
}

async function handleQueryAdsets(input) {
  const snapshots = await getLatestSnapshots('adset');
  let list = snapshots.filter(s => s.status === 'ACTIVE');

  if (input.name_contains) {
    const q = input.name_contains.toLowerCase();
    list = list.filter(s => (s.entity_name || '').toLowerCase().includes(q));
  }
  if (typeof input.min_roas === 'number') list = list.filter(s => (s.metrics?.last_7d?.roas || 0) >= input.min_roas);
  if (typeof input.max_roas === 'number') list = list.filter(s => (s.metrics?.last_7d?.roas || 0) <= input.max_roas);
  if (typeof input.min_spend_7d === 'number') list = list.filter(s => (s.metrics?.last_7d?.spend || 0) >= input.min_spend_7d);

  const sortBy = input.sort_by || 'roas';
  list.sort((a, b) => {
    const am = a.metrics?.last_7d || {};
    const bm = b.metrics?.last_7d || {};
    if (sortBy === 'spend') return (bm.spend || 0) - (am.spend || 0);
    if (sortBy === 'purchases') return (bm.purchases || 0) - (am.purchases || 0);
    if (sortBy === 'frequency') return (bm.frequency || 0) - (am.frequency || 0);
    return (bm.roas || 0) - (am.roas || 0);
  });

  const limit = Math.min(input.limit || 20, 50);
  return list.slice(0, limit).map(s => {
    const m = s.metrics?.last_7d || {};
    return {
      name: s.entity_name,
      id: s.entity_id,
      campaign: s.campaign_name,
      daily_budget: s.daily_budget || 0,
      spend_7d: Math.round(m.spend || 0),
      roas_7d: +(m.roas || 0).toFixed(2),
      purchases_7d: m.purchases || 0,
      cpa_7d: m.purchases > 0 ? +(m.spend / m.purchases).toFixed(2) : null,
      frequency: +(m.frequency || 0).toFixed(2),
      ctr: +(m.ctr || 0).toFixed(2),
      learning_stage: s.learning_stage || null
    };
  });
}

async function handleQueryTests(input) {
  const filter = {};
  if (input.phase === 'active') filter.phase = { $in: ['learning', 'evaluating'] };
  else if (input.phase) filter.phase = input.phase;

  const tests = await TestRun.find(filter)
    .sort({ launched_at: -1 })
    .limit(Math.min(input.limit || 15, 30))
    .populate({ path: 'proposal_id', select: 'headline scene_short product_name' })
    .lean();

  return tests.map(t => ({
    name: t.test_adset_name,
    phase: t.phase,
    days_active: Math.floor((Date.now() - new Date(t.launched_at).getTime()) / 86400000),
    metrics: {
      spend: Math.round(t.metrics?.spend || 0),
      roas: +(t.metrics?.roas || 0).toFixed(2),
      purchases: t.metrics?.purchases || 0,
      ctr: +(t.metrics?.ctr || 0).toFixed(2)
    },
    source_adset: t.source_adset_name,
    product: t.proposal_id?.product_name,
    scene: t.proposal_id?.scene_short,
    headline: t.proposal_id?.headline,
    latest_assessment: t.assessments?.[t.assessments.length - 1]?.assessment || null,
    kill_reason: t.kill_reason || null
  }));
}

async function handleQueryDnas(input) {
  const filter = { 'fitness.tests_total': { $gte: input.min_samples || 2 } };
  const sort = input.sort_by === 'roas'
    ? { 'fitness.avg_roas': -1 }
    : input.sort_by === 'win_rate'
    ? { 'fitness.win_rate': -1 }
    : input.sort_by === 'generation'
    ? { generation: -1 }
    : { 'fitness.avg_roas': -1, 'fitness.sample_confidence': -1 };

  const dnas = await CreativeDNA.find(filter)
    .sort(sort)
    .limit(Math.min(input.limit || 10, 30))
    .lean();

  return dnas.map(d => ({
    dimensions: d.dimensions,
    generation: d.generation,
    fitness: {
      tests_total: d.fitness?.tests_total || 0,
      tests_graduated: d.fitness?.tests_graduated || 0,
      tests_killed: d.fitness?.tests_killed || 0,
      avg_roas: +(d.fitness?.avg_roas || 0).toFixed(2),
      win_rate: Math.round((d.fitness?.win_rate || 0) * 100),
      confidence: Math.round((d.fitness?.sample_confidence || 0) * 100),
      total_spend: Math.round(d.fitness?.total_spend || 0),
      total_revenue: Math.round(d.fitness?.total_revenue || 0)
    }
  }));
}

async function handleQueryActions(input) {
  const hours = input.hours_back || 48;
  const since = new Date(Date.now() - hours * 3600000);
  const filter = { executed_at: { $gte: since }, success: true };
  if (input.agent_type && input.agent_type !== 'any') filter.agent_type = input.agent_type;
  if (input.action) filter.action = input.action;

  const actions = await ActionLog.find(filter)
    .sort({ executed_at: -1 })
    .limit(Math.min(input.limit || 15, 40))
    .lean();

  return actions.map(a => ({
    action: a.action,
    agent: a.agent_type,
    entity_name: a.entity_name,
    before: a.before_value,
    after: a.after_value,
    reasoning: a.reasoning?.substring(0, 200),
    executed_at: a.executed_at,
    impact_7d: a.impact_7d ? {
      roas_delta: +(a.impact_7d.roas_delta || 0).toFixed(2),
      spend_delta: Math.round(a.impact_7d.spend_delta || 0)
    } : null
  }));
}

async function handleQueryDirectives(input) {
  const filter = input.active_only === false ? {} : { active: true };
  const directives = await ZeusDirective.find(filter)
    .sort({ confidence: -1, created_at: -1 })
    .limit(30)
    .lean();
  return directives.map(d => ({
    id: d._id.toString(),                         // usalo con deactivate_directive
    directive: d.directive,
    type: d.directive_type,
    target_agent: d.target_agent,
    confidence: Math.round((d.confidence || 0) * 100),
    category: d.category,
    active: d.active,
    executed: d.executed,
    source: d.data?.source || 'learner',          // 'chat' si la creó el creador via chat
    reasoning: (d.data?.reasoning || d.reasoning || '').toString().substring(0, 200),
    created_at: d.created_at,
    expires_at: d.expires_at
  }));
}

async function handleQueryInsights(input) {
  const hours = input.hours_back || 24;
  const since = new Date(Date.now() - hours * 3600000);
  const filter = { created_at: { $gte: since } };
  if (input.insight_type) filter.insight_type = input.insight_type;

  const insights = await BrainInsight.find(filter)
    .sort({ created_at: -1 })
    .limit(Math.min(input.limit || 15, 40))
    .lean();

  return insights.map(i => ({
    type: i.insight_type,
    title: i.title,
    content: i.content?.substring(0, 300),
    generated_by: i.generated_by,
    entity: i.entity_name,
    confidence: i.confidence,
    created_at: i.created_at
  }));
}

async function handleQueryHypotheses(input) {
  const filter = { insight_type: 'hypothesis' };
  if (input.status && input.status !== 'all') filter['metadata.status'] = input.status;

  const hyps = await BrainInsight.find(filter)
    .sort({ created_at: -1 })
    .limit(Math.min(input.limit || 15, 30))
    .lean();

  return hyps.map(h => ({
    hypothesis: h.title,
    reasoning: h.content?.substring(0, 300),
    status: h.metadata?.status || 'pending',
    evidence: h.metadata?.evidence?.substring(0, 200) || null,
    recommendation: h.metadata?.recommendation?.substring(0, 200) || null,
    validated_at: h.metadata?.validated_at || null,
    created_at: h.created_at
  }));
}

async function handleQueryDuplications(input) {
  const dups = await ActionLog.find({
    action: { $in: ['duplicate_adset', 'fast_track_duplicate'] },
    agent_type: 'ares_agent',
    success: true
  }).sort({ executed_at: -1 })
    .limit(Math.min(input.limit || 15, 30))
    .lean();

  return dups.map(d => ({
    original_name: d.entity_name,
    clone_name: d.after_value,
    roas_at_dup: +(d.metrics_at_execution?.roas_7d || 0).toFixed(2),
    spend_at_dup: Math.round(d.metrics_at_execution?.spend_7d || 0),
    reasoning: d.reasoning?.substring(0, 200),
    executed_at: d.executed_at
  }));
}

async function handleQueryAdsetDetail(input) {
  const days = Math.min(input.days_back || 14, 90);
  const snapshots = await getLatestSnapshots('adset');

  // Resolver entity por id o por nombre
  let match = snapshots.find(s => s.entity_id === input.adset_query);
  if (!match) {
    const q = (input.adset_query || '').toLowerCase();
    match = snapshots.find(s => (s.entity_name || '').toLowerCase().includes(q));
  }
  if (!match) return { error: `No encontré un ad set con query "${input.adset_query}"` };

  // History día-por-día
  const history = await getSnapshotHistory(match.entity_id, days).catch(() => []);

  // Actions ejecutadas sobre este adset
  const actions = await ActionLog.find({ entity_id: match.entity_id, success: true })
    .sort({ executed_at: -1 }).limit(20).lean();

  // Tests con este adset como source
  const tests = await TestRun.find({ source_adset_id: match.entity_id })
    .sort({ launched_at: -1 }).limit(10).lean();

  // Memoria del brain
  const memory = await BrainMemory.findOne({ entity_id: match.entity_id }).lean();

  const m7 = match.metrics?.last_7d || {};
  const m14 = match.metrics?.last_14d || {};
  return {
    entity: {
      id: match.entity_id,
      name: match.entity_name,
      campaign: match.campaign_name,
      status: match.status,
      daily_budget: match.daily_budget,
      learning_stage: match.learning_stage
    },
    current_metrics: {
      roas_7d: +(m7.roas || 0).toFixed(2),
      spend_7d: Math.round(m7.spend || 0),
      purchases_7d: m7.purchases || 0,
      cpa_7d: m7.purchases > 0 ? +(m7.spend / m7.purchases).toFixed(2) : null,
      frequency: +(m7.frequency || 0).toFixed(2),
      ctr: +(m7.ctr || 0).toFixed(2),
      roas_14d: +(m14.roas || 0).toFixed(2)
    },
    daily_history: history.slice(-days).map(h => ({
      date: h.date,
      spend: Math.round(h.spend || 0),
      roas: +(h.roas || 0).toFixed(2),
      purchases: h.purchases || 0
    })),
    recent_actions: actions.slice(0, 10).map(a => ({
      action: a.action, agent: a.agent_type, executed_at: a.executed_at,
      reasoning: a.reasoning?.substring(0, 150),
      impact_7d: a.impact_7d ? { roas_delta: a.impact_7d.roas_delta } : null
    })),
    tests: tests.map(t => ({
      phase: t.phase, launched_at: t.launched_at,
      roas: t.metrics?.roas, purchases: t.metrics?.purchases,
      source_adset: t.source_adset_name
    })),
    brain_memory: memory ? {
      notes: memory.notes?.substring(0, 300),
      action_count: memory.action_history?.length || 0,
      last_updated: memory.last_updated_at
    } : null
  };
}

async function handleQueryOverviewHistory(input) {
  const days = Math.min(input.days_back || 14, 90);
  const history = await getOverviewHistory(days).catch(() => []);
  return history.map(h => ({
    date: h.date,
    spend: Math.round(h.spend || 0),
    revenue: Math.round(h.revenue || 0),
    roas: +(h.roas || 0).toFixed(2),
    purchases: h.purchases || 0,
    cpa: h.purchases > 0 ? +(h.spend / h.purchases).toFixed(2) : null
  }));
}

async function handleQueryTimeSeries(input) {
  if (!input.entity_id) return { error: 'entity_id requerido' };
  const days = Math.min(input.days_back || 14, 90);
  const history = await getSnapshotHistory(input.entity_id, days).catch(() => []);
  return {
    entity_id: input.entity_id,
    days_back: days,
    series: history.map(h => ({
      date: h.date,
      spend: Math.round(h.spend || 0),
      roas: +(h.roas || 0).toFixed(2),
      purchases: h.purchases || 0,
      frequency: +(h.frequency || 0).toFixed(2)
    }))
  };
}

async function handleQueryBrainMemory(input) {
  if (!input.entity_id) return { error: 'entity_id requerido' };

  // Intentar match exacto por id
  let memory = await BrainMemory.findOne({ entity_id: input.entity_id }).lean();

  // Si no, buscar por substring en nombre
  if (!memory) {
    const regex = new RegExp(input.entity_id.substring(0, 30), 'i');
    memory = await BrainMemory.findOne({ entity_name: regex }).lean();
  }

  if (!memory) return { error: `Sin memoria para "${input.entity_id}"` };

  return {
    entity_id: memory.entity_id,
    entity_name: memory.entity_name,
    entity_type: memory.entity_type,
    notes: memory.notes,
    patterns: memory.patterns,
    preferences: memory.preferences,
    recent_actions: (memory.action_history || []).slice(-10).map(a => ({
      action: a.action,
      date: a.date,
      outcome: a.outcome
    })),
    last_updated: memory.last_updated_at
  };
}

async function handleQuerySafetyEvents(input) {
  const days = input.days_back || 7;
  const since = new Date(Date.now() - days * 86400000);
  const filter = { created_at: { $gte: since } };
  if (input.severity && input.severity !== 'all') filter.severity = input.severity;

  const events = await SafetyEvent.find(filter)
    .sort({ created_at: -1 })
    .limit(Math.min(input.limit || 15, 40))
    .lean();

  return events.map(e => ({
    type: e.event_type,
    severity: e.severity,
    entity: e.entity_name,
    reason: e.reason?.substring(0, 200),
    action_taken: e.action_taken,
    created_at: e.created_at
  }));
}

async function handleQueryCreativeProposals(input) {
  const hours = input.hours_back || 48;
  const since = new Date(Date.now() - hours * 3600000);
  const filter = { created_at: { $gte: since } };
  if (input.status && input.status !== 'all') filter.status = input.status;

  const proposals = await CreativeProposal.find(filter)
    .sort({ created_at: -1 })
    .limit(Math.min(input.limit || 20, 50))
    .lean();

  return proposals.map(p => ({
    headline: p.headline,
    status: p.status,
    product: p.product_name,
    scene: p.scene_short,
    evolution_strategy: p.evolution_strategy,
    created_at: p.created_at,
    rejection_reason: p.rejection_reason
  }));
}

async function handleQueryAICreations(input) {
  const days = input.days_back || 14;
  const since = new Date(Date.now() - days * 86400000);
  const filter = { created_at: { $gte: since } };
  if (input.phase && input.phase !== 'all') filter.lifecycle_phase = input.phase;

  const creations = await AICreation.find(filter)
    .sort({ created_at: -1 })
    .limit(Math.min(input.limit || 15, 40))
    .lean();

  return creations.map(c => ({
    type: c.creation_type,
    entity_name: c.entity_name,
    phase: c.lifecycle_phase,
    verdict: c.verdict,
    created_at: c.created_at,
    measured_1d: c.impact_1d ? { roas: c.impact_1d.roas, purchases: c.impact_1d.purchases } : null,
    measured_7d: c.impact_7d ? { roas: c.impact_7d.roas, purchases: c.impact_7d.purchases } : null
  }));
}

async function handleQueryAds(input) {
  const snapshots = await getLatestSnapshots('ad');
  let list = snapshots.filter(s => s.status === 'ACTIVE');
  if (input.parent_adset_id) list = list.filter(s => s.parent_adset_id === input.parent_adset_id);
  if (typeof input.min_roas === 'number') list = list.filter(s => (s.metrics?.last_7d?.roas || 0) >= input.min_roas);
  if (typeof input.min_spend_7d === 'number') list = list.filter(s => (s.metrics?.last_7d?.spend || 0) >= input.min_spend_7d);

  const sortBy = input.sort_by || 'roas';
  list.sort((a, b) => {
    const am = a.metrics?.last_7d || {}, bm = b.metrics?.last_7d || {};
    if (sortBy === 'spend') return (bm.spend || 0) - (am.spend || 0);
    if (sortBy === 'purchases') return (bm.purchases || 0) - (am.purchases || 0);
    return (bm.roas || 0) - (am.roas || 0);
  });

  return list.slice(0, Math.min(input.limit || 20, 40)).map(s => {
    const m = s.metrics?.last_7d || {};
    return {
      name: s.entity_name,
      id: s.entity_id,
      adset_id: s.parent_adset_id,
      adset_name: s.parent_adset_name,
      spend_7d: Math.round(m.spend || 0),
      roas_7d: +(m.roas || 0).toFixed(2),
      purchases_7d: m.purchases || 0,
      ctr: +(m.ctr || 0).toFixed(2),
      frequency: +(m.frequency || 0).toFixed(2)
    };
  });
}

async function handleQueryCampaigns(input) {
  const snapshots = await getLatestSnapshots('campaign');
  let list = input.active_only === false ? snapshots : snapshots.filter(s => s.status === 'ACTIVE');
  if (input.name_contains) {
    const q = input.name_contains.toLowerCase();
    list = list.filter(s => (s.entity_name || '').toLowerCase().includes(q));
  }

  return list.slice(0, Math.min(input.limit || 20, 40)).map(s => {
    const m = s.metrics?.last_7d || {};
    return {
      name: s.entity_name,
      id: s.entity_id,
      objective: s.objective,
      bid_strategy: s.bid_strategy,
      budget_mode: s.budget_mode,
      daily_budget: s.daily_budget,
      status: s.status,
      spend_7d: Math.round(m.spend || 0),
      roas_7d: +(m.roas || 0).toFixed(2),
      purchases_7d: m.purchases || 0
    };
  });
}

async function handleQueryRecommendations(input) {
  const filter = {};
  if (input.status && input.status !== 'all') filter.status = input.status;
  if (input.hours_back) {
    filter.created_at = { $gte: new Date(Date.now() - input.hours_back * 3600000) };
  }

  const recs = await BrainRecommendation.find(filter)
    .sort({ created_at: -1 })
    .limit(Math.min(input.limit || 15, 40))
    .lean();

  return recs.map(r => ({
    entity_type: r.entity_type,
    entity_name: r.entity_name,
    action_type: r.action_type,
    rationale: r.rationale?.substring(0, 300),
    priority: r.priority,
    status: r.status,
    confidence: r.confidence,
    expected_impact: r.expected_impact,
    created_at: r.created_at,
    approved_at: r.approved_at,
    executed_at: r.executed_at,
    follow_up_phase: r.follow_up_phase,
    impact_measured: r.impact_measured
  }));
}

async function handleQueryProducts(input) {
  const filter = input.active_only === false ? {} : { active: true };
  const products = await ProductBank.find(filter).lean();
  return products.map(p => ({
    name: p.product_name,
    slug: p.product_slug,
    url: p.link_url,
    description: p.product_description?.substring(0, 300),
    prompt_type: p.prompt_type,
    has_custom_prompt: !!p.custom_prompt_template,
    reference_count: (p.png_references || []).length,
    performance: {
      ads_created: p.performance?.total_ads_created || 0,
      avg_roas: +(p.performance?.avg_roas || 0).toFixed(2),
      total_spend: Math.round(p.performance?.total_spend || 0),
      best_scene: p.performance?.best_scene,
      worst_scene: p.performance?.worst_scene
    },
    top_scenes: (p.scene_performance || []).slice(0, 5).map(s => ({
      scene: s.scene,
      avg_roas: +(s.avg_roas || 0).toFixed(2),
      ads_created: s.ads_created
    }))
  }));
}

async function handleQueryStrategicDirectives(input) {
  const filter = input.active_only === false ? {} : { status: { $in: ['active', 'pending'] } };
  const dirs = await StrategicDirective.find(filter)
    .sort({ created_at: -1 })
    .limit(Math.min(input.limit || 10, 30))
    .lean();

  return dirs.map(d => ({
    directive: d.directive,
    rationale: d.rationale?.substring(0, 300),
    status: d.status,
    target_entity_type: d.target_entity_type,
    target_entity: d.target_entity_name,
    priority: d.priority,
    created_at: d.created_at,
    expires_at: d.expires_at
  }));
}

async function handleQueryAgentConversations(input) {
  const hours = input.hours_back || 24;
  const filter = { created_at: { $gte: new Date(Date.now() - hours * 3600000) } };
  if (input.from_agent && input.from_agent !== 'any') filter.from = input.from_agent;

  const convs = await ZeusConversation.find(filter)
    .sort({ created_at: -1 })
    .limit(Math.min(input.limit || 20, 50))
    .lean();

  return convs.map(c => ({
    from: c.from,
    to: c.to,
    type: c.type,
    message: c.message?.substring(0, 300),
    created_at: c.created_at
  }));
}

async function handleAskAgent(agentKey, input) {
  if (!input.question) return { error: 'question requerida' };
  // Require lazily to evitar circular dep
  const { askAgent } = require('./agent-brains');
  return await askAgent(agentKey, input.question);
}

const codeTools = require('./code-tools');

async function handleCodeOverview() {
  return codeTools.codeOverview();
}

async function handleListCodeFiles(input) {
  return codeTools.listCodeFiles(input || {});
}

async function handleReadCodeFile(input) {
  try {
    return codeTools.readCodeFile(input || {});
  } catch (err) {
    return { error: err.message };
  }
}

async function handleGrepCode(input) {
  try {
    return codeTools.grepCode(input || {});
  } catch (err) {
    return { error: err.message };
  }
}

const ZEUS_SELF_FILES = [
  'src/ai/zeus/oracle-runner.js',
  'src/ai/zeus/oracle-tools.js',
  'src/ai/zeus/oracle-context.js',
  'src/ai/zeus/oracle-proactive.js',
  'src/ai/zeus/agent-brains.js',
  'src/ai/zeus/code-tools.js',
  'src/safety/kill-switch.js',
  'src/safety/guard-rail.js',
  'src/safety/cooldown-manager.js',
  'src/safety/anomaly-detector.js'
];

async function handleQueryDeliveryHealth() {
  const { checkDeliveryHealth } = require('./delivery-health');
  return await checkDeliveryHealth();
}

async function handleCreateWatcher(input) {
  if (!input.condition_type || !input.description) {
    return { error: 'condition_type y description requeridos' };
  }
  try {
    const params = {};
    ['amount', 'threshold', 'window', 'adset_id', 'count', 'min_spend_today', 'op']
      .forEach(k => { if (input[k] !== undefined) params[k] = input[k]; });

    const expiresAt = input.expires_in_hours
      ? new Date(Date.now() + input.expires_in_hours * 3600000)
      : null;

    // Si no viene conversation_id, usar la última activa
    let conversationId = input.conversation_id || null;
    if (!conversationId) {
      const ZeusChatMessage = require('../../db/models/ZeusChatMessage');
      const last = await ZeusChatMessage.findOne().sort({ created_at: -1 }).select('conversation_id').lean();
      conversationId = last?.conversation_id || null;
    }

    const watcher = await ZeusWatcher.create({
      condition_type: input.condition_type,
      condition_params: params,
      description: input.description,
      conversation_id: conversationId,
      created_via: 'chat',
      active: true,
      expires_at: expiresAt
    });
    return {
      ok: true,
      id: watcher._id.toString(),
      summary: `Watcher creado: ${input.description}${expiresAt ? ` (expira ${expiresAt.toISOString()})` : ''}`
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function handleCancelWatcher(input) {
  if (!input.watcher_id) return { error: 'watcher_id requerido' };
  try {
    const w = await ZeusWatcher.findByIdAndUpdate(
      input.watcher_id,
      { $set: { active: false } },
      { new: true }
    );
    if (!w) return { error: 'Watcher no encontrado' };
    return { ok: true, summary: `Watcher cancelado: ${w.description}` };
  } catch (err) {
    return { error: err.message };
  }
}

async function handleListWatchers(input) {
  const filter = input.include_triggered ? {} : { active: true };
  const watchers = await ZeusWatcher.find(filter)
    .sort({ created_at: -1 })
    .limit(30)
    .lean();
  return watchers.map(w => ({
    id: w._id.toString(),
    condition_type: w.condition_type,
    description: w.description,
    params: w.condition_params,
    active: w.active,
    triggered_at: w.triggered_at,
    trigger_result: w.trigger_result,
    expires_at: w.expires_at,
    created_at: w.created_at
  }));
}

async function handleCreateDirective(input) {
  if (!input.directive || !input.directive_type || !input.target_agent || !input.reasoning) {
    return { error: 'directive, directive_type, target_agent y reasoning son requeridos' };
  }
  try {
    const expiresAt = input.expires_in_hours
      ? new Date(Date.now() + input.expires_in_hours * 3600000)
      : null;
    const dir = await ZeusDirective.create({
      directive: input.directive,
      directive_type: input.directive_type,
      target_agent: input.target_agent,
      data: { ...(input.data || {}), reasoning: input.reasoning, source: 'chat' },
      confidence: input.confidence ?? 0.9,
      based_on_samples: 0,
      category: input.category || 'general',
      active: true,
      persistent: false,
      expires_at: expiresAt
    });
    return {
      ok: true,
      id: dir._id.toString(),
      summary: `Directiva creada para ${input.target_agent}: "${input.directive.substring(0, 80)}${input.directive.length > 80 ? '...' : ''}"${expiresAt ? ` (expira ${expiresAt.toISOString()})` : ''}`
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function handleDeactivateDirective(input) {
  if (!input.directive_id) return { error: 'directive_id requerido' };
  try {
    const dir = await ZeusDirective.findByIdAndUpdate(
      input.directive_id,
      { $set: { active: false, last_validated_at: new Date() } },
      { new: true }
    );
    if (!dir) return { error: 'Directiva no encontrada' };
    return { ok: true, summary: `Directiva desactivada: ${dir.directive.substring(0, 80)}` };
  } catch (err) {
    return { error: err.message };
  }
}

async function handleRememberPreference(input) {
  if (!input.key || !input.value) return { error: 'key y value requeridos' };
  try {
    const pref = await ZeusPreference.findOneAndUpdate(
      { key: input.key },
      {
        $set: {
          value: input.value,
          category: input.category || 'other',
          context: input.context || '',
          confidence: input.confidence ?? 0.8,
          active: true,
          updated_at: new Date()
        }
      },
      { upsert: true, new: true }
    );
    return { ok: true, key: pref.key, value: pref.value, summary: `Guardado: ${pref.key} = "${pref.value}"` };
  } catch (err) {
    return { error: err.message };
  }
}

async function handleForgetPreference(input) {
  if (!input.key) return { error: 'key requerido' };
  try {
    const updated = await ZeusPreference.findOneAndUpdate(
      { key: input.key },
      { $set: { active: false, updated_at: new Date() } },
      { new: true }
    );
    if (!updated) return { error: `No encontré preferencia con key "${input.key}"` };
    return { ok: true, summary: `Olvidado: ${input.key}` };
  } catch (err) {
    return { error: err.message };
  }
}

async function handleListPreferences(input) {
  const filter = { active: true };
  if (input.category && input.category !== 'all') filter.category = input.category;
  const prefs = await ZeusPreference.find(filter).sort({ category: 1, updated_at: -1 }).lean();
  return prefs.map(p => ({
    key: p.key,
    value: p.value,
    category: p.category,
    context: p.context,
    confidence: p.confidence,
    created_at: p.created_at
  }));
}

async function handleProposeCodeChange(input) {
  if (!input.file_path || !input.rationale || !input.evidence_summary) {
    return { error: 'file_path, rationale, evidence_summary son requeridos' };
  }
  // Guard: Zeus no puede proponer cambios a su propio cerebro ni a safety
  const normPath = input.file_path.replace(/\\/g, '/').replace(/^\.?\//, '');
  if (ZEUS_SELF_FILES.some(f => normPath === f || normPath.endsWith(f))) {
    return { error: `Archivo fuera de scope: ${input.file_path}. No podés proponer cambios a tu propio cerebro ni a safety.` };
  }
  try {
    const rec = await ZeusCodeRecommendation.create({
      file_path: input.file_path,
      line_start: input.line_start || null,
      line_end: input.line_end || null,
      current_code: input.current_code || '',
      proposed_code: input.proposed_code || '',
      rationale: input.rationale,
      evidence: input.evidence || {},
      evidence_summary: input.evidence_summary,
      expected_impact: input.expected_impact || '',
      category: input.category || 'other',
      severity: input.severity || 'medium',
      status: 'pending'
    });
    return {
      ok: true,
      id: rec._id.toString(),
      summary: `Recomendación creada: ${input.category}/${input.severity} en ${input.file_path}${input.line_start ? `:${input.line_start}` : ''}`
    };
  } catch (err) {
    return { error: err.message };
  }
}

const TOOL_HANDLERS = {
  query_portfolio: handleQueryPortfolio,
  query_adsets: handleQueryAdsets,
  query_tests: handleQueryTests,
  query_dnas: handleQueryDnas,
  query_actions: handleQueryActions,
  query_directives: handleQueryDirectives,
  query_insights: handleQueryInsights,
  query_hypotheses: handleQueryHypotheses,
  query_duplications: handleQueryDuplications,
  query_adset_detail: handleQueryAdsetDetail,
  query_overview_history: handleQueryOverviewHistory,
  query_time_series: handleQueryTimeSeries,
  query_brain_memory: handleQueryBrainMemory,
  query_safety_events: handleQuerySafetyEvents,
  query_creative_proposals: handleQueryCreativeProposals,
  query_ai_creations: handleQueryAICreations,
  query_ads: handleQueryAds,
  query_campaigns: handleQueryCampaigns,
  query_recommendations: handleQueryRecommendations,
  query_products: handleQueryProducts,
  query_strategic_directives: handleQueryStrategicDirectives,
  query_agent_conversations: handleQueryAgentConversations,
  ask_athena: (input) => handleAskAgent('athena', input),
  ask_apollo: (input) => handleAskAgent('apollo', input),
  ask_prometheus: (input) => handleAskAgent('prometheus', input),
  ask_ares: (input) => handleAskAgent('ares', input),
  code_overview: handleCodeOverview,
  list_code_files: handleListCodeFiles,
  read_code_file: handleReadCodeFile,
  grep_code: handleGrepCode,
  propose_code_change: handleProposeCodeChange,
  remember_preference: handleRememberPreference,
  forget_preference: handleForgetPreference,
  list_preferences: handleListPreferences,
  create_directive: handleCreateDirective,
  deactivate_directive: handleDeactivateDirective,
  query_delivery_health: handleQueryDeliveryHealth,
  create_watcher: handleCreateWatcher,
  cancel_watcher: handleCancelWatcher,
  list_watchers: handleListWatchers
};

async function executeTool(toolName, input) {
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) throw new Error(`Unknown tool: ${toolName}`);
  return await handler(input || {});
}

module.exports = {
  TOOL_DEFINITIONS,
  TOOL_HANDLERS,
  executeTool
};
