const mongoose = require('mongoose');

const researchCacheSchema = new mongoose.Schema({
  query: { type: String, required: true, index: true },
  category: {
    type: String,
    enum: ['platform_updates', 'best_practices', 'industry_trends', 'problem_specific', 'seasonal'],
    default: 'best_practices'
  },
  results: [{
    title: { type: String },
    url: { type: String },
    snippet: { type: String }
  }],
  summary: { type: String },
  expires_at: { type: Date, required: true, index: true }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// Auto-expire documents
researchCacheSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

/**
 * Find cached result that hasn't expired.
 */
researchCacheSchema.statics.findCached = async function (query) {
  return this.findOne({ query, expires_at: { $gt: new Date() } }).lean();
};

/**
 * Store research result with TTL.
 */
researchCacheSchema.statics.store = async function (query, category, results, summary, ttlHours = 24) {
  const expires_at = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  return this.findOneAndUpdate(
    { query },
    { query, category, results, summary, expires_at },
    { upsert: true, new: true }
  );
};

module.exports = mongoose.model('ResearchCache', researchCacheSchema);
