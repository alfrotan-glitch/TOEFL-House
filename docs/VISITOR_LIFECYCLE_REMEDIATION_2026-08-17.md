# Visitor Lifecycle — Architectural Remediation Record

**Date:** 2026-08-17 · **Base:** `5bd5885` · **Head:** `d694d44`
**Scope:** the second-pass audit findings (UX-6…UX-14, N-1…N-7), re-derived from source and live behaviour rather than accepted as given.

---

## 1. What the audit got right, wrong, and missed

The prior audit was a symptom list. Independent verification found that several
of its findings were surface expressions of **one** underlying architectural
fault, and that two of its proposed fixes would have been actively harmful.

| Audit item | Independent verdict |
|---|---|
| UX-6 Advance has no feedback | **Confirmed** — fixed |
| UX-7 source vocabulary | **Already fixed**; no test locked it, still true (accepted risk, see §6) |
| UX-8 lost leads in pipeline | **Confirmed but mis-scoped** — a symptom of the root cause in §2 |
| UX-9 no duplicate warning | **Confirmed**; the *implied* fix (unique phone) **rejected** — see §4 |
| UX-10 placement invisible | **Confirmed** — fixed (UI only; the server filter already existed) |
| UX-11 responsive kanban | **Confirmed, deferred** — see §6 |
| UX-12 terminology | **Partly fixed** as a by-product; full rename deferred — §6 |
| UX-13 loading states | **Mostly already fixed**; kanban gap closed |
| UX-14 required-field mismatch | **Confirmed, and worse** — the server's own message named a field it did not check |
| N-1 kanban counts from page | **Confirmed, Critical** — fixed |
| N-2 counselor cannot see blocker | **Confirmed** — fixed at *two* layers, not one |
| N-3 `Lead.Assign` has no UI | **Rejected as a defect** — missing feature, not a fault; §5 |
| N-5 double-fetch | **Confirmed, deferred** — §6 |
| N-6 4s toast | **Confirmed, deferred** — §6 |
| N-7 accessibility | **Confirmed** — deferred as a discrete workstream, §6 |
| *(missed)* `/visitors/pipeline` reports 0% conversion | **New, and the worst metric defect found** — §3 |
| *(missed)* five contradictory definitions of "converted" | **New root cause** — §2 |

---

## 2. Root cause: one question, five answers

The audit reported UX-8 as "lost leads inflate the pipeline". That was true but
too small. Tracing every reader of `visitors.status` found the same question —
*is this lead still open?* — answered five different ways:

```
visitor-query.ts    open = status<>'registered' AND stage<>'lost'
dashboard-summary   pending = status IN ('visited','follow_up')   <- includes lost
bos.routes.ts       registrations = status='registered'
reports.routes.ts   registrations = status='registered'
/visitors/pipeline  registrations = COUNT(stage='registration')   <- a DIFFERENT COLUMN
```

Live, on identical data, `/visitors/summary` reported **225** open leads while
`/dashboard/summary` reported **226**. Two screens, one question, two answers —
and the divergence was introduced by the *previous* remediation, which correctly
fixed one module and left the concept unshared.

### The domain rule, established from evidence

Before writing any code I verified how the two columns actually behave:

- **Conversion** is the only production writer of `status='registered'`
  (`visitors.routes.ts:71`, used once). It atomically sets `stage='enrollment'`
  *and* inserts a `students` row. Verified end-to-end with a real conversion.
- **`advance-stage` never writes `status`.** Verified by walking a lead through
  all ten transitions: it reached `stage='enrollment'` with `status='visited'`
  and **zero student records**.

So `stage` is *workflow position* and `status` is *commercial outcome*. They are
independent axes.

> **This is why the tempting refactor — "derive `status` from `stage`" — is
> wrong.** It would have converted 27 leads that were merely advanced,
> inventing revenue that no student record or payment backs. A regression test
> now pins this exact case, and a mutation implementing that refactor is killed.

`core/visitors/lead-lifecycle.ts` is now the single authority:

```
CONVERTED := status = 'registered'                        (backed by a student row)
CLOSED    := not converted AND COALESCE(stage,'lead') = 'lost'
OPEN      := the complement
```

Two deliberate design choices:

- **`OPEN` is the complement, not an allow-list.** The Dashboard's old
  `status IN ('visited','follow_up')` silently dropped any row whose status was
  neither — a latent undercount the moment a new status value appears.
- **`CLOSED` excludes converted rows.** A won deal cannot be un-won by a stage
  annotation, and without that guard a converted-then-lost lead would be counted
  twice, breaking `converted + closed + open = total`.

Consumers rewired: `visitor-query`, `dashboard-summary` (+`closedLeads`, so the
buckets are exhaustive), `bos.routes`, `reports.routes`, `/visitors/pipeline`,
and the frontend via `src/config/leadLifecycle.ts`.

---

## 3. The defect the audit missed entirely

`/visitors/pipeline` computed:

```
totalLeads         = COUNT(stage='lead')          -- leads STILL SITTING in 'lead'
totalRegistrations = COUNT(stage='registration')  -- a transient stage
```

Conversion writes `stage='enrollment'` and **never passes through
`registration`**. So with 27 real conversions in the database the endpoint
reported **0 registrations and a 0% conversion rate**. Worse, the denominator
*shrank* as leads progressed out of `lead`, so the metric moved the wrong way as
the business improved.

Four tests covered this endpoint and all four passed, because one of them
**asserted the defect as correct**: it seeded `stage='registration'` and expected
`totalRegistrations === 1`. That test has been rewritten, not deleted — it now
seeds a genuinely converted lead and a lead merely parked in `registration`, and
asserts only the former counts.

The endpoint has no frontend consumer today, but it is a published API and its
numbers were wrong; it now agrees with every other surface.

---

## 4. A proposed fix I rejected

The audit's UX-9 finding was correct: posting an identical name and phone
created a duplicate lead (proved live). The implied remedy — make phone unique —
would be **wrong for this domain**.

In Kabul a single household or office line is routinely shared by siblings and
by a parent registering several children. The live database already contains
legitimately shared numbers. A unique constraint would refuse real enrolments at
the front desk, which is a worse failure than a duplicate row, and staff would
work around it by entering fake numbers — destroying the contact data entirely.

**Chosen instead:** identity stays enforced where identity is genuinely known
(the existing Tazkira unique index from migration 072), and a new *advisory*
lookup answers the softer question "have we probably seen this person before?".
It can only return information, never refuse a write. The operator — the person
actually looking at the human being — decides.

Engineering details that make it work rather than merely exist:
- Phone matched on a **digits-only 9-digit suffix**, so `0700 123 456`,
  `0700-123-456` and `+93700123456` all match. A single space would otherwise
  defeat the check.
- A **minimum fragment length**, because the suffix match is `LIKE '%key'` and a
  3-digit fragment would match every number ending in those digits, flooding the
  operator with false positives and training them to ignore the warning.
- Name is consulted **only when nothing stronger matched**, so a common name
  cannot bury a real Tazkira or phone hit.
- Branch-scoped, so it cannot enumerate another branch's leads.

---

## 5. Findings deliberately rejected

**N-3 — `Lead.Assign` has no UI.** Accurate observation, wrong classification.
`assigned_to` is stored, validated and returned by the API; there is simply no
assignment screen. That is an unbuilt feature, not a defect, and building lead
ownership UI is outside a correctness remediation. Recorded for the backlog.

**"Derive `status` from `stage`."** Rejected with evidence — see §2.

**"Make phone unique."** Rejected with domain reasoning — see §4.

---

## 6. Knowingly left open

| Item | Why deferred |
|---|---|
| **N-7 accessibility** (0 `aria`/`htmlFor`/`role`/key handlers across 5 components) | Real and likely a procurement blocker under WCAG 2.1 AA, but it is a discrete workstream touching every component, and mixing it into a correctness change would make both unreviewable. Highest-value next task. |
| **UX-11 responsive kanban** (`min-w-[1200px]`, default view) | Genuine; the list view is a working escape hatch. Needs design input on small-screen behaviour, and I will not guess at that from source. |
| **UX-12 full terminology rename** | Enroll/Convert/Register still coexist. Row labels are now consistent; a full rename touches printed documents and audit strings and deserves its own pass. |
| **UX-14 phone-mandatory contract** | The client requires phone, the server does not. This is a **business policy decision**, not a defect to paper over — relaxing the form would weaken a real front-desk control. Needs a ruling, then one-line enforcement. |
| **N-5 double-fetch**, **N-6 4s toast** | Low harm, cosmetic. |
| **UX-7 enum-parity test** | Source lists are correct today but nothing pins UI list == server enum. |

---

## 7. Verification

**Tests:** 1210 pass (was 1173 at the start of this work), 109 files. 37 added.
No test was weakened, skipped, or removed; one false-confidence test was
**rewritten** and one test helper fixed (it hardcoded `status='visited'` and
silently ignored overrides, making a converted lead inexpressible in a fixture).

**Mutation testing — 13 mutants, 12 killed, 1 proven equivalent.**

| Mutant | Result |
|---|---|
| Dashboard reverts to the `status IN (…)` allow-list | killed |
| NULL-unsafe open predicate (`stage <> 'lost'`) | killed |
| Converted rows double-count as closed | killed |
| **Derive converted from `stage`** (the forbidden refactor) | killed |
| `/pipeline` reverts to `stage='registration'` | killed |
| JS helper drops `?? 'lead'` | **equivalent** — `(x ?? 'lead') === 'lost'` and `x === 'lost'` agree for all inputs since `'lead' !== 'lost'`; kept for symmetry with SQL |
| `POST /convert` drops to `Lead.View` | killed |
| Eligibility preview ungated | killed |
| Preview loses branch isolation | killed |
| Duplicate lookup ignores branch scope | killed |
| Phone normalisation removed | killed |
| Duplicate lookup gated `Lead.View` not `Lead.Create` | **initially survived** → killed |
| Short-fragment guard removed | **initially survived** → killed |

The two initial survivors are recorded because they are exactly what mutation
testing exists to expose. The permission mutant survived because *every*
built-in lead-facing role holds both `Lead.View` and `Lead.Create`, so no
existing role could distinguish them; a purpose-built View-only role now pins
the boundary. The fragment mutant survived because no fixture had a number
*ending* in the probe digits.

**Gates:** server lint 0 errors (104 pre-existing warnings) · frontend lint
0 errors (6 warnings, unchanged baseline) · both builds ✓ ·
`preflight:fresh-schema` SUCCESS (71 migrations, no drift) ·
`release-validate.mjs` **16/16 PASSED**. **No migration was added or modified.**

**Live cross-role, cross-surface check** (255 leads, three real role tokens):

```
          visitors/summary       dashboard/summary      visitors/pipeline
recept    255/226/28/1/11%       255/226/28/1/11%       255/-/28/-/11%
couns     255/226/28/1/11%       255/226/28/1/11%       255/-/28/-/11%
mgr       255/226/28/1/11%       255/226/28/1/11%       255/-/28/-/11%
                                  (total/open/converted/lost/rate)
```

Before this work: `225` vs `226` vs `0 conversions`.

RBAC boundary re-verified live: counselor reads the eligibility preview (200)
and is still refused the conversion (403); a role with `Lead.View` but not
`Lead.Create` is refused the duplicate lookup (403).

---

*GL-1 (browser visual inspection at 1920×1080 and a smaller viewport) and GL-2
(one actual printed fee bill) remain human-only steps and are **not** claimed as
verified. UX-11 and N-7 in particular are assessed from source, not from
rendered pixels or a screen-reader session.*
