# Academic Implementation Contract

Students/Admissions own verified student, admission, and enrollment. Academic owns versioned programs, levels, periods, placement attempts/evidence/results, classes, schedules, teacher delivery assignment, attendance, assessments, progression, appeals, eligibility, and certificates. HR owns teacher employment; Finance owns obligations.

Evidence (responses, attendance, submissions, scores) is immutable and may be corrected only by linked append. Official placement/progression/graduation decisions are separate authorized commands with review, preconditions, effective period, appeal, and supersession. Evidence never silently becomes a decision. Capacity/membership uses concurrency controls. Tests cover identity, enrollment, effective assignments, evidence/decision separation, appeals, lifecycle, and history.
