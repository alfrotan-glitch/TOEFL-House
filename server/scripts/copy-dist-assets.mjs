/**
 * Copies runtime assets that tsc does not emit into dist/ so the production
 * entry point (`npm start` → node dist/index.js) can bootstrap the database.
 *
 * tsc only compiles TypeScript; schema.sql is read at runtime via an
 * import.meta.url-relative path (src/db/connection.ts), so without this copy
 * step a production build crashes on startup with
 * "schema.sql not found at dist/db/schema.sql".
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, '..');
const srcDb = resolve(serverDir, 'src/db');
const distDb = resolve(serverDir, 'dist/db');

if (!existsSync(srcDb)) {
  throw new Error(`Expected source db directory not found: ${srcDb}`);
}

mkdirSync(distDb, { recursive: true });

cpSync(resolve(srcDb, 'schema.sql'), resolve(distDb, 'schema.sql'));

console.log('✅ Copied schema.sql into dist/db');
