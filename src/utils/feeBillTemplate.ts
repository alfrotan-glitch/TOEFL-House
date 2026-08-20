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
import { openPrintDocument, type PrintDocumentOptions } from '../design-system/print';

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
 * Builds the receipt as print-document options.
 *
 * `issuer` carries the branch's own name/address/phone/email. Every line is
 * optional: a branch with nothing configured still produces a valid, correctly
 * laid-out receipt rather than blank rows or the word "null".
 *
 * Paper is `receipt80` — a continuous 80mm till roll — so a short receipt is
 * not paginated onto a second sheet. The page rule comes from the print
 * authority rather than from a `<style>` block written here, so this document
 * gains direction handling and loses nothing: the shell owns paper, this module
 * owns the receipt's own look.
 */
export function buildFeeBillDocument(
  data: FeeBillData,
  issuer: DocumentIssuer,
  formatMoney: (n: number) => string,
): PrintDocumentOptions {
  const row = (label: string, value: string, cls = '') =>
    `<div class="row ${cls}"><span class="label">${esc(label)}</span><span class="value">${esc(value)}</span></div>`;

  return {
    title: `Receipt ${data.receiptNumber || ''}`.trim(),
    paper: 'receipt80',
    hideFooter: true,
    extraCss: `
      body { font-family: 'Courier New', monospace; font-size: 12px; max-width: 380px; margin: 0 auto; color: #1e293b; }
      .row { display: flex; justify-content: space-between; padding: 4px 0; gap: 12px; }
      .label { color: #64748b; }
      /* Logical alignment: a Persian/Dari receipt mirrors without a second
         stylesheet, exactly as the screen does. */
      .value { font-weight: 700; text-align: end; word-break: break-word; }
      .divider { border-top: 1px dashed #cbd5e1; margin: 8px 0; }
      .total-row { font-size: 14px; font-weight: 800; }
      .footer { text-align: center; margin-top: 16px; padding-top: 12px; border-top: 2px dashed #94a3b8; font-size: 10px; color: #94a3b8; }
      @media print {
        body { max-width: none; padding: 0; }
        /* Backgrounds and images are not printed by default in some engines,
           which drops the logo entirely. */
        .th-brand-header img { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .row, .footer { page-break-inside: avoid; }
      }
    `,
    bodyHtml: `
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
    `,
  };
}

/** Opens the receipt in a print window. Returns false when a popup is blocked. */
export function printFeeBill(
  data: FeeBillData,
  issuer: DocumentIssuer,
  formatMoney: (n: number) => string,
): boolean {
  return openPrintDocument(buildFeeBillDocument(data, issuer, formatMoney));
}
