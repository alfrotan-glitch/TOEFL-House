import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', '..');
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

describe('WP-10 · Books frontend contract', () => {
  it('consumes the server Books workspace instead of calculating inventory or sales truth in the browser', () => {
    const view = read('src/components/books/BooksView.tsx');
    const store = read('src/apiStore.ts');
    expect(view).toContain('BooksWorkspace');
    expect(view).toContain('workspace.summary.availableQuantity');
    expect(view).toContain('workspace.summary.salesRevenue');
    expect(view).not.toMatch(/books\.reduce\(/);
    expect(view).not.toMatch(/bookSales\.reduce\(/);
    expect(store).toContain("api.get<BooksWorkspace>('/books/workspace', { ...bq, page: String(page), limit: String(BOOK_HISTORY_PAGE_SIZE) })");
    expect(store).not.toContain("api.get<Book[]>('/books'");
    expect(store).not.toContain("'/books/sales/list'");
    expect(store).toContain('loadBooksHistoryPage');
    expect(view).toContain('HistoryPagination');
  });

  it('offers all bounded Book workflows with permission-based affordances and canonical Shamsi date inputs', () => {
    const view = read('src/components/books/BooksView.tsx');
    for (const permission of ['Book.Create', 'Book.Edit', 'Book.Restock', 'Book.Sell', 'Book.Refund', 'Book.Issue', 'Book.Return']) {
      expect(view).toContain(`'${permission}'`);
    }
    expect(view).toContain('ShamsiDateInput');
    expect(view).toContain('createBookCatalogItem');
    expect(view).toContain('receiveBookStock');
    expect(view).toContain('recordBookSale');
    expect(view).toContain('returnBookSale');
    expect(view).toContain('issueBookLoan');
    expect(view).toContain('returnBookLoan');
    expect(view).not.toMatch(/activeRole|isGlobalOwner/);

    const store = read('src/apiStore.ts');
    const journey = read('src/components/students/journey/StudentJourneyTimeline.tsx');
    expect(store).toMatch(/const issueBookLoan[\s\S]*?invalidate\('books', 'students'\)/);
    expect(store).toMatch(/const returnBookLoan[\s\S]*?invalidate\('books', 'students'\)/);
    expect(journey).toContain("useVersionedFetch(load, ['students']");
    expect(journey).toContain("'journey.book_issued'");
    expect(journey).toContain("'journey.book_returned'");
  });

  it('prints Book sale receipts through the shared print authority and has no obsolete modal implementation', () => {
    const view = read('src/components/books/BooksView.tsx');
    expect(view).toContain('openPrintDocument');
    expect(view).toContain("paper: 'receipt80'");
    expect(view).toContain('issuer.phone');
    expect(fs.existsSync(path.join(repoRoot, 'src/components/books/BooksModals.tsx'))).toBe(false);
  });
});
