# HR and Payroll Architecture

HR owns person employment, contracts, compensation terms, position assignment, leave, termination, and clearance. Academic owns teaching/work evidence. Payroll owns period calculation and approved payroll result. Finance owns journal/payment posting. Contractual entitlement, calculation, result, and actual payment remain separate.

Payroll calculation snapshots effective contract/configuration and source work evidence for the period. Review/approval is segregated from preparation and beneficiary. Contract-silent cases are held for HR/Finance; no invented charge or payment. Payroll period closure and Finance period closure coordinate through explicit status checks; disagreement creates an exception, not silent overwrite. Corrections append adjustment/reversal history and retain prior calculation.
