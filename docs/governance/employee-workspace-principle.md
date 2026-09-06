# EMPLOYEE WORKSPACE PRINCIPLE

The TOEFL House platform MUST treat the employee workspace as a first-class architectural and product concept.

Every operational employee must have a dedicated, role-aware workspace from which that employee can efficiently perform the majority of their legitimate daily responsibilities.

This is NOT merely a dashboard.

It is the employee's primary operational work environment.

## 1. PERSONAL WORKSPACE

Each employee must receive a workspace dynamically composed according to:

- employee identity
- employment status
- current position(s)
- organizational scope
- branch/campus/department scope
- assigned operational responsibilities
- granted capabilities
- current lifecycle state
- assigned tasks
- pending approvals
- relevant deadlines
- operational context

The workspace MUST NOT expose actions the employee is not authorized to perform.

Authorization remains server-authoritative.

The workspace is a presentation and workflow layer over canonical backend authorities.

## 2. ROLE-AWARE, NOT ROLE-LOCKED

Do not assume one employee has only one role.

An employee may hold multiple legitimate positions and responsibilities.

The workspace must therefore compose the employee's actual authorized work rather than displaying a static "role dashboard."

For example, an employee with multiple positions may legitimately see multiple work areas while each action remains individually scope-checked and authorized.

## 3. WORK-FIRST DESIGN

The workspace must prioritize ACTION over decoration.

The employee should immediately understand:

- What requires my attention?
- What can I do now?
- What is overdue?
- What is waiting for another person?
- What has recently changed?
- What are today's priorities?
- What exceptions need action?
- Which workflows can I complete directly from here?

Avoid dashboards filled with information that does not help the employee perform work.

## 4. DAILY WORK COMMAND CENTER

Where applicable, the workspace should provide:

- My tasks
- My pending actions
- My approvals
- My assigned students
- My classes
- My appointments
- My attendance work
- My assessments
- My financial work
- My follow-ups
- My unresolved exceptions
- My notifications
- My recently used records
- My frequently used actions
- Relevant deadlines
- Relevant system alerts

Only display sections relevant to the employee's actual authorized responsibilities.

## 5. WORKFLOW-CENTERED DESIGN

Whenever possible, common tasks should be executable directly from the employee workspace without forcing the employee to navigate through multiple unrelated administrative pages.

Examples:

Receptionist:  
registration → student lookup → placement/payment workflow → follow-up

Finance officer:  
pending payments → allocation → correction proposal → refund workflow → reconciliation

Teacher:  
today's classes → attendance → assessment → grading → correction requests

Academic manager:  
class capacity → attendance exceptions → teacher assignment → timetable issues → progression decisions

HR:  
employee lifecycle → assignment → payroll preparation → clearance → settlement proposal

Manager:  
approvals → exceptions → operational KPIs → unresolved problems → organizational decisions

The exact workspace must be determined from the actual authority and permissions model rather than hardcoded role assumptions.

## 6. PERSONALIZATION WITHOUT LOSING STANDARDIZATION

The platform should support personalization such as:

- preferred shortcuts
- favorite records
- frequently used actions
- workspace layout preferences
- saved filters
- saved views
- useful reminders
- recent work

But personalization MUST NOT alter business authority, security, lifecycle rules, or financial truth.

Personalization changes presentation and productivity, not permissions.

## 7. CONTEXTUAL WORK

The workspace should surface work according to context.

Examples:

- today's classes
- upcoming deadlines
- students needing attention
- pending approvals
- failed or blocked workflows
- financial exceptions
- unresolved admissions cases
- pending documents
- overdue follow-ups

Use business events and authoritative facts rather than creating independent shadow state.

## 8. EXCEPTION-FIRST VISIBILITY

Routine work should be easy.

Problems should be impossible to miss.

The workspace should clearly surface exceptional situations such as:

- blocked enrollment
- unresolved payment
- financial discrepancy
- missing required evidence
- branch/scope conflict
- pending approval
- failed workflow
- expiring assignment
- attendance anomaly
- grading issue
- document issue
- system-generated operational exception

Exceptions must link directly to the correct authoritative workflow.

## 9. WORKSPACE AS A CROSS-MODULE EXPERIENCE

The workspace may aggregate information from multiple modules.

However:

AGGREGATION MUST NOT CREATE A NEW AUTHORITY.

For example, a receptionist workspace may show:

Student + Admission + Placement + Payment status

but the receptionist workspace does not become the authority for any of those facts.

Each action must resolve through the canonical domain authority.

## 10. EMPLOYEE EFFICIENCY STANDARD

Evaluate every employee workflow using real operational metrics:

- number of steps
- unnecessary navigation
- duplicate data entry
- cognitive load
- error probability
- time to completion
- discoverability
- training difficulty
- recovery from mistakes

The system should reduce avoidable human effort.

Do not optimize for architectural elegance while creating a painful employee workflow.

## 11. HUMAN FACTORS

Design for real employees operating under normal organizational pressure.

Consider:

- novice staff
- experienced staff
- temporary workload spikes
- interruptions
- repeated daily operations
- mistakes
- incomplete information
- multi-tasking
- varying technical ability

The workspace should help employees make correct decisions quickly.

## 12. MANAGEMENT WORKSPACE

Management users should receive a different experience from operational employees.

A management workspace should emphasize:

- organizational performance
- exceptions
- pending decisions
- financial overview
- academic performance
- staffing
- operational risks
- bottlenecks
- unresolved issues
- trends
- accountability

Do not force management to work through employee-level operational screens.

## 13. EMPLOYEE SAFETY AND AUTHORIZATION

Workspace visibility must never be treated as authorization.

Every sensitive operation MUST still be checked server-side.

If:

- employment is suspended
- employment is terminated
- assignment expires
- position changes
- branch scope changes
- delegation expires
- capability is revoked

the effective workspace and accessible actions must reflect the authoritative authorization state.

No stale workspace state may preserve unauthorized power.

## 14. WORKSPACE ARCHITECTURE

The workspace system itself must be architecturally clean.

Prefer:

Employee identity  
→ effective authority  
→ relevant work context  
→ canonical queries/actions  
→ workspace composition  
→ UI

Do not create a giant workspace service containing unrelated business rules.

The workspace should orchestrate and present authoritative domain capabilities.

## 15. RESEARCH AND BENCHMARKING

Before finalizing the workspace architecture, independently research mature approaches to:

- ERP employee workspaces
- role-based work centers
- task-oriented enterprise UX
- CRM workspaces
- accounting workbenches
- HR work centers
- academic administration consoles
- exception-driven workflows

Study strong enterprise products and mature operational systems.

Extract proven patterns.

Do not copy blindly.

Adapt only what is suitable for TOEFL House.

## 16. PRODUCT QUALITY STANDARD

The final experience should make an employee think:

"I know what I need to do."

"I can find it immediately."

"I do not need to understand the whole ERP."

"The system tells me what needs attention."

"I can complete routine work quickly."

"I can recover safely from mistakes."

This is a core product requirement, not an optional UX enhancement.

## 17. ARCHITECTURAL REQUIREMENT

Employee Workspace is a first-class platform capability.

It must be considered whenever designing:

- authorization
- employee lifecycle
- notifications
- tasks
- approvals
- search
- reporting
- workflow
- API contracts
- frontend architecture
- event/outbox architecture
- personalization
- auditability

The workspace must evolve with the organization's real work.

## 18. FINAL STANDARD

Do not build one generic dashboard and call it an employee workspace.

Build a genuine operational work environment for each employee.

The goal is:

RIGHT PERSON  
→ RIGHT WORK  
→ RIGHT CONTEXT  
→ RIGHT INFORMATION  
→ RIGHT ACTION  
→ RIGHT AUTHORITY  
→ MINIMUM UNNECESSARY EFFORT

Employee Workspace must become one of the defining characteristics of the final TOEFL House platform.
