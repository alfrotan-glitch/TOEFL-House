import { text } from '../../design-system/styles';
import React from 'react';
import { Trash2, X, AlertCircle, Edit, Info, History, Printer, RotateCcw, TrendingDown, Plus } from 'lucide-react';
import { Book, BookSale } from '../../types';
import { formatAFN } from '../../utils/format';
import { BrandLogo } from '../common/BrandLogo';
import { BRAND_NAME } from '../../config/branding';
import type { DocumentIssuer } from '../../config/documentIssuer';

interface BooksModalsProps {
  /** Contact details of the issuing branch, for printed receipts. */
  issuer: DocumentIssuer;
  // Edit book modal
  editingBook: Book | null;
  setEditingBook: (b: Book | null) => void;
  editTitle: string;
  setEditTitle: (v: string) => void;
  editIsChapter: boolean;
  setEditIsChapter: (v: boolean) => void;
  editPrice: number;
  setEditPrice: (v: number) => void;
  editPurchasePrice: number;
  setEditPurchasePrice: (v: number) => void;
  editStock: number;
  setEditStock: (v: number) => void;
  handleEditBookSubmit: (e: React.FormEvent) => void;

  // Restock history modal
  selectedBookHistory: Book | null;
  setSelectedBookHistory: (b: Book | null) => void;

  // Sale receipt modal
  selectedSaleReceipt: { sale: BookSale; book: Book } | null;
  setSelectedSaleReceipt: (v: { sale: BookSale; book: Book } | null) => void;

  // Delete confirm modal
  bookToDelete: Book | null;
  setBookToDelete: (b: Book | null) => void;
  handleDeleteConfirm: () => void;

  // Refund confirm modal
  saleToRefund: BookSale | null;
  setSaleToRefund: (s: BookSale | null) => void;
  handleRefundConfirm: () => void;

  // Quick restock modal
  restockingBook: Book | null;
  setRestockingBook: (b: Book | null) => void;
  quickRestockQty: number;
  setQuickRestockQty: (v: number) => void;
  handleQuickRestockSubmit: (e: React.FormEvent) => void;

  // Inventory audit report modal
  showAuditModal: boolean;
  setShowAuditModal: (v: boolean) => void;
  books: Book[];
  totalAcquisitionCost: number;
  totalAssetValue: number;
}

/** Bundles every modal dialog used by BooksView: edit, restock history, sale receipt, delete/refund confirmations, quick restock, and the full inventory audit report. */
export default function BooksModals(props: BooksModalsProps) {
  const {
    editingBook, setEditingBook, editTitle, setEditTitle, editIsChapter, setEditIsChapter,
    editPrice, setEditPrice, editPurchasePrice, setEditPurchasePrice, editStock, setEditStock, handleEditBookSubmit,
    selectedBookHistory, setSelectedBookHistory,
    issuer,
    selectedSaleReceipt, setSelectedSaleReceipt,
    bookToDelete, setBookToDelete, handleDeleteConfirm,
    saleToRefund, setSaleToRefund, handleRefundConfirm,
    restockingBook, setRestockingBook, quickRestockQty, setQuickRestockQty, handleQuickRestockSubmit,
    showAuditModal, setShowAuditModal, books, totalAcquisitionCost, totalAssetValue,
  } = props;

  return (
    <>
      {/* Editing Dialog Modal */}
      {editingBook && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto animate-in fade-in duration-150">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full border border-slate-100 shadow-xl space-y-4 animate-in zoom-in-95 duration-200 text-start">
            <h3 className="font-extrabold text-slate-900 text-sm border-b border-slate-100 pb-3 flex items-center gap-1.5">
              <Edit className="w-4 h-4 text-indigo-600" />
              Edit book / chapter
            </h3>
            <form onSubmit={handleEditBookSubmit} className="space-y-4 text-xs text-start">
              <div className="space-y-1">
                <label className="block text-slate-600 font-semibold">Product title:</label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5"
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="block text-slate-600 font-semibold">Product type:</label>
                <select
                  value={editIsChapter ? 'chapter' : 'book'}
                  onChange={(e) => setEditIsChapter(e.target.value === 'chapter')}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 cursor-pointer"
                >
                  <option value="chapter">Skill chapter</option>
                  <option value="book">Full book</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="block text-slate-600 font-semibold">Sale price (AFN):</label>
                <input
                  type="number"
                  value={editPrice}
                  onChange={(e) => setEditPrice(Number(e.target.value))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 font-mono"
                  min={0}
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="block text-slate-600 font-semibold">Purchase cost (AFN):</label>
                <input
                  type="number"
                  value={editPurchasePrice}
                  onChange={(e) => setEditPurchasePrice(Number(e.target.value))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 font-mono"
                  min={0}
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="block text-slate-600 font-semibold">Stock (units):</label>
                <input
                  type="number"
                  value={editStock}
                  onChange={(e) => setEditStock(Number(e.target.value))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 font-mono"
                  min={0}
                  required
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setEditingBook(null)}
                  className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-2 px-4 rounded-lg transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-5 rounded-lg transition-colors cursor-pointer shadow-sm"
                >
                  Save changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Replenishment History Dialog Modal */}
      {selectedBookHistory && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto animate-in fade-in duration-150">
          <div className="bg-white rounded-3xl p-6 max-w-lg w-full border border-slate-100 shadow-2xl space-y-4 animate-in zoom-in-95 duration-200 text-start">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <History className="w-5 h-5 text-indigo-600" />
                <h3 className="font-extrabold text-slate-900 text-sm">Restock history</h3>
              </div>
              <button 
                onClick={() => setSelectedBookHistory(null)}
                className="p-1 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>

            <div className="space-y-1.5">
              <p className="text-[10px] text-slate-400 font-bold">Book / chapter title:</p>
              <h4 className="font-black text-slate-900 text-sm">{selectedBookHistory.title}</h4>
              <div className="flex gap-2 text-[10px] mt-1">
                <span className={`px-2 py-0.5 rounded font-bold ${selectedBookHistory.isChapter ? 'bg-amber-50 text-amber-700' : 'bg-indigo-50 text-indigo-700'}`}>
                  {selectedBookHistory.isChapter ? 'Skill chapter' : 'Full book'}
                </span>
                <span className="bg-slate-50 border border-slate-150 text-slate-600 px-2 py-0.5 rounded font-bold">
                  Current stock: {selectedBookHistory.stock} units
                </span>
              </div>
            </div>

            <div className="border border-slate-150 rounded-2xl overflow-hidden bg-slate-50/40">
              <div className="max-h-60 overflow-y-auto">
                <table className="w-full text-start text-xs">
                  <thead className="bg-slate-100 text-slate-500">
                    <tr>
                      <th className="py-2.5 px-3 font-bold">#</th>
                      <th className="py-2.5 px-3 font-bold">Entry date</th>
                      <th className="py-2.5 px-3 font-bold text-center">Qty added</th>
                      <th className="py-2.5 px-3 font-bold">Price at restock</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-150 text-slate-600 font-medium">
                    {!selectedBookHistory.restockHistory || selectedBookHistory.restockHistory.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-4 text-center text-slate-400 font-semibold">
                          No restock history for this product yet (initial entry).
                        </td>
                      </tr>
                    ) : (
                      selectedBookHistory.restockHistory.map((history, idx) => (
                        <tr key={idx} className="hover:bg-indigo-50/30">
                          <td className="py-2.5 px-3 font-mono font-bold text-slate-400">{idx + 1}</td>
                          <td className="py-2.5 px-3 font-mono">{history.date}</td>
                          <td className="py-2.5 px-3 text-center font-mono font-black text-slate-800">+{history.quantity} units</td>
                          <td className="py-2.5 px-3 font-mono text-indigo-600">{formatAFN(history.price)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => setSelectedBookHistory(null)}
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs py-2.5 px-5 rounded-xl transition-colors cursor-pointer shadow-md shadow-indigo-600/10"
              >
                Confirm & close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Professional Printable Receipt Modal */}
      {selectedSaleReceipt && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto animate-in fade-in duration-150">
          <div className="bg-white rounded-3xl p-6 max-w-md w-full border border-slate-100 shadow-2xl space-y-5 animate-in zoom-in-95 duration-200 text-start">
            
            {/* Header Dialog */}
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <span className="text-xs font-bold text-slate-400">Book/chapter sale receipt preview</span>
              <button 
                onClick={() => setSelectedSaleReceipt(null)}
                className="p-1 hover:bg-slate-150 rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>

            {/* Printable Area Box */}
            <div 
              className="border-2 border-dashed border-slate-200 rounded-2xl p-5 bg-stone-50/50 space-y-4" 
              id="printable-sale-invoice"
            >
              {/* Receipt Header logo */}
              <div className="text-center space-y-1 border-b border-slate-200 pb-3">
                <div className="flex justify-center pb-1"><BrandLogo height={30} /></div>
                <h4 className="font-black text-slate-900 text-sm">{BRAND_NAME}</h4>
                <p className="text-[10px] text-slate-500 font-semibold">Bookstore finance & inventory</p>
                {issuer.branchName && <p className="text-[10px] text-slate-500 font-semibold">{issuer.branchName}</p>}
                {issuer.address && <p className="text-[9px] text-slate-400">{issuer.address}</p>}
                {issuer.phone && <p className="text-[9px] text-slate-400 font-mono">Phone: {issuer.phone}</p>}
                {issuer.email && <p className="text-[9px] text-slate-400 font-mono">{issuer.email}</p>}
              </div>

              {/* Receipt metadata */}
              <div className="grid grid-cols-2 gap-2 text-[10px] text-slate-600 border-b border-slate-200 pb-3">
                <div>
                  <span className="font-semibold text-slate-400">Buyer name:</span>
                  <p className="font-bold text-slate-800 mt-0.5">{selectedSaleReceipt.sale.customerName}</p>
                </div>
                <div>
                  <span className="font-semibold text-slate-400">Transaction no:</span>
                  <p className="font-mono font-bold text-slate-800 mt-0.5">{selectedSaleReceipt.sale.id}</p>
                </div>
                <div>
                  <span className="font-semibold text-slate-400">Issue date:</span>
                  <p className="font-mono text-slate-800 mt-0.5">{selectedSaleReceipt.sale.date}</p>
                </div>
                <div>
                  <span className="font-semibold text-slate-400">Payment type:</span>
                  <p className="font-bold text-emerald-600 mt-0.5">
                    {selectedSaleReceipt.sale.paymentMethod === 'card' ? 'POS card' : selectedSaleReceipt.sale.paymentMethod === 'transfer' ? 'Transfer' : 'Cash (till)'}
                  </p>
                </div>
              </div>

              {/* Items Table */}
              <div className="space-y-2 border-b border-slate-200 pb-3 text-[11px]">
                <div className="flex justify-between font-bold text-slate-500">
                  <span>Educational item description</span>
                  <span>Total amount</span>
                </div>
                <div className="flex justify-between items-start text-slate-800 font-semibold">
                  <div className="space-y-0.5 max-w-[200px]">
                    <p className="text-xs font-black text-slate-900">{selectedSaleReceipt.book.title}</p>
                    <p className="text-[10px] text-slate-500">
                      {selectedSaleReceipt.sale.quantity} units × {formatAFN(selectedSaleReceipt.book.price)}
                    </p>
                  </div>
                  <span className="font-mono font-bold text-slate-900">
                    {formatAFN(selectedSaleReceipt.sale.totalAmount)}
                  </span>
                </div>
              </div>

              {/* Totals */}
              <div className="space-y-1.5 text-xs">
                {selectedSaleReceipt.sale.discountAmount !== undefined && selectedSaleReceipt.sale.discountAmount > 0 && (
                  <div className="flex justify-between text-rose-500 font-semibold">
                    <span>Special discount applied:</span>
                    <span className="font-mono">-{formatAFN(selectedSaleReceipt.sale.discountAmount)}</span>
                  </div>
                )}
                <div className="flex justify-between text-slate-900 font-black text-sm bg-indigo-50/50 p-2.5 rounded-xl border border-indigo-100">
                  <span>Net settlement amount:</span>
                  <span className="font-mono text-indigo-700">
                    {formatAFN(selectedSaleReceipt.sale.netAmount !== undefined ? selectedSaleReceipt.sale.netAmount : selectedSaleReceipt.sale.totalAmount)}
                  </span>
                </div>
              </div>

              {/* Simulated Professional Barcode */}
              <div className="flex flex-col items-center justify-center pt-2.5 space-y-1 border-t border-slate-200">
                <svg className="w-48 h-8 opacity-80" viewBox="0 0 100 20" xmlns="http://www.w3.org/2000/svg">
                  <rect x="2" y="1" width="1" height="15" fill="#1e293b" />
                  <rect x="4" y="1" width="2" height="15" fill="#1e293b" />
                  <rect x="7" y="1" width="1" height="15" fill="#1e293b" />
                  <rect x="10" y="1" width="3" height="15" fill="#1e293b" />
                  <rect x="15" y="1" width="1" height="15" fill="#1e293b" />
                  <rect x="17" y="1" width="2" height="15" fill="#1e293b" />
                  <rect x="21" y="1" width="1" height="15" fill="#1e293b" />
                  <rect x="23" y="1" width="4" height="15" fill="#1e293b" />
                  <rect x="29" y="1" width="1" height="15" fill="#1e293b" />
                  <rect x="31" y="1" width="2" height="15" fill="#1e293b" />
                  <rect x="35" y="1" width="1" height="15" fill="#1e293b" />
                  <rect x="37" y="1" width="3" height="15" fill="#1e293b" />
                  <rect x="42" y="1" width="1" height="15" fill="#1e293b" />
                  <rect x="44" y="1" width="2" height="15" fill="#1e293b" />
                  <rect x="48" y="1" width="1" height="15" fill="#1e293b" />
                  <rect x="50" y="1" width="4" height="15" fill="#1e293b" />
                  <rect x="56" y="1" width="1" height="15" fill="#1e293b" />
                  <rect x="58" y="1" width="2" height="15" fill="#1e293b" />
                  <rect x="62" y="1" width="1" height="15" fill="#1e293b" />
                  <rect x="64" y="1" width="3" height="15" fill="#1e293b" />
                  <rect x="69" y="1" width="1" height="15" fill="#1e293b" />
                  <rect x="71" y="1" width="2" height="15" fill="#1e293b" />
                  <rect x="75" y="1" width="1" height="15" fill="#1e293b" />
                  <rect x="77" y="1" width="4" height="15" fill="#1e293b" />
                  <rect x="83" y="1" width="1" height="15" fill="#1e293b" />
                  <rect x="85" y="1" width="2" height="15" fill="#1e293b" />
                  <rect x="89" y="1" width="1" height="15" fill="#1e293b" />
                  <rect x="91" y="1" width="3" height="15" fill="#1e293b" />
                  <rect x="96" y="1" width="1" height="15" fill="#1e293b" />
                  <rect x="98" y="1" width="1" height="15" fill="#1e293b" />
                </svg>
                <span className="text-[8px] font-mono tracking-widest text-slate-500">*{selectedSaleReceipt.sale.id.substring(0, 12).toUpperCase()}*</span>
              </div>

              {/* Footer Stamp */}
              <div className="text-center pt-2 text-[9px] text-slate-400 space-y-1">
                <p>{BRAND_NAME} cashier stamp &amp; signature</p>
                <div className="h-10 w-24 mx-auto border border-dashed border-indigo-200/50 rounded-full flex items-center justify-center text-[8px] text-indigo-400 font-bold rotate-6">
                  {BRAND_NAME} PAID
                </div>
                <p className="mt-2 text-[8px]">Thank you for your purchase!</p>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex justify-end gap-2 text-xs pt-1">
              <button
                type="button"
                onClick={() => setSelectedSaleReceipt(null)}
                className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-2.5 px-4 rounded-xl transition-colors cursor-pointer"
              >
                Cancel & go back
              </button>
              <button
                type="button"
                onClick={() => {
                  window.print();
                }}
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2.5 px-5 rounded-xl transition-colors cursor-pointer shadow-md shadow-indigo-600/10 flex items-center gap-1.5"
              >
                <Printer className="w-4 h-4" />
                Print this invoice
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Modern Interactive Deletion Confirmation Modal */}
      {bookToDelete && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto animate-in fade-in duration-150">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full border border-slate-100 shadow-2xl space-y-4 animate-in zoom-in-95 duration-200 text-start">
            <div className="flex items-center gap-3 text-rose-600 border-b border-slate-100 pb-3">
              <AlertCircle className="w-5 h-5 stroke-[2.5]" />
              <h3 className="font-extrabold text-slate-900 text-sm">Confirm delete book / booklet</h3>
            </div>
            
            <p className="text-xs text-slate-600 leading-relaxed">
              Are you sure you want to delete book/chapter <strong className="text-slate-900 font-bold">“{bookToDelete.title}”</strong> from {BRAND_NAME} inventory?
            </p>
            
            <div className="p-3 bg-rose-50 border border-rose-100 rounded-xl flex items-start gap-2.5 text-[11px] text-rose-800 leading-relaxed">
              <Info className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <span>
                Note: sales history for this book is kept, but it will no longer appear as a new sale option. This cannot be undone.
              </span>
            </div>

            <div className="flex justify-end gap-2.5 pt-2 border-t border-slate-100 text-xs">
              <button
                type="button"
                onClick={() => setBookToDelete(null)}
                className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-2.5 px-4 rounded-xl transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                className="bg-rose-600 hover:bg-rose-700 text-white font-bold py-2.5 px-5 rounded-xl transition-colors cursor-pointer shadow-md shadow-rose-600/10 flex items-center gap-1.5"
              >
                <Trash2 className="w-4 h-4" />
                Permanently delete from inventory
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Refund Sale Confirmation Modal */}
      {saleToRefund && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto animate-in fade-in duration-150">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full border border-slate-100 shadow-2xl space-y-4 animate-in zoom-in-95 duration-200 text-start">
            <div className="flex items-center gap-3 text-rose-600 border-b border-slate-100 pb-3">
              <TrendingDown className="w-5 h-5 stroke-[2.5]" />
              <h3 className="font-extrabold text-slate-900 text-sm">Refund & void sale invoice</h3>
            </div>
            
            <div className="space-y-1">
              <p className="text-[10px] text-slate-400 font-bold">Sale invoice for buyer:</p>
              <p className="text-xs font-black text-slate-800">{saleToRefund.customerName}</p>
              <p className="text-xs text-slate-600">
                Invoice amount: <strong className="text-slate-900">{formatAFN(saleToRefund.netAmount !== undefined ? saleToRefund.netAmount : saleToRefund.totalAmount)}</strong>
              </p>
            </div>

            <p className="text-xs text-slate-600 leading-relaxed">
              Refund this sale? The amount will be deducted from the finance desk and <strong className="text-slate-900 font-black">{saleToRefund.quantity}</strong> units will automatically return to inventory stock.
            </p>
            
            <div className="p-3 bg-amber-50 border border-amber-100 rounded-xl flex items-start gap-2.5 text-[11px] text-amber-800 leading-relaxed">
              <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <span>
                Note: this transaction is marked as refunded and retained in the database for audit.
              </span>
            </div>

            <div className="flex justify-end gap-2.5 pt-2 border-t border-slate-100 text-xs">
              <button
                type="button"
                onClick={() => setSaleToRefund(null)}
                className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-2.5 px-4 rounded-xl transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRefundConfirm}
                className="bg-rose-600 hover:bg-rose-700 text-white font-bold py-2.5 px-5 rounded-xl transition-colors cursor-pointer shadow-md shadow-rose-600/10 flex items-center gap-1.5"
              >
                <RotateCcw className="w-4 h-4" />
                Confirm final refund
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Quick Restock Interactive Popover Modal */}
      {restockingBook && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto animate-in fade-in duration-150 text-start">
          <div className="bg-white rounded-3xl p-6 max-w-md w-full border border-slate-100 shadow-2xl space-y-4 animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2 text-emerald-600">
                <Plus className="w-5 h-5 text-emerald-600 stroke-[2.5]" />
                <h3 className="font-extrabold text-slate-900 text-sm">Quick restock (new entry)</h3>
              </div>
              <button 
                onClick={() => setRestockingBook(null)}
                className="p-1 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>

            <div className="space-y-1 bg-slate-50 p-3 rounded-xl border border-slate-150">
              <span className="text-[10px] text-slate-400 font-bold">Warehouse product name:</span>
              <p className="font-black text-slate-900 text-xs">{restockingBook.title}</p>
              <div className="flex gap-2 text-[10px] mt-1.5 font-bold text-slate-600">
                <span>Current stock: {restockingBook.stock} units</span>
                <span className="text-slate-300">|</span>
                <span>Current purchase price: {formatAFN((restockingBook.purchasePrice ?? 0))}</span>
              </div>
            </div>

            <form onSubmit={handleQuickRestockSubmit} className="space-y-4 text-xs text-start">
              <div className="space-y-1.5">
                <label className="block text-slate-600 font-semibold">New units to add to stock:</label>
                <input
                  type="number"
                  value={quickRestockQty}
                  onChange={(e) => setQuickRestockQty(Math.max(1, Number(e.target.value)))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500/10 text-start text-sm font-bold text-slate-800"
                  min={1}
                  required
                />
              </div>

              {/* Quick choices pills */}
              <div className="flex flex-wrap gap-1.5 justify-start">
                {[10, 20, 50, 100].map(qty => (
                  <button
                    key={qty}
                    type="button"
                    onClick={() => setQuickRestockQty(qty)}
                    className={`px-3 py-1.5 rounded-lg border text-[11px] font-bold transition-all cursor-pointer ${
                      quickRestockQty === qty 
                        ? 'bg-emerald-600 border-emerald-600 text-white shadow-sm' 
                        : 'bg-slate-50 hover:bg-slate-100 border-slate-200 text-slate-700'
                    }`}
                  >
                    +{qty} units
                  </button>
                ))}
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setRestockingBook(null)}
                  className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-2.5 px-4 rounded-xl transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2.5 px-5 rounded-xl transition-colors cursor-pointer shadow-md shadow-emerald-600/10 flex items-center gap-1.5"
                >
                  <Plus className="w-4 h-4" />
                  Restock & update inventory
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Comprehensive Printable Inventory Audit Report Modal */}
      {showAuditModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto animate-in fade-in duration-150 text-start">
          <div className="bg-white rounded-3xl p-6 max-w-4xl w-full border border-slate-100 shadow-2xl space-y-5 animate-in zoom-in-95 duration-200">
            
            {/* Header Dialog */}
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <Printer className="w-5 h-5 text-indigo-600" />
                <span className={text.value}>Inventory audit report preview</span>
              </div>
              <button 
                onClick={() => setShowAuditModal(false)}
                className="p-1 hover:bg-slate-150 rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>

            {/* Printable Report Box */}
            <div 
              className="border border-slate-200 rounded-2xl p-6 bg-white space-y-6" 
              id="printable-inventory-report"
            >
              {/* Header section */}
              <div className="text-center space-y-1.5 border-b-2 border-double border-slate-300 pb-4">
                <div className="flex justify-center pb-1"><BrandLogo height={34} /></div>
                <h3 className="font-black text-slate-900 text-base">{BRAND_NAME}</h3>
                <p className="text-xs text-slate-600 font-bold">Bookstore finance & inventory — stock balance report</p>
                <div className="flex justify-center gap-6 text-[10px] text-slate-500 font-mono pt-1">
                  <span>Report date: {new Date().toISOString().split('T')[0]}</span>
                  <span>Issued at: {new Date().toLocaleTimeString('en-US')}</span>
                  <span>Issued by: System admin</span>
                </div>
              </div>

              {/* High-level Totals Grid */}
              <div className="grid grid-cols-4 gap-4 text-start">
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <span className="text-[10px] text-slate-400 font-bold">Total SKUs:</span>
                  <p className="text-sm font-black text-slate-800 mt-1 font-mono">{books.length} titles</p>
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <span className="text-[10px] text-slate-400 font-bold">Physical units:</span>
                  <p className="text-sm font-black text-slate-800 mt-1 font-mono">{books.reduce((sum, b) => sum + b.stock, 0)} units</p>
                </div>
                <div className="bg-indigo-50/50 border border-indigo-100 rounded-xl p-3">
                  <span className="text-[10px] text-indigo-500 font-bold">Total investment (cost):</span>
                  <p className="text-sm font-black text-indigo-700 mt-1 font-mono">{formatAFN(totalAcquisitionCost)}</p>
                </div>
                <div className="bg-emerald-50/50 border border-emerald-100 rounded-xl p-3">
                  <span className="text-[10px] text-emerald-500 font-bold">Total retail asset value:</span>
                  <p className="text-sm font-black text-emerald-700 mt-1 font-mono">{formatAFN(totalAssetValue)}</p>
                </div>
              </div>

              {/* Inventory Table */}
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-start text-[11px] border-collapse">
                  <thead className="bg-slate-100 text-slate-600 border-b border-slate-200 font-bold">
                    <tr>
                      <th className="py-2 px-3">Product title</th>
                      <th className="py-2 px-3 text-center">Type</th>
                      <th className="py-2 px-3 text-center">Stock</th>
                      <th className="py-2 px-3">Unit cost</th>
                      <th className="py-2 px-3">Unit retail</th>
                      <th className="py-2 px-3">Investment value</th>
                      <th className="py-2 px-3">Total retail value</th>
                      <th className="py-2 px-3 text-center">Stock status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-150 text-slate-700">
                    {books.map(b => {
                      const purPrice = (b.purchasePrice ?? 0);
                      const isLow = b.stock <= 5;
                      return (
                        <tr key={b.id} className="hover:bg-slate-50/50">
                          <td className="py-2 px-3 font-bold text-slate-800">{b.title}</td>
                          <td className="py-2 px-3 text-center">
                            <span className={`inline-block px-1.5 py-0.5 rounded text-[8px] font-bold ${b.isChapter ? 'bg-amber-50 text-amber-700' : 'bg-indigo-50 text-indigo-700'}`}>
                              {b.isChapter ? 'Chapter' : 'Book'}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-center font-mono font-bold">{b.stock} units</td>
                          <td className="py-2 px-3 font-mono">{formatAFN(purPrice)}</td>
                          <td className="py-2 px-3 font-mono">{formatAFN(b.price)}</td>
                          <td className="py-2 px-3 font-mono text-slate-500">{formatAFN(purPrice * b.stock)}</td>
                          <td className="py-2 px-3 font-mono font-bold text-slate-800">{formatAFN(b.price * b.stock)}</td>
                          <td className="py-2 px-3 text-center">
                            <span className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-bold ${
                              isLow ? 'bg-rose-100 text-rose-800' : 'bg-emerald-100 text-emerald-800'
                            }`}>
                              {isLow ? 'Needs restock' : 'Adequate stock'}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Disclaimer */}
              <div className="flex justify-between items-center text-[9px] text-slate-400 pt-4 border-t border-slate-100">
                <p>* Internal report based on the latest {BRAND_NAME} inventory entries.</p>
                <p>Institutional finance — admin approval</p>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex justify-end gap-2 text-xs pt-1">
              <button
                type="button"
                onClick={() => setShowAuditModal(false)}
                className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-2.5 px-4 rounded-xl transition-colors cursor-pointer"
              >
                Close window
              </button>
              <button
                type="button"
                onClick={() => {
                  window.print();
                }}
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2.5 px-5 rounded-xl transition-colors cursor-pointer shadow-md shadow-indigo-600/10 flex items-center gap-1.5"
              >
                <Printer className="w-4 h-4" />
                Print / save PDF report
              </button>
            </div>

          </div>
        </div>
      )}
    </>
  );
}
