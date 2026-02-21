# Plan: Cerebro IA Unificado

## Objetivo
Eliminar los 4 agentes tacticos independientes (scaling, performance, creative, pacing) y consolidar todo en un solo "Cerebro IA" que:
- Genera recomendaciones coordinadas (sin conflictos)
- Se alimenta del historial de impacto de sus propias decisiones
- Aprende de resultados medidos (feedback loop cerrado)
- Simplifica el frontend Centro IA

## Arquitectura

```
CADA 30 MIN:
  Feature Builder (existente) → extrae senales de ad sets + ads
       ↓
  Cerebro IA (NUEVO) → 1 llamada a Claude con TODO el contexto:
    - Metricas actuales de todas las entidades
    - Historial de impacto (que hice + que paso)
    - Acciones en medicion (no tocar)
    - Cooldowns activos
    - Banco de creativos
    - Deep research priors
    - Policy learner bias (bandit historico)
       ↓
  Adaptive Scorer (existente) → valida/ajusta scores
       ↓
  Guardar recomendaciones → mostrar en Centro IA
       ↓
  Ejecutar (manual o auto) → capturar metrics_at_execution
       ↓
  Medir impacto 1d/3d (existente) → alimentar siguiente ciclo
```

## Archivos a CREAR

### 1. `src/ai/brain/unified-brain.js` — Cerebro principal
- Reemplaza agent-runner.js como orquestador
- Carga datos compartidos (feature builder + cuenta + cooldowns + impacto)
- Construye UN prompt completo para Claude con:
  - Metricas de todos los ad sets y ads
  - Historial de impacto reciente (ultimas 20 acciones medidas con resultado)
  - Acciones en medicion activa (pending, no tocar)
  - Cooldowns activos (entidades bloqueadas)
  - Banco de creativos disponibles (ad-ready)
  - Feedback del policy learner (bias por bucket)
  - Deep research priors resumidos
- Parsea respuesta de Claude → array de recomendaciones
- Aplica adaptive scorer para validar/ajustar scores
- Aplica strategic directives (boost/suppress/protect/override)
- Guarda como AgentReport con agent_type = 'brain'
- Soporta auto-ejecucion segun modo autonomia

### 2. `src/ai/brain/brain-prompts.js` — Prompts del cerebro
- System prompt: experto en Meta Ads con todas las capacidades
  - Conoce scaling, performance, creativos, pacing
  - Recibe deep-research-priors como contexto base
  - Entiende attribution lag, learning phase, frecuencia
- User prompt builder: construye el contexto completo por ciclo
  - Seccion: Metricas actuales (ad sets + ads)
  - Seccion: Historial de impacto (acciones pasadas + resultado)
  - Seccion: Acciones en medicion (no tocar)
  - Seccion: Cooldowns activos
  - Seccion: Banco de creativos
  - Seccion: Hora actual + pacing
  - Seccion: Contexto de cuenta (ROAS general, spend, etc)
- Output format: JSON con recomendaciones coordinadas

### 3. `src/ai/brain/impact-context-builder.js` — Constructor de contexto de impacto
- Carga ultimas N acciones medidas (impact_measured = true)
- Calcula deltas ROAS/CPA por accion
- Agrupa por tipo de accion (scale_up tuvo X% exito, pause tuvo Y%)
- Identifica patrones: "subir budget a ad sets con ROAS>3 funciono 4/5 veces"
- Carga acciones en medicion (pending) para marcar "no tocar"
- Genera resumen legible para Claude

## Archivos a MODIFICAR

### 4. `src/index.js` — Reemplazar cron de agentes
- Cambiar `jobAgentsCycle` para usar UnifiedBrain en vez de AgentRunner
- Mantener todos los demas cron jobs intactos:
  - jobDataCollection (cada 10 min) ✓
  - jobMeasureImpact (cada 2h) ✓
  - jobLifecycleManager (cada 30 min) ✓
  - jobAIManager (cada 8h) ✓
  - jobCleanup, jobTokenHealthCheck ✓
- El strategic cycle se mantiene (genera directives para el brain)

### 5. `src/dashboard/routes/agents.js` — Adaptar endpoints
- `GET /latest` → devolver reporte del brain (agent_type = 'brain') en vez de 4 reportes
- `GET /pending` → mismo pero solo del brain
- `POST /execute` → mismo flujo, arreglar captura de metricas para ads (bug actual)
- `GET /impact` → agregar campo `impact_fed_to_brain: true` cuando la accion ya fue usada como input
- `GET /autonomy` → simplificar a un solo modo (manual/semi_auto/auto) global
- `PUT /autonomy` → un solo toggle
- Mantener: cooldowns, approve, reject, run

### 6. `config/safety-guards.js` — Simplificar autonomia
- Cambiar de 4 modos por agente a 1 modo global:
```js
autonomy: {
  mode: 'manual',  // manual | semi_auto | auto
  max_auto_change_pct: 20
}
```

### 7. `src/dashboard/frontend/src/pages/Agents.jsx` — Redisenar Centro IA
Nuevo diseno con 4 secciones claras:

**A) Header + Control**
- Toggle IA ON/OFF
- Modo autonomia (Manual / Semi-Auto / Auto) — un solo selector
- Boton "Ejecutar Ciclo"
- Estado: ultima ejecucion, proxima ejecucion

**B) Recomendaciones Pendientes (parte principal)**
- Lista de recomendaciones del cerebro, ordenadas por score
- Cada tarjeta muestra:
  - Tipo de accion (icono + color) + nombre entidad
  - Cambio propuesto (ej: $50 → $60)
  - Razonamiento de Claude
  - Metricas actuales (ROAS, CPA, CTR, Freq)
  - Confianza + prioridad
  - Si tiene historial: "Ultima vez que hice esto: +12% ROAS" (del impact context)
  - Botones: Ejecutar / Rechazar

**C) Acciones en Medicion (vista resumida del impacto)**
- Tarjetas compactas de acciones ejecutadas recientemente
- Muestra: accion + entidad + tiempo restante + metricas parciales 24h si hay
- Link a seccion Impacto para ver detalle completo
- Titulo: "Observando resultados (X acciones)"

**D) Resumen del Cerebro**
- Resumen de Claude del ultimo analisis (texto)
- Alertas si hay (fatiga critica, ROAS cuenta bajo, etc)
- Metricas clave de cuenta: ROAS 7d, CPA 7d, Spend hoy, Frecuencia promedio

### 8. `src/dashboard/frontend/src/pages/ImpactReport.jsx` — Mejorar impacto
- Arreglar metricas vacias "Al ejecutar" para ads (entity_type = 'ad')
- Mostrar claramente que hizo cada accion:
  - update_ad_status: "Pausado" o "Activado"
  - pause/reactivate: estado anterior → nuevo
  - create_ad: nombre del ad creado
- Agregar badge "Alimentando al cerebro" si la accion ya fue usada como input del brain
- Eliminar filtro por agente (ya no hay 4 agentes, todo es "Cerebro IA")

### 9. `src/dashboard/frontend/src/api.js` — Actualizar API calls
- Actualizar getAutonomyConfig/updateAutonomyConfig para nuevo formato
- Agregar: getImpactContext() para mostrar que datos ve el cerebro

### 10. `src/dashboard/routes/agents.js` — Fix bug metricas
- En POST execute y en auto-execute:
  - Cuando entity_type es 'ad', buscar metricas del ad set padre (no del ad)
  - Guardar parent_entity_id en el snapshot lookup

## Archivos que NO se tocan
- `src/ai/unified/` — feature-builder.js, adaptive-scorer.js, policy-learner.js (se reusan)
- `src/ai/strategic/` — strategic-agent.js sigue generando directives
- `src/ai/creative/` — image generation, prompt generation, judge (intactos)
- `src/ai/adset-creator/` — manager.js y strategist.js (intactos)
- `src/ai/lifecycle-manager.js` — intacto
- `src/safety/` — kill-switch, cooldown-manager, guard-rail (intactos)
- `src/meta/` — client, data-collector, action-executor (intactos)
- `src/db/models/` — todos los modelos se mantienen
- Todas las otras paginas del frontend (Dashboard, AdSets, CreativeBank, etc)

## Archivos que se DEPRECAN (no eliminar, solo dejar de usar)
- `src/ai/agents/agent-runner.js` — reemplazado por unified-brain.js
- `src/ai/agents/scaling-agent.js` — absorbido por brain
- `src/ai/agents/performance-agent.js` — absorbido por brain
- `src/ai/agents/creative-agent.js` — absorbido por brain
- `src/ai/agents/pacing-agent.js` — absorbido por brain
- `src/ai/agents/base-agent.js` — ya no necesario
- `src/ai/decision-engine.js` — legacy, ya no se usa

## Orden de Implementacion

### Fase 1: Backend — Cerebro IA
1. Crear `src/ai/brain/impact-context-builder.js`
2. Crear `src/ai/brain/brain-prompts.js`
3. Crear `src/ai/brain/unified-brain.js`
4. Modificar `src/index.js` para usar UnifiedBrain
5. Simplificar `config/safety-guards.js` autonomia

### Fase 2: Backend — Rutas y fixes
6. Actualizar `src/dashboard/routes/agents.js`:
   - Adaptar endpoints para brain
   - Fix bug metricas para ads
   - Simplificar autonomy endpoints
7. Actualizar `src/db/queries.js` si necesario

### Fase 3: Frontend — Centro IA
8. Redisenar `src/dashboard/frontend/src/pages/Agents.jsx`
9. Mejorar `src/dashboard/frontend/src/pages/ImpactReport.jsx`
10. Actualizar `src/dashboard/frontend/src/api.js`

### Fase 4: Build y verificacion
11. Build frontend (`npm run build` en frontend/)
12. Verificar que todo compila sin errores
