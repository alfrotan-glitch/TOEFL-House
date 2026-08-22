import { Router } from 'express';
import { db } from '../db/connection.js';
import { assertTextLengths, TEXT_LIMITS } from '../utils/textInput.js';
import { authenticate, authorize, resolveBranchScope, canAccessBranchResource } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { resolveIdempotency } from '../utils/idempotency.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';
import { assertMoney, assertSeatCount } from '../utils/money.js';
import { addNotification } from '../utils/notifications.js';
import { recordIncome } from '../utils/income.js';

export const booksRouter = Router();
booksRouter.use(authenticate);

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtGetBookById = db.prepare('SELECT * FROM books WHERE id = ?');
const stmtGetRestockHistoryByBook = db.prepare('SELECT * FROM book_restock_history WHERE book_id = ? ORDER BY date');
const stmtGetBooksByBranch = db.prepare('SELECT * FROM books WHERE branch_id = ? ORDER BY title');
const stmtGetBookByTitleAndType = db.prepare('SELECT * FROM books WHERE branch_id = ? AND is_chapter = ? AND LOWER(TRIM(title)) = ?');
const stmtUpdateBookStockAdd = db.prepare('UPDATE books SET stock = stock + ?, price = ?, purchase_price = ?, entry_date = ? WHERE id = ?');
const stmtInsertRestockHistory = db.prepare('INSERT INTO book_restock_history (id, book_id, date, quantity, price, purchase_price) VALUES (?, ?, ?, ?, ?, ?)');
const stmtInsertBook = db.prepare(
  `INSERT INTO books (id, title, price, purchase_price, stock, is_chapter, branch_id, entry_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtUpdateBook = db.prepare('UPDATE books SET title=?, price=?, stock=?, is_chapter=?, purchase_price=? WHERE id=?');
const stmtDeleteBook = db.prepare('DELETE FROM books WHERE id = ?');
const stmtGetSalesByBranch = db.prepare('SELECT * FROM book_sales WHERE branch_id = ? ORDER BY date DESC');
const stmtGetAllSales = db.prepare('SELECT * FROM book_sales ORDER BY date DESC');
const stmtUpdateBookStockSub = db.prepare('UPDATE books SET stock = stock - ? WHERE id = ? AND branch_id = ? AND stock >= ?');
const stmtInsertBookSale = db.prepare(
  `INSERT INTO book_sales (id, book_id, quantity, total_amount, discount_amount, net_amount, payment_method, status, date, customer_name, student_id, branch_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)`
);
const stmtGetSaleById = db.prepare('SELECT * FROM book_sales WHERE id = ?');
const stmtUpdateSaleStatus = db.prepare("UPDATE book_sales SET status = 'refunded' WHERE id = ?");

/** Ensure book exists and caller may access its branch. */
function requireBook(req: import('express').Request, bookId: string): any {
  const row = stmtGetBookById.get(bookId) as any;
  if (!row) throw new HttpError(404, 'Book not found.');
  
  const { branchId, isAll } = resolveBranchScope(req);
  if (!isAll && branchId && row.branch_id && row.branch_id !== branchId) {
    const user = req.user;
    if (!user) throw new HttpError(401, 'Not authenticated');
    const cross = !!row.branch_id && canAccessBranchResource(req, row.branch_id);
    if (!cross) throw new HttpError(403, 'Book belongs to another branch.');
  }
  return row;
}

function mapBook(row: any) {
  const restockHistory = stmtGetRestockHistoryByBook.all(row.id) as any[];
  return {
    id: row.id,
    title: row.title,
    price: row.price,
    purchasePrice: row.purchase_price,
    stock: row.stock,
    isChapter: !!row.is_chapter,
    branchId: row.branch_id,
    entryDate: row.entry_date,
    restockHistory: restockHistory.map((r) => ({ date: r.date, quantity: r.quantity, price: r.price, purchasePrice: r.purchase_price })),
  };
}

booksRouter.get(
  '/',
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const rows = isAll 
      ? db.prepare('SELECT * FROM books ORDER BY title').all() 
      : stmtGetBooksByBranch.all(branchId);
    res.json((rows as any[]).map(mapBook));
  })
);

// Adding a book with the same title+type in the same branch aggregates stock (restock) instead of duplicating
booksRouter.post(
  '/',
  authorize('receptionist', 'general_manager', 'finance_manager'),
  ah(async (req, res) => {
    const { title, price, stock, isChapter, entryDate, purchasePrice, branchId } = req.body;
    if (!title || price == null || stock == null) throw new HttpError(400, 'Title, price, and quantity are required.');
    assertTextLengths([[title, 'Title', TEXT_LIMITS.line]]);
    // Stock was validated but price was written through untouched, so the
    // literal string "abc" was stored as a price — along with null, -100,
    // 0.001 and 1e15. A book with a non-numeric price then became permanently
    // unsellable: /sell computes `book.price * quantity`, producing NaN and a
    // raw "NOT NULL constraint failed: book_sales.total_amount" from SQLite.
    const validatedPrice = assertMoney(price, 'book price');
    const validatedPurchasePrice = purchasePrice !== undefined
      ? assertMoney(purchasePrice, 'book purchase price')
      : null;
    if (!Number.isInteger(Number(stock)) || Number(stock) < 0) throw new HttpError(400, 'Stock must be a non-negative integer.');

    // The book is created in the caller's working branch (the branch the UI is
    // currently scoped to), which may differ from the JWT branch for
    // owners/managers who switch branches. The target branch must be within
    // the caller's authorized scope.
    const branchIdResolved = branchId || req.user?.branchId;
    if (!branchIdResolved) throw new HttpError(403, 'User branch context is missing.');
    if (!canAccessBranchResource(req, branchIdResolved)) throw new HttpError(403, 'Target branch is outside your authorized scope.');

    const normalizedTitle = String(title).trim().toLowerCase();
    const existing = stmtGetBookByTitleAndType.get(branchIdResolved, isChapter ? 1 : 0, normalizedTitle) as any;

    const targetDate = entryDate || today();
    const finalPurchasePrice = validatedPurchasePrice !== null ? validatedPurchasePrice : Math.round(validatedPrice * 0.6);

    db.transaction(() => {
      if (existing) {
        stmtUpdateBookStockAdd.run(stock, validatedPrice, finalPurchasePrice, targetDate, existing.id);
        stmtInsertRestockHistory.run(id('rs'), existing.id, targetDate, stock, validatedPrice, finalPurchasePrice);
      } else {
        const newId = id('bk');
        stmtInsertBook.run(newId, String(title).trim(), validatedPrice, finalPurchasePrice, stock, isChapter ? 1 : 0, branchIdResolved, targetDate);
        stmtInsertRestockHistory.run(id('rs'), newId, targetDate, stock, validatedPrice, finalPurchasePrice);
      }
    })();

    writeAudit(req, `Registered or restocked book/chapter: ${title}, adding ${stock} new copies`);
    res.status(201).json({ ok: true });
  })
);

booksRouter.put(
  '/:id',
  authorize('receptionist', 'general_manager', 'finance_manager'),
  ah(async (req, res) => {
    const existing = requireBook(req, req.params.id);
    const { title, price, stock, isChapter, purchasePrice } = req.body;
    if (stock !== undefined && (!Number.isInteger(Number(stock)) || Number(stock) < 0)) {
      throw new HttpError(400, 'Stock must be a non-negative integer.');
    }
    
    stmtUpdateBook.run(
      title ?? existing.title, 
      price != null ? assertMoney(price, 'book price') : existing.price, 
      stock ?? existing.stock,
      isChapter !== undefined ? (isChapter ? 1 : 0) : existing.is_chapter,
      purchasePrice !== undefined ? assertMoney(purchasePrice, 'book purchase price') : existing.purchase_price, 
      req.params.id
    );
    
    writeAudit(req, `Edited book/chapter details: ${existing.title}`);
    res.json({ ok: true });
  })
);

booksRouter.delete(
  '/:id',
  authorize('general_manager', 'finance_manager'),
  ah(async (req, res) => {
    const existing = requireBook(req, req.params.id);
    stmtDeleteBook.run(req.params.id);
    writeAudit(req, `Deleted book/chapter from system: ${existing.title}`);
    res.json({ ok: true });
  })
);

booksRouter.get(
  '/sales/list',
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const rows = isAll ? stmtGetAllSales.all() : stmtGetSalesByBranch.all(branchId);
    res.json(rows);
  })
);

booksRouter.post(
  '/:id/sell',
  authorize('receptionist', 'general_manager', 'finance_manager'),
  ah(async (req, res) => {
    const book = requireBook(req, req.params.id);
    const { quantity, customerName, studentId, discountAmount, paymentMethod } = req.body;
    
    // A book is a physical object, so the quantity must be a whole count. The
    // previous `!quantity || quantity <= 0` guard let anything else through and
    // the value flowed straight into `book.price * quantity` and
    // `SET stock = stock - ?`. Proven live: 0.5 sold for 50 AFN and left 9.5
    // copies in inventory, 0.001 left 4.999, and `[3]` was coerced to 3.
    // Fractional stock is corrupt inventory, not a smaller sale.
    //
    // assertSeatCount is the existing canonical whole-number boundary (finite,
    // integer, non-negative, bounded, same type discipline as assertMoney), so
    // it is reused rather than adding a second integer validator.
    let saleQuantity: number;
    try { saleQuantity = assertSeatCount(quantity, 'Quantity'); }
    catch { throw new HttpError(400, 'Quantity must be a whole number greater than zero.'); }
    if (saleQuantity <= 0) throw new HttpError(400, 'Quantity must be a whole number greater than zero.');
    if (book.stock < saleQuantity) throw new HttpError(409, `Insufficient stock (current stock: ${book.stock})`);

    const user = req.user;
    if (!user?.branchId || !user?.fullName) throw new HttpError(403, 'User context is missing.');
    if (studentId) {
      const student = db.prepare('SELECT branch_id FROM students WHERE id = ?').get(studentId) as { branch_id?: string } | undefined;
      if (!student) throw new HttpError(404, 'Student not found.');
      if (student.branch_id && student.branch_id !== book.branch_id) throw new HttpError(403, 'Student belongs to another branch.');
      // Financial integrity: a book is charged once per student. If the
      // payment desk already recorded a book/chapter payment for this
      // student+book, the sale desk must not charge it again.
      const alreadyPaid = db.prepare(
        `SELECT 1 FROM payments WHERE student_id = ? AND book_id = ? AND category IN ('book','chapter') AND status = 'completed' LIMIT 1`
      ).get(studentId, book.id);
      if (alreadyPaid) throw new HttpError(409, 'This book was already paid for by this student via the payment desk.');
    }

    // The sale decrements the stock of the book's own branch and records
    // revenue there. requireBook() already verified the operator can access
    // that branch (which may differ from the operator's JWT branch when an
    // owner/manager switches branches in the UI).
    const saleBranchId = book.branch_id;

    const totalAmount = book.price * saleQuantity;
    // Reject an over-large discount rather than capping it to the sale total,
    // which silently turned a mistyped figure into a free book. Same rule as
    // tuition payments and invoices.
    let requestedDiscount: number;
    try { requestedDiscount = assertMoney(discountAmount || 0, 'discount'); }
    catch { throw new HttpError(400, 'Discount must be a positive amount.'); }
    if (requestedDiscount > totalAmount) {
      throw new HttpError(400, `Discount cannot exceed the sale total of ${totalAmount} AFN.`);
    }
    const finalDiscount = requestedDiscount;
    const netAmount = totalAmount - finalDiscount;
    const categoryType = book.is_chapter ? 'chapter' : 'book';
    const method = paymentMethod || 'cash';
    const methodLabel = ({ cash: 'Cash', card: 'Card', transfer: 'Transfer' } as Record<string, string>)[method] || 'Cash';
    const date = today();
    const newSaleId = id('sale');

    // Duplicate protection for the sale desk. A double-click / retry created
    // one sale, one stock decrement and one income row PER CLICK. Same model
    // as the student payment desk: an explicit client key wins, otherwise a
    // fingerprint of the sale intent within a short window collapses retries.
    // A genuinely repeated sale (later, or explicitly keyed) still succeeds.
    const { candidates: saleIdemCandidates } = resolveIdempotency(req, {
      route: 'book-sale',
      bookId: book.id,
      studentId: studentId || null,
      customerName: customerName || null,
      quantity: saleQuantity,
      discount: finalDiscount,
      method,
      actorUserId: user.userId ?? null,
    });
    // A replay must be a replay OF THIS SALE. An `Idempotency-Key` is
    // caller-supplied, so a key already spent on another book or branch would
    // otherwise answer 200 for a sale that was never recorded here — stock
    // untouched, no income row, and the operator told it succeeded. Payroll
    // already applies this rule; so does invoice payment.
    const findPriorSale = () => db.prepare(
      `SELECT id, book_id, branch_id FROM book_sales WHERE idempotency_key IN (${saleIdemCandidates.map(() => '?').join(',')}) LIMIT 1`
    ).get(...saleIdemCandidates) as { id: string; book_id: string; branch_id: string } | undefined;
    const assertSameSale = (candidate: { book_id: string; branch_id: string }) => {
      if (candidate.book_id !== book.id || candidate.branch_id !== saleBranchId) {
        throw new HttpError(409, 'This idempotency key has already been used for a different sale.');
      }
    };
    const priorSale = findPriorSale();
    if (priorSale?.id) {
      assertSameSale(priorSale);
      return res.status(200).json({ id: priorSale.id, idempotentReplay: true });
    }
    const saleIdempotencyKey = saleIdemCandidates[0];

    const saleTx = db.transaction(() => {
      const stockUpdate = stmtUpdateBookStockSub.run(saleQuantity, book.id, saleBranchId, saleQuantity);
      if (stockUpdate.changes !== 1) throw new HttpError(409, 'Book stock changed or is insufficient. Please retry.');
      stmtInsertBookSale.run(
        newSaleId, book.id, saleQuantity, totalAmount, finalDiscount, netAmount, method, date, 
        customerName || 'Walk-in customer', studentId || null, saleBranchId, saleIdempotencyKey
      );
      recordIncome({
        category: categoryType,
        amount: netAmount,
        date,
        description: `Sold ${saleQuantity} copies of "${book.title}" to ${customerName || 'Walk-in customer'} (${methodLabel}${finalDiscount > 0 ? ` - with discount ${finalDiscount} AFN` : ''})`,
        referenceId: book.id,
        operatorName: user.fullName, operatorRole: req.rbac?.primaryRole ?? null,
        branchId: saleBranchId,
      });
    });

    try {
      saleTx();
    } catch (err) {
      // Atomic backstop: under concurrency several requests pass the check
      // above, but only one can win the unique index. Losers replay the
      // winner's sale instead of double-selling.
      if (String((err as { message?: string })?.message ?? '').includes('UNIQUE constraint failed')) {
        const winner = findPriorSale();
        if (winner?.id) {
          assertSameSale(winner);
          return res.status(200).json({ id: winner.id, idempotentReplay: true });
        }
        throw new HttpError(409, 'This idempotency key has already been used for a different sale.');
      }
      throw err;
    }

    addNotification('Book sale successful', `A total of ${saleQuantity} book copies were sold for a net amount of ${netAmount} AFN and recorded in the main account.`, 'success', saleBranchId);
    writeAudit(req, `Recorded book sale: ${saleQuantity} copies of ${book.title} for a total of ${totalAmount} AFN (net: ${netAmount} AFN, method: ${methodLabel})`);
    res.status(201).json({ id: newSaleId });
  })
);

booksRouter.post(
  '/sales/:saleId/refund',
  authorize('general_manager', 'finance_manager'),
  ah(async (req, res) => {
    const sale = stmtGetSaleById.get(req.params.saleId) as any;
    if (!sale) throw new HttpError(404, 'Sale invoice not found.');
    if (!canAccessBranchResource(req, sale.branch_id)) throw new HttpError(403, 'Sale belongs to another branch.');
    if (sale.status === 'refunded') throw new HttpError(409, 'This transaction has already been refunded.');

    const book = stmtGetBookById.get(sale.book_id) as any;
    const refundValue = sale.net_amount != null ? sale.net_amount : sale.total_amount;
    const categoryType = book && book.is_chapter ? 'chapter' : 'book';
    const date = today();

    const user = req.user;
    if (!user?.branchId || !user?.fullName) throw new HttpError(403, 'User context is missing.');

    // The contra-revenue entry lands in the sale's own branch (the branch
    // whose cash desk received the original revenue).
    const saleBranchId = sale.branch_id;

    db.transaction(() => {
      if (book) stmtUpdateBookStockAdd.run(sale.quantity, book.price, book.purchase_price, book.entry_date, book.id);
      stmtUpdateSaleStatus.run(sale.id);
      // The sale credits cash through recordIncome(); the refund MUST debit it
      // through the same path. Writing the contra row straight into
      // financial_transactions left the ledger saying -500 while the branch
      // cash account still held the 500 — 500 AFN of cash that existed in one
      // source of truth and not the other, and the gap grew with every refund.
      // recordIncome() also reclaims the savings sweep this sale triggered.
      recordIncome({
        category: categoryType + '_refund',
        amount: -refundValue,
        date,
        description: `Contra-revenue refund for book sale ${sale.id}`,
        referenceId: sale.id,
        operatorName: user.fullName, operatorRole: req.rbac?.primaryRole ?? null,
        branchId: saleBranchId,
      });
    })();

    addNotification('Book refund and return', `Sale invoice #${sale.id} was successfully refunded and ${sale.quantity} copies were returned to stock.`, 'info', saleBranchId);
    writeAudit(req, `Refunded book sale invoice: returned ${sale.quantity} copies and refunded ${refundValue} AFN`);
    res.json({ ok: true });
  })
);

export default booksRouter;