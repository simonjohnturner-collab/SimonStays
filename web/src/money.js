// Rand ⇄ cents helpers. Amounts are stored as integer cents.
export function fmtR(cents) {
  const v = Number(cents || 0) / 100;
  const neg = v < 0;
  const [int, dec] = Math.abs(v).toFixed(2).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${neg ? '-' : ''}R ${grouped}.${dec}`;
}
export function randToCents(v) {
  if (v === '' || v == null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : Math.round(n * 100);
}
export function centsToRand(cents) { return Number(cents || 0) / 100; }
