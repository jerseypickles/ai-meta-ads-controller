# Plan: Agente Estrategico IA con Conocimiento Profundo

## Problema Actual

El Unified Policy Agent es 100% algoritmico (reglas if/else + scoring matematico).
No usa Claude API. Solo sabe hacer 4 acciones: scale_up, scale_down, pause, reactivate.
No "piensa", no investiga, no da recomendaciones estrategicas de alto nivel.

Los 4 agentes especializados si usan Claude pero estan desconectados del flujo principal
y sus prompts son limitados a budget/performance basico.

El sistema NO lee contenido creativo (texto, imagenes, headlines de los ads).
El sistema NO busca informacion en la web.

## Objetivo

Construir un **Agente Estrategico IA** que funcione como un media buyer experto:

- Use Claude como cerebro central con conocimiento profundo de Meta Ads
- Investigue en la web (Google) sobre tendencias, cambios en Meta, mejores practicas
- Lea el contenido creativo real de los ads (texto, headlines, descripciones)
- De recomendaciones de alto nivel estrategico, no solo budget up/down
- Se integre con el flujo existente (dashboard, safety guards, impact tracking)

## Tipos de Recomendaciones Nuevas

Ademas de las 4 acciones existentes (scale_up, scale_down, pause, reactivate), el agente podra recomendar:

| Tipo | Ejemplo |
|------|---------|
| `creative_refresh` | "Este ad set tiene solo 2 ads activos, necesita minimo 4-5 para que Meta optimice" |
| `structure_change` | "Consolida estos 3 ad sets que compiten por la misma audiencia" |
| `audience_insight` | "Tu targeting esta demasiado fragmentado, Advantage+ necesita volumen" |
| `copy_strategy` | "Todos tus ads usan el mismo angulo de pricing, prueba social proof" |
| `platform_alert` | "Meta cambio su algoritmo de delivery este mes, ajusta tu estrategia" |
| `attribution_insight` | "Tu ROAS real es ~20% menor por la ventana de 7d click" |
| `testing_suggestion` | "Lanza un test A/B: formato carrusel vs video para este producto" |
| `seasonal_strategy` | "Presidents Day es en 3 dias, prepara creativos tematicos" |
| `budget_strategy` | "Redistribuye: estas gastando 60% en 2 ad sets que generan 30% del revenue" |
| `scaling_playbook` | "Para escalar este ad set, hazlo en incrementos de 15% cada 3 dias" |

## Arquitectura

```
                    +------------------+
                    |   Cron Job       |
                    |  (cada 2 horas)  |
                    +--------+---------+
                             |
                    +--------v---------+
                    |  Strategic Agent  |
                    |  Orchestrator     |
                    +--------+---------+
                             |
              +--------------+--------------+
              |              |              |
     +--------v---+  +------v------+  +----v--------+
     | Research    |  | Data        |  | Creative    |
     | Module      |  | Analyzer    |  | Analyzer    |
     | (web search)|  | (metricas)  |  | (ad content)|
     +--------+----+  +------+------+  +----+--------+
              |              |              |
              +--------------+--------------+
                             |
                    +--------v---------+
                    |  Claude API      |
                    |  (Analisis       |
                    |   Estrategico)   |
                    +--------+---------+
                             |
                    +--------v---------+
                    |  Decision Store  |
                    |  (MongoDB)       |
                    +--------+---------+
                             |
                    +--------v---------+
                    |  Dashboard       |
                    |  (UI existente)  |
                    +------------------+
```

## Plan de Implementacion

### Paso 1: Ampliar Meta Client para leer contenido creativo

**Archivo:** `src/meta/client.js`

Agregar metodo para obtener detalles creativos de los ads:
- Endpoint: `GET /{ad_id}?fields=creative{title,body,image_url,thumbnail_url,link_url,call_to_action_type}`
- Endpoint alternativo: `GET /{creative_id}?fields=title,body,image_url,thumbnail_url,object_story_spec`
- Guardar en snapshot o en estructura separada

**Campos a extraer:**
- `title` (headline del ad)
- `body` (texto principal / copy)
- `image_url` o `thumbnail_url` (referencia visual)
- `call_to_action_type` (SHOP_NOW, LEARN_MORE, etc.)
- `link_url` (landing page)
- `object_story_spec` (estructura completa del post)

### Paso 2: Crear modulo de Research (busqueda web)

**Archivo nuevo:** `src/ai/strategic/research-module.js`

Modulo que busca informacion relevante en la web usando la API de busqueda:
- Cambios recientes en Meta Ads (algorithm updates, policy changes)
- Mejores practicas para ecommerce / food & beverage
- Tendencias de CPM/CPA en la industria
- Nuevas features de Meta Ads que podrian beneficiar la cuenta

**Implementacion:**
- Usar Brave Search API o Google Custom Search API (mas economico que OpenAI)
- Cache de 24 horas para evitar busquedas repetidas
- Queries predefinidos + queries dinamicos basados en problemas detectados
- Almacenar hallazgos en MongoDB (modelo `ResearchInsight`)

**Queries de ejemplo:**
- "Meta Ads algorithm changes 2026"
- "Meta Advantage+ Shopping best practices ecommerce"
- "Meta Ads creative fatigue solutions"
- "food ecommerce Facebook ads strategy"
- Si detecta CPA alto: "how to reduce CPA Meta Ads ecommerce"
- Si detecta fatigue: "Meta Ads creative refresh strategies"

### Paso 3: Crear modelo de datos para recomendaciones estrategicas

**Archivo nuevo:** `src/db/models/StrategicInsight.js`

```javascript
{
  cycle_id: String,
  insight_type: String,        // 'creative_refresh', 'structure_change', etc.
  severity: String,            // 'critical', 'high', 'medium', 'low'
  title: String,               // Titulo corto de la recomendacion
  analysis: String,            // Analisis detallado del problema
  recommendation: String,      // Que hacer especificamente
  evidence: [String],          // Datos que soportan la recomendacion
  affected_entities: [{        // Entidades afectadas
    entity_type: String,
    entity_id: String,
    entity_name: String
  }],
  research_sources: [{         // Fuentes de investigacion web
    title: String,
    url: String,
    snippet: String
  }],
  actionable: Boolean,         // Si se puede ejecutar automaticamente
  auto_action: {               // Accion automatica (si aplica)
    action: String,
    entity_id: String,
    value: Number
  },
  status: String,              // 'pending', 'acknowledged', 'implemented', 'dismissed'
  acknowledged_by: String,
  acknowledged_at: Date,
  created_at: Date
}
```

### Paso 4: Crear el Agente Estrategico principal

**Archivo nuevo:** `src/ai/strategic/strategic-agent.js`

Este es el cerebro principal. Orquesta todo:

1. **Recolecta contexto completo:**
   - Metricas de cuenta (snapshots existentes)
   - Contenido creativo de los ads (Paso 1)
   - Estructura de campanas/ad sets/ads (cuantos, como estan organizados)
   - Historial de acciones y su impacto (ActionLog)
   - Estado del aprendizaje del contextual bandit (PolicyLearner)
   - Investigacion web reciente (Paso 2)
   - Eventos estacionales proximos

2. **Construye un prompt estrategico completo para Claude:**
   - Contexto de la cuenta (Jersey Pickles, ecommerce, pickles artesanales)
   - Metricas actuales con tendencias
   - Contenido creativo actual (headlines, copy, CTAs)
   - Estructura de campanas
   - Problemas detectados algoritmicamente (fatiga, bajo ROAS, etc.)
   - Hallazgos de investigacion web
   - Historial de que ha funcionado y que no

3. **Recibe analisis estrategico de Claude:**
   - Diagnostico general de la cuenta
   - Recomendaciones estrategicas priorizadas
   - Para cada recomendacion: que hacer, por que, evidencia, impacto esperado
   - Alertas sobre cambios en la plataforma
   - Sugerencias de testing

4. **Procesa y almacena:**
   - Parsea respuesta en StrategicInsights
   - Clasifica por severidad y tipo
   - Vincula con entidades afectadas
   - Guarda en MongoDB

### Paso 5: Construir el System Prompt estrategico

**Archivo nuevo:** `src/ai/strategic/strategic-prompts.js`

System prompt de ~2000 tokens que establece a Claude como experto en:

- Meta Ads platform (auction mechanics, learning phase, delivery optimization)
- Ecommerce advertising (ROAS optimization, creative strategy, scaling)
- Attribution modeling (7-day click, 1-day view, data lag)
- Creative strategy (ad fatigue, messaging angles, format testing)
- Account structure (ABO vs CBO, campaign consolidation, audience overlap)
- Seasonal planning (promotional calendars, budget allocation)
- Industry benchmarks (food/beverage ecommerce CPM, CPA, ROAS)

El prompt incluira:
- Conocimiento base de `deep-research-priors.js` (expandido)
- KPIs target de `kpi-targets.js`
- Safety guards de `safety-guards.js`
- Contexto del negocio (Jersey Pickles, producto, mercado)

### Paso 6: Integrar con el ciclo principal

**Archivo modificado:** `src/index.js`

Agregar nuevo cron job para el agente estrategico:

```javascript
// Cada 2 horas: Analisis estrategico IA
cron.schedule('0 */2 * * *', jobStrategicAnalysis, {
  timezone: TIMEZONE,
  name: 'strategic-analysis'
});
```

Frecuencia menor que el unified policy (cada 2h vs cada 30min) porque:
- Es mas costoso (Claude API + web search)
- Las recomendaciones estrategicas no cambian cada 30 minutos
- Evita rate limits

### Paso 7: Crear rutas API para el dashboard

**Archivo nuevo:** `src/dashboard/routes/strategic.js`

Endpoints:
- `GET /api/strategic/latest` — Ultimo analisis estrategico
- `GET /api/strategic/history` — Historial de insights
- `GET /api/strategic/insights/:type` — Filtrar por tipo
- `POST /api/strategic/acknowledge/:id` — Marcar como visto
- `POST /api/strategic/dismiss/:id` — Descartar insight
- `POST /api/strategic/run-cycle` — Ejecutar analisis manual

### Paso 8: Crear pagina en el dashboard

**Archivo nuevo:** `src/dashboard/frontend/src/pages/Strategic.jsx`

Pagina nueva "Estrategia IA" con:
- Resumen ejecutivo del ultimo analisis
- Lista de insights priorizados por severidad
- Para cada insight: titulo, analisis, recomendacion, evidencia, fuentes web
- Filtros por tipo (creative, structure, audience, etc.)
- Acciones: acknowledge, dismiss, implementar (si es actionable)
- Seccion de "Investigacion Web" mostrando hallazgos recientes

### Paso 9: Conectar agente estrategico con unified policy

El agente estrategico puede influir en el unified policy de dos formas:

1. **Insights actionables** que generan acciones automaticas (pause, scale, etc.)
   se pueden inyectar como candidatos en el unified policy cycle

2. **Insights no-actionables** (estructura, creativos, estrategia) se muestran
   solo en el dashboard para que el humano actue

### Paso 10: Expandir deep-research-priors.js

**Archivo modificado:** `config/deep-research-priors.js`

Expandir significativamente el conocimiento base con:
- Meta auction mechanics detallados
- Creative best practices por vertical (food/ecommerce)
- Attribution window implications
- Scaling methodologies (horizontal vs vertical)
- Account structure best practices
- Audience strategy (broad vs narrow, LAL, Advantage+)
- Benchmarks de industria

---

## Archivos a Crear

| Archivo | Proposito |
|---------|-----------|
| `src/ai/strategic/strategic-agent.js` | Orquestador principal |
| `src/ai/strategic/strategic-prompts.js` | System prompt + user prompt builder |
| `src/ai/strategic/research-module.js` | Busqueda web + cache |
| `src/ai/strategic/creative-analyzer.js` | Analisis de contenido creativo |
| `src/ai/strategic/response-parser.js` | Parser de respuestas estrategicas |
| `src/db/models/StrategicInsight.js` | Modelo MongoDB |
| `src/db/models/ResearchCache.js` | Cache de investigacion web |
| `src/dashboard/routes/strategic.js` | API endpoints |
| `src/dashboard/frontend/src/pages/Strategic.jsx` | Pagina del dashboard |

## Archivos a Modificar

| Archivo | Cambio |
|---------|--------|
| `src/meta/client.js` | Agregar `getCreativeDetails()` |
| `src/meta/data-collector.js` | Recolectar contenido creativo |
| `src/index.js` | Agregar cron job estrategico |
| `src/dashboard/server.js` | Registrar rutas estrategicas |
| `src/dashboard/frontend/src/App.jsx` | Agregar ruta /strategic |
| `src/dashboard/frontend/src/api.js` | Agregar endpoints estrategicos |
| `config/deep-research-priors.js` | Expandir conocimiento base |
| `config/index.js` | Agregar config de search API |
| `.env.example` | Agregar SEARCH_API_KEY |

## Dependencias Nuevas

| Paquete | Proposito |
|---------|-----------|
| Ninguno nuevo requerido | Se usa axios (ya instalado) para busqueda web |

## Estimacion de Costo por Ciclo

- Claude API: ~4K input tokens + ~2K output = ~$0.04 por ciclo
- Search API (Brave): ~5 busquedas = ~$0.005 por ciclo
- Total: ~$0.05 por ciclo x 12 ciclos/dia = ~$0.60/dia = ~$18/mes

## Orden de Implementacion

1. Modelo StrategicInsight + ResearchCache (base de datos)
2. Creative analyzer (leer contenido de ads)
3. Research module (busqueda web)
4. Strategic prompts (system + user prompts)
5. Strategic agent (orquestador)
6. Response parser
7. API routes + integracion con index.js
8. Frontend (pagina Strategic.jsx)
9. Expandir deep-research-priors.js
10. Testing y ajuste de prompts
