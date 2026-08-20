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
