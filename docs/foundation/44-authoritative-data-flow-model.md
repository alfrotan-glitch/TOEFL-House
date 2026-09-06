# Authoritative Data Flow Model

## Flow rule

A command enters through an authorized operation, is validated against configuration and owned invariants, is accepted by exactly one owning domain, and produces an immutable fact/state transition plus audit evidence. Other domains receive a read, decision input, or notification; they do not copy authority.

| Fact family | Authoritative owner | Consumers | Derived outputs |
|---|---|---|---|
| Person/student/guardian identity | Identity/Students | Admissions, Academic, HR, Finance | directories |
| Enrollment and membership | Students/Academic delivery | Academic, Finance, Reporting | active counts |
| Evidence/results/decisions | Academic | Students, Reporting | progression metrics |
| Employment/contracts/work basis | HR/Academic by fact | Payroll, Access | staffing metrics |
| Payroll calculation/result/payment | Payroll/Finance by fact | HR, Reporting | payroll totals |
| Obligations/charges | Finance | Students, Reporting | receivables |
| Payment/allocation/refund/adjustment/reversal | Finance | Students, Reporting | balance |
| Cash/journal/reconciliation | Finance | Reporting, Audit | cash position |
| Authority/permission/scope | Access | all operation gates | effective access |
| Consent/disclosure/document verification | Privacy/Documents | Communication, domains | compliance reports |

A historical fact carries actor, time, reason, authority, scope, effective date, and source. Corrections append; they never mutate the prior fact. Financial balances and report metrics are projections from canonical facts, not stored authorities.
