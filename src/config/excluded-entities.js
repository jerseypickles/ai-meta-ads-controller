// ═══════════════════════════════════════════════════════════════════════════════
// EXCLUSIONES GLOBALES — entidades que NINGÚN agente ni Zeus debe tocar/reconocer.
// Manual-only del creador (ej. posts boosteados, campañas de marca, experimentos).
//
// Se excluye por CAMPAIGN_ID (lo más confiable — los nombres cambian y tienen emoji)
// y opcionalmente por patrón de nombre. Configurable por env EXCLUDED_CAMPAIGN_IDS
// (CSV) para agregar más sin tocar código.
// ═══════════════════════════════════════════════════════════════════════════════

const EXCLUDED_CAMPAIGN_IDS = new Set([
  '120245933935770069', // Post: "not your normal pickle store 🥒" — boosted post manual (2026-05-30)
  ...(process.env.EXCLUDED_CAMPAIGN_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
]);

// Fallback por nombre (si en algún flujo no hay campaign_id a mano). UPPERCASE.
const EXCLUDED_NAME_PATTERNS = ['NOT YOUR NORMAL PICKLE STORE'];

function isExcludedCampaignId(id) {
  return !!id && EXCLUDED_CAMPAIGN_IDS.has(String(id));
}

function isExcludedName(name) {
  const u = (name || '').toUpperCase();
  return EXCLUDED_NAME_PATTERNS.some(p => u.includes(p));
}

/** True si la entidad (por campaign_id o por nombre) está excluida de todos los agentes. */
function isExcludedEntity({ campaign_id, campaign_name, name, entity_name } = {}) {
  return isExcludedCampaignId(campaign_id) || isExcludedName(name || entity_name || campaign_name);
}

module.exports = { isExcludedCampaignId, isExcludedName, isExcludedEntity, EXCLUDED_CAMPAIGN_IDS, EXCLUDED_NAME_PATTERNS };
