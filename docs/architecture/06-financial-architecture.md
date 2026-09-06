# Financial Architecture

Finance owns fee definitions as configuration, obligations/charges, payments, allocations, refunds, discounts, scholarships/funding postings, adjustments, reversals, cash movements, journals, periods, and reconciliation. Funding owns restrictions and awards; Finance owns monetary posting. Reporting derives balances and totals from posted facts.

Transactions are immutable after posting. Idempotency keys are required at command and external-integration boundaries; duplicate keys return the original result. Allocation and refund commands use serialized per-source/obligation concurrency control and re-check amounts at commit. Payment, allocation, and refund are separate commits with source references. Corrections append adjustments/reversals. Journals require balanced lines, source reference, period, and posting authority. Closed periods reject mutation and permit only controlled reopening.

A payment cannot be allocated twice; allocations cannot exceed payment or obligation; refunds cannot exceed refundable source; restricted funds cannot be reclassified without approval. Reconciliation compares independent observed/source sets and records variance, never edits balances. No UI, report, payroll view, or mutable balance can post truth.
