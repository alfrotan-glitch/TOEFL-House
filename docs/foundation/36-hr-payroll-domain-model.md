# HR and Payroll Domain Model

| Entity | Owner | Purpose | Historical rule |
|---|---|---|---|
| Employment | HR | relationship and status | status history retained |
| Contract | HR | agreed terms | signed terms immutable once used |
| Position Assignment | HR/Access | effective job responsibility | close prior, start new |
| Compensation Rule/Component | HR | contractual entitlement | effective-dated |
| Work/Teaching Basis | HR/Academic | hours, classes, workload evidence | source evidence retained |
| Leave | HR | approved absence | approval/history retained |
| Payroll Period | Payroll/Finance | calculation window | controlled closing |
| Payroll Calculation | Payroll | computed entitlement | recalculation audited |
| Payroll Result | Payroll | approved payable result | correction/reversal, not overwrite |
| Payroll Adjustment | Payroll/Finance | approved correction | source-linked |
| Advance/Loan | HR/Finance | employee obligation where applicable | balance derived from transactions |
| HR/Finance Clearance | HR/Finance | termination checks | both clear before closure |
| Final Settlement | Payroll/Finance | final obligation/payment | immutable approved result |
| Termination | HR | employment closure | access ends, history retained |

Contractual entitlement, calculated payroll, and actual payment are separate. Contract-silent absence/overtime/advance/deduction cases are held for HR and Finance review.
