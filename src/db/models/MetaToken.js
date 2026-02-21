const mongoose = require('mongoose');

const metaTokenSchema = new mongoose.Schema({
  // Token de acceso
  access_token: { type: String, required: true },
  token_type: { type: String, enum: ['short_lived', 'long_lived'], default: 'short_lived' },
  expires_at: { type: Date },
  scopes: [{ type: String }],

  // Info del usuario de Meta
  meta_user_id: { type: String },
  meta_user_name: { type: String },

  // Cuenta publicitaria seleccionada
  ad_account_id: { type: String },
  ad_account_name: { type: String },
  ad_account_currency: { type: String },
  ad_account_timezone: { type: String },

  // Todas las cuentas disponibles (para selección)
  available_accounts: [{
    id: String,
    name: String,
    account_status: Number,
    currency: String,
    timezone_name: String
  }],

  // Estado
  is_active: { type: Boolean, default: true },
  last_verified: { type: Date },
  last_refreshed: { type: Date },
  connection_status: {
    type: String,
    enum: ['connected', 'expired', 'error', 'disconnected'],
    default: 'connected'
  },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

// Solo un token activo a la vez
metaTokenSchema.index({ is_active: 1 });

// Método para verificar si el token está por expirar
metaTokenSchema.methods.isExpiringSoon = function(daysThreshold = 7) {
  if (!this.expires_at) return false;
  const daysLeft = (this.expires_at - new Date()) / (1000 * 60 * 60 * 24);
  return daysLeft < daysThreshold;
};

metaTokenSchema.methods.daysUntilExpiry = function() {
  if (!this.expires_at) return Infinity;
  return Math.floor((this.expires_at - new Date()) / (1000 * 60 * 60 * 24));
};

module.exports = mongoose.model('MetaToken', metaTokenSchema);
