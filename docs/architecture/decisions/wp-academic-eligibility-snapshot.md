# Academic Eligibility Snapshot — Architecture Decision (AC1)

Status: Accepted
Date: 2026-09-04
Scope: Signed, versioned, immutable academic-context snapshot produced by a
released Placement recommendation.

## Context

The Placement Decision System (WP-P) already produces a released
`PlacementProfile` and an immutable `PlacementRecommendation` with an
explainable score snapshot, recommended `ProgramVersionLevel`, and
operational recommended `Offering`/`Class`. The WP-1 gap matrix still reports
the signed `AcademicEligibilityResult` / academic-context snapshot as missing:
downstream systems (Admissions, Enrollment, Academic, Finance) can only see
the fingerprint of what was released; they cannot consume one authoritative,
integrity-signed object that reproduces exactly the academic context the
release was based on.

## Decision

The signed eligibility snapshot is an **Academic authority** fact, created
atomically with a Placement profile's `released` transition. It is never a
separate downstream decision and never changes the role separation of the
existing placement decision chain.

### Entity

`academic_eligibility_snapshots` stores one immutable signed record per
released profile:

- `placement_profile_id`, `placement_recommendation_id`, `person_id`,
  `visitor_id`, and the released recommendation's authoritative identities:
  program version, recommended level, recommended class, recommended
  offering, academic period (when present), and branch provenance.
- `snapshot_schema_version` (contract version, `academic-context-snapshot-v1`)
  and a `version_no` per profile for history.
- `payload` (JSONB) plus `payload_canonical_json` (TEXT) — the exact bytes that
  were signed — and `payload_sha256`.
- `signature_algorithm` `hmac-sha256`, `signature`, `signing_key_version`,
  `signed_by`, `signed_at`, and `supersedes_snapshot_id` for retake chaining.
- DB trigger blocks UPDATE and DELETE after insertion; the row is append-only
  history.

### Signing and verification

- Canonicalization is deterministic: associative keys are recursively sorted;
  lists keep order; strings use `JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE`.
- `payload_sha256` = SHA-256 over the canonical JSON bytes.
- `signature` = HMAC-SHA256 over that canonical JSON bytes using a key derived
  from `config('app.key')` plus the snapshot contract name. The key is outside
  domain data; only the signature and key version are stored.
- Verification recomputes canonicalization + digest + HMAC and compares with
  `hash_equals`; a rotated key makes old snapshots fail closed (unverifiable,
  never silently accepted).

### Consumption boundaries

- **Admissions**: registration with a `placement_profile_id` requires a
  released profile that has a verifiable eligibility snapshot; the applicant
  stores the snapshot reference. Conversion copies it to the Student record.
- **Enrollment**: a new enrollment row carries the Student's current
  eligibility snapshot reference when one exists; Academic never re-derives
  the recommendation from live catalogs at seat time.
- **Academic**: `PlacementProfile` records its latest eligibility snapshot;
  full snapshot/history queries expose the signed payload and verified state.
- **Finance**: consumption is read-only through the Academic snapshot query
  (the same `PlacementFinanceLinkQuery` lineage). Academic never creates or
  mutates Finance facts from this snapshot.
- A retake creates a new profile; a later release creates a new snapshot whose
  `supersedes_snapshot_id` points to the prior snapshot, preserving an
  append-only per-person chain.

### Capabilities

- Snapshots are produced inside the existing `placement.release` operation;
  no new standalone capability is introduced. Reading/verifying is a read
  query.

## Consequences

- Migration `2026_09_04_000133_add_academic_eligibility_snapshots.php` adds the
  snapshot table, the profile/applicant/student/enrollment snapshot
  references, and the append-only trigger.
- New model: `AcademicEligibilitySnapshot`.
- New domain/support: `CanonicalJson`, `AcademicEligibilitySigner`,
  `AcademicEligibilitySnapshotBuilder`, `AcademicEligibilitySnapshotQuery`.
- `DecidePlacement::release` creates the snapshot transactionally with the
  release. `RegisterApplicant`, `EnrollAdmittedApplicant`, and
  `MaintainEnrollment` carry the snapshot reference.
- Tests cover release/sign/verification, immutability, retake chaining,
  Admissions/Student/Enrollment propagation, tamper detection, and the
  Finance read lineage.
