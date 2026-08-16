/**
 * The student fee bill / registration receipt.
 * ============================================================================
 * Extracted from ConvertToStudentModal so the emitted document can be parsed
 * and asserted by tests. While it lived inside a click handler that calls
 * `window.open`, the only way to check it was to read the JSX by eye — which
 * is exactly how it kept a hardcoded institute name, no logo and no branch
 * contact for so long.
 *
 * This module builds a string and touches no browser API, so the real printed
 * output can be rendered in jsdom and inspected element by element.
 */
import { BRAND_NAME, BRAND_SLOGAN, brandPrintHeaderHtml } from '../config/branding';
import type { DocumentIssuer } from '../config/documentIssuer';

export interface FeeBillData {
  receiptNumber: string | null;
  studentName: string;
  studentCode: string | null;
  className: string | null;
  invoiceNumber: string | null;
  /** Fee before discount. Only rendered when a discount applies. */
  grossFee: number;
  discountPercent: number;
  netPayable: number;
  paidToday: number;
  /** Outstanding after this payment; only rendered when > 0. */
  remaining: number;
  paymentMethodLabel: string;
  issueDate: string;
}

/** Escapes interpolated values so a student name cannot inject markup. */
function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

/**
 * Builds the complete printable document.
 *
 * `issuer` carries the branch's own name/address/phone/email. Every line is
 * optional: a branch with nothing configured still produces a valid, correctly
 * laid-out receipt rather than blank rows or the word "null".
 */
export function buildFeeBillHtml(data: FeeBillData, issuer: DocumentIssuer, formatMoney: (n: number) => string): string {
  const row = (label: string, value: string, cls = '') =>
    `<div class="row ${cls}"><span class="label">${esc(label)}</span><span class="value">${esc(value)}</span></div>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>Receipt ${esc(data.receiptNumber || '')}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Courier New', monospace; font-size: 12px; padding: 20px; max-width: 380px; margin: 0 auto; color: #1e293b; }
        .row { display: flex; justify-content: space-between; padding: 4px 0; gap: 12px; }
        .label { color: #64748b; } .value { font-weight: 700; text-align: right; word-break: break-word; }
        .divider { border-top: 1px dashed #cbd5e1; margin: 8px 0; }
        .total-row { font-size: 14px; font-weight: 800; }
        .footer { text-align: center; margin-top: 16px; padding-top: 12px; border-top: 2px dashed #94a3b8; font-size: 10px; color: #94a3b8; }
        /* Printing rules. Without these the browser applied screen margins and
           could paginate a short receipt across two sheets, and the logo was
           dropped entirely because backgrounds/images are not printed by
           default in some engines. */
        @page { size: 80mm auto; margin: 6mm; }
        @media print {
          body { max-width: none; padding: 0; }
          .th-brand-header img { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .row, .footer { page-break-inside: avoid; }
        }
      </style></head><body>
        ${brandPrintHeaderHtml('Registration Receipt', issuer)}
        ${row('Receipt #', data.receiptNumber || '-')}
        ${row('Date', data.issueDate)}
        ${row('Student', data.studentName)}
        ${row('Student Code', data.studentCode || '-')}
        <div class="divider"></div>
        ${row('Class', data.className || '-')}
        ${row('Invoice #', data.invoiceNumber || '-')}
        ${data.discountPercent > 0
          ? row('Gross Fee', formatMoney(data.grossFee)) +
            row(`Discount (${data.discountPercent}%)`, `-${formatMoney(data.grossFee - data.netPayable)}`)
          : ''}
        <div class="divider"></div>
        ${row('Net Payable', `${formatMoney(data.netPayable)} AFN`, 'total-row')}
        <div class="divider"></div>
        ${row('Paid Today', `${formatMoney(data.paidToday)} AFN`)}
        ${row('Payment Method', data.paymentMethodLabel)}
        ${data.remaining > 0 ? `<div class="divider"></div>${row('Remaining', `${formatMoney(data.remaining)} AFN`)}` : ''}
        <div class="footer"><p>Thank you for choosing ${esc(BRAND_NAME)}!</p><p style="margin-top:2px;">${esc(BRAND_SLOGAN)}</p><p style="margin-top:4px;">This is a system-generated receipt.</p></div>
      </body></html>`;
}
