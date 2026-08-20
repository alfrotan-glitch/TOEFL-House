/**
 * THE print document authority.
 * ============================================================================
 * Printing is first-class where the business depends on it, and this business
 * prints constantly — reports, receipts, fee bills, certificates. What existed
 * was six components each calling `window.open` and writing their own
 * `<style>` block, which produced documents that were subtly different from
 * one another and shared none of the properties that make paper usable:
 *
 *   · no `@page`, so paper size and print margins were whatever the browser
 *     chose, and the on-screen `margin:40px` was doing the job badly;
 *   · `text-align:left` hard-coded, so a Persian/Dari document would print
 *     left-aligned;
 *   · no repeated table headers, so page two of a long table had no headings;
 *   · no page numbers, so a dropped page was undetectable;
 *   · no break control, so totals rows were split from their tables.
 *
 * One document shell fixes all of them at once, and every generator gets the
 * same paper. The design-system audit forbids opening a print window anywhere
 * else.
 */
import { directionOf, type AppLanguage, type TextDirection } from './direction-context';

/** Escapes text destined for a print document. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The shared print stylesheet.
 *
 * Written with LOGICAL alignment (`start`/`end`) so a right-to-left document
 * mirrors without a second stylesheet, exactly as the screen does.
 */
const PRINT_STYLESHEET = `
  /* Paper is a fixed size with real margins; the browser default is not a
     design decision. The footer sits inside the bottom margin. */
  @page {
    size: A4;
    margin: 16mm 14mm 18mm 14mm;
  }

  * { box-sizing: border-box; }

  body {
    font-family: Inter, "Vazirmatn", Arial, sans-serif;
    color: #0f172a;
    font-size: 11.5px;
    line-height: 1.5;
    margin: 0;
  }

  /* Ink economy: a report is read, not admired. Backgrounds are kept only
     where they carry meaning (totals rows), and printed light. */
  .th-title { font-size: 15px; font-weight: 800; margin: 0 0 2px; }
  .th-meta { font-size: 10.5px; color: #475569; margin-bottom: 14px; line-height: 1.6; }
  h2 {
    font-size: 12.5px; font-weight: 800; margin: 18px 0 6px;
    border-bottom: 1.5px solid #cbd5e1; padding-bottom: 3px;
    /* A heading alone at the foot of a page is a wasted line. */
    break-after: avoid; page-break-after: avoid;
  }

  table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
  caption { text-align: start; font-weight: 700; padding-bottom: 4px; }

  /* Repeat headings on every page. Without this, page two of a long table is
     a wall of unlabelled numbers. */
  thead { display: table-header-group; }
  tfoot { display: table-footer-group; }

  th, td {
    padding: 4px 7px;
    border-bottom: 1px solid #e2e8f0;
    text-align: start;          /* mirrors in RTL */
    vertical-align: top;
  }
  th { font-weight: 700; color: #334155; border-bottom-width: 1.5px; }

  /* Numbers align to the end of the line in both directions and use tabular
     figures so columns line up. */
  .num { text-align: end; font-variant-numeric: tabular-nums; white-space: nowrap; }

  /* Keep a row, and a totals line, intact across a page break. */
  tr, .th-keep { break-inside: avoid; page-break-inside: avoid; }
  .total { font-weight: 800; background: #f1f5f9; }

  .th-grid { display: flex; gap: 20px; flex-wrap: wrap; }
  .th-grid > div { flex: 1; min-width: 170px; }
  .kpi { font-size: 13px; font-weight: 800; }
  .muted { color: #64748b; }

  /* Signature blocks belong at the end of an operational document, and must
     not be orphaned onto a page of their own. */
  .th-signatures { display: flex; gap: 28px; margin-top: 26px; break-inside: avoid; }
  .th-signatures > div { flex: 1; }
  .th-sign-line { margin-top: 30px; border-top: 1px solid #94a3b8; padding-top: 3px; font-size: 10px; color: #475569; }

  /* Running footer with page numbers, so a missing page is visible. */
  .th-foot {
    position: fixed; bottom: -12mm; inset-inline: 0;
    font-size: 9px; color: #64748b;
    display: flex; justify-content: space-between;
  }
  .th-foot .page::after { counter-increment: page; content: "Page " counter(page); }

  @media screen {
    body { margin: 24px; }
    .th-foot { position: static; margin-top: 24px; }
  }
`;

export interface SignatureBlock {
  /** e.g. "Prepared by", "Approved by". */
  role: string;
  /** Printed under the line when known. */
  name?: string;
}

export interface PrintDocumentOptions {
  /** Window and document title; also what most browsers use as the filename. */
  title: string;
  /** Language of the document's own content. */
  lang?: AppLanguage;
  /** Overrides the direction implied by `lang` (rarely needed). */
  dir?: TextDirection;
  /** The document body, already escaped by the caller. */
  bodyHtml: string;
  /** Left-hand footer text — typically the report id or document reference. */
  footerNote?: string;
  /** Signature lines appended before the footer. */
  signatures?: SignatureBlock[];
  /**
   * Additional CSS for documents with their own visual design.
   *
   * A certificate or a fee bill is a designed artifact, not a report, and
   * forcing it into the report stylesheet would be wrong. It still gets the
   * shared page setup — paper size, margins, page numbering, direction —
   * because those are properties of PAPER, not of a particular document.
   */
  extraCss?: string;
  /** Suppresses the running footer for single-sheet artifacts. */
  hideFooter?: boolean;
}

/**
 * Builds the complete print document.
 *
 * Exported separately from `openPrintDocument` so the markup can be asserted
 * in a test. A document that can only be inspected by eye, in a popup, is a
 * document nobody checks.
 */
export function buildPrintDocument(options: PrintDocumentOptions): string {
  const lang = options.lang ?? 'en';
  const dir = options.dir ?? directionOf(lang);

  const signatures = options.signatures?.length
    ? `<div class="th-signatures">${options.signatures
        .map(
          (s) =>
            `<div><div class="th-sign-line">${escapeHtml(s.role)}${
              s.name ? ` — ${escapeHtml(s.name)}` : ''
            }</div></div>`,
        )
        .join('')}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}" dir="${escapeHtml(dir)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(options.title)}</title>
<style>${PRINT_STYLESHEET}</style>
${options.extraCss ? `<style>${options.extraCss}</style>` : ''}
</head>
<body>
${options.bodyHtml}
${signatures}
${options.hideFooter ? '' : `<div class="th-foot">
  <span>${escapeHtml(options.footerNote ?? '')}</span>
  <span class="page"></span>
</div>`}
</body>
</html>`;
}

/**
 * Opens the document in a print window and triggers the dialog.
 *
 * Returns false when the popup was blocked, so a caller can tell the operator
 * instead of appearing to do nothing — a print button that silently fails is
 * indistinguishable from a broken one.
 */
export function openPrintDocument(options: PrintDocumentOptions): boolean {
  const w = window.open('', '_blank', 'width=1000,height=750');
  if (!w) return false;
  w.document.write(buildPrintDocument(options));
  w.document.close();
  w.focus();
  w.print();
  return true;
}
