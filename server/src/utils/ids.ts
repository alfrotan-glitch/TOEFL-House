import { randomUUID } from 'node:crypto';

/** Generates a namespaced unique id, e.g. id('stu') -> 'stu_3f9a...' */
export function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/** Adds days to a YYYY-MM-DD date, purely in UTC.
 *
 * `new Date(str)` + `setDate` + `toISOString` mixes clocks: the parse is UTC,
 * the arithmetic is LOCAL, the render is UTC again, so the answer depends on
 * the server's offset (a negative offset can move the result back a day).
 * Business date math must be deterministic everywhere: parse UTC, add UTC,
 * render UTC.
 */
export function addDaysISO(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`addDaysISO: invalid date "${dateStr}".`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Returns today's date in YYYY-MM-DD format based on LOCAL server time. */
export function today(): string {
  // 'en-CA' locale reliably outputs ISO 8601 (YYYY-MM-DD). The TIMEZONE is
  // pinned to the business calendar (Asia/Kabul, UTC+4:30, no DST) rather
  // than left to the server's local setting: under a UTC server, every
  // Kabul date between 00:00 and 04:29 was booked to the PREVIOUS business
  // day — crossing month boundaries at month start (a fee paid 00:15 Kabul
  // on Sep 1 landed in August's P&L). Forensic wave 6 finding W6-2.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kabul' });
}

/** Returns current time in Persian (Farsi) format. */
export function nowTimeFa(): string {
  return new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
}