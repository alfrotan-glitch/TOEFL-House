import { randomUUID } from 'node:crypto';

/** Generates a namespaced unique id, e.g. id('stu') -> 'stu_3f9a...' */
export function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/** Returns today's date in YYYY-MM-DD format based on LOCAL server time. */
export function today(): string {
  // 'en-CA' locale reliably outputs ISO 8601 (YYYY-MM-DD) based on local time.
  return new Date().toLocaleDateString('en-CA');
}

/** Returns current time in Persian (Farsi) format. */
export function nowTimeFa(): string {
  return new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
}