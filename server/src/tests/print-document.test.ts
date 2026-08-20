/**
 * A printed document is a deliverable, and these are its properties.
 * ============================================================================
 * Printing used to be six components each calling `window.open` and writing
 * their own `<style>`. The only way to check any of it was to print it and
 * look, which is why none of them had the properties that make paper usable.
 *
 * Building the document is now separated from opening the window precisely so
 * it can be asserted here. Each test below corresponds to a defect the old
 * approach actually had.
 */
import { describe, it, expect } from 'vitest';
import { buildPrintDocument, escapeHtml } from '../../../src/design-system/print';
import { buildPayslipDocument } from '../../../src/utils/payslipDocument';

const doc = (over: Partial<Parameters<typeof buildPrintDocument>[0]> = {}) =>
  buildPrintDocument({ title: 'Test document', bodyHtml: '<p>body</p>', ...over });

describe('paper setup', () => {
  it('declares a page size and real print margins', () => {
    // Without @page the browser picks margins, and the document was relying on
    // an on-screen `margin:40px` that print ignores.
    const html = doc();
    expect(html).toMatch(/@page\s*\{[^}]*size:\s*A4/);
    expect(html).toMatch(/@page\s*\{[^}]*margin:/);
  });

  it('repeats table headers across page breaks', () => {
    // Page two of a long table was a wall of unlabelled numbers.
    expect(doc()).toContain('thead { display: table-header-group; }');
  });

  it('keeps rows and signature blocks intact across a break', () => {
    const html = doc();
    expect(html).toMatch(/tr,\s*\.th-keep\s*\{[^}]*break-inside:\s*avoid/);
    expect(html).toMatch(/\.th-signatures\s*\{[^}]*break-inside:\s*avoid/);
  });

  it('numbers pages so a missing sheet is visible', () => {
    expect(doc()).toContain('counter-increment: page');
  });
});

describe('direction', () => {
  it('defaults to the English left-to-right document', () => {
    expect(doc()).toContain('<html lang="en" dir="ltr">');
  });

  it('prints a Persian/Dari document right-to-left', () => {
    expect(doc({ lang: 'fa' })).toContain('<html lang="fa" dir="rtl">');
  });

  it('aligns text and numbers logically, never to a fixed side', () => {
    const html = doc();
    // `text-align: left` would print a Persian report left-aligned.
    expect(html).not.toMatch(/text-align:\s*left/);
    expect(html).not.toMatch(/text-align:\s*right/);
    expect(html).toMatch(/text-align:\s*start/);
    expect(html).toMatch(/\.num\s*\{[^}]*text-align:\s*end/);
  });

  it('uses tabular figures so number columns line up', () => {
    expect(doc()).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });
});

describe('document content', () => {
  it('carries the body it was given', () => {
    expect(doc({ bodyHtml: '<h2>Income</h2>' })).toContain('<h2>Income</h2>');
  });

  it('escapes the title rather than letting it break the document', () => {
    const html = doc({ title: 'Q1 <script>alert(1)</script> & co' });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('renders signature lines when the document needs them', () => {
    const html = doc({ signatures: [{ role: 'Prepared by', name: 'A. Frotan' }, { role: 'Approved by' }] });
    expect(html).toContain('Prepared by — A. Frotan');
    expect(html).toContain('Approved by');
  });

  it('omits the signature block entirely when there is none', () => {
    // Assert the rendered ELEMENT, not the class name — the class is always
    // present in the stylesheet, so a substring check here proves nothing.
    expect(doc()).not.toContain('<div class="th-signatures">');
    expect(doc({ signatures: [{ role: 'Prepared by' }] })).toContain('<div class="th-signatures">');
  });

  it('prints the footer note, and can suppress the footer for a single sheet', () => {
    expect(doc({ footerNote: 'REP-260820-000001' })).toContain('REP-260820-000001');
    expect(doc()).toContain('<div class="th-foot">');
    expect(doc({ hideFooter: true })).not.toContain('<div class="th-foot">');
  });

  it('accepts bespoke styling for designed artifacts without losing page setup', () => {
    const html = doc({ extraCss: '.seal { border: 2px solid black; }' });
    expect(html).toContain('.seal { border: 2px solid black; }');
    expect(html).toMatch(/@page\s*\{[^}]*size:\s*A4/);
  });
});

describe('escapeHtml', () => {
  it('neutralises every character that can break out of markup', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('renders null and undefined as empty rather than as the words', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PAPER IS THE SHELL'S DECISION, AND THERE IS MORE THAN ONE PAPER
// ══════════════════════════════════════════════════════════════════════════
/**
 * The last three bespoke documents — the salary slip, the registration receipt
 * and the student ID card — are now built through the authority, so the
 * design-system audit no longer carries a named exemption list.
 *
 * Two of them could not simply be dropped into the A4 report shell:
 *
 *   the registration receipt is issued on an 80mm till roll, and A4 report
 *     margins would paginate a short receipt onto a second sheet;
 *   the ID card is a card.
 *
 * Rather than let them keep their own `<style>` block, the shell learned the
 * papers by name. A caller chooses one; it cannot invent a page rule. That
 * keeps paper a property the authority owns while letting a designed artifact
 * still look like itself.
 *
 * The salary slip is the one that was actually broken. It printed by scraping
 * `innerHTML` out of the modal, which carried Tailwind class names into a
 * window with no Tailwind — every rule silently did nothing — and hard-coded
 * `direction: rtl` on a document whose labels read "Base Amount".
 */
describe('paper', () => {
  it('defaults to A4 with real margins', () => {
    const html = buildPrintDocument({ title: 'T', bodyHtml: '<p>x</p>' });
    expect(html).toContain('@page { size: A4; margin: 16mm 14mm 18mm 14mm; }');
  });

  it('a till-roll receipt gets a continuous 80mm page, not A4', () => {
    const html = buildPrintDocument({ title: 'T', bodyHtml: '<p>x</p>', paper: 'receipt80' });
    expect(html).toContain('@page { size: 80mm auto; margin: 6mm; }');
    expect(html).not.toContain('size: A4; margin: 16mm');
  });

  it('a card gets A4 with card margins', () => {
    const html = buildPrintDocument({ title: 'T', bodyHtml: '<p>x</p>', paper: 'card' });
    expect(html).toContain('@page { size: A4; margin: 12mm; }');
  });

  it('every document has exactly one @page rule', () => {
    for (const paper of ['a4', 'receipt80', 'card'] as const) {
      const html = buildPrintDocument({ title: 'T', bodyHtml: '<p>x</p>', paper });
      expect(html.match(/@page/g)).toHaveLength(1);
    }
  });
});

describe('the salary slip is built from data, not scraped from the screen', () => {
  const SLIP = {
    serialNo: 'PAY-TCH-12345',
    date: '2026-08-20',
    fullName: 'Ahmad Karimi',
    role: 'Teacher',
    month: '1405-05',
    baseSalary: 30000,
    paymentType: 'full',
    amount: 28000,
    monthLabel: 'اسد ۱۴۰۵',
    dateLabel: '۲۹ اسد ۱۴۰۵',
    baseSalaryLabel: '30,000 AFN',
    amountLabel: '28,000 AFN',
  };

  it('carries the payment figures', () => {
    const html = buildPrintDocument(buildPayslipDocument(SLIP));
    expect(html).toContain('Ahmad Karimi');
    expect(html).toContain('PAY-TCH-12345');
    expect(html).toContain('28,000 AFN');
    expect(html).toContain('اسد ۱۴۰۵');
  });

  it('does not pin RTL on an English slip', () => {
    const html = buildPrintDocument(buildPayslipDocument(SLIP));
    expect(html).toContain('dir="ltr"');
    expect(html).not.toContain('direction:rtl');
    expect(html).not.toContain('direction: rtl');
  });

  it('a Persian slip is RTL because its language says so', () => {
    const html = buildPrintDocument(buildPayslipDocument({ ...SLIP, lang: 'fa' }));
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="fa"');
  });

  it('carries no Tailwind utility classes into a window that has no Tailwind', () => {
    const html = buildPrintDocument(buildPayslipDocument(SLIP));
    for (const tailwindism of ['text-slate-500', 'font-black', 'rounded-xl', 'justify-between']) {
      expect(html).not.toContain(tailwindism);
    }
  });

  it('gets the signature block a financial receipt needs', () => {
    const html = buildPrintDocument(buildPayslipDocument(SLIP));
    expect(html).toContain('th-signatures');
    expect(html).toContain('Finance Manager');
    expect(html).toContain('Recipient signature');
  });

  it('escapes a name that contains markup', () => {
    const html = buildPrintDocument(
      buildPayslipDocument({ ...SLIP, fullName: '<script>alert(1)</script>' }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
