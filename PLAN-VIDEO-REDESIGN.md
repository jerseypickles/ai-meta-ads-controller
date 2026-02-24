# PLAN: Video Pipeline Redesign — Opción C + Kling 3.0

## Resumen
Rediseñar el pipeline de video para generar comerciales con storytelling real
usando shots CONTEXT (ingredientes, lifestyle, proceso) alternados con shots
PRODUCT (hero, closeup, uso). Upgrade de Kling 2.6 → Kling 3.0 Pro para
aprovechar multi-shot, start/end frame, y física mejorada.

---

## CAMBIO 1: Nuevos Narrative Beats (Opción C)
**Archivo:** `src/video/video-pipeline.js`

Reemplazar los 12 NARRATIVE_BEATS actuales (todos centrados en producto)
con el nuevo sistema híbrido CONTEXT + PRODUCT:

```
Beat 1:  [CONTEXT]  "Ingredient Origin"    — Campo, huerto, ingrediente en su estado natural
Beat 2:  [CONTEXT]  "Fresh Harvest"        — Ingrediente clave en primer plano, textura, frescura
Beat 3:  [PRODUCT]  "Product Reveal"       — Primera aparición del producto, revelación dramática
Beat 4:  [CONTEXT]  "Craft Process"        — Preparación artesanal, cocina, proceso
Beat 5:  [PRODUCT]  "Label Hero"           — Close-up del label, branding, texto legible
Beat 6:  [CONTEXT]  "Lifestyle Scene"      — Mesa servida, picnic, fiesta, contexto de uso
Beat 7:  [PRODUCT]  "Product in Action"    — Producto abierto, contenido visible, siendo usado
Beat 8:  [CONTEXT]  "Ingredient Beauty"    — Ingredientes frescos artísticamente dispuestos
Beat 9:  [PRODUCT]  "Contents Glory"       — Contenido del producto afuera, apetitoso, brillante
Beat 10: [CONTEXT]  "Mood & Atmosphere"    — Shot artístico/cinematográfico del ambiente
Beat 11: [PRODUCT]  "Final Composition"    — Producto con todo el arrangement, como portada
Beat 12: [PRODUCT]  "Closing Hero"         — Hero shot final, brand visible, CTA
```

Cada beat tiene un nuevo campo `type: 'context' | 'product'`:
- **CONTEXT shots**: Se generan con text-to-image (no necesitan la foto del producto).
  Claude diseña un prompt descriptivo basado en los ingredientes/categoría.
  OpenAI genera una imagen totalmente nueva (no edit, sino generate).
- **PRODUCT shots**: Se generan con image edit (como hoy), usando la foto del
  producto como referencia. El producto se mantiene idéntico.

## CAMBIO 2: Claude Director actualizado
**Archivo:** `src/video/video-pipeline.js` — `analyzeProductAndRecommendScene()`

Actualizar el prompt del Director para:
1. Identificar ingredientes principales del producto (Claude Vision los detecta)
2. Diseñar prompts CONTEXT que sean ingredientes/proceso/lifestyle REALES
   relacionados al producto (no genéricos)
3. Marcar cada beat como `type: 'context'` o `type: 'product'`
4. Los prompts CONTEXT son text-to-image completos (sin "Edit this product...")
5. Los prompts PRODUCT siguen usando "Edit this product photograph..."
6. Agregar campo `ingredients` al output del director
7. Agregar campo `videoModel: 'kling-3.0-pro'` al output

Formato de output actualizado:
```json
{
  "productName": "...",
  "brand": "...",
  "category": "...",
  "ingredients": ["cucumber", "dill", "vinegar", "garlic"],
  "targetAudience": "...",
  "chosenScene": "...",
  "videoModel": "kling-3.0-pro",
  "shots": {
    "beat-01-ingredient-origin": {
      "type": "context",
      "imagePrompt": "A sun-drenched cucumber field in summer...",
      "videoPrompt": "Slow cinematic aerial push over cucumber field..."
    },
    "beat-03-product-reveal": {
      "type": "product",
      "imagePrompt": "Edit this product photograph. Change ONLY the background...",
      "videoPrompt": "Slow dolly in revealing product..."
    }
  }
}
```

## CAMBIO 3: Shot Generation con dos modos
**Archivo:** `src/video/video-pipeline.js` — `_generateShotsBackground()`

Modificar la generación para manejar ambos tipos:

- **CONTEXT shots** (`type: 'context'`):
  Usar `client.images.generate()` (no edit) con el prompt completo.
  No se pasa imagen de referencia. OpenAI genera desde cero.
  Tamaño: 1024x1536 (vertical 9:16).

- **PRODUCT shots** (`type: 'product'`):
  Usar `client.images.edit()` como hoy, con la foto del producto.
  Mismas instrucciones de fidelidad del label.

## CAMBIO 4: Upgrade Kling 2.6 → 3.0
**Archivo:** `src/video/video-pipeline.js` — `submitVideoJob()` y `checkVideoStatus()`

Cambios:
1. Modelo: `fal-ai/kling-video/v2.6/pro/image-to-video` → `fal-ai/kling-video/v3/pro/image-to-video`
2. Parámetro de imagen: `image_url` → `start_image_url` (API v3)
3. Nuevo parámetro: `end_image_url` — para shots consecutivos, usar el último
   frame conceptual del clip anterior (opcional, fase 2)
4. Nuevo parámetro: `generate_audio: false` (no generar audio, seguimos con
   FFmpeg + música local para control total)
5. Duración default: 5s → configurable 5-10s
6. `cfg_scale`: 0.7 → 0.5 (recomendado por v3 docs)

También actualizar `checkVideoStatus()` y `submitVideoBatch()` con el nuevo
model path.

## CAMBIO 5: Actualizar Quality Judge
**Archivo:** `src/video/video-pipeline.js` — `judgeShots()`

Actualizar criterios de scoring para diferenciar CONTEXT vs PRODUCT:

- **PRODUCT shots**: Mismos criterios (label fidelity, product integrity, etc.)
- **CONTEXT shots**: Nuevos criterios:
  - Realismo (40%): ¿Se ve como una foto real? No AI artifacts
  - Relevancia (30%): ¿Se conecta con el producto/ingredientes?
  - Calidad comercial (20%): ¿Serviría en un comercial profesional?
  - Continuidad (10%): ¿Fluye visualmente con los otros shots?

## CAMBIO 6: Actualizar constantes y exports
**Archivo:** `src/video/video-pipeline.js`

- Renombrar `NARRATIVE_BEATS` con los nuevos beats
- Agregar constante `VIDEO_MODEL` con el modelo actual
- Agregar constante `BEAT_TYPES = { context, product }`
- Mantener backward compat con `SHOT_TYPES = NARRATIVE_BEATS`
- Actualizar `CAMERA_MOTIONS` con movimientos más variados para context shots
  (aerials, tracking, crane)

## CAMBIO 7: Actualizar rutas
**Archivo:** `src/dashboard/routes/video.js`

- Nuevo endpoint: `GET /api/video/beat-types` — retorna los tipos de beat
- Actualizar `GET /api/video/narrative-beats` — incluir `type` field
- Sin cambios breaking en endpoints existentes

## CAMBIO 8: Actualizar frontend
**Archivo:** `src/dashboard/frontend/src/pages/VideoGenerator.jsx`

1. **Step 2 (Director Plan)**: Mostrar shots diferenciados:
   - CONTEXT shots con borde verde y etiqueta "CONTEXTO"
   - PRODUCT shots con borde azul y etiqueta "PRODUCTO"
   - Mostrar lista de ingredientes detectados

2. **Step 3 (Generated Shots)**: Diferenciación visual:
   - CONTEXT shots: icono de paisaje/ingrediente
   - PRODUCT shots: icono de producto
   - El judge muestra criterios diferentes por tipo

3. **Step 4 (Storyboard)**: Mostrar el flujo context→product alternado

4. **Step 5 (Clips)**: Mostrar costo actualizado ($0.224/s con Kling 3.0)

5. **Step 2 (Director Plan)**: Agregar selector de modelo:
   - Kling 3.0 Pro ($0.224/s) — Recomendado
   - Kling 3.0 Standard ($0.168/s) — Económico
   - Kling 2.6 Pro ($0.07/s) — Legacy

## CAMBIO 9: Actualizar api.js frontend
**Archivo:** `src/dashboard/frontend/src/api.js`

- Agregar `getBeatTypes()`
- Sin cambios breaking en funciones existentes

---

## Archivos a modificar (en orden)

1. `src/video/video-pipeline.js` — Cambios 1, 2, 3, 4, 5, 6
2. `src/dashboard/routes/video.js` — Cambio 7
3. `src/dashboard/frontend/src/api.js` — Cambio 9
4. `src/dashboard/frontend/src/pages/VideoGenerator.jsx` — Cambio 8

## Costos estimados por comercial

| Config | Shots | Duración | Costo Kling | Costo OpenAI | Total est. |
|--------|-------|----------|-------------|--------------|------------|
| 8 shots, 5s, 3.0 Standard | 8 | 40s | $6.72 | ~$0.80 | ~$8 |
| 10 shots, 5s, 3.0 Pro | 10 | 50s | $11.20 | ~$1.00 | ~$13 |
| 12 shots, 5s, 3.0 Pro | 12 | 60s | $13.44 | ~$1.20 | ~$15 |
| 8 shots, 5s, 2.6 Pro (legacy) | 8 | 40s | $2.80 | ~$0.80 | ~$4 |

## Lo que NO cambia
- Upload de producto (mismo flujo)
- FFmpeg stitching (mismo flujo)
- Music tracks (mismo catálogo)
- Stitch/download (mismo flujo)
- API backward compatible
