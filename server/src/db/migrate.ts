/**
 * TOEFL House ERP — SQLite Migration Runner (Production Grade)
 *
 * Migrations are numbered .sql files in db/migrations/.
 * Applied in lexical order, recorded in schema_migrations.
 *
 * Execution rules:
 *   - schema.sql must already have been applied (CREATE TABLE IF NOT EXISTS).
 *   - Each migration file is split into individual statements and executed.
 *   - Transaction control statements (BEGIN/COMMIT) inside .sql files are 
 *     safely ignored because the runner wraps the whole file in an atomic transaction.
 *   - Only a proven duplicate ADD COLUMN whose target column already exists is treated as idempotently satisfied.
 *     Broad 'already exists' errors are never swallowed because they can hide schema drift.
 */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function isSafeExistingColumnError(db: Database.Database, statement: string, message: string): boolean {
  if (!/duplicate column name/i.test(message)) return false;
  const match = /^\s*ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)\b/i.exec(statement.trim());
  if (!match) return false;
  const [, table, column] = match;
  const safeTable = table.replace(/[^A-Za-z0-9_]/g, '');
  const columns = db.prepare(`PRAGMA table_info(${safeTable})`).all() as Array<{ name: string }>;
  return columns.some((c) => c.name === column);
}

function isSafeIdempotentError(db: Database.Database, statement: string, message: string): boolean {
  return isSafeExistingColumnError(db, statement, message);
}

// Regex to detect explicit transaction control commands that might exist in .sql files
// We must ignore these because better-sqlite3 handles the transaction wrapper automatically.
const TRANSACTION_CONTROL_PATTERN = /^\s*(BEGIN|COMMIT|END|ROLLBACK)(\s+TRANSACTION)?\s*$/i;

/**
 * Split a SQL file into executable statements safely.
 * Ignores semicolons inside string literals (single or double quotes).
 * Removes comments and ignores explicit transaction control commands.
 */
function splitStatements(sql: string): string[] {
  const withoutBlockComments = sql.replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = withoutBlockComments.split(/\r?\n/);

  const statements: string[] = [];
  let currentStatement = '';
  let inString = false;
  let stringChar = '';
  let triggerBody = false;
  let triggerBeginSeen = false;
  let triggerEndSeen = false;

  for (const line of lines) {
    let i = 0;
    while (i < line.length) {
      const char = line[i];

      if (inString) {
        currentStatement += char;
        if (char === stringChar && line[i + 1] === stringChar) {
          currentStatement += line[i + 1];
          i++;
        } else if (char === stringChar) {
          inString = false;
        }
      } else {
        if (char === '-' && line[i + 1] === '-') {
          break;
        } else if (char === "'" || char === '"') {
          inString = true;
          stringChar = char;
          currentStatement += char;
        } else if (char === ';') {
          // CREATE TRIGGER bodies contain their own semicolons. The migration
          // splitter must not break on those internal statements; only the
          // semicolon terminating END closes the trigger statement.
          if (triggerBody && triggerBeginSeen && !triggerEndSeen) {
            currentStatement += char;
          } else {
            const stmt = currentStatement.trim();
            if (stmt.length > 0 && !TRANSACTION_CONTROL_PATTERN.test(stmt)) {
              statements.push(stmt);
            }
            currentStatement = '';
            triggerBody = false;
            triggerBeginSeen = false;
            triggerEndSeen = false;
          }
        } else {
          currentStatement += char;
          const normalized = currentStatement.toUpperCase();
          if (!triggerBody && /^CREATE\s+(TEMP\s+)?TRIGGER\b/.test(normalized.trim())) {
            triggerBody = true;
          }
          if (triggerBody && /\bBEGIN\b/.test(normalized)) triggerBeginSeen = true;
          if (triggerBody && triggerBeginSeen && /\bEND\s*$/.test(normalized.trim())) triggerEndSeen = true;
        }
      }
      i++;
    }
    if (currentStatement.length > 0 && !currentStatement.endsWith('\n')) {
      currentStatement += '\n';
    }
  }

  const lastStmt = currentStatement.trim();
  if (lastStmt.length > 0 && !TRANSACTION_CONTROL_PATTERN.test(lastStmt)) {
    statements.push(lastStmt);
  }

  return statements;
}


function tableColumns(db: Database.Database, table: string): string[] {
  const safe = table.replace(/[^A-Za-z0-9_]/g, '');
  return (db.prepare(`PRAGMA table_info(${safe})`).all() as Array<{ name: string }>).map((r) => r.name);
}

function visitorStageCheckContainsExpandedStages(db: Database.Database): boolean {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'visitors'`).get() as { sql?: string } | undefined;
  const sql = row?.sql || '';
  return ['placement_fee', 'card_issued', 'book_issued'].every((stage) => sql.includes(`'${stage}'`));
}

/**
 * Migration 026 originally rebuilt visitors with SELECT *. That is unsafe when
 * the live database has acquired columns not present in the historical migration.
 * If a legacy database genuinely lacks the expanded stage CHECK, rebuild using
 * the intersection of source/target columns so unknown newer columns are never
 * shifted positionally or accidentally mapped to the wrong field.
 */
function upgradeLegacyVisitorStageConstraint(db: Database.Database): void {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='visitors'`).get()) return;
  if (visitorStageCheckContainsExpandedStages(db)) return;

  const sourceColumns = tableColumns(db, 'visitors');
  const targetColumns = [
    'id','serial_no','full_name','phone','email','gender','source','campaign_id',
    'stage','assigned_to','visit_date','status','notes','branch_id','interested_course',
    'follow_up_status','next_contact_date','father_name','address_region','tazkira_no',
    'whatsapp','dob','school_or_university','emergency_contact_name',
    'emergency_contact_phone','placement_score','created_at'
  ];
  const copyColumns = targetColumns.filter((c) => sourceColumns.includes(c));
  if (!copyColumns.includes('id') || !copyColumns.includes('full_name') || !copyColumns.includes('branch_id')) {
    throw new Error('Cannot safely upgrade legacy visitors table: required columns are missing.');
  }

  db.exec(`DROP TABLE IF EXISTS visitors_new`);
  db.exec(`CREATE TABLE visitors_new (
    id TEXT PRIMARY KEY, serial_no TEXT, full_name TEXT NOT NULL, phone TEXT, email TEXT,
    gender TEXT NOT NULL, source TEXT NOT NULL, campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
    stage TEXT DEFAULT 'lead' CHECK (stage IN (
      'lead','inquiry','follow_up','placement_booking','placement_fee','placement_completed',
      'class_fee','card_issued','book_issued','registration','enrollment','active','graduated','alumni','lost'
    )),
    assigned_to TEXT, visit_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'visited', notes TEXT,
    branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, interested_course TEXT,
    follow_up_status TEXT, next_contact_date TEXT, father_name TEXT, address_region TEXT, tazkira_no TEXT,
    whatsapp TEXT, dob TEXT, school_or_university TEXT, emergency_contact_name TEXT,
    emergency_contact_phone TEXT, placement_score TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const columns = copyColumns.join(', ');
  db.exec(`INSERT INTO visitors_new (${columns}) SELECT ${columns} FROM visitors`);
  db.exec(`DROP TABLE visitors`);
  db.exec(`ALTER TABLE visitors_new RENAME TO visitors`);
}

function validateDatabaseIntegrity(db: Database.Database): void {
  const integrity = db.pragma('integrity_check', { simple: true }) as string;
  if (integrity !== 'ok') {
    throw new Error(`SQLite integrity_check failed: ${integrity}`);
  }

  const fkViolations = db.pragma('foreign_key_check') as unknown[];
  if (fkViolations.length > 0) {
    throw new Error(`SQLite foreign_key_check failed with ${fkViolations.length} violation(s)`);
  }
}

/**
 * Runs all pending migrations in db/migrations/ against the given database.
 */
/** How many pre-migration snapshots to keep before pruning the oldest. */
const MIGRATION_BACKUP_RETENTION = 10;

/**
 * Writes a consistent snapshot of the database next to it, under `backups/`.
 *
 * Uses `VACUUM INTO`, which produces a transactionally consistent copy of a
 * live SQLite database — unlike a filesystem copy, which can capture a torn
 * page or miss the WAL. In-memory databases (tests) are skipped.
 *
 * A backup failure must never block startup: an operator with a healthy
 * database and a full disk still needs the service to come up. The failure is
 * logged loudly instead.
 */
function backupBeforeMigrations(db: Database.Database, pendingCount: number): void {
  const source = db.name;
  if (!source || source === ':memory:' || source.startsWith('file:memory')) return;
  // A throwaway test database is recreated from scratch on every run, so a
  // recovery point is meaningless — and writing one would litter the source
  // tree with snapshots beside src/tests/test.sqlite.
  if (process.env.NODE_ENV === 'test') return;

  try {
    const backupDir = path.join(path.dirname(source), 'backups');
    fs.mkdirSync(backupDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(backupDir, `pre-migration-${stamp}.sqlite`);
    // VACUUM INTO cannot overwrite, so a collision means a backup already exists.
    if (!fs.existsSync(target)) {
      db.prepare('VACUUM INTO ?').run(target);
      console.log(`🛟 Pre-migration backup written (${pendingCount} pending): ${target}`);
    }

    const snapshots = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith('pre-migration-') && f.endsWith('.sqlite'))
      .sort();
    for (const stale of snapshots.slice(0, Math.max(0, snapshots.length - MIGRATION_BACKUP_RETENTION))) {
      fs.unlinkSync(path.join(backupDir, stale));
    }
  } catch (err) {
    console.error('⚠️  Pre-migration backup FAILED — continuing without a recovery point:', err);
  }
}

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    fs.mkdirSync(migrationsDir, { recursive: true });
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) return;

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>).map(
      (r) => r.version
    )
  );

  const pending = files.filter((f) => !applied.has(f.replace(/\.sql$/, '')));
  if (pending.length === 0) return;

  // Point-in-time backup BEFORE the first pending migration runs.
  //
  // Individual migrations are atomic, but the schema is forward-only: there
  // are no `down` scripts. A migration that succeeds and commits, yet turns
  // out to be semantically wrong, previously left no way back — and nothing
  // else in the codebase ever copied the database. This snapshot is the
  // recovery point for that case.
  backupBeforeMigrations(db, pending.length);

  const recordApplied = db.prepare(
    'INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)'
  );

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;

    const fullPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(fullPath, 'utf-8');
    const statements = splitStatements(sql);

    console.log(`Applying migration: ${file} (${statements.length} statement(s))`);

    const requiresForeignKeyRebuild = /PRAGMA\s+foreign_keys\s*=\s*OFF/i.test(sql);
    try {
      // Wrap the entire migration file in a transaction.
      // If a fatal error occurs, all changes in this file are rolled back,
      // preventing partial schema updates.
      const migrate = db.transaction(() => {
        if (version === '026_visitor_stages_expand') {
          upgradeLegacyVisitorStageConstraint(db);
        }

        for (const statement of statements) {
          try {
            db.exec(statement);
          } catch (err: any) {
            const msg = String(err?.message || err);
            if (isSafeIdempotentError(db, statement, msg)) {
              console.log(`  ℹ already satisfied because the target column already exists (${msg})`);
              continue;
            }
            // Log the fatal statement before throwing to help debugging
            console.error(`  ❌ Fatal SQL Error in statement:\n${statement}\n`);
            throw err instanceof Error ? err : new Error(msg);
          }
        }

        // Validate before commit so an integrity failure rolls back the entire migration.
        validateDatabaseIntegrity(db);
      });

      if (requiresForeignKeyRebuild) db.pragma('foreign_keys = OFF');
      try {
        migrate();
      } finally {
        if (requiresForeignKeyRebuild) db.pragma('foreign_keys = ON');
      }
      validateDatabaseIntegrity(db);
      recordApplied.run(version, file);
      console.log(`  ✓ ${file} applied successfully.`);
      
    } catch (fatalError) {
      console.error(`❌ Migration failed for ${file}. Rolled back.`);
      throw fatalError;
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
}