import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const schemaPath = path.join(serverRoot, 'src', 'db', 'schema.sql');

const db = new Database(':memory:');
try {
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  const badIndexes = [];
  const indexes = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all();
  for (const index of indexes) {
    const indexColumns = db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all().map(row => row.name);
    const tableColumns = new Set(db.prepare(`PRAGMA table_info(${JSON.stringify(index.tbl_name)})`).all().map(row => row.name));
    for (const column of indexColumns) {
      if (!tableColumns.has(column)) badIndexes.push(`${index.tbl_name}.${column} via ${index.name}`);
    }
  }
  if (badIndexes.length) throw new Error(`Invalid schema indexes: ${badIndexes.join(', ')}`);
  db.pragma('integrity_check');
  console.log('[SUCCESS] Fresh schema preflight passed.');
} finally {
  db.close();
}
