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
    // The document builder was extracted from the modal into a pure module so
    // its output can be parsed as a DOM (see fee-bill-render.test.ts). This
    // guards the source of truth: the template must delegate to the shared
    // print header rather than assembling its own.
    const template = read('src/utils/feeBillTemplate.ts');
    expect(template).toContain('brandPrintHeaderHtml');
    expect(template).toContain('BRAND_NAME');
    expect(template).toContain('BRAND_SLOGAN');
    // The regression: a hand-typed institute name in the receipt header.
    expect(template).not.toMatch(/<h1>\s*TOEFL HOUSE\s*<\/h1>/i);

    // The receipt is built through the print authority, so the template names
    // the paper it needs rather than writing its own @page rule.
    expect(template).toContain("paper: 'receipt80'");
    expect(template).not.toContain('@page');
    expect(template).not.toContain('<!DOCTYPE html>');

    // The printable entrypoint lives in the extracted utility now, not in the
    // visitor modal. It must still open through the shared print authority and
    // never reintroduce inline window/document assembly.
    expect(template).toContain('export function printFeeBill');
    expect(template).toContain('openPrintDocument(buildFeeBillDocument');
    expect(template).not.toContain('<!DOCTYPE html>');
    expect(template).not.toContain('window.open(');
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

  it('the student fee bill consumes branch contact through the shared issuer contract', () => {
    const src = read('src/utils/feeBillTemplate.ts');
    expect(src).toContain('import type { DocumentIssuer }');
    expect(src).toContain('issuer: DocumentIssuer');
    // The header receives the caller-resolved issuer, so contact comes from the
    // branch record rather than literals embedded in the receipt template.
    expect(src).toContain("brandPrintHeaderHtml('Registration Receipt', issuer)");
    expect(src).not.toContain('0788223344');
  });

  it('the Book sale receipt resolves branch contact instead of a literal number', () => {
    const src = read('src/components/books/BooksView.tsx');
    expect(src).toContain('issuer.phone');
    expect(src).toContain('openPrintDocument');
    expect(src).not.toContain('0788223344');
  });

  it('a branch with no configured phone omits the line rather than inventing one', () => {
    const src = read('src/config/documentIssuer.ts');
    // Nothing may be substituted for a missing value: the resolver returns
    // null and every consumer renders the line conditionally.
    expect(src).toContain('null');
    expect(src).not.toMatch(/\|\|\s*['"]0\d{9}['"]/);

    const books = read('src/components/books/BooksView.tsx');
    expect(books).toContain('issuer.phone');
    expect(books).toContain('.filter((value): value is string => Boolean(value))');
    const header = read('src/config/branding.ts');
    expect(header).toContain(".filter((line): line is string =>");
  });
});
