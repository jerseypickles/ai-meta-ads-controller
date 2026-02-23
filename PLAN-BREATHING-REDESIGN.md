# PLAN: Sistema de Respiracion — Rediseno Brain + AI Manager

## Problema
El sistema dispara cientos de acciones/eventos por dia sin esperar resultados.
Meta Ads necesita 3-7 dias para mostrar resultados reales. El sistema actual
hace cambios cada 30 minutos — es como ajustar el volante cada segundo.

## Principio Fundamental
> Un cerebro de calidad PLANTA, ESPERA, MIDE, y DECIDE.
> No planta y arranca la planta 30 minutos despues.

---

## CAMBIOS POR ARCHIVO

### 1. `config/safety-guards.js` — Timers reales para Meta Ads

**Cambios:**
- `cooldown_hours: 6` → `cooldown_hours: 24` (minimo 24h entre acciones en misma entidad)
- `anomaly_detection.cooldown_hours: 6` → `cooldown_hours: 24` (no repetir anomalias)

**Justificacion:** 6 horas no es suficiente para Meta. Las conversiones se atribuyen en ventana de 24h-7d. Hacer cambios cada 6h es ruido.

### 2. `config/unified-policy.js` — Limitar acciones por ciclo

**Cambios:**
- `max_recommendations_per_cycle: 12` → `max_recommendations_per_cycle: 5`

**Justificacion:** 12 acciones cada 30 min = 576/dia. 5 acciones cada 6h = 20/dia maximo. Un cerebro de calidad actua poco y mide mucho.

### 3. `src/index.js` — Frecuencias de cron realistas

**Cambios:**
```
Brain:            cada 30 min  → cada 6 horas (4 veces al dia)
AI Manager:       cada 2 horas → cada 8 horas (3 veces al dia)
Anomaly Detector: cada 10 min  → cada 1 hora
Lifecycle Manager: cada 30 min → cada 2 horas
```

**Cron schedules nuevos:**
- Brain: `'0 7,13,19,23 * * *'` (7am, 1pm, 7pm, 11pm ET)
- AI Manager: `'0 9,17,22 * * *'` (9am, 5pm, 10pm ET — DESPUES del Brain para leer directivas)
- Anomaly Detector: `'0 * * * *'` (cada hora en punto)
- Lifecycle Manager: `'30 */2 * * *'` (cada 2 horas, offset 30min)

**Justificacion:** Brain analiza 4 veces al dia. Manager ejecuta 3 veces al dia, siempre despues del Brain. Anomaly detector cada hora es suficiente para detectar emergencias sin generar ruido. Esto da tiempo a Meta para procesar cada cambio.

### 4. `src/safety/anomaly-detector.js` — Dejar de gritar por ROAS de "hoy"

**Cambios:**
- Comparar ROAS `last_3d` vs `last_7d` en vez de `today` vs `last_7d`
- Agregar check: si `spend_today < 30% del budget diario`, no evaluar (es temprano en el dia, datos incompletos)
- Cooldown de 24h (via config change arriba)
- Agregar filtro: no crear SafetyEvent si ya existe uno identico (mismo entity, mismo type) en las ultimas 24h

**Justificacion:** ROAS de "hoy" a las 8am siempre es 0 porque Meta atribuye conversiones con delay. Comparar 3d vs 7d da signal real. El filtro de 30% spend evita falsos positivos temprano en el dia.

**Codigo clave a cambiar (lineas 158-182):**
```javascript
// ANTES: comparaba today vs 7d (siempre alarma temprano)
const roasToday = toNumber(today.roas);
// DESPUES: comparar 3d vs 7d (signal real de deterioro)
const last3d = metrics.last_3d || {};
const roas3d = toNumber(last3d.roas);
const spend3d = toNumber(last3d.spend);
// Solo evaluar si hay suficiente spend en 3d (evitar noise con $5)
if (spend3d < spendThreshold * 3) return [];
const roasDrop = (roas7d - roas3d) / roas7d;
```

### 5. `src/ai/brain/unified-brain.js` — Brain solo PIENSA, no ejecuta

**Cambios criticos:**

#### 5a. Filtro pendingEntities debe bloquear TODAS las acciones (no solo scale/pause)
- Linea 123: El filtro ya existe pero el Brain puede generar `optimize_ads`, `update_ad_status`, `create_ad` que van como directivas al Manager y NO se filtran por pending
- Agregar: antes de `_createDirectivesForAIManager()`, filtrar recs donde entity_id este en pendingEntities

#### 5b. Limitar max_recommendations_per_cycle a 5 (via config change)

#### 5c. NO crear directivas duplicadas
- Antes de crear una nueva StrategicDirective, verificar si ya existe una activa con mismo entity_id + directive_type + target_action
- Si existe, solo incrementar `consecutive_count`, NO crear nueva
- Esto evita el spam de "27+ directivas OPTIMIZE_ADS"

#### 5d. Cooldown de directivas: no emitir directiva si la ultima fue hace < 24h
- En `_createDirectivesForAIManager()`, verificar si ya hay directiva activa para esa entidad creada en las ultimas 24h
- Si existe → skip (o solo actualizar consecutive_count)

### 6. `src/ai/adset-creator/manager.js` — Manager respeta tiempos

**Cambios:**

#### 6a. Respetar pendingEntities del ImpactContextBuilder
- Antes de llamar a Claude para un ad set, verificar si tiene acciones pendientes de medicion (< 3 dias)
- Si tiene → skip este ad set, log "Esperando medicion de impacto"
- Usar ActionLog.findOne({ entity_id, success: true, impact_measured: { $ne: true }, executed_at: { $gte: 3daysAgo } })

#### 6b. Respetar cooldown de 24h entre acciones
- Ya usa CooldownManager pero el COOLDOWN_DAYS=3 es solo para el cooldown post-accion
- Agregar check adicional: si la ultima accion (de CUALQUIER agente, brain o manager) fue hace < 24h → skip
- Esto previene que Manager actue sobre algo que el Brain acaba de tocar

#### 6c. Marcar directivas como "applied" cuando se actua
- Despues de ejecutar acciones, buscar directivas activas del Brain para esa entidad y marcarlas como `status: 'applied'`
- Esto mejora el compliance tracking y evita que el Brain re-emita

### 7. `src/safety/cooldown-manager.js` — Cooldown real de 24h minimo

**Cambios:**
- `COOLDOWN_DAYS = 3` → mantener 3 dias pero agregar `MIN_HOURS_BETWEEN_ACTIONS = 24`
- Nuevo metodo: `hasRecentAction(entityId, hours = 24)` que chequea si CUALQUIER agente (brain, ai_manager, anomaly_detector) actuo en las ultimas N horas
- Este metodo se usa en Brain y Manager antes de actuar

---

## RESUMEN DE FRECUENCIAS: ANTES vs DESPUES

| Componente | ANTES | DESPUES |
|-----------|-------|---------|
| Data Collection | 10 min | 10 min (sin cambio — solo lee) |
| Anomaly Detector | 10 min | 1 hora |
| Kill Switch | 15 min | 15 min (sin cambio — emergencia) |
| Brain | 30 min | 6 horas |
| Lifecycle Manager | 30 min | 2 horas |
| AI Manager | 2 horas | 8 horas |
| Impact Measurement | 2 horas | 2 horas (sin cambio) |

| Metrica | ANTES | DESPUES |
|---------|-------|---------|
| Max acciones Brain/dia | 288 | 20 |
| Max acciones Manager/dia | ~100 | ~15 |
| Max anomaly events/dia | 144 | 17 |
| Tiempo minimo entre acciones/entidad | 6h (config, 3d cooldown) | 24h minimo |
| Directivas duplicadas | Ilimitadas (27+ vistas) | 1 por entidad/tipo/24h |

---

## ORDEN DE IMPLEMENTACION (seguro, sin romper nada)

1. **config/safety-guards.js** — Cambiar cooldown_hours (cero riesgo, solo config)
2. **config/unified-policy.js** — Reducir max_recommendations (cero riesgo)
3. **src/index.js** — Cambiar cron schedules (bajo riesgo, solo timing)
4. **src/safety/anomaly-detector.js** — Comparar 3d vs 7d (bajo riesgo)
5. **src/safety/cooldown-manager.js** — Agregar hasRecentAction (bajo riesgo, aditivo)
6. **src/ai/brain/unified-brain.js** — Filtrar pending + dedup directivas (medio riesgo)
7. **src/ai/adset-creator/manager.js** — Respetar pending + marcar applied (medio riesgo)

Cada paso es independiente y se puede deployear por separado. Si algo falla, se revierte solo ese archivo.

---

## VALIDACION POST-DEPLOY

Despues de deployear, verificar en AI Ops:
1. Timeline debe mostrar ~20 eventos/dia en vez de ~500
2. Anomaly events deben comparar 3d vs 7d (no "hoy vs 7d")
3. No debe haber directivas duplicadas masivas (max 1 por entidad/tipo/24h)
4. Compliance rate debe mejorar (Manager tiene tiempo de actuar)
5. Brain debe mostrar "Filtrada por medicion pendiente" en logs
