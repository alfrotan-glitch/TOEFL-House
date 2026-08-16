import { db } from '../db/connection.js';

// ── Performance: Module-level Prepared Statements ──────────────────────────
const stmtGetSetting = db.prepare('SELECT value FROM system_settings WHERE key = ?');
const stmtUpsertSetting = db.prepare(
  `INSERT INTO system_settings (key, value) VALUES (?, ?) 
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);

/**
 * CRITICAL FIX: Atomic increment using UPSERT.
 * This prevents race conditions (Read-Modify-Write) under concurrent requests or multi-threading.
 */
const stmtAtomicIncrement = db.prepare(
  `INSERT INTO system_settings (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + ?
   RETURNING value`
);

function getSetting(key: string, fallback: string): string {
  const row = stmtGetSetting.get(key) as { value: string } | undefined;
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string): void {
  stmtUpsertSetting.run(key, value);
}

export function getNumberSetting(key: string, fallback: number): number {
  const val = getSetting(key, String(fallback));
  const num = Number(val);
  return isNaN(num) ? fallback : num;
}

/**
 * Atomically increments a numeric setting.
 * Safe under concurrent access.
 */

export function incrementNumberSetting(key: string, delta: number, fallback = 0): number {
  // If the key doesn't exist, it inserts with (fallback + delta).
  // If it exists, it adds delta to the current value and returns the new value.
  const initialValue = fallback + delta;
  
  const result = stmtAtomicIncrement.get(key, initialValue, delta) as { value: string } | undefined;
  
  // Convert to number and validate
  const newVal = Number(result?.value);
  return isNaN(newVal) ? initialValue : newVal;
}