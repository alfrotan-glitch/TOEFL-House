import type Database from 'better-sqlite3';
import { id as makeId } from '../../utils/ids.js';

/**
 * Ensures every program has at least one published version.
 * Attaches unversioned levels to this new default version.
 * Runs atomically at startup.
 */
export function bootstrapAcademicCatalog(db: Database.Database): void {
  // Pre-compiled statements inside the function scope to have access to `db`
  const stmtGetAllPrograms = db.prepare('SELECT id, name, description, duration_months FROM programs');
  const stmtGetExistingVersion = db.prepare('SELECT id FROM program_versions WHERE program_id = ? LIMIT 1');
  const stmtInsertDefaultVersion = db.prepare(
    `INSERT INTO program_versions (id, program_id, version_label, version_number, status, duration_months, description, is_default, published_at, effective_from, created_at)
     VALUES (?, ?, 'v1', 1, 'published', ?, ?, 1, datetime('now'), date('now'), datetime('now'))`
  );
  const stmtUpdateUnversionedLevels = db.prepare(
    `UPDATE levels SET program_version_id = ? WHERE program_id = ? AND (program_version_id IS NULL OR program_version_id = '')`
  );

  const programs = stmtGetAllPrograms.all() as any[];
  if (programs.length === 0) return;

  const bootstrapTx = db.transaction(() => {
    for (const p of programs) {
      const existing = stmtGetExistingVersion.get(p.id);
      if (existing) continue;

      const versionId = makeId('pv');
      
      stmtInsertDefaultVersion.run(
        versionId, 
        p.id, 
        p.duration_months || 0, 
        p.description || null
      );

      // Attach unversioned levels to this new default version
      stmtUpdateUnversionedLevels.run(versionId, p.id);
    }
  });

  bootstrapTx();
}