const axios = require('axios');
const config = require('../../../config');
const ResearchCache = require('../../db/models/ResearchCache');
const logger = require('../../utils/logger');

const SEARCH_TIMEOUT = 30000; // 30s — APIs externas pueden ser lentas
const CACHE_TTL_HOURS = 24;
const MAX_RESULTS_PER_QUERY = 5;

/**
 * Research Module — busca informacion en la web para alimentar
 * las recomendaciones estrategicas con conocimiento actualizado.
 *
 * Soporta: Brave Search API (primario), SerpAPI (fallback).
 * Si no hay API key configurada, retorna insights vacios sin errores.
 */
class ResearchModule {
  constructor() {
    this.braveApiKey = config.search?.braveApiKey || process.env.BRAVE_SEARCH_API_KEY;
    this.serpApiKey = config.search?.serpApiKey || process.env.SERP_API_KEY;
    this.enabled = !!(this.braveApiKey || this.serpApiKey);
  }

  /**
   * Ejecuta investigacion completa basada en el estado de la cuenta.
   * Genera queries inteligentes segun los problemas detectados.
   */
  async research(accountContext = {}) {
    if (!this.enabled) {
      logger.info('[RESEARCH] Sin API key de busqueda configurada. Usando solo conocimiento base.');
      return { insights: [], sources: [], enabled: false };
    }

    logger.info('[RESEARCH] Iniciando investigacion web...');
    const queries = this._buildQueries(accountContext);
    const allResults = [];
    const allSources = [];

    for (const q of queries) {
      try {
        // Revisar cache primero
        const cached = await ResearchCache.findCached(q.query);
        if (cached) {
          logger.debug(`[RESEARCH] Cache hit: "${q.query}"`);
          allResults.push({ query: q.query, category: q.category, summary: cached.summary, sources: cached.results });
          for (const s of (cached.results || [])) {
            allSources.push(s);
          }
          continue;
        }

        // Buscar en web
        const results = await this._search(q.query);
        if (results.length > 0) {
          const summary = this._summarizeResults(results, q.query);

          // Guardar en cache
          await ResearchCache.store(q.query, q.category, results, summary, CACHE_TTL_HOURS);

          allResults.push({ query: q.query, category: q.category, summary, sources: results });
          for (const s of results) {
            allSources.push(s);
          }
        }
      } catch (error) {
        logger.warn(`[RESEARCH] Error en query "${q.query}": ${error.message}`);
      }
    }

    logger.info(`[RESEARCH] Completado: ${allResults.length}/${queries.length} queries, ${allSources.length} fuentes`);

    return {
      insights: allResults,
      sources: allSources,
      queries_executed: allResults.length,
      queries_total: queries.length,
      enabled: true
    };
  }

  /**
   * Construye queries de busqueda basados en el contexto de la cuenta.
   */
  _buildQueries(ctx) {
    const queries = [];
    const year = new Date().getFullYear();

    // Siempre buscar actualizaciones de plataforma
    queries.push({
      query: `Meta Facebook Ads algorithm changes ${year}`,
      category: 'platform_updates'
    });

    // Best practices para la vertical
    queries.push({
      query: `Meta Ads best practices ecommerce food beverage ${year}`,
      category: 'best_practices'
    });

    // Queries dinamicos basados en problemas detectados
    if (ctx.high_fatigue) {
      queries.push({
        query: 'Meta Ads creative fatigue solutions refresh strategy',
        category: 'problem_specific'
      });
    }

    if (ctx.low_roas) {
      queries.push({
        query: `Meta Ads improve ROAS ecommerce ${year} strategies`,
        category: 'problem_specific'
      });
    }

    if (ctx.high_cpa) {
      queries.push({
        query: 'reduce CPA Facebook Ads ecommerce purchase optimization',
        category: 'problem_specific'
      });
    }

    if (ctx.high_frequency) {
      queries.push({
        query: 'Meta Ads high frequency audience saturation Advantage+ solutions',
        category: 'problem_specific'
      });
    }

    if (ctx.low_creative_count) {
      queries.push({
        query: 'Meta Ads creative volume testing framework ecommerce',
        category: 'best_practices'
      });
    }

    if (ctx.scaling_opportunity) {
      queries.push({
        query: 'Meta Ads scaling strategy ecommerce without losing efficiency',
        category: 'best_practices'
      });
    }

    // Tendencias de industria
    queries.push({
      query: `Facebook Ads CPM CPA benchmarks food ecommerce ${year}`,
      category: 'industry_trends'
    });

    // Limitar a 6 queries por ciclo para no abusar de la API
    return queries.slice(0, 6);
  }

  /**
   * Busca en Brave Search API (primario) o SerpAPI (fallback).
   */
  async _search(query) {
    if (this.braveApiKey) {
      return this._searchBrave(query);
    }
    if (this.serpApiKey) {
      return this._searchSerp(query);
    }
    return [];
  }

  async _searchWithRetry(fn, label, maxRetries = 2) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const isTimeout = error.code === 'ECONNABORTED' || error.message?.includes('timeout');
        const isRetryable = isTimeout || (error.response?.status >= 500);
        if (isRetryable && attempt < maxRetries) {
          const delay = attempt * 3000;
          logger.warn(`[RESEARCH] ${label} intento ${attempt}/${maxRetries} falló (${error.message}), reintentando en ${delay / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
    return [];
  }

  async _searchBrave(query) {
    try {
      return await this._searchWithRetry(async () => {
        const response = await axios.get('https://api.search.brave.com/res/v1/web/search', {
          params: { q: query, count: MAX_RESULTS_PER_QUERY },
          headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': this.braveApiKey
          },
          timeout: SEARCH_TIMEOUT
        });

        const results = (response.data.web?.results || []).map(r => ({
          title: r.title || '',
          url: r.url || '',
          snippet: r.description || ''
        }));

        return results.slice(0, MAX_RESULTS_PER_QUERY);
      }, 'Brave Search');
    } catch (error) {
      logger.warn(`[RESEARCH] Brave Search error: ${error.message}`);
      return [];
    }
  }

  async _searchSerp(query) {
    try {
      return await this._searchWithRetry(async () => {
        const response = await axios.get('https://serpapi.com/search', {
          params: {
            q: query,
            api_key: this.serpApiKey,
            engine: 'google',
            num: MAX_RESULTS_PER_QUERY
          },
          timeout: SEARCH_TIMEOUT
        });

        const results = (response.data.organic_results || []).map(r => ({
          title: r.title || '',
          url: r.link || '',
          snippet: r.snippet || ''
        }));

        return results.slice(0, MAX_RESULTS_PER_QUERY);
      }, 'SerpAPI');
    } catch (error) {
      logger.warn(`[RESEARCH] SerpAPI error: ${error.message}`);
      return [];
    }
  }

  /**
   * Genera un resumen conciso de los resultados de busqueda.
   */
  _summarizeResults(results, query) {
    if (!results.length) return '';

    const snippets = results
      .map(r => r.snippet)
      .filter(Boolean)
      .slice(0, 3);

    return `Busqueda: "${query}"\n${snippets.join('\n')}`;
  }
}

module.exports = ResearchModule;
