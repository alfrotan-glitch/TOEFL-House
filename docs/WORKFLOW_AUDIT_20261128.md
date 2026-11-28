# Registered workflow audit — 28 November 2026

This is a read-only snapshot of every workflow returned by GitHub Actions at the time of review. Source is the `main` version when present, otherwise one fetched remote-ref version. Variants count distinct Git blob IDs among fetched branch tips. **A workflow marked active by GitHub is not necessarily invoked; a historical name is not proof it is safe to remove.** Cross-ref variants, external `workflow_dispatch` consumers, branch protection requirements, secrets, environment rules, and deployment integrations require separate owner review. No workflow was disabled.

`Triggers` are parsed from the selected source. `Writes` flags explicit write permissions or push/deploy text, not a proof that other workflows are read-only. Fixed hostnames are a signal to investigate, not a candidate test. Artifacts and run history may still be needed. API returned 92 workflows; checkout as audited before the current iteration had 44.

| Workflow | Path | API state | Source reference | Ref tips / variants | Triggers | Writes / deployment indicators |
| --- | --- | --- | --- | ---: | --- | --- |
| Integrated catalog and EAP preview acceptance | `.github/workflows/catalog-integrated-preview.yml` | active | `qa/catalog-95db2ac` | 1 / 1 | push | fixed Pages host |
| Narrow-screen catalog and EAP preview acceptance | `.github/workflows/catalog-narrow-preview.yml` | active | `qa/catalog-e603abc` | 1 / 1 | push | fixed Pages host |
| .github/workflows/ci.yml | `.github/workflows/ci.yml` | active | `arena/01a01dc0-toefl-house` | 11 / 1 | push, pull_request | none detected |
| Cloudflare Analytics Verification | `.github/workflows/cloudflare-analytics-tests.yml` | active | `main` | 109 / 2 | push, pull_request, workflow_dispatch | Cloudflare tooling |
| Diagnose public CMS route on Pages hosts | `.github/workflows/cms-route-diagnostic.yml` | active | `diagnose-canonical-cms-api-20261120` | 1 / 1 | push | fixed Pages host |
| Dari campus image delivery evidence | `.github/workflows/dari-campus-image-optimization.yml` | active | `qa/dari-campus-image-optimization-d80e575` | 1 / 1 | push | fixed Pages host |
| Diagnose narrow viewport overflow | `.github/workflows/diagnose-overflow.yml` | active | `qa/overflow-diagnosis-f50e562` | 1 / 1 | push | fixed Pages host |
| EAP academic program — three-language browser acceptance | `.github/workflows/eap-browser.yml` | active | `main` | 93 / 4 | push, workflow_dispatch | fixed Pages host |
| EAP editorial preview acceptance | `.github/workflows/eap-editorial-preview.yml` | active | `qa/eap-editorial-9e4f33e` | 1 / 1 | push | fixed Pages host |
| EAP mobile preview repeated Lighthouse and read-only safety | `.github/workflows/eap-mobile-perf-repeat-2a273d8.yml` | active | `qa/eap-mobile-perf-repeat-2a273d8` | 1 / 1 | push | fixed Pages host |
| EAP mobile editorial exact-worker acceptance | `.github/workflows/eap-mobile-preview.yml` | active | `qa/eap-mobile-2a273d8` | 1 / 1 | push | fixed Pages host |
| Verify final candidate repeated Lighthouse and read-only safety | `.github/workflows/final-candidate-performance-8406d04.yml` | active | `qa/final-perf-confirm-8406d04` | 2 / 2 | push | fixed Pages host |
| Final mobile hero integrated acceptance | `.github/workflows/final-mobile-hero-preview.yml` | active | `qa/hero-244b6d8` | 1 / 1 | push | fixed Pages host |
| Final integrated preview repeated Lighthouse and read-only safety | `.github/workflows/final-pashto-perf-repeat.yml` | active | `qa/final-pashto-7c8edfd` | 1 / 1 | push | fixed Pages host |
| Final Pashto typography and EAP exact-worker acceptance | `.github/workflows/final-pashto-preview.yml` | active | `qa/final-pashto-7c8edfd` | 1 / 1 | push | fixed Pages host |
| Dari font and integrated V3 preview acceptance | `.github/workflows/font-integrated-preview.yml` | active | `qa/hero-b178de1` | 1 / 1 | push | fixed Pages host |
| Dari LCP and integrated V3 preview acceptance | `.github/workflows/lcp-integrated-preview.yml` | active | `qa/final-8406d04` | 5 / 3 | push | fixed Pages host |
| TOEFL House Browser Conversion Acceptance | `.github/workflows/pages-browser-acceptance.yml` | active | `main` | 109 / 2 | push, workflow_dispatch | none detected |
| TOEFL House Pages Edge Safety | `.github/workflows/pages-edge-safety.yml` | active | `main` | 109 / 2 | push, pull_request, workflow_dispatch | none detected |
| TOEFL House Live Conversion Collector End-to-End | `.github/workflows/pages-live-collector-smoke.yml` | active | `main` | 108 / 1 | workflow_dispatch | none detected |
| TOEFL House Cloudflare preview parity | `.github/workflows/pages-preview-parity.yml` | active | `main` | 109 / 2 | workflow_dispatch | none detected |
| TOEFL House upgrade performance comparison | `.github/workflows/pages-preview-performance.yml` | active | `main` | 109 / 2 | workflow_dispatch | none detected |
| TOEFL House Production Post-Deploy Acceptance | `.github/workflows/pages-production-acceptance.yml` | active | `main` | 109 / 2 | push, workflow_dispatch | none detected |
| Compare original immutable Pages and live alias (read only) | `.github/workflows/pages-upstream-comparison.yml` | active | `main` | 109 / 2 | workflow_dispatch | none detected |
| Pashto glyph coverage and typography evidence | `.github/workflows/pashto-font-coverage.yml` | active | `qa/dari-campus-image-optimization-d80e575` | 1 / 1 | push | fixed Pages host |
| Responsive scope and signature hero acceptance | `.github/workflows/responsive-hero-preview.yml` | active | `qa/hero-c742e25` | 1 / 1 | push | fixed Pages host |
| Qaws 1405 — real-browser semester campaign acceptance | `.github/workflows/semester-video-browser.yml` | active | `main` | 94 / 2 | push, workflow_dispatch | fixed Pages host |
| Semester Qaws 1405 — promotional video source acceptance | `.github/workflows/semester-video-source-check.yml` | active | `main` | 94 / 1 | push, workflow_dispatch | none detected |
| Signature hero integrated preview acceptance | `.github/workflows/signature-hero-preview.yml` | active | `qa/hero-4ce1af9` | 1 / 1 | push | fixed Pages host |
| Signature homepage performance diagnosis | `.github/workflows/signature-performance-diagnosis.yml` | active | `qa/perf-diagnose-244b6d8` | 1 / 1 | push | fixed Pages host |
| Diagnose 320px homepage overflow | `.github/workflows/toefl-320-overflow-diagnosis.yml` | active | `qa/overflow-320-diagnosis` | 1 / 1 | push | fixed Pages host |
| Attested preview 7c8edfd — byte-identical Worker acceptance | `.github/workflows/toefl-attested-preview-7c8edfd.yml` | active | `qa/attested-7c8edfd-d49de5df` | 1 / 1 | push | fixed Pages host |
| Brand and Google Meet release preview | `.github/workflows/toefl-brand-meet-preview.yml` | active | `qa/brand-meet-957e7c7-20261126` | 1 / 1 | push | fixed Pages host |
| Published brand release acceptance | `.github/workflows/toefl-brand-production-acceptance.yml` | active | `qa/production-brand-957e7c7` | 1 / 1 | push | fixed Pages host |
| TOEFL House CMS Security (Anonymous / Non-mutating) | `.github/workflows/toefl-cms-auth-negative.yml` | active | `main` | 105 / 1 | workflow_dispatch | none detected |
| TOEFL House CMS Endpoint Inventory (No Auth) | `.github/workflows/toefl-cms-endpoint-inventory.yml` | active | `main` | 105 / 1 | workflow_dispatch | none detected |
| TOEFL House Legacy CMS Dependency Gate | `.github/workflows/toefl-cms-legacy-dependency.yml` | active | `main` | 105 / 1 | workflow_dispatch | none detected |
| TOEFL House Public CMS Recovery Snapshot | `.github/workflows/toefl-cms-public-snapshot.yml` | active | `main` | 105 / 1 | workflow_dispatch | none detected |
| TOEFL House CMS QA Pre-Merge | `.github/workflows/toefl-cms-qa-premerge.yml` | active | `main` | 105 / 1 | push, workflow_dispatch | none detected |
| TOEFL House — Dari typography & mobile FAQ browser acceptance | `.github/workflows/toefl-dari-typography.yml` | active | `main` | 85 / 2 | push, workflow_dispatch | fixed Pages host |
| Exact main preview acceptance — e17879a | `.github/workflows/toefl-exact-preview-e17879a.yml` | active | `qa/main-e17879a-attested-20261128` | 1 / 1 | push | fixed Pages host |
| Final production quality verification | `.github/workflows/toefl-final-production-58fb6b3.yml` | active | `qa/production-final-58fb6b3` | 1 / 1 | push | fixed Pages host |
| Friendly academic design — exact preview acceptance | `.github/workflows/toefl-friendly-design-4577f9a.yml` | active | `qa/friendly-design-4577f9a` | 1 / 1 | push | fixed Pages host |
| Friendly academic design — corrected mobile acceptance | `.github/workflows/toefl-friendly-mobile-52a2b4e.yml` | active | `qa/friendly-mobile-52a2b4e` | 1 / 1 | push | fixed Pages host |
| Full public brand preview acceptance | `.github/workflows/toefl-full-brand-preview.yml` | active | `qa/brand-all-e44c583` | 1 / 1 | push | fixed Pages host |
| Full public brand production acceptance | `.github/workflows/toefl-full-brand-production.yml` | active | `qa/full-brand-production-f50e562` | 1 / 1 | push | fixed Pages host |
| General English editorial — exact preview acceptance | `.github/workflows/toefl-ge-editorial-9b1b2bc.yml` | active | `qa/ge-editorial-9b1b2bc` | 1 / 1 | push | fixed Pages host |
| General English experience — exact preview acceptance | `.github/workflows/toefl-ge-experience-0e916bf.yml` | active | `qa/ge-experience-0e916bf` | 1 / 1 | push | fixed Pages host |
| General English integrated skills — exact preview acceptance | `.github/workflows/toefl-ge-integrated-8daed54.yml` | active | `qa/ge-integrated-8daed54` | 1 / 1 | push | fixed Pages host |
| General English premium — exact preview acceptance | `.github/workflows/toefl-ge-premium-acc6400.yml` | active | `qa/ge-premium-acc6400` | 1 / 1 | push | fixed Pages host |
| TOEFL House General English Exact Preview Visual & WCAG Acceptance | `.github/workflows/toefl-general-english-preview-acceptance.yml` | active | `main` | 101 / 1 | workflow_dispatch | none detected |
| Official homepage exact preview — c683360 | `.github/workflows/toefl-home-preview-c683360.yml` | active | `qa/home-c683360-20261128` | 1 / 1 | push | fixed Pages host |
| Signature homepage exact preview — 2449ae | `.github/workflows/toefl-home-signature-2449ae.yml` | active | `qa/home-signature-2449ae-20261128` | 1 / 1 | push | fixed Pages host |
| TOEFL House — Free short address production acceptance | `.github/workflows/toefl-house-short-alias.yml` | active | `main` | 85 / 1 | push, workflow_dispatch | fixed Pages host |
| Learning habits and General English — exact preview acceptance | `.github/workflows/toefl-learning-habits-038f542.yml` | active | `qa/learning-habits-038f542` | 1 / 1 | push | fixed Pages host |
| TOEFL House — Legacy Tools Brand Browser Acceptance | `.github/workflows/toefl-legacy-brand-browser.yml` | active | `main` | 96 / 2 | push, workflow_dispatch | fixed Pages host |
| TOEFL House live-site smoke tests | `.github/workflows/toefl-live-site-smoke.yml` | active | `main` | 109 / 2 | push, pull_request, workflow_dispatch | none detected |
| Narrow-screen candidate acceptance | `.github/workflows/toefl-narrow-preview.yml` | active | `qa/narrow-0f99266` | 1 / 1 | push | fixed Pages host |
| Online admissions candidate acceptance | `.github/workflows/toefl-online-preview.yml` | active | `qa/online-1c6cc1e` | 1 / 1 | push | fixed Pages host |
| Production online admissions acceptance | `.github/workflows/toefl-online-production.yml` | active | `qa/production-online-58fb6b3` | 1 / 1 | push | fixed Pages host |
| Mobile performance candidate acceptance | `.github/workflows/toefl-perf-preview-fa030bf.yml` | active | `qa/perf-fa030bf-20261126` | 1 / 1 | push | fixed Pages host |
| Production performance and responsive acceptance | `.github/workflows/toefl-perf-production-6976b58.yml` | active | `qa/production-perf-6976b58` | 1 / 1 | push | fixed Pages host |
| TOEFL House — Designer UX audit production browser acceptance | `.github/workflows/toefl-premium-ux-preview.yml` | active | `main` | 85 / 2 | push, workflow_dispatch | fixed Pages host |
| Exact preview 7c8edfd — read-only acceptance and performance | `.github/workflows/toefl-preview-7c8edfd.yml` | active | `qa/preview-perf-7c8edfd` | 1 / 1 | push | fixed Pages host |
| Production 8ce2ca3 — attested release acceptance | `.github/workflows/toefl-production-8ce2ca3.yml` | active | `qa/production-8ce2ca3-d49de5df` | 1 / 1 | push | fixed Pages host |
| TOEFL House Production Admissions End-to-End Acceptance | `.github/workflows/toefl-production-admissions-acceptance.yml` | active | `main` | 102 / 1 | workflow_dispatch | none detected |
| Post-release production acceptance — e17879a | `.github/workflows/toefl-production-e17879a.yml` | active | `qa/production-e17879a-20261128` | 1 / 1 | push | fixed Pages host |
| Exact release preview 39d3042 | `.github/workflows/toefl-release-preview-39d3042.yml` | active | `qa/preview-39d3042-20261126` | 1 / 1 | push | fixed Pages host |
| Exact release production 39d3042 | `.github/workflows/toefl-release-production-39d3042.yml` | active | `qa/production-39d3042-20261126` | 1 / 1 | push | fixed Pages host |
| Production responsive and brand acceptance | `.github/workflows/toefl-responsive-production.yml` | active | `qa/production-narrow-1ae0a70` | 1 / 1 | push | fixed Pages host |
| Shared brand asset acceptance | `.github/workflows/toefl-shared-brand-preview.yml` | active | `qa/shared-brand-0e25d0c` | 2 / 2 | push | fixed Pages host |
| TOEFL House public Pages snapshot (read-only) | `.github/workflows/toefl-site-public-snapshot.yml` | active | `main` | 109 / 2 | workflow_dispatch | none detected |
| TOEFL House — Special Speaking & TOEFL release browser acceptance | `.github/workflows/toefl-special-programs-preview-qa.yml` | active | `main` | 85 / 1 | push, workflow_dispatch | fixed Pages host |
| TOEFL House V2 Accessibility Audit | `.github/workflows/toefl-v2-accessibility.yml` | active | `main` | 107 / 1 | push, workflow_dispatch | fixed Pages host |
| TOEFL House Admissions Language Continuity (Exact Preview) | `.github/workflows/toefl-v2-admissions-language-continuity.yml` | active | `main` | 103 / 1 | push, workflow_dispatch | fixed Pages host |
| TOEFL House V2 Admissions and Guides Preview Acceptance | `.github/workflows/toefl-v2-admissions-preview.yml` | active | `main` | 106 / 1 | workflow_dispatch | none detected |
| TOEFL House V2 Real Browser Design QA | `.github/workflows/toefl-v2-browser.yml` | active | `main` | 108 / 1 | push, workflow_dispatch | none detected |
| TOEFL House V2 Redesign Safety | `.github/workflows/toefl-v2-design.yml` | active | `main` | 108 / 8 | push, pull_request, workflow_dispatch | none detected |
| TOEFL House V2 Program and Admissions Visual QA | `.github/workflows/toefl-v2-detail-browser.yml` | active | `main` | 108 / 1 | push, workflow_dispatch | none detected |
| TOEFL House V2 — Exact Preview Final Acceptance | `.github/workflows/toefl-v2-final-preview.yml` | active | `main` | 104 / 1 | push, workflow_dispatch | fixed Pages host |
| TOEFL House V2 Final Production Navigation Acceptance | `.github/workflows/toefl-v2-final-production-navigation.yml` | active | `main` | 108 / 1 | push, workflow_dispatch | none detected |
| TOEFL House V2 Lighthouse Mobile Baseline | `.github/workflows/toefl-v2-lighthouse-baseline.yml` | active | `main` | 106 / 1 | schedule, workflow_dispatch | none detected |
| TOEFL House V2 Live Browser Final Acceptance | `.github/workflows/toefl-v2-live-browser.yml` | active | `main` | 108 / 1 | push, workflow_dispatch | none detected |
| TOEFL House V2 Production Anonymous Conversion Acceptance | `.github/workflows/toefl-v2-live-conversion-qa.yml` | active | `main` | 106 / 1 | workflow_dispatch | none detected |
| TOEFL House V2 Navigation Preview Gate | `.github/workflows/toefl-v2-navigation-gate.yml` | active | `main` | 108 / 1 | push, workflow_dispatch | none detected |
| TOEFL House V2 — Production Quality Gate | `.github/workflows/toefl-v2-production-quality.yml` | active | `main` | 107 / 10 | push, pull_request, schedule, workflow_dispatch | fixed Pages host |
| TOEFL House V2 Production Full Acceptance | `.github/workflows/toefl-v2-production.yml` | active | `main` | 108 / 2 | push, pull_request, workflow_dispatch | none detected |
| TOEFL House V2 Candidate Preview Acceptance | `.github/workflows/toefl-v2-quality-preview.yml` | active | `main` | 107 / 1 | push, workflow_dispatch | none detected |
| TOEFL House V2 Content Schema Read-Only | `.github/workflows/toefl-v2-schema.yml` | active | `main` | 108 / 1 | push, workflow_dispatch | none detected |
| TOEFL House V2 Legacy Tools Browser Acceptance | `.github/workflows/toefl-v2-tools.yml` | active | `main` | 108 / 1 | push, workflow_dispatch | none detected |
| TOEFL House — Full-brand free production address QA | `.github/workflows/toeflhouse-fullname-alias.yml` | active | `main` | 85 / 3 | push, pull_request, workflow_dispatch | fixed Pages host |
| TOEFL House — Vendor licensed Persian font (one-time) | `.github/workflows/vendor-persian-font.yml` | active | `main` | 85 / 1 | push | write permission, git push |

Parser errors: 0. The selected source may differ from the workflow definition that last ran. Current-branch changes made after this census are not represented.

Recommended consolidation sequence: map check requirements and owners; replace fixed candidate-preview checks with a parameterized exact-artifact gate; keep scheduled production monitoring separate from PR qualification; move direct pushes to reviewed changes; only retire a workflow after equivalent behavior, external dependencies and historical evidence are verified. Cloudflare release itself remains an authorized operator action until scoped infrastructure and exact deployment validation are available.
