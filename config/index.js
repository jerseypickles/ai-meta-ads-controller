require('dotenv').config({ override: true });

module.exports = {
  meta: {
    appId: process.env.META_APP_ID,
    appSecret: process.env.META_APP_SECRET,
    accessToken: process.env.META_ACCESS_TOKEN,
    adAccountId: process.env.META_AD_ACCOUNT_ID,
    apiVersion: process.env.META_API_VERSION || 'v21.0',
    baseUrl: `https://graph.facebook.com/${process.env.META_API_VERSION || 'v21.0'}`,
    pageId: process.env.META_PAGE_ID || '',
    pixelId: process.env.META_PIXEL_ID || '',
    defaultLinkUrl: process.env.META_DEFAULT_LINK_URL || '',
    rateLimit: {
      maxCalls: 200,
      perHour: 1,
      batchSize: 50
    }
  },

  claude: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929',
    maxTokens: 4096
  },

  googleAI: {
    apiKey: process.env.GOOGLE_AI_API_KEY || ''
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
