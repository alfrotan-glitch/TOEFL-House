# The TOEFL House — Premium UX Release, 21 November 2026

## Production identity and rollback
- Canonical: https://the-toefl-house.pages.dev/
- Cloudflare Pages project: `the-toefl-house` (existing Direct Upload project).
- **New production deployment:** `d97b2a0f-68d9-41a5-9e11-95492d43b8ec`, environment `production`, stage `success`.
- **Exact tested source:** `a3170c885a9d9f0862c90c9ad41522eea6f4fff2`. Later GitHub commits update QA workflow and these release notes only; they do not change deployed source behavior.
- **Previous production preserved:** `f0881d41-f61f-4bc3-8f83-f9c4583a7656` (source `bd6763d694afc807b71d096d62524efe5138e429`).
- **Pre-production candidate:** `4788848a-c8e8-4966-ac81-5039ff33ffea` (environment `preview`, stage `success`), tested against the exact same Worker.
- All original **25 static asset checksums** preserved. Existing `CMS_DB` D1 binding retained. No D1 data writes, migrations, authenticated CMS operations, genuine enrollment submissions or WhatsApp messages were performed as part of QA.

## User-facing improvements
1. Accessible **sticky** global header, so the admissions and course-navigation entry points remain available while reading long pages.
2. Compact **mobile free placement assessment** shortcut in English, Afghan Dari and Pashto; remains visible at narrow phone widths.
3. Context-preserving admissions: global desktop and mobile header buttons on the Special Speaking, TOEFL iBT Preparation and EAP course pages use an allowlisted `?program=...` parameter to preselect the same course in admissions, without collecting personal data in the URL.
4. Premium editorial finish with coherent red/white branding, more considered hero spacing, clearer course-card interactions, deeper plum-red featured TOEFL card, consistent online-learning panel and footer, focus states and contrast-aware forced-colors styling.
5. Site header works from 320px up to desktop. Menu is keyboard-operable, Escape-dismissable and bounded to the viewport height; sticky positioning remains functional after scrolling.
6. More compact delivered CSS, without erasing the readable source file in Git. The released compiled Worker is **280,887 UTF-8 bytes**, the served CSS is **68,017 bytes** (raw source CSS **70,274 bytes**); CSS/JS asset hash is `b2df3ac106b2`. This documents byte reduction, **not** an unmeasured speed-score increase.

## Verification evidence
- [Exact source Production Quality Gate](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44841845295) — success. 48 V2 unit tests, 16 edge tests, 7 analytics tests, live canonical content/security checks, WCAG A/AA automated audit and public-only CMS recovery snapshot.
- [EAP three-language browser acceptance](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44841845485) — success.
- [Preview responsive/interaction acceptance](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44841972503) — success: 3 languages × 4 widths (320, 390, 768, 1440px) on home, plus nine course-to-admissions paths. Validates sticky header, menu, real logo rendering, no horizontal overflow, localized shortcut, course selection, serious/critical WCAG checks on narrow phone and desktop. Screenshots archived.
- [Canonical production browser acceptance](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44842349307) — success, same 21 scenarios on the actual production domain.
- Cloudflare deployment API separately confirmed `production` stage `success`, source SHA, exactly 25 existing static files and the retained `CMS_DB` binding.

## Program truth and editorial boundaries
- Special Speaking: **two months**, one semester, total **AFN 2,000** tuition, **Master Speaking** and school-authored **Grammar for Special Speaking**, free placement assessment separate from course fees.
- TOEFL Preparation: **four months**, content follows the official ETS post-21-Jan-2026 TOEFL iBT format. Exact local tuition and class schedules are not invented.
- EAP: four two-month levels. Contemporary Topics fourth edition has levels 1–3: EAP 4 assigned listening text must be confirmed by the academic department before publication as a numbered 'Book 4'.
- Public Afghan Dari brand name remains **تافل هوس**, not a literal institutional translation.
- Figures, official affiliations, teacher credentials, and learning outcomes should never be embellished without evidence.

## Residual verification boundaries
- Authenticated Owner/Editor login, draft/publish/restore, image uploads and staff approval workflows still need authorised real-role acceptance. Public CMS read-only checks do not certify administrative write operations.
- No independent **private** D1 SQL backup/isolated restore was performed. A D1 Time Travel bookmark is a separate protection and does not substitute for a tested independent backup.
- No real-user field data, Core Web Vitals, actual inquiries, qualified leads or enrollments were available. Screenshots and browser-unit acceptance cannot prove conversion uplift or search ranking.
- The photograph and logo source rights/brand accuracy should be signed off by the center. Do not substitute hypothetical facilities, unlicensed images or unapproved testimonials.
- Keep pinned historical CMS/auth deployments until all migration/recovery dependencies are verified and signed off.

**Rollback:** Restore only the previous known-good Pages *code deployment* if warranted and authorised. Never roll back or mutate the connected D1 database as an implicit part of code rollback.

This release is public and browser-qualified; unrelated authenticated CMS and business workflows are not claimed to be fully accepted.
