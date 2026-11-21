# The TOEFL House — Website V2 release & operations

## Live production and source

- Official website: https://toeflhouse.pages.dev/
- Source of the V2 edge renderer: `cloudflare/site-v2/` in the repository's `main` branch.
- Public content comes from the existing Cloudflare D1 `CMS_DB`; **do not** replace that database or overwrite it with sample data.
- Historical React tools are available at `/tools/`, `/fa/tools/`, `/ps/tools/`, and are intentionally `noindex`.
- The new admissions enquiry **prepares** WhatsApp text on the user's device. It does not create a confirmed enrollment or store visitor PII.
- Free placement assessment is separate from paid course tuition. TOEFL Preparation duration is **four months**.

## CI

`The TOEFL House V2 — Production Quality Gate` checks:

1. Repeatable Worker build and syntax.
2. Trilingual, CMS resilience, privacy and routing unit tests.
3. Release size limit.
4. Live 39-route sitemap/canonical/indexability/CMS security checks.
5. Real browser WCAG A/AA accessibility checks on three languages.

The workflow runs for relevant PRs/merges, **daily** for operational monitoring, and manually when necessary. It does not publish a build or alter production data.

## Deployment

The official Pages project is `toeflhouse` and uses **Direct Upload**, not Cloudflare's native Git connection. Its public homepage, course routes, guides and admissions are served on `https://toeflhouse.pages.dev/`. The legacy compatibility layer uses a pinned immutable upstream only for retained media and student tools; this is an internal dependency, not a public address. Code merging alone **does not publish a new website**. Until a narrowly scoped Cloudflare API credential is configured in CI, only an authorized release operator should:

- Build and test the exact source SHA in a staging preview on the existing Pages project.
- Confirm all languages, course links, admissions, old tools, CMS, security headers, indexability and performance.
- Preserve the current 25-file static manifest and existing Pages Functions D1 binding.
- Publish the tested Worker to the **existing** Pages project's `main` branch.
- Verify that the canonical deployment matches the approved release SHA and use the previous deployment for rollback if necessary.

**Never** publish the separate Laravel application over this Pages hostname. Do not delete the immutable upstream pinned production assets or original CMS Workers on which existing tools still depend.

## Conversion reporting

The separate Cloudflare Workers `toefl-house-conversions` D1 tracks anonymous CTA *click counts* only. These numbers must not be reported as actual WhatsApp messages sent, answered phone calls, qualified leads or enrolled students. The legacy enquiry form is still accessible via the original tools.

## Business operations not proved by technical smoke tests

Authenticated CMS editor draft/publish/rollback, teacher schedules, real admissions handoff, owner approval, and marketing ROI need separate authorized acceptance with appropriate personnel. A passing public-site smoke test is not evidence these internal workflows were exercised.

## Next improvement opportunities

- Independent staff and admissions acceptance after change approval.
- Remove immutable upstream dependency only after recovering the full legacy Functions/auth implementation and migrating it safely.
- Validate real user mobile Web Vitals and cohort enrollment conversions, rather than inferring success from synthetic visits.

## November 18 conversion and CMS-quality improvements

- Campus address/title/teaching hours are sourced from the **currently published existing CMS** in the chosen language, with safe fallbacks.
- `Learning guides` are now discoverable from the header and footer; they are still served by the pinned legacy site.
- Public V2 CSS and JS use a combined SHA-256 content fingerprint `?v=…` in all HTML templates. Immutable browser caching no longer leaves returning visitors with stale styling after a new release.
- Only sanitized, anonymous `utm_source` and `utm_campaign` labels are carried through same-tab navigation and optionally shown in the **student-approved WhatsApp draft**; do not treat a generated WhatsApp URL as a delivered message or an enrollment.
- A real synthetic student flow is checked on a read-only preview: course page → selected TOEFL program → online/afternoon enquiry → intercepted WhatsApp message, in all three languages. **No message is sent.**
- The Lighthouse lab baseline (18 Nov 2026, mobile): English homepage 100 performance; Dari homepage 99; Dari admissions 100; these are synthetic scores, not real-user country/connection metrics. Source: `cloudflare/site-v2/lighthouse-baseline.mjs`. Repeat weekly through GitHub Actions.
- Never use a fixed preview as permanent source of truth. Each release must compile current `main`, deploy to a unique Preview, and test the exact same candidate before production promotion.

### Remaining honest acceptance limits

- No authenticated end-to-end CMS draft/save/publish/restore tests have been done using staff accounts.
- No evidence of real learner conversion, actual WhatsApp send/response, Google ranking improvement or signed staff approval is implied by public-site smoke tests.
- The current public Worker still transparently proxies the old pinned CMS/auth infrastructure. A full standalone extraction/migration must not proceed without a clean, independently tested backup and role-based acceptance.
