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

// ═══ METRICS (All ad sets / ads from data-collector) ═══

export const getAllAdSets = async () => {
  const response = await api.get('/api/metrics/adsets', { timeout: 60000 });
  return response.data;
};

export const getAdsForAdSet = async (adsetId) => {
  const response = await api.get('/api/metrics/ads', { params: { adset_id: adsetId }, timeout: 30000 });
  return response.data;
};

export const getAccountOverview = async () => {
  const response = await api.get('/api/metrics/overview', { timeout: 30000 });
  return response.data;
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

export default api;
