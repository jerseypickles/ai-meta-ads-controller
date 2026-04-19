const CreativeDNA = require('../../db/models/CreativeDNA');
const logger = require('../../utils/logger');

/**
 * Creative DNA helpers — extractores e inferencia para las 5 dimensiones
 * del DNA system. Incluye hash deterministico + fitness update logic.
 */

// ═══════════════════════════════════════════════════════════════════════════
// CANONICAL VALUES — enums normalizados para consistencia
// ═══════════════════════════════════════════════════════════════════════════

const STYLES = ['ugly-ad', 'pov-selfie', 'overhead-flat', 'close-up-texture', 'action-shot', 'unknown'];
const ANGLES = ['curiosity', 'social-proof', 'urgency', 'humor', 'sensory', 'casual-fun', 'controversy', 'unknown'];
const HOOK_TYPES = ['question', 'statement', 'exclamation', 'number', 'unknown'];
const FRAMINGS = ['curiosity', 'upgrade', 'obsession', 'transformation', 'question', 'bold-claim', 'social-proof', 'other'];

// ═══════════════════════════════════════════════════════════════════════════
// EXTRACTORS — infieren dimensiones desde inputs crudos
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Infiere el style desde el prompt usado (si fue generado con uno conocido).
 * Returns 'unknown' si no detecta.
 */
function extractStyleFromPrompt(promptUsed) {
  if (!promptUsed) return 'unknown';
  const p = promptUsed.toLowerCase();
  if (p.includes('ugly-ad') || p.includes('realistic ugly')) return 'ugly-ad';
  if (p.includes('pov-style') || p.includes('first person') || p.includes('selfie')) return 'pov-selfie';
  if (p.includes('overhead') || p.includes('flat lay') || p.includes('top down')) return 'overhead-flat';
  if (p.includes('close-up') || p.includes('close up') || p.includes('macro') || p.includes('texture')) return 'close-up-texture';
  if (p.includes('action shot') || p.includes('in motion') || p.includes('being used')) return 'action-shot';
  return 'unknown';
}

/**
 * Determina el hook_type desde el headline (puntuacion + estructura).
 */
function extractHookType(headline) {
  if (!headline) return 'unknown';
  const h = headline.trim();
  if (h.includes('?')) return 'question';
  if (h.includes('!') || /\b(WOW|🔥|OMG)\b/i.test(h)) return 'exclamation';
  if (/^\d+[%\s]|\b(one|two|three|five|ten|#\d+)\b/i.test(h)) return 'number';
  return 'statement';
}

/**
 * Infiere copy_angle desde el headline (pattern match en keywords/structure).
 * Nota: este es un inferrer heuristico. El valor explicito (guardado al
 * generarse) debe preferirse cuando existe.
 */
function extractCopyAngle(headline) {
  if (!headline) return 'unknown';
  const h = headline.toLowerCase();

  // Curiosity hooks
  if (/wait|you won'?t|you can'?t|did you know|secret|hidden|nobody talks/i.test(h)) return 'curiosity';

  // Social proof
  if (/everyone|obsessed|#?\d+k|viral|trending|most popular|best seller/i.test(h)) return 'social-proof';

  // Urgency
  if (/almost gone|limited|selling out|last chance|before.* too late|ends (today|soon)/i.test(h)) return 'urgency';

  // Humor / casual
  if (/lol|like a legend|embarrassing|weird|just.* like|chaos/i.test(h)) return 'humor';

  // Sensory
  if (/crunchy|spicy|tangy|sweet|hot|fresh|flavor|taste/i.test(h)) return 'sensory';

  // Controversy
  if (/wrong|hate|doesn'?t belong|don'?t let|stop/i.test(h)) return 'controversy';

  return 'casual-fun';
}

/**
 * Extrae framing desde headline — como se POSICIONA el mensaje.
 * Mas abstracto que copy_angle — habla del APPROACH narrativo.
 */
function extractFraming(headline) {
  if (!headline) return 'other';
  const h = headline.toLowerCase();

  // Curiosity framing — "wait... you can X?"
  if (/wait|you can pickle|did you know|you won'?t believe/i.test(h)) return 'curiosity';

  // Upgrade framing — "just got [better/upgraded]"
  if (/just got|upgraded|glow.?up|leveled up/i.test(h)) return 'upgrade';

  // Obsession framing — "obsessed", "can't stop"
  if (/obsessed|addictive|can'?t stop|hooked/i.test(h)) return 'obsession';

  // Transformation framing — "from X to Y"
  if (/from .* to|transform|become/i.test(h)) return 'transformation';

  // Question framing
  if (h.includes('?')) return 'question';

  // Bold claim
  if (/best|only|never|always|the .* you/i.test(h)) return 'bold-claim';

  // Social proof framing
  if (/everyone|most|all.*(are|love)/i.test(h)) return 'social-proof';

  return 'other';
}

// ═══════════════════════════════════════════════════════════════════════════
// DNA HASH — identificador deterministico de una combinacion
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Genera un hash deterministico del DNA. Mismas dimensiones → mismo hash.
 * Format: "style|angle|scene|product|hook"
 * Minimizado a lowercase sin espacios/caracteres raros.
 */
function computeDNAHash(dimensions) {
  const normalize = (s) => (s || 'unknown').toString().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_\-]/g, '');
  const { style, copy_angle, scene, product, hook_type } = dimensions;
  return [
    normalize(style),
    normalize(copy_angle),
    normalize(scene),
    normalize(product),
    normalize(hook_type)
  ].join('|');
}

/**
 * Build full DNA object desde dimensiones raw.
 */
function buildDNA(dimensions) {
  const style = dimensions.style || 'unknown';
  const copy_angle = dimensions.copy_angle || 'unknown';
  const scene = dimensions.scene_short || dimensions.scene || 'unknown';
  const product = dimensions.product_name || dimensions.product || 'unknown';
  const hook_type = dimensions.hook_type || extractHookType(dimensions.headline);
  const framing = dimensions.framing || extractFraming(dimensions.headline);

  const hash = computeDNAHash({ style, copy_angle, scene, product, hook_type });

  return {
    dna_hash: hash,
    style,
    copy_angle,
    framing,
    hook_type,
    dimensions: { scene, style, copy_angle, product, hook_type }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FITNESS UPDATE — hook para test outcomes
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Actualiza o crea CreativeDNA record tras un outcome de test.
 * Llamado desde graduateTest / killOrExpireTest en testing-agent.js.
 *
 * @param proposal — CreativeProposal populated con el DNA guardado
 * @param outcome — 'graduated' | 'killed' | 'expired'
 * @param metrics — { spend, revenue, purchases }
 */
async function updateDNAFitness(proposal, outcome, metrics) {
  try {
    if (!proposal) return null;

    // Si el proposal no tiene dna_hash guardado (legacy), infiere on-the-fly
    let dnaHash = proposal.dna_hash;
    let dimensions;

    if (!dnaHash) {
      const dna = buildDNA({
        style: proposal.style,
        copy_angle: proposal.copy_angle,
        scene: proposal.scene_short,
        product: proposal.product_name,
        headline: proposal.headline
      });
      dnaHash = dna.dna_hash;
      dimensions = dna.dimensions;
    } else {
      dimensions = {
        scene: proposal.scene_short || 'unknown',
        style: proposal.style || 'unknown',
        copy_angle: proposal.copy_angle || 'unknown',
        product: proposal.product_name || 'unknown',
        hook_type: proposal.hook_type || extractHookType(proposal.headline)
      };
    }

    // Upsert + record outcome
    let dnaDoc = await CreativeDNA.findOne({ dna_hash: dnaHash });
    if (!dnaDoc) {
      dnaDoc = new CreativeDNA({
        dna_hash: dnaHash,
        dimensions,
        generation: 0,
        created_via: 'random',
        first_seen_at: proposal.created_at || new Date()
      });
    }

    dnaDoc.recordOutcome(outcome, metrics);
    await dnaDoc.save();

    logger.info(`[DNA] ${dnaHash} → ${outcome} | ROAS ${dnaDoc.fitness.avg_roas}x | samples ${dnaDoc.fitness.tests_total} | win rate ${(dnaDoc.fitness.win_rate * 100).toFixed(0)}%`);
    return dnaDoc;
  } catch (err) {
    logger.warn(`[DNA] Error updating fitness (non-fatal): ${err.message}`);
    return null;
  }
}

module.exports = {
  STYLES,
  ANGLES,
  HOOK_TYPES,
  FRAMINGS,
  extractStyleFromPrompt,
  extractHookType,
  extractCopyAngle,
  extractFraming,
  computeDNAHash,
  buildDNA,
  updateDNAFitness
};
