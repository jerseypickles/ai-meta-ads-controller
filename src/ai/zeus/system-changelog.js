/**
 * system-changelog.js — expone los commits recientes del deploy para que Zeus sepa
 * qué cambió en el sistema AUTOMÁTICAMENTE, sin que nadie se lo cuente.
 *
 * Insight (2026-05-26): hasta hoy, cuando se cambiaba la conducta de un agente
 * (gates, thresholds, capacidades), Zeus no se enteraba y podía razonar sobre un
 * modelo mental viejo (ej. flaggear como anomalía una caída de graduación que era
 * intencional). Los mensajes de commit que escribimos son descriptivos → SON el
 * changelog. Este helper los lee y oracle-context los inyecta en el prompt de Zeus.
 *
 * Lee `git log` una sola vez por proceso (los commits no cambian entre deploys).
 * Fail-open: si no hay git disponible en runtime, devuelve [] y Zeus simplemente
 * no ve changelog (sin romper nada).
 */

const { execSync } = require('child_process');
const logger = require('../../utils/logger');

let _cache = null;

function getRecentChanges() {
  if (_cache !== null) return _cache;
  try {
    const out = execSync('git log -25 --no-merges --since="14 days ago" --format=%ct%x09%s', {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    _cache = out.trim().split('\n').filter(Boolean).map(line => {
      const tab = line.indexOf('\t');
      const ts = parseInt(line.slice(0, tab), 10);
      return { at: new Date(ts * 1000).toISOString().slice(0, 10), subject: line.slice(tab + 1) };
    });
  } catch (err) {
    logger.debug(`[CHANGELOG] git log no disponible (${err.message}) — Zeus sin changelog automático`);
    _cache = [];
  }
  return _cache;
}

module.exports = { getRecentChanges };
