# CLAUDE.md — AI Meta Ads Controller

## Project Purpose

AI-powered autonomous Meta Ads optimization system for **Jersey Pickles** (food/ecommerce). A single Node.js process runs 24/7 collecting ad metrics, analyzing performance with multiple LLMs, generating actionable recommendations, and auto-executing optimizations on the Meta Ads account within bounded safety gates. Users interact via a React dashboard + a chat/oracle interface named **Zeus** that acts as CEO of a 5-agent team (Athena, Apollo, Prometheus, Ares, **Demeter**).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js >= 18, CommonJS (`require`/`module.exports`) |
| Backend | Express 4.18, node-cron scheduling |
| Database | MongoDB 8.0 via Mongoose ODM (pool: 10). Cluster Atlas. |
| AI | Anthropic Claude (`@anthropic-ai/sdk`) — Opus 4.7, Sonnet 4.6, Haiku 4.5. Google GenAI (image gen). OpenAI (embeddings only). |
| Frontend | React 19 + Vite 7, React Router 7, Recharts 3.7, TanStack Table v8, framer-motion, Three.js (3D orbs) |
| Auth | JWT (24h expiry), single hardcoded user |
| Ads API | Meta Marketing API v21.0 via axios + Bottleneck rate limiter (5000 pts/h) |
| Image Gen | **Google Gemini 3 Pro Image Preview** único motor operativo (desde 2026-04-24). Config `aspectRatio: '9:16' / '1:1'`, `imageSize: '2K'`. Helper compartido en `src/ai/creative/gemini-image.js` con retry 3x + exponential backoff (5s/15s/30s) y detección transient vs permanent. BFL / Freepik / xAI Grok siguen en config.env pero SIN implementación. |
| Embeddings | OpenAI `text-embedding-3-small` (solo para memoria episódica de Zeus — `src/ai/zeus/episodic-memory.js`). NO para imágenes. |
| Prompt caching | Activo en `oracle-runner.js` desde 2026-04-23 (commit `b47a51d`). System prompt persona + tools cacheadas, context dinámico sin cache. Descuento 90% input tokens post-cache hit. |
| Deployment | Render.yaml (Node runtime, 1GB upload disk) |

## Directory Structure (actual)

```
src/
├── index.js                    # Entry point — 38+ cron jobs, Zeus ecosystem boot
├── ai/
│   ├── agent/                  # Agentes especializados (los 4 reales + Ares Portfolio + CBO Monitor + Safety)
│   │   ├── account-agent.js         # Athena — budgets/bid strategy
│   │   ├── creative-agent.js        # Apollo — imagen+copy (usa gemini-image)
│   │   ├── testing-agent.js         # Prometheus — A/B tests lifecycle
│   │   ├── ares-agent.js            # Ares — duplicación de ganadores (legacy flow)
│   │   ├── ares-portfolio-manager.js# Ares Portfolio (autónomo, Fase 3 adelantada)
│   │   ├── cbo-health-monitor.js    # Monitor de salud CBO (Fase 1)
│   │   └── safety-decisions.js
│   ├── brain/                  # Brain legacy + unified
│   │   ├── unified-brain.js
│   │   ├── brain-analyzer.js
│   │   ├── brain-prompts.js
│   │   ├── diagnostic-engine.js
│   │   ├── zeus-learner.js          # Learner L1 de Zeus
│   │   ├── hypothesis-validator.js
│   │   └── impact-context-builder.js
│   ├── zeus/                   # Zeus Oracle ecosystem (L1-L5)
│   │   ├── oracle-runner.js         # Tool-use loop, streaming SSE, prompt caching
│   │   ├── oracle-tools.js          # 60+ tools Anthropic
│   │   ├── oracle-context.js        # Build context snapshot por turno
│   │   ├── oracle-proactive.js      # Cron cada 30m — emite pings con dedup
│   │   ├── agent-stance.js          # Stances diarios + teeth
│   │   ├── agent-brains.js          # Sub-agents brainstorm
│   │   ├── devils-advocate.js       # LLM adversarial crítico
│   │   ├── episodic-memory.js       # Vectores embedding (OpenAI)
│   │   ├── learner.js, hypothesis-engine.js
│   │   ├── architect.js, plan-evaluator.js, plan-propagator.js
│   │   ├── preference-detector.js
│   │   ├── rec-capacity.js          # Gate Hilo D: gradient zones, dedup, aging
│   │   ├── auto-pause-detector.js   # Hilo C
│   │   ├── auto-pause-executor.js   # Hilo C shadow/live
│   │   ├── auto-pause-maintenance.js# Hilo C ground truth + health check
│   │   ├── delivery-health.js       # Portfolio freeze detection
│   │   ├── directive-guard.js       # isAgentBlocked + isActionBlockedForAgent (granular)
│   │   ├── directive-maintenance.js # Cleanup nightly zombies
│   │   ├── response-auditor.js      # Post-hoc self-audit (Hilo B)
│   │   ├── trap-runner.js           # Adversarial traps
│   │   ├── rec-verifier.js          # Verifica que cambios propuestos se aplicaron
│   │   ├── reflection-engine.js
│   │   ├── portfolio-capacity.js    # Concurrency caps
│   │   ├── pattern-enricher.js      # Pre-save hooks time/concurrency/cohort
│   │   ├── strategic-planner.js
│   │   ├── execution-gate.js, code-tools.js, sentinel.js
│   │   └── watchers.js              # Conditional watchers
│   ├── creative/               # Apollo image + prompt pipeline
│   │   ├── gemini-image.js          # Helper único Gemini con retry robusto
│   │   ├── image-generator.js       # UI pipeline (wrapper de gemini-image)
│   │   ├── image-judge.js           # Claude Vision scoring 0-100
│   │   ├── prompt-generator.js      # Claude Vision + top performers
│   │   ├── dna-helper.js            # Hash + 5 dimensiones
│   │   └── evolution-engine.js      # exploit/mutate/crossover/explore (ratio=0 hoy)
│   ├── strategic/              # Long-term planning + research
│   └── decision-engine.js
├── meta/
│   ├── client.js                    # Meta API (rate limited, cached)
│   ├── data-collector.js            # Collection pipeline cada 10 min
│   ├── action-executor.js
│   └── helpers.js
├── db/
│   ├── connection.js
│   ├── queries.js                   # getLatestSnapshots, getSnapshotHistory, getAdsForAdSet, etc
│   └── models/                      # 44 modelos
│       # ═══ Métricas + histórico ═══
│       ├── MetricSnapshot.js        # 5 windows (today/3d/7d/14d/30d) + índices compound
│       ├── ActionLog.js             # Todas las acciones con agent_type, impact 1d/3d/7d
│       # ═══ Brain (legacy, reads activos) ═══
│       ├── BrainInsight.js, BrainRecommendation.js (writes dark desde 10-mar)
│       ├── BrainMemory.js, BrainCycleMemory.js, BrainTemporalPattern.js
│       ├── BrainKnowledgeSnapshot.js, BrainChat.js
│       # ═══ Creative + AI ═══
│       ├── CreativeAsset.js, CreativeProposal.js, CreativeDNA.js
│       ├── AICreation.js, ProductBank.js
│       ├── TestRun.js               # Prometheus A/B tests
│       # ═══ Zeus ecosystem ═══
│       ├── ZeusChatMessage.js       # Chat + cache_read/creation_tokens + partial flag
│       ├── ZeusConversation.js      # Cross-agent conversations
│       ├── ZeusDirective.js         # source (chat/learner/proactive/system) + persistent
│       ├── ZeusPreference.js, ZeusHypothesis.js
│       ├── ZeusCodeRecommendation.js# category incluye 'phase_followup'
│       ├── ZeusRecommendationOutcome.js  # T+7d measurement_method por categoría
│       ├── ZeusArchitectureProposal.js
│       ├── ZeusEpisode.js           # Memoria episódica vectorizada
│       ├── ZeusJournalEntry.js      # Principles enum (16) + calibration entries
│       ├── ZeusTrap.js              # Adversarial traps
│       ├── ZeusAgentStance.js       # Postura diaria por agente
│       ├── ZeusAuditRun.js          # Code Sentinel runs
│       ├── ZeusWatcher.js           # Conditional proactive watchers
│       ├── ZeusStrategicPlan.js, ZeusPlaybook.js
│       ├── ZeusExecutionAuthority.js # L5 authorities (OFF by default)
│       ├── ZeusAutoPauseShadowLog.js # Hilo C shadow
│       ├── ZeusAutoPauseLog.js       # Hilo C live
│       ├── CBOHealthSnapshot.js     # Monitor Fase 1 cada 2h
│       # ═══ Otros ═══
│       ├── Decision.js, AgentReport.js
│       ├── StrategicDirective.js, StrategicInsight.js
│       ├── ResearchCache.js, SafetyEvent.js
│       ├── MetaToken.js, SystemConfig.js
│       └── SeasonalEvent.js         # Calendario estacional
├── dashboard/
│   ├── server.js                   # Express port 3500
│   ├── routes/                     # 22 route files
│   │   ├── auth.js, meta-auth.js
│   │   ├── metrics.js               # SSE + live caching + fallback
│   │   ├── brain.js, briefing.js    # briefing cacheado 15min + context cacheado 60s (post-índices)
│   │   ├── ai-ops.js, agents.js, agent.js
│   │   ├── controls.js, settings.js
│   │   ├── decisions.js, actions.js
│   │   ├── creatives.js, ai-creations.js
│   │   ├── adset-creator.js, strategic.js
│   │   ├── video.js
│   │   ├── zeus.js                  # intelligence + paralelizado + /directives/:id/deactivate
│   │   ├── zeus-chat.js             # chat streaming + notifications panel + entity drill-in
│   │   ├── ares.js                  # intelligence + cbo-health + portfolio-actions
│   │   ├── testing-agent.js, creative-agent.js
│   └── frontend/                   # React 19 SPA
│       └── src/
│           ├── main.jsx, App.jsx, api.js, index.css
│           ├── pages/
│           │   ├── Login.jsx
│           │   ├── AdSetsManager.jsx     # Tabla adsets + ads
│           │   ├── BrainIntelligence.jsx # Feed/Recs/Follow-up/Knowledge/Creatives/Chat
│           │   └── BrainOS.jsx           # Neural Command Center
│           └── components/
│               ├── ZeusSpeaks.jsx        # Drawer con chat + 10+ paneles (memory, plans, coderecs, calibration, autopause, notifications, etc)
│               ├── NeuralCommandCenter.jsx
│               ├── AdSetDetailCard.jsx + AdSetDetailModal  # Drill-in adset
│               ├── EntityListTable.jsx   # TanStack Table cards densas (zeus:entity-list)
│               ├── AccountOrb/BrainOrb/ImpactOrb/ZeusOrb
│               ├── TemporalSpine.jsx, DNAGenomeSpace.jsx
│               ├── zeus-viz.jsx          # Recharts 3.7 (sparkline/metric/compare/progress)
│               └── agents/
│                   ├── ZeusPanel.jsx, AthenaPanel.jsx
│                   ├── ApolloPanel.jsx, PrometheusPanel.jsx
│                   └── AresPanel.jsx     # Resumen · Acciones · Salud CBOs · CBO 1/2/3 · Candidatos · Historial · Criterios
├── safety/
│   ├── kill-switch.js
│   ├── anomaly-detector.js
│   ├── cooldown-manager.js         # Tiered (scale 36h, pause 60h, duplicate 72h)
│   ├── guard-rail.js               # Budget limits ±25% default
│   └── platform-circuit-breaker.js # Detecta degradación Meta
├── utils/
│   ├── logger.js                   # Winston (rotación)
│   ├── retry.js
│   └── formatters.js
└── video/video-pipeline.js
config/
├── index.js                        # Central config (42 env vars)
├── safety-guards.js
├── kpi-targets.js
├── unified-policy.js
└── deep-research-priors.js
scripts/                            # Utility scripts (seed, backfill, dedup, cleanup)
```

## Cron Job Schedule (timezone America/New_York)

| Schedule | Job | Frecuencia | Propósito |
|----------|-----|------------|-----------|
| `*/10 * * * *` | Data Collection | cada 10 min | Meta API → MetricSnapshots |
| `*/15 * * * *` | Kill Switch Monitor | cada 15 min | Safety check emergencia |
| `5,20,35,50 * * * *` | AI Ops Metrics Refresh | cada 15 min | Fresh ops metrics |
| `7,22,37,52 * * * *` | Platform Circuit Breaker | cada 15 min | Meta degradación check |
| `12,42 * * * *` | Zeus Watchers | cada 30 min | Conditional proactive watchers |
| `*/30 * * * *` | Zeus Proactive | cada 30 min | Detect signals + dedup + quiet hours (23-07 ET) |
| `0 * * * *` | Anomaly Detection | hourly | Per-entity alerts |
| `0 */2 * * *` | CBO Health Monitor | cada 2h, 24/7 | Snapshots CBO como unidad (Fase 1) |
| `0 */2 * * *` | Impact Measurement | cada 2h | T+1d/3d/7d del ActionLog |
| `30 */2 * * *` | Lifecycle Manager | cada 2h | AI-created lifecycle |
| `30 */6 * * *` | Creative Metrics Sync | cada 6h | CreativeAsset avg_ctr/roas refresh |
| `0 2,4,...,22 * * *` | Account Agent (Athena) | cada 2h (11x/día) | Budget + bid strategy |
| `0 5,11,17,23 * * *` | Zeus Learner (L1) | 4x/día | Post-mortems + patterns |
| `0 7,13,19,23 * * *` | Unified Brain Cycle | 4x/día | Brain analyzer + hypothesis |
| `0 8,14,20 * * *` | Creative Agent (Apollo) | 3x/día | Gemini image generation |
| `30 6,10,14,18,22 * * *` | Testing Agent (Prometheus) | 5x/día | Test lifecycle |
| `0 8,16 * * *` | Ares Agent | 2x/día | Duplicaciones + Portfolio Manager hook |
| `0 9,17,22 * * *` | AI Manager | 3x/día | AI ad set management |
| `0 2 * * *` | Hypothesis Validator | diario 2am | Validar hipótesis ≥7d |
| `0 2 * * *` | Cleanup | diario 2am | Delete snapshots >90d |
| `0 3 * * *` | Token Health Check | diario 3am | Meta API token refresh |
| `0 3 * * *` | Directive Cleanup | diario 3am | Expired non-persistent → active=false |
| `30 4 * * *` | Code Sentinel daily | diario 4:30am | 3 sub-lenses (security/silent/config) |
| `0 5 * * *` | Agent Stances Verdict | diario 5am | Verdict retroactivo stances ≥7d |
| `0 6 * * *` | Morning Briefing Context | diario 6am | Refresh briefing Claude |
| `30 6 * * *` | Prometheus Stance Briefing | diario 6:30am | Morning postura Prometheus |
| `0 7 * * *` | (misc 7am job) | diario | |
| `0 9 * * *` | AI Manager Post-overnight | diario 9am | Revisión post-night |
| `0 9 * * 0` | Sentinel Weekly | domingo 9am | 5 sub-lenses full |
| `30 11 * * 0` | Architect Weekly | domingo 11:30am | Lens 3 architecture proposals |
| `0 11 * * 0` | Reflection Engine | domingo 11am | Journal + playbooks |
| `0 10 * * 0` | Episodic Memory Consolidation | domingo 10am | |
| `0 12 * * 0` | Weekly Plan Generation | domingo 12pm | Strategic planner |
| `0 8 * * 1` | Weekly Plan Followup | lunes 8am | Eval goals + milestones |
| `55 23 * * *` | Brain Knowledge Snapshot | diario 23:55 | State capture |
| `0 4 * * *` | Plan Health Check | diario 4am | |
| `0 8 1 * *` | Monthly Plan | mensual | |
| `0 9 1 2,5,8,11 *` | Quarterly Plan | trimestral | |
| `0 9 1 1,4,7,10 *` | Quarterly Eval | trimestral | |
| `*/2 * * * *` | Auto-Pause Detector (Hilo C) | cada 2 min | Bounded drain detection (SHADOW por default) |
| `5 0 * * *` | Demeter Snapshot | diario 00:05 ET | Cash reconciliation Shopify ↔ Meta |
| `*/30 * * * *` | Warehouse Throttle | cada 30min | Tiered ROAS gating + crea/desactiva ZeusDirective |

**Total**: ~40 crones. Timezone: America/New_York (ET).

## Code Conventions

### JavaScript Style
- **Module system**: CommonJS
- **Semicolons**: siempre
- **Quotes**: simples para strings, template literals para interpolación
- **Async**: `async`/`await`, nunca Promise chains raw
- **Naming**: camelCase funciones, PascalCase classes/models, UPPER_SNAKE constantes, kebab-case archivos
- **Private methods**: prefijo `_` (ej. `_computeOverallDiagnosis`)
- **Error handling**: try-catch en todos los route handlers + cron jobs
- **Queries**: `.lean()` en read-only MongoDB queries
- **Paralelización**: `Promise.all` para queries independientes (cuello común de performance)

### Comments & Language
- **Comentarios en español** (codebase bilingüe)
- **UI text en español** ("Anomalía", "Tendencia", "Oportunidad")
- **Ad copy en inglés** (mercado US)
- **Variable names en inglés**

### Frontend Patterns
- React 19 funcional components only
- State: useState + Context (sin Redux/Zustand)
- Lazy loading para componentes 3D (`React.lazy` + Suspense)
- CSS custom properties + utility classes BEM-inspired, dark theme only
- SSE para streaming chat y live metrics
- TanStack Table v8 headless para entity lists
- framer-motion para animaciones
- Recharts 3.7 para sparklines/charts

### Backend Patterns
- **Circuit breaker** en data collection (3-failure backoff) + platform-level para Meta
- **Rate limiting**: Bottleneck 5000 pts/h Meta API
- **Caching tiers**: 55s insights, 90s daily insights, 60s briefing context, 15min briefing Claude, 5min prompt cache Anthropic
- **Cooldowns tiered**: 24-72h per action type
- **Paralelización**: queries independientes en Promise.all (ver `zeus.js:/intelligence`, `briefing.js`)

## Zeus Ecosystem (CEO del sistema)

Zeus es el layer de alto nivel que coordina los 4 agentes especializados. Operativo en 5 niveles:

- **L1 Learner** — post-mortems 7/30/90d, aprende de outcomes
- **L2 Hypothesis Architect** — hipótesis testeables con bayesian validation
- **L3 Strategic Mind** — planes multi-horizonte (weekly/monthly/quarterly)
- **L4 Meta-cognitive** — journal + playbooks + reflection
- **L5 Autonomous Partner** — authorities scaffolded, **OFF by default**

### Modos de conversación (persona)
- **ANALISTA** — responde con data, tool calls, viz inline
- **CONVERSACIÓN** — opinión estratégica sin tools, texto plano
- **MIXTO** — híbrido según juicio del contexto

### REGLA #1 (scope drift)
Cada turno pre-respuesta Zeus valida: ¿qué preguntó el creador? ¿mi respuesta agrega temas no pedidos? → corta. Previene scope drift sistemático.

### Tools disponibles (~62 tools)
`query_portfolio`, `query_adsets`, `query_ads`, `query_campaigns`, `query_tests`, `query_dnas`, `query_actions`, `query_directives`, `query_insights`, `query_hypotheses`, `query_duplications`, `query_adset_detail`, `query_overview_history`, `query_time_series`, `query_brain_memory`, `query_safety_events`, `query_agent_conversations`, `query_recommendations`, `query_products`, `query_strategic_directives`, `query_agent_stances`, `query_similar_episodes`, `query_rec_capacity`, `query_delivery_health`, `create_directive`, `deactivate_directive`, `override_agent_stance`, `get_devils_advocate`, `propose_code_change`, `propose_architecture_change`, `create_watcher`, etc.

### zeus:// URL protocol
Links inline tipo `[name](zeus://adset/<id>)` en markdown. `zeus://adset/<id>` abre `AdSetDetailModal` con 4 tabs (Métricas/Ads/Historial/Memoria). También: `zeus://ad/<id>`, `zeus://campaign/<id>`, `zeus://test/<id>`, `zeus://dna/<hash>`, `zeus://product/<slug>`, `zeus://rec/<id>`, `zeus://agent/<athena|apollo|prometheus|ares>`.

### Bloques estructurados en chat
- `` ```zeus:sparkline `` — trend temporal
- `` ```zeus:metric `` — métrica destacada + delta
- `` ```zeus:compare `` — barras horizontales
- `` ```zeus:progress `` — gauge hacia meta
- `` ```zeus:entity-list `` — cards densas (reemplaza markdown tables colapsadas) con sort/sparkline/badges

### Panel 🔔 Notificaciones (separado del chat)
Desde 2026-04-23 los proactive pings NO se mezclan con el chat flow. Viven en panel dedicado accesible via command palette (botón ☰ en drawer). Chat queda limpio para conversación real.

### Quiet hours ET
Cron proactive respeta 23:00–07:00 ET — solo `safety_event critical` + `watcher_triggered` rompen el silencio nocturno. El resto acumula y se consolida en un ping único al primer ciclo post-07:00.

### Dedup por kind + entity
Oracle proactive hace dedup por:
- Entidad mencionada en content/title (últimas 4h)
- Kind agregado (stale_recs, bulk_kills, kill_switch, watcher_triggered, etc) si se emitió en ventana

## Pantheon de agentes (5 reales)

### Athena (Account Agent) — `account-agent.js`
Ajustes de budget + bid strategy. Ejecuta scale_up/scale_down autónomo con safety gates. 11x/día. **Granular directive enforcement** (2026-04-28): los 4 handlers mutadores (`handleScaleBudget`, `handlePauseAd`, `handleReactivateAd`, `handlePauseAdSet`) chequean `isActionBlockedForAgent('athena', <action>)` al inicio. Mismo patrón que Ares Portfolio.

### Apollo (Creative Agent) — `creative-agent.js`
Detecta fatiga (freq>2.5, CTR<0.5%), genera imágenes con **Gemini 3 Pro Image Preview** + copy con Claude. 3x/día. **Housekeeping pre-directive** (2026-04-28): expiry de proposals stale (>48h) corre en Fase 0 antes del directive-guard, así una directiva "no generes" no deja el pool acumulándose.

### Prometheus (Testing Agent) — `testing-agent.js`
Lifecycle de A/B tests: learning → evaluating → graduated/killed/expired. Morning stance con teeth (max_launches, kill_threshold). 5x/día + stance 6:30am. Tracking post-graduation (graduó X / hoy Y / Δ%).

### Ares (3 capas: legacy + Portfolio + Brain LLM)
- **Ares legacy** (`ares-agent.js`): duplica ganadores (ROAS≥3 + spend≥$500 + 30+ conv + freq<2 + 21d). Duplicates ahora ACTIVE automático.
- **Ares Portfolio Manager** (`ares-portfolio-manager.js`): 4 detectores autónomos procedural con safety gates:
  - `starved_winner_rescue` → duplica a CBO rescate (ROAS>2 + spend_share<3%)
  - `underperformer_kill` → pausa (spend>$50 + 0 conv + >5d edad + no LEARNING)
  - `cbo_saturated_winner` → scale_up +15% budget CBO
  - `cbo_starvation` → scale_up al target pulse (cap primera semana +$100)
- **Ares Brain LLM** (`ares-brain/`): Claude Sonnet 4.6 + tools propios (scale_cbo, pause_adset, duplicate_to_cbo, create_new_cbo). Learning loop con outcomes T+7d + guidance de Zeus inyectado en próximo ciclo.
- Respeta `isActionBlockedForAgent` granular (directiva "no duplications" NO bloquea kills/scales).
- Feature flag `ARES_PORTFOLIO_AUTONOMOUS` (default ON).

### Demeter (Cash Reconciliation Agent) — `demeter-agent.js`
**Quinto agente, incorporado 2026-04-25**. Reconcilia Meta atribución (`meta_roas`) vs cash real al banco (`cash_roas`) considerando Shopify fees, refunds, descuentos, shipping, taxes. Cron diario 00:05 ET → `DemeterSnapshot` con breakdown completo. Shadow mode con Opus consulta cash awareness ANTES que el brain decida scale_ups (`Meta dice 4x` pero `cash dice 2x` → flag). `DemeterPanel` con tabs por mes + cascada lineal Gross → minus(Discounts/Refunds/Fees/Shipping/Tax) → Net for Merchant + forecast del mes en curso.

### CBO Health Monitor — `cbo-health-monitor.js`
Cron propio cada 2h. Analiza CBOs como unidad (no solo adsets). Detecta zombies, colapsos, saturación, starvation. Persiste `CBOHealthSnapshot` (TTL 45d). Filtro stale 6h (ignora campaigns que Meta ya no reporta). Fase 2 (gate compuesto en Ares) pendiente — rec `phase_followup` target 29-abr.

## Key Architecture Concepts

### Data Flow
```
Meta API → DataCollector → MetricSnapshot → BrainAnalyzer → BrainInsight
                                        → DiagnosticEngine → UnifiedBrain (legacy) → Claude
                                                         → AdaptiveScorer
                                        → CBO Health Monitor → CBOHealthSnapshot
                                        → 4 agents (Athena/Apollo/Prometheus/Ares) → ActionLog
                                        → Impact Measurement → Zeus Learner → Directives + Stances
                                        → Zeus Oracle (chat + proactive) → creator
```

### BrainRecommendation — status pipeline dark
**Writes DARK en producción desde 2026-03-10** (commit `3124601`). El modelo sigue en uso como audit trail read-only. El rol accionable fue asumido por:
- `ZeusCodeRecommendation` (panel 💡 Code Recs)
- Ejecución táctica directa de Athena/Ares Portfolio
- Stances diarios de Prometheus
- Auto-pause bounded (Hilo C)

### Hilos B/C/D (sistemas horizontales de Zeus)

**Hilo B — Response Calibration** (`20 - Response Calibration`)
- PRINCIPLES enum de 16 valores en `ZeusJournalEntry`
- Post-hoc auditor en `response-auditor.js` (corre tras cada turno)
- Turn-level linter `unverified_self_assertion` para detectar claims sin backing
- Archive: 4 goldens + 3 anti-references seeded con casos reales
- Trap runner adversarial

**Hilo C — Auto-Pause Bounded**
- `auto-pause-detector.js` con 5 filtros duros (spend>$100 + 72h+ edad + ROAS 3d<0.3x + etc)
- `auto-pause-executor.js` dry-run (SHADOW) vs live
- `auto-pause-maintenance.js` ground truth + health check
- Panel 🎚️ + toggle shadow→live manual cuando shadow clean ≥7d
- Default: SHADOW mode

**Hilo D — Rec Capacity Gate**
- `rec-capacity.js` con gradient zones (green/yellow/red) por `pending_eff`
- Dedup por `pattern_hash` (target + type + keywords)
- Red-state aging 72h (archiva pending no-tocadas)
- Hysteresis 24h post-green (evita flapping)
- Cron diario 9am ET
- Phase 3 T+7d re-framing: `measurement_method` por categoría (kpi_delta/log_firings/regression_check/manual/inconclusive)

### Safety System
- **Kill switch**: auto-pause ALL si ROAS<0.5x, CPA>3x, daily loss>$1000
- **Budget limits**: $5000 daily ceiling, ±25% per change default (Ares Portfolio usa 50% cap específico)
- **Cooldowns tiered**: 24h create_ad → 72h pause/duplicate. Tiered en `cooldown-manager.js`.
- **Portfolio capacity**: max_active_adsets=200, max_scale_24h=15, max_dup_24h=8, etc.
- **Platform circuit breaker**: detecta spend_collapsed, mass_with_issues, silent_freeze. Baseline 7d refrescado solo si healthy.
- **Directive guard granular**: `isActionBlockedForAgent(agent, action_type)` con dos prioridades: (1) `action_scope: [string]` estructurado en la directiva, (2) fallback parse del texto. Campo `llm_can_override` boolean para directivas que el LLM puede ignorar con justificación.
- **Warehouse Throttle** (`src/safety/warehouse-throttle.js`): cron 30min checkea daily revenue vs target. Si revenue ≥ target × 1.05 → activa throttle. Tiered: ROAS≥5x permite scale_up moderado, <5x freeze. Cuando activa, crea `ZeusDirective` con `action_scope: ['scale_up', 'duplicate_adset']` para `target_agent: 'all'` → todos los agentes lo respetan via `isActionBlockedForAgent`. Auto-deactivate al volver a verde.
- **Anomaly detection**: 50% ROAS drop, 2.5x spend spike (alerts only)
- **Autonomy modes**: manual | semi_auto | auto

## KPI Targets (Jersey Pickles)
- **ROAS**: target 3.0x, minimum 1.5x, excellent 5.0x+
- **CPA**: target $25
- **CTR**: minimum 1.0%
- **Frequency**: warning 2.5, critical 4.0
- **Daily spend**: ~$3,000 target

## Development Commands
```bash
npm run dev          # Backend con nodemon
npm run dashboard    # Dashboard server (port 3500)
npm run build        # Build React frontend (Vite)
npm test             # Jest con coverage
npm run backfill     # Backfill histórico de métricas
npm run seed         # Seed config a MongoDB
```

## Environment Variables (42 total)

**Key groups**:
- **Meta API**: `APP_ID`, `APP_SECRET`, `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`
- **Anthropic**: `ANTHROPIC_API_KEY` (único proveedor LLM primario)
- **Image generation**: `GOOGLE_AI_API_KEY` (único motor operativo — Gemini 3 Pro Image Preview)
- **Embeddings**: `OPENAI_API_KEY` (solo para episodic memory, NO para imágenes)
- **MongoDB**: `MONGODB_URI` (Atlas cluster)
- **Dashboard**: `DASHBOARD_PORT`, `DASHBOARD_SECRET`, `DASHBOARD_USER`, `DASHBOARD_PASSWORD`
- **Search**: `BRAVE_SEARCH_API_KEY`, `SERP_API_KEY`
- **Vestigiales** (env definidas sin código): `BFL_API_KEY`, `FREEPIK_API_KEY`, `XAI_API_KEY` — en config/env pero ningún archivo las consume. Dejadas por si se decide implementar fallback multi-motor futuro.
- **Feature flags**: `ARES_PORTFOLIO_AUTONOMOUS` (ON default), `ARES_RESCUE_CBO_ID` (opcional)

## Important Implementation Notes

### Anti-patterns a evitar
- No agregar pause bias (el diagnostic engine + system prompt rules están balanceados)
- No tocar entities en learning phase (<72h para ads, configurable para adsets)
- No skipear cooldown checks (previenen thrashing)
- No generar recs para entidades con <$5 weekly spend
- No emitir signals proactivos en quiet hours (23-07 ET) salvo critical real
- No usar `$regex` sobre colecciones grandes sin índice prefix

### When Modifying AI Prompts
- Zeus persona: `oracle-runner.js:ZEUS_PERSONA`. REGLA #1 al top (scope drift). Bloque estable cacheado con `cache_control: ephemeral`, dinámico sin cache.
- Stances: `agent-stance.js` (morning briefings con disciplina 2 pros + 2 cons)
- Devil's advocate: `devils-advocate.js` (crítico adversarial)
- Response calibration: taxonomía en `ZeusJournalEntry.PRINCIPLES` (16 valores)

### When Adding New Action Types
1. Agregar a `BrainRecommendation.action_type` enum (aún útil para audit trail)
2. Agregar a `ACTION_TYPE_CONFIG` en `BrainIntelligence.jsx`
3. Agregar cooldown tier en `cooldown-manager.js`
4. Agregar a system prompt allowed actions
5. Si afecta budget: validar en `guard-rail.js`
6. Agregar keyword match en `directive-guard.js:parseBlockedActions` si la acción puede ser bloqueada por directivas

### Database Considerations
- Snapshots >90 días auto-deleted (cleanup cron 2am)
- CBOHealthSnapshot TTL 45d automático
- Todas las time-series queries deben usar índices (entity_id + snapshot_at compound existe)
- Índices compound críticos:
  - `MetricSnapshot.{entity_type, learning_stage, snapshot_at}` (post 2026-04-24)
  - `MetricSnapshot.{campaign_id, entity_type, snapshot_at}`
  - `CreativeProposal.{created_at, evolution_strategy}` (post 2026-04-24)
- Nunca hacer `$regex` sin índice prefix sobre colecciones grandes

### Sessions intensivas recientes (últimas 2 semanas)
- **2026-04-22 AM**: Stances + Platform Resilience + Devil's Advocate + Episodic Memory
- **2026-04-22 PM**: Response Calibration (Hilo B) + Auto-Pause Bounded (Hilo C) + Rec Capacity (Hilo D) + fix scope-drift + history loading fix
- **2026-04-22 noche**: Adset drill-in modal + zeus:entity-list + 3 bugs pipeline mensajes + fix learner (source + granularity) + tiers UI directivas + CBO Health Monitor Fase 1
- **2026-04-23**: Ares Portfolio Manager autónomo + gemini-image helper unificado + perf briefing (19s→2s con índices + cache) + prompt caching Zeus + panel 🔔 notificaciones + quiet hours
- **2026-04-24**: Ares Brain LLM (4 commits: tools READ-ONLY → action tools → safety enforcement → learning loop) + Neural Command Center estilo Obsidian con D3 + `action_scope` estructurado en directivas
- **2026-04-25/26**: **Demeter** — quinto agente operativo (5 commits build + DemeterPanel + cascada cash flow + forecast del mes + shadow mode con Opus + backfill optimizado N²→linear)
- **2026-04-26**: Warehouse Throttle (backend + UI + bug histórico last_1d→last_3d + cobertura completa via Zeus directive con action_scope) + Ares duplicates ACTIVE auto + path traversal hardening creatives
- **2026-04-27/28**: Voseo→tuteo neutro en 5 archivos (parcial, 7 archivos pendientes en `src/ai/zeus/`) + Demeter orb alineado a MTD + Apollo pool housekeeping pre-directive + Athena report fixes (truncado smart + action types completos) + Athena chequeo granular de directivas en los 4 handlers + Render MCP server instalado para diagnostics directos

### Vault Obsidian (documentación viva paralela)
Notas indexadas 01-23 en `AI Meta Ads Controller/` del vault Obsidian (path: `/Users/thompson/AshVault/`). Actualizadas en sync con commits mayores. Incluye roadmap, pendientes con deadlines, hilos B/C/D detallados, historial de evolución por fases. Ver `00 - Index.md`.

### Render MCP server (para Claude Code)
Instalado vía `claude mcp add --transport http render-mcp-server https://mcp.render.com/mcp --header "Authorization: Bearer <KEY>"`. Da acceso a: `list_services`, `get_service`, `list_deploys`, `get_deploy`, `list_logs`, `get_metrics`, `query_render_postgres`, etc (14 tools read-only auto-allowed en `.claude/settings.local.json`). Tools mutadoras (`create_*`, `update_environment_variables`) requieren approval manual. Permite que Claude lea logs prod, verifique deploys, ejecute SQL read-only directo sin que el creador haga relay manual del output.

### Convenciones de voz/idioma en prompts
- **Español neutro latinoamericano** (tuteo, sin voseo argentino ni "po" chileno).
- Razón: el creador es chileno y prefiere voz neutra para personas/prompts.
- Cleanup parcial al 2026-04-28: hecho en `oracle-runner.js`, `oracle-proactive.js`, `devils-advocate.js`, `agent-brains.js`, `agent-stance.js`. Pendiente en `weekly-audit.js`, `reflection-engine.js`, `oracle-tools.js` (descriptions), `oracle-context.js`, `strategic-planner.js`, `preference-detector.js`, `sentinel-lenses/*`.
