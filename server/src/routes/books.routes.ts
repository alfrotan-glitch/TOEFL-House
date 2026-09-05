import { Router, type Request } from 'express';
import { db } from '../db/connection.js';
import { authenticate, canAccessBranchResource, requirePermission, resolveBranchScope } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { resolveIdempotency } from '../utils/idempotency.js';
import { parsePagination } from '../utils/pagination.js';
import { addNotification } from '../utils/notifications.js';
import {
  adjustBookStock,
  createBookCatalogItem,
  getBookBranch,
  getBookLoanBranch,
  getBookSaleBranch,
  getBooksWorkspace,
  issueBookLoan,
  patchBookCatalogItem,
  postBookSale,
  receiveBookStock,
  returnBookLoan,
  returnBookSale,
  type BooksActor,
} from '../core/books/books-service.js';

export const booksRouter = Router();
booksRouter.use(authenticate);

// Bounded operational history: enough context for a desk page while preserving
// database and payload limits under a growing sales/loan ledger.
const BOOK_HISTORY_DEFAULT_PAGE_SIZE = 50;
const BOOK_HISTORY_MAX_PAGE_SIZE = 100;

function actor(req: Request): BooksActor {
  if (!req.user?.userId || !req.user.fullName) throw new HttpError(403, 'User context is missing.');
  return {
    userId: req.user.userId,
    fullName: req.user.fullName,
    role: req.rbac?.primaryRole ?? null,
  };
}

function bodyBranchId(req: Request): string {
  const requested = req.body?.branchId;
  if (requested !== undefined && (typeof requested !== 'string' || !requested.trim())) {
    throw new HttpError(400, 'branchId must be a non-empty string when supplied.');
  }
  if (typeof requested === 'string' && requested.trim()) {
    const branchId = requested.trim();
    if (!canAccessBranchResource(req, branchId)) throw new HttpError(403, 'Target branch is outside your authorized scope.');
    return branchId;
  }
  const scope = resolveBranchScope(req);
  if (scope.isAll || !scope.branchId) throw new HttpError(400, 'Select one branch before recording a Book command.');
  return scope.branchId;
}

function accessibleBookBranch(req: Request, bookId: string): string {
  const branchId = getBookBranch(db, bookId);
  if (!canAccessBranchResource(req, branchId)) throw new HttpError(403, 'Book belongs to another branch.');
  return branchId;
}

function accessibleSaleBranch(req: Request, saleId: string): string {
  const branchId = getBookSaleBranch(db, saleId);
  if (!canAccessBranchResource(req, branchId)) throw new HttpError(403, 'Book sale belongs to another branch.');
  return branchId;
}

function accessibleLoanBranch(req: Request, loanId: string): string {
  const branchId = getBookLoanBranch(db, loanId);
  if (!canAccessBranchResource(req, branchId)) throw new HttpError(403, 'Book loan belongs to another branch.');
  return branchId;
}

function intentValue(value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value);
}

booksRouter.get(
  '/workspace',
  requirePermission('Book.View'),
  ah(async (req, res) => {
    const scope = resolveBranchScope(req);
    const pagination = parsePagination(req, {
      defaultPageSize: BOOK_HISTORY_DEFAULT_PAGE_SIZE,
      maxPageSize: BOOK_HISTORY_MAX_PAGE_SIZE,
    });
    res.json(getBooksWorkspace(db, scope, pagination));
  }),
);

booksRouter.post(
  '/catalog',
  requirePermission('Book.Create'),
  ah(async (req, res) => {
    const branchId = bodyBranchId(req);
    const idem = resolveIdempotency(req, {
      route: 'book-catalog-create',
      branchId,
      title: intentValue(req.body?.title),
      itemKind: intentValue(req.body?.itemKind),
      saleEnabled: intentValue(req.body?.saleEnabled),
      salePrice: intentValue(req.body?.salePrice),
      lendingEnabled: intentValue(req.body?.lendingEnabled),
      initialQuantity: intentValue(req.body?.initialQuantity),
      unitCost: intentValue(req.body?.unitCost),
      purchase: intentValue(req.body?.purchase),
      actorUserId: req.user?.userId ?? null,
    });
    const result = createBookCatalogItem(db, {
      ...req.body,
      branchId,
      idempotencyKey: idem.key,
      idempotencyCandidates: idem.candidates,
      actor: actor(req),
    });
    if (!result.idempotentReplay) {
      writeAudit(req, `Created Book catalog item ${result.id}`, { branchId });
      addNotification('Book catalog item created', 'A Book catalog item and its initial stock receipt were recorded.', 'success', branchId);
    }
    res.status(result.idempotentReplay ? 200 : 201).json(result);
  }),
);

booksRouter.post(
  '/catalog/:bookId/adjustments',
  requirePermission('Book.Edit'),
  ah(async (req, res) => {
    const branchId = accessibleBookBranch(req, req.params.bookId);
    const idem = resolveIdempotency(req, {
      route: 'book-stock-adjustment',
      bookId: req.params.bookId,
      delta: intentValue(req.body?.delta),
      kind: intentValue(req.body?.kind),
      reason: intentValue(req.body?.reason),
      actorUserId: req.user?.userId ?? null,
    });
    const result = adjustBookStock(db, req.params.bookId, branchId, {
      delta: req.body?.delta,
      kind: req.body?.kind,
      adjustedOn: req.body?.adjustedOn,
      reason: req.body?.reason,
      idempotencyKey: idem.key,
      idempotencyCandidates: idem.candidates,
      actor: actor(req),
    });
    if (!result.idempotentReplay) {
      writeAudit(req, `Recorded Book stock adjustment ${result.id} (${req.body?.kind} ${req.body?.delta})`, { branchId });
      addNotification('Book stock adjusted', `A ${req.body?.kind} stock adjustment (${req.body?.delta}) was recorded.`, 'warning', branchId);
    }
    res.status(result.idempotentReplay ? 200 : 201).json(result);
  }),
);

booksRouter.patch(
  '/catalog/:bookId',
  requirePermission('Book.Edit'),
  ah(async (req, res) => {
    const branchId = accessibleBookBranch(req, req.params.bookId);
    patchBookCatalogItem(db, req.params.bookId, branchId, req.body ?? {});
    writeAudit(req, `Updated Book catalog item ${req.params.bookId}`, { branchId });
    res.json({ ok: true });
  }),
);

booksRouter.post(
  '/catalog/:bookId/receipts',
  requirePermission('Book.Restock'),
  ah(async (req, res) => {
    const branchId = accessibleBookBranch(req, req.params.bookId);
    const idem = resolveIdempotency(req, {
      route: 'book-stock-receipt',
      bookId: req.params.bookId,
      quantity: intentValue(req.body?.quantity),
      receivedOn: intentValue(req.body?.receivedOn),
      unitCost: intentValue(req.body?.unitCost),
      note: intentValue(req.body?.note),
      purchase: intentValue(req.body?.purchase),
      actorUserId: req.user?.userId ?? null,
    });
    const result = receiveBookStock(db, req.params.bookId, branchId, {
      ...req.body,
      idempotencyKey: idem.key,
      idempotencyCandidates: idem.candidates,
      actor: actor(req),
    });
    if (!result.idempotentReplay) {
      writeAudit(req, `Recorded Book stock receipt ${result.id}`, { branchId });
      addNotification('Book stock received', 'A Book stock receipt was recorded.', 'success', branchId);
    }
    res.status(result.idempotentReplay ? 200 : 201).json(result);
  }),
);

booksRouter.post(
  '/catalog/:bookId/sales',
  requirePermission('Book.Sell'),
  ah(async (req, res) => {
    const branchId = accessibleBookBranch(req, req.params.bookId);
    const idem = resolveIdempotency(req, {
      route: 'book-sale',
      bookId: req.params.bookId,
      quantity: intentValue(req.body?.quantity),
      studentId: intentValue(req.body?.studentId),
      purchaserName: intentValue(req.body?.purchaserName),
      discountAmount: intentValue(req.body?.discountAmount),
      paymentMethod: intentValue(req.body?.paymentMethod),
      soldOn: intentValue(req.body?.soldOn),
      actorUserId: req.user?.userId ?? null,
    });
    const result = postBookSale(db, req.params.bookId, branchId, {
      ...req.body,
      idempotencyKey: idem.key,
      idempotencyCandidates: idem.candidates,
      actor: actor(req),
    });
    if (!result.idempotentReplay) {
      writeAudit(req, `Recorded Book sale ${result.id}`, { branchId });
      addNotification('Book sale recorded', `Book sale receipt ${result.receiptNumber} was recorded.`, 'success', branchId);
    }
    res.status(result.idempotentReplay ? 200 : 201).json(result);
  }),
);

booksRouter.post(
  '/sales/:saleId/return',
  requirePermission('Book.Refund'),
  ah(async (req, res) => {
    const branchId = accessibleSaleBranch(req, req.params.saleId);
    const idem = resolveIdempotency(req, {
      route: 'book-sale-return',
      saleId: req.params.saleId,
      returnedOn: intentValue(req.body?.returnedOn),
      reason: intentValue(req.body?.reason),
      actorUserId: req.user?.userId ?? null,
    });
    const result = returnBookSale(db, req.params.saleId, branchId, {
      ...req.body,
      idempotencyKey: idem.key,
      idempotencyCandidates: idem.candidates,
      actor: actor(req),
    });
    if (!result.idempotentReplay) {
      writeAudit(req, `Returned and refunded Book sale ${req.params.saleId}`, { branchId });
      addNotification('Book sale returned', `Book sale return receipt ${result.receiptNumber} was recorded.`, 'info', branchId);
    }
    res.status(result.idempotentReplay ? 200 : 201).json(result);
  }),
);

booksRouter.post(
  '/catalog/:bookId/loans',
  requirePermission('Book.Issue'),
  ah(async (req, res) => {
    const branchId = accessibleBookBranch(req, req.params.bookId);
    const idem = resolveIdempotency(req, {
      route: 'book-loan-issue',
      bookId: req.params.bookId,
      studentId: intentValue(req.body?.studentId),
      issuedOn: intentValue(req.body?.issuedOn),
      dueOn: intentValue(req.body?.dueOn),
      actorUserId: req.user?.userId ?? null,
    });
    const result = issueBookLoan(db, req.params.bookId, branchId, {
      ...req.body,
      idempotencyKey: idem.key,
      idempotencyCandidates: idem.candidates,
      actor: actor(req),
    });
    if (!result.idempotentReplay) {
      writeAudit(req, `Issued Book loan ${result.id}`, { branchId });
      addNotification('Book issued', 'A Book was issued to a student with an explicit due date.', 'success', branchId);
    }
    res.status(result.idempotentReplay ? 200 : 201).json(result);
  }),
);

booksRouter.post(
  '/loans/:loanId/return',
  requirePermission('Book.Return'),
  ah(async (req, res) => {
    const branchId = accessibleLoanBranch(req, req.params.loanId);
    const idem = resolveIdempotency(req, {
      route: 'book-loan-return',
      loanId: req.params.loanId,
      returnedOn: intentValue(req.body?.returnedOn),
      note: intentValue(req.body?.note),
      actorUserId: req.user?.userId ?? null,
    });
    const result = returnBookLoan(db, req.params.loanId, branchId, {
      ...req.body,
      idempotencyKey: idem.key,
      idempotencyCandidates: idem.candidates,
      actor: actor(req),
    });
    if (!result.idempotentReplay) {
      writeAudit(req, `Returned Book loan ${req.params.loanId}`, { branchId });
      addNotification('Book returned', 'The Book loan return was recorded.', 'success', branchId);
    }
    res.status(result.idempotentReplay ? 200 : 201).json(result);
  }),
);

export default booksRouter;
