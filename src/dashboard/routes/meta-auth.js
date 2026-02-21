const express = require('express');
const axios = require('axios');
const config = require('../../../config');
const MetaToken = require('../../db/models/MetaToken');
const logger = require('../../utils/logger');
const router = express.Router();

const META_GRAPH_URL = `https://graph.facebook.com/${config.meta.apiVersion}`;

// Permisos necesarios para el Marketing API
const REQUIRED_SCOPES = [
  'ads_management',
  'ads_read',
  'business_management',
  'read_insights'
];

// GET /api/auth/meta/status — Estado actual de la conexión
router.get('/status', async (req, res) => {
  try {
    const token = await MetaToken.findOne({ is_active: true }).lean();

    if (!token) {
      return res.json({
        connected: false,
        message: 'No hay conexión con Meta configurada'
      });
    }

    const daysLeft = token.expires_at
      ? Math.floor((new Date(token.expires_at) - new Date()) / (1000 * 60 * 60 * 24))
      : null;

    res.json({
      connected: token.connection_status === 'connected',
      connection_status: token.connection_status,
      meta_user_name: token.meta_user_name,
      meta_user_id: token.meta_user_id,
      ad_account_id: token.ad_account_id,
      ad_account_name: token.ad_account_name,
      ad_account_currency: token.ad_account_currency,
      ad_account_timezone: token.ad_account_timezone,
      available_accounts: token.available_accounts || [],
      token_type: token.token_type,
      expires_at: token.expires_at,
      days_until_expiry: daysLeft,
      last_verified: token.last_verified,
      last_refreshed: token.last_refreshed,
      scopes: token.scopes
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/auth/meta/login-url — Genera la URL de login de Facebook OAuth
router.get('/login-url', (req, res) => {
  const appId = config.meta.appId;

  if (!appId || appId === 'your_app_id') {
    return res.status(400).json({
      error: 'META_APP_ID no está configurado en .env'
    });
  }

  // Redirect URI — el frontend manejará el callback
  const redirectUri = req.query.redirect_uri || `${req.protocol}://${req.get('host')}/api/auth/meta/callback`;

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: REQUIRED_SCOPES.join(','),
    response_type: 'code',
    state: 'meta_oauth_' + Date.now()
  });

  const loginUrl = `https://www.facebook.com/${config.meta.apiVersion}/dialog/oauth?${params.toString()}`;

  res.json({
    login_url: loginUrl,
    redirect_uri: redirectUri,
    scopes: REQUIRED_SCOPES
  });
});

// GET /api/auth/meta/callback — Callback de OAuth (recibe el code)
router.get('/callback', async (req, res) => {
  const { code, error: oauthError, error_description } = req.query;

  if (oauthError) {
    logger.error(`OAuth error: ${oauthError} — ${error_description}`);
    // Redirigir al frontend con error
    return res.redirect(`/meta-connect?error=${encodeURIComponent(error_description || oauthError)}`);
  }

  if (!code) {
    return res.redirect('/meta-connect?error=No se recibió código de autorización');
  }

  try {
    const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/meta/callback`;

    // 1. Intercambiar code por token de corta duración
    const tokenResponse = await axios.get(`${META_GRAPH_URL}/oauth/access_token`, {
      params: {
        client_id: config.meta.appId,
        client_secret: config.meta.appSecret,
        redirect_uri: redirectUri,
        code: code
      }
    });

    const shortLivedToken = tokenResponse.data.access_token;

    // 2. Extender a token de larga duración (60 días)
    const longLivedResponse = await axios.get(`${META_GRAPH_URL}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: config.meta.appId,
        client_secret: config.meta.appSecret,
        fb_exchange_token: shortLivedToken
      }
    });

    const longLivedToken = longLivedResponse.data.access_token;
    const expiresIn = longLivedResponse.data.expires_in || 5184000; // 60 días default

    // 3. Obtener info del usuario
    const userResponse = await axios.get(`${META_GRAPH_URL}/me`, {
      params: {
        access_token: longLivedToken,
        fields: 'id,name'
      }
    });

    // 4. Obtener cuentas publicitarias
    const accountsResponse = await axios.get(`${META_GRAPH_URL}/me/adaccounts`, {
      params: {
        access_token: longLivedToken,
        fields: 'id,name,account_status,currency,timezone_name',
        limit: 50
      }
    });

    const accounts = (accountsResponse.data.data || []).map(acc => ({
      id: acc.id,
      name: acc.name,
      account_status: acc.account_status,
      currency: acc.currency,
      timezone_name: acc.timezone_name
    }));

    // 5. Verificar permisos
    const debugResponse = await axios.get(`${META_GRAPH_URL}/debug_token`, {
      params: {
        input_token: longLivedToken,
        access_token: `${config.meta.appId}|${config.meta.appSecret}`
      }
    });

    const scopes = debugResponse.data.data?.scopes || [];

    // 6. Desactivar tokens anteriores
    await MetaToken.updateMany({ is_active: true }, { is_active: false, connection_status: 'disconnected' });

    // 7. Guardar nuevo token
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + expiresIn);

    // Seleccionar primera cuenta activa por defecto
    const defaultAccount = accounts.find(a => a.account_status === 1) || accounts[0];

    const metaToken = await MetaToken.create({
      access_token: longLivedToken,
      token_type: 'long_lived',
      expires_at: expiresAt,
      scopes,
      meta_user_id: userResponse.data.id,
      meta_user_name: userResponse.data.name,
      ad_account_id: defaultAccount?.id || null,
      ad_account_name: defaultAccount?.name || null,
      ad_account_currency: defaultAccount?.currency || null,
      ad_account_timezone: defaultAccount?.timezone_name || null,
      available_accounts: accounts,
      is_active: true,
      last_verified: new Date(),
      last_refreshed: new Date(),
      connection_status: 'connected'
    });

    logger.info(`Meta OAuth completado — Usuario: ${userResponse.data.name}, Cuentas: ${accounts.length}`);

    // Redirigir al frontend con éxito
    res.redirect('/meta-connect?success=true');
  } catch (error) {
    logger.error('Error en OAuth callback:', error.response?.data || error.message);
    const errorMsg = error.response?.data?.error?.message || error.message;
    res.redirect(`/meta-connect?error=${encodeURIComponent(errorMsg)}`);
  }
});

// POST /api/auth/meta/exchange-token — Intercambiar token manual (pegado directamente)
router.post('/exchange-token', async (req, res) => {
  try {
    const { access_token } = req.body;

    if (!access_token) {
      return res.status(400).json({ error: 'access_token es requerido' });
    }

    // 1. Verificar el token
    const debugResponse = await axios.get(`${META_GRAPH_URL}/debug_token`, {
      params: {
        input_token: access_token,
        access_token: `${config.meta.appId}|${config.meta.appSecret}`
      }
    });

    const tokenData = debugResponse.data.data;
    if (!tokenData.is_valid) {
      return res.status(400).json({ error: 'Token inválido o expirado' });
    }

    // 2. Intentar extender a larga duración
    let finalToken = access_token;
    let tokenType = 'short_lived';
    let expiresIn = tokenData.expires_at ? (tokenData.expires_at - Math.floor(Date.now() / 1000)) : 3600;

    try {
      const longLivedResponse = await axios.get(`${META_GRAPH_URL}/oauth/access_token`, {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: config.meta.appId,
          client_secret: config.meta.appSecret,
          fb_exchange_token: access_token
        }
      });
      finalToken = longLivedResponse.data.access_token;
      tokenType = 'long_lived';
      expiresIn = longLivedResponse.data.expires_in || 5184000;
    } catch (extendError) {
      // Si ya es long-lived, no se puede extender de nuevo — está bien
      logger.info('Token ya es de larga duración o no se pudo extender');
      if (tokenData.expires_at === 0) {
        tokenType = 'long_lived';
        expiresIn = Infinity;
      }
    }

    // 3. Obtener info del usuario
    const userResponse = await axios.get(`${META_GRAPH_URL}/me`, {
      params: { access_token: finalToken, fields: 'id,name' }
    });

    // 4. Obtener cuentas publicitarias
    const accountsResponse = await axios.get(`${META_GRAPH_URL}/me/adaccounts`, {
      params: {
        access_token: finalToken,
        fields: 'id,name,account_status,currency,timezone_name',
        limit: 50
      }
    });

    const accounts = (accountsResponse.data.data || []).map(acc => ({
      id: acc.id,
      name: acc.name,
      account_status: acc.account_status,
      currency: acc.currency,
      timezone_name: acc.timezone_name
    }));

    // 5. Desactivar tokens anteriores
    await MetaToken.updateMany({ is_active: true }, { is_active: false, connection_status: 'disconnected' });

    // 6. Guardar
    const expiresAt = new Date();
    if (expiresIn !== Infinity) {
      expiresAt.setSeconds(expiresAt.getSeconds() + expiresIn);
    }

    const defaultAccount = accounts.find(a => a.account_status === 1) || accounts[0];

    await MetaToken.create({
      access_token: finalToken,
      token_type: tokenType,
      expires_at: expiresIn === Infinity ? null : expiresAt,
      scopes: tokenData.scopes || [],
      meta_user_id: userResponse.data.id,
      meta_user_name: userResponse.data.name,
      ad_account_id: defaultAccount?.id || null,
      ad_account_name: defaultAccount?.name || null,
      ad_account_currency: defaultAccount?.currency || null,
      ad_account_timezone: defaultAccount?.timezone_name || null,
      available_accounts: accounts,
      is_active: true,
      last_verified: new Date(),
      last_refreshed: new Date(),
      connection_status: 'connected'
    });

    logger.info(`Token intercambiado manualmente — Usuario: ${userResponse.data.name}`);

    res.json({
      success: true,
      user: userResponse.data.name,
      accounts: accounts.length,
      token_type: tokenType,
      expires_in_days: expiresIn === Infinity ? 'No expira' : Math.floor(expiresIn / 86400),
      selected_account: defaultAccount?.name
    });
  } catch (error) {
    logger.error('Error intercambiando token:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.error?.message || error.message });
  }
});

// PUT /api/auth/meta/select-account — Seleccionar cuenta publicitaria
router.put('/select-account', async (req, res) => {
  try {
    const { ad_account_id } = req.body;
    const token = await MetaToken.findOne({ is_active: true });

    if (!token) {
      return res.status(404).json({ error: 'No hay conexión activa con Meta' });
    }

    const account = token.available_accounts.find(a => a.id === ad_account_id);
    if (!account) {
      return res.status(404).json({ error: 'Cuenta publicitaria no encontrada' });
    }

    token.ad_account_id = account.id;
    token.ad_account_name = account.name;
    token.ad_account_currency = account.currency;
    token.ad_account_timezone = account.timezone_name;
    token.updated_at = new Date();
    await token.save();

    logger.info(`Cuenta publicitaria seleccionada: ${account.name} (${account.id})`);

    res.json({
      success: true,
      ad_account_id: account.id,
      ad_account_name: account.name
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/meta/refresh — Renovar token manualmente
router.post('/refresh', async (req, res) => {
  try {
    const result = await refreshMetaToken();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/meta/disconnect — Desconectar Meta
router.post('/disconnect', async (req, res) => {
  try {
    await MetaToken.updateMany({ is_active: true }, {
      is_active: false,
      connection_status: 'disconnected',
      updated_at: new Date()
    });

    logger.info('Meta desconectado desde el dashboard');
    res.json({ success: true, message: 'Desconectado de Meta' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Función de renovación de token — usada por el cron job.
 */
async function refreshMetaToken() {
  const token = await MetaToken.findOne({ is_active: true });

  if (!token) {
    return { success: false, reason: 'No hay token activo' };
  }

  // Verificar si necesita renovación
  const daysLeft = token.expires_at
    ? Math.floor((token.expires_at - new Date()) / (1000 * 60 * 60 * 24))
    : Infinity;

  if (daysLeft > 10) {
    return { success: true, reason: `Token válido por ${daysLeft} días más, no necesita renovación` };
  }

  try {
    // Extender token
    const response = await axios.get(`${META_GRAPH_URL}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: config.meta.appId,
        client_secret: config.meta.appSecret,
        fb_exchange_token: token.access_token
      }
    });

    const newToken = response.data.access_token;
    const expiresIn = response.data.expires_in || 5184000;
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + expiresIn);

    token.access_token = newToken;
    token.expires_at = expiresAt;
    token.last_refreshed = new Date();
    token.updated_at = new Date();
    token.connection_status = 'connected';
    await token.save();

    const newDaysLeft = Math.floor(expiresIn / 86400);
    logger.info(`Token de Meta renovado exitosamente — ${newDaysLeft} días de validez`);

    return {
      success: true,
      reason: `Token renovado, válido por ${newDaysLeft} días`,
      expires_at: expiresAt
    };
  } catch (error) {
    logger.error('Error renovando token de Meta:', error.response?.data || error.message);

    token.connection_status = 'error';
    token.updated_at = new Date();
    await token.save();

    return {
      success: false,
      reason: error.response?.data?.error?.message || error.message
    };
  }
}

/**
 * Obtiene el token activo desde MongoDB.
 */
async function getActiveToken() {
  const token = await MetaToken.findOne({ is_active: true }).lean();
  return token;
}

module.exports = router;
module.exports.refreshMetaToken = refreshMetaToken;
module.exports.getActiveToken = getActiveToken;
