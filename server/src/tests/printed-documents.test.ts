/**
 * Printed financial documents carry authoritative branding and branch contact
 * ============================================================================
 * Two defects, both found by reading the documents these templates actually
 * emit rather than the React tree around them:
 *
 *   ISSUE 2  The student registration receipt (the fee bill printed when a
 *            visitor is converted) rendered `<h1>TOEFL HOUSE</h1>` as a
 *            literal, with no logo and no branch contact whatsoever. It did
 *            not look like an institutional financial document, and it drifted
 *            from BRAND_NAME ("The TOEFL House").
 *
 *   ISSUE 3  The book-sale receipt printed a hardcoded `0788223344` on every
 *            copy from every branch.
 *
 * These assert the source of truth is used, because a document is only correct
 * if it reads its identity from branding.ts and its contact details from the
 * branch record. Rendering is covered by the shape of the emitted HTML.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

describe('printed documents use authoritative branding', () => {
  it('the student fee bill prints the official logo, name and slogan', () => {
    const src = read('src/components/visitors/ConvertToStudentModal.tsx');

    // It must delegate to the shared print header, which is the only place the
    // logo/name/slogan are assembled.
    expect(src).toContain('brandPrintHeaderHtml');
    // The regression: a hand-typed institute name in the receipt header.
    expect(src).not.toMatch(/<h1>\s*TOEFL HOUSE\s*<\/h1>/i);
  });

  it('the shared print header emits the logo, brand name and exact slogan', () => {
    const src = read('src/config/branding.ts');
    const header = src.slice(src.indexOf('export function brandPrintHeaderHtml'));

    expect(header).toContain('brandLogoAbsoluteUrl()');
    expect(header).toContain('${BRAND_NAME}');
    expect(header).toContain('${BRAND_SLOGAN}');
    // Contact lines are rendered from the issuer, never from literals.
    expect(header).toContain('issuer?.phone');
  });

  it('the student fee bill resolves branch contact from the branch record', () => {
    const src = read('src/components/visitors/ConvertToStudentModal.tsx');
    expect(src).toContain('resolveDocumentIssuer');
    // Resolved from the branch actually being enrolled into, not a global.
    expect(src).toMatch(/resolveDocumentIssuer\(branches\.find/);
  });

  it('the book receipt resolves branch contact instead of a literal number', () => {
    const src = read('src/components/books/BooksModals.tsx');
    expect(src).toContain('issuer.phone');
    expect(src).not.toContain('0788223344');
  });

  it('a branch with no configured phone omits the line rather than inventing one', () => {
    const src = read('src/config/documentIssuer.ts');
    // Nothing may be substituted for a missing value: the resolver returns
    // null and every consumer renders the line conditionally.
    expect(src).toContain('null');
    expect(src).not.toMatch(/\|\|\s*['"]0\d{9}['"]/);

    const books = read('src/components/books/BooksModals.tsx');
    expect(books).toMatch(/\{issuer\.phone\s*&&/);
    const header = read('src/config/branding.ts');
    expect(header).toContain(".filter((line): line is string =>");
  });
});
