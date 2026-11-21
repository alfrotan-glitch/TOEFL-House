# TOEFL House — UX/UI Design Audit and Release Review
**Date:** 21 November 2026 · **Languages:** English, Afghan Dari, Pashto · **Scope:** public school site and course-to-admissions journey

## Executive assessment

The public site has a recognizable red-and-white brand, real campus photography, a six-course catalog, a goal-first chooser, live program content in three languages, course detail pages, and a short WhatsApp-driven admissions path. The most significant current design issue observed in source was a **misleading visual hit area**: each program is presented as one cohesive card, yet only the small “View program” text was clickable. The new candidate makes the entire surface of all six cards a native hyperlink target, avoiding extra JavaScript.

Other minor defects found: verbose course card headings and weak campus-photo alternative text. Social sharing pages also lacked an explicit per-language Open Graph locale. These have been corrected in source.

This is a professional design QA assessment, **not** an independent claim of being the world's top educational website. No unmeasured SEO rankings, Core Web Vitals, conversion uplift, or complete CMS recovery status is claimed.

## Evidence-based audit

| Dimension | Finding | Priority / action |
|---|---|---|
| Brand identity | Main palette and authentic campus images are coherent; logo appears small on 320px phones but is recognizable. | Preserve the genuine center logo and red/white palette; no generic stock replacement. |
| Visual hierarchy | Hero is clear, though tall on narrow phones. Primary free-placement CTA is visible in the existing 320px screenshot. | Keep effective contrast; assess real visitor scroll/click data before compressing the hero. |
| Course choice | Four goal-first choices point to the correct cards, but only the small link within each course card was clickable. | **Fixed:** native anchor covers entire card; focus states and hover preserved. |
| Editorial typography | Raw CMS headings can be verbose and inconsistently long in course overview cards. | **Fixed:** curated short titles used on summary cards; complete names and curricula remain on detail pages. |
| Multilingual UX | Dari and Pashto are properly right-to-left. Native language links and admissions labels exist. | **Fixed:** OG locale per EN/FA-AF/PS-AF and localized campus alt; continue human language QA. |
| Media accessibility | Campus photo alternative text previously contained only the neighborhood rather than describing the depicted image. | **Fixed:** meaningfully described actual campus photo in all three languages on home/admissions. |
| Pointer accessibility | Tiny text link was technically clickable but did not match the visual card's apparent action. | **Fixed:** full-card hit target. WCAG 2.2 has a 24×24px AA minimum with exceptions; 44×44 is enhanced guidance. |
| Keyboard accessibility | Semantic links, visible focus, Escape-closing mobile menu and skip link already exist. | Preserve; manually test screen readers NVDA/TalkBack with staff. |
| Enrollment clarity | Mobile admissions now appears in first viewport and explicitly distinguishes the free assessment from tuition. | Keep accurate monthly vs semester fees and no invented TOEFL tuition. |
| Course accuracy | GE AFN 500/month; EAP AFN 1,000/month; Special Speaking AFN 2,000/two-month semester; TOEFL Prep 4 months, price unknown. | Periodically review written material, books and tuition with Owner before publishing changes. |
| Trust proof | CMS displays lifetime graduate/TOEFL/admissions counts. | **Open:** validate figures against dated records and obtain permission for any testimonials, photos and credentials. |
| Structured data | Six actual curriculum courses are expressed in schema.org Course/ItemList; online one-to-one is a format, not a seventh course. | Validate Search Console indexing and Google's rich-result eligibility; markup does not guarantee ranking. |
| Social previews | OG image/title and canonical URL exist; explicit image description and language metadata needed. | **Fixed:** appropriate OG locale for all home, course and admissions pages; sample-share test still recommended. |
| Performance | Lightweight client JS and locally hosted fonts; scripts are deferred, hero imagery responsive; production Worker and CSS have fixed size budgets. | **Open:** field LCP, INP, CLS on Kabul mobile networks; compare real users, not screenshot durations. |
| Conversion measurement | Website can prepare a WhatsApp conversation; no personal data stored by the form. | **Open:** reception must verify actual received leads and registration outcomes; do not count draft clicks as enrollments. |
| Operational resilience | 25 legacy assets and production CMS_DB binding preserved in controlled Pages releases; previous production available for code rollback. | **Open:** staff-role authentication, CMS publishing and independent encrypted D1 export / isolated restore acceptance. |
| Legal/trademark | Name “THE TOEFL HOUSE” uses an ETS trademark; separate institutional affiliation/authorization is not established. | **Open:** qualified trademark review before asserting official affiliation or considering a brand-name change. |
| Semester freshness | Qaws 1405 campaign is currently present. | Renew when intake ends; do not market a past intake as currently open. |

## Changes in current design candidate
- `cloudflare/site-v2/site.css` — positioned course card and full-card click surface via existing native link's `::after`; hover and keyboard focus remain.
- `cloudflare/site-v2/landing.mjs` — concise locale-aware six course headings, actual campus ALT copy, home social OpenGraph locale.
- `cloudflare/site-v2/detail.mjs` — descriptive campus image ALT and native locale social metadata on course/admissions.
- `cloudflare/site-v2/tests/landing.test.mjs` — regression for localized headings, social metadata, ALT and link hit area CSS.
- `cloudflare/site-v2/premium-ux-browser.cjs` — real-browser full-card mouse action and full-page screenshots for mobile/desktop, along with existing 21 responsive/RTL/admissions scenarios.

## Acceptance and safe release requirements
1. All source compile, multilingual, Edge, analytics and automated accessibility CI gates pass.
2. Exact code deployed to non-indexed Cloudflare preview; 25 original asset hashes retained; CMS_DB preview binding unchanged.
3. Desktop and mobile screenshots, horizontal-overflow tests and human-readable copy inspected; card-body clicks reach the matching detail page on all three language routes.
4. If preview is good, deploy the **exact same qualified Worker** into Direct Upload Production; confirm status `success`, CMS binding, no asset deletion and preservation of previous production.
5. Re-run the same real-browser test suite against the canonical production domain; store screenshots and provide direct evidence.
6. Do **not** claim auth-CMS private restore, business conversion, speed ranking or legal authorization unless separately proven.

## Operational design principles
Maintain Afghan Dari terminology, protect real brand identity and student privacy, keep tuition wording exact (monthly versus semester), prefer readable content and authentic media over heavy visual effects, and version all changes with an executable regression and rollback path.

## Production closure — verified

- **Exact released Worker source:** `d16e1d5779a166fb809baa930f6f70b283aa59b6`.
- **Cloudflare Pages production deployment:** `bbb81b8c-1a5d-4e9e-b5a3-6a37b5be5dcf` — environment `production`, latest stage `success`. The preceding production deployment `2d2db382-3ff7-4a7e-a801-0ac8a2f35849` remains available for code rollback.
- **Build parity:** 291,694 UTF-8 Worker bytes, asset revision `e413653b6596`, served CSS 71,051 bytes, client JS 7,834 bytes; exact results matched CI.
- [Complete production quality gate](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44857699298) — success. 54 website tests, 16 Edge tests, 7 analytics tests, automated WCAG audit, public content/security checks and public-only CMS snapshot.
- [Real-browser preview acceptance](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44857488118) — success; tests 12 homepage locale/viewport combinations plus 9 course-to-admissions paths, including clicking the main tile itself.
- [Real-browser post-deployment production acceptance](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44857869320) — success, same 21 browser scenarios on the canonical domain. Archived 15 screenshots, including complete-page Dari mobile and desktop views.
- Production API independently checked exactly **25 retained static assets**, the active `CMS_DB` D1 binding and successful source SHA. No database writes or authentication admin changes were made.
- Production source and latest GitHub main can differ after documentation/QA-only commits because this Pages project is **Direct Upload**; use the source SHA above to identify actual production code.

**Scope note:** Passing automated design/browser tests does not prove real-user conversion uplift, independent database recovery, manual assistive-technology certification, or legal brand ownership. These remain explicit open items.
