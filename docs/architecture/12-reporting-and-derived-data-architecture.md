# Reporting and Derived Data Architecture

Reporting has metric definitions, versioned calculation specifications, scope/period parameters, projection refresh, report runs, completeness markers, and reconciliation status. It reads canonical domain outputs; it cannot write them. Operational queries use owner contexts; analytical projections are rebuildable and carry source/version/as-of metadata.

Financial metrics consume Finance posted transactions, journals, and reconciliation under Financial Period semantics. Enrollment, attendance, progression, payroll, funding, inventory, and asset metrics use their registered owner facts and effective dates. A report cannot redefine month, revenue, receivable, cash, payroll, or academic success. Stale/incomplete projections are labeled or withheld, never silently presented as authoritative.

Employee and management workspaces may surface governed metrics, deadlines, exceptions, and operational context, but workspace cards and work queues are presentation projections rather than business facts. A workspace must link to the authoritative report or domain workflow and must not maintain an independent balance, enrollment state, payroll state, approval state, or exception truth.
