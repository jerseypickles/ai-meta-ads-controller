/**
 * Formatea un número como moneda USD.
 */
function formatCurrency(value) {
  if (value == null || isNaN(value)) return '$0.00';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2
  }).format(value);
}

/**
 * Formatea un número como porcentaje.
 */
function formatPercent(value, decimals = 1) {
  if (value == null || isNaN(value)) return '0%';
  return `${(value * 100).toFixed(decimals)}%`;
}

/**
 * Formatea ROAS como multiplicador.
 */
function formatROAS(value) {
  if (value == null || isNaN(value)) return '0.00x';
  return `${Number(value).toFixed(2)}x`;
}

/**
 * Convierte centavos de Meta API a dólares.
 */
function centsToDollars(cents) {
  return Number(cents) / 100;
}

/**
 * Convierte dólares a centavos para Meta API.
 */
function dollarsToCents(dollars) {
  return Math.round(Number(dollars) * 100);
}

/**
 * Formatea una fecha para la API de Meta (YYYY-MM-DD).
 */
function formatDateForMeta(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().split('T')[0];
}

/**
 * Calcula el porcentaje de cambio entre dos valores.
 */
function percentChange(oldValue, newValue) {
  if (!oldValue || oldValue === 0) return 0;
  return ((newValue - oldValue) / oldValue) * 100;
}

/**
 * Trunca un string a un largo máximo.
 */
function truncate(str, maxLength = 50) {
  if (!str) return '';
  return str.length > maxLength ? str.substring(0, maxLength) + '...' : str;
}

module.exports = {
  formatCurrency,
  formatPercent,
  formatROAS,
  centsToDollars,
  dollarsToCents,
  formatDateForMeta,
  percentChange,
  truncate
};
