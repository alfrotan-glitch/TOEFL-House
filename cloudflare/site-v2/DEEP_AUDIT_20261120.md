# The TOEFL House — Deep Technical & Editorial Audit (20 November 2026)

## Scope and evidence
This is an evidence-based, NON-DESTRUCTIVE review of the canonical Cloudflare Pages website, GitHub source, current Pages configuration, the CMS D1 database metadata, browser-rendered screenshots and the publisher catalogues. It is not approval of untested staff authentication or database recovery. No learner/employee private data, backups, credentials or CMS drafts were downloaded or changed.

- Repository: https://github.com/alfrotan-glitch/TOEFL-House
- Canonical URL: https://the-toefl-house.pages.dev/
- Project: Cloudflare Pages `the-toefl-house`, Direct Upload, production branch `main`.
- Last observed LIVE production deployment: `3140e428-b1c8-4f42-bec6-5af41e9cfe86`, at source SHA `50d0a3633d695d5ed6fe9924d15dd706642f8fd8`; Cloudflare reports `success`. The GitHub branch has newer commits; **a GitHub merge/push does not update Direct Upload production**.
- Production D1 binding `CMS_DB` points to `toefl_house_cms_production`; database metadata shows 12 tables. A D1 Time Travel bookmark is available. This is **not** evidence that an independent SQL export, encrypted offsite backup or restore drill was completed.
- Last approved source qualification immediately before this audit note: [Production Quality Gate](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44765586729) and [EAP browser acceptance](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44765586951), both green on `f6a525f8497e471e299a87fe55d4db89dcdc7f1f`.
- 22 EAP, homepage and learning-guide screenshots were inspected from the real browser evidence archive: https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44748367183

## Corrected in source
1. **Legacy anchor hijack**: Previous JS routed *every* unknown fragment on any public page to legacy tools. This broke unknown campaign fragments and future deep links. Now only known retired homepage anchors are migrated: `#start` and `#advisor` to current admissions, `#th-pathways` to current programs. Unknown fragments and subpage fragments remain on their own page. Regression tests cover all three languages.
2. **Screen-reader language navigation**: Breadcrumb navigation labels are localized for English, Afghan Dari and Pashto. Existing landmark semantics are retained.
3. **Mobile program choice**: Entire program-card area has a pointer/tap hit zone via its *existing single link*; no nested anchors, no script navigation. Existing keyboard focus remains.
4. **Bidirectional typesetting**: The EAP level index `01 — 04` explicitly has LTR direction to avoid displaying `04 — 01` on RTL pages. Book titles already use `lang=en` and `dir=ltr`.
5. Earlier source improvements from the preceding iteration remain preserved: accessible language chooser, publisher-aware textbook copy, branded multilingual social-preview metadata, legacy 503 vs canonical CMS diagnostic reporting and privacy-safe analytics.

## Editorial and publisher verification
- Cengage/National Geographic Learning documents `ACTIVE Skills for Reading`, 3rd Edition, with Intro and Books 1–4: https://cengagejapan.com/elt/Reading/page/?no=1350964597kkqpf
- Pearson's fourth-edition `Contemporary Topics` components catalogue lists Levels 1, 2 and 3, not a numbered Book 4. Do not invent `Contemporary Topics 4 (4th edition)` or ISBN: https://dev.longmanhomeusa.com/catalog/products/contemporary-topics-4e/
- Pearson documents `Longman Academic Writing` as five levels; the school's EAP course maps EAP 1–4 to Books 1–4 (edition number is **not** level number): https://www.pearson.com/languages/en-us/educators/connected-english-learning-program/adult/longman-academic-writing.html
- Before claiming EAP 4 has a specific fourth `Contemporary Topics` title, obtain an approved replacement/assigned book or materials list from the Academic Department.
- Preserve `تافل هوس` in public Afghan Dari marketing, free placement assessment as a free *assessment* (not free tuition), TOEFL preparation as FOUR months, and published CMS course information without introducing unapproved promises.

## Areas audited without unsafe changes
- Source build, JS syntax, public CMS snapshot, canonical routes, privacy protection, legacy tools, WCAG automated accessibility and EAP real-browser responsive behavior are covered by GitHub workflows. A green automated run does not prove complete manual usability or real conversion.
- The visual evidence confirms responsive English, Dari and Pashto hero layouts. The default design uses the actual school logo, red/white brand palette and RTL Arabic typography. Further visual refresh should be judged on real screenshots and A/B conversion data, not untested decorative effects.
- EAP is content-rich; for international learners, validate clarity of shift/time-zone wording with actual admissions staff before expanding the form. Current form prepares a WhatsApp draft; it does **not** mean a lead was sent, answered, enrolled or stored.
- Legacy immutable CMS/auth and marketing-overlay deployments return HTTP 503 for direct historical `/api/content` reads. Canonical V2 public content currently has its own D1-backed read-only route. Do not mistake direct historical 503 for a canonical outage, but do not infer that authenticated Owner/Editor workflows have passed.

## Required before promoting the current source to production
1. Build the **exact approved GitHub SHA** with `node cloudflare/site-v2/build.mjs`, preserving the original static manifest (25 files), `CMS_DB` and existing upstream assets.
2. Deploy that bundle only to a **unique Pages preview**, not directly over the canonical site. Preview must remain `noindex` and must not perform real CMS writes or send WhatsApp messages.
3. Run syntax, all unit tests, the 39-route canonical/navigation and sitemap tests, trilingual desktop/mobile browser accessibility, conversion privacy checks, all old /tools routes, read-only public CMS and current assets; verify no visual regression at 390px and desktop.
4. Confirm previous production deployment ID and asset manifest for rollback. Code rollback must **never** imply a D1 data rollback.
5. Promote the tested exact bundle to the existing production Pages project, with an operator who has authorized Cloudflare release access. Confirm `latest_stage.status=success`, deployed commit SHA, CSS/JS fingerprint and production page parity.
6. Separately complete authorized Owner/Editor login, create draft, publish, restore and image-upload checks. Do not delete pinned November legacy services until their source, data backup and full migration have been independently recovered and tested.
7. Validate a *private, independent* D1 export plus restore in an isolated test database; a Time Travel bookmark alone does not meet the independent recovery standard.
8. Measure actual mobile Web Vitals, inquiry count, answered WhatsApp conversations, qualified leads and enrollments; keep synthetic CTA intent events separate from those business metrics.

**Current disposition:** source-qualified; deployment to canonical is **NOT COMPLETE** for these newest changes. This note is documentation only and must not be interpreted as permission to bypass release gates.
