const mongoose = require('mongoose');

const systemConfigSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
  updated_at: { type: Date, default: Date.now },
  updated_by: { type: String, default: 'system' }
});

systemConfigSchema.statics.get = async function (key, defaultValue = null) {
  const doc = await this.findOne({ key }).lean();
  return doc ? doc.value : defaultValue;
};

systemConfigSchema.statics.set = async function (key, value, updatedBy = 'system') {
  return this.findOneAndUpdate(
    { key },
    { value, updated_at: new Date(), updated_by: updatedBy },
    { upsert: true, new: true }
  );
};

module.exports = mongoose.model('SystemConfig', systemConfigSchema);
