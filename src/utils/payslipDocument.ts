/**
 * The salary payslip, as a printed document.
 * ============================================================================
 * A payslip is a financial receipt an employee keeps, so it is built from the
 * payment data rather than scraped out of the screen.
 *
 * Scraping `innerHTML` from the modal — the obvious shortcut — produces a
 * document carrying Tailwind class names into a window that has no Tailwind:
 * every rule silently does nothing, and the slip prints as unstyled text in
 * whatever order the markup happened to be in. It also cannot control paper,
 * because there is no stylesheet to put `@page` in.
 *
 * Direction follows the document's own language. Hard-coding `direction: rtl`
 * on a slip whose labels read "Base Amount" and "Settlement Type" mirrors an
 * English document for no reason; a Persian/Dari slip gets RTL because its
 * `lang` says so, which is the same rule the screen follows.
 */
import { openPrintDocument, escapeHtml, type PrintDocumentOptions } from '../design-system/print';
import type { AppLanguage } from '../design-system/direction-context';
import { brandPrintHeaderHtml } from '../config/branding';

export interface PayslipData {
  /** Receipt number printed on the slip and quoted in the ledger. */
  serialNo: string;
  /** Issue date, ISO. */
  date: string;
  fullName: string;
  /** Position as it should read on the slip, e.g. "Teacher". */
  role: string;
  /** Shamsi period key of the work month, e.g. '1405-05'. */
  month: string;
  baseSalary: number;
  paymentType: string;
  /** Net amount actually paid. */
  amount: number;
}

export interface PayslipDocumentInput extends PayslipData {
  /** Pre-formatted so this module owns no money or calendar formatting. */
  monthLabel: string;
  dateLabel: string;
  baseSalaryLabel: string;
  amountLabel: string;
  lang?: AppLanguage;
}

/**
 * A payslip is a designed artifact rather than a report, so it supplies its own
 * type scale and boxes. Paper setup — size, margins, direction, page numbering
 * — still comes from the shared shell, because those are properties of paper.
 */
const PAYSLIP_CSS = `
  .ps-title {
    text-align: center;
    font-weight: 800;
    font-size: 12px;
    letter-spacing: .04em;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    padding: 6px;
    margin: 10px 0 14px;
  }
  .ps-ref { font-family: ui-monospace, monospace; font-size: 10px; text-align: end; }
  .ps-grid { display: flex; gap: 12px; }
  .ps-card {
    flex: 1;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 8px 10px;
  }
  .ps-row {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    padding: 3px 0;
  }
  .ps-row + .ps-row { border-top: 1px dotted #e2e8f0; }
  .ps-label { color: #475569; }
  .ps-value { font-weight: 700; }
  .ps-net { font-family: ui-monospace, monospace; font-weight: 800; }
`;

function row(label: string, value: string, valueClass = ''): string {
  return `<div class="ps-row"><span class="ps-label">${escapeHtml(label)}</span><span class="ps-value ${valueClass}">${escapeHtml(value)}</span></div>`;
}

/**
 * Builds the payslip document options.
 *
 * Separated from opening the window so a test can assert the markup. A popup
 * cannot be reviewed by eye.
 */
export function buildPayslipDocument(input: PayslipDocumentInput): PrintDocumentOptions {
  return {
    title: `Salary Slip ${input.serialNo}`,
    lang: input.lang ?? 'en',
    extraCss: PAYSLIP_CSS,
    footerNote: `Salary slip ${input.serialNo} · ${input.fullName}`,
    signatures: [
      { role: 'Recipient signature' },
      { role: 'Finance Manager' },
      { role: 'Director (authorized signatory)' },
    ],
    bodyHtml: `
      ${brandPrintHeaderHtml('Finance calculation, salary payment, and central treasury')}
      <div class="ps-ref">Receipt No: ${escapeHtml(input.serialNo)} &middot; Date: ${escapeHtml(input.dateLabel)}</div>
      <div class="ps-title">Official monthly salary settlement slip</div>
      <div class="ps-grid th-keep">
        <div class="ps-card">
          ${row('Employee name', input.fullName)}
          ${row('Role', input.role)}
          ${row('Work month', input.monthLabel)}
        </div>
        <div class="ps-card">
          ${row('Base amount', input.baseSalaryLabel, 'ps-net')}
          ${row('Settlement type', input.paymentType.toUpperCase())}
          ${row('Net paid', input.amountLabel, 'ps-net')}
        </div>
      </div>
    `,
  };
}

/** Opens the payslip in a print window. Returns false when a popup is blocked. */
export function printPayslip(input: PayslipDocumentInput): boolean {
  return openPrintDocument(buildPayslipDocument(input));
}
