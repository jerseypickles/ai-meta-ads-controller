const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../config');
const { SYSTEM_PROMPT, buildUserPrompt } = require('./prompts');
const { parseResponse } = require('./response-parser');
const { getLatestSnapshots, getRecentDecisions, getAccountOverview } = require('../db/queries');
const Decision = require('../db/models/Decision');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('crypto');

class DecisionEngine {
  constructor() {
    this.anthropic = new Anthropic({ apiKey: config.claude.apiKey });
  }

  /**
   * Ciclo principal de análisis.
   * 1. Carga snapshots más recientes
   * 2. Carga historial de decisiones
   * 3. Llama a Claude
   * 4. Parsea y retorna decisiones
   */
  async analyze() {
    const cycleId = `cycle_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    logger.info(`═══ Iniciando ciclo de análisis IA [${cycleId}] ═══`);

    try {
      // 1. Cargar datos
      const [snapshots, recentDecisionsList, accountOverview] = await Promise.all([
        getLatestSnapshots(),
        getRecentDecisions(24),
        getAccountOverview()
      ]);

      if (snapshots.length === 0) {
        logger.warn('Sin snapshots disponibles. Saltando análisis.');
        return null;
      }

      logger.info(`Datos cargados: ${snapshots.length} snapshots, ${recentDecisionsList.length} decisiones previas`);

      // 2. Construir prompt
      const userPrompt = buildUserPrompt({
        snapshots,
        recentDecisions: recentDecisionsList,
        accountOverview
      });

      // 3. Llamar a Claude
      const aiResponse = await this.callClaude(userPrompt);
      if (!aiResponse) {
        logger.error('Sin respuesta de Claude');
        return null;
      }

      // 4. Parsear respuesta
      const parsed = parseResponse(aiResponse.text);
      if (!parsed) {
        logger.error('No se pudo parsear la respuesta de Claude');
        return null;
      }

      // 5. Guardar decisión en MongoDB
      const decision = new Decision({
        cycle_id: cycleId,
        analysis_summary: parsed.analysis_summary,
        total_daily_spend: parsed.total_daily_spend,
        account_roas: parsed.account_roas,
        decisions: parsed.decisions,
        alerts: parsed.alerts,
        total_actions: parsed.decisions.length,
        approved_actions: 0, // Se actualiza después del safety check
        rejected_actions: 0,
        executed_actions: 0,
        claude_model: config.claude.model,
        prompt_tokens: aiResponse.usage?.input_tokens || 0,
        completion_tokens: aiResponse.usage?.output_tokens || 0
      });

      await decision.save();
      logger.info(`Decisión guardada: ${parsed.decisions.length} acciones propuestas`);

      // Log de alertas
      if (parsed.alerts.length > 0) {
        parsed.alerts.forEach(alert => {
          const logMethod = alert.severity === 'critical' ? 'error' : 'warn';
          logger[logMethod](`Alerta [${alert.severity}]: ${alert.message}`);
        });
      }

      return {
        decision,
        parsed,
        cycleId
      };
    } catch (error) {
      logger.error(`Error en ciclo de análisis [${cycleId}]:`, error);
      throw error;
    }
  }

  /**
   * Llama a la API de Claude con el prompt construido.
   */
  async callClaude(userPrompt) {
    try {
      logger.info('Llamando a Claude API...');
      const startTime = Date.now();

      const message = await this.anthropic.messages.create({
        model: config.claude.model,
        max_tokens: config.claude.maxTokens,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: userPrompt
        }]
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`Claude respondió en ${elapsed}s — ${message.usage.input_tokens} input, ${message.usage.output_tokens} output tokens`);

      return {
        text: message.content[0].text,
        usage: message.usage
      };
    } catch (error) {
      logger.error('Error llamando a Claude API:', {
        error: error.message,
        status: error.status
      });

      // Si es rate limit, esperar y reintentar una vez
      if (error.status === 429) {
        logger.warn('Rate limit de Claude, esperando 30s...');
        await new Promise(resolve => setTimeout(resolve, 30000));
        try {
          const retry = await this.anthropic.messages.create({
            model: config.claude.model,
            max_tokens: config.claude.maxTokens,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userPrompt }]
          });
          return { text: retry.content[0].text, usage: retry.usage };
        } catch (retryError) {
          logger.error('Reintento de Claude también falló:', retryError.message);
          return null;
        }
      }

      return null;
    }
  }
}

module.exports = DecisionEngine;
