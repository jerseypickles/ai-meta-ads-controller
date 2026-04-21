/**
 * Seasonal Calendar — resuelve fechas de eventos (fixed/computed) y
 * encuentra los próximos N días para inyectarlos en el contexto de Zeus.
 *
 * Awareness-only. Sin auto-directivas. El creador decide cuándo activar.
 */

const SeasonalEvent = require('../../db/models/SeasonalEvent');

/**
 * Helpers para fechas computed.
 * Cada rule retorna la fecha del evento para un año específico.
 */
const RULES = {
  // Black Friday — último viernes de noviembre (después de Thanksgiving)
  last_friday_november: (year) => {
    const d = new Date(Date.UTC(year, 10, 30)); // nov 30
    while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() - 1);
    return d;
  },
  // Cyber Monday — lunes después de Black Friday
  cyber_monday: (year) => {
    const bf = RULES.last_friday_november(year);
    return new Date(Date.UTC(year, bf.getUTCMonth(), bf.getUTCDate() + 3));
  },
  // Thanksgiving US — 4to jueves de noviembre
  fourth_thursday_november: (year) => {
    const d = new Date(Date.UTC(year, 10, 1));
    let thursdays = 0;
    while (thursdays < 4) {
      if (d.getUTCDay() === 4) thursdays++;
      if (thursdays < 4) d.setUTCDate(d.getUTCDate() + 1);
    }
    return d;
  },
  // Memorial Day — último lunes de mayo
  last_monday_may: (year) => {
    const d = new Date(Date.UTC(year, 4, 31));
    while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() - 1);
    return d;
  },
  // Labor Day US — 1er lunes de septiembre
  first_monday_september: (year) => {
    const d = new Date(Date.UTC(year, 8, 1));
    while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  },
  // Super Bowl — 2do domingo de febrero
  second_sunday_february: (year) => {
    const d = new Date(Date.UTC(year, 1, 1));
    let sundays = 0;
    while (sundays < 2) {
      if (d.getUTCDay() === 0) sundays++;
      if (sundays < 2) d.setUTCDate(d.getUTCDate() + 1);
    }
    return d;
  },
  // Mother's Day US — 2do domingo de mayo
  second_sunday_may: (year) => {
    const d = new Date(Date.UTC(year, 4, 1));
    let sundays = 0;
    while (sundays < 2) {
      if (d.getUTCDay() === 0) sundays++;
      if (sundays < 2) d.setUTCDate(d.getUTCDate() + 1);
    }
    return d;
  },
  // Father's Day US — 3er domingo de junio
  third_sunday_june: (year) => {
    const d = new Date(Date.UTC(year, 5, 1));
    let sundays = 0;
    while (sundays < 3) {
      if (d.getUTCDay() === 0) sundays++;
      if (sundays < 3) d.setUTCDate(d.getUTCDate() + 1);
    }
    return d;
  }
};

/**
 * Resuelve la fecha del evento para un año específico.
 */
function resolveEventDate(event, year) {
  if (event.date_type === 'fixed') {
    if (!event.month || !event.day) return null;
    return new Date(Date.UTC(year, event.month - 1, event.day));
  }
  if (event.date_type === 'computed') {
    const fn = RULES[event.rule];
    if (!fn) return null;
    return fn(year);
  }
  return null;
}

/**
 * Para cada evento activado, computa la ocurrencia más próxima dentro del rango.
 * rangeDays: ventana futura (default 90)
 * Retorna array ordenado por fecha: { event, date, days_away, phase }
 */
async function getUpcomingEvents(rangeDays = 60) {
  const now = Date.now();
  const events = await SeasonalEvent.find({ activated: true }).lean();
  const year = new Date().getUTCFullYear();

  const upcoming = [];
  for (const ev of events) {
    // Probar este año y siguiente (por si ya pasó)
    for (const testYear of [year, year + 1]) {
      const date = resolveEventDate(ev, testYear);
      if (!date) continue;
      const daysAway = Math.round((date.getTime() - now) / 86400000);

      // Considerar también eventos pasados en los últimos cool_down_days
      const inWindow = daysAway >= -(ev.cool_down_days || 3) && daysAway <= rangeDays;
      if (!inWindow) continue;

      // Phase actual
      let phase = 'future';
      if (daysAway < -0) phase = 'cool_down';
      else if (daysAway === 0) phase = 'peak';
      else if (daysAway > 0 && daysAway <= (ev.peak_days || 1) - 1) phase = 'peak';
      else if (daysAway <= (ev.anticipation_days || 14)) phase = 'anticipation';
      else phase = 'future';

      upcoming.push({
        name: ev.name,
        description: ev.description,
        category: ev.category,
        priority: ev.priority,
        date: date.toISOString().substring(0, 10),
        days_away: daysAway,
        phase,
        anticipation_days: ev.anticipation_days,
        peak_days: ev.peak_days,
        cool_down_days: ev.cool_down_days,
        messaging_theme: ev.messaging_theme,
        target_audience_hint: ev.target_audience_hint
      });
      break; // solo la próxima ocurrencia
    }
  }

  upcoming.sort((a, b) => a.days_away - b.days_away);
  return upcoming;
}

module.exports = { resolveEventDate, getUpcomingEvents, RULES };
