# Privacy, Audit, and Resilience Architecture Contract

## Privacy

Personal and sensitive information has classification, owner, purpose, minimum necessary scope, retention rule, and access audit. Consent is an explicit, purpose-specific, effective-dated record; communication and marketing consent are separate. Disclosure records recipient, purpose, authority, scope, time, and disclosed category. Verification records verifier, outcome, evidence, and reason. Guardian access requires verified relationship and applicable permission. Revocation prevents future use without erasing historical consent/disclosure evidence.

## Audit and history

Material operations preserve who, what, when, why, previous value, new value, authority, approval, scope, effective date, source, and outcome. Audit is append-only and does not own business state. Historical relationships, transactions, decisions, configuration versions, and branch attribution remain immutable; corrections and reversals append linked records.

## Resilience boundary

Architecture must preserve committed financial transactions and append-only audit evidence across backup and recovery. Recovery requirements must specify, before operational design, acceptable data loss (RPO), acceptable downtime (RTO), backup coverage, restoration verification, period/reconciliation integrity, and recovery audit evidence. These are requirements, not infrastructure-product choices. Until organization-specific RPO/RTO values are supplied, design must use conservative documented targets and mark values configurable; no financial transaction may be discarded to meet availability goals.
