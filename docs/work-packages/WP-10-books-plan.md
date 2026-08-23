# WP-10 Books — Reconstruction Plan

**Work Package:** WP-10 Books (`books`)

**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md` §§2, 3, 12–18, 20–23,
28, 33–43, 49–54, 58–76, 84, 90–96 and 98–101

**Owner scope authorization:** The Owner's current instruction authorizes autonomous
completion of the remaining incomplete / blocked / uncertified work, subject to the
Protocol stop conditions. D-16 already requires a complete issuance/lending domain
separate from book sales.

**Risk class:** Critical — canonical schema replacement, inventory integrity, cash
receipt/refund links, RBAC, destructive removal of the obsolete Books UI and legacy
book-test authority.

**Recovery baseline:** `82786c07b685218e0b782fd786f51237783db981`
(`certify: complete WP-09 funding impact`), clean working tree verified before this
plan was written.

---

## SCOPE

### Included

- The complete Books vertical slice: catalog, immutable inventory receipts, stock
  availability, sales, full sale returns/refunds, student lending/issuance, returns,
  overdue visibility, server API, RBAC, audit records, frontend state and UI.
- Replacement of the duplicate book-payment writer in `students.routes.ts` and its
  student-payment UI entry point. This is a necessary boundary repair: Book commerce
  must have one financial/inventory writer.
- The dependent report/catalog consumers only where their current Book source would
  otherwise become false after the Books reconstruction.
- Books-specific canonical-authority, invariant, metric, decision and conflict-register
  updates; new package-local test authority; deletion of superseded Books artifacts
  after the deletion protocol.

### Excluded

- General Finance, invoice, payment, reporting-engine, workflow/automation, audit and
  design-system redesigns owned by WP-07 / WP-11 / WP-12 / WP-13.
- A lending fine, deposit, replacement-charge, collection, or procurement-accounting
  policy. No owner requirement establishes any of those monetary rules, so this package
  must not invent money.
- Staff, visitor, or anonymous borrowing. The actual pre-existing book workflow links
  books to `students`, and the visitor journey's `book_issued` stage is part of the
  eventual student path. The bounded borrower is therefore a same-branch student.
  Extending borrower classes requires a new evidence-backed scope.
- Partial sale returns. The existing operational behavior is a full sale refund with
  the same physical quantity returned; no contrary partial-return requirement exists.

### Affected authorities and contracts

| Area | Current contract / authority | Required result |
|---|---|---|
| Catalog/inventory | `books.stock` plus mutable restock history | catalog facts plus immutable receipt/commerce/lending facts; availability derived server-side |
| Sales money | `book_sales` and separate `payments` writers | one Book command creates exactly one linked payment and ledger income fact |
| Student book payment | `POST /api/students/:id/payments` with `category='book'` | removed as a second Book writer; student purchases use the Books sale command |
| Lending | none | explicit student loan and return facts, due date, branch correlation and derived overdue state |
| Authorization | role-name gates despite `Book.*` permissions | `requirePermission` at every Books boundary |
| UI truth | `BooksView` browser reducers for stock, revenue, profit and payment mix | server workspace/read model is the only displayed inventory/commerce truth |
| Reporting | `book_sales` queries | consume the final Book sale authority; no browser/report recomputation of a second fact |

---

## DISCOVER — read-only evidence

The repository-freeze and forensic work found the following actual state.

| Finding | Evidence |
|---|---|
| D-16 requires issuance/lending as a concern distinct from sales, but no loan table, route, service, frontend state or UI exists. | `docs/registries/decisions.md` D-16; `server/src/db/schema.sql` Library block; `server/src/routes/books.routes.ts`; `src/components/books/` |
| `books.stock` is a mutable stored balance. `POST /api/books`, direct catalog update, `/sell`, student payment and refund all write it from different routes. | `books.routes.ts`; `students.routes.ts` book-payment path; `schema.sql` `books`/`book_sales` block |
| A student may pay for a book through `/students/:id/payments`, while `/books/:id/sell` also creates book income and stock movement. Cross-route checks attempt to block duplicates, but the two write different canonical facts: one `payments` row and one `book_sales` row. Reports count only `book_sales`; thus an accepted student book payment is not an authoritative Book sale/report fact. | `students.routes.ts` lines 1171–1289; `books.routes.ts` lines 171–305; `reports.routes.ts` Book-sales metrics |
| Book routes use `authorize('receptionist', ...)` role lists although the canonical RBAC catalog declares `Book.View`, `Book.Create`, `Book.Edit` and `Book.Sell`. | `books.routes.ts`; `server/src/core/rbac/permission-catalog.ts` |
| The Books UI derives stock value, revenue, profit, payment-method shares and best seller in the browser from loaded lists. That is a second business/reporting authority and is incomplete for paginated or cross-surface data. | `src/components/books/BooksView.tsx` |
| The Library schema has redundant null-unsafe `<>` branch guards and null-safe `IS NOT` guards for `book_sales`; C-18 explicitly assigns the duplicate cleanup to WP-10. | `server/src/db/schema.sql` Library block; `docs/registries/protocol-conflicts.md` C-18 |
| Existing Book tests are still top-level legacy authority rather than a WP-10 package suite. | `docs/legacy-test-inventory.md` WP-10; `server/src/tests/book-*.test.ts`, `books-branch.test.ts` |
| The clean baseline is executable but does not establish WP-10 correctness. | 2026-08-23 `cd server && npm test`: 182 files passed / 2773 tests passed / 14 files and 164 explicit skips |

### Root cause

The original Books surface is a sale-oriented stock counter, not the D-16 lending
aggregate. It accumulates inventory, commerce, finance and UI-reporting decisions in
routes/components rather than one Book domain boundary. The duplicate student-payment
path and browser metrics are consequences of that missing aggregate: neither represents
an exact, source-linked Book commerce lifecycle.

---

## MODEL

### Entities and authoritative facts

```text
Book catalog item
  -> immutable stock receipt(s)
  -> derived available quantity
       - posted sales not returned
       - active student loans not returned

Posted book sale
  -> one linked completed payment
  -> one linked income transaction
  -> optional same-branch student purchaser
  -> at most one immutable full sale-return/refund fact
       -> one linked contra payment
       -> one linked negative income transaction

Book loan/issuance
  -> one same-branch student + one catalog item + one issued copy quantity
  -> explicit issued-on and due-on dates
  -> at most one immutable return fact
  -> current / overdue is derived from absence of a return and canonical server date
```

The physical quantity is fungible at title level. A loan always reserves one available
copy; it is not a sale, it has no cash effect, and it never silently becomes one. The
availability formula is a server/domain read model from immutable receipts, active sales
and active loans. It is not a browser reducer or a mutable `stock` mirror.

### States and transitions

| Aggregate | Valid transitions | Forbidden transition |
|---|---|---|
| Catalog item | active → archived; active metadata/pricing update | delete historical catalog/inventory/commercial facts; new stock/sale/loan for archived item |
| Receipt | create | update/delete |
| Sale | post → optional full return/refund fact | edit/delete/second refund/return without a matching cash contra fact |
| Loan | issue → optional return fact | edit/delete/second return/issue when unavailable or lending disabled |

### Non-invented lending policy

- The operator supplies an explicit valid due date. No arbitrary default loan period or
  renewal count is invented.
- Overdue is a derived visibility state, not an automatic fee, state mutation or
  collection action.
- No fine, deposit, replacement charge, procurement expense or inventory valuation is
  created because no owner decision establishes its amount, authorization or accounting
  treatment.
- A sale refund is full-quantity only and requires a non-empty reason; it creates the
  matching returned inventory quantity and signed cash contra fact atomically.

---

## CHALLENGE

| Candidate | Verdict | Reason |
|---|---|---|
| Add a `loaned` Boolean to the old `books` table | REJECT | cannot identify borrower, due date, return history, branch integrity or concurrent availability |
| Keep `books.stock` and add loans around it | REJECT | leaves a mutable inventory mirror written by unrelated routes; no source-exact stock authority |
| Retain student smart-payment book handling alongside sale endpoint | REJECT | two Book writers and two incompatible business facts; reports cannot reconcile both safely |
| Treat a loan as a zero-price sale | REJECT | conflates property custody with cash receipt and corrupts sales/reporting/financial semantics |
| Infer lending terms, fines, deposits or lost-book charges | REJECT | no business decision defines the policy; would invent financial truth |
| Use role-name gates | REJECT | conflicts with canonical RBAC authority and D-168's project-wide permission-based standard |
| Keep old `BooksView` reducers as presentation “summaries” | REJECT | they calculate business/reporting facts from incomplete client data |

---

## DECIDE

### D-173 — WP-10 canonical Book facts (agent architectural decision under D-16)

1. A Book sale is a Book-domain fact linked one-to-one to its payment and income ledger
   fact; the Student payment endpoint is not a Book commerce writer.
2. Inventory availability is derived from immutable Book receipts, active sales and
   active loans. No mutable stock field is authoritative.
3. Lending is student-only within this bounded evidence, requires an explicit due date,
   and records issuance/return facts without monetary side effects.
4. Catalog records are archived, never deleted after they have historical dependents.
5. All Books commands consume RBAC permissions rather than role names.

This decision does **not** decide a lending fine/deposit/replacement policy. Any future
policy that moves money must return to Owner decision under §105 and §20–21.

### Exact implementation plan

| Layer | Planned change |
|---|---|
| Schema | Replace the old Books block with catalog, receipt, sale, sale-return, loan and loan-return facts; add deferred Book sale/payment relations; remove mutable stock/restock mirror and duplicate sale guards; add foreign keys, branch/capacity/immutability/status triggers and supporting indexes. Replace `payments.book_id` only after every consumer is re-homed to the Book sale relation. |
| Domain | Add `server/src/core/books/books-service.ts` for validation, authoritative workspace queries, catalog/receipt commands, sale/refund money lifecycle and loan/return commands inside explicit transactions. |
| API | Rebuild `server/src/routes/books.routes.ts` around permission checks and the service. Expose a server-rendered workspace plus focused commands; remove the obsolete stock-write and role-name routes. |
| RBAC | Add Book restock/issue/return/refund permissions and assign default scopes consistent with the currently executable Books route behavior; server routes use `requirePermission`. |
| Student boundary | Remove the generic `category='book'` payment path, its book lookup/stock mutation and the Student UI book-payment affordance. Preserve generic finance behavior for non-Book categories. |
| Frontend | Replace legacy Books components and state with a typed workspace consumer. It renders server totals and supports catalog, stock receipt, sale, sale-return, loan and return workflows; it has intentional loading/empty/error/permission states and never calculates inventory/financial truth locally. |
| Consumers | Adapt report/catalog and dependent tests only to consume the final sale relation; do not redesign WP-11 reporting architecture. |
| Tests | Re-home/rebuild Book tests under `server/src/tests/work-packages/wp10/`; add API, direct-schema, RBAC, cross-writer, finance/reconciliation, idempotency/concurrency, lending lifecycle, UI-contract and cold-review attack suites. |
| Documentation | Update authorities/invariants/metrics/decisions/conflicts/legacy inventory and produce a bounded certification only after all gates pass. |

### Acceptance criteria

1. A valid operator can create/receive a catalog item, sell it, and see exactly one
   Book sale, completed payment, income transaction and stock decrease.
2. No direct or generic Student payment can create Book sale/inventory truth.
3. A full sale return/refund is atomic, exactly once, restores availability and writes a
   linked signed contra payment/income fact; insufficient cash leaves no residue.
4. A valid operator can issue one available lending-enabled book to a same-branch
   student with an explicit due date, return it once, and see derived availability and
   overdue status update without a browser refresh.
5. Cross-branch, archived, disabled-lending, unavailable, malformed-date, double-submit,
   direct SQL mutation and unauthorized command attacks fail without residue.
6. A report/API/UI Book metric agrees with the same canonical facts; the browser has no
   independent Book financial or inventory reducer.
7. A fresh canonical database creates all constraints, converges idempotently and passes
   the full product verification gates.

---

## CHECKPOINT

Schema, finance, RBAC and deletion changes require §65. The recoverable Git baseline
above is preserved. The Owner's current autonomous-completion instruction authorizes the
bounded WP-10 checkpoint; the implementation must stop and re-scope if it reveals a
business-policy ambiguity that affects money, security, RBAC, data integrity or a core
workflow.

No implementation is included in this plan.
