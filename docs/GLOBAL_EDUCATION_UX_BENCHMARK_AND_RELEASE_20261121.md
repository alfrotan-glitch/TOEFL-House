# The TOEFL House — World-class educational UX benchmark and verified release

**Review date:** 21 November 2026  
**Canonical website:** https://the-toefl-house.pages.dev/  
**Production Pages deployment:** `30f25c42-be07-4c73-9acd-86a4e6518c54` — `production`, Cloudflare stage `success`  
**Exact deployed source SHA:** `75b07cff77b776e170774295fee8bad1185afac8`  
**Previous known-good production:** `d97b2a0f-68d9-41a5-9e11-95492d43b8ec` (source `a3170c885a9d9f0862c90c9ad41522eea6f4fff2`)

## Scope and principle

A globally competitive school website succeeds by helping a real prospective learner understand the choices, find the right course and ask admissions for accurate information. Attractive visuals are necessary but insufficient. This change prioritizes useful course discovery, local-language comprehension, trustworthy claims, mobile interaction, accessible navigation, measured engineering quality, and safe releases.

This site **has not** been independently ranked as the world's best website, and we do not make that marketing claim.

### External benchmarks, not sites to copy

- **Harvard Division of Continuing Education Course Browser:** course discovery is organized by user interest, topic, study mode and program. See https://coursebrowser.dce.harvard.edu/ and https://coursebrowser.dce.harvard.edu/courses/ . We adapted the *goal-first choice* principle for a six-program Kabul English school without copying Harvard's visual assets or content.
- **British Council LearnEnglish:** learners are directed to activities through purpose, skill, self-assessed level and English-level tests. See https://learnenglish.britishcouncil.org/free-resources/listening and https://learnenglish.britishcouncil.org/free-resources/writing . We retained the center's **free placement assessment** but explicitly distinguished it from **paid courses**, unlike the Council's free self-study materials.
- **Google/web.dev Web Vitals:** LCP good ≤2.5 s, INP good ≤200 ms, CLS good ≤0.1 at the 75th percentile of real visitor page loads; mobile and desktop measured separately: https://web.dev/articles/vitals . These are **future field-measurement targets**, not metrics achieved or measured by this release.
- **WCAG 2.2:** keyboard navigation, accessible labeling, focus/scroll visibility, mobile reflow, contrast and pointer targets: https://www.w3.org/TR/wcag/ . Automated audits exclude certain human-only accessibility defects; accessibility is not claimed to be universally certified.

## Directly implemented design and content system

1. **Goal-first discoverability** near the six real programs. Four localized, concise, visible navigation choices lead to the corresponding course cards: General English, Special Speaking, Academic English, and TOEFL Preparation. The remaining two program cards (Professional Writing and Teacher Training) remain displayed and fully reachable; no courses are filtered out or hidden.
2. **EN / Afghan Dari / Pashto native copy**, including goal titles, supporting explanation, and action labels. Dari uses terminology such as `سطح`, `صنف`, `پوهنتون`, and the exact local public brand `تافل هوس`.
3. **Keyboard-compatible native hash navigation**, plus target-card emphasis and scroll padding so the previously released sticky header does not obscure the selected item. Goal links require no new JavaScript and continue to work with JS disabled.
4. **Mobile 320px readability** of program links and brand wordmark; clear 44px high touch areas, single-column reflow on compact phones and two columns where space permits.
5. **International SEO**: page-specific canonical and `hreflang` EN/FA-AF/PS-AF plus `x-default` English fallback on course, guide and admissions subpage templates.
6. **Existing user paths preserved**: home, all six programs, online individual classes, admissions/WhatsApp draft, authentic original learning tools, editorial guides, CMS public read-only content, languages and prior artwork.
7. **Original assets and connected systems preserved**: Cloudflare Pages Direct Upload project, all 25 original asset hashes, `CMS_DB` production binding, no schema migrations, no authenticated CMS writes, no test WhatsApp sends, no enrollment data changes.

### Exact verified engineering evidence

- [Source quality gate — all jobs passed](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44847991185). Exact release source: 51 site tests, 16 Edge tests, 7 analytics tests, built Worker and syntax checks, live-public security/content checks, automated WCAG A/AA audit, public CMS content snapshot.
- [EAP browser acceptance](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44847991155) — passed.
- [Real Cloudflare preview goal-selection acceptance](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44848139455) — passed. Homepages in EN/FA-AF/PS-AF at 320, 390, 768, 1440px plus the nine course-to-admissions paths, on the exact compiled Worker. Verifies four goal links, all six cards retained, clicking a goal lands on a highlighted card beneath the sticky header, no horizontal overflow, real logo rendering, responsive menu, keyboard Escape, serious/critical automated WCAG issues and program selection in admissions.
- Preview `9328336a-0233-4480-932c-fcf4e1179e6e`, source `75b07cff77b776e170774295fee8bad1185afac8`, stage `success`.
- **Identical compiled Worker** deployed to production, exactly **284,456 UTF-8 bytes**, client style version `9d49a58d9b4d`, served compact CSS **69,859 bytes**, lightweight client JS **7,253 bytes**. This confirms size/composition, not a simulated real-user Core Web Vitals speed score.
- Latest Cloudflare `production` deployment `30f25c42-be07-4c73-9acd-86a4e6518c54` independently verified `success` with 25 original asset entries and D1 binding.
- Post-release real-browser acceptance must be recorded against its actual completed GitHub Actions run ID; do not infer it from Preview results.

## Professional risk register — do not claim completed

### P1 — Official TOEFL trademark, affiliation and brand review

ETS's published third-party guidelines state that ETS trademarks **must not be incorporated in independent company/brand names, domain names, site names or other identifiers without authorization**, and uses must not imply sponsorship or endorsement: https://www.ets.org/legal/trademarks.html . The existing identity **THE TOEFL HOUSE** predates this change and potentially requires professional intellectual-property review or permission. **We did not rebrand, remove the owner's logo or assert ETS affiliation.** The owner should consult qualified legal/trademark advice and ask ETS about compliant ongoing use. The independent TOEFL Preparation content should not imply an official ETS testing-center role unless documented.

### P1 — Production data recovery and authorisation

The existing D1 `CMS_DB` binding is preserved, but **independent encrypted private DB export plus isolated restore is not demonstrated**. Authenticated Owner/Editor draft, edit, publish, media upload and restore scenarios likewise remain unqualified by anonymous public checks. Do not remove historic auth/CMS dependencies or roll back live data without an approved recovery procedure. Code rollback should target the previous Pages code deployment only.

### P2 — Accurate public school facts

Keep teacher credentials, accreditation/affiliations, achievement counts, intake availability and program fees sourced from the center's approved records. Known Special Speaking: 2 months, AFN 2,000 for the complete semester, own Master Speaking and Grammar for Special Speaking books. TOEFL Preparation: 4 months, current post-January-2026 TOEFL iBT structure; **its local tuition has not yet been confirmed**. Do not fabricate an official test score guarantee.

### P2 — Actual performance and outcomes

Real-user LCP/INP/CLS (75th percentile), screen-reader/manual accessibility testing, real mobile networks in Kabul, search indexing/rankings, click-through rates, qualified admissions conversations and enrollments have **not** been measured by this source release. Cloudflare Web Analytics, Search Console and reception-level non-sensitive aggregate reporting are needed to substantiate claims. WhatsApp link creation is **not** an enrollment, and viewing a prefilled WhatsApp draft is **not** proof the message was sent.

### P3 — Ongoing content and assets

Review course texts/editions each semester; confirm EAP Level 4 listening text rather than inventing a nonexistent fourth-edition Contemporary Topics 4. Confirm third-party photo, brand logo and textbook figure usage rights. Keep the Qaws 1405 enrollment announcement current; do not leave a past semester promotion indefinitely after a new intake supersedes it.

## Rollback record

Previous production code deployment: `d97b2a0f-68d9-41a5-9e11-95492d43b8ec`. Restore via approved operator action only if serious regression requires it. **Never treat code rollback as permission to roll back D1 or delete historic CMS/auth workers.**

## Conclusion

The new goal-first experience is published, source-tested, real-browser-preview-tested and verified as a successful production deployment. It is a concrete improvement aligned with established education-site patterns, not evidence of a worldwide ranking or complete compliance/operational certification.
