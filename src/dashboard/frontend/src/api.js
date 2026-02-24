/**
 * API Client para AI Meta Ads Controller - Jersey Pickles
 * Cliente Axios con autenticación, interceptores y funciones de API
 */

import axios from 'axios';

// Configurar base URL: en producción usa URL relativa (mismo dominio), en dev usa localhost:3500
const BASE_URL = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3500');

// Crear instancia de Axios
const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 30000, // 30 segundos
});

// ============================================
// TOKEN MANAGEMENT
// ============================================

/**
 * Obtener token de autenticación desde localStorage
 * @returns {string|null} Token JWT o null
 */
export const getToken = () => {
  return localStorage.getItem('auth_token');
};

/**
 * Guardar token de autenticación en localStorage
 * @param {string} token - Token JWT
 */
export const setToken = (token) => {
  if (token) {
    localStorage.setItem('auth_token', token);
  } else {
    localStorage.removeItem('auth_token');
  }
};

/**
 * Eliminar token de autenticación
 */
export const clearToken = () => {
  localStorage.removeItem('auth_token');
};

// ============================================
// REQUEST INTERCEPTOR - Agregar token Bearer
// ============================================

api.interceptors.request.use(
  (config) => {
    const token = getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// ============================================
// RESPONSE INTERCEPTOR - Manejo de 401
// ============================================

api.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    // Si recibimos 401 Unauthorized, limpiar token y redirigir a login
    if (error.response && error.response.status === 401) {
      clearToken();
      // Redirigir a login si no estamos ya allí
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

// ============================================
// AUTHENTICATION
// ============================================

/**
 * Iniciar sesión
 * @param {string} username - Usuario
 * @param {string} password - Contraseña
 * @returns {Promise<Object>} Datos del usuario y token
 */
export const login = async (username, password) => {
  const response = await api.post('/api/auth/login', { username, password });
  if (response.data.token) {
    setToken(response.data.token);
  }
  return response.data;
};

/**
 * Cerrar sesión
 */
export const logout = () => {
  clearToken();
  window.location.href = '/login';
};

// ============================================
// DASHBOARD OVERVIEW
// ============================================

/**
 * Obtener resumen general del dashboard
 * @returns {Promise<Object>} Métricas generales, KPIs, resumen
 */
export const getOverview = async () => {
  const response = await api.get('/api/metrics/overview');
  return response.data;
};

/**
 * Obtener historial diario del overview (para gráficos de tendencia)
 * @param {number} days - Días de historial (default 7)
 * @returns {Promise<Array>} Array de { date, spend, revenue, roas_7d, roas_3d }
 */
export const getOverviewHistory = async (days = 7) => {
  const response = await api.get('/api/metrics/overview/history', { params: { days } });
  return response.data;
};

// ============================================
// CAMPAIGNS
// ============================================

/**
 * Obtener todas las campañas
 * @param {Object} params - Parámetros de filtrado (status, sortBy, etc.)
 * @returns {Promise<Array>} Lista de campañas
 */
export const getCampaigns = async (params = {}) => {
  const response = await api.get('/api/metrics/campaigns', { params });
  return response.data;
};

/**
 * Obtener campaña por ID
 * @param {string} campaignId - ID de la campaña
 * @returns {Promise<Object>} Datos de la campaña
 */
export const getCampaign = async (campaignId) => {
  const response = await api.get(`/api/metrics/campaigns/${campaignId}`);
  return response.data;
};

// ============================================
// AD SETS
// ============================================

/**
 * Obtener conjuntos de anuncios
 * @param {string} campaignId - ID de campaña (opcional)
 * @returns {Promise<Array>} Lista de ad sets
 */
export const getAdSets = async (campaignId = null) => {
  const params = campaignId ? { campaign_id: campaignId } : {};
  const response = await api.get('/api/metrics/adsets', { params });
  return response.data;
};

/**
 * Obtener ad set por ID
 * @param {string} adsetId - ID del ad set
 * @returns {Promise<Object>} Datos del ad set
 */
export const getAdSet = async (adsetId) => {
  const response = await api.get(`/api/metrics/adsets/${adsetId}`);
  return response.data;
};

// ============================================
// ADS
// ============================================

/**
 * Obtener anuncios
 * @param {string} adsetId - ID de ad set (opcional)
 * @returns {Promise<Array>} Lista de anuncios
 */
export const getAds = async (adsetId = null) => {
  const params = adsetId ? { adset_id: adsetId } : {};
  const response = await api.get('/api/metrics/ads', { params });
  return response.data;
};

/**
 * Obtener anuncio por ID
 * @param {string} adId - ID del anuncio
 * @returns {Promise<Object>} Datos del anuncio
 */
export const getAd = async (adId) => {
  const response = await api.get(`/api/metrics/ads/${adId}`);
  return response.data;
};

// ============================================
// HISTORY & PERFORMANCE
// ============================================

/**
 * Obtener historial de métricas para una entidad
 * @param {string} entityId - ID de la entidad (campaign, adset, ad)
 * @param {number} days - Número de días de historial (default 7)
 * @returns {Promise<Array>} Datos históricos
 */
export const getHistory = async (entityId, days = 7) => {
  const response = await api.get(`/api/metrics/history/${entityId}`, {
    params: { days }
  });
  return response.data;
};

/**
 * Obtener top performers (mejores campañas/anuncios)
 * @param {Object} params - Parámetros (metric, limit, type)
 * @returns {Promise<Array>} Lista de top performers
 */
export const getTopPerformers = async (params = {}) => {
  const response = await api.get('/api/metrics/top-performers', { params });
  return response.data;
};

// ============================================
// AI DECISIONS & ACTIONS
// ============================================

/**
 * Obtener decisiones de la IA
 * @param {number} page - Número de página (paginación)
 * @param {number} limit - Límite de resultados por página
 * @returns {Promise<Object>} Decisiones con metadata de paginación
 */
export const getDecisions = async (page = 1, limit = 50) => {
  const response = await api.get('/api/decisions', {
    params: { page, limit }
  });
  return response.data;
};

/**
 * Obtener estadísticas de decisiones
 * @returns {Promise<Object>} Stats de decisiones (counts por tipo, éxito, etc.)
 */
export const getDecisionStats = async () => {
  const response = await api.get('/api/decisions/stats');
  return response.data;
};

/**
 * Aprobar recomendación de una decisión
 * @param {string} decisionId
 * @param {string} itemId
 * @returns {Promise<Object>}
 */
export const approveDecisionRecommendation = async (decisionId, itemId) => {
  const response = await api.post(`/api/decisions/${decisionId}/items/${itemId}/approve`, {}, { timeout: 120000 });
  return response.data;
};

/**
 * Rechazar recomendación de una decisión
 * @param {string} decisionId
 * @param {string} itemId
 * @returns {Promise<Object>}
 */
export const rejectDecisionRecommendation = async (decisionId, itemId) => {
  const response = await api.post(`/api/decisions/${decisionId}/items/${itemId}/reject`);
  return response.data;
};

/**
 * Helper: poll a status endpoint until completed or failed.
 * @param {string} url - Status endpoint to poll
 * @param {number} intervalMs - Polling interval (default 2s)
 * @param {number} maxWaitMs - Max wait time (default 5 min)
 * @returns {Promise<Object>} Final result
 */
const pollForCompletion = async (url, intervalMs = 2000, maxWaitMs = 300000) => {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const response = await api.get(url);
    const data = response.data;

    if (data.status === 'completed') {
      return { success: true, ...data };
    }
    if (data.status === 'failed') {
      throw new Error(data.error || 'Ejecución falló');
    }
    // Still running — wait and retry
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timeout: la operación tardó demasiado');
};

/**
 * Ejecutar recomendación aprobada de una decisión (background + polling)
 * @param {string} decisionId
 * @param {string} itemId
 * @returns {Promise<Object>}
 */
export const executeDecisionRecommendation = async (decisionId, itemId) => {
  // Launch background execution
  const response = await api.post(`/api/decisions/${decisionId}/items/${itemId}/execute`, {}, { timeout: 30000 });
  const data = response.data;

  // If async execution, poll for result
  if (data.async && data.job_id) {
    return pollForCompletion(`/api/decisions/execute-status/${data.job_id}`);
  }

  // Fallback: direct response (shouldn't happen, but safe)
  return data;
};

/**
 * Obtener acciones ejecutadas
 * @param {number} page - Número de página
 * @param {number} limit - Límite de resultados por página
 * @returns {Promise<Object>} Acciones con metadata de paginación
 */
export const getActions = async (page = 1, limit = 50) => {
  const response = await api.get('/api/actions', {
    params: { page, limit }
  });
  return response.data;
};

// ============================================
// CONTROLS & SAFETY
// ============================================

/**
 * Obtener estado de los controles (kill switch, modo, etc.)
 * @returns {Promise<Object>} Estado actual de controles
 */
export const getControlsStatus = async () => {
  const response = await api.get('/api/controls/status');
  return response.data;
};

/**
 * Activar/desactivar kill switch
 * @param {string} action - 'activate' | 'deactivate'
 * @param {string} reason - Razón del cambio
 * @returns {Promise<Object>} Estado actualizado
 */
export const triggerKillSwitch = async (action, reason = '') => {
  const response = await api.post('/api/controls/kill-switch', {
    action,
    reason
  });
  return response.data;
};

/**
 * Activar/desactivar control de IA
 * @param {boolean} enabled - true para activar, false para desactivar
 * @returns {Promise<Object>} Estado actualizado
 */
export const toggleAI = async (enabled) => {
  const response = await api.post('/api/controls/ai-toggle', { enabled });
  return response.data;
};

/**
 * Obtener modo del motor de decisiones
 * @returns {Promise<Object>} { decision_engine_mode }
 */
export const getDecisionEngineMode = async () => {
  const response = await api.get('/api/controls/engine-mode');
  return response.data;
};

/**
 * Actualizar modo del motor de decisiones
 * @param {string} mode - unified_shadow | unified_live
 * @returns {Promise<Object>} Estado actualizado
 */
export const updateDecisionEngineMode = async (mode) => {
  const response = await api.put('/api/controls/engine-mode', { mode });
  return response.data;
};

/**
 * Ejecutar ciclo IA inmediato según modo activo
 * @returns {Promise<Object>} Resultado de ejecución
 */
export const runAICycle = async () => {
  const response = await api.post('/api/controls/run-cycle', {}, { timeout: 180000 });
  return response.data;
};

/**
 * Pausar entidad (campaign, adset, ad) manualmente
 * @param {string} entityId - ID de la entidad
 * @param {Object} data - { entity_type: 'campaign'|'adset'|'ad', reason: string }
 * @returns {Promise<Object>} Resultado de la acción
 */
export const pauseEntity = async (entityId, data) => {
  const response = await api.post(`/api/controls/pause/${entityId}`, data, { timeout: 60000 });
  return response.data;
};

/**
 * Activar entidad (campaign, adset, ad) manualmente
 * @param {string} entityId - ID de la entidad
 * @param {Object} data - { entity_type: 'campaign'|'adset'|'ad', reason: string }
 * @returns {Promise<Object>} Resultado de la acción
 */
export const activateEntity = async (entityId, data) => {
  const response = await api.post(`/api/controls/activate/${entityId}`, data, { timeout: 60000 });
  return response.data;
};

// ============================================
// SETTINGS & CONFIGURATION
// ============================================

/**
 * Obtener configuración actual
 * @returns {Promise<Object>} Configuración de seguridad, KPIs, etc.
 */
export const getSettings = async () => {
  const response = await api.get('/api/settings');
  return response.data;
};

/**
 * Actualizar configuración de seguridad
 * @param {Object} data - Nuevas configuraciones de safety
 * @returns {Promise<Object>} Configuración actualizada
 */
export const updateSafety = async (data) => {
  const response = await api.put('/api/settings/safety', data);
  return response.data;
};

/**
 * Actualizar configuración de KPIs
 * @param {Object} data - Nuevas configuraciones de KPI
 * @returns {Promise<Object>} Configuración actualizada
 */
export const updateKPI = async (data) => {
  const response = await api.put('/api/settings/kpi', data);
  return response.data;
};

// ============================================
// NOTIFICATIONS
// ============================================

/**
 * Obtener notificaciones
 * @param {Object} params - Filtros (read, type, etc.)
 * @returns {Promise<Array>} Lista de notificaciones
 */
export const getNotifications = async (params = {}) => {
  const response = await api.get('/api/notifications', { params });
  return response.data;
};

/**
 * Marcar notificación como leída
 * @param {string} notificationId - ID de la notificación
 * @returns {Promise<Object>} Notificación actualizada
 */
export const markNotificationRead = async (notificationId) => {
  const response = await api.put(`/api/notifications/${notificationId}/read`);
  return response.data;
};

/**
 * Marcar todas las notificaciones como leídas
 * @returns {Promise<Object>} Resultado
 */
export const markAllNotificationsRead = async () => {
  const response = await api.put('/api/notifications/read-all');
  return response.data;
};

// ============================================
// ALERTS
// ============================================

/**
 * Obtener alertas activas
 * @returns {Promise<Array>} Lista de alertas
 */
export const getAlerts = async () => {
  const response = await api.get('/api/alerts');
  return response.data;
};

/**
 * Descartar alerta
 * @param {string} alertId - ID de la alerta
 * @returns {Promise<Object>} Resultado
 */
export const dismissAlert = async (alertId) => {
  const response = await api.delete(`/api/alerts/${alertId}`);
  return response.data;
};

// ============================================
// META OAUTH & CONNECTION
// ============================================

/**
 * Obtener estado de la conexión con Meta
 * @returns {Promise<Object>} Estado de conexión, usuario, cuenta
 */
export const getMetaConnectionStatus = async () => {
  const response = await api.get('/api/auth/meta/status');
  return response.data;
};

/**
 * Obtener URL de login de Facebook OAuth
 * @returns {Promise<Object>} { login_url, redirect_uri, scopes }
 */
export const getMetaLoginUrl = async () => {
  const response = await api.get('/api/auth/meta/login-url');
  return response.data;
};

/**
 * Intercambiar un token pegado manualmente
 * @param {string} accessToken - Token de acceso de Meta
 * @returns {Promise<Object>} Resultado del intercambio
 */
export const exchangeMetaToken = async (accessToken) => {
  const response = await api.post('/api/auth/meta/exchange-token', {
    access_token: accessToken
  });
  return response.data;
};

/**
 * Seleccionar cuenta publicitaria
 * @param {string} adAccountId - ID de la cuenta (act_XXXXXXXXXX)
 * @returns {Promise<Object>} Resultado
 */
export const selectMetaAccount = async (adAccountId) => {
  const response = await api.put('/api/auth/meta/select-account', {
    ad_account_id: adAccountId
  });
  return response.data;
};

/**
 * Renovar token de Meta manualmente
 * @returns {Promise<Object>} Resultado de la renovación
 */
export const refreshMetaToken = async () => {
  const response = await api.post('/api/auth/meta/refresh');
  return response.data;
};

/**
 * Desconectar de Meta
 * @returns {Promise<Object>} Resultado
 */
export const disconnectMeta = async () => {
  const response = await api.post('/api/auth/meta/disconnect');
  return response.data;
};

// ============================================
// AI AGENTS
// ============================================

export const getAgentReports = async () => {
  const response = await api.get('/api/agents/latest');
  return response.data;
};

export const getAgentHistory = async (agentType, limit = 20) => {
  const response = await api.get('/api/agents/history', {
    params: { agent_type: agentType, limit }
  });
  return response.data;
};

export const getPendingRecommendations = async () => {
  const response = await api.get('/api/agents/pending');
  return response.data;
};

export const approveRecommendation = async (reportId, recId) => {
  const response = await api.post(`/api/agents/approve/${reportId}/${recId}`);
  return response.data;
};

export const rejectRecommendation = async (reportId, recId) => {
  const response = await api.post(`/api/agents/reject/${reportId}/${recId}`);
  return response.data;
};

export const executeRecommendation = async (reportId, recId, body = {}) => {
  // Launch background execution
  const response = await api.post(`/api/agents/execute/${reportId}/${recId}`, body, { timeout: 30000 });
  const data = response.data;

  // If async execution, poll for result
  if (data.async && data.job_id) {
    return pollForCompletion(`/api/agents/execute-status/${data.job_id}`);
  }

  return data;
};

export const runAgents = async () => {
  const response = await api.post('/api/agents/run', {}, { timeout: 180000 });
  return response.data;
};

export const getAdsForAdSet = async (adSetId) => {
  const response = await api.get(`/api/metrics/ads/${adSetId}`);
  return response.data;
};

export const getAdSetActions = async (days = 30) => {
  const response = await api.get('/api/metrics/adsets/actions', { params: { days } });
  return response.data;
};

export const getActionsWithImpact = async (limit = 50) => {
  const response = await api.get('/api/agents/impact', { params: { limit } });
  return response.data;
};

export const getImpactData = async (limit = 50) => {
  const response = await api.get('/api/agents/impact', { params: { limit } });
  return response.data;
};

export const getAutonomyConfig = async () => {
  const response = await api.get('/api/agents/autonomy');
  return response.data;
};

export const updateAutonomyConfig = async (updates) => {
  const response = await api.put('/api/agents/autonomy', updates);
  return response.data;
};

export const getBrainReadiness = async () => {
  const response = await api.get('/api/agents/readiness');
  return response.data;
};

// ============================================
// CREATIVE BANK
// ============================================

export const getCreativeAssets = async (status = 'active') => {
  const response = await api.get('/api/creatives', { params: { status } });
  return response.data;
};

export const uploadCreativeAsset = async (formData) => {
  const response = await api.post('/api/creatives/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 120000
  });
  return response.data;
};

export const updateCreativeAsset = async (id, data) => {
  const response = await api.put(`/api/creatives/${id}`, data);
  return response.data;
};

export const archiveCreativeAsset = async (id) => {
  const response = await api.delete(`/api/creatives/${id}`);
  return response.data;
};

export const uploadCreativeToMeta = async (id) => {
  const response = await api.post(`/api/creatives/${id}/upload-to-meta`, {}, { timeout: 60000 });
  return response.data;
};

export const detectProductForAsset = async (id) => {
  const response = await api.post(`/api/creatives/${id}/detect-product`, {}, { timeout: 30000 });
  return response.data;
};

export const bulkDetectProducts = async () => {
  const response = await api.post('/api/creatives/detect-all', {}, { timeout: 600000 });
  return response.data;
};

export const syncCreativeMetrics = async () => {
  const response = await api.post('/api/creatives/sync-metrics', {}, { timeout: 60000 });
  return response.data;
};

export const getCreativePreviewUrl = (filenameOrId, filename) => {
  // Si se pasa filename directamente, usar ruta estática (no requiere auth)
  const fname = filename || filenameOrId;
  return `${BASE_URL}/uploads/creatives/${fname}`;
};

export const generateCreativePrompt = async (data) => {
  const response = await api.post('/api/creatives/generate/prompt', data, { timeout: 180000 });
  return response.data;
};

export const generateCreativeImages = async (data) => {
  const response = await api.post('/api/creatives/generate/images', data, { timeout: 600000 });
  return response.data;
};

export const getGeneratedPreviewUrl = (filename) => {
  return `${BASE_URL}/uploads/generated/${filename}`;
};

export const judgeGeneratedImages = async (data) => {
  const response = await api.post('/api/creatives/generate/judge', data, { timeout: 180000 });
  return response.data;
};

export const acceptGeneratedCreative = async (data) => {
  const response = await api.post('/api/creatives/generate/accept', data);
  return response.data;
};

export const getCooldowns = async () => {
  const response = await api.get('/api/agents/cooldowns');
  return response.data;
};

export const clearCooldowns = async () => {
  const response = await api.delete('/api/agents/cooldowns');
  return response.data;
};

// ============================================
// AD SET CREATOR (AI)
// ============================================

export const strategizeAdSet = async () => {
  const response = await api.post('/api/adset-creator/strategize', {}, { timeout: 300000 });
  return response.data;
};

export const approveAdSet = async (data) => {
  // Launch background execution
  const response = await api.post('/api/adset-creator/approve', data, { timeout: 30000 });
  const resData = response.data;

  // If async execution, poll for result
  if (resData.async && resData.job_id) {
    return pollForCompletion(`/api/adset-creator/approve-status/${resData.job_id}`, 3000, 600000);
  }

  return resData;
};

export const rejectAdSet = async () => {
  const response = await api.post('/api/adset-creator/reject');
  return response.data;
};

export const getAdSetCreatorHistory = async () => {
  const response = await api.get('/api/adset-creator/history');
  return response.data;
};

export const getManagerStatus = async () => {
  const response = await api.get('/api/adset-creator/manager/status');
  return response.data;
};

export const getManagerStatusLive = async () => {
  const response = await api.get('/api/adset-creator/manager/status/live', { timeout: 120000 });
  return response.data;
};

export const runAIManager = async () => {
  const response = await api.post('/api/adset-creator/manager/run', {}, { timeout: 300000 });
  return response.data;
};

export const getManagerControlPanel = async () => {
  const response = await api.get('/api/adset-creator/manager/control-panel');
  return response.data;
};

// ============================================
// AI OPS (Operations Dashboard)
// ============================================

export const getAIOpsStatus = async () => {
  const response = await api.get('/api/ai-ops/status', { timeout: 60000 });
  return response.data;
};

// ============================================
// AI CREATIONS
// ============================================

export const getAICreations = async (params = {}) => {
  const response = await api.get('/api/ai-creations', { params });
  return response.data;
};

export const getAICreationStats = async () => {
  const response = await api.get('/api/ai-creations/stats');
  return response.data;
};

// ============================================
// STRATEGIC
// ============================================

export const getStrategicLatest = async () => {
  const response = await api.get('/api/strategic/latest');
  return response.data;
};

export const runStrategicCycle = async () => {
  // Launch cycle (returns immediately since backend runs in background)
  const response = await api.post('/api/strategic/run-cycle', {}, { timeout: 30000 });
  const data = response.data;

  if (!data.success) return data;

  // Poll run-status until completed
  const start = Date.now();
  const maxWait = 300000; // 5 min max
  while (Date.now() - start < maxWait) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const statusRes = await api.get('/api/strategic/run-status');
    const status = statusRes.data;

    if (status.status === 'completed') {
      return { success: true, ...status.result };
    }
    if (status.status === 'idle' && !status.result) {
      // Might have missed it — check latest
      return { success: true, status: 'completed' };
    }
  }
  throw new Error('Timeout: el ciclo estratégico tardó demasiado');
};

export const getStrategicRunStatus = async () => {
  const response = await api.get('/api/strategic/run-status');
  return response.data;
};

export const getStrategicDirectives = async () => {
  const response = await api.get('/api/strategic/directives');
  return response.data;
};

export const acknowledgeInsight = async (insightId) => {
  const response = await api.post(`/api/strategic/insights/${insightId}/acknowledge`);
  return response.data;
};

export const implementInsight = async (insightId) => {
  const response = await api.post(`/api/strategic/insights/${insightId}/implement`, {}, { timeout: 120000 });
  return response.data;
};

export const dismissInsight = async (insightId) => {
  const response = await api.post(`/api/strategic/insights/${insightId}/dismiss`);
  return response.data;
};

// ============================================
// VIDEO GENERATION — Director Creativo Mode
// ============================================

export const getVideoScenes = async () => {
  const response = await api.get('/api/video/scenes');
  return response.data;
};

export const getVideoShotTypes = async () => {
  const response = await api.get('/api/video/shot-types');
  return response.data;
};

export const getBeatTypes = async () => {
  const response = await api.get('/api/video/beat-types');
  return response.data;
};

export const getVideoModels = async () => {
  const response = await api.get('/api/video/video-models');
  return response.data;
};

export const getVideoMotions = async () => {
  const response = await api.get('/api/video/motions');
  return response.data;
};

export const uploadProductPhoto = async (formData) => {
  const response = await api.post('/api/video/upload-product', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 120000
  });
  return response.data;
};

// Claude Director Creativo: analyze product + recommend scene + design shots
export const analyzeScene = async (data) => {
  const response = await api.post('/api/video/analyze-scene', data, { timeout: 180000 });
  return response.data;
};

export const getVideoShots = async () => {
  const response = await api.get('/api/video/shots');
  return response.data;
};

export const deleteVideoShot = async (filename) => {
  const response = await api.delete(`/api/video/shots/${filename}`);
  return response.data;
};

// Start async shot generation (returns jobId immediately)
export const generateShots = async (data) => {
  const response = await api.post('/api/video/generate-shots', data);
  return response.data;
};

// Poll shot generation job status
export const getShotJobStatus = async (jobId) => {
  const response = await api.get(`/api/video/shots-job/${jobId}`);
  return response.data;
};

// Claude Quality Judge: score each generated shot
export const judgeShots = async (data) => {
  const response = await api.post('/api/video/judge-shots', data, { timeout: 180000 });
  return response.data;
};

// Regenerate a single low-scoring shot
export const regenerateShot = async (data) => {
  const response = await api.post('/api/video/regenerate-shot', data, { timeout: 120000 });
  return response.data;
};

export const generateClip = async (data) => {
  const response = await api.post('/api/video/generate-clip', data, { timeout: 300000 });
  return response.data;
};

export const generateClipsBatch = async (data) => {
  const response = await api.post('/api/video/generate-clips-batch', data, { timeout: 600000 });
  return response.data;
};

export const getClipStatus = async (requestId, videoModel) => {
  const params = videoModel ? { videoModel } : {};
  const response = await api.get(`/api/video/clip-status/${requestId}`, { params });
  return response.data;
};

export const getClipStatusBatch = async (requestIds, videoModel) => {
  const response = await api.post('/api/video/clip-status-batch', { requestIds, videoModel });
  return response.data;
};

// Get available music tracks
export const getMusicTracks = async () => {
  const response = await api.get('/api/video/music-tracks');
  return response.data;
};

// Stitch completed clips into ONE commercial video with crossfades, music, and text
export const stitchClips = async (clipUrls, options = {}) => {
  const response = await api.post('/api/video/stitch', {
    clipUrls,
    musicTrack: options.musicTrack || 'none',
    brandText: options.brandText || '',
    crossfadeDuration: options.crossfadeDuration ?? 0.5
  });
  return response.data;
};

// Poll stitch job status
export const getStitchStatus = async (jobId) => {
  const response = await api.get(`/api/video/stitch-status/${jobId}`);
  return response.data;
};

// ============================================
// EXPORT DEFAULT
// ============================================

export default api;
