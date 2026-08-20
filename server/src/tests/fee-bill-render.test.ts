/**
 * The printed student fee bill, rendered and inspected as a DOM
 * ============================================================================
 * These parse the ACTUAL document the print window receives, using jsdom,
 * rather than asserting on the presence of substrings in a .tsx file. That
 * distinction matters: the bill carried a hardcoded institute name, no logo
 * and no branch contact for a long time precisely because the only available
 * check was reading the JSX by eye.
 *
 * This is as close to "open the browser print flow" as this environment
 * permits — same HTML, same parser class, real element queries. What it
 * cannot do is rasterise a page; paper output remains a human check.
 */
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildFeeBillDocument, type FeeBillData } from '../../../src/utils/feeBillTemplate.js';
import { buildPrintDocument } from '../../../src/design-system/print.js';

/**
 * The receipt now goes through the shared print shell, so the assertions run
 * against the document the operator actually gets — page rule included — rather
 * than against the fragment this module contributes to it.
 */
const buildFeeBillHtml = (
  data: FeeBillData,
  issuer: Parameters<typeof buildFeeBillDocument>[1],
  money: (n: number) => string,
) => buildPrintDocument(buildFeeBillDocument(data, issuer, money));
import { resolveDocumentIssuer } from '../../../src/config/documentIssuer.js';
import { BRAND_NAME, BRAND_SLOGAN, BRAND_LOGO_URL } from '../../../src/config/branding.js';
import type { Branch } from '../../../src/types.js';

const money = (n: number) => new Intl.NumberFormat('en-US').format(n);

const BILL: FeeBillData = {
  receiptNumber: 'R-00000042',
  studentName: 'Ahmad Rahimi',
  studentCode: 'TH-001042',
  className: 'General English — Beginner',
  invoiceNumber: 'INV-00042',
  grossFee: 5000,
  discountPercent: 10,
  netPayable: 4500,
  paidToday: 2000,
  remaining: 2500,
  paymentMethodLabel: 'Cash',
  issueDate: '2026-08-16',
};

const FULL_BRANCH = {
  id: '1', name: 'Main Branch', location: 'Kabul, Karte-4',
  address: 'Kabul, Karte-4', phone: '0700123456', email: 'main@toeflhouse.af',
} as Branch;

/** A branch where nothing optional has been configured yet. */
const BARE_BRANCH = { id: '2', name: 'Herat Branch', location: '' } as Branch;

function render(branch: Branch | null, data: FeeBillData = BILL) {
  const html = buildFeeBillHtml(data, resolveDocumentIssuer(branch), money);
  return new JSDOM(html).window.document;
}

/** All visible text, whitespace-collapsed, as a printed page would read. */
const textOf = (doc: Document) => (doc.body.textContent || '').replace(/\s+/g, ' ').trim();

describe('printed fee bill — brand identity', () => {
  it('renders the official logo as a real <img> pointing at the one canonical asset', () => {
    const doc = render(FULL_BRANCH);
    const img = doc.querySelector('.th-brand-header img') as HTMLImageElement | null;

    expect(img, 'the receipt must contain a logo image element').not.toBeNull();
    expect(img!.getAttribute('src')).toContain(BRAND_LOGO_URL);
    expect(img!.getAttribute('alt')).toBe(BRAND_NAME);
  });

  it('prints the official name and the exact slogan', () => {
    const text = textOf(render(FULL_BRANCH));
    expect(text).toContain(BRAND_NAME);
    expect(text).toContain(BRAND_SLOGAN);
    // The regression: a hand-typed "TOEFL HOUSE" that drifted from BRAND_NAME.
    expect(doesNotContainStandaloneLiteral(text)).toBe(true);
  });
});

/** True when the document has no bare "TOEFL HOUSE" outside the real brand name. */
function doesNotContainStandaloneLiteral(text: string): boolean {
  return !/(^|[^e])TOEFL HOUSE/.test(text.replace(new RegExp(BRAND_NAME, 'g'), ''));
}

describe('printed fee bill — authoritative branch contact', () => {
  it('prints the configured branch name, address, phone and email', () => {
    const text = textOf(render(FULL_BRANCH));
    expect(text).toContain('Main Branch');
    expect(text).toContain('Kabul, Karte-4');
    expect(text).toContain('0700123456');
    expect(text).toContain('main@toeflhouse.af');
  });

  it('contains no hardcoded contact details', () => {
    const html = buildFeeBillHtml(BILL, resolveDocumentIssuer(FULL_BRANCH), money);
    // The literal the book receipt used to print on every copy.
    expect(html).not.toContain('0788223344');
    // Any Afghan mobile literal other than the one this branch configured.
    const numbers = html.match(/0\d{9}/g) || [];
    expect(numbers.every((n) => n === '0700123456')).toBe(true);
  });

  it('a branch with no phone/address/email omits those lines without breaking layout', () => {
    const doc = render(BARE_BRANCH);
    const text = textOf(doc);

    expect(text).toContain('Herat Branch');
    // Nothing invented, and no "null"/"undefined" leaking onto a financial document.
    expect(text).not.toMatch(/null|undefined/);
    // Structure survives: header, all data rows and the footer still render.
    expect(doc.querySelector('.th-brand-header')).not.toBeNull();
    expect(doc.querySelectorAll('.row').length).toBeGreaterThanOrEqual(8);
    expect(doc.querySelector('.footer')).not.toBeNull();
  });

  it('renders correctly when there is no branch at all', () => {
    const doc = render(null);
    expect(textOf(doc)).not.toMatch(/null|undefined/);
    expect(doc.querySelector('.th-brand-header img')).not.toBeNull();
  });
});

describe('printed fee bill — financial content', () => {
  it('shows every figure an institutional receipt must carry', () => {
    const text = textOf(render(FULL_BRANCH));
    for (const expected of [
      'R-00000042', 'Ahmad Rahimi', 'TH-001042', 'INV-00042',
      'General English', '2026-08-16', 'Cash',
      '5,000',  // gross
      '4,500',  // net payable
      '2,000',  // paid today
      '2,500',  // remaining
    ]) {
      expect(text, `receipt must show ${expected}`).toContain(expected);
    }
    expect(text).toContain('Discount (10%)');
  });

  it('omits the discount and remaining rows when they do not apply', () => {
    const settled: FeeBillData = { ...BILL, discountPercent: 0, netPayable: 5000, paidToday: 5000, remaining: 0 };
    const text = textOf(render(FULL_BRANCH, settled));
    expect(text).not.toContain('Discount');
    expect(text).not.toContain('Remaining');
    expect(text).toContain('Net Payable');
  });

  it('escapes interpolated values so a name cannot inject markup', () => {
    const hostile: FeeBillData = { ...BILL, studentName: '<script>alert(1)</script>' };
    const doc = render(FULL_BRANCH, hostile);
    expect(doc.querySelectorAll('script')).toHaveLength(0);
    expect(textOf(doc)).toContain('<script>alert(1)</script>');
  });
});

describe('printed fee bill — print formatting', () => {
  it('declares page geometry and print rules so the sheet is not mis-paginated', () => {
    const html = buildFeeBillHtml(BILL, resolveDocumentIssuer(FULL_BRANCH), money);
    expect(html).toContain('@page');
    expect(html).toContain('@media print');
    // Rows must not be split across two sheets.
    expect(html).toContain('page-break-inside: avoid');
    // Browsers drop images/backgrounds when printing unless told otherwise.
    expect(html).toContain('print-color-adjust: exact');
  });

  it('is a complete, well-formed document', () => {
    const html = buildFeeBillHtml(BILL, resolveDocumentIssuer(FULL_BRANCH), money);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    const doc = new JSDOM(html).window.document;
    expect(doc.querySelector('meta[charset]')).not.toBeNull();
    expect(doc.title).toContain('R-00000042');
  });
});
