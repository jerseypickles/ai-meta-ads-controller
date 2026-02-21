# Plan: Tracking de Impacto, Ventanas de Tiempo Extendidas y Datos de Creativos

## Resumen
6 funcionalidades interconectadas para dar "memoria" al sistema y visibilidad completa.

---

## FASE 1: Ventanas de Tiempo 14d y 30d (Backend)

### 1.1 `src/meta/helpers.js` — Agregar rangos
- Agregar `last_14d` y `last_30d` a `getTimeRanges()`

### 1.2 `src/db/models/MetricSnapshot.js` — Extender schema
- Agregar `last_14d` y `last_30d` al objeto `metrics`

### 1.3 `src/meta/data-collector.js` — Recolectar ventanas nuevas
- Iterar sobre 5 ventanas (today, 3d, 7d, 14d, 30d) en vez de 3
- Aplica tanto para campaigns como adsets
- API calls pasan de ~8 a ~12 (2 extras para campaigns, 2 extras para adsets)

### 1.4 `src/db/queries.js` — Actualizar getAccountOverview
- Agregar `roas_14d`, `roas_30d`, `spend_14d`, `spend_30d`

---

## FASE 2: Recolección de Datos a Nivel de Ad (Creativos)

### 2.1 `src/meta/data-collector.js` — Nueva sección de ads
- Usar `getAccountInsights('ad', range)` para cada ventana de tiempo (5 llamadas)
- Retorna todos los ads con métricas en una sola llamada por ventana (igual que adsets)
- NO necesita iterar ad set por ad set (mismo patrón de level= que ya usamos)
- API calls: +5 llamadas = ~17 total (sigue siendo eficiente)
- Agregar `ad_id` y `ad_name` a los campos solicitados en `getAccountInsights`

### 2.2 `src/meta/client.js` — Agregar ad_id/ad_name a getAccountInsights
- Agregar `ad_id`, `ad_name` a los fields cuando level='ad'

### 2.3 Guardar snapshots de ads
- Entity type: 'ad'
- parent_id: adset_id (viene en la respuesta de insights)
- campaign_id: campaign_id
- Mismas métricas por ventana que adsets

### 2.4 `src/db/queries.js` — Query para ads por adset
- `getAdsForAdSet(adSetId)` — obtener últimos snapshots de ads de un adset

---

## FASE 3: Tracking de Impacto Post-Ejecución

### 3.1 `src/db/models/ActionLog.js` — Extender schema
- Agregar `metrics_at_execution`: objeto con métricas del ad set al momento de ejecutar
  ```
  metrics_at_execution: {
    roas_7d, roas_3d, cpa_7d, spend_today, daily_budget, frequency, ctr
  }
  ```
- Agregar `metrics_after_3d`: mismo formato, llenado 3 días después
- Agregar `impact_measured`: Boolean (false hasta que se mida)
- Agregar `impact_measured_at`: Date

### 3.2 `src/dashboard/routes/agents.js` — Capturar métricas al ejecutar
- En el endpoint POST `/execute/:reportId/:recId`:
  - Buscar el snapshot más reciente del entity_id
  - Guardar sus métricas en `metrics_at_execution`

### 3.3 Cron job de medición de impacto
- Nuevo job en `src/index.js`: `jobMeasureImpact()`
- Corre cada 6 horas
- Busca ActionLogs donde:
  - `impact_measured` === false
  - `executed_at` <= hace 3 días
  - `success` === true
- Para cada uno:
  - Obtener snapshot más reciente del entity_id
  - Guardar métricas en `metrics_after_3d`
  - Marcar `impact_measured = true`

### 3.4 `src/db/queries.js` — Queries de impacto
- `getExecutedActionsWithImpact(limit)` — acciones ejecutadas con métricas before/after
- `getPendingImpactMeasurement()` — acciones pendientes de medición

---

## FASE 4: Cooldown de 3 Días para Agentes

### 4.1 `config/safety-guards.js` — Cambiar cooldown
- Cambiar `cooldown_hours: 6` a `cooldown_hours: 72` (3 días)

### 4.2 `src/ai/agents/agent-runner.js` — Cargar historial para agentes
- En `_loadSharedData()`:
  - Obtener acciones recientes (últimos 3 días) via `getRecentActions(3)`
  - Obtener cooldowns activos via `CooldownManager.getActiveCooldowns()`
  - Agregar `recentActions` y `activeCooldowns` al objeto sharedData

### 4.3 `src/db/queries.js` — Nueva query
- `getRecentActions(days)` — todas las acciones ejecutadas en los últimos N días

### 4.4 Cada agente recibe contexto de acciones recientes
- En `buildUserPrompt()` de cada agente (budget, performance, creative, pacing):
  - Agregar sección al prompt: "ACCIONES RECIENTES (últimos 3 días)"
  - Listar: entity_id, entity_name, action, antes, después, fecha
  - Instrucción: "NO recomendes cambios en entidades que fueron modificadas en los últimos 3 días"
- En `base-agent.js` `_validateRecommendation()`:
  - Filtrar recomendaciones cuyo entity_id tenga cooldown activo
  - Log: "Recomendación filtrada por cooldown: {entity_name}"

---

## FASE 5: Frontend — Página Ad Sets Rediseñada

### 5.1 `src/dashboard/routes/metrics.js` — Nuevo endpoint para ads
- GET `/api/metrics/ads/:adSetId` — retorna ads de un adset con métricas

### 5.2 `src/dashboard/frontend/src/api.js` — Nuevas funciones
- `getAdsForAdSet(adSetId)` — obtener ads de un adset
- `getActionsWithImpact()` — obtener acciones con impacto medido

### 5.3 `src/dashboard/frontend/src/pages/AdSets.jsx` — Rediseño
- **Selector de ventana de tiempo** (tabs arriba de la tabla):
  - Hoy | 3 días | 7 días | 14 días | 30 días
  - Cambiar columnas dinámicamente según ventana seleccionada
- **Columnas por ventana**: Spend, ROAS, CPA, Purchases, CTR, Frequency
- **Row expandible** mejorado:
  - Panel superior: Métricas detalladas del adset + gráfico ROAS
  - Panel inferior: **Tabla de Ads (creativos)** dentro del adset
    - Columnas: Nombre, Status, Spend, ROAS, CPA, CTR (de la ventana seleccionada)
    - Ordenable por cada columna
- **Indicador de cooldown**: Si un adset fue modificado recientemente, mostrar badge "Modificado hace X días"

---

## FASE 6: Frontend — Impacto en Página de Agentes

### 6.1 `src/dashboard/routes/agents.js` — Endpoint de impacto
- GET `/api/agents/impact` — retorna acciones ejecutadas con métricas before/after
  - Filtrar solo las que tienen `impact_measured === true`
  - Incluir delta calculado (% cambio ROAS, CPA, etc.)

### 6.2 `src/dashboard/frontend/src/pages/Agents.jsx` — Sección de impacto
- **Nueva sección** debajo de las tarjetas de agentes: "Impacto de Acciones Ejecutadas"
- Tabla con columnas:
  - Ad Set | Agente | Acción | Fecha | ROAS Antes | ROAS Después | Delta ROAS | CPA Antes | CPA Después | Resultado
- Resultado = badge verde "Mejoró" / rojo "Empeoró" / gris "Sin cambio"
- Para acciones aún sin medir (< 3 días): badge amarillo "Midiendo... (X días restantes)"
- **Indicador en tarjetas de agente**: "X acciones ejecutadas, Y mejoraron"

---

## Resumen de Archivos a Modificar

| Archivo | Cambios |
|---------|---------|
| `src/meta/helpers.js` | +2 time ranges (14d, 30d) |
| `src/db/models/MetricSnapshot.js` | +2 metric windows |
| `src/meta/data-collector.js` | +ads collection, +14d/30d windows |
| `src/meta/client.js` | +ad fields en getAccountInsights |
| `src/db/models/ActionLog.js` | +metrics_at_execution, +metrics_after_3d, +impact fields |
| `src/db/queries.js` | +getAdsForAdSet, +getRecentActions, +getActionsWithImpact, +getPendingImpactMeasurement, actualizar getAccountOverview |
| `config/safety-guards.js` | cooldown_hours: 6 → 72 |
| `src/ai/agents/agent-runner.js` | cargar recentActions + cooldowns |
| `src/ai/agents/base-agent.js` | filtrar recs con cooldown |
| `src/ai/agents/budget-agent.js` | agregar acciones recientes al prompt |
| `src/ai/agents/performance-agent.js` | agregar acciones recientes al prompt |
| `src/ai/agents/creative-agent.js` | agregar acciones recientes al prompt |
| `src/ai/agents/pacing-agent.js` | agregar acciones recientes al prompt |
| `src/dashboard/routes/agents.js` | capturar métricas al ejecutar, +endpoint impacto |
| `src/dashboard/routes/metrics.js` | +endpoint ads por adset |
| `src/index.js` | +cron jobMeasureImpact |
| `src/dashboard/frontend/src/api.js` | +getAdsForAdSet, +getActionsWithImpact |
| `src/dashboard/frontend/src/pages/AdSets.jsx` | rediseño completo con 5 windows + ads expandibles |
| `src/dashboard/frontend/src/pages/Agents.jsx` | +sección impacto |

## Orden de Implementación
1. Fase 1 — Ventanas 14d/30d (backend)
2. Fase 2 — Datos de ads/creativos (backend)
3. Fase 3 — Tracking de impacto (backend)
4. Fase 4 — Cooldown 3 días para agentes (backend)
5. Fase 5 — Frontend Ad Sets rediseñado
6. Fase 6 — Frontend impacto en Agentes
