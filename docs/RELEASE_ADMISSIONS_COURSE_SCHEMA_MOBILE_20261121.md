# TOEFL House — Admissions Conversion, Course Search Markup and Mobile UX Release

**Release date:** 21 November 2026  
**Canonical production:** https://the-toefl-house.pages.dev/  
**Release source commit:** `d8f14ef2b6a19e62240174adf016f75e59e5fddf`  
**Cloudflare production deployment:** `2d2db382-3ff7-4a7e-a801-0ac8a2f35849` — deployment stage **success**  
**Previous known-good production:** `397557f5-f870-42ef-9676-f5b4be68951c` — rollback option for code only  
**Verified production manifest:** all 25 original static asset hash entries retained; original `CMS_DB` binding connected; no authenticated CMS operations, D1 writes, schema migrations or WhatsApp sends.

## Decisions and implementation

### 1. First-screen mobile admissions, not a buried form
Actual browser screenshots of the previous mobile admissions page showed a large introduction and campus photo occupying the entire first 390×844 viewport, hiding the registration/placement program choice. The release shortens the mobile introduction, formats benefits compactly, moves the form into the first phone viewport and removes the preceding campus photo **only on mobile admissions pages**. Original campus media remains on the desktop admissions page and public homepage. The form remains readable and keyboard-accessible.

The mobile browser acceptance asserts that the form begins above 570 CSS px and the program selection appears above 844 CSS px across English, Afghan Dari and Pashto on 390px phones. It also checks 320px home views, 768px tablets, 1440px desktops and 21 total flows.

### 2. Accurate course facts before opening WhatsApp
The admissions form now reveals an accessible, live-updated duration/tuition summary when the visitor selects a course. All course metadata is fixed, public and approved program information, not personal visitor data. It is included as safely HTML-escaped `data-summary` on individual option elements and rendered via `textContent`, with no new API requests.

Owner-confirmed facts used:
- General English: Pre-Starter one month; other levels two months; tuition AFN 500/month.
- EAP: four two-month levels; tuition AFN 1,000/month or AFN 2,000/level.
- Special Speaking: one two-month semester using `Master Speaking` and separate grammar book; **AFN 2,000 for the full semester**, not monthly. Any separate material charge must be confirmed by reception.
- TOEFL Preparation: four months, updated 2026 TOEFL iBT; **no price is invented**. Admissions confirmation is explicitly required.
- Professional Writing, Teacher Training, and individual online lessons: actual course type/duration and need to confirm fees/timetable, no unapproved price claims.

The select menu uses short, readable English/Dari/Pashto labels rather than long bilingual names that were visibly clipped by the native mobile select. Switching selections immediately updates the summary. Form submission behavior remains a visitor-controlled WhatsApp draft; no student name, phone number or message is stored by this feature.

### 3. Six real course entries for Google Course list
The homepage keeps the preexisting `EducationalOrganization` JSON-LD and adds `ItemList` with **exactly six actual courses**, valid `ListItem.position`, canonical localized `ListItem.url` and nested `Course` entities with title, meaningful description, provider and URL. Individual online learning is correctly treated as a *learning format*, not invented as a seventh curriculum.

Sparse CMS descriptions fall back to truthful course-name descriptions, not fabricated achievements or test outcomes. All JSON-LD is serialized with a `<` escape so unexpected CMS text cannot break out of the script. Proper eligibility in Google Search is not guaranteed; Google documents that Course list features are currently available in English and have separate eligibility and indexing conditions. Official specification: https://developers.google.com/search/docs/appearance/structured-data/course

### 4. Code size and client limits
- Compiled Worker: **291,119 UTF-8 bytes** on qualified release SHA.
- Delivered compact CSS: **70,932 bytes**, raw source CSS remains readable in version control.
- Client JS: **7,834 bytes**; asset revision `c640b1dad3e8`.
- CI retains bounded delivery limits: Worker under 296KB, raw CSS under 74KB, JS under 10KB.
- A byte-budget exception is not a proven speed improvement. Real field CWV data remains required.

## Actual release evidence
- [Source release quality gate](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44856318283) — **success**. 53 multilingual V2 site tests, 16 Edge tests, 7 analytics tests, WCAG A/AA automated audit, public CMS/security checks.
- [EAP browser regression](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44856318282) — **success**.
- [Exact final Cloudflare preview browser acceptance](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44856410253) — **success**. Tests 12 homepage device/language combinations and nine course-to-admissions flows including verified fee switching, short translated select labels, first-screen form, accessible goal navigation, correct structured data, layout, no browser errors, and automated serious/critical WCAG checks; screenshots archived.
- [Post-production real-browser test](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44856584472) — **success**. Repeated the 21-scenario responsive, trilingual admissions, visible-first-form, approved tuition, six-course structured data and accessibility regression suite on the actual canonical domain after the final production deploy; screenshots retained as the workflow artifact.
- Cloudflare API confirms source `d8f14ef2b6a19e62240174adf016f75e59e5fddf` as latest successful **production** deployment, 25 original static files retained, `CMS_DB` still bound.
- Production Pages project uses **Direct Upload**; a later GitHub documentation or workflow commit does **not** automatically deploy altered website code.

## Outstanding final acceptance tasks — do not misrepresent as completed

1. **CMS authenticated operations and recovery:** Owner/Editor login, authorisation, content publish/restore, upload, and read-write scenarios have not had a fresh authorized human-roles acceptance. The automatic public CMS snapshot is not an independent private database export, encryption or isolated restore.
2. **Actual field performance:** Real user LCP/INP/CLS, mobile-network speed in Kabul and low-end Android devices need measurement. Synthetic browser screenshots and Cloudflare deploy success are not Core Web Vitals measurements.
3. **Real business outcome:** Track only consent-respecting non-sensitive aggregates: course-to-admissions clicks, real WhatsApp conversations received by reception, qualified inquiries, trial placements and actual enrollments. A prefilled WhatsApp draft is not a sent lead.
4. **Owner sign-off:** Confirm current course fee schedules, any material/book charges, staffing/availability, numeric success claims displayed in CMS, and photo/branding rights. Where price is unknown, continue to show an explicit request to confirm it.
5. **TOEFL trademark review:** Independent institution-name and logo usage should be reviewed against ETS trademark policies. Do not imply official ETS partnership or accreditation absent documentary permission.
6. **Renew the term-specific Qaws 1405 promotion when the semester changes.** Do not display an expired enrollment period as current.

## Rollback safety

Only an authorised operator may revert **code** to the previous Pages deployment `397557f5-f870-42ef-9676-f5b4be68951c`. Code rollback must never implicitly roll back or overwrite D1 production data; preserve historical CMS/admin dependencies. Maintain account ownership and update access controls through the normal administrative process.

## Completion standard

This release's **public website features** are source-qualified, preview-browser-qualified, successfully deployed and canonically browser-qualified. The *entire institutional operating system* (including secured CMS write flows and independent disaster recovery) is **not** claimed to have unconditional production acceptance merely because these web features pass.
