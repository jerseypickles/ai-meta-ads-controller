/**
 * Seed del calendario estacional para Jersey Pickles.
 * Idempotente — upsert por name.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const SeasonalEvent = require('../src/db/models/SeasonalEvent');

const SEED = [
  // CRITICAL — El día de la marca
  {
    name: 'National Pickle Day',
    description: 'Día nacional del pickle. Tu evento más relevante — storytelling de marca, FOMO máximo, contenido tematizado.',
    date_type: 'fixed', month: 11, day: 14,
    category: 'niche_holiday', priority: 'critical',
    anticipation_days: 21, peak_days: 1, cool_down_days: 5,
    messaging_theme: 'Storytelling de marca, origen del pickle, celebración, comunidad pickle lovers',
    target_audience_hint: 'Base fiel + expansión a foodies + regalos temáticos'
  },

  // CRITICAL — El retail moment
  {
    name: 'Black Friday',
    description: 'Peak de shopping anual. Bundles/gift sets, discount messaging, CPM más caro pero conversion más alta.',
    date_type: 'computed', rule: 'last_friday_november',
    category: 'retail_sales', priority: 'critical',
    anticipation_days: 21, peak_days: 4, cool_down_days: 3,
    messaging_theme: 'Gift sets, charcuterie bundles, discounts, deal urgency',
    target_audience_hint: 'Gift-buyers + regulares + expansión cold hacia foodie gifting'
  },
  {
    name: 'Cyber Monday',
    description: 'Continuación del weekend de Black Friday. Conviene unificar strategy.',
    date_type: 'computed', rule: 'cyber_monday',
    category: 'retail_sales', priority: 'critical',
    anticipation_days: 14, peak_days: 1, cool_down_days: 2,
    messaging_theme: 'Online exclusive, última oportunidad del weekend'
  },

  // HIGH — Q4 shopping holidays
  {
    name: 'Thanksgiving',
    description: 'Sides, pickle trays, charcuterie para la mesa. Mid-funnel, no descuento agresivo.',
    date_type: 'computed', rule: 'fourth_thursday_november',
    category: 'national_holiday', priority: 'high',
    anticipation_days: 14, peak_days: 1, cool_down_days: 2,
    messaging_theme: 'Sides de Thanksgiving, pickle tray, acompañamientos, mesa familiar'
  },
  {
    name: 'Christmas',
    description: 'Gift sets, charcuterie boards, regalos especiales.',
    date_type: 'fixed', month: 12, day: 25,
    category: 'national_holiday', priority: 'high',
    anticipation_days: 21, peak_days: 3, cool_down_days: 3,
    messaging_theme: 'Gift sets premium, charcuterie para las fiestas'
  },

  // HIGH — Summer BBQ season
  {
    name: 'Memorial Day',
    description: 'Apertura de la temporada BBQ. Pickles como acompañamiento esencial.',
    date_type: 'computed', rule: 'last_monday_may',
    category: 'national_holiday', priority: 'high',
    anticipation_days: 14, peak_days: 3, cool_down_days: 2,
    messaging_theme: 'BBQ season opener, summer grilling, outdoor food',
    target_audience_hint: 'BBQ/grill enthusiasts, summer hosts'
  },
  {
    name: 'Fourth of July',
    description: 'Peak del BBQ season. Tradicional americano.',
    date_type: 'fixed', month: 7, day: 4,
    category: 'national_holiday', priority: 'high',
    anticipation_days: 14, peak_days: 3, cool_down_days: 2,
    messaging_theme: 'All-American BBQ, fireworks party food, red-white-blue',
    target_audience_hint: 'Family hosts, BBQ enthusiasts, traditional American'
  },

  // HIGH — Game day
  {
    name: 'Super Bowl',
    description: 'Party snacks, game day bundles. Momento pico para charcuterie y picadas.',
    date_type: 'computed', rule: 'second_sunday_february',
    category: 'cultural', priority: 'high',
    anticipation_days: 14, peak_days: 1, cool_down_days: 2,
    messaging_theme: 'Game day snacks, party bundles, charcuterie, finger food',
    target_audience_hint: 'Sports viewing hosts, party planners'
  },

  // MEDIUM — End of summer + fall
  {
    name: 'Labor Day',
    description: 'Cierre del summer BBQ season. Last-call angle.',
    date_type: 'computed', rule: 'first_monday_september',
    category: 'national_holiday', priority: 'medium',
    anticipation_days: 10, peak_days: 2, cool_down_days: 2,
    messaging_theme: 'Last summer BBQ, end-of-season celebration'
  },

  // MEDIUM — Q1 / Q2
  {
    name: 'Valentine\'s Day',
    description: 'Angle inusual: "gift for the foodie you love". Charcuterie boards.',
    date_type: 'fixed', month: 2, day: 14,
    category: 'cultural', priority: 'medium',
    anticipation_days: 14, peak_days: 1, cool_down_days: 1,
    messaging_theme: 'Unusual gift, foodie love, charcuterie date night'
  },
  {
    name: 'Mother\'s Day',
    description: 'Gift angle — pickle gift sets premium.',
    date_type: 'computed', rule: 'second_sunday_may',
    category: 'national_holiday', priority: 'medium',
    anticipation_days: 14, peak_days: 1, cool_down_days: 1,
    messaging_theme: 'Unusual gift for mom, premium foodie gift sets'
  },
  {
    name: 'Father\'s Day',
    description: 'Gift angle — "for the dad who has everything". BBQ/grill.',
    date_type: 'computed', rule: 'third_sunday_june',
    category: 'national_holiday', priority: 'medium',
    anticipation_days: 14, peak_days: 1, cool_down_days: 1,
    messaging_theme: 'Gift for dad, BBQ enthusiast, grill accessories'
  },

  // LOW — nice-to-have
  {
    name: 'St. Patrick\'s Day',
    description: 'Angle débil — pickled foods association con cocina irlandesa.',
    date_type: 'fixed', month: 3, day: 17,
    category: 'cultural', priority: 'low',
    anticipation_days: 10, peak_days: 1, cool_down_days: 1,
    messaging_theme: 'Irish cuisine association, pickled everything'
  }
];

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI requerido');
    process.exit(1);
  }
  await mongoose.connect(uri);

  let upserted = 0;
  for (const item of SEED) {
    const existing = await SeasonalEvent.findOne({ name: item.name });
    if (existing) {
      Object.assign(existing, item);
      existing.updated_at = new Date();
      await existing.save();
    } else {
      await SeasonalEvent.create({ ...item, source: 'system_seed' });
    }
    upserted++;
  }

  console.log(`✓ ${upserted} eventos estacionales seed/upsert`);
  await mongoose.disconnect();
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { SEED };
