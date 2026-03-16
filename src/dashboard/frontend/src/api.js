/**
 * API Client — Ad Sets Manager
 */
import axios from 'axios';

const BASE_URL = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3500');

const api = axios.create({
  baseURL: BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 30000,
});

// ═══ TOKEN ═══

export const getToken = () => localStorage.getItem('auth_token');

export const setToken = (token) => {
  if (token) localStorage.setItem('auth_token', token);
  else localStorage.removeItem('auth_token');
};

export const clearToken = () => localStorage.removeItem('auth_token');

// ═══ INTERCEPTORS ═══

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
}, (error) => Promise.reject(error));

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      clearToken();
      if (window.location.pathname !== '/login') window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// ═══ AUTH ═══

export const login = async (username, password) => {
  const response = await api.post('/api/auth/login', { username, password });
  if (response.data.token) setToken(response.data.token);
  return response.data;
};

export const logout = () => {
  clearToken();
  window.location.href = '/login';
};

// ═══ POLLING HELPER ═══

const pollForCompletion = async (url, intervalMs = 2000, maxWaitMs = 300000) => {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const response = await api.get(url);
    const data = response.data;
    if (data.status === 'completed') return { success: true, ...data };
    if (data.status === 'failed') throw new Error(data.error || 'Operation failed');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timeout');
};

// ═══ CONTROLS ═══

export const getControlsStatus = async () => {
  const response = await api.get('/api/controls/status');
  return response.data;
};

export const pauseEntity = async (entityId, data) => {
  const response = await api.post(`/api/controls/pause/${entityId}`, data, { timeout: 60000 });
  return response.data;
};

export const deleteEntity = async (entityId, data) => {
  const response = await api.post(`/api/controls/delete/${entityId}`, data, { timeout: 60000 });
  return response.data;
};

// ═══ AGENTS (Brain) ═══

export const runAgents = async () => {
  const response = await api.post('/api/agents/run', {}, { timeout: 30000 });
  const data = response.data;
  if (data.async && data.job_id) return pollForCompletion(`/api/agents/execute-status/${data.job_id}`, 3000, 600000);
  return data;
};

// ═══ AI MANAGER ═══

export const runAIManager = async () => {
  const response = await api.post('/api/adset-creator/manager/run', {}, { timeout: 30000 });
  const data = response.data;
  if (data.async && data.job_id) return pollForCompletion(`/api/adset-creator/manager/run-status/${data.job_id}`, 3000, 600000);
  return data;
};

// ═══ METRICS — LIVE from Meta API ═══

export const getAllAdSets = async (force = false) => {
  const params = force ? { force: 'true' } : {};
  const response = await api.get('/api/metrics/adsets/live', { params, timeout: 35000 });
  return response.data; // { adsets: [...], cached, fetched_at, age_seconds }
};

export const getAdsForAdSet = async (adsetId) => {
  const response = await api.get(`/api/metrics/ads/live/${adsetId}`, { timeout: 120000 });
  return response.data;
};

export const getAccountOverview = async () => {
  const response = await api.get('/api/metrics/overview', { timeout: 30000 });
  return response.data;
};

export const refreshLiveCache = async () => {
  await api.post('/api/metrics/refresh-cache', {}, { timeout: 5000 });
};

export const getRateLimitStatus = async () => {
  const response = await api.get('/api/metrics/rate-limit', { timeout: 5000 });
  return response.data;
};

// ═══ SSE — Server-Sent Events for real-time push updates ═══

/**
 * Connect to the SSE stream for real-time ad set updates.
 * Returns an EventSource instance. Call .close() to disconnect.
 *
 * @param {Function} onData - callback(data) when new adsets data arrives
 * @param {Function} onError - callback(error) on connection error
 * @returns {EventSource}
 */
export const connectSSE = (onData, onError) => {
  const token = getToken();
  const url = `${BASE_URL}/api/metrics/stream${token ? `?token=${token}` : ''}`;
  const es = new EventSource(url);

  es.addEventListener('adsets', (event) => {
    try {
      const data = JSON.parse(event.data);
      onData(data);
    } catch (e) {
      console.error('SSE parse error:', e);
    }
  });

  es.onerror = (err) => {
    if (onError) onError(err);
  };

  return es;
};

// ═══ AI OPS (refresh, auto-refresh) ═══

export const refreshAIOpsMetrics = async () => {
  const response = await api.post('/api/ai-ops/refresh', {}, { timeout: 30000 });
  const data = response.data;
  if (data.async && data.job_id) return pollForCompletion(`/api/ai-ops/refresh-status/${data.job_id}`, 3000, 600000);
  return data;
};

export const autoRefreshAIOps = async () => {
  const response = await api.post('/api/ai-ops/auto-refresh', {}, { timeout: 30000 });
  const data = response.data;
  if (data.action === 'refreshing' && data.job_id) return pollForCompletion(`/api/ai-ops/refresh-status/${data.job_id}`, 3000, 600000);
  return data;
};

// ═══ ADD CREATIVE TO AD SET ═══

export const getAvailableCreatives = async (adsetId) => {
  const response = await api.get(`/api/ai-ops/available-creatives/${adsetId}`, { timeout: 30000 });
  return response.data;
};

export const generateAdCopy = async (adsetId, assetId) => {
  const response = await api.post('/api/ai-ops/generate-copy', {
    adset_id: adsetId, asset_id: assetId
  }, { timeout: 60000 });
  return response.data;
};

export const addAdToAdSet = async (adsetId, assetId, customHeadline, customBody) => {
  const response = await api.post('/api/ai-ops/add-ad', {
    adset_id: adsetId, asset_id: assetId,
    custom_headline: customHeadline || null, custom_body: customBody || null
  }, { timeout: 15000 });
  const data = response.data;
  if (data.job_id) return pollForCompletion(`/api/ai-ops/add-ad-status/${data.job_id}`, 3000, 300000);
  return data;
};

export const getCreativePreviewUrl = (filenameOrId, filename) => {
  const fname = filename || filenameOrId;
  return `${BASE_URL}/uploads/creatives/${fname}`;
};

// ═══ MANUAL CREATIVE UPLOAD ═══

export const generateCopyForUpload = async (imageFile, productHint = '') => {
  const formData = new FormData();
  formData.append('image', imageFile);
  if (productHint) formData.append('product_hint', productHint);
  const response = await api.post('/api/ai-ops/generate-copy-for-upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 120000
  });
  return response.data;
};

export const uploadAndCreateAd = async ({ adsetId, imageFile, uploadedFile, headline, primaryText, linkUrl, description, cta }) => {
  const formData = new FormData();
  formData.append('adset_id', adsetId);
  formData.append('headline', headline);
  formData.append('primary_text', primaryText);
  formData.append('link_url', linkUrl);
  if (description) formData.append('description', description);
  if (cta) formData.append('cta', cta);
  if (imageFile) formData.append('image', imageFile);
  else if (uploadedFile) formData.append('uploaded_file', uploadedFile);
  const response = await api.post('/api/ai-ops/upload-and-create-ad', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 15000
  });
  const data = response.data;
  if (data.job_id) return pollForCompletion(`/api/ai-ops/upload-ad-status/${data.job_id}`, 3000, 300000);
  return data;
};

// ═══ ACCOUNT AGENT ═══

export const getAgentActivity = async () => {
  const response = await api.get('/api/agent/activity', { timeout: 15000 });
  return response.data;
};

export const runAccountAgent = async () => {
  const response = await api.post('/api/agent/run', {}, { timeout: 30000 });
  const data = response.data;
  if (data.async && data.job_id) return pollForCompletion(`/api/agent/run-status/${data.job_id}`, 3000, 600000);
  return data;
};

export const getAgentAdsetDetail = async (adsetId) => {
  const response = await api.get(`/api/agent/adset/${adsetId}`, { timeout: 15000 });
  return response.data;
};

// ═══ BRAIN — Creative Refresh Link ═══

export const getPendingCreativeRec = async (adsetId) => {
  const response = await api.get(`/api/brain/recommendations/pending-creative/${adsetId}`);
  return response.data;
};

// ═══ BRAIN — Intelligence Feed & Chat ═══

export const getBrainInsights = async (page = 1, limit = 20, filters = {}) => {
  const params = { page, limit, ...filters };
  const response = await api.get('/api/brain/insights', { params });
  return response.data;
};

export const markInsightRead = async (id) => {
  const response = await api.post(`/api/brain/insights/${id}/read`);
  return response.data;
};

export const markAllInsightsRead = async () => {
  const response = await api.post('/api/brain/insights/read-all');
  return response.data;
};

export const triggerBrainAnalysis = async () => {
  const response = await api.post('/api/brain/analyze', {}, { timeout: 120000 });
  return response.data;
};

export const sendBrainChat = async (message) => {
  const response = await api.post('/api/brain/chat', { message }, { timeout: 180000 });
  return response.data;
};

/**
 * Streaming chat with Brain via SSE (POST with fetch).
 * @param {string} message
 * @param {Function} onThinking - callback({ phase, text }) during thinking phases
 * @param {Function} onDelta - callback(text) for each text chunk
 * @param {Function} onDone - callback({ tokens_used }) when complete
 * @param {Function} onError - callback(error) on error
 * @returns {{ abort: Function }} - call abort() to cancel
 */
export const sendBrainChatStream = (message, { onThinking, onDelta, onDone, onError }) => {
  const controller = new AbortController();
  const token = getToken();

  const url = `${BASE_URL}/api/brain/chat/stream`;

  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ message }),
    signal: controller.signal
  }).then(async (response) => {
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Stream failed' }));
      onError?.(new Error(err.error || `HTTP ${response.status}`));
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'thinking') onThinking?.(data);
          else if (data.type === 'delta') onDelta?.(data.text);
          else if (data.type === 'done') onDone?.(data);
          else if (data.type === 'error') onError?.(new Error(data.error));
        } catch (e) { /* ignore parse errors */ }
      }
    }
  }).catch((err) => {
    if (err.name !== 'AbortError') onError?.(err);
  });

  return { abort: () => controller.abort() };
};

export const getBrainChatHistory = async (limit = 50) => {
  const response = await api.get('/api/brain/chat/history', { params: { limit } });
  return response.data;
};

export const clearBrainChatHistory = async () => {
  const response = await api.delete('/api/brain/chat/history');
  return response.data;
};

export const getBrainStats = async () => {
  const response = await api.get('/api/brain/stats');
  return response.data;
};

export const getBrainMemory = async () => {
  const response = await api.get('/api/brain/memory');
  return response.data;
};

// ═══ BRAIN — Recommendations ═══

export const getBrainRecommendations = async (page = 1, limit = 20, status = '') => {
  const params = { page, limit };
  if (status) params.status = status;
  const response = await api.get('/api/brain/recommendations', { params });
  return response.data;
};

export const approveRecommendation = async (id, note = '') => {
  const response = await api.post(`/api/brain/recommendations/${id}/approve`, { note });
  return response.data;
};

export const rejectRecommendation = async (id, note = '') => {
  const response = await api.post(`/api/brain/recommendations/${id}/reject`, { note });
  return response.data;
};

export const markRecommendationExecuted = async (id) => {
  const response = await api.post(`/api/brain/recommendations/${id}/mark-executed`);
  return response.data;
};

export const triggerBrainRecommendations = async () => {
  const response = await api.post('/api/brain/recommendations/generate', {}, { timeout: 120000 });
  return response.data;
};

export const getRecommendationHistory = async (limit = 20) => {
  const response = await api.get('/api/brain/recommendations/history', { params: { limit } });
  return response.data;
};

// ═══ BRAIN — Follow-Up Stats & Knowledge ═══

export const getFollowUpStats = async () => {
  const response = await api.get('/api/brain/recommendations/follow-up-stats');
  return response.data;
};

export const getPolicyState = async () => {
  const response = await api.get('/api/brain/policy/state');
  return response.data;
};

export const getPolicyLearning = async () => {
  const response = await api.get('/api/brain/policy/learning');
  return response.data;
};

export const getKnowledgeHistory = async (days = 30) => {
  const response = await api.get('/api/brain/knowledge/history', { params: { days } });
  return response.data;
};

export const getDeepKnowledge = async () => {
  const response = await api.get('/api/brain/knowledge/deep');
  return response.data;
};

export const getLaunchedAdsets = async () => {
  const response = await api.get('/api/ai-creations/launched-adsets');
  return response.data;
};

// ═══ BRAIN — Creative Performance Tracking ═══

export const getCreativePerformance = async () => {
  const response = await api.get('/api/brain/creative-performance');
  return response.data;
};

// ═══ BRAIN — Ad Health Diagnostics ═══

export const getAdHealth = async () => {
  const response = await api.get('/api/brain/ad-health');
  return response.data;
};

export const suggestAdHealthAction = async (adsetId, adsetName, suggestionType, zombieAdIds = []) => {
  const response = await api.post('/api/brain/ad-health/suggest', {
    adset_id: adsetId,
    adset_name: adsetName,
    suggestion_type: suggestionType,
    zombie_ad_ids: zombieAdIds
  });
  return response.data;
};

export const quickPauseAd = async (adId, adName, adsetId, adsetName, reason) => {
  const response = await api.post('/api/brain/ad-health/quick-pause', {
    ad_id: adId,
    ad_name: adName,
    adset_id: adsetId,
    adset_name: adsetName,
    reason
  });
  return response.data;
};

// ═══ BRAIN — Launch Ad Set ═══

export const uploadLaunchCreatives = async (imageFiles, productName = '') => {
  const formData = new FormData();
  for (const file of imageFiles) {
    formData.append('images', file);
  }
  if (productName) formData.append('product_name', productName);
  const response = await api.post('/api/brain/launch/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 60000
  });
  return response.data;
};

export const launchStrategize = async (assetIds, productName = '') => {
  const response = await api.post('/api/brain/launch/strategize', {
    asset_ids: assetIds,
    product_name: productName
  }, { timeout: 120000 });
  return response.data;
};

export const launchApprove = async (proposal) => {
  const response = await api.post('/api/brain/launch/approve', { proposal }, { timeout: 15000 });
  const data = response.data;
  if (data.async && data.job_id) {
    // Poll for completion
    const start = Date.now();
    while (Date.now() - start < 300000) {
      const status = await api.get(`/api/brain/launch/status/${data.job_id}`);
      if (status.data.status === 'completed') return { success: true, ...status.data };
      if (status.data.status === 'failed') throw new Error(status.data.error || 'Launch failed');
      await new Promise(r => setTimeout(r, 3000));
    }
    throw new Error('Timeout');
  }
  return data;
};

export const getCreativeThumbnailUrl = (filename) => {
  const BASE = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3500');
  return `${BASE}/uploads/creatives/${filename}`;
};

export default api;
