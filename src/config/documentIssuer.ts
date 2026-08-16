/**
 * Contact details printed on institutional documents.
 * ============================================================================
 * Receipts, invoices and bills must show the contact details of the branch
 * that issued them — never a literal typed into a template. The book-sale
 * receipt printed a hardcoded `0788223344` on every copy, from every branch,
 * which is wrong the moment a second branch exists and is wrong today for any
 * branch whose real number differs.
 *
 * `branding.ts` owns brand IDENTITY (name, slogan, logo) — the things that are
 * the same everywhere. This module owns per-branch CONTACT data, which is
 * operational configuration and therefore comes from the API, not from source.
 *
 * Policy when a branch has no value configured (stated once, here, rather than
 * re-decided per template): the line is OMITTED. There is deliberately no
 * organization-level fallback, because `Organization` carries no contact
 * fields today — inventing one here would mean inventing a schema. A missing
 * phone renders as an absent line, never a placeholder and never a literal:
 * printing a wrong number on a financial document is worse than printing none.
 */
import type { Branch } from '../types';

export interface DocumentIssuer {
  /** Branch display name, e.g. "Main Branch". */
  branchName: string | null;
  phone: string | null;
  address: string | null;
  email: string | null;
}

export function resolveDocumentIssuer(branch: Branch | null | undefined): DocumentIssuer {
  const clean = (value: unknown): string | null => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length > 0 ? text : null;
  };
  return {
    branchName: clean(branch?.name),
    phone: clean(branch?.phone),
    address: clean(branch?.address) ?? clean(branch?.location),
    email: clean(branch?.email),
  };
}
