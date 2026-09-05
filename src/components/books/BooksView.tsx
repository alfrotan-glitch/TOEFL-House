import React, { useMemo, useState } from 'react';
import {
  BookOpen, BookOpenCheck, ClipboardCheck,
  HandCoins, LibraryBig, PackagePlus, Pencil, Plus, Printer,
  ReceiptText, RefreshCcw, RotateCcw, Search, Undo2,
} from 'lucide-react';
import type { BookCatalogItem, BookLoan, BookSale, BooksWorkspace, BudgetLine, Student } from '../../types';
import type { DocumentIssuer } from '../../config/documentIssuer';
import { formatAFN } from '../../utils/format';
import { hasPermission } from '../../config/permissions';
import { openPrintDocument } from '../../design-system/print';
import { badge, button, control, cx, layout, surface, table, text } from '../../design-system/styles';
import ShamsiDateInput from '../common/ShamsiDateInput';

interface BooksViewProps {
  issuer: DocumentIssuer;
  workspace: BooksWorkspace | null;
  students: Student[];
  permissionCodes?: string[];
  createBookCatalogItem: (input: {
    title: string;
    itemKind: 'book' | 'chapter';
    saleEnabled: boolean;
    salePrice?: number | null;
    lendingEnabled: boolean;
    initialQuantity: number;
    receivedOn?: string;
    unitCost?: number | null;
    note?: string;
    purchase?: { paidFromBudgetLineId?: string; declaration?: 'separate' | 'not-applicable' };
  }) => Promise<void>;
  budgetLines: BudgetLine[];
  updateBookCatalogItem: (bookId: string, input: {
    title?: string;
    saleEnabled?: boolean;
    salePrice?: number | null;
    lendingEnabled?: boolean;
    defaultUnitCost?: number | null;
    status?: 'active' | 'archived';
  }) => Promise<void>;
  receiveBookStock: (bookId: string, input: { quantity: number; receivedOn?: string; unitCost?: number | null; note?: string; purchase?: { paidFromBudgetLineId?: string; declaration?: 'separate' | 'not-applicable' } }) => Promise<void>;
  adjustBookStock: (bookId: string, input: { delta: number; kind: 'loss' | 'found' | 'correction'; reason: string; adjustedOn?: string }) => Promise<void>;
  recordBookSale: (bookId: string, input: {
    quantity: number;
    purchaserName?: string;
    studentId?: string;
    discountAmount?: number;
    paymentMethod?: 'cash' | 'card' | 'bank_transfer';
    soldOn?: string;
  }) => Promise<void>;
  returnBookSale: (saleId: string, input: { reason: string; returnedOn?: string }) => Promise<void>;
  issueBookLoan: (bookId: string, input: { studentId: string; dueOn: string; issuedOn?: string }) => Promise<void>;
  returnBookLoan: (loanId: string, input: { returnedOn?: string; note?: string }) => Promise<void>;
  loadBooksHistoryPage: (page: number) => Promise<void>;
}

type BooksTab = 'catalog' | 'sales' | 'loans' | 'receipts';
type Dialog =
  | { kind: 'catalog' }
  | { kind: 'edit'; book: BookCatalogItem }
  | { kind: 'receipt'; book: BookCatalogItem }
  | { kind: 'adjust'; book: BookCatalogItem }
  | { kind: 'sale'; book: BookCatalogItem }
  | { kind: 'saleReturn'; sale: BookSale }
  | { kind: 'loan'; book: BookCatalogItem }
  | { kind: 'loanReturn'; loan: BookLoan }
  | null;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The command could not be completed. Please try again.';
}

function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function itemKindLabel(kind: 'book' | 'chapter'): string {
  return kind === 'chapter' ? 'Skill chapter' : 'Book';
}

function statusTone(status: BookCatalogItem['status']) {
  return status === 'active' ? badge.success : badge.neutral;
}

function dialogTitle(dialog: Exclude<Dialog, null>): string {
  switch (dialog.kind) {
    case 'catalog': return 'Create catalog item';
    case 'edit': return `Edit ${dialog.book.title}`;
    case 'receipt': return `Receive stock · ${dialog.book.title}`;
    case 'adjust': return `Adjust stock · ${dialog.book.title}`;
    case 'sale': return `Record sale · ${dialog.book.title}`;
    case 'saleReturn': return `Return sale ${dialog.sale.receiptNumber}`;
    case 'loan': return `Issue loan · ${dialog.book.title}`;
    case 'loanReturn': return `Return loan · ${dialog.loan.bookTitle}`;
  }
}

export default function BooksView({
  issuer,
  workspace,
  students,
  permissionCodes,
  createBookCatalogItem,
  updateBookCatalogItem,
  receiveBookStock,
  recordBookSale,
  returnBookSale,
  issueBookLoan,
  returnBookLoan,
  loadBooksHistoryPage,
  budgetLines,
  adjustBookStock,
}: BooksViewProps) {
  const [tab, setTab] = useState<BooksTab>('catalog');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [catalogTitle, setCatalogTitle] = useState('');
  const [catalogKind, setCatalogKind] = useState<'book' | 'chapter'>('book');
  const [catalogSaleEnabled, setCatalogSaleEnabled] = useState(true);
  const [catalogSalePrice, setCatalogSalePrice] = useState('');
  const [catalogLendingEnabled, setCatalogLendingEnabled] = useState(false);
  const [catalogQuantity, setCatalogQuantity] = useState('1');
  const [catalogUnitCost, setCatalogUnitCost] = useState('');
  const [catalogReceivedOn, setCatalogReceivedOn] = useState('');

  const [editTitle, setEditTitle] = useState('');
  const [editSaleEnabled, setEditSaleEnabled] = useState(true);
  const [editSalePrice, setEditSalePrice] = useState('');
  const [editLendingEnabled, setEditLendingEnabled] = useState(false);
  const [editDefaultUnitCost, setEditDefaultUnitCost] = useState('');
  const [editStatus, setEditStatus] = useState<'active' | 'archived'>('active');

  const [receiptQuantity, setReceiptQuantity] = useState('1');
  const [receiptUnitCost, setReceiptUnitCost] = useState('');
  const [receiptDate, setReceiptDate] = useState('');
  const [receiptNote, setReceiptNote] = useState('');
  // Acquisition accounting (W6-1): costly stock must declare how it is paid.
  const [catalogPurchaseMode, setCatalogPurchaseMode] = useState('');
  const [catalogPurchaseLine, setCatalogPurchaseLine] = useState('');
  const [receiptPurchaseMode, setReceiptPurchaseMode] = useState('');
  const [receiptPurchaseLine, setReceiptPurchaseLine] = useState('');
  const [adjustDelta, setAdjustDelta] = useState('-1');
  const [adjustKind, setAdjustKind] = useState<'loss' | 'found' | 'correction'>('loss');
  const [adjustReason, setAdjustReason] = useState('');
  const purchasePayload = (mode: string, lineId: string) =>
    mode === 'paid-here' ? (lineId ? { paidFromBudgetLineId: lineId } : undefined)
      : mode === 'separate' || mode === 'not-applicable' ? { declaration: mode as 'separate' | 'not-applicable' }
        : undefined;

  const [saleQuantity, setSaleQuantity] = useState('1');
  const [saleStudentId, setSaleStudentId] = useState('');
  const [salePurchaserName, setSalePurchaserName] = useState('');
  const [saleDiscount, setSaleDiscount] = useState('0');
  const [salePaymentMethod, setSalePaymentMethod] = useState<'cash' | 'card' | 'bank_transfer'>('cash');
  const [saleDate, setSaleDate] = useState('');

  const [saleReturnReason, setSaleReturnReason] = useState('');
  const [saleReturnDate, setSaleReturnDate] = useState('');
  const [loanStudentId, setLoanStudentId] = useState('');
  const [loanDueOn, setLoanDueOn] = useState('');
  const [loanIssuedOn, setLoanIssuedOn] = useState('');
  const [loanReturnDate, setLoanReturnDate] = useState('');
  const [loanReturnNote, setLoanReturnNote] = useState('');

  const canCreate = hasPermission(permissionCodes, 'Book.Create');
  const canEdit = hasPermission(permissionCodes, 'Book.Edit');
  const canRestock = hasPermission(permissionCodes, 'Book.Restock');
  const canSell = hasPermission(permissionCodes, 'Book.Sell');
  const canRefund = hasPermission(permissionCodes, 'Book.Refund');
  const canIssue = hasPermission(permissionCodes, 'Book.Issue');
  const canReturn = hasPermission(permissionCodes, 'Book.Return');

  const branchStudents = useMemo(
    () => students.filter((student) => student.branchId === undefined || workspace?.catalog.some((book) => book.branchId === student.branchId)),
    [students, workspace?.catalog],
  );
  const filteredCatalog = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase();
    if (!normalized) return workspace?.catalog ?? [];
    return (workspace?.catalog ?? []).filter((book) =>
      book.title.toLocaleLowerCase().includes(normalized) || itemKindLabel(book.itemKind).toLocaleLowerCase().includes(normalized),
    );
  }, [search, workspace?.catalog]);

  const selectTab = (next: BooksTab) => {
    setTab(next);
    // One bounded workspace request pages all histories. Reset when changing
    // history type so a sparse receipt/loan ledger never renders an empty page
    // merely because the previous sales view was on a later page.
    const currentPage = next === 'sales' ? workspace?.sales.page
      : next === 'loans' ? workspace?.loans.page
        : next === 'receipts' ? workspace?.receipts.page
          : 1;
    if (next !== 'catalog' && currentPage && currentPage !== 1) void loadBooksHistoryPage(1);
  };

  const openCatalog = () => {
    setCatalogTitle('');
    setCatalogKind('book');
    setCatalogSaleEnabled(true);
    setCatalogSalePrice('');
    setCatalogLendingEnabled(false);
    setCatalogQuantity('1');
    setCatalogUnitCost('');
    setCatalogReceivedOn('');
    setDialog({ kind: 'catalog' });
  };

  const openEdit = (book: BookCatalogItem) => {
    setEditTitle(book.title);
    setEditSaleEnabled(book.saleEnabled);
    setEditSalePrice(book.salePrice == null ? '' : String(book.salePrice));
    setEditLendingEnabled(book.lendingEnabled);
    setEditDefaultUnitCost(book.defaultUnitCost == null ? '' : String(book.defaultUnitCost));
    setEditStatus(book.status);
    setDialog({ kind: 'edit', book });
  };

  const openReceipt = (book: BookCatalogItem) => {
    setReceiptQuantity('1');
    setReceiptUnitCost(book.defaultUnitCost == null ? '' : String(book.defaultUnitCost));
    setReceiptDate('');
    setReceiptNote('');
    setDialog({ kind: 'receipt', book });
  };

  const openAdjust = (book: BookCatalogItem) => {
    setAdjustDelta('-1');
    setAdjustKind('loss');
    setAdjustReason('');
    setDialog({ kind: 'adjust', book });
  };

  const openSale = (book: BookCatalogItem) => {
    setSaleQuantity('1');
    setSaleStudentId('');
    setSalePurchaserName('');
    setSaleDiscount('0');
    setSalePaymentMethod('cash');
    setSaleDate('');
    setDialog({ kind: 'sale', book });
  };

  const openLoan = (book: BookCatalogItem) => {
    setLoanStudentId('');
    setLoanDueOn('');
    setLoanIssuedOn('');
    setDialog({ kind: 'loan', book });
  };

  const submit = async (work: () => Promise<void>, success: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
      setDialog(null);
      setToast({ type: 'success', text: success });
    } catch (error) {
      setToast({ type: 'error', text: messageOf(error) });
    } finally {
      setBusy(false);
    }
  };

  const printSale = (sale: BookSale) => {
    const issuerLines = [issuer.branchName, issuer.address, issuer.phone, issuer.email]
      .filter((value): value is string => Boolean(value))
      .map((value) => `<div>${escapeHtml(value)}</div>`)
      .join('');
    const opened = openPrintDocument({
      title: `Book sale ${sale.receiptNumber}`,
      paper: 'receipt80',
      hideFooter: true,
      bodyHtml: `<main class="th-receipt">
        <header class="th-receipt-head"><h1 class="th-title">Book sale receipt</h1>${issuerLines}<div>Receipt: ${escapeHtml(sale.receiptNumber)}</div></header>
        <table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead><tbody>
          <tr><td>${escapeHtml(sale.bookTitle)}</td><td class="num">${sale.quantity}</td><td class="num">${escapeHtml(formatAFN(sale.netAmount))}</td></tr>
        </tbody></table>
        <p>Purchaser: ${escapeHtml(sale.studentName ?? sale.purchaserName)}</p>
        <p>Sale date: ${escapeHtml(sale.soldOn)}</p>
        ${sale.discountAmount > 0 ? `<p>Discount: ${escapeHtml(formatAFN(sale.discountAmount))}</p>` : ''}
        <p class="th-total">Total: ${escapeHtml(formatAFN(sale.netAmount))}</p>
      </main>`,
    });
    if (!opened) setToast({ type: 'error', text: 'The print window was blocked. Allow pop-ups and try again.' });
  };

  if (!workspace) {
    return (
      <section className={cx(surface.panel, 'p-8 text-center')} aria-busy="true">
        <LibraryBig className="mx-auto h-8 w-8 text-brand-600" />
        <h2 className="mt-3 text-lg font-bold text-slate-900">Loading Books workspace</h2>
        <p className={text.hint}>Inventory, sales and lending facts are being loaded from the server.</p>
      </section>
    );
  }

  return (
    <section className="space-y-6" aria-labelledby="books-page-title">
      {toast && (
        <div role="status" className={cx('rounded-xl border px-4 py-3 text-sm font-medium', toast.type === 'success'
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
          : 'border-rose-200 bg-rose-50 text-rose-800')}>
          {toast.text}
        </div>
      )}

      <header className="flex flex-col gap-4 border-b border-slate-200 pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className={layout.inline}>
            <LibraryBig className="h-6 w-6 text-brand-600" aria-hidden="true" />
            <h1 id="books-page-title" className="text-xl font-extrabold text-slate-900">Books, sales & lending</h1>
          </div>
          <p className={text.hint}>Catalog facts, available copies, cash receipts and student custody are reconciled by the server.</p>
        </div>
        {canCreate && <button type="button" className={button.primary} onClick={openCatalog}><Plus className="h-4 w-4" />Create catalog item</button>}
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Available copies" value={workspace.summary.availableQuantity} icon={<BookOpen className="h-4 w-4" />} />
        <Metric label="Active loans" value={workspace.summary.activeLoans} icon={<BookOpenCheck className="h-4 w-4" />} tone={workspace.summary.overdueLoans > 0 ? 'warning' : 'default'} detail={workspace.summary.overdueLoans > 0 ? `${workspace.summary.overdueLoans} overdue` : 'No overdue loans'} />
        <Metric label="Posted sales" value={workspace.summary.soldQuantity} icon={<ReceiptText className="h-4 w-4" />} detail={`${formatAFN(workspace.summary.salesRevenue)} recognized`} />
        <Metric label="Returned sales" value={formatAFN(workspace.summary.returnedSalesValue)} icon={<Undo2 className="h-4 w-4" />} tone="default" detail="Full returned-sale contra facts" />
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <nav aria-label="Books sections" className="flex flex-wrap gap-2">
          {([
            ['catalog', 'Catalog'], ['sales', 'Sales'], ['loans', 'Lending'], ['receipts', 'Stock receipts'],
          ] as Array<[BooksTab, string]>).map(([key, label]) => (
            <button key={key} type="button" onClick={() => selectTab(key)} aria-current={tab === key ? 'page' : undefined}
              className={cx(button.secondary, tab === key && 'border-brand-300 bg-brand-50 text-brand-800')}>
              {label}
            </button>
          ))}
        </nav>
        {tab === 'catalog' && (
          <label className="relative block w-full lg:w-80">
            <span className="sr-only">Search catalog</span>
            <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-slate-400" aria-hidden="true" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} className={cx(control.input, 'ps-9')} placeholder="Search catalog" />
          </label>
        )}
      </div>

      {tab === 'catalog' && (
        <div className={cx(surface.panel, 'overflow-x-auto')}>
          <table className="min-w-full">
            <thead className="border-b border-slate-200 bg-slate-50"><tr>
              <th className={table.headCell}>Catalog item</th><th className={table.headCell}>Availability</th><th className={table.headCell}>Capabilities</th><th className={table.headCell}>Status</th><th className={cx(table.headCell, 'text-end')}>Actions</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {filteredCatalog.map((book) => (
                <tr key={book.id}>
                  <td className={table.cell}><div className="font-semibold text-slate-900">{book.title}</div><div className={text.meta}>{itemKindLabel(book.itemKind)} · {book.saleEnabled ? formatAFN(book.salePrice ?? 0) : 'Not for sale'}</div></td>
                  <td className={table.cell}><span className={book.availableQuantity > 0 ? badge.success : badge.danger}>{book.availableQuantity} available</span><div className={text.meta}>Received {book.receivedQuantity} · sold {book.soldQuantity} · loaned {book.loanedQuantity}</div></td>
                  <td className={table.cell}><div className="flex flex-wrap gap-1">{book.saleEnabled && <span className={badge.neutral}>Sale</span>}{book.lendingEnabled && <span className={badge.neutral}>Lending</span>}</div></td>
                  <td className={table.cell}><span className={statusTone(book.status)}>{book.status}</span></td>
                  <td className={cx(table.cell, 'whitespace-nowrap text-end')}>
                    <div className="inline-flex flex-wrap justify-end gap-2">
                      {canRestock && book.status === 'active' && <button type="button" className={button.ghost} onClick={() => openReceipt(book)}><PackagePlus className="h-4 w-4" />Stock</button>}
                      {canSell && book.status === 'active' && book.saleEnabled && <button type="button" className={button.ghost} onClick={() => openSale(book)} disabled={book.availableQuantity <= 0}><HandCoins className="h-4 w-4" />Sell</button>}
                      {canIssue && book.status === 'active' && book.lendingEnabled && <button type="button" className={button.ghost} onClick={() => openLoan(book)} disabled={book.availableQuantity <= 0}><BookOpenCheck className="h-4 w-4" />Issue</button>}
                      {canEdit && book.status === 'active' && <button type="button" className={button.ghost} onClick={() => openAdjust(book)}><ClipboardCheck className="h-4 w-4" />Adjust</button>}
                      {canEdit && <button type="button" className={button.ghost} onClick={() => openEdit(book)}><Pencil className="h-4 w-4" />Edit</button>}
                    </div>
                  </td>
                </tr>
              ))}
              {filteredCatalog.length === 0 && <EmptyRow columns={5} title="No catalog items match this view." detail={canCreate ? 'Create a catalog item to record an initial immutable stock receipt.' : 'Ask a Book administrator to create a catalog item.'} />}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'sales' && (
        <>
        <div className={cx(surface.panel, 'overflow-x-auto')}>
          <table className="min-w-full"><thead className="border-b border-slate-200 bg-slate-50"><tr>
            <th className={table.headCell}>Receipt</th><th className={table.headCell}>Item / purchaser</th><th className={table.headCell}>Date</th><th className={table.numericCell}>Net amount</th><th className={table.headCell}>Lifecycle</th><th className={cx(table.headCell, 'text-end')}>Actions</th>
          </tr></thead><tbody className="divide-y divide-slate-100">
            {workspace.sales.items.map((sale) => <tr key={sale.id}>
              <td className={table.cell}><span className="font-mono text-xs font-semibold text-slate-700">{sale.receiptNumber}</span></td>
              <td className={table.cell}><div className="font-semibold text-slate-900">{sale.bookTitle} × {sale.quantity}</div><div className={text.meta}>{sale.studentName ?? sale.purchaserName}</div></td>
              <td className={table.cell}>{sale.soldOn}</td>
              <td className={table.numericCell}>{formatAFN(sale.netAmount)}</td>
              <td className={table.cell}>{sale.refunded ? <><span className={badge.neutral}>Returned</span><div className={text.meta}>{sale.returnedOn} · {sale.refundReason}</div></> : <span className={badge.success}>Posted</span>}</td>
              <td className={cx(table.cell, 'text-end')}><div className="inline-flex gap-2"><button type="button" className={button.ghost} onClick={() => printSale(sale)}><Printer className="h-4 w-4" />Print</button>{canRefund && !sale.refunded && <button type="button" className={button.ghost} onClick={() => { setSaleReturnReason(''); setSaleReturnDate(''); setDialog({ kind: 'saleReturn', sale }); }}><RotateCcw className="h-4 w-4" />Return</button>}</div></td>
            </tr>)}
            {workspace.sales.items.length === 0 && <EmptyRow columns={6} title="No Book sales have been recorded." detail="A Book sale creates one linked cash receipt and income fact." />}
          </tbody></table>
        </div>
        <HistoryPagination page={workspace.sales.page} pageSize={workspace.sales.pageSize} total={workspace.sales.total} onPage={(page) => { void loadBooksHistoryPage(page); }} />
        </>
      )}

      {tab === 'loans' && (
        <>
        <div className={cx(surface.panel, 'overflow-x-auto')}>
          <table className="min-w-full"><thead className="border-b border-slate-200 bg-slate-50"><tr>
            <th className={table.headCell}>Book</th><th className={table.headCell}>Student</th><th className={table.headCell}>Issued / due</th><th className={table.headCell}>Lifecycle</th><th className={cx(table.headCell, 'text-end')}>Actions</th>
          </tr></thead><tbody className="divide-y divide-slate-100">
            {workspace.loans.items.map((loan) => <tr key={loan.id}>
              <td className={table.cell}><div className="font-semibold text-slate-900">{loan.bookTitle}</div><div className={text.meta}>{itemKindLabel(loan.itemKind)}</div></td>
              <td className={table.cell}>{loan.studentName}</td>
              <td className={table.cell}><div>{loan.issuedOn}</div><div className={text.meta}>Due {loan.dueOn}</div></td>
              <td className={table.cell}>{loan.returned ? <><span className={badge.success}>Returned</span><div className={text.meta}>{loan.returnedOn}</div></> : loan.overdue ? <span className={badge.danger}>Overdue</span> : <span className={badge.warning}>Issued</span>}</td>
              <td className={cx(table.cell, 'text-end')}>{canReturn && !loan.returned && <button type="button" className={button.ghost} onClick={() => { setLoanReturnDate(''); setLoanReturnNote(''); setDialog({ kind: 'loanReturn', loan }); }}><ClipboardCheck className="h-4 w-4" />Return</button>}</td>
            </tr>)}
            {workspace.loans.items.length === 0 && <EmptyRow columns={5} title="No Book loans have been recorded." detail="A loan reserves one available copy without creating a financial transaction." />}
          </tbody></table>
        </div>
        <HistoryPagination page={workspace.loans.page} pageSize={workspace.loans.pageSize} total={workspace.loans.total} onPage={(page) => { void loadBooksHistoryPage(page); }} />
        </>
      )}

      {tab === 'receipts' && (
        <>
        <div className={cx(surface.panel, 'overflow-x-auto')}>
          <table className="min-w-full"><thead className="border-b border-slate-200 bg-slate-50"><tr>
            <th className={table.headCell}>Book</th><th className={table.headCell}>Received</th><th className={table.numericCell}>Quantity</th><th className={table.numericCell}>Unit cost</th><th className={table.headCell}>Recorded by</th>
          </tr></thead><tbody className="divide-y divide-slate-100">
            {workspace.receipts.items.map((receipt) => <tr key={receipt.id}><td className={table.cell}>{receipt.bookTitle}</td><td className={table.cell}>{receipt.receivedOn}</td><td className={table.numericCell}>{receipt.quantity}</td><td className={table.numericCell}>{receipt.unitCost == null ? '—' : formatAFN(receipt.unitCost)}</td><td className={table.cell}>{receipt.receivedByName}</td></tr>)}
            {workspace.receipts.items.length === 0 && <EmptyRow columns={5} title="No stock receipts have been recorded." detail="Catalog creation and every restock write an immutable receipt." />}
          </tbody></table>
        </div>
        <HistoryPagination page={workspace.receipts.page} pageSize={workspace.receipts.pageSize} total={workspace.receipts.total} onPage={(page) => { void loadBooksHistoryPage(page); }} />
        </>
      )}

      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="books-dialog-title" className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
            <div className="mb-5 flex items-center justify-between gap-4 border-b border-slate-200 pb-4">
              <h2 id="books-dialog-title" className="text-base font-extrabold text-slate-900">{dialogTitle(dialog)}</h2>
              <button type="button" className={button.ghost} onClick={() => setDialog(null)} disabled={busy}>Close</button>
            </div>

            {dialog.kind === 'catalog' && <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(() => createBookCatalogItem({ title: catalogTitle, itemKind: catalogKind, saleEnabled: catalogSaleEnabled, salePrice: catalogSaleEnabled ? Number(catalogSalePrice) : null, lendingEnabled: catalogLendingEnabled, initialQuantity: Number(catalogQuantity), receivedOn: catalogReceivedOn || undefined, unitCost: catalogUnitCost === '' ? null : Number(catalogUnitCost), purchase: purchasePayload(catalogPurchaseMode, catalogPurchaseLine) }), 'Catalog item and initial stock receipt created.'); }}>
              <Field label="Title"><input required value={catalogTitle} onChange={(event) => setCatalogTitle(event.target.value)} className={control.input} /></Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><Field label="Initial quantity"><input required min="1" step="1" type="number" value={catalogQuantity} onChange={(event) => setCatalogQuantity(event.target.value)} className={control.input} /></Field><Field label="Unit cost (optional AFN)"><input min="0" step="1" type="number" value={catalogUnitCost} onChange={(event) => setCatalogUnitCost(event.target.value)} className={control.input} /></Field></div>
              <div className="grid grid-cols-1 gap-2 rounded-md border border-amber-300/60 bg-amber-50/60 p-3 text-xs">
                <span className={text.hint}>How is this purchase paid? (required when a unit cost is given)</span>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <select value={catalogPurchaseMode} onChange={(event) => setCatalogPurchaseMode(event.target.value)} className={control.select} required={catalogUnitCost !== '' && Number(catalogUnitCost) > 0}>
                    <option value="">Choose…</option>
                    <option value="paid-here">Pay now from a budget line</option>
                    <option value="separate">Recorded separately (expense workflow)</option>
                    <option value="not-applicable">No payment — donation / internal transfer</option>
                  </select>
                  {catalogPurchaseMode === 'paid-here' && (
                    <select value={catalogPurchaseLine} onChange={(event) => setCatalogPurchaseLine(event.target.value)} className={control.select} required>
                      <option value="">Budget line…</option>
                      {budgetLines.filter((line) => line.isActive).map((line) => <option key={line.id} value={line.id}>{line.name} — {formatAFN(line.currentAmount)}</option>)}
                    </select>
                  )}
                </div>
              </div>
              <ShamsiDateInput label="Received on (optional)" value={catalogReceivedOn} onChange={setCatalogReceivedOn} />
              <SubmitButton busy={busy} label="Create catalog item" />
            </form>}

            {dialog.kind === 'edit' && <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(() => updateBookCatalogItem(dialog.book.id, { title: editTitle, saleEnabled: editSaleEnabled, salePrice: editSaleEnabled ? Number(editSalePrice) : null, lendingEnabled: editLendingEnabled, defaultUnitCost: editDefaultUnitCost === '' ? null : Number(editDefaultUnitCost), status: editStatus }), 'Catalog item updated.'); }}>
              <Field label="Title"><input required value={editTitle} onChange={(event) => setEditTitle(event.target.value)} className={control.input} /></Field>
              <CapabilityControls saleEnabled={editSaleEnabled} onSaleEnabled={setEditSaleEnabled} salePrice={editSalePrice} onSalePrice={setEditSalePrice} lendingEnabled={editLendingEnabled} onLendingEnabled={setEditLendingEnabled} />
              <Field label="Default unit cost (optional AFN)"><input min="0" step="1" type="number" value={editDefaultUnitCost} onChange={(event) => setEditDefaultUnitCost(event.target.value)} className={control.input} /></Field>
              <Field label="Catalog status"><select value={editStatus} onChange={(event) => setEditStatus(event.target.value as 'active' | 'archived')} className={control.select}><option value="active">Active</option><option value="archived">Archived — preserves history and blocks new Book commands</option></select></Field>
              <SubmitButton busy={busy} label="Save catalog item" />
            </form>}

            {dialog.kind === 'receipt' && <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(() => receiveBookStock(dialog.book.id, { quantity: Number(receiptQuantity), receivedOn: receiptDate || undefined, unitCost: receiptUnitCost === '' ? null : Number(receiptUnitCost), note: receiptNote || undefined, purchase: purchasePayload(receiptPurchaseMode, receiptPurchaseLine) }), 'Immutable stock receipt recorded.'); }}>
              <p className={text.hint}>Current available quantity: {dialog.book.availableQuantity}</p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><Field label="Quantity"><input required min="1" step="1" type="number" value={receiptQuantity} onChange={(event) => setReceiptQuantity(event.target.value)} className={control.input} /></Field><Field label="Unit cost (optional AFN)"><input min="0" step="1" type="number" value={receiptUnitCost} onChange={(event) => setReceiptUnitCost(event.target.value)} className={control.input} /></Field></div>
              <div className="grid grid-cols-1 gap-2 rounded-md border border-amber-300/60 bg-amber-50/60 p-3 text-xs">
                <span className={text.hint}>How is this purchase paid? (required when a unit cost is given)</span>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <select value={receiptPurchaseMode} onChange={(event) => setReceiptPurchaseMode(event.target.value)} className={control.select} required={receiptUnitCost !== '' && Number(receiptUnitCost) > 0}>
                    <option value="">Choose…</option>
                    <option value="paid-here">Pay now from a budget line</option>
                    <option value="separate">Recorded separately (expense workflow)</option>
                    <option value="not-applicable">No payment — donation / internal transfer</option>
                  </select>
                  {receiptPurchaseMode === 'paid-here' && (
                    <select value={receiptPurchaseLine} onChange={(event) => setReceiptPurchaseLine(event.target.value)} className={control.select} required>
                      <option value="">Budget line…</option>
                      {budgetLines.filter((line) => line.isActive).map((line) => <option key={line.id} value={line.id}>{line.name} — {formatAFN(line.currentAmount)}</option>)}
                    </select>
                  )}
                </div>
              </div>
              <ShamsiDateInput label="Received on (optional)" value={receiptDate} onChange={setReceiptDate} />
              <Field label="Note (optional)"><textarea value={receiptNote} onChange={(event) => setReceiptNote(event.target.value)} className={control.input} rows={3} /></Field>
              <SubmitButton busy={busy} label="Record stock receipt" />
            </form>}

            {dialog.kind === 'adjust' && <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(() => adjustBookStock(dialog.book.id, { delta: Number(adjustDelta), kind: adjustKind, reason: adjustReason }), 'Stock adjustment recorded.'); }}>
              <p className={text.hint}>Current available quantity: {dialog.book.availableQuantity}. An adjustment is a physical correction (loss, found, count fix) — it moves no money and writes an immutable audit row.</p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Kind"><select value={adjustKind} onChange={(event) => setAdjustKind(event.target.value as 'loss' | 'found' | 'correction')} className={control.select}><option value="loss">Loss (negative)</option><option value="found">Found (positive)</option><option value="correction">Count correction</option></select></Field>
                <Field label="Delta (copies, signed)"><input required type="number" step="1" value={adjustDelta} onChange={(event) => setAdjustDelta(event.target.value)} className={control.input} /></Field>
              </div>
              <Field label="Reason (required, min 8 characters)"><input required minLength={8} value={adjustReason} onChange={(event) => setAdjustReason(event.target.value)} className={control.input} /></Field>
              <SubmitButton busy={busy} label="Record adjustment" danger={adjustKind === 'loss'} />
            </form>}

            {dialog.kind === 'sale' && <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(() => recordBookSale(dialog.book.id, { quantity: Number(saleQuantity), studentId: saleStudentId || undefined, purchaserName: saleStudentId ? undefined : salePurchaserName, discountAmount: Number(saleDiscount || 0), paymentMethod: salePaymentMethod, soldOn: saleDate || undefined }), 'Book sale and linked receipt recorded.'); }}>
              <p className={text.hint}>Available: {dialog.book.availableQuantity} · Listed price: {formatAFN(dialog.book.salePrice ?? 0)}</p>
              <Field label="Quantity"><input required min="1" max={dialog.book.availableQuantity} step="1" type="number" value={saleQuantity} onChange={(event) => setSaleQuantity(event.target.value)} className={control.input} /></Field>
              <Field label="Student purchaser (optional)"><select value={saleStudentId} onChange={(event) => setSaleStudentId(event.target.value)} className={control.select}><option value="">Walk-in purchaser</option>{branchStudents.map((student) => <option key={student.id} value={student.id}>{student.fullName}</option>)}</select></Field>
              {!saleStudentId && <Field label="Walk-in purchaser name"><input required value={salePurchaserName} onChange={(event) => setSalePurchaserName(event.target.value)} className={control.input} /></Field>}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><Field label="Discount (AFN)"><input min="0" step="1" type="number" value={saleDiscount} onChange={(event) => setSaleDiscount(event.target.value)} className={control.input} /></Field><Field label="Payment method"><select value={salePaymentMethod} onChange={(event) => setSalePaymentMethod(event.target.value as 'cash' | 'card' | 'bank_transfer')} className={control.select}><option value="cash">Cash</option><option value="card">Card</option><option value="bank_transfer">Bank transfer</option></select></Field></div>
              <ShamsiDateInput label="Sale date (optional)" value={saleDate} onChange={setSaleDate} />
              <SubmitButton busy={busy} label="Record sale" />
            </form>}

            {dialog.kind === 'saleReturn' && <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(() => returnBookSale(dialog.sale.id, { reason: saleReturnReason, returnedOn: saleReturnDate || undefined }), 'Book sale returned and cash contra receipt recorded.'); }}>
              <p className={text.hint}>This is a full return of {dialog.sale.quantity} copy/copies and {formatAFN(dialog.sale.netAmount)}. It restores availability only with the signed cash contra fact.</p>
              <Field label="Return reason"><textarea required minLength={1} value={saleReturnReason} onChange={(event) => setSaleReturnReason(event.target.value)} className={control.input} rows={3} /></Field>
              <ShamsiDateInput label="Returned on (optional)" value={saleReturnDate} onChange={setSaleReturnDate} />
              <SubmitButton busy={busy} label="Return and refund sale" danger />
            </form>}

            {dialog.kind === 'loan' && <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(() => issueBookLoan(dialog.book.id, { studentId: loanStudentId, dueOn: loanDueOn, issuedOn: loanIssuedOn || undefined }), 'Book loan issued without a cash transaction.'); }}>
              <p className={text.hint}>Available: {dialog.book.availableQuantity}. A due date is mandatory; overdue is derived, never charged automatically.</p>
              <Field label="Student"><select required value={loanStudentId} onChange={(event) => setLoanStudentId(event.target.value)} className={control.select}><option value="">Select student</option>{branchStudents.map((student) => <option key={student.id} value={student.id}>{student.fullName}</option>)}</select></Field>
              <ShamsiDateInput label="Due on" required value={loanDueOn} onChange={setLoanDueOn} />
              <ShamsiDateInput label="Issued on (optional; defaults to today)" value={loanIssuedOn} onChange={setLoanIssuedOn} />
              <SubmitButton busy={busy} label="Issue Book loan" />
            </form>}

            {dialog.kind === 'loanReturn' && <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(() => returnBookLoan(dialog.loan.id, { returnedOn: loanReturnDate || undefined, note: loanReturnNote || undefined }), 'Book loan return recorded.'); }}>
              <p className={text.hint}>{dialog.loan.studentName} borrowed this item on {dialog.loan.issuedOn}; it was due {dialog.loan.dueOn}.</p>
              <ShamsiDateInput label="Returned on (optional; defaults to today)" value={loanReturnDate} onChange={setLoanReturnDate} />
              <Field label="Return note (optional)"><textarea value={loanReturnNote} onChange={(event) => setLoanReturnNote(event.target.value)} className={control.input} rows={3} /></Field>
              <SubmitButton busy={busy} label="Record loan return" />
            </form>}
          </section>
        </div>
      )}
    </section>
  );
}

function Metric({ label, value, detail, icon, tone = 'default' }: { label: string; value: string | number; detail?: string; icon: React.ReactNode; tone?: 'default' | 'warning' }) {
  return <article className={cx(surface.card, tone === 'warning' && 'border-amber-200 bg-amber-50/40')}><div className="flex items-start justify-between gap-3"><div><p className={text.meta}>{label}</p><p className="mt-1 text-xl font-extrabold tabular-nums text-slate-900">{value}</p>{detail && <p className={text.hint}>{detail}</p>}</div><span className="rounded-lg bg-brand-50 p-2 text-brand-700">{icon}</span></div></article>;
}

function HistoryPagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return <p className={cx(text.hint, 'text-end')}>{total} record{total === 1 ? '' : 's'}</p>;
  return <nav aria-label="Books history pagination" className="flex items-center justify-between gap-3"><p className={text.hint}>Page {page} of {pageCount} · {total} records</p><div className="flex gap-2"><button type="button" className={button.secondary} disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button><button type="button" className={button.secondary} disabled={page >= pageCount} onClick={() => onPage(page + 1)}>Next</button></div></nav>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className={text.label}>{label}</span>{children}</label>;
}

function CapabilityControls({ saleEnabled, onSaleEnabled, salePrice, onSalePrice, lendingEnabled, onLendingEnabled }: { saleEnabled: boolean; onSaleEnabled: (value: boolean) => void; salePrice: string; onSalePrice: (value: string) => void; lendingEnabled: boolean; onLendingEnabled: (value: boolean) => void }) {
  return <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4"><label className="flex items-center gap-2 text-sm font-medium text-slate-800"><input type="checkbox" checked={saleEnabled} onChange={(event) => onSaleEnabled(event.target.checked)} />Available for sale</label>{saleEnabled && <Field label="Sale price (AFN)"><input required min="1" step="1" type="number" value={salePrice} onChange={(event) => onSalePrice(event.target.value)} className={control.input} /></Field>}<label className="flex items-center gap-2 text-sm font-medium text-slate-800"><input type="checkbox" checked={lendingEnabled} onChange={(event) => onLendingEnabled(event.target.checked)} />Available for student lending</label>{!saleEnabled && !lendingEnabled && <p className={text.error}>Enable sale, lending, or both.</p>}</div>;
}

function SubmitButton({ busy, label, danger = false }: { busy: boolean; label: string; danger?: boolean }) {
  return <button type="submit" className={danger ? button.danger : button.primary} disabled={busy}>{busy && <RefreshCcw className="h-4 w-4 animate-spin" />}{label}</button>;
}

function EmptyRow({ columns, title, detail }: { columns: number; title: string; detail: string }) {
  return <tr><td colSpan={columns} className="px-4 py-10 text-center"><p className="font-semibold text-slate-700">{title}</p><p className={text.hint}>{detail}</p></td></tr>;
}
