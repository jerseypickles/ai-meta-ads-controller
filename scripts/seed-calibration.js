/**
 * Seed inicial del archive de calibración (Hilo B).
 *
 * Inserta dos entries históricas reconstruidas desde la conversación del 2026-04-21:
 *
 *   1. Anti-reference del "billing freeze stale context" — Zeus siguió respondiendo
 *      con billing issues activos cuando ya estaban resueltos porque leyó el context
 *      snapshot como si fuera estado presente, sin refrescar con delivery_health.
 *
 *   2. Golden reference del turno "3-actos" — Zeus separó respuesta en
 *      inversión-a-futuro / calibración medida / impacto-hoy-con-contrafactual,
 *      ancló epistémicamente ("no tengo baseline contrafactual"), y se paró en
 *      seco ("no tengo evidencia para mostrarte alpha"). Benchmark de cómo
 *      queremos que suene cuando el rigor está operando.
 *
 * Ambos entries marcados con source='manual' + tag 'seeded' para poder filtrar
 * del auditor trimestral si decidimos contar solo data operativa real.
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

async function run() {
  console.log('\n═══ Seed Calibration Archive (Hilo B) ═══');
  console.log('MongoDB:', (config.mongodb.uri || '').substring(0, 60) + '...');

  await mongoose.connect(config.mongodb.uri);
  console.log('  [CONN] conectado a Mongo');

  console.log('\n1. Anti-ref — billing freeze stale context');
  await seedOne(ANTI_REF_BILLING);

  console.log('\n2. Golden reference — respuesta 3-actos a "¿cómo vamos?"');
  await seedOne(REF_THREE_ACTS);

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
