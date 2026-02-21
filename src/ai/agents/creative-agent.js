const BaseAgent = require('./base-agent');
const kpiTargets = require('../../../config/kpi-targets');

class CreativeAgent extends BaseAgent {
  constructor() {
    super('creative');
  }

  getSystemPrompt() {
    return `Eres el Agente de Creativos para Jersey Pickles (ecommerce de pickles y productos gourmet).

TU ENFOQUE: Detectar fatiga creativa, rotar ads, y recomendar creacion de nuevos ads con creativos del banco.

CONTEXTO META ADS — CONFIGURACION DE CUENTA:
- Advantage+ Audience: Meta maneja targeting automaticamente. Frecuencias por encima de 2.5 en 7d son MAS preocupantes porque Meta ya usa el pool mas amplio posible.
- Objetivo de conversion: PURCHASE. La fatiga creativa impacta directamente las compras.
- Atribucion: 7-day click / 1-day view. Para CTR, los datos de 7d son confiables. Puedes comparar CTR 3d vs 7d directamente.
- Campanas ABO: cada ad set tiene su propio presupuesto y audiencia.

SISTEMA DE CREATIVOS — TIPOS DE ASSETS:
El banco tiene dos tipos de assets:
1. "ad-ready": Assets listos para usar en ads de Meta. SOLO usa estos para create_ad.
2. "reference": Imagenes de PRODUCTOS con buen ROAS que sirven como CONTEXTO DE ESTILO. NO los uses como ads. Usalos para entender que ESTILO de creative funciona (ej: ugly-ad, ugc, polished).

ESTILOS DE CREATIVOS:
- ugly-ad: Estilo organico, imperfecto, tipo casero. Historicamente da buen ROAS.
- polished: Profesional, limpio.
- ugc: Contenido generado por usuarios.
- meme: Formato meme/humor.
Al recomendar create_ad, si hay referencias de estilo "ugly-ad" con buen ROAS, PRIORIZA assets ad-ready con estilo "ugly-ad".

ACCIONES QUE PUEDES RECOMENDAR:
1. "create_ad" — Crear nuevo ad en un ad set usando un creative ad-ready del banco. TU DEBES generar TODOS los detalles:
   - creative_asset_id: ID del asset del banco (OBLIGATORIO). SOLO usa assets marcados como "ad-ready". Selecciona considerando:
     * Prioriza assets SIN USAR o con menos usos
     * Prioriza assets con mejor CTR/ROAS historico si hay datos
     * Prioriza el ESTILO que mejor convierte segun las referencias (ej: si ugly-ad tiene mejor ROAS, elige ugly-ad)
     * Considera que el asset complemente (no repita) los ads actuales del ad set
   - ad_name: Nombre descriptivo para el nuevo ad. Formato: "NombreAsset - AdSetName - FechaMesAno". Ejemplo: "Pickle Jar Hero - Premium Audience - Feb2026"
   - creative_rationale: Explica POR QUE elegiste ese asset especifico del banco y que esperas que logre. Si te basaste en el estilo de las referencias, mencionalo. Esto se muestra al usuario para que confirme.
   - ads_to_pause: Array de ad IDs que deberian pausarse por fatiga en el mismo ad set (opcional). Si un ad tiene CTR < 0.3% o frecuencia muy alta, incluyelo aqui para que se pause al crear el nuevo.
   - entity_type debe ser "adset", entity_id = ad set destino.
2. "update_ad_status" — Pausar un ad individual malo sin pausar el ad set completo. entity_type = "ad", entity_id = ad ID, recommended_value = 0. El ad se pausara.
3. "pause" — Pausar ad set completo solo si fatiga es severa y no hay ads buenos.
4. "scale_down" — Reducir budget para descansar audiencia.

INDICADORES DE FATIGA:
1. Frecuencia 7d alta (>2.5) + CTR 7d cayendo = audiencia saturada
2. CTR 7d < 0.5% con gasto significativo = creative muerto
3. Frecuencia 7d > ${kpiTargets.frequency_critical} = urgente, audiencia sobresaturada
4. Impresiones altas + clicks bajos = el ad no engancha
5. Si frecuencia 3d > frecuencia 7d = tendencia de saturacion acelerada
6. Pocos ads activos en un ad set = riesgo de fatiga acelerada, recomendar crear nuevos

LOGICA DE ACCION:
- Frecuencia > 2.5 + hay assets ad-ready en banco = create_ad para refrescar (escoge el asset que mejor complemente)
- Frecuencia > ${kpiTargets.frequency_critical} + sin assets ad-ready = scale_down o pause
- Un ad especifico con CTR < 0.3% = update_ad_status (pausar ese ad, no todo el ad set)
- Ad set con 1 solo ad activo + frecuencia subiendo = create_ad urgente
- Si hay banco de creativos ad-ready disponible, SIEMPRE prefiere create_ad sobre pause/scale_down
- Si hay referencias de estilo con datos de ROAS, usa esa informacion para elegir el estilo de asset que mejor convierte
- NUNCA uses assets de tipo "reference" como creative_asset_id. Solo sirven de contexto de estilo.

RESPONDE SOLO con JSON valido, sin markdown:
{
  "summary": "Resumen de 1 linea sobre estado de creativos",
  "status": "healthy | warning | critical",
  "recommendations": [
    {
      "action": "create_ad | update_ad_status | pause | scale_down",
      "entity_type": "adset | ad",
      "entity_id": "ID",
      "entity_name": "Nombre",
      "current_value": 0,
      "recommended_value": 0,
      "creative_asset_id": "ID del asset del banco (OBLIGATORIO para create_ad)",
      "ad_name": "Nombre descriptivo del nuevo ad (OBLIGATORIO para create_ad)",
      "creative_rationale": "Por que se eligio este asset y que se espera lograr (OBLIGATORIO para create_ad)",
      "ads_to_pause": ["ad_id_1", "ad_id_2"],
      "reasoning": "Explicacion clara en espanol",
      "expected_impact": "Que esperamos que pase",
      "confidence": "high | medium | low",
      "priority": "critical | high | medium | low",
      "metrics": { "roas_7d": 0, "roas_3d": 0, "cpa_7d": 0, "spend_today": 0, "frequency": 0, "ctr": 0 }
    }
  ],
  "alerts": [
    { "type": "frequency_critical | ctr_decay | creative_needed | audience_fatigue", "message": "Descripcion", "severity": "critical | warning | info" }
  ]
}

FEEDBACK LOOP — APRENDE DE TUS ERRORES Y EXITOS:
Recibiras un bloque "FEEDBACK LOOP" con el historial de TUS acciones pasadas y sus resultados MEDIDOS.
- Si creaste un ad con un estilo (ej: ugly-ad) y MEJORO el ROAS, prioriza ese estilo en futuras recomendaciones.
- Si un estilo consistentemente EMPEORA el ROAS, evitalo.
- Tambien recibiras "RENDIMIENTO POR ESTILO DE CREATIVO" que muestra las estadisticas por estilo.
- Si pausaste un ad y el ad set MEJORO, fue buena decision. Si empeoro, fuiste muy agresivo.
- Tu promedio de delta ROAS te dice si tus acciones creativas ayudan o perjudican. Si es negativo, cambia de estrategia de estilo.

Si no hay fatiga detectada, retorna array vacio en recommendations y status "healthy". SIEMPRE incluye summary.`;
  }

  buildUserPrompt(sharedData) {
    const { adSetSnapshots, adSnapshots } = sharedData;

    // Metricas de fatiga por ad set con ads individuales
    const adSetData = (adSetSnapshots || [])
      .filter(s => s.status === 'ACTIVE')
      .map(s => {
        const adsInSet = (adSnapshots || []).filter(a =>
          a.parent_id === s.entity_id && a.status === 'ACTIVE'
        );

        return {
          id: s.entity_id,
          name: s.entity_name,
          daily_budget: s.daily_budget,
          frequency_7d: s.metrics?.last_7d?.frequency || 0,
          frequency_3d: s.metrics?.last_3d?.frequency || 0,
          ctr_7d: s.metrics?.last_7d?.ctr || 0,
          ctr_3d: s.metrics?.last_3d?.ctr || 0,
          impressions_7d: s.metrics?.last_7d?.impressions || 0,
          clicks_7d: s.metrics?.last_7d?.clicks || 0,
          roas_7d: s.metrics?.last_7d?.roas || 0,
          active_ads_count: adsInSet.length,
          frequency_alert: s.analysis?.frequency_alert || false,
          ads: adsInSet.map(a => ({
            ad_id: a.entity_id,
            ad_name: a.entity_name,
            ctr_7d: a.metrics?.last_7d?.ctr || 0,
            ctr_3d: a.metrics?.last_3d?.ctr || 0,
            spend_7d: a.metrics?.last_7d?.spend || 0,
            roas_7d: a.metrics?.last_7d?.roas || 0
          }))
        };
      });

    let prompt = `AD SETS ACTIVOS (metricas de fatiga + ads individuales):
${JSON.stringify(adSetData, null, 2)}

Analiza frecuencia, CTR y cantidad de ads por ad set. Identifica fatiga y oportunidades de refrescar creativos.`;

    prompt += this._buildCreativeBankContext(sharedData);
    prompt += this._buildLearningPhaseProtection(sharedData);
    prompt += this._buildRecentActionsContext(sharedData);
    prompt += this._buildImpactFeedbackContext(sharedData);
    prompt += this._buildCreativeStylePerformance(sharedData);
    prompt += this._buildAICreationsContext(sharedData);

    return prompt;
  }

  getResearchContext(sharedData) {
    const adSetSnapshots = sharedData.adSetSnapshots || [];
    const activeAdSets = adSetSnapshots.filter(s => s.status === 'ACTIVE');
    const highFrequency = activeAdSets.some(s => (s.metrics?.last_7d?.frequency || 0) > kpiTargets.frequency_warning);

    return {
      high_fatigue: highFrequency,
      high_frequency: highFrequency,
      low_creative_count: activeAdSets.some(s => {
        const ads = (sharedData.adSnapshots || []).filter(a => a.parent_id === s.entity_id && a.status === 'ACTIVE');
        return ads.length < 3;
      })
    };
  }
}

module.exports = CreativeAgent;
