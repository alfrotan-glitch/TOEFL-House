import type { Database } from 'better-sqlite3';
import { HttpError } from '../../middleware/errorHandler.js';
import { id, today } from '../../utils/ids.js';
import { assertMoney, assertSeatCount } from '../../utils/money.js';
import { assertDateRange, assertOptionalIsoDate } from '../../utils/isoDate.js';
import { optionalText, requiredText, TEXT_LIMITS } from '../../utils/textInput.js';
import { nextReceiptNumber } from '../../utils/receipt.js';
import { recordIncome } from '../../utils/income.js';
import { isUniqueViolation } from '../../utils/idempotency.js';
import type { Pagination } from '../../utils/pagination.js';
import { getJourneyEngine } from '../journey/journey-engine.js';
import { JourneyEventType } from '../journey/event-types.js';

export type BookItemKind = 'book' | 'chapter';
export type BookPaymentMethod = 'cash' | 'card' | 'bank_transfer';

export interface BooksActor {
  userId: string;
  fullName: string;
  role: string | null;
}

export interface BookCatalogCommand {
  title: unknown;
  itemKind: unknown;
  saleEnabled: unknown;
  salePrice?: unknown;
  lendingEnabled: unknown;
  initialQuantity: unknown;
  receivedOn?: unknown;
  unitCost?: unknown;
  note?: unknown;
  branchId: string;
  idempotencyKey: string;
  idempotencyCandidates?: string[];
  actor: BooksActor;
}

export interface BookCatalogPatchCommand {
  title?: unknown;
  saleEnabled?: unknown;
  salePrice?: unknown;
  lendingEnabled?: unknown;
  defaultUnitCost?: unknown;
  status?: unknown;
}

export interface BookReceiptCommand {
  quantity: unknown;
  receivedOn?: unknown;
  unitCost?: unknown;
  note?: unknown;
  idempotencyKey: string;
  idempotencyCandidates?: string[];
  actor: BooksActor;
}

export interface BookSaleCommand {
  quantity: unknown;
  purchaserName?: unknown;
  studentId?: unknown;
  discountAmount?: unknown;
  paymentMethod?: unknown;
  soldOn?: unknown;
  idempotencyKey: string;
  idempotencyCandidates?: string[];
  actor: BooksActor;
}

export interface BookSaleReturnCommand {
  returnedOn?: unknown;
  reason: unknown;
  idempotencyKey: string;
  idempotencyCandidates?: string[];
  actor: BooksActor;
}

export interface BookLoanCommand {
  studentId: unknown;
  issuedOn?: unknown;
  dueOn: unknown;
  idempotencyKey: string;
  idempotencyCandidates?: string[];
  actor: BooksActor;
}

export interface BookLoanReturnCommand {
  returnedOn?: unknown;
  note?: unknown;
  idempotencyKey: string;
  idempotencyCandidates?: string[];
  actor: BooksActor;
}

interface BookRow {
  id: string;
  title: string;
  item_kind: BookItemKind;
  sale_enabled: number;
  sale_price: number | null;
  lending_enabled: number;
  default_unit_cost: number | null;
  status: 'active' | 'archived';
  branch_id: string;
}

interface StudentRow {
  id: string;
  full_name: string;
  branch_id: string;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} is required.`);
  if (value.trim().length > TEXT_LIMITS.short) throw new HttpError(400, `${field} is too long.`);
  return value.trim();
}

function parseBookItemKind(value: unknown): BookItemKind {
  if (value === 'book' || value === 'chapter') return value;
  throw new HttpError(400, 'itemKind must be book or chapter.');
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  throw new HttpError(400, `${field} must be true or false.`);
}

function parsePaymentMethod(value: unknown): BookPaymentMethod {
  if (value === undefined || value === null || value === '') return 'cash';
  if (value === 'cash' || value === 'card' || value === 'bank_transfer') return value;
  throw new HttpError(400, 'paymentMethod must be cash, card, or bank_transfer.');
}

function parsePositiveQuantity(value: unknown, field: string): number {
  let quantity: number;
  try {
    quantity = assertSeatCount(value, field);
  } catch {
    throw new HttpError(400, `${field} must be a positive whole number.`);
  }
  if (quantity <= 0) throw new HttpError(400, `${field} must be a positive whole number.`);
  return quantity;
}

function parseOptionalWholeMoney(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  return assertMoney(value, field);
}

function assertKey(key: string): string {
  if (!key || !key.trim()) throw new HttpError(400, 'An idempotency key is required.');
  if (key.trim().length > TEXT_LIMITS.line) throw new HttpError(400, 'Idempotency key is too long.');
  return key.trim();
}

function idempotencyCandidates(key: string, supplied?: string[]): string[] {
  const canonical = assertKey(key);
  const candidates = [canonical, ...(supplied ?? [])]
    .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
    .map((candidate) => assertKey(candidate));
  return Array.from(new Set(candidates));
}

function candidatePlaceholders(candidates: string[]): string {
  return candidates.map(() => '?').join(', ');
}

function rejectBookStorageFailure(error: unknown, message: string): never {
  const detail = String((error as { message?: string })?.message ?? error);
  if (isUniqueViolation(error) || /Book (sale|loan|stock receipt|sale return)/i.test(detail) || /Book catalog facts are archived/i.test(detail)) {
    throw new HttpError(409, message);
  }
  throw error;
}

function requireBook(db: Database, bookId: string): BookRow {
  const book = db.prepare(`
    SELECT id, title, item_kind, sale_enabled, sale_price, lending_enabled,
           default_unit_cost, status, branch_id
      FROM books WHERE id = ?
  `).get(bookId) as BookRow | undefined;
  if (!book) throw new HttpError(404, 'Book catalog item not found.');
  return book;
}

export function getBookBranch(db: Database, bookId: string): string {
  return requireBook(db, bookId).branch_id;
}

export function getBookSaleBranch(db: Database, saleId: string): string {
  const row = db.prepare('SELECT branch_id FROM book_sales WHERE id = ?').get(saleId) as { branch_id: string } | undefined;
  if (!row) throw new HttpError(404, 'Book sale not found.');
  return row.branch_id;
}

export function getBookLoanBranch(db: Database, loanId: string): string {
  const row = db.prepare('SELECT branch_id FROM book_loans WHERE id = ?').get(loanId) as { branch_id: string } | undefined;
  if (!row) throw new HttpError(404, 'Book loan not found.');
  return row.branch_id;
}

function requireStudent(db: Database, studentId: string): StudentRow {
  const student = db.prepare('SELECT id, full_name, branch_id FROM students WHERE id = ?').get(studentId) as StudentRow | undefined;
  if (!student) throw new HttpError(404, 'Student not found.');
  return student;
}

function assertBookBranch(book: BookRow, branchId: string): void {
  if (book.branch_id !== branchId) throw new HttpError(403, 'Book belongs to another branch.');
}

function nullableId(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requireId(value, field);
}

function sameNullable(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

function asBookDto(row: Record<string, unknown>) {
  return {
    id: row.id,
    title: row.title,
    itemKind: row.item_kind,
    saleEnabled: Boolean(row.sale_enabled),
    salePrice: row.sale_price,
    lendingEnabled: Boolean(row.lending_enabled),
    defaultUnitCost: row.default_unit_cost,
    status: row.status,
    branchId: row.branch_id,
    receivedQuantity: Number(row.received_quantity ?? 0),
    soldQuantity: Number(row.sold_quantity ?? 0),
    loanedQuantity: Number(row.loaned_quantity ?? 0),
    availableQuantity: Number(row.available_quantity ?? 0),
  };
}

/**
 * Read model for the Books workspace. The server calculates every inventory and
 * commerce aggregate from canonical facts; the UI receives no second authority.
 */
export function getBooksWorkspace(
  db: Database,
  scope: { branchId: string | null; isAll: boolean },
  pagination: Pagination,
) {
  const filter = scope.isAll ? '' : 'WHERE b.branch_id = ?';
  const params = scope.isAll ? [] : [scope.branchId];
  const catalogRows = db.prepare(`
    SELECT b.*, p.received_quantity, p.sold_quantity, p.loaned_quantity, p.available_quantity
      FROM books b
      JOIN book_inventory_positions p ON p.book_id = b.id
      ${filter}
     ORDER BY CASE b.status WHEN 'active' THEN 0 ELSE 1 END, b.title COLLATE NOCASE
  `).all(...params) as Array<Record<string, unknown>>;

  const scopeArgs = scope.isAll ? [] : [scope.branchId];
  const sales = db.prepare(`
    SELECT s.id, s.book_id AS bookId, b.title AS bookTitle, b.item_kind AS itemKind,
           s.quantity, s.unit_price AS unitPrice, s.gross_amount AS grossAmount,
           s.discount_amount AS discountAmount, s.net_amount AS netAmount, s.sold_on AS soldOn,
           s.purchaser_name AS purchaserName, s.student_id AS studentId,
           st.full_name AS studentName, s.branch_id AS branchId, p.receipt_number AS receiptNumber,
           sr.id AS refundId, sr.returned_on AS returnedOn, sr.reason AS refundReason
      FROM book_sales s
      JOIN books b ON b.id = s.book_id
      JOIN payments p ON p.id = s.payment_id
 LEFT JOIN students st ON st.id = s.student_id
 LEFT JOIN book_sale_refunds sr ON sr.sale_id = s.id
     WHERE 1 = 1 ${scope.isAll ? '' : ' AND s.branch_id = ?'}
     ORDER BY s.sold_on DESC, s.created_at DESC
     LIMIT ? OFFSET ?
  `).all(...scopeArgs, pagination.limit, pagination.offset) as Array<Record<string, unknown>>;

  const loans = db.prepare(`
    SELECT l.id, l.book_id AS bookId, b.title AS bookTitle, b.item_kind AS itemKind,
           l.student_id AS studentId, st.full_name AS studentName, l.issued_on AS issuedOn,
           l.due_on AS dueOn, l.branch_id AS branchId, lr.id AS returnId,
           lr.returned_on AS returnedOn, lr.note AS returnNote
      FROM book_loans l
      JOIN books b ON b.id = l.book_id
      JOIN students st ON st.id = l.student_id
 LEFT JOIN book_loan_returns lr ON lr.loan_id = l.id
     WHERE 1 = 1 ${scope.isAll ? '' : ' AND l.branch_id = ?'}
     ORDER BY CASE WHEN lr.id IS NULL THEN 0 ELSE 1 END, l.due_on ASC, l.issued_on DESC
     LIMIT ? OFFSET ?
  `).all(...scopeArgs, pagination.limit, pagination.offset) as Array<Record<string, unknown>>;

  const receipts = db.prepare(`
    SELECT r.id, r.book_id AS bookId, b.title AS bookTitle, r.quantity,
           r.received_on AS receivedOn, r.unit_cost AS unitCost, r.note,
           r.branch_id AS branchId, r.received_by_name AS receivedByName
      FROM book_stock_receipts r
      JOIN books b ON b.id = r.book_id
     WHERE 1 = 1 ${scope.isAll ? '' : ' AND r.branch_id = ?'}
     ORDER BY r.received_on DESC, r.created_at DESC
     LIMIT ? OFFSET ?
  `).all(...scopeArgs, pagination.limit, pagination.offset) as Array<Record<string, unknown>>;

  const salesTotal = db.prepare(`SELECT COUNT(*) AS count FROM book_sales s WHERE 1 = 1 ${scope.isAll ? '' : ' AND s.branch_id = ?'}`)
    .get(...scopeArgs) as { count: number };
  const loansTotal = db.prepare(`SELECT COUNT(*) AS count FROM book_loans l WHERE 1 = 1 ${scope.isAll ? '' : ' AND l.branch_id = ?'}`)
    .get(...scopeArgs) as { count: number };
  const receiptsTotal = db.prepare(`SELECT COUNT(*) AS count FROM book_stock_receipts r WHERE 1 = 1 ${scope.isAll ? '' : ' AND r.branch_id = ?'}`)
    .get(...scopeArgs) as { count: number };

  const inventorySummary = db.prepare(`
    SELECT COUNT(*) AS catalog_items,
           COALESCE(SUM(p.available_quantity), 0) AS available_quantity,
           COALESCE(SUM(p.loaned_quantity), 0) AS active_loans
      FROM books b
      JOIN book_inventory_positions p ON p.book_id = b.id
      ${filter}
  `).get(...params) as Record<string, unknown>;
  const loanSummary = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN lr.id IS NULL AND l.due_on < ? THEN 1 ELSE 0 END), 0) AS overdue_loans
      FROM book_loans l
 LEFT JOIN book_loan_returns lr ON lr.loan_id = l.id
     WHERE 1 = 1 ${scope.isAll ? '' : ' AND l.branch_id = ?'}
  `).get(today(), ...scopeArgs) as Record<string, unknown>;
  const salesSummary = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN sr.id IS NULL THEN s.quantity ELSE 0 END), 0) AS sold_quantity,
           COALESCE(SUM(CASE WHEN sr.id IS NULL THEN s.net_amount ELSE 0 END), 0) AS sales_revenue,
           COALESCE(SUM(CASE WHEN sr.id IS NOT NULL THEN s.net_amount ELSE 0 END), 0) AS returned_sales_value
      FROM book_sales s
 LEFT JOIN book_sale_refunds sr ON sr.sale_id = s.id
     WHERE 1 = 1 ${scope.isAll ? '' : ' AND s.branch_id = ?'}
  `).get(...scopeArgs) as Record<string, unknown>;

  return {
    catalog: catalogRows.map(asBookDto),
    receipts: {
      items: receipts.map((row) => ({ ...row, quantity: Number(row.quantity), unitCost: row.unitCost == null ? null : Number(row.unitCost) })),
      page: pagination.page,
      pageSize: pagination.limit,
      total: Number(receiptsTotal.count),
    },
    sales: {
      items: sales.map((row) => ({
        ...row,
        quantity: Number(row.quantity), unitPrice: Number(row.unitPrice), grossAmount: Number(row.grossAmount),
        discountAmount: Number(row.discountAmount), netAmount: Number(row.netAmount), refunded: row.refundId != null,
      })),
      page: pagination.page,
      pageSize: pagination.limit,
      total: Number(salesTotal.count),
    },
    loans: {
      items: loans.map((row) => ({ ...row, returned: row.returnId != null, overdue: row.returnId == null && String(row.dueOn) < today() })),
      page: pagination.page,
      pageSize: pagination.limit,
      total: Number(loansTotal.count),
    },
    summary: {
      catalogItems: Number(inventorySummary.catalog_items ?? 0),
      availableQuantity: Number(inventorySummary.available_quantity ?? 0),
      activeLoans: Number(inventorySummary.active_loans ?? 0),
      overdueLoans: Number(loanSummary.overdue_loans ?? 0),
      soldQuantity: Number(salesSummary.sold_quantity ?? 0),
      salesRevenue: Number(salesSummary.sales_revenue ?? 0),
      returnedSalesValue: Number(salesSummary.returned_sales_value ?? 0),
    },
  };
}

export function createBookCatalogItem(db: Database, command: BookCatalogCommand): { id: string; idempotentReplay: boolean } {
  const title = requiredText(command.title, 'Title', TEXT_LIMITS.line);
  const itemKind = parseBookItemKind(command.itemKind);
  const saleEnabled = parseBoolean(command.saleEnabled, 'saleEnabled');
  const lendingEnabled = parseBoolean(command.lendingEnabled, 'lendingEnabled');
  if (!saleEnabled && !lendingEnabled) throw new HttpError(400, 'Enable sale, lending, or both for a Book item.');
  const salePrice = parseOptionalWholeMoney(command.salePrice, 'sale price');
  if (saleEnabled && (!salePrice || salePrice <= 0)) throw new HttpError(400, 'A sale-enabled Book item requires a positive whole-AFN sale price.');
  if (!saleEnabled && salePrice !== null) throw new HttpError(400, 'A non-sale Book item cannot carry a sale price.');
  const quantity = parsePositiveQuantity(command.initialQuantity, 'Initial quantity');
  const receivedOn = assertOptionalIsoDate(command.receivedOn, 'receivedOn') ?? today();
  const unitCost = parseOptionalWholeMoney(command.unitCost, 'unit cost');
  const note = optionalText(command.note, 'Receipt note', TEXT_LIMITS.notes);
  const idempotencyKey = assertKey(command.idempotencyKey);
  const candidates = idempotencyCandidates(idempotencyKey, command.idempotencyCandidates);

  const prior = db.prepare(`
    SELECT r.book_id, b.title, b.item_kind, r.quantity, r.branch_id
      FROM book_stock_receipts r JOIN books b ON b.id = r.book_id
     WHERE r.idempotency_key IN (${candidatePlaceholders(candidates)})
  `).get(...candidates) as { book_id: string; title: string; item_kind: string; quantity: number; branch_id: string } | undefined;
  if (prior) {
    if (prior.branch_id !== command.branchId || prior.title !== title || prior.item_kind !== itemKind || prior.quantity !== quantity) {
      throw new HttpError(409, 'This idempotency key has already been used for a different Book receipt.');
    }
    return { id: prior.book_id, idempotentReplay: true };
  }

  const duplicateTitle = db.prepare(`
    SELECT id FROM books WHERE branch_id = ? AND item_kind = ? AND title = ? COLLATE NOCASE
  `).get(command.branchId, itemKind, title) as { id: string } | undefined;
  if (duplicateTitle) throw new HttpError(409, 'A Book catalog item with this title and kind already exists in the branch.');

  const bookId = id('book');
  const receiptId = id('book_receipt');
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO books
          (id, title, item_kind, sale_enabled, sale_price, lending_enabled, default_unit_cost, status, branch_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
      `).run(bookId, title, itemKind, saleEnabled ? 1 : 0, saleEnabled ? salePrice : null, lendingEnabled ? 1 : 0, unitCost, command.branchId);
      db.prepare(`
        INSERT INTO book_stock_receipts
          (id, book_id, quantity, received_on, unit_cost, note, received_by_user_id, received_by_name, branch_id, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(receiptId, bookId, quantity, receivedOn, unitCost, note, command.actor.userId, command.actor.fullName, command.branchId, idempotencyKey);
    })();
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = db.prepare(`
        SELECT r.book_id, b.title, b.item_kind, r.quantity, r.branch_id
          FROM book_stock_receipts r JOIN books b ON b.id = r.book_id
         WHERE r.idempotency_key IN (${candidatePlaceholders(candidates)})
      `).get(...candidates) as { book_id: string; title: string; item_kind: string; quantity: number; branch_id: string } | undefined;
      if (winner) {
        if (winner.branch_id !== command.branchId || winner.title !== title || winner.item_kind !== itemKind || winner.quantity !== quantity) {
          throw new HttpError(409, 'This idempotency key has already been used for a different Book receipt.');
        }
        return { id: winner.book_id, idempotentReplay: true };
      }
      throw new HttpError(409, 'A Book catalog item with this title and kind already exists in the branch.');
    }
    rejectBookStorageFailure(error, 'The Book catalog item conflicts with an existing record.');
  }
  return { id: bookId, idempotentReplay: false };
}

export function patchBookCatalogItem(db: Database, bookId: string, branchId: string, command: BookCatalogPatchCommand): void {
  const current = requireBook(db, bookId);
  assertBookBranch(current, branchId);
  const title = command.title === undefined ? current.title : requiredText(command.title, 'Title', TEXT_LIMITS.line);
  const saleEnabled = command.saleEnabled === undefined ? Boolean(current.sale_enabled) : parseBoolean(command.saleEnabled, 'saleEnabled');
  const lendingEnabled = command.lendingEnabled === undefined ? Boolean(current.lending_enabled) : parseBoolean(command.lendingEnabled, 'lendingEnabled');
  if (!saleEnabled && !lendingEnabled) throw new HttpError(400, 'Enable sale, lending, or both for a Book item.');
  const salePrice = command.salePrice === undefined
    ? current.sale_price
    : parseOptionalWholeMoney(command.salePrice, 'sale price');
  if (saleEnabled && (!salePrice || salePrice <= 0)) throw new HttpError(400, 'A sale-enabled Book item requires a positive whole-AFN sale price.');
  if (!saleEnabled && salePrice !== null) throw new HttpError(400, 'A non-sale Book item cannot carry a sale price.');
  const defaultUnitCost = command.defaultUnitCost === undefined
    ? current.default_unit_cost
    : parseOptionalWholeMoney(command.defaultUnitCost, 'default unit cost');
  const status = command.status === undefined ? current.status : command.status;
  if (status !== 'active' && status !== 'archived') throw new HttpError(400, 'status must be active or archived.');

  try {
    db.prepare(`
      UPDATE books
         SET title = ?, sale_enabled = ?, sale_price = ?, lending_enabled = ?, default_unit_cost = ?, status = ?
       WHERE id = ?
    `).run(title, saleEnabled ? 1 : 0, saleEnabled ? salePrice : null, lendingEnabled ? 1 : 0, defaultUnitCost, status, bookId);
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, 'A Book catalog item with this title and kind already exists in the branch.');
    rejectBookStorageFailure(error, 'Book catalog update conflicts with historical Book facts.');
  }
}

export function receiveBookStock(db: Database, bookId: string, branchId: string, command: BookReceiptCommand): { id: string; idempotentReplay: boolean } {
  const book = requireBook(db, bookId);
  assertBookBranch(book, branchId);
  if (book.status !== 'active') throw new HttpError(409, 'Archived Book items cannot receive stock.');
  const quantity = parsePositiveQuantity(command.quantity, 'Quantity');
  const receivedOn = assertOptionalIsoDate(command.receivedOn, 'receivedOn') ?? today();
  const unitCost = parseOptionalWholeMoney(command.unitCost, 'unit cost') ?? book.default_unit_cost;
  const note = optionalText(command.note, 'Receipt note', TEXT_LIMITS.notes);
  const idempotencyKey = assertKey(command.idempotencyKey);
  const candidates = idempotencyCandidates(idempotencyKey, command.idempotencyCandidates);
  const prior = db.prepare(`SELECT id, book_id, quantity, branch_id FROM book_stock_receipts WHERE idempotency_key IN (${candidatePlaceholders(candidates)})`).get(...candidates) as { id: string; book_id: string; quantity: number; branch_id: string } | undefined;
  if (prior) {
    if (prior.book_id !== bookId || prior.quantity !== quantity || prior.branch_id !== branchId) {
      throw new HttpError(409, 'This idempotency key has already been used for a different Book receipt.');
    }
    return { id: prior.id, idempotentReplay: true };
  }

  const receiptId = id('book_receipt');
  try {
    db.prepare(`
      INSERT INTO book_stock_receipts
        (id, book_id, quantity, received_on, unit_cost, note, received_by_user_id, received_by_name, branch_id, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(receiptId, bookId, quantity, receivedOn, unitCost, note, command.actor.userId, command.actor.fullName, branchId, idempotencyKey);
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = db.prepare(`
        SELECT id, book_id, quantity, branch_id FROM book_stock_receipts
         WHERE idempotency_key IN (${candidatePlaceholders(candidates)})
      `).get(...candidates) as { id: string; book_id: string; quantity: number; branch_id: string } | undefined;
      if (winner) {
        if (winner.book_id !== bookId || winner.quantity !== quantity || winner.branch_id !== branchId) {
          throw new HttpError(409, 'This idempotency key has already been used for a different Book receipt.');
        }
        return { id: winner.id, idempotentReplay: true };
      }
    }
    rejectBookStorageFailure(error, 'Book stock receipt conflicts with an existing command.');
  }
  return { id: receiptId, idempotentReplay: false };
}

export function postBookSale(db: Database, bookId: string, branchId: string, command: BookSaleCommand): { id: string; receiptNumber: string; idempotentReplay: boolean } {
  const book = requireBook(db, bookId);
  assertBookBranch(book, branchId);
  if (book.status !== 'active' || !book.sale_enabled || !book.sale_price) throw new HttpError(409, 'This Book item is not available for sale.');
  const quantity = parsePositiveQuantity(command.quantity, 'Quantity');
  const studentId = nullableId(command.studentId, 'studentId');
  const student = studentId ? requireStudent(db, studentId) : null;
  if (student && student.branch_id !== branchId) throw new HttpError(403, 'Student belongs to another branch.');
  const purchaserName = student
    ? student.full_name
    : requiredText(command.purchaserName, 'Purchaser name', TEXT_LIMITS.name);
  const discountAmount = parseOptionalWholeMoney(command.discountAmount, 'discount') ?? 0;
  const grossAmount = book.sale_price * quantity;
  if (discountAmount >= grossAmount) throw new HttpError(400, `Discount must be less than the sale total of ${grossAmount} AFN.`);
  const netAmount = grossAmount - discountAmount;
  const paymentMethod = parsePaymentMethod(command.paymentMethod);
  const soldOn = assertOptionalIsoDate(command.soldOn, 'soldOn') ?? today();
  const idempotencyKey = assertKey(command.idempotencyKey);
  const candidates = idempotencyCandidates(idempotencyKey, command.idempotencyCandidates);

  const prior = db.prepare(`
    SELECT s.id, s.book_id, s.quantity, s.discount_amount, s.student_id, s.purchaser_name,
           s.branch_id, p.payment_method, p.receipt_number
      FROM book_sales s JOIN payments p ON p.id = s.payment_id
     WHERE s.idempotency_key IN (${candidatePlaceholders(candidates)})
  `).get(...candidates) as {
    id: string; book_id: string; quantity: number; discount_amount: number; student_id: string | null;
    purchaser_name: string; branch_id: string; payment_method: BookPaymentMethod; receipt_number: string;
  } | undefined;
  if (prior) {
    if (prior.book_id !== bookId || prior.quantity !== quantity || prior.discount_amount !== discountAmount
      || !sameNullable(prior.student_id, studentId) || prior.purchaser_name !== purchaserName
      || prior.branch_id !== branchId || prior.payment_method !== paymentMethod) {
      throw new HttpError(409, 'This idempotency key has already been used for a different Book sale.');
    }
    return { id: prior.id, receiptNumber: prior.receipt_number, idempotentReplay: true };
  }

  const saleId = id('book_sale');
  const paymentId = id('pay');
  const receiptNumber = nextReceiptNumber();
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO book_sales
          (id, book_id, quantity, unit_price, gross_amount, discount_amount, net_amount, payment_id,
           sold_on, purchaser_name, student_id, operator_user_id, operator_name, branch_id, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(saleId, bookId, quantity, book.sale_price, grossAmount, discountAmount, netAmount, paymentId,
        soldOn, purchaserName, studentId, command.actor.userId, command.actor.fullName, branchId, idempotencyKey);
      db.prepare(`
        INSERT INTO payments
          (id, student_id, amount, date, payment_method, status, category, notes, receipt_number, branch_id, idempotency_key)
        VALUES (?, ?, ?, ?, ?, 'completed', 'book', ?, ?, ?, ?)
      `).run(paymentId, studentId, netAmount, soldOn, paymentMethod, `Book sale ${saleId}`, receiptNumber, branchId, idempotencyKey);
      recordIncome({
        category: 'book', amount: netAmount, date: soldOn,
        description: `Book sale ${saleId}: ${quantity} × ${book.title} to ${purchaserName}`,
        referenceId: saleId, paymentId, operatorName: command.actor.fullName,
        operatorRole: command.actor.role, branchId,
      });
    })();
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = db.prepare(`
        SELECT s.id, s.book_id, s.quantity, s.discount_amount, s.student_id, s.purchaser_name,
               s.branch_id, p.payment_method, p.receipt_number
          FROM book_sales s JOIN payments p ON p.id = s.payment_id
         WHERE s.idempotency_key IN (${candidatePlaceholders(candidates)})
      `).get(...candidates) as {
        id: string; book_id: string; quantity: number; discount_amount: number; student_id: string | null;
        purchaser_name: string; branch_id: string; payment_method: BookPaymentMethod; receipt_number: string;
      } | undefined;
      if (winner) {
        if (winner.book_id !== bookId || winner.quantity !== quantity || winner.discount_amount !== discountAmount
          || !sameNullable(winner.student_id, studentId) || winner.purchaser_name !== purchaserName
          || winner.branch_id !== branchId || winner.payment_method !== paymentMethod) {
          throw new HttpError(409, 'This idempotency key has already been used for a different Book sale.');
        }
        return { id: winner.id, receiptNumber: winner.receipt_number, idempotentReplay: true };
      }
    }
    rejectBookStorageFailure(error, 'Book availability changed or the sale conflicts with an existing command.');
  }
  return { id: saleId, receiptNumber, idempotentReplay: false };
}

export function returnBookSale(db: Database, saleId: string, branchId: string, command: BookSaleReturnCommand): { id: string; receiptNumber: string; idempotentReplay: boolean } {
  const returnedOn = assertOptionalIsoDate(command.returnedOn, 'returnedOn') ?? today();
  const reason = requiredText(command.reason, 'Return reason', TEXT_LIMITS.notes);
  const idempotencyKey = assertKey(command.idempotencyKey);
  const candidates = idempotencyCandidates(idempotencyKey, command.idempotencyCandidates);
  const sale = db.prepare(`
    SELECT s.id, s.payment_id, s.student_id, s.net_amount, s.sold_on, s.branch_id, b.title
      FROM book_sales s JOIN books b ON b.id = s.book_id WHERE s.id = ?
  `).get(saleId) as { id: string; payment_id: string; student_id: string | null; net_amount: number; sold_on: string; branch_id: string; title: string } | undefined;
  if (!sale) throw new HttpError(404, 'Book sale not found.');
  if (sale.branch_id !== branchId) throw new HttpError(403, 'Book sale belongs to another branch.');
  assertDateRange(sale.sold_on, returnedOn, 'sale date', 'return date');

  const prior = db.prepare(`
    SELECT sr.id, sr.sale_id, p.receipt_number
      FROM book_sale_refunds sr JOIN payments p ON p.id = sr.refund_payment_id
     WHERE sr.idempotency_key IN (${candidatePlaceholders(candidates)})
  `).get(...candidates) as { id: string; sale_id: string; receipt_number: string } | undefined;
  if (prior) {
    if (prior.sale_id !== saleId) throw new HttpError(409, 'This idempotency key has already been used for a different Book sale return.');
    return { id: prior.id, receiptNumber: prior.receipt_number, idempotentReplay: true };
  }
  const existing = db.prepare('SELECT id FROM book_sale_refunds WHERE sale_id = ?').get(saleId) as { id: string } | undefined;
  if (existing) throw new HttpError(409, 'This Book sale has already been returned and refunded.');

  const refundId = id('book_sale_refund');
  const paymentId = id('pay');
  const receiptNumber = `REF-${nextReceiptNumber()}`;
  try {
    db.transaction(() => {
      const fresh = db.prepare('SELECT id FROM book_sale_refunds WHERE sale_id = ?').get(saleId);
      if (fresh) throw new HttpError(409, 'This Book sale has already been returned and refunded.');
      db.prepare(`
        INSERT INTO book_sale_refunds
          (id, sale_id, refund_payment_id, returned_on, reason, returned_by_user_id, returned_by_name, branch_id, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(refundId, saleId, paymentId, returnedOn, reason, command.actor.userId, command.actor.fullName, branchId, idempotencyKey);
      db.prepare(`
        INSERT INTO payments
          (id, student_id, amount, date, payment_method, status, category, notes, receipt_number,
           branch_id, refunds_payment_id, idempotency_key)
        VALUES (?, ?, ?, ?, 'cash', 'completed', 'refund', ?, ?, ?, ?, ?)
      `).run(paymentId, sale.student_id, -sale.net_amount, returnedOn, `Book sale return ${saleId}: ${reason}`,
        receiptNumber, branchId, sale.payment_id, idempotencyKey);
      recordIncome({
        category: 'refund', amount: -sale.net_amount, date: returnedOn,
        description: `Book sale return ${saleId}: ${sale.title}; ${reason}`,
        referenceId: saleId, paymentId, operatorName: command.actor.fullName,
        operatorRole: command.actor.role, branchId,
      });
    })();
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = db.prepare(`
        SELECT sr.id, sr.sale_id, p.receipt_number
          FROM book_sale_refunds sr JOIN payments p ON p.id = sr.refund_payment_id
         WHERE sr.idempotency_key IN (${candidatePlaceholders(candidates)})
      `).get(...candidates) as { id: string; sale_id: string; receipt_number: string } | undefined;
      if (winner) {
        if (winner.sale_id !== saleId) throw new HttpError(409, 'This idempotency key has already been used for a different Book sale return.');
        return { id: winner.id, receiptNumber: winner.receipt_number, idempotentReplay: true };
      }
    }
    rejectBookStorageFailure(error, 'This Book sale has already been returned or the return conflicts with an existing command.');
  }
  return { id: refundId, receiptNumber, idempotentReplay: false };
}

export function issueBookLoan(db: Database, bookId: string, branchId: string, command: BookLoanCommand): { id: string; idempotentReplay: boolean } {
  const book = requireBook(db, bookId);
  assertBookBranch(book, branchId);
  if (book.status !== 'active' || !book.lending_enabled) throw new HttpError(409, 'This Book item is not available for lending.');
  const studentId = requireId(command.studentId, 'studentId');
  const student = requireStudent(db, studentId);
  if (student.branch_id !== branchId) throw new HttpError(403, 'Student belongs to another branch.');
  const issuedOn = assertOptionalIsoDate(command.issuedOn, 'issuedOn') ?? today();
  const dueOn = assertOptionalIsoDate(command.dueOn, 'dueOn');
  if (!dueOn) throw new HttpError(400, 'dueOn is required.');
  assertDateRange(issuedOn, dueOn, 'issuedOn', 'dueOn');
  const idempotencyKey = assertKey(command.idempotencyKey);
  const candidates = idempotencyCandidates(idempotencyKey, command.idempotencyCandidates);
  const prior = db.prepare(`SELECT id, book_id, student_id, due_on, branch_id FROM book_loans WHERE idempotency_key IN (${candidatePlaceholders(candidates)})`).get(...candidates) as { id: string; book_id: string; student_id: string; due_on: string; branch_id: string } | undefined;
  if (prior) {
    if (prior.book_id !== bookId || prior.student_id !== studentId || prior.due_on !== dueOn || prior.branch_id !== branchId) {
      throw new HttpError(409, 'This idempotency key has already been used for a different Book loan.');
    }
    return { id: prior.id, idempotentReplay: true };
  }

  const loanId = id('book_loan');
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO book_loans
          (id, book_id, student_id, issued_on, due_on, issued_by_user_id, issued_by_name, branch_id, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(loanId, bookId, studentId, issuedOn, dueOn, command.actor.userId, command.actor.fullName, branchId, idempotencyKey);
      getJourneyEngine(db).appendEvent({
        studentId,
        eventType: JourneyEventType.BOOK_ISSUED,
        occurredAt: issuedOn,
        branchId,
        actorUserId: command.actor.userId,
        actorName: command.actor.fullName,
        correlationId: loanId,
        payload: { loanId, bookId, title: book.title, dueOn },
      });
    })();
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = db.prepare(`
        SELECT id, book_id, student_id, due_on, branch_id FROM book_loans
         WHERE idempotency_key IN (${candidatePlaceholders(candidates)})
      `).get(...candidates) as { id: string; book_id: string; student_id: string; due_on: string; branch_id: string } | undefined;
      if (winner) {
        if (winner.book_id !== bookId || winner.student_id !== studentId || winner.due_on !== dueOn || winner.branch_id !== branchId) {
          throw new HttpError(409, 'This idempotency key has already been used for a different Book loan.');
        }
        return { id: winner.id, idempotentReplay: true };
      }
    }
    rejectBookStorageFailure(error, 'Book availability changed or the loan conflicts with an existing command.');
  }
  return { id: loanId, idempotentReplay: false };
}

export function returnBookLoan(db: Database, loanId: string, branchId: string, command: BookLoanReturnCommand): { id: string; idempotentReplay: boolean } {
  const returnedOn = assertOptionalIsoDate(command.returnedOn, 'returnedOn') ?? today();
  const note = optionalText(command.note, 'Return note', TEXT_LIMITS.notes);
  const idempotencyKey = assertKey(command.idempotencyKey);
  const candidates = idempotencyCandidates(idempotencyKey, command.idempotencyCandidates);
  const loan = db.prepare(`
    SELECT l.id, l.book_id, l.student_id, l.issued_on, l.branch_id, b.title
      FROM book_loans l JOIN books b ON b.id = l.book_id
     WHERE l.id = ?
  `).get(loanId) as { id: string; book_id: string; student_id: string; issued_on: string; branch_id: string; title: string } | undefined;
  if (!loan) throw new HttpError(404, 'Book loan not found.');
  if (loan.branch_id !== branchId) throw new HttpError(403, 'Book loan belongs to another branch.');
  assertDateRange(loan.issued_on, returnedOn, 'issuedOn', 'returnedOn');
  const prior = db.prepare(`SELECT id, loan_id FROM book_loan_returns WHERE idempotency_key IN (${candidatePlaceholders(candidates)})`).get(...candidates) as { id: string; loan_id: string } | undefined;
  if (prior) {
    if (prior.loan_id !== loanId) throw new HttpError(409, 'This idempotency key has already been used for a different Book loan return.');
    return { id: prior.id, idempotentReplay: true };
  }
  const existing = db.prepare('SELECT id FROM book_loan_returns WHERE loan_id = ?').get(loanId);
  if (existing) throw new HttpError(409, 'This Book loan has already been returned.');

  const returnId = id('book_loan_return');
  try {
    db.transaction(() => {
      const fresh = db.prepare('SELECT id FROM book_loan_returns WHERE loan_id = ?').get(loanId);
      if (fresh) throw new HttpError(409, 'This Book loan has already been returned.');
      db.prepare(`
        INSERT INTO book_loan_returns
          (id, loan_id, returned_on, note, returned_by_user_id, returned_by_name, branch_id, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(returnId, loanId, returnedOn, note, command.actor.userId, command.actor.fullName, branchId, idempotencyKey);
      getJourneyEngine(db).appendEvent({
        studentId: loan.student_id,
        eventType: JourneyEventType.BOOK_RETURNED,
        occurredAt: returnedOn,
        branchId,
        actorUserId: command.actor.userId,
        actorName: command.actor.fullName,
        correlationId: returnId,
        causationId: loanId,
        payload: { loanId, bookId: loan.book_id, title: loan.title, note },
      });
    })();
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = db.prepare(`
        SELECT id, loan_id FROM book_loan_returns
         WHERE idempotency_key IN (${candidatePlaceholders(candidates)})
      `).get(...candidates) as { id: string; loan_id: string } | undefined;
      if (winner) {
        if (winner.loan_id !== loanId) throw new HttpError(409, 'This idempotency key has already been used for a different Book loan return.');
        return { id: winner.id, idempotentReplay: true };
      }
    }
    rejectBookStorageFailure(error, 'The Book loan has already been returned or conflicts with an existing command.');
  }
  return { id: returnId, idempotentReplay: false };
}
