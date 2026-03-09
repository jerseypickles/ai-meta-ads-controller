# Plan: 5 Fixes para el Loop de Aprendizaje del Brain

## Fix 1: Inyectar lecciones aprendidas en el prompt de recomendaciones
**Archivo:** `src/ai/brain/brain-analyzer.js`
**Función:** `_buildRecommendationPrompt()` (línea ~1662)

**Cambios:**
1. Antes de construir el prompt (línea ~1468), cargar las últimas lecciones:
   ```js
   const recentLessons = await BrainRecommendation.find({
     'follow_up.ai_analysis.lesson_learned': { $exists: true, $ne: '' }
   }).sort({ updated_at: -1 }).limit(15).lean();
   ```
2. Pasar `recentLessons` como parámetro a `_buildRecommendationPrompt()`
3. En el prompt (~línea 1816), agregar sección LECCIONES APRENDIDAS:
   ```
   ## LECCIONES APRENDIDAS (de seguimientos completados)
   - [scale_up/negative] "Escalar con freq > 3.0 causa fatiga" (Ad Set X, hace 5d)
   - [creative_refresh/positive] "Creative refresh mejora CTR en 48h" (Ad Set Y, hace 12d)
   INSTRUCCIÓN: Aplica estas lecciones. No repitas errores documentados.
   ```

## Fix 2: Pasar contexto de overlap al análisis AI del día 14
**Archivo:** `src/ai/brain/brain-analyzer.js`
**Función:** `_runAIImpactAnalysis()` (línea ~2320)

**Cambios:**
1. Dentro de `followUpApprovedRecommendations()` (línea ~2090), antes de llamar a `_runAIImpactAnalysis`, buscar acciones concurrentes:
   ```js
   const concurrentRecs = approvedRecs.filter(other =>
     other._id.toString() !== rec._id.toString() &&
     other.entity?.entity_id === rec.entity?.entity_id &&
     other.status === 'approved'
   );
   ```
2. Pasar `concurrentRecs` a `_runAIImpactAnalysis()`
3. En el prompt del día 14 (~línea 2325), agregar sección:
   ```
   ACCIONES CONCURRENTES EN ESTA ENTIDAD:
   - "Scale Up" aprobada día 5 (5 días después de esta acción), fase: awaiting_day_7, día 3: positivo
   INSTRUCCIÓN: Considera que el impacto medido puede estar compartido con estas acciones.
   ```

## Fix 3: Marcar acciones concurrentes en action_history
**Archivo:** `src/db/models/BrainMemory.js` — agregar campos al schema
**Archivo:** `src/ai/brain/brain-analyzer.js` — línea ~2065 donde se escribe historyEntry

**Cambios en BrainMemory schema:**
- Agregar `concurrent_actions: [{ type: String }]` al subdocumento de action_history
- Agregar `attribution: { type: String, enum: ['sole', 'shared'], default: 'sole' }`

**Cambios en brain-analyzer.js (línea ~2053):**
1. Al escribir action_history en day_7, buscar otras recs activas para esa entidad
2. Si existen, marcar `attribution: 'shared'` y `concurrent_actions: ['scale_up']`

**Cambios en prompt (línea ~1718):**
- Al mostrar historial de acción, incluir si fue `shared`:
  `✓scale_up(+30% ROAS, 5d ago, shared w/ creative_refresh)`

## Fix 4: Descontar reward en Policy Learner cuando hay overlap
**Archivo:** `src/ai/unified/policy-learner.js`
**Función:** `consumeImpactFeedback()` (línea ~14) y `_calculateReward()` (línea ~197)

**Cambios:**
1. En `consumeImpactFeedback()`, antes de calcular reward, buscar acciones concurrentes:
   ```js
   // Buscar otras acciones en la misma entidad ejecutadas dentro de ±7 días
   const concurrentActions = await ActionLog.countDocuments({
     entity_id: action.entity_id,
     _id: { $ne: action._id },
     success: true,
     executed_at: {
       $gte: new Date(action.executed_at - 7*86400000),
       $lte: new Date(action.executed_at.getTime() + 7*86400000)
     }
   });
   ```
2. Aplicar factor de descuento al reward:
   ```js
   const overlapDiscount = 1 / (1 + concurrentActions);
   reward *= overlapDiscount;
   ```
3. Guardar `learned_overlap_count` en ActionLog para auditoría

## Fix 5: Ajustar win_rate para no contar doble
**Archivo:** `src/ai/brain/impact-context-builder.js`
**Función:** `_processActions()` (línea ~86) y `_extractPatterns()` (línea ~134)

**Cambios:**
1. En `_processActions()`, para cada acción, contar concurrentes:
   ```js
   // Buscar si hubo otras acciones en la misma entidad dentro de ±7d
   const concurrent = actions.filter(other =>
     other._id !== a._id &&
     other.entity_id === a.entity_id &&
     Math.abs(other.executed_at - a.executed_at) < 7*86400000
   );
   const weight = concurrent.length > 0 ? 1 / (1 + concurrent.length) : 1.0;
   ```
2. En `_extractPatterns()`, usar weight para calcular success_rate ajustado
3. En summary, calcular win_rate ponderado:
   ```js
   const weightedImproved = processed.reduce((sum, a) => sum + (a.result === 'improved' ? a.weight : 0), 0);
   const totalWeight = processed.reduce((sum, a) => sum + a.weight, 0);
   summary.success_rate_pct = totalWeight > 0 ? Math.round(weightedImproved / totalWeight * 100) : 0;
   ```

## Archivos modificados (resumen)
1. `src/ai/brain/brain-analyzer.js` — Fixes 1, 2, 3
2. `src/ai/unified/policy-learner.js` — Fix 4
3. `src/ai/brain/impact-context-builder.js` — Fix 5
4. `src/db/models/BrainMemory.js` — Fix 3 (schema)
5. `src/db/models/ActionLog.js` — Fix 4 (campo nuevo)
