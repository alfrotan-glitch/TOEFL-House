/**
 * Canonical finance category catalogue writer.
 *
 * Lives in its own module because TWO callers need it and neither may import
 * the other:
 *
 *   · `db/migrate.ts`               — migration 078 must have the taxonomy rows
 *                                     in place before its explicit legacy
 *                                     mapping can reference them by foreign key
 *   · `db/organizationHierarchy.ts` — every boot, fresh or upgraded
 *
 * The rows themselves come from `core/finance/category-taxonomy.ts`, the single
 * source of truth the ledger classifier and the test-suite also read. Writing
 * the 55 nodes out again in SQL would have created a second definition that
 * could silently drift from the first.
 */
import type Database from 'better-sqlite3';
import { CANONICAL_CHANNELS, canonicalCategoryRows } from '../core/finance/category-taxonomy.js';

/** Organization that owns the system taxonomy. Mirrors FIXED_ORG_ID. */
const SYSTEM_ORGANIZATION_ID = 'org_toefl_house';

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

/**
 * Writes (or refreshes) the canonical taxonomy and its channels.
 *
 * Idempotent by primary key. `is_active` is deliberately never overwritten: an
 * operator who retires a system subcategory must not have it reactivated by the
 * next boot.
 */
export function seedFinanceCategoryCatalog(db: Database.Database): void {
  if (!tableExists(db, 'finance_categories')) return;

  const upsertCategory = db.prepare(`
    INSERT INTO finance_categories
      (id, parent_id, name, level, classification, sort_order, is_active, is_system, organization_id)
    VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)
    ON CONFLICT(id) DO UPDATE SET
      parent_id      = excluded.parent_id,
      name           = excluded.name,
      level          = excluded.level,
      classification = excluded.classification,
      sort_order     = excluded.sort_order,
      is_system      = 1,
      updated_at     = datetime('now')
  `);

  const upsertChannel = tableExists(db, 'finance_category_channels')
    ? db.prepare(`
        INSERT INTO finance_category_channels (id, category_id, name, kind, sort_order, is_active, is_system)
        VALUES (?, ?, ?, ?, ?, 1, 1)
        ON CONFLICT(id) DO UPDATE SET
          category_id = excluded.category_id,
          name        = excluded.name,
          kind        = excluded.kind,
          sort_order  = excluded.sort_order,
          is_system   = 1
      `)
    : null;

  const write = () => {
    // canonicalCategoryRows() emits every parent before its children, which the
    // "parent must be a top-level category" trigger requires.
    for (const row of canonicalCategoryRows()) {
      upsertCategory.run(
        row.id,
        row.parentId,
        row.name,
        row.level,
        row.classification,
        row.sortOrder,
        SYSTEM_ORGANIZATION_ID,
      );
    }
    if (upsertChannel) {
      CANONICAL_CHANNELS.forEach((channel, index) => {
        upsertChannel.run(channel.id, channel.categoryId, channel.name, channel.kind, (index + 1) * 10);
      });
    }
  };

  // The migration runner already holds a transaction open when it calls this;
  // nesting one would throw. Outside a migration, wrap it so a partial taxonomy
  // can never be committed.
  if (db.inTransaction) write();
  else db.transaction(write)();
}
