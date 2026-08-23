import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', '..');
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

function booksSchemaBlock(): string {
  const schema = read('server/src/db/schema.sql');
  const start = schema.indexOf('-- BOOKS\n-- ============================================================================');
  const end = schema.indexOf('-- FINANCE\n-- ============================================================================', start);
  return schema.slice(start, end);
}

describe('WP-10 cold review · Books authority boundaries', () => {
  it('has no mutable stock mirror or obsolete Book-restock table in the canonical schema', () => {
    const schema = booksSchemaBlock();
    expect(schema).toContain('CREATE VIEW book_inventory_positions AS');
    expect(schema).toContain('book_stock_receipts');
    expect(schema).not.toMatch(/\bstock\s+(?:INTEGER|REAL)/i);
    expect(schema).not.toContain('book_restock_history');
  });

  it('binds a Book sale/return to exact cash facts while accepting only invoice-backed non-catalog Book payments', () => {
    const schema = read('server/src/db/schema.sql');
    expect(schema).toContain('payment_id            TEXT NOT NULL UNIQUE REFERENCES payments(id)');
    expect(schema).toContain('refund_payment_id     TEXT NOT NULL UNIQUE REFERENCES payments(id)');
    expect(schema).toContain('trg_book_sale_payment_integrity_insert');
    expect(schema).toContain("NEW.category = 'book' AND NEW.invoice_id IS NULL");
    expect(schema).toContain('trg_book_sale_refund_income_integrity_insert');
  });

  it('removes the generic Student Book writer and routes all Book commands through permission-based API boundaries', () => {
    const students = read('server/src/routes/students.routes.ts');
    const routes = read('server/src/routes/books.routes.ts');
    expect(students).not.toMatch(/\['fee', 'book', 'chapter'/);
    expect(students).not.toContain('bookId = optionalText');
    expect(routes).not.toContain('authorize(');
    for (const permission of ['Book.Create', 'Book.Edit', 'Book.Restock', 'Book.Sell', 'Book.Refund', 'Book.Issue', 'Book.Return']) {
      expect(routes).toContain(`requirePermission('${permission}')`);
    }
  });

  it('records only supported Book custody states in the Student Journey, atomically from the Book service', () => {
    const service = read('server/src/core/books/books-service.ts');
    const events = read('server/src/core/journey/event-types.ts');
    expect(service).toContain('JourneyEventType.BOOK_ISSUED');
    expect(service).toContain('JourneyEventType.BOOK_RETURNED');
    expect(service).toContain('db.transaction(() =>');
    expect(events).not.toContain('BOOK_LOST');
  });

  it('keeps the final Books source tree free of obsolete modal, route and browser-calculation residue', () => {
    expect(fs.existsSync(path.join(repoRoot, 'src/components/books/BooksModals.tsx'))).toBe(false);
    const view = read('src/components/books/BooksView.tsx');
    const store = read('src/apiStore.ts');
    expect(view).not.toMatch(/books\.reduce|bookSales\.reduce|window\.print\(/);
    expect(store).not.toContain('/books/sales/list');
    expect(store).not.toContain('/sell');
  });
});
