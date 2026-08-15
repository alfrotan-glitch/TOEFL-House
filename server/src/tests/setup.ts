process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-jwt-secret-please-do-not-use-in-production-123456';
/**
Global test setup: points DB_PATH at a throwaway SQLite file
so tests never touch the real database.
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.join(__dirname, 'test.sqlite');

// Clean up any leftover test database from a previous run.
// Wrapped in try-catch because on Windows the file may still be
// locked by a previous process for a brief moment.
try {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = testDbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
} catch {
  // Ignore — the DB will be recreated by initSchema() anyway.
}

// Must be set BEFORE any module imports db/connection.js
process.env.DB_PATH = testDbPath;