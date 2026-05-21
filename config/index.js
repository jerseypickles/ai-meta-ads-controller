require('dotenv').config({ override: true });

module.exports = {
  meta: {
    appId: process.env.META_APP_ID,
    appSecret: process.env.META_APP_SECRET,
    accessToken: process.env.META_ACCESS_TOKEN,
    adAccountId: process.env.META_AD_ACCOUNT_ID,
    // Migración 14-may-2026: v21.0 → v25.0 (email Meta: deprecation de versions
    // prior to v24.0 el 9-jun-2026, recomiendan v25.0 para minimizar migraciones).
    // gpt-image-2 + Advantage+ Standard Enhancements requieren v25.0+. Nuestros
    // endpoints (campaigns, adsets, ads, adcreatives, adimages, insights, search)
    // todos disponibles en v25.0 sin breaking changes para nuestros usos.
    apiVersion: process.env.META_API_VERSION || 'v25.0',
    baseUrl: `https://graph.facebook.com/${process.env.META_API_VERSION || 'v25.0'}`,
    pageId: process.env.META_PAGE_ID || '',
    pixelId: process.env.META_PIXEL_ID || '',
    defaultLinkUrl: process.env.META_DEFAULT_LINK_URL || '',
    // Prometheus Creative Testing Pipeline campaign ID. Si está vacío,
    // testing-agent.js:getTestingCampaignId() cae a SystemConfig y después
    // auto-crea la campaña. Declarado acá 2026-04-24 para trazabilidad —
    // antes se leía directo de process.env sin pasar por config (único env
    // var high-impact sin declarar).
    testingCampaignId: process.env.TESTING_CAMPAIGN_ID || '',
    rateLimit: {
      maxCalls: 200,
      perHour: 1,
      batchSize: 50
    },

    // Advantage+ Standard Enhancements — features que Meta aplica auto al
    // creative para mejorar performance (Marketing API v25.0+).
    //
    // Modo: 'off' | 'safe' | 'all'
    //   off  — no opt-in (estado actual, no cambia visuals de Apollo)
    //   safe — solo features que NO transforman la imagen original:
    //          text_optimizations, image_brightness_and_contrast,
    //          video_auto_crop, image_uncrop
    //   all  — opt-in global a standard_enhancements (incluye image_expansion,
    //          background_generation, 3d_animation, music — pueden distorsionar
    //          creatives de Apollo con estilo intencional ugly-ad/POV/etc)
    //
    // Default: 'off'. El user prende cuando quiera testear.
    advantagePlus: {
      mode: process.env.META_ADVANTAGE_PLUS_MODE || 'off'
    }
  },

  claude: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6-20250514',
    maxTokens: 4096
  },

  // ═══ Hermes — agente de foot traffic para tienda física NJ ═══
  // Tienda en 9 Romanelli Ave, South Hackensack NJ 07606. Maneja la campaña
  // local desde día 1 con modo manual_approval (usuario aprueba en dashboard).
  // Cuando esté validado, switch a HERMES_MODE=auto para autonomía completa.
  hermes: {
    enabled: process.env.HERMES_ENABLED === 'true',
    mode: process.env.HERMES_MODE || 'manual_approval', // manual_approval | auto
    warehouseAddress: process.env.HERMES_WAREHOUSE_ADDRESS || '9 Romanelli Ave, South Hackensack, NJ 07606',
    addressShort: process.env.HERMES_ADDRESS_SHORT || '9 Romanelli Ave · South Hackensack NJ',
    brandSince: process.env.HERMES_BRAND_SINCE || '2014',
    targetingRadiusMi: parseInt(process.env.HERMES_TARGETING_RADIUS_MI) || 10,
    // Page IDs Meta (necesarios para auto-publish en Fase 2 — pendiente de pasarlos)
    facebookPageUrl: process.env.HERMES_FACEBOOK_URL || 'https://www.facebook.com/picklesjersey',
    facebookPageId: process.env.HERMES_FACEBOOK_PAGE_ID || '',
    instagramUrl: process.env.HERMES_INSTAGRAM_URL || 'https://www.instagram.com/jerseypickles/',
    instagramId: process.env.HERMES_INSTAGRAM_ID || '',
    // Google Maps CTA — destination del Get Directions
    googleMapsUrl: process.env.HERMES_GOOGLE_MAPS_URL || 'https://maps.google.com/?q=9+Romanelli+Ave,+South+Hackensack+NJ+07606',
    // Budget caps (solo aplican cuando mode=auto en Fase 2+)
    initialDailyBudget: parseInt(process.env.HERMES_INITIAL_BUDGET) || 45,
    maxDailyBudget: parseInt(process.env.HERMES_MAX_DAILY_BUDGET) || 100,
    minDailyBudget: parseInt(process.env.HERMES_MIN_DAILY_BUDGET) || 20,
    // Operacional
    maxActiveAds: parseInt(process.env.HERMES_MAX_ACTIVE_ADS) || 5,
    proposalExpiryHours: parseInt(process.env.HERMES_PROPOSAL_EXPIRY_HOURS) || 72,
    // Comment Intelligence — auto-reply OFF por default (shadow→live).
    // Con OFF, incluso respuestas high-confidence van a cola de aprobación
    // manual. Activar (=true) solo tras validar la calidad de las respuestas.
    commentAutoReply: process.env.HERMES_COMMENT_AUTOREPLY === 'true'
  },

  googleAI: {
    apiKey: process.env.GOOGLE_AI_API_KEY || ''
  },

  // Shopify Admin API — usado por Demeter para reconciliación cash vs Meta ROAS.
  // Domain debe ser el .myshopify.com (no el dominio público).
  shopify: {
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN || '',
    adminToken: process.env.SHOPIFY_ADMIN_TOKEN || '',
    apiVersion: process.env.SHOPIFY_API_VERSION || '2025-01',
    // Shopify Payments standard fees (US). Si tu plan es distinto, override.
    feePercent: parseFloat(process.env.SHOPIFY_FEE_PERCENT) || 0.029,
    feeFlat: parseFloat(process.env.SHOPIFY_FEE_FLAT) || 0.30
  },

  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/ai-meta-ads'
  },

  dashboard: {
    port: parseInt(process.env.DASHBOARD_PORT) || 3500,
    secret: process.env.DASHBOARD_SECRET || 'dev-secret-change-me',
    user: process.env.DASHBOARD_USER || 'admin',
    password: process.env.DASHBOARD_PASSWORD || 'admin'
  },

  imageGen: {
    // Motor de generación de imágenes de Apollo. 'gemini' | 'gpt-image-2'.
    // Default 'gemini' (histórico). Setear APOLLO_IMAGE_ENGINE=gpt-image-2 en
    // Render para que Apollo genere con OpenAI gpt-image-2 (usa OPENAI_API_KEY,
    // que ya está configurada — la misma que usa Hermes).
    apolloEngine: process.env.APOLLO_IMAGE_ENGINE || 'gemini',
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      model: 'gpt-image-1.5'
    },
    flux: {
      apiKey: process.env.BFL_API_KEY,
      model: 'flux-2-pro',
      baseUrl: 'https://api.bfl.ai'
    },
    seedream: {
      apiKey: process.env.FREEPIK_API_KEY,
      model: 'seedream-v4-5-edit',
      baseUrl: 'https://api.freepik.com'
    },
    formats: {
      feed: { width: 1080, height: 1080, label: 'Feed 1:1', aspectRatio: '1:1', fluxWidth: 1024, fluxHeight: 1024, seedreamAspect: 'square_1_1' },
      stories: { width: 1080, height: 1920, label: 'Stories/Reels 9:16', aspectRatio: '9:16', fluxWidth: 1024, fluxHeight: 1792, seedreamAspect: 'social_story_9_16' }
    }
  },

  xai: {
    apiKey: process.env.XAI_API_KEY || '',
    baseUrl: 'https://api.x.ai/v1',
    imageModel: 'grok-imagine-image',
    videoModel: 'grok-imagine-video'
  },

  fal: {
    apiKey: process.env.FAL_KEY || ''
  },

  search: {
    braveApiKey: process.env.BRAVE_SEARCH_API_KEY || '',
    serpApiKey: process.env.SERP_API_KEY || ''
  },

  system: {
    env: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',
    timezone: process.env.TIMEZONE || 'America/New_York',
    decisionEngineMode: process.env.DECISION_ENGINE_MODE || 'unified_shadow',
    uploadsDir: process.env.UPLOADS_DIR || require('path').join(__dirname, '../uploads')
  }
};
