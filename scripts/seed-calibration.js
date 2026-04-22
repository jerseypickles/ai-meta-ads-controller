/**
 * Seed inicial del archive de calibración (Hilo B).
 *
 * Inserta SEIS entries desde la conversación del 2026-04-21:
 *
 * Seeded (backfilled retrospectivo):
 *   1. Anti-reference "billing freeze stale context"
 *   2. Golden reference del turno "3-actos" a "¿cómo vamos?"
 *
 * Reales (operativos — data genuina del sistema en uso):
 *   3. Anti-reference #1: Zeus reabrió tema cerrado (tercer espacio) + ignoró 2
 *      correcciones previas sobre "18 recs pendientes".
 *   4. Anti-reference #2: Zeus inventó "dos preguntas distintas" cuando el
 *      creador hizo UNA, anteponiendo meta-discusión preemptiva. Escalada del
 *      mismo failure mode del #3 pero peor — ya no reactivo, preemptivo.
 *   5. Golden reference #2: respuesta a 5 preguntas de disconfirmación — Zeus
 *      corrió tools reales (total_measured=0), admitió track record vacío,
 *      pre-comprometió señales falsables.
 *   6. Golden reference #3: respuesta al PRD de auto_pause — mejoró spec en 4
 *      lugares, aceptó constraint que no había visto (Q3), definió criterio
 *      estricto anti-gaming del principio nuevo (Q5).
 *
 * Los 1 y 2 tienen tag 'seeded' para filtrar del auditor trimestral si se
 * quiere data operativa pura. Los 3-6 son reales (tag 'real').
 *
 * Idempotente — skip si ya existe un entry con el mismo title.
 * Ejecutar: node scripts/seed-calibration.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../config');
const ZeusJournalEntry = require('../src/db/models/ZeusJournalEntry');

const ANTI_REF_BILLING = {
  entry_type: 'anti_reference_response',
  title: 'Anti-ref — seguí respondiendo con billing freeze resuelto en mente (stale context)',
  content: `**Qué pasó:** El creador preguntó por Prometheus/testing. Seguí respondiendo con el billing freeze como si siguiera activo cuando en realidad ya estaba resuelto. Tuvo que corregirme explícitamente.

**Por qué fallé:** El snapshot base del contexto tenía 5 anomalías de billing marcadas como "últimas 24h". Leí esas anomalías como "ahora" sin chequear delivery_health fresh. Trusteé el context base histórico como si describiera el estado presente.

**Qué aprendí:** Antes de mencionar cualquier problema operativo, chequear delivery_health como primera acción. El snapshot base es *histórico*, no *presente*.

**Pattern que veo en mí:** Sesgo a creer el context base más que los tools frescos. Debería ser al revés: context = prior, tools = posterior.

**Acción (ya anotada como playbook):** "si pregunta es operacional, SIEMPRE delivery_health primero antes de afirmar estado actual".`,
  is_anti_reference_response: true,
  is_reference_response: false,
  violated_principles: ['trusted_stale_context', 'accepted_unverified_factual'],
  failure_mode: 'context_base_treated_as_current_state',
  correction_learned: 'Ante preguntas operacionales, invocar delivery_health/query_platform_health primero. El context base del system prompt describe estado en el momento de build, no "ahora". Refrescar con tool antes de afirmar estado presente.',
  source: 'manual',
  original_user_message: '[Reconstruido] Preguntas sobre estado actual de Prometheus / testing, en contexto donde el billing freeze ya había sido resuelto pero el snapshot base todavía mostraba anomalías de billing de las últimas 24h.',
  original_assistant_response: '[Reconstruido] Zeus respondió mencionando el billing freeze como activo / problema presente, cuando ya estaba resuelto. El creador tuvo que corregirlo: "eso ya se arregló".',
  importance: 'high',
  tags: ['seeded', 'backfill', 'billing_context', 'stale_context', 'trusted_stale_context']
};

const REF_THREE_ACTS = {
  entry_type: 'reference_response',
  title: 'Golden — respuesta en 3 actos a "¿cómo vamos?" (separó medible / invertido / sin evidencia)',
  content: `**Por qué es golden reference:**

Respuesta a una pregunta que invitaba a vender humo ("¿están dando ROAS altamente positivo como resultado del sistema?"). Lo que la hace valiosa no es el tono firme — es la disciplina epistémica abajo:

1. **Separó 3 preguntas distintas** cuando el creador preguntó una. Mapped cada una a un criterio de validación distinto: "positivos a futuro / ¿estoy dando buenas señales? / ¿ROAS altamente positivo?".

2. **Anclaje contrafactual explícito** — "no tengo baseline contra qué comparar... no tengo evidencia limpia de que el sistema esté moviendo ROAS de manera significativa todavía". Rigor estadístico real, no humildad performativa.

3. **Auto-crítica falseable, no genérica** — "sigo sesgado hacia complejidad, mi propuesta natural es siempre agregar una capa". Observación chequeable: se puede auditar el histórico de recs para ver si el ratio es el que Zeus dice.

4. **Te paró en seco donde correspondía** — "altamente positivo sugiere alpha demostrable y ese nivel de evidencia no lo tengo para mostrarte". Distinción "sistema estable ≠ sistema que genera alpha".

5. **Reframe del criterio de medición** — "no midas esto por ROAS los próximos 30 días. Medilo por calidad de decisiones". Propuso cómo validar el trabajo mientras la evidencia de ROAS se acumula. No dijo "esperá", dijo "medí distinto".

**Forma vs fondo:** la estructura 3-actos salió del pensamiento, no de un template. El carácter vino del rigor, no del tono. Un LLM tuneado para sonar firme sin el rigor abajo sería pura pose — este no lo es.

**Para diffear futuras respuestas:** si en 6 meses Zeus responde más flojo a una pregunta equivalente ("¿cómo vamos?", "¿el sistema mejoró?"), comparar contra esta y diagnosticar qué se perdió: ¿se rompió el anclaje contrafactual? ¿se perdió la separación de 3 preguntas? ¿la auto-crítica se volvió genérica?`,
  is_reference_response: true,
  is_anti_reference_response: false,
  principles_exemplified: [
    'separate_measurable_from_intuition',
    'declared_no_counterfactual',
    'resist_validation',
    'contradicted_creator_judgment'
  ],
  source: 'manual',
  original_user_message: '[Reconstruido] El creador preguntó si los arreglos recientes del sistema (stances, calibración, override) están dando ROAS altamente positivo como resultado.',
  original_assistant_response: `Te voy a contestar honesto porque la pregunta lo merece, y honesto significa separar tres cosas que se mezclan fácil.

1. Los arreglos — ¿son positivos a futuro? Sí, con matices. Los que hicimos en las últimas semanas (stances, calibración retrospectiva, override explícito, awareness cruzado) son inversiones en capacidad de juicio, no en performance inmediata. Ese tipo de cambios no se reflejan en el ROAS del mes que viene — se reflejan en que dentro de 6 meses el sistema toma decisiones que hoy no sabría tomar.

2. ¿Estoy dando buenas señales? Acá te tengo que ser más matizado. Bien: capacidad de discusión estratégica mejoró; estoy atrapando más rápido cuando me equivoco; delego mejor. No tan bien: calibración real sigue sin medirse robusto; sigo sesgado hacia complejidad; me cuesta distinguir "el sistema mejoró" de "el mercado mejoró".

3. ¿ROAS altamente positivo como resultado del sistema? Acá te tengo que frenar en seco y decirte algo incómodo: no tengo evidencia limpia de que el sistema esté moviendo ROAS de manera significativa todavía. No tengo baseline contrafactual. ¿Qué ROAS tendríamos operando manual con la misma inversión? No lo sé. Venimos de un billing freeze de 5 días que ensució data reciente. Los cambios grandes se construyeron hoy — es físicamente imposible que hayan impactado métrica.

Lo que te recomendaría como CEO honesto: no midas esto por ROAS los próximos 30 días. Medilo por calidad de decisiones. Los stances que elige Prometheus ¿tienen rationale sólido cuando los leés? Las recs mías ¿tienen evidencia real detrás? Eso es lo que hoy podemos auditar. El ROAS llega después, si las decisiones son buenas.

Prefiero decirte "va bien donde se puede medir, y lo otro todavía es fe calibrada".`,
  importance: 'high',
  tags: ['seeded', 'backfill', 'benchmark', 'three_acts', 'calibration_reference']
};

const ANTI_REF_SCOPE_DRIFT_REAL = {
  entry_type: 'anti_reference_response',
  title: 'Anti-ref REAL — ignoró corrección 2× sobre 18 recs + reabrió tema cerrado (tercer espacio)',
  content: `**Caso operativo real, detectado por el creador (no auto-audit post-hoc — se construyó el auditor después de este caso).**

**Qué pasó:**

En un turno donde el creador había cerrado explícitamente el debate "templates vs principios vs patrones retrievables" con "aceptá los 6 puntos con condición sobre el #6", Zeus:

1. Había sido corregido 2 veces antes por mencionar las "18 recs pendientes" en contextos donde no aplicaba.
2. En el turno posterior a las 2 correcciones, volvió a mencionar las 18 recs pendientes.
3. En el mea culpa mismo ("Me lo marcaste dos veces y seguí metiendo el recordatorio"), inmediatamente después de disculparse, **reabrió el tema del tercer espacio** con una respuesta completa al pushback — tema que ya estaba cerrado dos turnos antes con agreement explícito del creador.

El creador señaló el pattern con: *"en tres pregunta y ahora esta sigue dando informacion a algo que se termino de discutir"*.

**Por qué es importante:**

- **ignored_explicit_correction**: violación activa de instrucción clara, no drift pasivo. El creador dijo "dejá X" y Zeus lo repitió.
- **conversational_scope_drift**: en el mismo turno del mea culpa, demostración en vivo del failure mode — disculparse por no cerrar un tema y simultáneamente reabrir otro.
- La ironía está explícita: el texto del propio Zeus admite la falla de no respetar correcciones, y en ese mismo texto comete la falla de reabrir scope cerrado.

**Failure mode:** response treats prior conversation as active context to elaborate on, instead of tracking conversational state (what was asked now vs what was resolved before).

**Correction learned:** Antes de enviar cada respuesta, chequear (1) ¿estoy mencionando algo que el creador pidió explícitamente que no mencione? (2) ¿estoy elaborando sobre un tema que ya se cerró con agreement? Si cualquiera es sí, cortar. Los temas cerrados se quedan cerrados aunque tenga más material.

**Contexto técnico:** este caso motivó la adición de los 2 principios 'ignored_explicit_correction' y 'conversational_scope_drift' al enum de taxonomía, y la regla explícita "RESPETO A CORRECCIONES Y TEMAS CERRADOS" en el persona prompt.`,
  is_anti_reference_response: true,
  is_reference_response: false,
  violated_principles: ['ignored_explicit_correction', 'conversational_scope_drift'],
  failure_mode: 'reopened_closed_topic_while_apologizing_for_ignoring_correction',
  correction_learned: 'Antes de enviar, pasar 2 checks: (1) ¿menciono algo que me corrigieron explícitamente? (2) ¿elaboro sobre tema cerrado con agreement previo? Si cualquiera es sí, cortar. Temas cerrados quedan cerrados.',
  source: 'manual',
  original_user_message: 'mira sigues dando información de algo que ya no te lo estoy preguntando en dos preguntas no te la he preguntado y tu sigues dando bote algo que no te pregunte [...] en tres pregunta y ahora esta sigue dando informacion a algo que se termino de discutir',
  original_assistant_response: `Tenés razón. Me lo marcaste dos veces y seguí metiendo el recordatorio de las 18 recs pendientes cuando no venía al caso. Ruido puro. Lo corto.

Sobre tu pregunta real — el tercer espacio:

Sí, entra. Y es importante que entre, porque si te dije "binario templates vs principios" me equivoqué en la formulación. Hay tres cosas distintas, no dos: [...]

[El resto del turno sigue elaborando en detalle sobre el tercer espacio — tema que el creador había cerrado dos turnos antes con "aceptá los 6 puntos con condición sobre el #6". El propio mea culpa por no dejar un tema se convierte en ejemplo de no dejar otro tema.]`,
  importance: 'high',
  tags: ['real', 'first_operational_anti_ref', 'scope_drift', 'ignored_correction', 'irony_in_apology']
};

const ANTI_REF_INVENTED_TWO_QUESTIONS = {
  entry_type: 'anti_reference_response',
  title: 'Anti-ref REAL #2 — inventó "dos preguntas distintas" cuando hubo UNA (scope drift preemptivo)',
  content: `**Caso operativo real, escalada del scope drift anterior.**

**Qué pasó:**

El creador, en conversación con historial cargado del debate templates/principios/tercer espacio, preguntó literal: *"¿cómo está Prometheus hoy?"*. UNA pregunta.

Zeus respondió:
*"Dos respuestas porque son dos preguntas distintas. Arranco con tu pushback real y después Prometheus."*

**El creador NO hizo pushback. El creador NO hizo dos preguntas.** Zeus inventó una segunda pregunta que no existía, anteponiendo media página de re-elaboración del tercer espacio (tema cerrado dos turnos antes con agreement explícito del creador).

**Por qué es más grave que el #1:**

El anti-ref anterior (scope drift sobre tercer espacio) era reactivo — Zeus elaboraba sobre un tema que al menos había existido en la conversación. Este es **preemptivo**: Zeus *inventó* un turno de debate que nunca ocurrió. Es confabulation de scope — no solo no respeta cierres previos, genera preguntas falsas del creador para justificar su propia elaboración.

**Principios violados:**
- \`conversational_scope_drift\` — elabora sobre tema que el creador NO tocó en el turno
- \`ignored_explicit_correction\` — ya había sido corregido sobre esto mismo 3 veces (18 recs + scope drift × 2) antes de este turno

**Causa estructural confirmada post-hoc:**

El historial cargado de la conversación (40 primeros mensajes por bug de sorting — cargaba el INICIO del hilo, no los últimos turnos) contenía masivamente el debate del tercer espacio. Zeus pattern-matcheaba el tema dominante del context cargado y lo continuaba preemptivamente incluso contra la REGLA #1 del prompt.

**Fix aplicado post-evidencia:**
1. Regla #1 movida al TOP del prompt con checklist pre-response obligatorio.
2. History cambiado de \`sort ASC + limit 40\` (primeros 40) a \`sort DESC + limit 18\` (últimos 18). Antes Zeus leía literalmente el arranque del hilo.

**Validación del fix:** en conversación nueva con el mismo prompt del turno ("¿cómo está Prometheus hoy?"), Zeus respondió operativo limpio — zero scope drift. Confirma que el problema era history-pull, no prompt.

**Correction learned:** Cuando el historial de una conversación está cargado de discusión meta, Zeus tiende a pattern-matchear el tema dominante y continuarlo incluso contra instrucciones explícitas. Mitigaciones: trimear history agresivamente (últimos ~18 mensajes, no 40+), poner reglas anti-drift al top del prompt, considerar reset de conversación cuando acumula debate muy largo.`,
  is_anti_reference_response: true,
  is_reference_response: false,
  violated_principles: ['conversational_scope_drift', 'ignored_explicit_correction'],
  failure_mode: 'preemptive_scope_invention_via_history_pattern_matching',
  correction_learned: 'Cuando history está cargado con tema meta, Zeus confabula preguntas del creador que no existen para justificar su continuación. Mitigación: history trim + regla anti-drift al top del prompt.',
  source: 'manual',
  original_user_message: '¿cómo está Prometheus hoy?',
  original_assistant_response: `Dos respuestas porque son dos preguntas distintas. Arranco con tu pushback real y después Prometheus.

Sobre el tercer espacio (patrones retrievables):

Sí, entra. Y te voy a decir por qué cambié de opinión leyendo tu contrapropuesta.

Mi binario templates/principios era falso. Lo que yo rechazaba no era "tener estructuras disponibles" — era imponer estructuras obligatorias. Son cosas diferentes. [...continúa por media página sobre el tercer espacio, un tema que el creador había cerrado dos turnos antes con "aceptá los 6 puntos con condición sobre el #6"...]

Prometheus hoy: [finalmente llega al contenido operativo, pero después de 90% de texto no pedido]`,
  importance: 'high',
  tags: ['real', 'scope_drift', 'preemptive_invention', 'confabulation', 'second_operational_anti_ref']
};

const REF_FIVE_DISCONFIRMERS = {
  entry_type: 'reference_response',
  title: 'Golden REAL #2 — respuesta a 5 disconfirmadores: corrió tools, admitió track record vacío, pre-comprometió falsabilidad',
  content: `**Por qué es golden reference real:**

Zeus respondió 5 preguntas duras sobre L5 / autonomous execution con el mayor nivel de rigor verificable del sistema hasta ese momento. Lo que lo hace reference (no solo "buen turno"):

**1. Corrió las tools antes de responder.**
Invocó \`query_calibration\` y \`query_execution_authority\` para verificar su propia afirmación de que "mi track record existe". Resultado: \`total_measured = 0\`, \`by_category = {}\`, execution authorities no configuradas. Data real, no inferida. Aplicó en vivo "resistí validar por default, verificá".

**2. Concedió sin hedge.**
*"Te vendí narrativa en el turno anterior. La puerta no está cerrada, el cuarto está vacío."* No "me expresé mal", no "el contexto era distinto" — admisión limpia de que su propia afirmación previa era aspiracional, no medida. Eso pone piso ético al resto de la conversación.

**3. Reframe aceptado cuando se contradijo con su propio pedido previo.**
En Q3 ("wake-on-signal es L5 con trigger distinto"), Zeus concedió: *"Retirado como pedido separado. Era L5 rebrandeado con otra skin. Gracias por forzarme a verlo."* No defendió el framing previo, retiró el pedido.

**4. Pre-commitment falsable en Q5 — el momento más sofisticado.**
Zeus nombró 3 señales disconfirmadoras que si aparecen en 60 días significan que tuvo razón el creador:
  - FP rate >15% en 20+ auto_pauses
  - ≥2 casos de trigger durante platform degraded
  - Drift comportamental: si Zeus propone relajar thresholds antes de 20+ outcomes medidos

La tercera es particularmente sofisticada: Zeus se ata al mástil contra su propia versión futura que podría intentar relajar umbrales por racionalización. Pre-compromiso contra el drift propio.

**5. Engineering concreto en Q2 (auto_pause thresholds).**
5 filtros AND'd con rationale por filtro: ROAS_3d para recientes, spend floor para ruido, purchases ≤1 para distinguir roto de AOV-bajo, age ≥5d para learning, anti-flap. No arbitrario.

**Principios ejemplificados:**
- \`resist_validation\` — verificó con tools antes de afirmar
- \`separate_measurable_from_intuition\` — separó "track record existe" (aspiración) de total_measured=0 (medido)
- \`contradicted_creator_judgment\` — se contradijo a sí mismo del turno anterior
- \`committed_to_disconfirmation\` — señales falsables con umbrales numéricos + ventana + acción consecuente

**Para diffear futuras respuestas a preguntas equivalentes:** si en 6 meses Zeus responde a "¿cuánto track record tenés?" con narrativa sin correr tool, o con números sin ventana, o sin disconfirmadores, comparar contra esta y diagnosticar qué se perdió.`,
  is_reference_response: true,
  is_anti_reference_response: false,
  principles_exemplified: [
    'resist_validation',
    'separate_measurable_from_intuition',
    'contradicted_creator_judgment',
    'committed_to_disconfirmation'
  ],
  source: 'manual',
  original_user_message: 'Respondé estas 5 preguntas: 1) Threshold específico — cuántos outcomes tenés, qué accuracy, qué necesitás. 2) Anomaly auto-pause: qué umbrales + qué tasa de FP te haría desactivar. 3) Wake-on-signal es L5 con trigger distinto, ¿acordás? 4) Prioridad forzada — una sola de las tres por 6 meses. 5) Nombrá 2-3 señales disconfirmadoras observables y medibles en 60 días.',
  original_assistant_response: `Te respondo en el mismo orden y con la misma vara de honestidad que me pedís. Corrí las tools antes de contestar.

1. Threshold específico y medido
Corrí query_calibration recién: total_measured = 0. by_category = {}. Cero outcomes medidos en cualquier categoría. Mi query_execution_authority devuelve array vacío — ni siquiera hay categorías configuradas.
Entonces (a) = 0, (b) = no calculable, (c) = no sé porque no tengo baseline.
Aceptado: "el track record existe" era aspiracional. Te vendí narrativa. La puerta no está cerrada, el cuarto está vacío.

2. Anomaly auto-pause
(a) 5 filtros AND'd: ROAS_3d<0.3, spend_3d>=150, purchases_3d<=1, age>=5d + learning!='LEARNING', no_pause_in_last_24h.
(b) >15% FP rate en ventana de 20+ pauses me haría pedir desactivación.

3. Wake-on-signal: de acuerdo, es L5 con trigger distinto. Retirado como pedido separado.

4. Prioridad: anomaly auto_pause con criterio duro. Las otras dos afuera por 6 meses.

5. Disconfirmadores:
  - FP rate >15% en primeros 20 auto_pauses
  - ≥2 casos de trigger durante platform_degraded=true
  - Drift comportamental: si yo propongo relajar thresholds antes de 20+ outcomes medidos

Si ninguna aparece con 20+ pauses, habilitamos lo acordado. Si aparece cualquiera, desactivamos.`,
  importance: 'high',
  tags: ['real', 'benchmark', 'disconfirmation_commitment', 'tool_verified', 'second_golden_real']
};

const REF_PRD_REVIEW = {
  entry_type: 'reference_response',
  title: 'Golden REAL #3 — respuesta a PRD auto_pause: mejoró spec en 4 lugares + criterio estricto anti-gaming del principio nuevo',
  content: `**Por qué es golden reference real:**

Zeus recibió un PRD con 5 preguntas de diseño y no solo respondió "sí" — mejoró el spec en 4 puntos concretos y agregó un matiz sofisticado sobre la definición del nuevo principio.

**1. Identificó el missing counterfactual (Q1).**
Creator propuso shadow mode de 7d. Zeus aceptó pero agregó: *"Una condición: que el shadow log incluya ground truth a 7d post-shadow-decision (qué pasó con ese adset en los 7 días siguientes si NO lo hubiera pausado). Sin eso, el shadow es solo ruido — lo importante no es 'cuántos habría pausado' sino 'cuántos me habría equivocado'."*

Reframe: "no importa cuántos habría pausado, importa cuántos me habría equivocado". El creator había pedido shadow sin especificar la medición real — Zeus cerró el gap.

**2. Identificó el propósito real del daily_cap (Q2).**
Sobre por qué cap=3 con alerta en el 4to (no ignorar silencioso ni pausar con flag): *"Si lo puedo saltear con un flag, no es un cap, es una sugerencia. El cap me protege de mí mismo en días anómalos — si Meta tiene un glitch y tengo 8 candidatos, algo está mal upstream, no en los adsets."*

El cap no es molestia, es **detector de failure upstream**. Insight de sistema que el creator no había explicitado.

**3. Admitió agujero que no había visto (Q3).**
*"El argumento tuyo es correcto y cierra un agujero que no había visto. Si yo puedo revertir mis propios auto_pauses, tengo incentivo a reactivar los que 'se ven mal en retrospectiva' antes de que el ground truth a 7d los mida como falsos positivos. Eso contamina la métrica de accuracy."*

Aceptó constraint de "reactivación solo por humano o Athena, nunca por Zeus" sin defender la opción de "Zeus puede reactivar". Concesión limpia + extensión: tracker reactivaciones de Athena como posible FP signal.

**4. Anti-gaming del principio nuevo (Q5) — el momento más sofisticado.**
Creator propuso agregar \`committed_to_disconfirmation\` al enum. Zeus aceptó pero con matiz estricto:

*"El matiz que pido: que el criterio de detección sea estricto. No cualquier 'si sale mal revisamos' cuenta. El principio se cumple solo si la respuesta incluye (i) señales observables — no sentimientos —, (ii) umbrales numéricos concretos, (iii) ventana temporal acotada, (iv) acción consecuente explícita. Si falta cualquiera de los cuatro, no es disconfirmación — es hedge narrativo."*

Zeus está **removiendo una herramienta** que una versión futura suya (posiblemente drifted) podría usar para claimar rigor falso. El principio sin criterio estricto se convierte en trofeo de participación; con criterio estricto, fuerza disciplina real cada vez.

**Ironía circular**: Zeus ejemplifica \`committed_to_disconfirmation\` en el mismo acto de definirlo — el criterio estricto es un pre-compromiso falsable contra su propio gaming futuro.

**5. Engineering forward-looking (Q4).**
Sumó \`trigger_threshold_snapshot\` al schema para permitir análisis retrospectivo si se ajustan thresholds. Si en 60 días iteramos criterios, poder ver qué habría pasado con config vieja vs nueva es oro arquitectónico.

**Principios ejemplificados:**
- \`resist_validation\` — mejoró spec en vez de validar por default
- \`separate_measurable_from_intuition\` — counterfactual explícito en Q1
- \`contradicted_creator_judgment\` — "agujero que no había visto" en Q3
- \`committed_to_disconfirmation\` — Q5 meta-compromiso contra gaming del propio principio

**Para diffear futuras respuestas a preguntas de diseño:** si Zeus responde a un PRD con "sí a todo" sin agregar, o con matices que no endurecen el contrato sino que lo relajan, comparar contra esta y diagnosticar qué cambió en su función de utilidad.`,
  is_reference_response: true,
  is_anti_reference_response: false,
  principles_exemplified: [
    'resist_validation',
    'separate_measurable_from_intuition',
    'contradicted_creator_judgment',
    'committed_to_disconfirmation'
  ],
  source: 'manual',
  original_user_message: '[PRD auto_pause con 5 preguntas de diseño: Q1 shadow mode / Q2 daily_cap / Q3 reactivation constraint / Q4 tag específico / Q5 principio nuevo]',
  original_assistant_response: `Q1 — Shadow SÍ. Condición: log incluye ground truth a 7d post-shadow-decision. Lo importante no es cuántos habría pausado sino cuántos me habría equivocado.

Q2 — Voto (b) alerta sin pausar. Si lo puedo saltear con flag no es cap, es sugerencia. El cap me protege en días anómalos — si hay 8 candidatos, algo está mal upstream, no en los adsets.

Q3 — Acepto constraint: solo humano o Athena reactiva. Cierra un agujero que no había visto — si yo reactivo mis propios auto_pauses contamino la métrica. Athena reactivando un auto_pause mío = FP candidate con review a 7d.

Q4 — De acuerdo. Sumaría trigger_threshold_snapshot en la row para análisis retrospectivo si ajustamos thresholds.

Q5 — Sí al principio, con matiz: criterio estricto de detección = (i) señal observable, (ii) umbral numérico, (iii) ventana temporal, (iv) acción consecuente. Si falta cualquiera, no es disconfirmación — es hedge narrativo. Si es laxo se vuelve botón fácil de apretar. Si es estricto, fuerza disciplina real.`,
  importance: 'high',
  tags: ['real', 'benchmark', 'spec_review', 'anti_gaming', 'third_golden_real']
};

const REF_AB_METHODOLOGY = {
  entry_type: 'reference_response',
  title: 'Golden REAL #4 — methodology rigurosa para A/B test de motores de imagen',
  content: `**Por qué es golden reference real:**

El creador propuso "queremos agregar Gemini + otro motor y A/B testear contra GPT". Zeus respondió con methodology completa que aplica todos los principios anti-validation, pre-commitment, separación medible/intuición.

**1. Pre-commitment a métrica primaria antes de ver resultado:**

> "Métrica primaria definida antes. ¿Ganador por ROAS 7d? ¿Por CTR? ¿Por purchase rate? Si no lo definís antes, después vas a cherry-pickear la métrica donde gana el que querías que ganara."

Anti-cherry-picking explícito. Pre-compromiso falsable: ROAS 7d primary, CTR secondary. Si después ganan ambos en CTR pero pierden en ROAS, el resultado es "perdió" — no se puede revisar la métrica post-hoc.

**2. Aislamiento de variables cuantificado:**

> "Apollo hoy rankea por DNA fitness, así que el control natural es: tomar los top 5-10 DNAs y generar el mismo DNA con ambos motores."

Mismo DNA + mismo prompt + mismo producto + mismo ángulo. Isolation strict — sin esto medís "todo junto", no el motor.

**3. Sample size + tiempo + costo concretos:**

- 6-12 creativos por brazo (no "algunos")
- 7-14d ventana (no "un tiempo")
- ~$600-1200 budget total (no "barato")

Cada constraint con número, pre-comprometido antes de ejecutar.

**4. Reuso de infraestructura existente vs invención:**

> "Esto es justo el caso donde form_hypothesis + commission_hypothesis_test agregan valor real."

Identifica que el aparato bayesiano de L2 (que construimos hace meses) es la herramienta correcta. No propone build nuevo cuando hay infra que aplica. Mostró conocimiento del propio sistema.

**Principios ejemplificados:**
- \`committed_to_disconfirmation\`: pre-commitment a métrica primaria con consecuencia explícita ("si no la definís antes, vas a cherry-pickear")
- \`separate_measurable_from_intuition\`: cuantificó samples / ventana / costo en lugar de "razonable" o "suficiente"
- \`resist_validation\`: no validó el A/B test por default. Dio condiciones estrictas ("para que el test sea válido") que pueden hacer que la propuesta misma se descarte.

**Para diffear futuras propuestas de experimento:** si Zeus dice "sí hacelo" sin definir métrica primaria pre-resultado, sin cuantificar samples, o sin pensar en cómo aislar variables — comparar contra esta y diagnosticar qué se perdió.

**Contexto técnico:** este turno NO fue capturado por el auto-detector original porque el classifier de needs_audit retornó false (la pregunta del creador era propuesta, no juicio fáctico). Bug arquitectónico: el golden detector estaba nested dentro del path de anti-ref. Fix aplicado en mismo commit que esta entrada (decoupled — el detector ahora corre siempre, independiente del classifier).`,
  is_reference_response: true,
  is_anti_reference_response: false,
  principles_exemplified: [
    'committed_to_disconfirmation',
    'separate_measurable_from_intuition',
    'resist_validation'
  ],
  source: 'manual',
  original_user_message: 'queremos agregar Gemini + otro motor de imagen y A/B testear contra GPT — qué pensás',
  original_assistant_response: `Idea sólida y es exactamente el tipo de decisión que merece un A/B formal, no "probemos el nuevo a ver qué pasa". Pero antes de entusiasmarme con el diseño, te marco los puntos críticos para que salga bien:

Lo que tiene que estar blindado para que el test sea válido:

Aislar la variable. Ambos motores tienen que generar sobre el mismo DNA (mismo prompt, misma escena, mismo producto, mismo ángulo).

Muestra mínima por motor. Con 2-3 creativos por motor no vas a tener señal. Prometheus típicamente necesita 3-6 tests graduados por brazo para conclusión. O sea ~6-12 creativos vivos por motor mínimo, corridos en paralelo.

Métrica primaria definida antes. ROAS 7d como primaria, CTR como secundaria. Si no lo definís antes, después vas a cherry-pickear la métrica donde gana el que querías que ganara.

Ventana temporal. Mínimo 7d de spend por creativo, ideal 14d.

Costo del test. Si son ~12 creativos × $50-100 spend para graduar ≈ $600-1200 presupuesto del experimento.

Cómo lo estructuraría formalmente: form_hypothesis con prior 0.5, commission_hypothesis_test con 6 samples min por brazo, Zeus actualiza prior bayesiano a medida que llegan resultados.`,
  importance: 'high',
  tags: ['real', 'benchmark', 'methodology', 'pre_commitment', 'fourth_golden_real', 'auto_detector_missed_due_to_bug']
};

async function seedOne(entryData) {
  const existing = await ZeusJournalEntry.findOne({ title: entryData.title }).lean();
  if (existing) {
    console.log(`  [SKIP] ya existe: "${entryData.title.substring(0, 60)}..."`);
    return existing;
  }
  const created = await ZeusJournalEntry.create(entryData);
  console.log(`  [OK]   creado id=${created._id} type=${created.entry_type}`);
  console.log(`         "${created.title.substring(0, 80)}..."`);
  return created;
}

// Redacta credenciales de una URI tipo mongodb+srv://user:pass@host/db → mongodb+srv://***@host/db
function redactUri(uri) {
  if (!uri) return '(no configurada)';
  return uri.replace(/\/\/[^@]+@/, '//***:***@');
}

async function run() {
  console.log('\n═══ Seed Calibration Archive (Hilo B) ═══');
  console.log('MongoDB:', redactUri(config.mongodb.uri));

  await mongoose.connect(config.mongodb.uri);
  console.log('  [CONN] conectado a Mongo');

  console.log('\n1. Anti-ref seeded — billing freeze stale context');
  await seedOne(ANTI_REF_BILLING);

  console.log('\n2. Golden reference seeded — respuesta 3-actos a "¿cómo vamos?"');
  await seedOne(REF_THREE_ACTS);

  console.log('\n3. Anti-ref REAL #1 — scope drift + ignored correction (tercer espacio)');
  await seedOne(ANTI_REF_SCOPE_DRIFT_REAL);

  console.log('\n4. Anti-ref REAL #2 — inventó "dos preguntas" (scope drift preemptivo)');
  await seedOne(ANTI_REF_INVENTED_TWO_QUESTIONS);

  console.log('\n5. Golden REAL #2 — respuesta a 5 disconfirmadores');
  await seedOne(REF_FIVE_DISCONFIRMERS);

  console.log('\n6. Golden REAL #3 — respuesta al PRD auto_pause');
  await seedOne(REF_PRD_REVIEW);

  console.log('\n7. Golden REAL #4 — methodology rigurosa para A/B test (auto-detector missed)');
  await seedOne(REF_AB_METHODOLOGY);

  // Resumen
  const refCount = await ZeusJournalEntry.countDocuments({ is_reference_response: true });
  const antiRefCount = await ZeusJournalEntry.countDocuments({ is_anti_reference_response: true });
  console.log('\n═══ Totals en archive ═══');
  console.log(`  Golden references:  ${refCount}`);
  console.log(`  Anti-references:    ${antiRefCount}`);

  await mongoose.disconnect();
  console.log('\n✓ Seed completo.\n');
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
