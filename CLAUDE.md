# CLAUDE.md — AI Meta Ads Controller

## Project Purpose

AI-powered autonomous Meta Ads optimization system for **Jersey Pickles** (food/ecommerce). A single Node.js process runs 24/7 collecting ad metrics, analyzing performance with Claude AI, generating actionable recommendations, and optionally auto-executing optimizations on the Meta Ads account. Users interact via a React dashboard.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js >= 18, CommonJS (`require`/`module.exports`) |
| Backend | Express 4.18, node-cron scheduling |
| Database | MongoDB 8.0 via Mongoose ODM (pool: 10) |
| AI | Anthropic Claude (`@anthropic-ai/sdk`), OpenAI (image gen), Google GenAI |
| Frontend | React 19 + Vite 7, React Router 7, Recharts, Three.js (3D orbs) |
| Auth | JWT (24h expiry), single hardcoded user |
| Ads API | Meta Marketing API v21.0 via axios + Bottleneck rate limiter |
| Image Gen | OpenAI gpt-image-1.5, BFL FLUX 2 Pro, Freepik Seedream, xAI Grok |
| Deployment | Render.yaml (Node runtime, 1GB upload disk) |

## Directory Structure

```
src/
├── index.js                    # Main entry — 11+ cron jobs, circuit breaker
├── ai/
│   ├── brain/
│   │   ├── unified-brain.js        # Core decision engine (runs 4x/day)
│   │   ├── brain-analyzer.js       # Continuous analysis + 6h recommendations
│   │   ├── brain-prompts.js        # System/user prompts for Claude
│   │   ├── diagnostic-engine.js    # Math-based pattern detection
│   │   └── impact-context-builder.js
│   ├── unified/
│   │   ├── policy-learner.js       # Thompson Sampling (contextual bandit)
│   │   ├── adaptive-scorer.js      # Multi-dimensional recommendation scoring
│   │   ├── feature-builder.js      # Feature extraction per entity
│   │   ├── attribution-model.js    # Multi-touch impact attribution
│   │   └── statistical-confidence.js
│   ├── agents/                     # Legacy agents (superseded by Brain)
│   │   ├── base-agent.js, agent-runner.js
│   │   ├── scaling-agent.js, performance-agent.js
│   │   ├── creative-agent.js, pacing-agent.js
│   │   └── budget-agent.js
│   ├── adset-creator/
│   │   ├── manager.js              # Autonomous AI ad set management
│   │   └── strategist.js
│   ├── creative/                   # Image gen + judging
│   ├── strategic/                  # Long-term planning + research
│   ├── lifecycle-manager.js        # AI-created entity lifecycle
│   └── decision-engine.js
├── meta/
│   ├── client.js                   # Meta API client (rate limited, cached)
│   ├── data-collector.js           # Optimized collection pipeline
│   ├── action-executor.js          # Executes Meta API actions
│   └── helpers.js
├── db/
│   ├── connection.js
│   ├── queries.js
│   └── models/                     # 19 Mongoose models
│       ├── MetricSnapshot.js       # Entity metrics (5 time windows)
│       ├── ActionLog.js            # Executed actions + impact (1d/3d/7d)
│       ├── BrainInsight.js         # Real-time observations (every 10 min)
│       ├── BrainRecommendation.js  # Actionable recs (every 6h, multi-phase follow-up)
│       ├── BrainMemory.js          # Per-entity long-term memory
│       ├── BrainCycleMemory.js     # Per-cycle conclusions + hypotheses
│       ├── BrainTemporalPattern.js # Day-of-week performance norms
│       ├── BrainKnowledgeSnapshot.js # Daily state captures
│       ├── BrainChat.js            # Chat history with Brain
│       ├── CreativeAsset.js        # Image/video assets + performance
│       ├── AICreation.js           # AI-created entities + lifecycle
│       ├── Decision.js, AgentReport.js
│       ├── StrategicDirective.js, StrategicInsight.js
│       ├── ResearchCache.js, SafetyEvent.js
│       ├── MetaToken.js, SystemConfig.js
│       └── ...
├── dashboard/
│   ├── server.js                   # Express on port 3500
│   ├── routes/                     # 16 route files
│   │   ├── auth.js, meta-auth.js
│   │   ├── metrics.js              # SSE + live caching + fallback
│   │   ├── brain.js                # Insights, recs, follow-ups, chat
│   │   ├── ai-ops.js              # Operational metrics refresh
│   │   ├── agents.js, controls.js, settings.js
│   │   ├── decisions.js, actions.js
│   │   ├── creatives.js, ai-creations.js
│   │   ├── adset-creator.js, strategic.js
│   │   └── video.js
│   └── frontend/                   # React 19 SPA
│       └── src/
│           ├── main.jsx, App.jsx   # Entry + routing + AuthContext
│           ├── api.js              # Centralized axios client (interceptors, SSE)
│           ├── index.css           # Full design system (CSS variables, dark theme)
│           ├── pages/
│           │   ├── Login.jsx
│           │   ├── AdSetsManager.jsx    # Main dashboard (ad sets + ads)
│           │   └── BrainIntelligence.jsx # 6 tabs: Feed, Recs, Follow-up, Knowledge, Creatives, Chat
│           └── components/
│               ├── AccountOrb.jsx       # 3D account health
│               ├── BrainOrb.jsx         # 3D neural activity
│               ├── ImpactOrb.jsx        # 3D win rate tracking
│               └── BrainKnowledgeOrb.jsx
├── safety/
│   ├── kill-switch.js              # Emergency account pause
│   ├── anomaly-detector.js         # Per-entity anomaly detection
│   ├── cooldown-manager.js         # 24-72h action cooldowns
│   └── guard-rail.js               # Budget limits + validation
├── utils/
│   ├── logger.js                   # Winston (file rotation + console)
│   ├── retry.js                    # Exponential backoff + jitter
│   └── formatters.js               # Currency, percent, ROAS formatting
└── video/
    └── video-pipeline.js
config/
├── index.js                        # Central config (loads .env)
├── safety-guards.js                # Budget ceilings, kill switch thresholds
├── kpi-targets.js                  # ROAS 3.0x target, CPA $25, frequency limits
├── unified-policy.js               # Scoring weights, bandit priors, diversity
└── deep-research-priors.js
scripts/
├── test-connection.js, backfill-metrics.js, seed-config.js
```

## Cron Job Schedule (all ET timezone)

| Job | Frequency | Purpose |
|-----|-----------|---------|
| Data Collection | Every 10 min | Meta API → MetricSnapshots, triggers BrainAnalyzer |
| Brain Recommendations | 4x/day (6am/12pm/6pm/12am) | Generate actionable recommendations |
| Brain Cycle | 4x/day (7am/1pm/7pm/11pm) | Unified decision engine |
| AI Manager | 3x/day (9am/5pm/10pm) | Autonomous AI ad set management |
| Impact Measurement | Every 2h | Measure 1d/3d/7d impact of actions |
| Lifecycle Manager | Every 2h | AI-created entity phase transitions |
| AI Ops Refresh | Every 15 min | Fresh operational metrics |
| Kill Switch | Every 15 min | Emergency safety check |
| Anomaly Detection | Hourly | Per-entity anomaly alerts |
| Creative Metrics Sync | Every 6h | Update creative asset performance |
| Knowledge Snapshot | Daily 11:55 PM | Daily brain state capture |
| Cleanup | Daily 2 AM | Delete snapshots >90 days |

## Code Conventions

### JavaScript Style
- **Module system**: CommonJS (`require`/`module.exports`) — no ESM
- **Semicolons**: Always used
- **Quotes**: Single quotes for strings, template literals for interpolation
- **Async**: Always `async`/`await`, never raw Promise chains
- **Naming**: camelCase functions, PascalCase classes/models, UPPER_SNAKE constants, kebab-case files
- **Private methods**: Prefixed with `_` (e.g., `_computeOverallDiagnosis`)
- **Error handling**: try-catch in all route handlers and cron jobs
- **Queries**: `.lean()` for read-only MongoDB queries

### Comments & Language
- **Comments in Spanish** throughout (bilingual codebase)
- **UI text in Spanish** ("Anomalía", "Tendencia", "Oportunidad")
- **Ad copy in English** (target market is US/English-speaking)
- **Variable names in English**

### Frontend Patterns
- **React 19** with functional components only (no class components)
- **State**: `useState` + Context API (no Redux/Zustand)
- **3D components**: Lazy loaded with `React.lazy()` + Suspense
- **Styling**: CSS custom properties for theming, utility classes (BEM-inspired), dark theme only
- **API client**: Centralized axios instance with token interceptor + 401 auto-redirect
- **Real-time**: SSE (Server-Sent Events) for live metrics + streaming chat

### Backend Patterns
- **Circuit breaker** on data collection (3-failure backoff)
- **Rate limiting**: Bottleneck (5,000 pts/hour cap for Meta API)
- **Caching**: 55s insights cache, 90s daily insights cache
- **Cooldowns**: Tiered per action type (24-72h)

## Key Architecture Concepts

### Data Flow
```
Meta API → DataCollector → MetricSnapshot → BrainAnalyzer → BrainInsight
                                         → DiagnosticEngine → UnifiedBrain → Claude
                                                           → AdaptiveScorer → BrainRecommendation
                                                                           → User Approval → ActionExecutor → Meta API
                                                                           → Impact Measurement → PolicyLearner (reward)
```

### Brain System (3 layers)
1. **DiagnosticEngine** — Pure math: funnel analysis, fatigue scoring, saturation detection, ad health
2. **Claude AI** — Interprets diagnostics + context → generates recommendations
3. **AdaptiveScorer** — Enriches with Thompson Sampling bias + risk/uncertainty scoring

### Thompson Sampling (Contextual Bandit)
- **Context buckets**: ROAS band × CPA band × Frequency × Spend × Conversions × Hour × Season × Account stress
- **Prior**: Beta-Binomial (alpha=1, beta=1)
- **Reward**: 0.7 × ROAS_delta + 0.3 × CPA_delta + action modifiers, clipped to [-1, +1]
- **Concurrent action discount**: reward × 1/(1 + overlap_count)
- **State persisted** in SystemConfig (survives restarts)

### Recommendation Lifecycle
```
pending → approved → (executed via Meta API) → follow-up phases:
  day_3 (early signal) → day_7 (stabilized) → day_14 (full impact + AI analysis)
```

### Entity Types in Recommendations
- `entity_type: 'adset'` — Standard ad set level recommendations
- `entity_type: 'ad'` — Individual ad pause/action (with `parent_adset_id` reference)

### Safety System
- **Kill switch**: Auto-pause ALL if ROAS < 0.5x, CPA > 3x, daily loss > $1,000
- **Budget limits**: $5,000 daily ceiling, ±25% per change, 20% daily account change max
- **Cooldowns**: 24h (create_ad) to 72h (pause/reactivate) per entity
- **Anomaly detection**: 50% ROAS drop, 2.5x spend spike (alerts only, auto_pause disabled)
- **Autonomy modes**: manual | semi_auto | auto

## KPI Targets (Jersey Pickles)
- **ROAS**: Target 3.0x, minimum 1.5x, excellent 5.0x+
- **CPA**: Target $25
- **CTR**: Minimum 1.0%
- **Frequency**: Warning 2.5, critical 4.0
- **Daily spend**: ~$3,000 target

## Development Commands
```bash
npm run dev          # Backend with nodemon
npm run dashboard    # Dashboard server
npm run build        # Build React frontend (Vite)
npm test             # Jest with coverage
npm run test:watch   # Jest watch mode
npm run backfill     # Backfill historical metrics
npm run seed         # Seed config to MongoDB
```

## Environment Variables (42 total)
Key groups: Meta API (APP_ID, APP_SECRET, ACCESS_TOKEN, AD_ACCOUNT_ID), Anthropic (ANTHROPIC_API_KEY), MongoDB (MONGODB_URI), Dashboard (DASHBOARD_PORT, SECRET, USER, PASSWORD), Image Gen (OPENAI_API_KEY, BFL_API_KEY, FREEPIK_API_KEY, XAI_API_KEY), Search (BRAVE_SEARCH_API_KEY, SERP_API_KEY).

## Important Implementation Notes

### Anti-patterns to Avoid
- Don't add pause bias to the system — the diagnostic engine + system prompt rules are carefully balanced
- Don't touch entities in learning phase (<72h for ads, configurable for ad sets)
- Don't skip cooldown checks — they prevent thrashing
- Don't generate recommendations for entities with <$5 weekly spend

### When Modifying AI Prompts
- Zeus prompts: `src/ai/zeus/oracle-runner.js` (ZEUS_PERSONA), `src/ai/zeus/agent-stance.js` (morning briefings), `src/ai/zeus/devils-advocate.js` (critic)
- UnifiedBrain prompt: `src/ai/brain/unified-brain.js` + `src/ai/prompts.js`
- Response calibration principles: ver notas del Hilo B + taxonomía en `ZeusJournalEntry.PRINCIPLES`

### BrainRecommendation pipeline — status actual (22-abr-2026)

**Writes DARK en producción desde 2026-03-10** (commit `3124601`, refactor que eliminó el viejo cron `jobBrainRecommendations`).

Causa arquitectónica: `jobAgentsCycle` (4x/día) con `agent_mode='unified'` (default) llama a `brain.analyzeAndLearn()` que **solo** procesa impact feedback y temporal patterns — NO invoca `_saveToBrainRecommendations()`. El código de escritura vive solo en `brain.runCycle()`, que se ejecuta con `agent_mode='legacy'`. El refactor de marzo asumió que jobAgentsCycle cubría ambas cosas, pero el path quedó huérfano.

**Reads siguen activos** — el modelo se consulta en `impact-context-builder.js`, `brain-analyzer.js` (follow-ups, approved/pending queries), frontend, y `oracle-proactive.js` (hasta hoy — ahora cuenta `ZeusCodeRecommendation` en lugar).

**Estado práctico**: las BrainRecommendations históricas son read-only audit trail. El rol que cumplían está cubierto por: Zeus `ZeusCodeRecommendation` (panel 💡), Athena ejecución táctica directa, stances diarios, auto_pause bounded.

**Para re-habilitar writes** (si alguna vez se decide): agregar al final de `unified-brain.js:analyzeAndLearn()` una invocación equivalente a `_saveToBrainRecommendations(recs, cycleId, sharedData, usage)` con una generación propia previa, O switchar `agent_mode` a 'legacy' en `SystemConfig`.

**Dead code eliminado 2026-04-22** (`97691cb` etc): `brain-analyzer.js::generateRecommendations`, `_getRecommendationSystemPrompt`, `_buildRecommendationPrompt`, `_parseRecommendationResponse` — 528 líneas sin callers.

### When Adding New Action Types
1. Add to `BrainRecommendation.action_type` enum
2. Add to `ACTION_TYPE_CONFIG` in `BrainIntelligence.jsx`
3. Add cooldown tier in `cooldown-manager.js`
4. Add to system prompt's allowed actions list
5. Add reward modifiers in `policy-learner.js`

### Database Considerations
- Snapshots older than 90 days are auto-deleted (cleanup cron)
- All time-series queries should use indexed fields (entity_id + created_at)
- BrainRecommendation has compound indexes for status + created_at queries
