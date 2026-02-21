# PLAN: Sistema Unificado de Agentes de Escalabilidad

## Problema Actual

Existen 3 sistemas de IA separados (Strategic Agent, Unified Policy Agent, 4 Agentes Especializados) que se solapan, generan confusión, y solo ejecutan 4 acciones básicas (scale_up, scale_down, pause, reactivate). El usuario necesita un **sistema unificado** que controle campañas de forma integral para escalar: no solo budget, sino creativos, audiencias, estructura, bid strategy, etc.

## Visión

**Un solo sistema de agentes inteligentes** que:
1. Analiza las 36 ad sets con deep research (web + conocimiento interno)
2. Genera recomendaciones de **todas las acciones posibles** (no solo budget)
3. Flujo: Agente recomienda → Usuario aprueba en dashboard → Se ejecuta vía Meta API
4. Todo en una sola sección del dashboard (fusionar Strategic + Agents)

---

## Arquitectura Nueva

### Eliminar / Deprecar
- `src/ai/strategic/` — TODO (strategic-agent.js, strategic-prompts.js, response-parser.js, creative-analyzer.js, research-module.js)
- `src/ai/unified/` — TODO (unified-policy-agent.js, feature-builder.js, adaptive-scorer.js, policy-learner.js)
- `src/ai/decision-engine.js` — Ya obsoleto
- `src/ai/prompts.js` — Ya obsoleto
- `src/ai/response-parser.js` — Ya obsoleto
- `src/db/models/Decision.js` — Reemplazado por AgentReport unificado
- `src/db/models/StrategicInsight.js` — Fusionado en AgentReport
- `src/db/models/StrategicDirective.js` — Ya no necesario
- `src/dashboard/routes/strategic.js` — Fusionado en agents.js
- `src/dashboard/frontend/src/pages/Strategic.jsx` — Fusionado en Agents.jsx

### Mantener y Extender
- `src/ai/agents/` — Base del nuevo sistema
- `src/ai/agents/base-agent.js` — Extender con capacidades de research
- `src/ai/agents/agent-runner.js` — Extender para nuevas acciones
- `src/meta/client.js` — Extender con nuevos endpoints de Meta API
- `src/meta/action-executor.js` — Extender para ejecutar nuevas acciones
- `src/db/models/AgentReport.js` — Extender schema de recomendaciones
- `src/db/models/ActionLog.js` — Extender para nuevos tipos de acción
- `src/safety/guard-rail.js` — Extender validaciones
- `src/dashboard/routes/agents.js` — Agregar endpoints de ejecución
- `src/dashboard/frontend/src/pages/Agents.jsx` — Rediseñar como hub central

---

## Nuevas Acciones del Sistema

### Acciones Actuales (mantener)
1. `scale_up` — Subir budget de ad set
2. `scale_down` — Bajar budget de ad set
3. `pause` — Pausar ad set
4. `reactivate` — Reactivar ad set pausado

### Acciones Nuevas a Implementar

5. **`duplicate_adset`** — Duplicar ad set ganador
   - Meta API: `POST /{adset_id}/copies`
   - Params: nuevo nombre, nuevo budget (opcional), modificaciones de targeting (opcional)
   - Uso: Escalar horizontalmente duplicando ad sets con buen ROAS

6. **`create_ad`** — Crear nuevo ad dentro de ad set existente
   - Meta API: `POST /act_{ad_account_id}/ads` + `POST /act_{ad_account_id}/adcreatives`
   - Requiere: creative_id (de banco de creativos) o image_hash + copy
   - Uso: Refrescar creativos en ad sets fatigados

7. **`update_bid_strategy`** — Cambiar bid strategy de campaña
   - Meta API: `POST /{campaign_id}` con `bid_strategy`
   - Opciones: LOWEST_COST_WITHOUT_CAP, COST_CAP, LOWEST_COST_WITH_BID_CAP, LOWEST_COST_WITH_MIN_ROAS
   - Uso: Optimizar según rendimiento (ej: pasar a cost cap si ROAS es bueno pero CPA sube)

8. **`update_ad_status`** — Pausar/activar ads individuales (no ad set completo)
   - Meta API: `POST /{ad_id}` con `status`
   - Uso: Pausar ads con mal CTR sin pausar todo el ad set

9. **`move_budget`** — Redistribuir budget entre ad sets
   - Meta API: Combina scale_down en uno + scale_up en otro
   - Uso: Mover dinero de ad sets malos a buenos sin cambiar gasto total

10. **`update_ad_creative`** — Cambiar creative de un ad existente (via duplication)
    - Meta API: `POST /{ad_id}/copies` con nuevos campos de creative
    - Uso: Refrescar copy/headline sin crear ad set nuevo

---

## Nuevos Agentes (reemplazar los 4 actuales + strategic)

### Agente 1: `scaling` (reemplaza budget + strategic budget/scaling)
**Responsabilidad**: Escalar campañas — budget vertical, duplicación horizontal, redistribución
**Acciones**: `scale_up`, `scale_down`, `duplicate_adset`, `move_budget`
**Deep Research**: Buscar mejores prácticas de scaling Meta Ads 2026, benchmarks del sector food/ecommerce

### Agente 2: `performance` (se mantiene, expandido)
**Responsabilidad**: Analizar ROAS/CPA, detectar winners y losers, decidir pausas y reactivaciones
**Acciones**: `pause`, `reactivate`, `scale_down`, `update_bid_strategy`
**Deep Research**: Buscar cambios en algoritmo de Meta, tendencias de CPA en ecommerce

### Agente 3: `creative` (expandido significativamente)
**Responsabilidad**: Fatiga creativa, rotación de ads, crear nuevos ads con creativos del banco
**Acciones**: `create_ad`, `update_ad_status`, `update_ad_creative`, `pause` (solo ads individuales)
**Deep Research**: Buscar tendencias de copy/creative en food ecommerce, mejores CTAs
**Requiere**: Acceso al banco de creativos (file upload → MongoDB/disk)

### Agente 4: `pacing` (se mantiene, mejorado)
**Responsabilidad**: Ritmo de gasto, delivery issues, oportunidades de redistribución
**Acciones**: `scale_up`, `scale_down`, `move_budget`
**Deep Research**: Buscar cambios en delivery algorithm de Meta

---

## Banco de Creativos (Creative Bank)

### Modelo MongoDB: `CreativeAsset`
```javascript
{
  asset_id: ObjectId,
  filename: String,           // "pickle-jar-hero.jpg"
  original_name: String,
  file_path: String,          // "/uploads/creatives/pickle-jar-hero.jpg"
  file_type: String,          // "image/jpeg", "video/mp4"
  media_type: "image" | "video",

  // Meta API references (después de subir)
  meta_image_hash: String,    // Hash retornado por Meta al subir
  meta_video_id: String,      // Video ID retornado por Meta
  uploaded_to_meta: Boolean,
  uploaded_at: Date,

  // Metadata del creative
  headline: String,           // "Best Pickles in Jersey"
  body: String,               // "Try our hand-crafted pickles..."
  description: String,        // Link description
  cta: String,                // "SHOP_NOW", "LEARN_MORE", etc.
  link_url: String,           // "https://jerseypickles.com/shop"

  // Organización
  tags: [String],             // ["hero", "product", "lifestyle"]
  campaign_type: String,      // "acquisition", "retargeting", "seasonal"
  notes: String,

  // Tracking de uso
  times_used: Number,         // Cuántas veces se usó en ads
  used_in_ads: [String],      // IDs de ads donde se usó
  avg_ctr: Number,            // CTR promedio cuando se usa
  avg_roas: Number,           // ROAS promedio cuando se usa

  status: "active" | "archived",
  created_at: Date,
  updated_at: Date
}
```

### Upload API
- `POST /api/creatives/upload` — Subir imagen/video + metadata (headline, body, cta, link)
- `GET /api/creatives` — Listar banco de creativos
- `POST /api/creatives/:id/upload-to-meta` — Subir asset a Meta y guardar image_hash/video_id
- `DELETE /api/creatives/:id` — Archivar creative

### Flujo de Uso
1. Usuario sube creativos al banco via dashboard (imagen + copy + CTA + link)
2. Se almacena en disco + MongoDB
3. Cuando Creative Agent recomienda `create_ad`, referencia un `asset_id` del banco
4. Al aprobar, el sistema sube la imagen a Meta (si no está subida), crea el creative, y crea el ad

---

## Deep Research Integrado en Base Agent

Mover la funcionalidad de research del Strategic Agent al BaseAgent para que TODOS los agentes puedan investigar:

### Cambios en `base-agent.js`
```javascript
class BaseAgent {
  constructor(agentType) {
    this.agentType = agentType;
    this.researchModule = new ResearchModule(); // Reusar research-module.js
  }

  async analyze(sharedData) {
    // 1. Construir prompt del agente
    // 2. Hacer deep research relevante al dominio del agente
    const research = await this._conductResearch(sharedData);
    // 3. Inyectar research en el prompt
    // 4. Llamar a Claude con contexto enriquecido
    // 5. Parsear y guardar
  }

  async _conductResearch(sharedData) {
    const queries = this.getResearchQueries(sharedData); // Cada agente define sus queries
    return this.researchModule.research(queries);
  }

  // Override por cada agente
  getResearchQueries(sharedData) {
    return []; // Por defecto no investiga
  }
}
```

### Research Queries por Agente

**ScalingAgent**:
- "Meta Ads scaling strategies 2026 ecommerce"
- "horizontal scaling duplicate ad sets Meta best practices"
- "Meta Ads budget optimization ABO strategy"

**PerformanceAgent**:
- "Meta Ads ROAS optimization 2026"
- "Meta algorithm changes {current_month} 2026"
- "ecommerce food CPA benchmarks Meta Ads"

**CreativeAgent**:
- "Meta Ads creative best practices 2026"
- "food ecommerce ad copy trends"
- "Meta Ads creative fatigue solutions"

**PacingAgent**:
- "Meta Ads delivery pacing optimization"
- "Meta Ads underspending solutions 2026"

---

## Cambios en Meta Client (`client.js`)

### Nuevos Métodos

```javascript
// Duplicar ad set
async duplicateAdSet(adSetId, options = {}) {
  // POST /{adset_id}/copies
  // options: { name, daily_budget, status }
}

// Crear ad creative
async createAdCreative(params) {
  // POST /act_{ad_account_id}/adcreatives
  // params: { page_id, object_story_spec: { link_data: { message, link, image_hash, name, description, call_to_action } } }
}

// Crear ad
async createAd(adSetId, creativeId, name, status = 'PAUSED') {
  // POST /act_{ad_account_id}/ads
  // { adset_id, creative: { creative_id }, name, status }
}

// Subir imagen a Meta
async uploadImage(filePath) {
  // POST /act_{ad_account_id}/adimages
  // Retorna image_hash
}

// Subir video a Meta
async uploadVideo(filePath) {
  // POST /act_{ad_account_id}/advideos
  // Retorna video_id
}

// Actualizar bid strategy de campaña
async updateBidStrategy(campaignId, bidStrategy, bidAmount = null) {
  // POST /{campaign_id} { bid_strategy, bid_amount? }
}

// Actualizar status de ad individual
async updateAdStatus(adId, status) {
  // POST /{ad_id} { status: 'ACTIVE' | 'PAUSED' }
}

// Duplicar ad con creative changes
async duplicateAd(adId, options = {}) {
  // POST /{ad_id}/copies
  // options: { name, creative fields }
}
```

---

## Cambios en Action Executor

Extender `_executeAction()` para manejar nuevos tipos:

```javascript
async _executeAction(decision) {
  switch (decision.action) {
    case 'scale_up':
    case 'scale_down':
      return this.meta.updateBudget(decision.entity_id, decision.new_value);

    case 'pause':
      return this.meta.updateStatus(decision.entity_id, 'PAUSED');

    case 'reactivate':
      return this.meta.updateStatus(decision.entity_id, 'ACTIVE');

    case 'duplicate_adset':
      return this.meta.duplicateAdSet(decision.entity_id, {
        name: decision.duplicate_name,
        daily_budget: decision.new_value,
        status: 'PAUSED' // Siempre crear pausado para revisión
      });

    case 'create_ad':
      // 1. Obtener creative asset del banco
      // 2. Subir imagen a Meta si no está subida
      // 3. Crear ad creative
      // 4. Crear ad en el ad set
      return this._executeCreateAd(decision);

    case 'update_bid_strategy':
      return this.meta.updateBidStrategy(
        decision.entity_id, // campaign_id
        decision.new_value  // bid strategy string
      );

    case 'update_ad_status':
      return this.meta.updateAdStatus(decision.entity_id, decision.new_value);

    case 'move_budget':
      // Ejecutar como transacción: bajar uno, subir otro
      return this._executeMoveBudget(decision);

    case 'update_ad_creative':
      return this.meta.duplicateAd(decision.entity_id, {
        name: decision.duplicate_name,
        ...decision.creative_changes
      });
  }
}
```

---

## Cambios en Schema de AgentReport (recomendaciones)

Extender `recommendationSchema` para soportar nuevas acciones:

```javascript
const recommendationSchema = new mongoose.Schema({
  // ... campos existentes ...
  action: {
    type: String,
    enum: [
      'scale_up', 'scale_down', 'pause', 'reactivate',
      'duplicate_adset', 'create_ad', 'update_bid_strategy',
      'update_ad_status', 'move_budget', 'update_ad_creative'
    ],
    required: true
  },

  // Nuevos campos para acciones avanzadas
  target_entity_id: String,        // Para move_budget: el ad set destino
  target_entity_name: String,
  creative_asset_id: String,       // Para create_ad: referencia al banco
  bid_strategy: String,            // Para update_bid_strategy
  duplicate_name: String,          // Para duplicate_adset/update_ad_creative
  creative_changes: {              // Para update_ad_creative
    headline: String,
    body: String,
    cta: String,
    link_url: String
  },

  // Research context (del deep research)
  research_context: String,        // Resumen del research que informó esta recomendación
  research_sources: [{
    title: String,
    url: String,
    snippet: String
  }]
});
```

---

## Cambios en ActionLog

Extender enum de acciones y agregar campos:

```javascript
action: {
  type: String,
  enum: [
    'scale_up', 'scale_down', 'pause', 'reactivate', 'kill_switch',
    'duplicate_adset', 'create_ad', 'update_bid_strategy',
    'update_ad_status', 'move_budget', 'update_ad_creative'
  ]
},
// Nuevos campos
target_entity_id: String,
target_entity_name: String,
creative_asset_id: String,
new_entity_id: String,           // ID del nuevo ad set/ad creado
```

---

## Cambios en Guard Rail

Nuevas validaciones por tipo de acción:

```javascript
async validate(decision) {
  // ... checks existentes (kill switch, horas, cooldown) ...

  switch (decision.action) {
    case 'scale_up':
    case 'scale_down':
      return this._validateBudgetChange(decision);

    case 'duplicate_adset':
      return this._validateDuplicate(decision);

    case 'create_ad':
      return this._validateCreateAd(decision);

    case 'update_bid_strategy':
      return this._validateBidChange(decision);

    case 'move_budget':
      return this._validateMoveBudget(decision);

    case 'pause':
    case 'reactivate':
    case 'update_ad_status':
    case 'update_ad_creative':
      return { approved: true, modified: false, reason: 'Acción aprobada' };
  }
}

async _validateDuplicate(decision) {
  // Check: No más de X duplicaciones por día
  // Check: Budget ceiling no se excede con nuevo ad set
  // Check: No duplicar ad set que ya fue duplicado recientemente
}

async _validateCreateAd(decision) {
  // Check: Creative asset existe en banco
  // Check: Creative asset tiene image_hash (subido a Meta)
  // Check: Ad set destino existe y está activo
}

async _validateBidChange(decision) {
  // Check: Solo cambiar una vez cada 7 días (learning phase)
  // Check: Bid strategy es válida
}

async _validateMoveBudget(decision) {
  // Check: Budget total no cambia (source - amount === target + amount)
  // Check: Source no queda debajo de mínimo
  // Check: Target no excede máximo
}
```

---

## Cambios en Frontend

### Fusionar Strategic + Agents → Un solo "AI Control Center"

La página Agents.jsx se convierte en el hub central:

**Secciones**:
1. **Status Bar**: Estado general de la cuenta (ROAS, gasto, health)
2. **Recomendaciones Pendientes**: Tabla unificada de TODOS los agentes con filtros
   - Columnas: Agente, Acción, Entidad, Valor Actual → Nuevo, Razón, Confianza, Research
   - Botones: Aprobar / Rechazar / Ejecutar
   - Filtro por agente (scaling, performance, creative, pacing)
   - Filtro por acción (budget, creative, structure, bid)
3. **Research Insights**: Hallazgos del deep research (colapsable)
4. **Banco de Creativos**: Mini-galería con upload (accesible desde tab)
5. **Historial**: Acciones ejecutadas con impacto medido
6. **Controles**: Run manual, modo autonomía

### Eliminar de Navegación
- Quitar "Strategic" del sidebar
- Renombrar "Agents" → "AI Agents" o "AI Control"

---

## Cambios en Cron Jobs (index.js)

### Eliminar
- Job de Strategic Agent (cada 3 horas)
- Job de Unified Policy Agent (cada 30 min)

### Mantener/Modificar
- Data collection (cada 10 min) — sin cambios
- **Agent cycle (cada 30 min)** — AgentRunner con 4 nuevos agentes + deep research
- Kill switch monitor (cada 15 min) — sin cambios
- Impact measurement (cada 2 horas) — sin cambios
- Daily cleanup (2 AM) — limpiar research cache también
- Token health (3 AM) — sin cambios

---

## Orden de Implementación

### Fase 1: Extender Meta Client + Action Executor
1. Agregar `duplicateAdSet()` a client.js
2. Agregar `uploadImage()`, `uploadVideo()` a client.js
3. Agregar `createAdCreative()`, `createAd()` a client.js
4. Agregar `updateBidStrategy()` a client.js
5. Agregar `updateAdStatus()` a client.js
6. Agregar `duplicateAd()` a client.js
7. Extender action-executor.js con nuevas acciones

### Fase 2: Banco de Creativos
8. Crear modelo `CreativeAsset` en db/models/
9. Crear ruta `routes/creatives.js` (upload, list, upload-to-meta, delete)
10. Agregar middleware multer para file upload
11. Registrar ruta en server.js

### Fase 3: Extender Schemas
12. Extender `AgentReport.recommendationSchema` con nuevos campos
13. Extender `ActionLog` con nuevos tipos de acción
14. Actualizar enum de acciones en ambos modelos

### Fase 4: Integrar Research en Base Agent
15. Mover ResearchModule a `src/ai/agents/research-module.js` (o reusar el existente)
16. Extender `BaseAgent` con `_conductResearch()` y `getResearchQueries()`
17. Agregar research context al prompt de cada agente

### Fase 5: Crear/Refactorear Agentes
18. Crear `ScalingAgent` (reemplaza BudgetAgent)
19. Extender `PerformanceAgent` con nuevas acciones
20. Extender `CreativeAgent` con create_ad, update_ad_status, banco de creativos
21. Extender `PacingAgent` con move_budget
22. Cada agente implementa `getResearchQueries()`

### Fase 6: Extender Guard Rails
23. Agregar validaciones para duplicate_adset, create_ad, update_bid_strategy, move_budget

### Fase 7: Extender Ejecución en Routes
24. Actualizar `routes/agents.js` execute endpoint para nuevas acciones
25. Eliminar `routes/strategic.js` de server.js

### Fase 8: Actualizar Frontend
26. Rediseñar `Agents.jsx` como hub central (fusionar con Strategic)
27. Agregar sección de Banco de Creativos (upload + galería)
28. Agregar filtros por tipo de acción
29. Mostrar research context en recomendaciones
30. Eliminar `Strategic.jsx` y su ruta en App.jsx

### Fase 9: Limpiar Código Obsoleto
31. Mover archivos deprecados a `src/_deprecated/` (strategic/, unified/, decision-engine, etc.)
32. Actualizar cron jobs en index.js
33. Limpiar imports y referencias

### Fase 10: Testing
34. Test de conexión Meta API para cada nuevo método
35. Test de cada agente con datos reales (modo shadow)
36. Test de flujo completo: recomendación → aprobación → ejecución
37. Test de guard rails para nuevas acciones

---

## Estimación de Costo API

**Claude API** (por ciclo de 4 agentes con research):
- ~4 calls Claude × ~4000 tokens input × ~2000 tokens output = ~$0.15/ciclo
- Research queries: ~6 búsquedas web × $0.01 = ~$0.06/ciclo
- **Total por ciclo: ~$0.21**
- 48 ciclos/día (cada 30 min) = **~$10/día** con research
- Sin research en cada ciclo (cache 24h): **~$5/día**

**Meta API**:
- Acciones de ejecución: negligible (pocas calls/día)
- Data collection: ya existente, sin cambio
