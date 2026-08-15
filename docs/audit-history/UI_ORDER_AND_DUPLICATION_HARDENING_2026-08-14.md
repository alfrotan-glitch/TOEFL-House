# TOEFL House ERP — Academic Setup UI / Domain Hardening

## User-reported visual findings verified from screenshots

### 1. Duplicate Capacity / Fee inputs
The previous UI exposed capacity and fee in multiple places:
- Program/Level configuration
- Course Offering creation
- Class Generation configuration

This created competing sources of truth.

### 2. Generation order was not enforced
The UI displayed `Course Offerings` and `Generate Classes` side-by-side in the same phase, and generation was unlocked as soon as curriculum existed. This allowed a user to reach class generation before creating a Course Offering.

### 3. Version/assessment controls were too compressed
The placement assessment editor used a dense six-column layout. Section name, type, numeric fields, and examiner instructions were visibly truncated on a 1920×1080 capture.

### 4. Class generation displayed a runtime error
The generation screen showed `Cannot read properties of undefined (reading 'filter')`. The generator contained an unsafe `res.items.filter(...)` publish success path. The revised UI normalizes all API arrays before use and never assumes `items` exists.

## Remediation

- Academic Setup now follows a strict sequence:
  1. Infrastructure
  2. Curriculum + Versions
  3. Course Offerings
  4. Generate Class Sections
- Generate Classes is locked until at least one Course Offering exists.
- Course Offering creation requires Program + Program Version + Level + Academic Term.
- Course Offering fee is derived from the selected level/branch fee policy; there is no manual fee input.
- Course Offering capacity is not manually editable; it is derived from the sum of generated class section capacities.
- Class section capacity is sourced from the assigned physical room.
- Class generation is now driven by `offeringId`, not a second copy of program/version/term/fee/capacity settings.
- Generated classes are directly attached to the Course Offering inside the publish transaction.
- Offering capacity is recalculated from linked class capacities after publish.
- Class generation requires active rooms and active time slots and rejects insufficient room capacity for simultaneous sections.
- Program version / placement assessment layout was widened and relabeled so numeric fields and instructions remain readable.
- Assessment fields now have explicit labels for pass threshold and maximum score.
- API responses are normalized before `.filter()` / `.map()` use to prevent UI runtime crashes.
- Course Offering backend validates curriculum consistency and derives the fee server-side, preventing client-side fee tampering.

## Verification

- Modified UI/backend files were parsed individually with the TypeScript compiler's transpiler parser: all targeted files passed.
- Global full typecheck could not be certified because the project dependencies are not installed in this audit environment and the repository requires `vite/client` types from the installed dependency tree.
- No manual capacity/fee input remains in `OfferingsPanel` creation state.
- No `updated_at` write remains against `course_offerings`, whose current schema does not contain that column.
