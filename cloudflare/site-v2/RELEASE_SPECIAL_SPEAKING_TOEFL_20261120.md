# The TOEFL House — Special Speaking & TOEFL iBT 2026 public release

**Release date:** 20 November 2026  
**Canonical website:** https://the-toefl-house.pages.dev  
**Production source SHA:** `bd6763d694afc807b71d096d62524efe5138e429`  
**Cloudflare Pages deployment:** `f0881d41-f61f-4bc3-8f83-f9c4583a7656` — `production`, `success`  
**Previous production retained:** `3140e428-b1c8-4f42-bec6-5af41e9cfe86` (`50d0a3633d695d5ed6fe9924d15dd706642f8fd8`)

## Released public pages

Each URL has equivalent English, Afghan Dari and Pashto variants, using the same V2 navigation, design, canonical URL, hreflang, branded social card, keyboard navigation, responsive layout and a preselected admissions link.

- Special Speaking: https://the-toefl-house.pages.dev/fa/courses/special-speaking/
- TOEFL iBT Preparation: https://the-toefl-house.pages.dev/fa/courses/toefl-preparation/
- Admissions: https://the-toefl-house.pages.dev/fa/admissions/

### Owner-confirmed facts

**Special Speaking:** one **two-month semester**, **AFN 2,000 total semester tuition**, the **Master Speaking** textbook authored for The TOEFL House and the companion **Grammar for Special Speaking** material. Curriculum descriptions are grounded in the real school-owned book repository, not invented publisher claims.

- Verified school-owned book source: https://github.com/alfrotan-glitch/Master-Speaking
- Master Speaking has **eight thematic units**, with speaking studios, pair tasks, listening, pronunciation, discussion and presentation.
- The separate grammar-in-conversation companion has **16 lessons**.
- Physical book charges are not included or excluded from the fee without specific school approval; admissions must clarify any additional costs.
- A free placement assessment is **not free course tuition**. Individual fluency gains are not guaranteed.

**TOEFL Preparation:** **four months**. The public curriculum uses the official TOEFL iBT format **effective 21 January 2026**, covering updated task types for Reading, Listening, Writing and Speaking, adaptive Reading/Listening and a **1–6** score scale. ETS reports a comparable 0–120 overall score during the two-year transition. The public page links to the primary ETS description: https://www.ets.org/toefl/test-takers/ibt/about/content.html?version=after-jan-2026

TOEFL Preparation tuition, exact staff names, shift dates and the assigned practice-material/edition list have **not been owner-confirmed** in this release and are deliberately left to admissions/academic staff; do not invent pricing or a guaranteed official score. The school is **not represented as an ETS testing authority**.

## Evidence and non-destructive release

- Site build + 46 V2 tests, 16 edge tests, 7 analytics tests, and accessibility / production checks: [GitHub Production Quality Gate](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44769813627) — **success**.
- Existing EAP real-browser acceptance: [EAP suite](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44769813573) — **success**.
- Preview of the final compiled Worker: `c4a0365c-95e6-480d-bf47-f0edef335a4e`, SHA `bd6763d`, stage **success**.
- Preview real browser: [12 views / six pages / three languages / mobile + desktop / WCAG / no legacy regressions](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44770154523) — **success**.
- Post-production real browser: [same 12 views on canonical + public CMS + historic learning tools](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44770531739) — **success**.
- Compiled exact-release Pages Worker: **279,910 UTF-8 bytes**; CSS/JS asset fingerprint `0a12a3517558`. The production deployment was uploaded from the exact SHA and byte-count-qualified Worker, not a stale draft.
- The **25 original static asset hashes** were preserved exactly. The existing Pages `CMS_DB` production binding was retained. No CMS draft, teacher timetable, student record, enrollment submission or D1 schema was written or migrated.
- Both language-switch and keyboard interactions remain available; the original `/tools/`, `/fa/tools/`, `/ps/tools/` paths remain accessible and are `noindex`.
- Confirmed Cloudflare latest `production` deployment environment, success stage, the exact code SHA, 25-file manifest and production D1 binding after deployment.

## Honest operational boundaries

Authenticated Owner/Editor create, draft, publish, restore, media upload and an **independent private D1 export plus isolated recovery drill** still need authorised acceptance. D1 Time Travel availability is not proof of a tested independent backup. Real enquiries, answered WhatsApp conversations and enrollments need staff reporting; anonymous CTA click events are not enrollments.

**Rollback plan:** if a material code regression is confirmed, restore the previous Pages *code* deployment `3140e428-d...` through the authorised operator process. Do **not** roll back or replace the production D1 database as part of a website-code rollback. Preserve pinned historical CMS/auth deployments until the dependencies are explicitly retired after independent backup and full staff acceptance.

The new academic pages are now **publicly deployed and browser-qualified**. This release does **not** imply that unrelated authenticated CMS administration or business enrollment workflows were fully re-certified.
