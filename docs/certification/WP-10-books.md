# Certification — WP-10 Books

**Work Package:** WP-10 Books (`books`)

**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md` §§2–4, 12–18, 20–23,
28, 31–43, 49–54, 58–76, 84, 89–101

**Checkpoint baseline:** `1a08f13` (`checkpoint: refine WP-10 refund boundary`)

**Date:** 2026-08-23

**Status:** **READY WITH TRACKED RISK** — bounded WP-10 certification

> This certificate covers the Books catalog, inventory, Book commerce and
> student lending slice only. It does not certify Finance (WP-07), Payroll
> (WP-08), Reporting & Analytics (WP-11), Workflow & Automation (WP-12), Audit
> (WP-13), or the complete product / production release.

## Scope and decisions

Owner decision D-16 requires a genuine issuance/lending domain distinct from
book sales. The bounded reconstruction applies D-173 through D-176:

- a catalog sale is one immutable Book sale linked to one payment and one income
  fact; generic Student payment is never a second Book writer;
- available copies are derived from immutable stock receipts, non-returned sales
  and active loans — never a mutable `stock` mirror;
- lending is a same-branch Student custody workflow with an explicit due date;
  it creates no inferred fine, deposit, replacement charge or other money;
- a full sale return writes one immutable return fact and one signed cash contra
  fact atomically;
- Book authorization consumes named permissions, not role-name middleware;
- Book issue/return append the corresponding Student Journey event atomically;
  unsupported loss/replacement policy is not invented; and
- the current whole-copy mutation K2 is execution-proven equivalent, while the
  explicit guard remains as clear defence in depth.

A `purpose='books'` **invoice** remains a WP-07 document/payment fact. It may
not mutate physical Book inventory or lending history. A physical catalog sale
always carries its exact `book_sales` identity.

## Root cause and final architecture

The old surface was a sale-oriented mutable counter. `books.stock` was written
by catalog, sale, refund and Student-payment routes; a student Book payment and
a Book sale wrote different financial facts; no lending aggregate existed;
role-name routes bypassed canonical `Book.*` permissions; and the browser
recomputed inventory and commercial summaries from loaded lists.

The final graph is:

```text
Book catalog item
  -> immutable stock receipt(s)
  -> derived available copies
       - final sale quantities
       - active loan quantities

Book sale
  -> one completed payment
  -> one income transaction
  -> optional immutable full sale return
       -> one signed refund payment
       -> one signed contra income transaction

Student Book loan
  -> explicit issued / due dates
  -> one append-only journey.book_issued fact
  -> optional immutable return
       -> one append-only journey.book_returned fact
```

`book_inventory_positions` is the server-side availability read model. Source
facts are protected by foreign keys, unique constraints, date/branch/capacity
checks, exact linked-money triggers and immutable-history triggers. The Books
workspace paginates sales, loans and receipts (default 50, capped at 100) rather
than silently truncating history or fetching an unbounded ledger.

## Attack, repair and review evidence

The final authority suite directly attacks:

- malformed, zero, negative, fractional, nonnumeric and unsafe-price inputs;
- cross-branch Book, Student and command access;
- unavailable, archived and lending-disabled operations;
- duplicate catalog identity; explicit and concurrent idempotency replay;
- direct source rewrite/delete, bad date, oversell, mismatched payment/refund
  and duplicated income attacks;
- generic Student Book payment/refund attempts;
- source-aware full return and exact Book money reconciliation;
- Student Journey issuance/return chronology; and
- server-workspace, pagination, permission, Shamsi date and print contracts.

During attack, raw capacity-trigger errors initially surfaced as unclassified
server failures. The service now translates a genuine Book storage conflict to
an actionable 409 without weakening the database backstop. Direct-write review
also exposed the need to reject an already-existing unrelated payment/refund
link and a second income row for the same Book payment; the canonical triggers
now reject both.

The structurally separate cold review is executable in
`server/src/tests/work-packages/wp10/books.review.test.ts`. It confirms the
absence of the old stock mirror/modal/route residue, exact money links,
permission boundaries and supported Journey vocabulary.

## Verification

Commands below were executed against the final WP-10 source. The release gate
was re-executed after this certificate and the final registries were recorded.

| Gate | Result |
|---|---|
| WP-10 authority / attack / frontend / review | `npx vitest run src/tests/work-packages/wp10 --no-file-parallelism` — **4 files / 31 tests passed** |
| Full server suite | `cd server && npm test` — **183 files passed / 2765 tests passed / 14 files and 164 explicit skipped cases** |
| Canonical schema | `cd server && npm run preflight:fresh-schema` — **120 tables / 273 indexes / 197 triggers**, standalone, sound and idempotent |
| Server typecheck/lint/build | passed |
| Frontend typecheck/lint | passed; eight pre-existing warnings outside WP-10, zero errors |
| Mutation gate | `npm run audit:mutation` — **18 harnesses passed / 0 failed**; Book K1/K3/K4 killed and K2 execution-proven equivalent; no invalid Book anchor |
| Performance probe | 250 Book sale facts, 50-row workspace page: **1.74 ms** in this sandbox; `EXPLAIN QUERY PLAN` used `idx_book_sales_branch_date (branch_id=?)` |
| Registry/static/product/design/logging/dependency/cleanliness audits | passed; all re-run inside final release validation |
| Final release validation | `npm run release:validate` — **22 passed / 0 failed / 0 skipped** |

## Certification matrix

| Dimension | Status | Evidence class | Evidence | Remaining risk |
|---|---|---|---|---|
| Architecture | READY (bounded) | PROVEN | one Books service, one derived availability read model, no legacy modal/counter | broader Workflow/Event redesign remains WP-12 |
| Domain correctness | READY | PROVEN | authority + attack suite | no loss/replacement policy is intentionally outside validated requirement |
| Database / data integrity | READY | PROVEN | fresh schema, FK/trigger/direct-write attacks | none found in bounded slice |
| Finance | READY (Book boundary) | PROVEN | exact payment/income/contra links, reconciliation consumers | does not recertify WP-07 generally |
| RBAC / security | READY | PROVEN | permission routes and cross-role/branch attacks | none found in bounded slice |
| API / reliability / concurrency | READY | PROVEN | canonical error mapping, idempotency and capacity tests | none found in bounded slice |
| Frontend / state freshness | READY | PROVEN | server workspace, page controls, mutation reload and Student Journey freshness contract | visual browser-assistive review is supported by source/design-system evidence, not an external audit |
| Reporting / printing | READY (Book consumers) | PROVEN + SUPPORTED | final-sale report queries; shared receipt print authority contract | does not certify reporting engine redesign |
| Performance | READY (measured slice) | PROVEN | bounded pagination, indexed plan and 250-fact probe | not a whole-product load certification |
| Testing / maintainability / cleanliness | READY | PROVEN | package suite, full suite, mutation, cleanup scan | none found in bounded slice |
| Independent review | TRACKED RISK | SUPPORTED | executable cold review completed by the implementing agent | **TR-4:** same-agent cold review is not an external independent review |

## Final bounded verdict

**WP-10 Books is READY WITH TRACKED RISK.** No unresolved Critical or High
Books-domain defect is known from the final authority, attack, schema, full-suite
and mutation evidence. The only tracked certification risk is TR-4 review
independence. This is not a claim that the whole TOEFL House product is ready.
