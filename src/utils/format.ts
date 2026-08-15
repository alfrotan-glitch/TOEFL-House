/** Formats an amount as Afghani currency with Latin numerals, e.g. "125,000 AFN". */
export function formatAFN(amount: number): string {
  if (amount == null || Number.isNaN(Number(amount))) return '0 AFN';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(amount)) + ' AFN';
}