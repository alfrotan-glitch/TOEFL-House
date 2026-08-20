/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {BookOpen, ShoppingBag, Plus, Sparkles, ClipboardList, TrendingUp, Calendar, Trash2, X, CheckCircle2, AlertCircle, Edit, Info, Search, History, Printer, CreditCard, RotateCcw, BarChart3, AlertTriangle} from 'lucide-react';
import {Book, BookSale, Student, UserRole} from '../../types';
import BooksModals from './BooksModals';
import {formatAFN} from '../../utils/format';
import type { DocumentIssuer } from '../../config/documentIssuer';
import { ShamsiDateInput } from '../common/ShamsiDateInput';

interface BooksViewProps {
  books: Book[];
  bookSales: BookSale[];
  students: Student[];
  recordBookSale: (
    bookId: string, 
    quantity: number, 
    customerName: string, 
    studentId?: string, 
    discountAmount?: number, 
    paymentMethod?: 'cash' | 'card' | 'transfer'
  ) => Promise<void>;
  addBook: (title: string, price: number, stock: number, isChapter: boolean, entryDate?: string, purchasePrice?: number) => Promise<void>;
  editBook: (id: string, title: string, price: number, stock: number, isChapter: boolean, purchasePrice?: number) => Promise<void>;
  deleteBook: (id: string) => Promise<void>;
  refundBookSale: (saleId: string) => Promise<void>;
  activeRole: UserRole;
  /** Contact details of the issuing branch, for printed receipts. */
  issuer: DocumentIssuer;
}

export default function BooksView({
  books,
  bookSales,
  students,
  recordBookSale,
  addBook,
  editBook,
  deleteBook,
  refundBookSale,
  activeRole,
  issuer
}: BooksViewProps) {
  /** Change in Settings later; default alert when stock <= this. */
  const LOW_STOCK_THRESHOLD = 5;
  const [subTab, setSubTab] = useState<'sales' | 'add' | 'analytics'>('sales');
  
  // Dynamic initialization for selectedBookId
  const [selectedBookId, setSelectedBookId] = useState<string>(() => {
    return books.length > 0 ? books[0].id : '';
  });
  
  const [quantity, setQuantity] = useState<number>(1);
  const [customerName, setCustomerName] = useState<string>('');
  const [studentId, setStudentId] = useState<string>('');
  const [discountInput, setDiscountInput] = useState<string>('0');
  const [discountType, setDiscountType] = useState<'percent' | 'afn'>('percent');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'transfer'>('cash');

  // Add new book form state
  const [newTitle, setNewTitle] = useState<string>('');
  const [newPrice, setNewPrice] = useState<number>(0);
  const [newPurchasePrice, setNewPurchasePrice] = useState<number>(0);
  const [newStock, setNewStock] = useState<number>(0);
  const [newIsChapter, setNewIsChapter] = useState<boolean>(false);
  const [newEntryDate, setNewEntryDate] = useState<string>(() => {
    return new Date().toISOString().split('T')[0];
  });

  // Edit book form state
  const [editingBook, setEditingBook] = useState<Book | null>(null);
  const [editTitle, setEditTitle] = useState<string>('');
  const [editPrice, setEditPrice] = useState<number>(0);
  const [editPurchasePrice, setEditPurchasePrice] = useState<number>(0);
  const [editStock, setEditStock] = useState<number>(0);
  const [editIsChapter, setEditIsChapter] = useState<boolean>(true);

  // Search & Filters state
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'books' | 'chapters'>('all');
  const [stockFilter, setStockFilter] = useState<'all' | 'low'>('all');

  // Custom UI feedback states
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [bookToDelete, setBookToDelete] = useState<Book | null>(null);
  const [selectedBookHistory, setSelectedBookHistory] = useState<Book | null>(null);
  const [selectedSaleReceipt, setSelectedSaleReceipt] = useState<{ sale: BookSale; book: Book } | null>(null);
  const [saleToRefund, setSaleToRefund] = useState<BookSale | null>(null);

  // Quick restock states
  const [restockingBook, setRestockingBook] = useState<Book | null>(null);
  const [quickRestockQty, setQuickRestockQty] = useState<number>(1);
  const [showAuditModal, setShowAuditModal] = useState<boolean>(false);

  const handleQuickRestockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!restockingBook) return;
    try {
      await addBook(
        restockingBook.title,
        restockingBook.price,
        quickRestockQty,
        restockingBook.isChapter,
        new Date().toISOString().split('T')[0],
        restockingBook.purchasePrice ?? 0
      );
      setRestockingBook(null);
      setQuickRestockQty(20);
      showToastMsg(`Stock for "${restockingBook.title}" increased successfully to ${quickRestockQty} units.`, 'success');
    } catch (err) {
      showToastMsg(err instanceof Error ? err.message : 'Restock failed. Please try again.', 'error');
    }
  };

  const showToastMsg = (message: string, type: 'success' | 'error' | 'info' = 'success') => {
    setToast({ message, type });
    setTimeout(() => {
      setToast(null);
    }, 4500);
  };

  const handleStartEditBook = (book: Book) => {
    setEditingBook(book);
    setEditTitle(book.title);
    setEditPrice(book.price);
    setEditPurchasePrice(book.purchasePrice ?? 0);
    setEditStock(book.stock);
    setEditIsChapter(book.isChapter);
  };

  const handleEditBookSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingBook) return;
    try {
      await editBook(editingBook.id, editTitle, editPrice, editStock, editIsChapter, editPurchasePrice);
      setEditingBook(null);
      showToastMsg('Book/chapter details updated successfully.', 'success');
    } catch (err) {
      showToastMsg(err instanceof Error ? err.message : 'Failed to update the book/chapter. Please try again.', 'error');
    }
  };

  const handleDeleteConfirm = async () => {
    if (!bookToDelete) return;
    try {
      await deleteBook(bookToDelete.id);
      showToastMsg(`Book/chapter "${bookToDelete.title}" deleted successfully.`, 'success');
      setBookToDelete(null);
      // Update selectedBookId if the deleted book was selected in invoice
      if (selectedBookId === bookToDelete.id) {
        const remaining = books.filter(b => b.id !== bookToDelete.id);
        setSelectedBookId(remaining.length > 0 ? remaining[0].id : '');
      }
    } catch (err) {
      showToastMsg(err instanceof Error ? err.message : 'Failed to delete the book/chapter. Please try again.', 'error');
    }
  };

  const selectedBook = books.find(b => b.id === selectedBookId);
  const grossCost = selectedBook ? selectedBook.price * quantity : 0;

  // Calculate dynamic discount amount
  const calculatedDiscount = (() => {
    const val = Number(discountInput) || 0;
    if (discountType === 'percent') {
      return Math.round((grossCost * Math.min(val, 100)) / 100);
    }
    return Math.min(val, grossCost);
  })();

  const totalCost = Math.max(0, grossCost - calculatedDiscount);

  const handleSaleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBookId) {
      showToastMsg('Please select a book or skill chapter.', 'error');
      return;
    }
    if (!customerName && !studentId) {
      showToastMsg('Please specify buyer or student name.', 'error');
      return;
    }

    let finalCustomerName = customerName;
    if (studentId) {
      const stud = students.find(s => s.id === studentId);
      if (stud) finalCustomerName = stud.fullName;
    }

    try {
      await recordBookSale(
        selectedBookId, 
        quantity, 
        finalCustomerName, 
        studentId || undefined, 
        calculatedDiscount, 
        paymentMethod
      );
      // Reset form only after the sale was actually recorded.
      setCustomerName('');
      setStudentId('');
      setQuantity(1);
      setDiscountInput('0');
      setPaymentMethod('cash');
      showToastMsg('Sale recorded successfully and revenue was added to the finance cash desk.', 'success');
    } catch (err) {
      showToastMsg(err instanceof Error ? err.message : 'Sale failed. Please try again.', 'error');
    }
  };

  const handleAddBookSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) {
      showToastMsg('Please enter book or chapter title.', 'error');
      return;
    }
    if (newPrice <= 0) {
      showToastMsg('Sale price must be greater than zero.', 'error');
      return;
    }
    if (newStock < 0) {
      showToastMsg('Stock cannot be negative.', 'error');
      return;
    }
    try {
      await addBook(newTitle, newPrice, newStock, newIsChapter, newEntryDate, newPurchasePrice);
      setNewTitle('');
      setNewPrice(0);
      setNewPurchasePrice(0);
      setNewStock(0);
      setNewIsChapter(false);
      setNewEntryDate(new Date().toISOString().split('T')[0]);
      setSubTab('sales');
      showToastMsg('Book/chapter registered successfully.', 'success');
    } catch (err) {
      showToastMsg(err instanceof Error ? err.message : 'Failed to register the book/chapter. Please try again.', 'error');
    }
  };

  const handleRefundConfirm = async () => {
    if (!saleToRefund) return;
    try {
      await refundBookSale(saleToRefund.id);
      showToastMsg('Sale reversed and stock restored.', 'info');
      setSaleToRefund(null);
    } catch (err) {
      showToastMsg(err instanceof Error ? err.message : 'Refund failed. Please try again.', 'error');
    }
  };

  const isAuthorizedToManage = activeRole === 'owner' || activeRole === 'general_manager' || activeRole === 'receptionist' || activeRole === 'finance_manager';
  const isOwnerOrManager = activeRole === 'owner' || activeRole === 'general_manager';

  // Dynamic Metrics & Totals
  const totalDistinctBooks = books.length;
  const totalCopiesInStock = books.reduce((sum, b) => sum + b.stock, 0);
  const totalAssetValue = books.reduce((sum, b) => sum + (b.price * b.stock), 0);
  const totalAcquisitionCost = books.reduce((sum, b) => sum + (((b.purchasePrice ?? 0)) * b.stock), 0);

  // Filtered sales (exclude refunded from some totals if appropriate, but let's count only completed)
  const completedSales = bookSales.filter(s => s.status !== 'refunded');
  const refundedSales = bookSales.filter(s => s.status === 'refunded');
  
  const totalSalesRevenue = completedSales.reduce((sum, s) => sum + (s.netAmount !== undefined ? s.netAmount : s.totalAmount), 0);
  const totalSalesCopies = completedSales.reduce((sum, s) => sum + s.quantity, 0);
  
  // Calculate Net Profit
  // Profit = netAmount_of_sale - (purchase_price_of_book * sale_quantity)
  const totalNetProfit = completedSales.reduce((sum, s) => {
    const book = books.find(b => b.id === s.bookId);
    const purchase = (book?.purchasePrice ?? 0);
    const revenue = s.netAmount !== undefined ? s.netAmount : s.totalAmount;
    const cost = purchase * s.quantity;
    return sum + (revenue - cost);
  }, 0);

  // Filtered Books
  const filteredBooks = books.filter(b => {
    const matchesSearch = b.title.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesType = typeFilter === 'all' ? true : (typeFilter === 'books' ? !b.isChapter : b.isChapter);
    const matchesStock = stockFilter === 'all' ? true : (stockFilter === 'low' ? b.stock <= 5 : true);
    return matchesSearch && matchesType && matchesStock;
  });

  // Calculate payment method share
  const paymentMethodsStats = completedSales.reduce((acc, s) => {
    const method = s.paymentMethod || 'cash';
    const amount = s.netAmount !== undefined ? s.netAmount : s.totalAmount;
    acc[method] = (acc[method] || 0) + amount;
    return acc;
  }, { cash: 0, card: 0, transfer: 0 } as Record<string, number>);

  const totalSalesWithMethods = paymentMethodsStats.cash + paymentMethodsStats.card + paymentMethodsStats.transfer;

  // Find products with critically low stock (<= 2)
  const criticalBooks = books.filter(b => b.stock <= 2);

  // Find highest units sold book ID to mark as "Best Seller" (Best seller)
  const bestSellerId = (() => {
    if (completedSales.length === 0) return null;
    const salesCount: Record<string, number> = {};
    completedSales.forEach(s => {
      salesCount[s.bookId] = (salesCount[s.bookId] || 0) + s.quantity;
    });
    let maxQty = 0;
    let maxId: string | null = null;
    Object.entries(salesCount).forEach(([id, qty]) => {
      if (qty > maxQty) {
        maxQty = qty;
        maxId = id;
      }
    });
    return maxQty >= 3 ? maxId : null; // Only tag if sold at least 3 copies to make it genuine
  })();

  return (
    <div className="space-y-6 font-sans text-left relative" dir="ltr" id="books-view-root">
      
      {/* Toast Notification HUD */}
      {toast && (
        <div 
          className={`fixed top-4 left-4 z-50 flex items-center gap-3 px-5 py-3 rounded-2xl shadow-xl border animate-in slide-in-from-left duration-300 ${
            toast.type === 'success' 
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800' 
              : toast.type === 'error' 
                ? 'bg-rose-50 border-rose-200 text-rose-800' 
                : 'bg-indigo-50 border-indigo-200 text-indigo-800'
          }`}
          id="books-custom-toast"
        >
          {toast.type === 'success' && <CheckCircle2 className="w-5 h-5 text-emerald-600" />}
          {toast.type === 'error' && <AlertCircle className="w-5 h-5 text-rose-600" />}
          {toast.type === 'info' && <Info className="w-5 h-5 text-indigo-600" />}
          <span className="text-xs font-bold">{toast.message}</span>
          <button onClick={() => setToast(null)} className="p-1 hover:bg-black/5 rounded-lg transition-colors cursor-pointer">
            <X className="w-3.5 h-3.5 text-slate-400 hover:text-slate-600" />
          </button>
        </div>
      )}

      {/* Page Header */}
      <div className="border-b border-slate-200 pb-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-extrabold text-slate-900 flex items-center gap-2">
            <BookOpen className="w-6 h-6 text-indigo-600" />
            Bookstore & inventory
          </h2>
          <p className="text-xs text-slate-500 mt-1">Catalog, sales, restock, discounts, and receipts — all data from your inventory</p>
        </div>
      </div>

      {books.length === 0 && subTab === 'sales' && (
        <div className="rounded-2xl border border-dashed border-indigo-200 bg-indigo-50/40 px-6 py-10 text-center">
          <BookOpen className="mx-auto h-10 w-10 text-indigo-400" />
          <h3 className="mt-3 text-sm font-extrabold text-slate-900">Inventory is empty</h3>
          <p className="mt-1 text-xs text-slate-500 max-w-md mx-auto">
            Add real books and skill chapters with purchase and sale prices. Nothing is pre-loaded — your catalog is yours.
          </p>
          <button
            type="button"
            onClick={() => setSubTab('add')}
            className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-700"
          >
            <Plus className="h-3.5 w-3.5" />
            Add first book
          </button>
        </div>
      )}

      {/* Dynamic Summary Cards Shelf */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" id="books-stats-bento">
        
        {/* Metric 1: Net Profit */}
        <div className="bg-gradient-to-br from-indigo-50 to-white border border-indigo-150 rounded-2xl p-4.5 shadow-sm flex items-center gap-4 hover:shadow-md transition-all">
          <div className="p-3 bg-indigo-600 text-white rounded-xl">
            <TrendingUp className="w-5 h-5 stroke-[2.5]" />
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] text-indigo-600 font-black uppercase tracking-wider flex items-center gap-1">
              <Sparkles className="w-3 h-3 animate-pulse" />
              Net book profit
            </p>
            <p className="text-lg font-black text-indigo-950 font-mono">{formatAFN(totalNetProfit)}</p>
          </div>
        </div>

        {/* Metric 2: Asset Value / In Stock */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4.5 shadow-xs flex items-center gap-4 hover:shadow-md transition-shadow">
          <div className="p-3 bg-amber-50 text-amber-600 rounded-xl">
            <BookOpen className="w-5 h-5 stroke-[2.5]" />
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">Active bookstore stock</p>
            <p className="text-base font-black text-slate-900 font-mono">
              {totalCopiesInStock} copies <span className="text-[10px] text-slate-400">({totalDistinctBooks} titles)</span>
            </p>
          </div>
        </div>

        {/* Metric 3: Total Sales Revenue */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4.5 shadow-xs flex items-center gap-4 hover:shadow-md transition-shadow">
          <div className="p-3 bg-emerald-50 text-emerald-600 rounded-xl">
            <ShoppingBag className="w-5 h-5 stroke-[2.5]" />
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">Gross cash sales total</p>
            <p className="text-base font-black text-emerald-600 font-mono">{formatAFN(totalSalesRevenue)}</p>
          </div>
        </div>

        {/* Metric 4: Total Units Sold / Refunds */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4.5 shadow-xs flex items-center gap-4 hover:shadow-md transition-shadow">
          <div className="p-3 bg-slate-100 text-slate-600 rounded-xl">
            <ClipboardList className="w-5 h-5 stroke-[2.5]" />
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">Books sold / reversed</p>
            <p className="text-base font-black text-slate-800 font-mono">
              {totalSalesCopies} units <span className="text-[10px] text-rose-500 font-bold">({refundedSales.length} refunded)</span>
            </p>
          </div>
        </div>
      </div>

      {/* Sub tabs switch */}
      {isAuthorizedToManage && (
        <div className="flex gap-2 border-b border-slate-200 pb-px">
          <button
            onClick={() => setSubTab('sales')}
            className={`pb-2.5 px-4 font-bold text-xs border-b-2 transition-colors cursor-pointer ${
              subTab === 'sales'
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            Book sales & stock
          </button>
          <button
            onClick={() => setSubTab('add')}
            className={`pb-2.5 px-4 font-bold text-xs border-b-2 transition-colors cursor-pointer ${
              subTab === 'add'
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            Add book / chapter
          </button>
          <button
            onClick={() => setSubTab('analytics')}
            className={`pb-2.5 px-4 font-bold text-xs border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
              subTab === 'analytics'
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <BarChart3 className="w-4 h-4" />
            Sales analysis & net profit
          </button>
        </div>
      )}

      {subTab === 'sales' && (
        <div className="space-y-6">
          {/* Critical Inventory Alert Banner */}
          {criticalBooks.length > 0 && (
            <div className="bg-rose-50/80 border border-rose-200/60 rounded-3xl p-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 animate-in slide-in-from-top-4 duration-300">
              <div className="flex gap-3.5 text-left">
                <div className="p-3 bg-rose-100 text-rose-600 rounded-2xl h-fit">
                  <AlertTriangle className="w-5 h-5 text-rose-600 stroke-[2.5] animate-bounce" />
                </div>
                <div className="space-y-0.5">
                  <h4 className="font-extrabold text-rose-950 text-sm">Critical low-stock alert</h4>
                  <p className="text-xs text-rose-700/90 leading-relaxed font-medium">
                    Critical low stock on {criticalBooks.length} book(s)/chapter(s) ({criticalBooks.map(b => `"${b.title}"`).join(', ')}). Please restock soon to avoid stockouts during sales.
                  </p>
                </div>
              </div>
              <div className="flex gap-2 flex-wrap self-stretch md:self-auto justify-end">
                {criticalBooks.slice(0, 2).map(b => (
                  <button
                    key={b.id}
                    onClick={() => {
                      setRestockingBook(b);
                      setQuickRestockQty(25);
                    }}
                    className="bg-white hover:bg-rose-50 text-rose-800 border border-rose-200 hover:border-rose-300 font-extrabold text-[11px] py-2 px-3.5 rounded-xl transition-all cursor-pointer flex items-center gap-1.5 shadow-xs"
                  >
                    <Plus className="w-3.5 h-3.5 text-rose-600 stroke-[2.5]" />
                    Quick restock "{b.title.substring(0, 16)}..."
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Books directory list */}
          <div className="lg:col-span-8 space-y-4">
            
            {/* Advanced Search & Filtering HUD */}
            <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm space-y-3">
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="flex-1 relative">
                  <Search className="w-4 h-4 text-slate-400 absolute right-3 top-3" />
                  <input
                    type="text"
                    placeholder="Search books & chapters…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl pr-9 pl-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/10 focus:bg-white"
                  />
                </div>
                
                <div className="flex gap-2 text-xs">
                  <select
                    value={typeFilter}
                    onChange={(e) => setTypeFilter(e.target.value as any)}
                    className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500/10"
                  >
                    <option value="all">All products</option>
                    <option value="books">Full books only</option>
                    <option value="chapters">Skill chapters only</option>
                  </select>

                  <select
                    value={stockFilter}
                    onChange={(e) => setStockFilter(e.target.value as any)}
                    className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500/10"
                  >
                    <option value="all">Stock (all)</option>
                    <option value="low">Low stock</option>
                  </select>
                </div>
              </div>
            </div>

            <h3 className="text-sm font-extrabold text-slate-900 flex items-center gap-1.5">
              <BookOpen className="w-4 h-4 text-indigo-600" />
              Book & chapter stock list ({filteredBooks.length} titles)
            </h3>
            
            {filteredBooks.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-slate-400 text-xs">
                {books.length === 0 ? 'No books in inventory yet. Open “Add book / chapter” to build your catalog.' : 'No books match the current filters.'}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {filteredBooks.map((book) => {
                  const isLowStock = book.stock <= LOW_STOCK_THRESHOLD;
                  const restockCount = book.restockHistory?.length || 0;
                  const purchaseVal = book.purchasePrice ?? 0;
                  return (
                    <div key={book.id} className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm flex flex-col justify-between hover:border-slate-300 transition-colors">
                      <div className="flex flex-col space-y-3">
                        <div className="flex justify-between items-start">
                          <div className="space-y-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className={`inline-flex px-2 py-0.5 rounded text-[9px] font-bold ${book.isChapter ? 'bg-amber-50 text-amber-700' : 'bg-indigo-50 text-indigo-700'}`}>
                                {book.isChapter ? 'Skill chapter' : 'Full book'}
                              </span>
                              
                              {/* Best Seller badge */}
                              {book.id === bestSellerId && (
                                <span className="inline-flex items-center gap-0.5 bg-amber-500 text-white px-2 py-0.5 rounded text-[9px] font-black shadow-xs">
                                  <Sparkles className="w-2.5 h-2.5 animate-pulse" />
                                  Best seller
                                </span>
                              )}

                              {/* Restock indicator */}
                              {restockCount > 1 && (
                                <span className="inline-flex items-center gap-0.5 bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded text-[9px] font-bold">
                                  <History className="w-2.5 h-2.5" />
                                  {restockCount} restocks
                                </span>
                              )}
                            </div>
                            
                            <h4 className="font-bold text-slate-900 text-xs sm:text-sm mt-1">{book.title}</h4>
                            <div className="space-y-0.5 text-left">
                              <p className="text-xs font-semibold text-indigo-600 font-mono mt-1">Unit sale price: {formatAFN(book.price)}</p>
                              {isOwnerOrManager && (
                                <p className="text-[10px] font-medium text-slate-400 font-mono">Unit purchase: {formatAFN(purchaseVal)}</p>
                              )}
                            </div>
                            
                            {/* Entry Date */}
                            <div className="text-[10px] text-slate-400 font-medium flex items-center gap-1 mt-1.5" title="Last stock entry date">
                              <Calendar className="w-3.5 h-3.5 text-slate-400 stroke-[2]" />
                              <span>Last restock: {book.entryDate || '1405/04/15'}</span>
                            </div>
                          </div>
                          
                          <div className="text-left">
                            <p className="text-[10px] text-slate-400 font-semibold">Stock:</p>
                            <p className={`text-sm font-extrabold font-mono mt-0.5 ${isLowStock ? 'text-rose-600' : 'text-slate-800'}`}>
                              {book.stock} units
                            </p>
                            {isLowStock && (
                              <span className="text-[9px] text-rose-500 bg-rose-50 px-1.5 py-0.5 rounded-full font-bold mt-1 inline-block">Low stock</span>
                            )}
                          </div>
                        </div>

                        {/* Modern Stock Health Progress bar */}
                        <div className="space-y-1 bg-slate-50/60 p-2 rounded-xl border border-slate-100">
                          <div className="flex justify-between items-center text-[9px] font-bold">
                            <span className="text-slate-400">Restock level:</span>
                            <span className={book.stock === 0 ? 'text-rose-600' : isLowStock ? 'text-amber-600' : 'text-emerald-600'}>
                              {book.stock === 0 ? 'Out of stock' : isLowStock ? `Critical (${book.stock} units)` : `Adequate (${book.stock} units)`}
                            </span>
                          </div>
                          <div className="w-full bg-slate-200/70 rounded-full h-1.5 overflow-hidden">
                            <div 
                              className={`h-full rounded-full transition-all duration-500 ${
                                book.stock === 0 
                                  ? 'bg-rose-600' 
                                  : isLowStock 
                                    ? 'bg-rose-500 animate-pulse' 
                                    : book.stock > 30 
                                      ? 'bg-emerald-500' 
                                      : 'bg-indigo-500'
                              }`} 
                              style={{ width: `${Math.min(100, (book.stock / 50) * 100)}%` }}
                            />
                          </div>
                        </div>
                      </div>
                      
                      <div className="flex items-center justify-between mt-4 pt-2 border-t border-slate-100">
                        {/* replenishment history trigger */}
                        <button
                          type="button"
                          onClick={() => setSelectedBookHistory(book)}
                          className="text-[10px] text-slate-500 hover:text-indigo-600 hover:bg-indigo-50/50 px-2 py-1 rounded-md transition-colors font-semibold flex items-center gap-1 cursor-pointer"
                        >
                          <History className="w-3.5 h-3.5" />
                          Entry history
                        </button>

                        {isOwnerOrManager && (
                          <div className="flex gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                setRestockingBook(book);
                                setQuickRestockQty(10);
                              }}
                              className="text-[10px] bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-bold px-2 py-1 rounded-lg border border-emerald-200 transition-colors cursor-pointer flex items-center gap-1"
                              title="Quick restock"
                            >
                              <Plus className="w-3 h-3" />
                              Restock inventory
                            </button>
                            <button
                              type="button"
                              onClick={() => handleStartEditBook(book)}
                              className="text-[10px] bg-slate-50 hover:bg-indigo-50 hover:text-indigo-600 text-slate-600 font-bold px-2 py-1 rounded-lg border border-slate-200 transition-colors cursor-pointer flex items-center gap-1"
                            >
                              <Edit className="w-3 h-3" />
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => setBookToDelete(book)}
                              className="text-[10px] bg-slate-50 hover:bg-rose-50 hover:text-rose-600 text-slate-500 font-bold px-2 py-1 rounded-lg border border-slate-200 transition-colors cursor-pointer flex items-center gap-1"
                            >
                              <Trash2 className="w-3 h-3" />
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Historical sales logs */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-extrabold text-slate-900 flex items-center gap-1.5">
                  <ClipboardList className="w-5 h-5 text-indigo-600" />
                  Sales & refunds ledger
                </h3>
                <span className="text-[10px] font-bold bg-slate-50 border border-slate-150 px-2 py-1 rounded-lg text-slate-500">
                  {bookSales.length} total transactions
                </span>
              </div>
              <div className="overflow-x-auto text-xs">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-100 text-slate-500">
                      <th className="py-2 px-3 font-bold text-slate-700">Book / chapter</th>
                      <th className="py-2 px-3 font-bold text-slate-700 text-center">Qty</th>
                      <th className="py-2 px-3 font-bold text-slate-700">Buyer</th>
                      <th className="py-2 px-3 font-bold text-slate-700">Method</th>
                      <th className="py-2 px-3 font-bold text-slate-700">Sale total</th>
                      <th className="py-2 px-3 font-bold text-slate-700 font-mono">Date</th>
                      <th className="py-2 px-3 font-bold text-slate-700 text-center">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50 text-slate-600">
                    {bookSales.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="text-center py-6 text-slate-400">No sales recorded yet.</td>
                      </tr>
                    ) : (
                      bookSales.map((sale) => {
                        const bk = books.find(b => b.id === sale.bookId);
                        const isRefunded = sale.status === 'refunded';
                        const paymentMethodLabels = { cash: 'Cash', card: 'Card', transfer: 'Bank transfer' };
                        const methodLabel = paymentMethodLabels[sale.paymentMethod || 'cash'] || 'Cash';
                        
                        const actualAmount = sale.netAmount !== undefined ? sale.netAmount : sale.totalAmount;

                        return (
                          <tr key={sale.id} className={`hover:bg-slate-50/40 ${isRefunded ? 'bg-rose-50/20 text-slate-400 line-through' : ''}`}>
                            <td className="py-2.5 px-3 font-semibold text-slate-800">
                              <span className="flex items-center gap-1.5">
                                {isRefunded && <span className="bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded text-[8px] font-bold no-underline">Reversed</span>}
                                {bk ? bk.title : 'Deleted product'}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 text-center font-mono">{sale.quantity} units</td>
                            <td className="py-2.5 px-3">{sale.customerName}</td>
                            <td className="py-2.5 px-3">{methodLabel}</td>
                            <td className={`py-2.5 px-3 font-mono font-bold ${isRefunded ? 'text-rose-500 font-normal' : 'text-emerald-600'}`}>
                              {isRefunded ? '-' : ''}{formatAFN(actualAmount)}
                            </td>
                            <td className="py-2.5 px-3 font-mono text-slate-400">{sale.date}</td>
                            <td className="py-2.5 px-3 text-center">
                              <div className="flex items-center justify-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (bk) {
                                      setSelectedSaleReceipt({ sale, book: bk });
                                    } else {
                                      showToastMsg('Product info not found for this invoice.', 'error');
                                    }
                                  }}
                                  className="text-[10px] text-indigo-600 hover:text-indigo-800 hover:bg-indigo-50 px-2 py-1 rounded-md transition-all font-bold cursor-pointer inline-flex items-center gap-1 no-underline"
                                >
                                  <Printer className="w-3.5 h-3.5" />
                                  Print invoice
                                </button>

                                {!isRefunded && isOwnerOrManager && (
                                  <button
                                    type="button"
                                    onClick={() => setSaleToRefund(sale)}
                                    className="text-[10px] text-rose-600 hover:text-rose-800 hover:bg-rose-50 px-2 py-1 rounded-md transition-all font-bold cursor-pointer inline-flex items-center gap-1 no-underline"
                                    title="Refund invoice and return stock to inventory"
                                  >
                                    <RotateCcw className="w-3 h-3" />
                                    Refund
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Sell Book Form panel */}
          <div className="lg:col-span-4 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4 h-fit">
            <h3 className="text-sm font-extrabold text-slate-900 border-b border-slate-100 pb-2.5 flex items-center gap-1.5">
              <ShoppingBag className="w-5 h-5 text-indigo-600" />
              New sale invoice (smart discount)
            </h3>
            
            <form onSubmit={handleSaleSubmit} className="space-y-4 text-xs">
              {/* Book Selector */}
              <div className="space-y-1">
                <label className="block text-slate-600 font-medium">Book or skill chapter:</label>
                <select
                  value={selectedBookId}
                  onChange={(e) => {
                    setSelectedBookId(e.target.value);
                    setQuantity(1);
                  }}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 cursor-pointer focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="" disabled>--- Select book/chapter ---</option>
                  {books.map(b => (
                    <option key={b.id} value={b.id}>{b.title} ({formatAFN(b.price)} - stock: {b.stock})</option>
                  ))}
                </select>
              </div>

              {/* Quantity */}
              <div className="space-y-1">
                <label className="block text-slate-600 font-medium">Order qty:</label>
                <input
                  type="number"
                  value={quantity}
                  onChange={(e) => setQuantity(Math.max(1, Number(e.target.value)))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 font-mono"
                  min={1}
                  max={selectedBook ? selectedBook.stock : 10}
                  required
                />
                {quantity >= 5 && (
                  <div className="bg-amber-50 border border-amber-200 text-amber-800 p-2.5 rounded-lg flex flex-col gap-1.5 mt-1 text-[10px]">
                    <div className="flex items-center gap-1 font-semibold">
                      <Sparkles className="w-3.5 h-3.5 text-amber-600 animate-pulse" />
                      <span>Suggestion: apply bulk purchase discount</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setDiscountType('percent');
                        setDiscountInput('10');
                      }}
                      className="bg-amber-600 hover:bg-amber-700 text-white font-bold text-[9px] py-1 px-2 rounded-md transition-colors cursor-pointer self-start"
                    >
                      Auto-apply 10% bulk discount
                    </button>
                  </div>
                )}
              </div>

              {/* Discount Input Section */}
              <div className="space-y-1">
                <label className="block text-slate-600 font-medium">Apply sale discount:</label>
                <div className="flex gap-1.5">
                  <input
                    type="number"
                    value={discountInput}
                    onChange={(e) => setDiscountInput(e.target.value)}
                    className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono text-xs"
                    placeholder={discountType === 'percent' ? 'Discount % e.g. 10' : 'Discount amount e.g. 50'}
                    min={0}
                  />
                  <div className="flex border border-slate-200 rounded-lg overflow-hidden bg-slate-50 text-[10px] font-bold">
                    <button
                      type="button"
                      onClick={() => setDiscountType('percent')}
                      className={`px-2.5 py-1 transition-colors cursor-pointer ${discountType === 'percent' ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
                    >
                      Percent (%)
                    </button>
                    <button
                      type="button"
                      onClick={() => setDiscountType('afn')}
                      className={`px-2.5 py-1 transition-colors cursor-pointer ${discountType === 'afn' ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
                    >
                      AFN
                    </button>
                  </div>
                </div>
              </div>

              {/* Payment Method Selector */}
              <div className="space-y-1">
                <label className="block text-slate-600 font-medium">Customer payment method:</label>
                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setPaymentMethod('cash')}
                    className={`p-2 rounded-xl border text-[10px] font-bold text-center transition-all cursor-pointer ${
                      paymentMethod === 'cash' 
                        ? 'border-indigo-600 bg-indigo-50/50 text-indigo-700' 
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    Cash (till)
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaymentMethod('card')}
                    className={`p-2 rounded-xl border text-[10px] font-bold text-center transition-all cursor-pointer ${
                      paymentMethod === 'card' 
                        ? 'border-indigo-600 bg-indigo-50/50 text-indigo-700' 
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    Card reader
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaymentMethod('transfer')}
                    className={`p-2 rounded-xl border text-[10px] font-bold text-center transition-all cursor-pointer ${
                      paymentMethod === 'transfer' 
                        ? 'border-indigo-600 bg-indigo-50/50 text-indigo-700' 
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    Transfer
                  </button>
                </div>
              </div>

              {/* Student selection toggle */}
              <div className="space-y-1.5">
                <label className="block text-slate-600 font-medium">Assign to student? (optional)</label>
                <select
                  value={studentId}
                  onChange={(e) => {
                    setStudentId(e.target.value);
                    if (e.target.value) {
                      setCustomerName(''); // clear generic custom name
                    }
                  }}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 cursor-pointer focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="">Walk-in customer purchase</option>
                  {students.map(s => (
                    <option key={s.id} value={s.id}>{s.fullName} ({s.studentCode})</option>
                  ))}
                </select>
              </div>

              {/* Raw Customer Name */}
              {!studentId && (
                <div className="space-y-1">
                  <label className="block text-slate-600 font-medium">Walk-in customer name:</label>
                  <input
                    type="text"
                    placeholder="e.g. Ali Akbari"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5"
                    required
                  />
                </div>
              )}

              {/* Total invoice layout indicator */}
              <div className="bg-slate-50 border border-slate-100 rounded-xl p-4 space-y-1.5">
                <div className="flex justify-between text-slate-500 text-[11px]">
                  <span>Gross book price:</span>
                  <span className="font-mono">{formatAFN(grossCost)}</span>
                </div>
                {calculatedDiscount > 0 && (
                  <div className="flex justify-between text-rose-600 text-[11px]">
                    <span>Discount applied:</span>
                    <span className="font-mono">-{formatAFN(calculatedDiscount)}</span>
                  </div>
                )}
                <div className="flex justify-between text-slate-900 font-bold border-t border-slate-200/60 pt-1.5 mt-0.5">
                  <span>Net payable:</span>
                  <span className="font-mono text-indigo-600">{formatAFN(totalCost)}</span>
                </div>
              </div>

              <button
                type="submit"
                disabled={selectedBook ? selectedBook.stock < quantity : true}
                className={`w-full text-white font-bold py-3 rounded-lg transition-colors cursor-pointer shadow-sm text-center ${
                  selectedBook && selectedBook.stock >= quantity 
                    ? 'bg-indigo-600 hover:bg-indigo-700' 
                    : 'bg-slate-300 cursor-not-allowed'
                }`}
              >
                Post cash invoice and update till stock
              </button>
            </form>
          </div>
        </div>
        </div>
      )}

      {subTab === 'add' && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm max-w-2xl animate-in fade-in slide-in-from-bottom-4 duration-300">
          <div className="border-b border-slate-100 pb-3 mb-4 flex items-center justify-between">
            <div>
              <h3 className="font-extrabold text-slate-900 text-sm">Register new book or chapter</h3>
              <p className="text-[10px] text-slate-400 mt-0.5">Set sale and purchase prices for live net profit and inventory ROI calculations.</p>
            </div>
            <Sparkles className="w-5 h-5 text-indigo-600 animate-pulse" />
          </div>
          
          <form onSubmit={handleAddBookSubmit} className="space-y-4 text-xs">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="block text-slate-600 font-semibold">Product title (exact):</label>
                <input
                  type="text"
                  placeholder="e.g. TOEFL Reading Practice Chapter"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/10"
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="block text-slate-600 font-semibold">Product type:</label>
                <select
                  value={newIsChapter ? 'chapter' : 'book'}
                  onChange={(e) => setNewIsChapter(e.target.value === 'chapter')}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500/10"
                >
                  <option value="chapter">Skill chapter</option>
                  <option value="book">Full book</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="block text-slate-600 font-semibold">Sale price (AFN):</label>
                <input
                  type="number"
                  value={newPrice}
                  onChange={(e) => {
                    setNewPrice(Number(e.target.value));
                    // Purchase price is entered separately — not auto-estimated
                  }}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/10 font-mono"
                  min={0}
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="block text-slate-600 font-semibold">Purchase cost (AFN) — for margin:</label>
                <input
                  type="number"
                  value={newPurchasePrice}
                  onChange={(e) => setNewPurchasePrice(Number(e.target.value))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/10 font-mono"
                  min={0}
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="block text-slate-600 font-semibold">New stock qty (units):</label>
                <input
                  type="number"
                  value={newStock}
                  onChange={(e) => setNewStock(Number(e.target.value))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/10 font-mono"
                  min={1}
                  required
                />
              </div>

              {/* Entry Date Picker */}
              <div className="space-y-1">
                <label className="block text-slate-600 font-semibold">Warehouse entry date:</label>
                <ShamsiDateInput value={newEntryDate} onChange={(v) => setNewEntryDate(v)} required />
              </div>
            </div>

            <button
              type="submit"
              className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 px-6 rounded-lg transition-colors cursor-pointer shadow-sm mt-2 flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              Add & sync with inventory stock
            </button>
          </form>
        </div>
      )}

      {subTab === 'analytics' && (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300">
          {/* Header Action Bar */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 bg-indigo-50/40 border border-indigo-100 rounded-2xl p-4">
            <div className="space-y-0.5 text-left">
              <h3 className="font-extrabold text-slate-900 text-sm">Inventory profit & asset dashboard</h3>
              <p className="text-[10px] text-slate-500 font-semibold">Live ROI, payment mix, and management reporting</p>
            </div>
            <button
              type="button"
              onClick={() => setShowAuditModal(true)}
              className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs py-2 px-4 rounded-xl transition-colors cursor-pointer shadow-md shadow-indigo-600/10 flex items-center gap-1.5"
            >
              <Printer className="w-3.5 h-3.5" />
              Print full inventory audit report
            </button>
          </div>

          {/* Stats Bento Layout */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            
            {/* ROI Card */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
              <h3 className="text-xs font-black text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                <TrendingUp className="w-4 h-4 text-emerald-500" />
                Profitability & ROI
              </h3>
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Inventory value at cost:</span>
                  <span className="font-mono font-bold text-slate-700">{formatAFN(totalAcquisitionCost)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Inventory retail potential:</span>
                  <span className="font-mono font-bold text-slate-700">{formatAFN(totalAssetValue)}</span>
                </div>
                <div className="flex justify-between text-xs border-t border-slate-100 pt-2 font-bold">
                  <span className="text-indigo-600">Remaining inventory profit potential:</span>
                  <span className="font-mono text-indigo-700">{formatAFN(totalAssetValue - totalAcquisitionCost)}</span>
                </div>
                <div className="flex justify-between text-xs pt-1 font-bold">
                  <span className="text-emerald-600">Realized gross profit:</span>
                  <span className="font-mono text-emerald-700">{formatAFN(totalSalesRevenue)}</span>
                </div>
              </div>
            </div>

            {/* Payment Methods Chart Box */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-3.5">
              <h3 className="text-xs font-black text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                <CreditCard className="w-4 h-4 text-indigo-500" />
                Revenue by payment method
              </h3>
              
              <div className="space-y-2.5">
                {/* Cash Progress bar */}
                <div className="space-y-1">
                  <div className="flex justify-between text-[11px] font-semibold text-slate-600">
                    <span>Cash payment</span>
                    <span className="font-mono">{formatAFN(paymentMethodsStats.cash)} ({totalSalesWithMethods > 0 ? Math.round((paymentMethodsStats.cash / totalSalesWithMethods) * 100) : 0}%)</span>
                  </div>
                  <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                    <div 
                      className="bg-emerald-500 h-full rounded-full transition-all duration-500" 
                      style={{ width: `${totalSalesWithMethods > 0 ? (paymentMethodsStats.cash / totalSalesWithMethods) * 100 : 0}%` }}
                    />
                  </div>
                </div>

                {/* Card Progress bar */}
                <div className="space-y-1">
                  <div className="flex justify-between text-[11px] font-semibold text-slate-600">
                    <span>Card (POS)</span>
                    <span className="font-mono">{formatAFN(paymentMethodsStats.card)} ({totalSalesWithMethods > 0 ? Math.round((paymentMethodsStats.card / totalSalesWithMethods) * 100) : 0}%)</span>
                  </div>
                  <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                    <div 
                      className="bg-indigo-500 h-full rounded-full transition-all duration-500" 
                      style={{ width: `${totalSalesWithMethods > 0 ? (paymentMethodsStats.card / totalSalesWithMethods) * 100 : 0}%` }}
                    />
                  </div>
                </div>

                {/* Transfer Progress bar */}
                <div className="space-y-1">
                  <div className="flex justify-between text-[11px] font-semibold text-slate-600">
                    <span>Bank transfer</span>
                    <span className="font-mono">{formatAFN(paymentMethodsStats.transfer)} ({totalSalesWithMethods > 0 ? Math.round((paymentMethodsStats.transfer / totalSalesWithMethods) * 100) : 0}%)</span>
                  </div>
                  <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                    <div 
                      className="bg-amber-500 h-full rounded-full transition-all duration-500" 
                      style={{ width: `${totalSalesWithMethods > 0 ? (paymentMethodsStats.transfer / totalSalesWithMethods) * 100 : 0}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Stock Health Chart Box */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-3.5">
              <h3 className="text-xs font-black text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4 text-amber-500" />
                Stock health status
              </h3>
              
              <div className="grid grid-cols-2 gap-3 text-center">
                <div className="bg-rose-50/50 border border-rose-100 rounded-xl p-3">
                  <span className="block text-[10px] text-slate-400 font-bold">Books needing urgent restock</span>
                  <span className="text-lg font-black text-rose-600 font-mono mt-0.5 block">
                    {books.filter(b => b.stock <= 5).length} <span className="text-xs text-rose-400">items</span>
                  </span>
                </div>
                <div className="bg-emerald-50/50 border border-emerald-100 rounded-xl p-3">
                  <span className="block text-[10px] text-slate-400 font-bold">Adequate stock</span>
                  <span className="text-lg font-black text-emerald-600 font-mono mt-0.5 block">
                    {books.filter(b => b.stock > 5).length} <span className="text-xs text-emerald-400">items</span>
                  </span>
                </div>
              </div>

              <div className="text-[10px] text-slate-400 leading-relaxed text-left pt-0.5">
                * Books with 5 units or fewer are marked “Low stock” so print orders can be placed before semesters start.
              </div>
            </div>
          </div>

          {/* Top Selling Products List */}
          <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-sm space-y-4">
            <h3 className="text-xs font-black text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-indigo-500" />
              Product sales ranking and finance yield
            </h3>

            <div className="overflow-x-auto text-xs">
              <table className="w-full text-left border-collapse">
                <thead className="bg-slate-50 text-slate-500">
                  <tr className="border-b border-slate-200">
                    <th className="py-2.5 px-3 font-bold text-slate-700">Product name</th>
                    <th className="py-2.5 px-3 font-bold text-slate-700 text-center">Product type</th>
                    <th className="py-2.5 px-3 font-bold text-slate-700 text-center">Copies sold</th>
                    <th className="py-2.5 px-3 font-bold text-slate-700">Total revenue (net sales)</th>
                    <th className="py-2.5 px-3 font-bold text-slate-700">Purchase cost (investment)</th>
                    <th className="py-2.5 px-3 font-bold text-slate-700">Net profit earned</th>
                    <th className="py-2.5 px-3 font-bold text-slate-700 text-center">Net margin</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-600">
                  {books.map(b => {
                    const salesForBook = completedSales.filter(s => s.bookId === b.id);
                    const unitsSold = salesForBook.reduce((sum, s) => sum + s.quantity, 0);
                    const grossRev = salesForBook.reduce((sum, s) => sum + (s.netAmount !== undefined ? s.netAmount : s.totalAmount), 0);
                    const purchaseVal = (b.purchasePrice ?? 0);
                    const totalCostVal = purchaseVal * unitsSold;
                    const netProfitVal = grossRev - totalCostVal;
                    const profitMargin = grossRev > 0 ? Math.round((netProfitVal / grossRev) * 100) : 0;

                    return (
                      <tr key={b.id} className="hover:bg-slate-50/40 font-medium">
                        <td className="py-2.5 px-3 font-bold text-slate-800">{b.title}</td>
                        <td className="py-2.5 px-3 text-center">
                          <span className={`inline-flex px-2 py-0.5 rounded text-[9px] font-bold ${b.isChapter ? 'bg-amber-50 text-amber-700' : 'bg-indigo-50 text-indigo-700'}`}>
                            {b.isChapter ? 'Skill chapter' : 'Full book'}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-center font-mono font-bold text-slate-900">{unitsSold} units</td>
                        <td className="py-2.5 px-3 font-mono">{formatAFN(grossRev)}</td>
                        <td className="py-2.5 px-3 font-mono text-slate-400">{formatAFN(totalCostVal)}</td>
                        <td className={`py-2.5 px-3 font-mono font-black ${netProfitVal > 0 ? 'text-emerald-600' : netProfitVal < 0 ? 'text-rose-600' : 'text-slate-400'}`}>
                          {formatAFN(netProfitVal)}
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <span className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            profitMargin >= 40 ? 'bg-emerald-50 text-emerald-700' : profitMargin > 0 ? 'bg-indigo-50 text-indigo-700' : 'bg-slate-100 text-slate-500'
                          }`}>
                            {profitMargin}%
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <BooksModals
        issuer={issuer}
        editingBook={editingBook}
        setEditingBook={setEditingBook}
        editTitle={editTitle}
        setEditTitle={setEditTitle}
        editIsChapter={editIsChapter}
        setEditIsChapter={setEditIsChapter}
        editPrice={editPrice}
        setEditPrice={setEditPrice}
        editPurchasePrice={editPurchasePrice}
        setEditPurchasePrice={setEditPurchasePrice}
        editStock={editStock}
        setEditStock={setEditStock}
        handleEditBookSubmit={handleEditBookSubmit}
        selectedBookHistory={selectedBookHistory}
        setSelectedBookHistory={setSelectedBookHistory}
        selectedSaleReceipt={selectedSaleReceipt}
        setSelectedSaleReceipt={setSelectedSaleReceipt}
        bookToDelete={bookToDelete}
        setBookToDelete={setBookToDelete}
        handleDeleteConfirm={handleDeleteConfirm}
        saleToRefund={saleToRefund}
        setSaleToRefund={setSaleToRefund}
        handleRefundConfirm={handleRefundConfirm}
        restockingBook={restockingBook}
        setRestockingBook={setRestockingBook}
        quickRestockQty={quickRestockQty}
        setQuickRestockQty={setQuickRestockQty}
        handleQuickRestockSubmit={handleQuickRestockSubmit}
        showAuditModal={showAuditModal}
        setShowAuditModal={setShowAuditModal}
        books={books}
        totalAcquisitionCost={totalAcquisitionCost}
        totalAssetValue={totalAssetValue}
      />
    </div>
  );
}
