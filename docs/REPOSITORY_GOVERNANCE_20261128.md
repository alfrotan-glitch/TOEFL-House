# Repository governance and inventory — 28 November 2026

Snapshot only; requery before taking action. This inventory is a non-destructive census, not proof that any branch, commit, workflow, dependency, or deployment is safe to delete. Commit ancestry is not proof that a squash-merged change is absent or present. Branch activity and ownership require coordination with maintainers and agents.

- Observed main `91a6cdaa14df239d9fdb464f4d405df051e20ff7`. The complete fetched graph was no longer shallow: 1229 reachable commits across all local refs, 754 on main and 475 reachable only outside main. This is a graph census, not a manual content review of every commit.
- GitHub API: 133 remote branches, 59 pull requests (4 open, 45 merged, 10 closed without merge); 92 registered workflows. Current checkout has 44 workflow files. API entries absent from the checkout may represent workflows registered from other refs or historical paths; do not assume they are disabled or redundant.
- GitHub listed 678 deployment records (498 Preview, 180 Production). These are GitHub deployment records, not proof of a successful Cloudflare Pages release or its current bindings. Recent runs queried during the snapshot showed no non-completed runs among the latest 100; this does not establish that no external release or agent is active.
- GitHub branch listing reported `main` as not protected; branch protection detail returned HTTP 403. The rules/branches endpoint returned an empty array, but that is not a complete substitute for administrative protection/ruleset visibility. Repository metadata reported auto-delete merged branches disabled. Neither setting was changed; confirm access and existing rules before applying a policy.
- Open PR #60 targets `feature/home-editorial-redesign-20261128`, which is itself the source of merged PR #59. Preserve both sides of every open PR, even when a source has been merged elsewhere.
- Local workflow `vendor-persian-font.yml` has `contents: write` and can push directly to `main` when its workflow file changes. Before enforcing branch protection, coordinate its owner and decide whether to replace this exceptional path with a reviewed PR; do not silently disable it.
- The tracked root patch file contains changes across the Laravel application and may represent unmerged work. Its usefulness is unverified; preserve it pending owner review.

## Architecture and dependency boundaries

| Area | Purpose / safety boundary |
| --- | --- |
| `cloudflare/site-v2` | Public Pages renderer, locale copy, CSS, JS, build and browser tests. Generated `dist` is not source. |
| `cloudflare/pages-edge` | Edge routing, CMS and legacy compatibility; preserve `CMS_DB`, `LEGACY_CMS`, routing and the static manifest. |
| `cloudflare/analytics` and `cloudflare/short-alias` | Separate Workers and operational deployments, not interchangeable with the Pages renderer. |
| `cloudflare/cms-readiness` and `cloudflare/website-verification` | Read-only evidence and static manifest; legacy CMS and asset dependencies are not fully recovered. |
| `app`, `routes`, `database`, `config`, `resources`, `tests` | Separate Laravel management system; preserve schemas, workflows and business rules. |
| `.github/workflows` | Automation; audit triggers, refs, secrets, permissions, artifacts and outside dependencies before consolidation. |
| `docs` | Mix of architectural contracts, operations and dated evidence. Historical documents can conflict; do not erase them without provenance review. |

The Pages project is documented as Direct Upload; GitHub merges do not by themselves deploy it. No live Cloudflare project configuration or deployed byte identity was verified during this inventory. See `cloudflare/site-v2/OPERATIONS.md` and `docs/RELEASE_SAFETY_BASELINE_20261128.md`.

## Branch inventory

`Ahead` counts commits reachable from that tip but not from observed `main`; it is not a semantic diff and does not determine whether work is valuable. PR column includes any head/base relationship; workflow column reports literal mentions in workflow files of this checkout only, not external or other-branch dependencies. Exact duplicate tips are marked. All rows require fresh verification and explicit branch-specific approval before deletion.

| Branch | Tip | Tip date UTC | Ahead | PR relationship | Local workflow mentions | Same tip |
| --- | --- | --- | ---: | --- | --- | --- |
| `admissions-copy-cleanup-20261121` | `4a67c1c3211c` | 2026-11-21 | 0 | #29 head merged | none found | — |
| `align-pashto-ge-acceptance-20261120` | `1da0f9651d19` | 2026-11-20 | 0 | #24 head merged | none found | — |
| `arena/01a003cd-toefl-house` | `ff0dfa6fe7e7` | 2026-08-15 | 2 | none | none found | — |
| `arena/01a0062e-toefl-house` | `796d98f8b725` | 2026-08-17 | 0 | none | none found | — |
| `arena/01a0151e-toefl-house` | `14b9cc844ac9` | 2026-08-20 | 0 | none | none found | — |
| `arena/01a01dc0-toefl-house` | `810ac1c25794` | 2026-08-20 | 0 | none | none found | — |
| `arena/01a02099-toefl-house` | `e1d91326a571` | 2026-08-21 | 0 | none | none found | — |
| `arena/01a023ff-toefl-house` | `d29554bff7a6` | 2026-08-21 | 0 | none | none found | — |
| `arena/01a0244b-toefl-house` | `381c400d7617` | 2026-08-21 | 0 | none | none found | — |
| `arena/01a0276a-toefl-house` | `102074c767bc` | 2026-08-22 | 0 | none | none found | — |
| `arena/01a0299b-toefl-house` | `3e5683dcadbd` | 2026-08-22 | 0 | none | none found | — |
| `arena/01a02a56-toefl-house` | `9370c0847410` | 2026-08-23 | 0 | none | none found | — |
| `arena/01a02d63-toefl-house` | `e2e3b01edc55` | 2026-08-24 | 0 | none | none found | — |
| `arena/01a03298-toefl-house` | `b2886a4a6906` | 2026-09-05 | 34 | none | none found | — |
| `arena/01a034c7-toefl-house` | `785c3497924c` | 2026-08-24 | 0 | none | none found | — |
| `arena/01a0356a-toefl-house` | `368eef34c3ae` | 2026-08-25 | 0 | none | none found | — |
| `arena/01a0381a-toefl-house` | `1c233dfe13ac` | 2026-08-26 | 0 | none | none found | — |
| `arena/01a03d22-toefl-house` | `423aa37d873e` | 2026-09-01 | 0 | none | none found | — |
| `arena/01a056f4-toefl-house` | `7f5e8692c881` | 2026-08-31 | 3 | none | none found | — |
| `arena/01a05cb3-toefl-house` | `eafe0c84286f` | 2026-09-02 | 0 | none | none found | — |
| `arena/01a062e3-toefl-house` | `e2c9d7c804b2` | 2026-09-03 | 0 | none | none found | — |
| `arena/01a0677c-toefl-house` | `6404e81c8408` | 2026-09-04 | 1 | none | none found | — |
| `arena/01a06c43-toefl-house` | `e19eed5bfd39` | 2026-09-06 | 0 | #2 head merged | none found | — |
| `arena/01a076d1-toefl-house` | `bbcd68915983` | 2026-09-07 | 4 | none | none found | — |
| `arena/01a07879-toefl-house` | `091ab38c9575` | 2026-09-07 | 4 | none | none found | — |
| `arena/01a07ac5-toefl-house` | `51066c25a23c` | 2026-09-07 | 11 | none | none found | — |
| `arena/ac3605a7-toefl-house` | `73a3b10e228b` | 2026-11-28 | 1 | #61 head open | none found | — |
| `chore/safe-site-upgrade-20261123` | `9bbc57804e57` | 2026-11-23 | 2 | #38 head merged | none found | — |
| `cms-readiness-and-recovery-20261118` | `8cb3b83444bc` | 2026-11-18 | 19 | #7 head merged | toefl-cms-qa-premerge.yml | — |
| `content-edit-dari-eap-editions-2026-11-20` | `22647a00d204` | 2026-11-20 | 6 | #21 head merged | none found | — |
| `content/general-english-editorial-20261127` | `038f5423b1cd` | 2026-11-27 | 0 | #55 head merged | none found | — |
| `design/eap-editorial-20261126` | `105e3d14b0fb` | 2026-11-26 | 6 | #49 head closed | none found | — |
| `design/eap-mobile-polish-20261126` | `2a273d831de9` | 2026-11-26 | 0 | #53 head merged | none found | — |
| `design/friendly-academic-20261127` | `52a2b4e10b29` | 2026-11-27 | 0 | #57 head merged | none found | — |
| `design/program-catalog-editorial-20261126` | `e603abc79463` | 2026-11-26 | 12 | #51 /base closed, #50 head closed | none found | — |
| `design/v3-signature-hero-20261126` | `105efe5edf97` | 2026-11-26 | 23 | #51 head closed | none found | — |
| `diagnose-canonical-cms-api-20261120` | `2c00f692c830` | 2026-11-20 | 1 | none | none found | — |
| `eap-curriculum-and-semester-campaign-1405` | `6d20a99fb6ba` | 2026-11-20 | 18 | #19 head merged | eap-browser.yml | — |
| `editorial-publisher-precision-fa-af-20261120` | `3912cc25b4a4` | 2026-11-20 | 6 | #26 head merged | none found | — |
| `editorial-trilingual-2026-11-20` | `0a8b1341d287` | 2026-11-20 | 0 | #20 head merged | eap-browser.yml | — |
| `feature/campus-showcase-20261128` | `ca85b3d5de2f` | 2026-11-28 | 3 | #60 head open | none found | — |
| `feature/general-english-mini-practice-20261127` | `d47e51e7fdd0` | 2026-11-27 | 6 | #56 head open | none found | — |
| `feature/home-editorial-redesign-20261128` | `2449aeebba7f` | 2026-11-28 | 0 | #60 /base open, #59 head merged | none found | — |
| `feature/trilingual-textbook-library-20261127` | `7c3cfffab00a` | 2026-11-27 | 1 | #58 head open | none found | — |
| `fix/admissions-whatsapp-url-validation-20261123` | `5b50410b4201` | 2026-11-23 | 5 | #41 head merged | none found | — |
| `fix/brand-meet-20261126` | `2ab268a45a7e` | 2026-11-25 | 6 | #43 head merged | none found | — |
| `fix/complete-public-brand-palette-20261126` | `e44c583b0824` | 2026-11-25 | 2 | #45 head merged | none found | — |
| `fix/mobile-menu-keyboard-focus-20261123` | `aec3a0563309` | 2026-11-23 | 2 | #39 head merged | none found | — |
| `fix/narrow-course-card-f50e562` | `0f99266b8927` | 2026-11-26 | 2 | #46 head merged | none found | — |
| `fix/online-admissions-consistency-20261126` | `1c6cc1e2fabc` | 2026-11-26 | 2 | #47 head merged | none found | — |
| `fix/schedule-accessibility-20261126` | `933a446adc37` | 2026-11-25 | 2 | #42 head merged | none found | — |
| `fix/v3-pashto-glyphs-20261126` | `7c8edfd64d7d` | 2026-11-26 | 0 | #54 head merged | none found | — |
| `fix/v3-truthful-image-descriptors-20261126` | `8406d0432016` | 2026-11-26 | 26 | #52 head merged | none found | — |
| `general-english-live-postdeploy-20261119` | `235b1fe2b2e9` | 2026-11-19 | 2 | #12 head merged | none found | — |
| `general-english-researched-curriculum-20261119` | `5654af3212fd` | 2026-11-19 | 13 | #11 head merged | none found | — |
| `global-ux-a11y-guides-20261120` | `52d9369e3b86` | 2026-11-20 | 0 | #22 head merged | eap-browser.yml | — |
| `legacy-cms-internal-20261122` | `ac5cb7233201` | 2026-11-22 | 4 | none | none found | — |
| `legacy-tools-public-brand-20261119` | `7d4fd9307f6d` | 2026-11-19 | 4 | #16 head merged | toefl-legacy-brand-browser.yml | — |
| `main` | `91a6cdaa14df` | 2026-11-28 | 0 | #61 /base open, #59 /base merged, #58 /base open, #57 /base merged, #56 /base open, #55 /base merged, #54 /base merged, #53 /base merged, #52 /base merged, #50 /base closed, #49 /base closed, #48 /base merged, #47 /base merged, #46 /base merged, #45 /base merged, #44 /base merged, #43 /base merged, #42 /base merged, #41 /base merged, #40 /base merged, #39 /base merged, #38 /base merged, #37 /base closed, #36 /base closed, #35 /base closed, #34 /base closed, #33 /base closed, #32 /base merged, #31 /base closed, #30 /base closed, #29 /base merged, #28 /base merged, #27 /base merged, #26 /base merged, #24 /base merged, #23 /base merged, #22 /base merged, #21 /base merged, #20 /base merged, #19 /base merged, #18 /base merged, #17 /base merged, #16 /base merged, #15 /base merged, #14 /base merged, #13 /base merged, #12 /base merged, #11 /base merged, #10 /base merged, #9 /base merged, #8 /base merged, #7 /base merged, #6 /base merged, #5 /base merged, #4 /base merged, #3 /base merged, #2 /base merged | none found | — |
| `perf/mobile-render-20261126` | `fa030bfd9652` | 2026-11-25 | 6 | #44 head merged | none found | — |
| `perf/shared-brand-asset-20261126` | `a84ac327a3dd` | 2026-11-26 | 6 | #48 head merged | none found | — |
| `production-admissions-acceptance-20261119` | `8abad5602ded` | 2026-11-19 | 4 | #10 head merged | none found | — |
| `qa/attested-7c8edfd-d49de5df` | `7a525ef08e8d` | 2026-11-27 | 1 | none | none found | — |
| `qa/brand-all-e44c583` | `4deec14bb23a` | 2026-11-25 | 3 | none | none found | — |
| `qa/brand-meet-957e7c7-20261126` | `7862f5f9e89d` | 2026-11-25 | 1 | none | none found | — |
| `qa/catalog-95db2ac` | `28da03b12d3c` | 2026-11-26 | 11 | none | none found | — |
| `qa/catalog-e603abc` | `26593487dd49` | 2026-11-26 | 13 | none | none found | — |
| `qa/dari-campus-image-optimization-d80e575` | `426b8555ba87` | 2026-11-26 | 3 | none | none found | — |
| `qa/eap-editorial-9e4f33e` | `417cf2fc6858` | 2026-11-26 | 6 | none | none found | — |
| `qa/eap-mobile-2a273d8` | `59611f05f2d9` | 2026-11-26 | 1 | none | none found | — |
| `qa/eap-mobile-perf-repeat-2a273d8` | `a5356c946c5a` | 2026-11-26 | 1 | none | none found | — |
| `qa/final-8406d04` | `973e4a0e5372` | 2026-11-26 | 25 | none | none found | — |
| `qa/final-pashto-7c8edfd` | `e05d7218dda2` | 2026-11-27 | 2 | none | none found | — |
| `qa/final-perf-confirm-8406d04` | `43d90cb8c6f4` | 2026-11-26 | 26 | none | none found | — |
| `qa/friendly-design-4577f9a` | `3a7a9a782088` | 2026-11-27 | 1 | none | none found | — |
| `qa/friendly-mobile-52a2b4e` | `4dd856fa0713` | 2026-11-27 | 1 | none | none found | — |
| `qa/full-brand-production-f50e562` | `64e3a464f508` | 2026-11-25 | 1 | none | none found | — |
| `qa/ge-editorial-9b1b2bc` | `0a87798fd2ab` | 2026-11-27 | 1 | none | none found | — |
| `qa/ge-experience-0e916bf` | `d8130f98e936` | 2026-11-27 | 1 | none | none found | — |
| `qa/ge-integrated-8daed54` | `7afa779817c7` | 2026-11-27 | 1 | none | none found | — |
| `qa/ge-premium-acc6400` | `47c1a5cd2788` | 2026-11-27 | 1 | none | none found | — |
| `qa/hero-105efe5` | `c88cff640a06` | 2026-11-26 | 24 | none | none found | — |
| `qa/hero-244b6d8` | `5e35b790d723` | 2026-11-26 | 20 | none | none found | — |
| `qa/hero-4ce1af9` | `6d2b520264b8` | 2026-11-26 | 16 | none | none found | — |
| `qa/hero-b178de1` | `789d3ba64974` | 2026-11-26 | 23 | none | none found | — |
| `qa/hero-c742e25` | `19a4cc99d363` | 2026-11-26 | 18 | none | none found | — |
| `qa/home-c683360-20261128` | `4ea06f928044` | 2026-11-28 | 1 | none | none found | — |
| `qa/home-signature-2449ae-20261128` | `3939a079de68` | 2026-11-28 | 1 | none | none found | — |
| `qa/learning-habits-038f542` | `02a5cc8cf867` | 2026-11-27 | 2 | none | none found | — |
| `qa/main-e17879a-attested-20261128` | `e90c2e47d050` | 2026-11-28 | 1 | none | none found | — |
| `qa/narrow-0f99266` | `065414185daa` | 2026-11-26 | 3 | none | none found | — |
| `qa/online-1c6cc1e` | `947a82f27405` | 2026-11-26 | 3 | none | none found | — |
| `qa/overflow-320-diagnosis` | `beae30f450ee` | 2026-11-26 | 1 | none | none found | — |
| `qa/overflow-diagnosis-f50e562` | `456a9249e97f` | 2026-11-26 | 1 | none | none found | — |
| `qa/perf-diagnose-244b6d8` | `7586c3b6f353` | 2026-11-26 | 20 | none | none found | — |
| `qa/perf-fa030bf-20261126` | `439d9fcd6571` | 2026-11-25 | 7 | none | none found | — |
| `qa/preview-39d3042-20261126` | `8458ccac681c` | 2026-11-25 | 1 | none | none found | — |
| `qa/preview-perf-7c8edfd` | `d2ef53900275` | 2026-11-27 | 1 | none | none found | — |
| `qa/production-39d3042-20261126` | `46fcd37ee061` | 2026-11-25 | 1 | none | none found | — |
| `qa/production-8ce2ca3-d49de5df` | `7752d52a347e` | 2026-11-27 | 1 | none | none found | — |
| `qa/production-brand-957e7c7` | `d4d8f39866ff` | 2026-11-25 | 1 | none | none found | — |
| `qa/production-e17879a-20261128` | `a4d7f8840513` | 2026-11-28 | 1 | none | none found | — |
| `qa/production-en-perf-repeat-d80e575` | `a36f08e472ae` | 2026-11-26 | 27 | none | none found | — |
| `qa/production-final-58fb6b3` | `251d260a15e8` | 2026-11-26 | 1 | none | none found | — |
| `qa/production-narrow-1ae0a70` | `e21f453b82fc` | 2026-11-26 | 1 | none | none found | — |
| `qa/production-online-58fb6b3` | `4a8fd9703afc` | 2026-11-26 | 1 | none | none found | — |
| `qa/production-perf-6976b58` | `0b4d78bcc95e` | 2026-11-25 | 1 | none | none found | — |
| `qa/production-v3-d80e575` | `8e7b8b45c2f1` | 2026-11-26 | 26 | none | none found | — |
| `qa/shared-brand-0e25d0c` | `467a2a95bb24` | 2026-11-26 | 6 | none | none found | — |
| `qa/shared-brand-a84ac32` | `e61574a830b5` | 2026-11-26 | 7 | none | none found | — |
| `recovery-verify-preview6-20261122` | `0c4ef0f9b95e` | 2026-11-22 | 14 | #37 head closed | none found | — |
| `repair-public-cms-read-20261120` | `a3e1d1241bb6` | 2026-11-20 | 0 | #23 head merged | none found | — |
| `restore-public-site-20261122` | `0de786eeaf69` | 2026-11-22 | 56 | #32 head merged | toefl-v2-production-quality.yml | — |
| `restore-public-site-acceptance-20261122` | `49f709a75761` | 2026-11-22 | 7 | #33 head closed | none found | — |
| `restore-public-site-asset-probe-20261122` | `2d7da7dad1a4` | 2026-11-22 | 10 | #35 head closed | none found | — |
| `restore-public-site-diagnostics-20261122` | `ef74cf319542` | 2026-11-22 | 9 | #34 head closed | none found | — |
| `semester-qaws-1405-video-homepage` | `8c99c459cbb2` | 2026-11-19 | 17 | #18 head merged | semester-video-browser.yml, semester-video-source-check.yml | — |
| `short-sitemap-tools-20261121` | `8993a51aeab8` | 2026-11-21 | 0 | #28 head merged | none found | — |
| `site-qa-no-internal-bibliography-20261119` | `76f9e0503fcf` | 2026-11-19 | 1 | #17 head merged | none found | — |
| `test/mobile-menu-focus-regression-20261123` | `3b45cb8b855d` | 2026-11-23 | 1 | #40 head merged | none found | — |
| `verify-recovery-preview-20261122` | `c5cbbed25a03` | 2026-11-22 | 2 | #30 head closed | none found | verify-recovery-preview2-20261122 |
| `verify-recovery-preview2-20261122` | `c5cbbed25a03` | 2026-11-22 | 2 | #31 head closed | none found | verify-recovery-preview-20261122 |
| `verify-recovery-preview5-20261122` | `1b2df93f584b` | 2026-11-22 | 12 | #36 head closed | none found | — |
| `visitor-copy-brand-and-navigation-final-20261119` | `8504323022c9` | 2026-11-19 | 7 | #15 head merged | none found | — |
| `website-polish-canonical-short-20261121` | `59dff0d301cb` | 2026-11-21 | 0 | #27 head merged | none found | — |
| `website-public-copy-polish-20261119` | `6052a5d6be0c` | 2026-11-19 | 3 | #13 head merged | none found | — |
| `website-published-faq-brand-cleanup-20261119` | `56845c54a05d` | 2026-11-19 | 2 | #14 head merged | none found | — |
| `website-source-control-20261117` | `b170eef62f21` | 2026-11-17 | 31 | #3 head merged | none found | — |
| `website-v2-admissions-continuity-20261119` | `f538864243d3` | 2026-11-19 | 11 | #9 head merged | toefl-v2-admissions-language-continuity.yml | — |
| `website-v2-final-polish-20261119` | `ff0b15cf6ba2` | 2026-11-19 | 6 | #8 head merged | toefl-v2-final-preview.yml | — |
| `website-v2-performance-admissions-20261118` | `c170607a8ead` | 2026-11-18 | 27 | #6 head merged | none found | — |
| `website-v2-quality-20261118` | `574126811b12` | 2026-11-18 | 14 | #5 head merged | toefl-v2-accessibility.yml, toefl-v2-quality-preview.yml | — |
| `website-v2-redesign-20261118` | `d7e6c76cb908` | 2026-11-17 | 40 | #4 head merged | toefl-v2-browser.yml, toefl-v2-design.yml, toefl-v2-detail-browser.yml, toefl-v2-final-production-navigation.yml, toefl-v2-live-browser.yml, toefl-v2-navigation-gate.yml, toefl-v2-schema.yml, toefl-v2-tools.yml | — |

## Pull request census

| PR | State | Head → base | Updated |
| --- | --- | --- | --- |
| [#61](https://github.com/alfrotan-glitch/TOEFL-House/pull/61) | open | `arena/ac3605a7-toefl-house` → `main` | 2026-11-28T06:28:58Z |
| [#60](https://github.com/alfrotan-glitch/TOEFL-House/pull/60) | open | `feature/campus-showcase-20261128` → `feature/home-editorial-redesign-20261128` | 2026-11-28T05:02:03Z |
| [#59](https://github.com/alfrotan-glitch/TOEFL-House/pull/59) | merged | `feature/home-editorial-redesign-20261128` → `main` | 2026-11-28T05:07:35Z |
| [#58](https://github.com/alfrotan-glitch/TOEFL-House/pull/58) | open | `feature/trilingual-textbook-library-20261127` → `main` | 2026-11-27T17:03:03Z |
| [#57](https://github.com/alfrotan-glitch/TOEFL-House/pull/57) | merged | `design/friendly-academic-20261127` → `main` | 2026-11-27T16:35:20Z |
| [#56](https://github.com/alfrotan-glitch/TOEFL-House/pull/56) | open | `feature/general-english-mini-practice-20261127` → `main` | 2026-11-27T16:53:38Z |
| [#55](https://github.com/alfrotan-glitch/TOEFL-House/pull/55) | merged | `content/general-english-editorial-20261127` → `main` | 2026-11-27T16:04:12Z |
| [#54](https://github.com/alfrotan-glitch/TOEFL-House/pull/54) | merged | `fix/v3-pashto-glyphs-20261126` → `main` | 2026-11-27T14:07:41Z |
| [#53](https://github.com/alfrotan-glitch/TOEFL-House/pull/53) | merged | `design/eap-mobile-polish-20261126` → `main` | 2026-11-26T15:38:13Z |
| [#52](https://github.com/alfrotan-glitch/TOEFL-House/pull/52) | merged | `fix/v3-truthful-image-descriptors-20261126` → `main` | 2026-11-26T12:15:56Z |
| [#51](https://github.com/alfrotan-glitch/TOEFL-House/pull/51) | closed unmerged | `design/v3-signature-hero-20261126` → `design/program-catalog-editorial-20261126` | 2026-11-26T12:20:39Z |
| [#50](https://github.com/alfrotan-glitch/TOEFL-House/pull/50) | closed unmerged | `design/program-catalog-editorial-20261126` → `main` | 2026-11-26T12:20:35Z |
| [#49](https://github.com/alfrotan-glitch/TOEFL-House/pull/49) | closed unmerged | `design/eap-editorial-20261126` → `main` | 2026-11-26T12:20:33Z |
| [#48](https://github.com/alfrotan-glitch/TOEFL-House/pull/48) | merged | `perf/shared-brand-asset-20261126` → `main` | 2026-11-26T05:24:46Z |
| [#47](https://github.com/alfrotan-glitch/TOEFL-House/pull/47) | merged | `fix/online-admissions-consistency-20261126` → `main` | 2026-11-26T03:50:46Z |
| [#46](https://github.com/alfrotan-glitch/TOEFL-House/pull/46) | merged | `fix/narrow-course-card-f50e562` → `main` | 2026-11-26T02:51:58Z |
| [#45](https://github.com/alfrotan-glitch/TOEFL-House/pull/45) | merged | `fix/complete-public-brand-palette-20261126` → `main` | 2026-11-25T22:38:16Z |
| [#44](https://github.com/alfrotan-glitch/TOEFL-House/pull/44) | merged | `perf/mobile-render-20261126` → `main` | 2026-11-25T22:21:21Z |
| [#43](https://github.com/alfrotan-glitch/TOEFL-House/pull/43) | merged | `fix/brand-meet-20261126` → `main` | 2026-11-25T22:09:12Z |
| [#42](https://github.com/alfrotan-glitch/TOEFL-House/pull/42) | merged | `fix/schedule-accessibility-20261126` → `main` | 2026-11-25T21:56:43Z |
| [#41](https://github.com/alfrotan-glitch/TOEFL-House/pull/41) | merged | `fix/admissions-whatsapp-url-validation-20261123` → `main` | 2026-11-23T10:21:01Z |
| [#40](https://github.com/alfrotan-glitch/TOEFL-House/pull/40) | merged | `test/mobile-menu-focus-regression-20261123` → `main` | 2026-11-23T01:28:53Z |
| [#39](https://github.com/alfrotan-glitch/TOEFL-House/pull/39) | merged | `fix/mobile-menu-keyboard-focus-20261123` → `main` | 2026-11-23T00:59:11Z |
| [#38](https://github.com/alfrotan-glitch/TOEFL-House/pull/38) | merged | `chore/safe-site-upgrade-20261123` → `main` | 2026-11-23T00:50:45Z |
| [#37](https://github.com/alfrotan-glitch/TOEFL-House/pull/37) | closed unmerged | `recovery-verify-preview6-20261122` → `main` | 2026-11-22T04:14:03Z |
| [#36](https://github.com/alfrotan-glitch/TOEFL-House/pull/36) | closed unmerged | `verify-recovery-preview5-20261122` → `main` | 2026-11-22T04:14:01Z |
| [#35](https://github.com/alfrotan-glitch/TOEFL-House/pull/35) | closed unmerged | `restore-public-site-asset-probe-20261122` → `main` | 2026-11-22T04:14:00Z |
| [#34](https://github.com/alfrotan-glitch/TOEFL-House/pull/34) | closed unmerged | `restore-public-site-diagnostics-20261122` → `main` | 2026-11-22T04:13:58Z |
| [#33](https://github.com/alfrotan-glitch/TOEFL-House/pull/33) | closed unmerged | `restore-public-site-acceptance-20261122` → `main` | 2026-11-22T04:13:56Z |
| [#32](https://github.com/alfrotan-glitch/TOEFL-House/pull/32) | merged | `restore-public-site-20261122` → `main` | 2026-11-22T04:13:06Z |
| [#31](https://github.com/alfrotan-glitch/TOEFL-House/pull/31) | closed unmerged | `verify-recovery-preview2-20261122` → `main` | 2026-11-22T04:13:55Z |
| [#30](https://github.com/alfrotan-glitch/TOEFL-House/pull/30) | closed unmerged | `verify-recovery-preview-20261122` → `main` | 2026-11-22T04:13:53Z |
| [#29](https://github.com/alfrotan-glitch/TOEFL-House/pull/29) | merged | `admissions-copy-cleanup-20261121` → `main` | 2026-11-21T11:28:28Z |
| [#28](https://github.com/alfrotan-glitch/TOEFL-House/pull/28) | merged | `short-sitemap-tools-20261121` → `main` | 2026-11-21T11:18:05Z |
| [#27](https://github.com/alfrotan-glitch/TOEFL-House/pull/27) | merged | `website-polish-canonical-short-20261121` → `main` | 2026-11-21T11:11:08Z |
| [#26](https://github.com/alfrotan-glitch/TOEFL-House/pull/26) | merged | `editorial-publisher-precision-fa-af-20261120` → `main` | 2026-11-20T10:07:06Z |
| [#24](https://github.com/alfrotan-glitch/TOEFL-House/pull/24) | merged | `align-pashto-ge-acceptance-20261120` → `main` | 2026-11-20T06:36:35Z |
| [#23](https://github.com/alfrotan-glitch/TOEFL-House/pull/23) | merged | `repair-public-cms-read-20261120` → `main` | 2026-11-20T06:29:56Z |
| [#22](https://github.com/alfrotan-glitch/TOEFL-House/pull/22) | merged | `global-ux-a11y-guides-20261120` → `main` | 2026-11-20T06:16:57Z |
| [#21](https://github.com/alfrotan-glitch/TOEFL-House/pull/21) | merged | `content-edit-dari-eap-editions-2026-11-20` → `main` | 2026-11-20T05:51:53Z |
| [#20](https://github.com/alfrotan-glitch/TOEFL-House/pull/20) | merged | `editorial-trilingual-2026-11-20` → `main` | 2026-11-20T03:31:24Z |
| [#19](https://github.com/alfrotan-glitch/TOEFL-House/pull/19) | merged | `eap-curriculum-and-semester-campaign-1405` → `main` | 2026-11-20T02:42:26Z |
| [#18](https://github.com/alfrotan-glitch/TOEFL-House/pull/18) | merged | `semester-qaws-1405-video-homepage` → `main` | 2026-11-19T18:14:32Z |
| [#17](https://github.com/alfrotan-glitch/TOEFL-House/pull/17) | merged | `site-qa-no-internal-bibliography-20261119` → `main` | 2026-11-19T14:26:06Z |
| [#16](https://github.com/alfrotan-glitch/TOEFL-House/pull/16) | merged | `legacy-tools-public-brand-20261119` → `main` | 2026-11-19T14:24:01Z |
| [#15](https://github.com/alfrotan-glitch/TOEFL-House/pull/15) | merged | `visitor-copy-brand-and-navigation-final-20261119` → `main` | 2026-11-19T14:09:35Z |
| [#14](https://github.com/alfrotan-glitch/TOEFL-House/pull/14) | merged | `website-published-faq-brand-cleanup-20261119` → `main` | 2026-11-19T09:59:00Z |
| [#13](https://github.com/alfrotan-glitch/TOEFL-House/pull/13) | merged | `website-public-copy-polish-20261119` → `main` | 2026-11-19T09:55:41Z |
| [#12](https://github.com/alfrotan-glitch/TOEFL-House/pull/12) | merged | `general-english-live-postdeploy-20261119` → `main` | 2026-11-19T05:04:58Z |
| [#11](https://github.com/alfrotan-glitch/TOEFL-House/pull/11) | merged | `general-english-researched-curriculum-20261119` → `main` | 2026-11-19T05:01:50Z |
| [#10](https://github.com/alfrotan-glitch/TOEFL-House/pull/10) | merged | `production-admissions-acceptance-20261119` → `main` | 2026-11-19T04:12:57Z |
| [#9](https://github.com/alfrotan-glitch/TOEFL-House/pull/9) | merged | `website-v2-admissions-continuity-20261119` → `main` | 2026-11-19T04:09:09Z |
| [#8](https://github.com/alfrotan-glitch/TOEFL-House/pull/8) | merged | `website-v2-final-polish-20261119` → `main` | 2026-11-19T03:42:44Z |
| [#7](https://github.com/alfrotan-glitch/TOEFL-House/pull/7) | merged | `cms-readiness-and-recovery-20261118` → `main` | 2026-11-18T03:28:35Z |
| [#6](https://github.com/alfrotan-glitch/TOEFL-House/pull/6) | merged | `website-v2-performance-admissions-20261118` → `main` | 2026-11-18T02:45:55Z |
| [#5](https://github.com/alfrotan-glitch/TOEFL-House/pull/5) | merged | `website-v2-quality-20261118` → `main` | 2026-11-18T02:01:59Z |
| [#4](https://github.com/alfrotan-glitch/TOEFL-House/pull/4) | merged | `website-v2-redesign-20261118` → `main` | 2026-11-17T22:17:33Z |
| [#3](https://github.com/alfrotan-glitch/TOEFL-House/pull/3) | merged | `website-source-control-20261117` → `main` | 2026-11-17T21:20:12Z |
| [#2](https://github.com/alfrotan-glitch/TOEFL-House/pull/2) | merged | `arena/01a06c43-toefl-house` → `main` | 2026-09-06T10:47:39Z |

## Registered workflow census

GitHub reports registration/state, not whether an automation is still necessary or currently running. `In checkout` refers only to the current branch snapshot. Investigate other refs and external invocations before changing any workflow.

| Workflow | API state | Path | In checkout |
| --- | --- | --- | --- |
| Integrated catalog and EAP preview acceptance | active | `.github/workflows/catalog-integrated-preview.yml` | no |
| Narrow-screen catalog and EAP preview acceptance | active | `.github/workflows/catalog-narrow-preview.yml` | no |
| .github/workflows/ci.yml | active | `.github/workflows/ci.yml` | no |
| Cloudflare Analytics Verification | active | `.github/workflows/cloudflare-analytics-tests.yml` | yes |
| Diagnose public CMS route on Pages hosts | active | `.github/workflows/cms-route-diagnostic.yml` | no |
| Dari campus image delivery evidence | active | `.github/workflows/dari-campus-image-optimization.yml` | no |
| Diagnose narrow viewport overflow | active | `.github/workflows/diagnose-overflow.yml` | no |
| EAP academic program — three-language browser acceptance | active | `.github/workflows/eap-browser.yml` | yes |
| EAP editorial preview acceptance | active | `.github/workflows/eap-editorial-preview.yml` | no |
| EAP mobile preview repeated Lighthouse and read-only safety | active | `.github/workflows/eap-mobile-perf-repeat-2a273d8.yml` | no |
| EAP mobile editorial exact-worker acceptance | active | `.github/workflows/eap-mobile-preview.yml` | no |
| Verify final candidate repeated Lighthouse and read-only safety | active | `.github/workflows/final-candidate-performance-8406d04.yml` | no |
| Final mobile hero integrated acceptance | active | `.github/workflows/final-mobile-hero-preview.yml` | no |
| Final integrated preview repeated Lighthouse and read-only safety | active | `.github/workflows/final-pashto-perf-repeat.yml` | no |
| Final Pashto typography and EAP exact-worker acceptance | active | `.github/workflows/final-pashto-preview.yml` | no |
| Dari font and integrated V3 preview acceptance | active | `.github/workflows/font-integrated-preview.yml` | no |
| Dari LCP and integrated V3 preview acceptance | active | `.github/workflows/lcp-integrated-preview.yml` | no |
| TOEFL House Browser Conversion Acceptance | active | `.github/workflows/pages-browser-acceptance.yml` | yes |
| TOEFL House Pages Edge Safety | active | `.github/workflows/pages-edge-safety.yml` | yes |
| TOEFL House Live Conversion Collector End-to-End | active | `.github/workflows/pages-live-collector-smoke.yml` | yes |
| TOEFL House Cloudflare preview parity | active | `.github/workflows/pages-preview-parity.yml` | yes |
| TOEFL House upgrade performance comparison | active | `.github/workflows/pages-preview-performance.yml` | yes |
| TOEFL House Production Post-Deploy Acceptance | active | `.github/workflows/pages-production-acceptance.yml` | yes |
| Compare original immutable Pages and live alias (read only) | active | `.github/workflows/pages-upstream-comparison.yml` | yes |
| Pashto glyph coverage and typography evidence | active | `.github/workflows/pashto-font-coverage.yml` | no |
| Responsive scope and signature hero acceptance | active | `.github/workflows/responsive-hero-preview.yml` | no |
| Qaws 1405 — real-browser semester campaign acceptance | active | `.github/workflows/semester-video-browser.yml` | yes |
| Semester Qaws 1405 — promotional video source acceptance | active | `.github/workflows/semester-video-source-check.yml` | yes |
| Signature hero integrated preview acceptance | active | `.github/workflows/signature-hero-preview.yml` | no |
| Signature homepage performance diagnosis | active | `.github/workflows/signature-performance-diagnosis.yml` | no |
| Diagnose 320px homepage overflow | active | `.github/workflows/toefl-320-overflow-diagnosis.yml` | no |
| Attested preview 7c8edfd — byte-identical Worker acceptance | active | `.github/workflows/toefl-attested-preview-7c8edfd.yml` | no |
| Brand and Google Meet release preview | active | `.github/workflows/toefl-brand-meet-preview.yml` | no |
| Published brand release acceptance | active | `.github/workflows/toefl-brand-production-acceptance.yml` | no |
| TOEFL House CMS Security (Anonymous / Non-mutating) | active | `.github/workflows/toefl-cms-auth-negative.yml` | yes |
| TOEFL House CMS Endpoint Inventory (No Auth) | active | `.github/workflows/toefl-cms-endpoint-inventory.yml` | yes |
| TOEFL House Legacy CMS Dependency Gate | active | `.github/workflows/toefl-cms-legacy-dependency.yml` | yes |
| TOEFL House Public CMS Recovery Snapshot | active | `.github/workflows/toefl-cms-public-snapshot.yml` | yes |
| TOEFL House CMS QA Pre-Merge | active | `.github/workflows/toefl-cms-qa-premerge.yml` | yes |
| TOEFL House — Dari typography & mobile FAQ browser acceptance | active | `.github/workflows/toefl-dari-typography.yml` | yes |
| Exact main preview acceptance — e17879a | active | `.github/workflows/toefl-exact-preview-e17879a.yml` | no |
| Final production quality verification | active | `.github/workflows/toefl-final-production-58fb6b3.yml` | no |
| Friendly academic design — exact preview acceptance | active | `.github/workflows/toefl-friendly-design-4577f9a.yml` | no |
| Friendly academic design — corrected mobile acceptance | active | `.github/workflows/toefl-friendly-mobile-52a2b4e.yml` | no |
| Full public brand preview acceptance | active | `.github/workflows/toefl-full-brand-preview.yml` | no |
| Full public brand production acceptance | active | `.github/workflows/toefl-full-brand-production.yml` | no |
| General English editorial — exact preview acceptance | active | `.github/workflows/toefl-ge-editorial-9b1b2bc.yml` | no |
| General English experience — exact preview acceptance | active | `.github/workflows/toefl-ge-experience-0e916bf.yml` | no |
| General English integrated skills — exact preview acceptance | active | `.github/workflows/toefl-ge-integrated-8daed54.yml` | no |
| General English premium — exact preview acceptance | active | `.github/workflows/toefl-ge-premium-acc6400.yml` | no |
| TOEFL House General English Exact Preview Visual & WCAG Acceptance | active | `.github/workflows/toefl-general-english-preview-acceptance.yml` | yes |
| Official homepage exact preview — c683360 | active | `.github/workflows/toefl-home-preview-c683360.yml` | no |
| Signature homepage exact preview — 2449ae | active | `.github/workflows/toefl-home-signature-2449ae.yml` | no |
| TOEFL House — Free short address production acceptance | active | `.github/workflows/toefl-house-short-alias.yml` | yes |
| Learning habits and General English — exact preview acceptance | active | `.github/workflows/toefl-learning-habits-038f542.yml` | no |
| TOEFL House — Legacy Tools Brand Browser Acceptance | active | `.github/workflows/toefl-legacy-brand-browser.yml` | yes |
| TOEFL House live-site smoke tests | active | `.github/workflows/toefl-live-site-smoke.yml` | yes |
| Narrow-screen candidate acceptance | active | `.github/workflows/toefl-narrow-preview.yml` | no |
| Online admissions candidate acceptance | active | `.github/workflows/toefl-online-preview.yml` | no |
| Production online admissions acceptance | active | `.github/workflows/toefl-online-production.yml` | no |
| Mobile performance candidate acceptance | active | `.github/workflows/toefl-perf-preview-fa030bf.yml` | no |
| Production performance and responsive acceptance | active | `.github/workflows/toefl-perf-production-6976b58.yml` | no |
| TOEFL House — Designer UX audit production browser acceptance | active | `.github/workflows/toefl-premium-ux-preview.yml` | yes |
| Exact preview 7c8edfd — read-only acceptance and performance | active | `.github/workflows/toefl-preview-7c8edfd.yml` | no |
| Production 8ce2ca3 — attested release acceptance | active | `.github/workflows/toefl-production-8ce2ca3.yml` | no |
| TOEFL House Production Admissions End-to-End Acceptance | active | `.github/workflows/toefl-production-admissions-acceptance.yml` | yes |
| Post-release production acceptance — e17879a | active | `.github/workflows/toefl-production-e17879a.yml` | no |
| Exact release preview 39d3042 | active | `.github/workflows/toefl-release-preview-39d3042.yml` | no |
| Exact release production 39d3042 | active | `.github/workflows/toefl-release-production-39d3042.yml` | no |
| Production responsive and brand acceptance | active | `.github/workflows/toefl-responsive-production.yml` | no |
| Shared brand asset acceptance | active | `.github/workflows/toefl-shared-brand-preview.yml` | no |
| TOEFL House public Pages snapshot (read-only) | active | `.github/workflows/toefl-site-public-snapshot.yml` | yes |
| TOEFL House — Special Speaking & TOEFL release browser acceptance | active | `.github/workflows/toefl-special-programs-preview-qa.yml` | yes |
| TOEFL House V2 Accessibility Audit | active | `.github/workflows/toefl-v2-accessibility.yml` | yes |
| TOEFL House Admissions Language Continuity (Exact Preview) | active | `.github/workflows/toefl-v2-admissions-language-continuity.yml` | yes |
| TOEFL House V2 Admissions and Guides Preview Acceptance | active | `.github/workflows/toefl-v2-admissions-preview.yml` | yes |
| TOEFL House V2 Real Browser Design QA | active | `.github/workflows/toefl-v2-browser.yml` | yes |
| TOEFL House V2 Redesign Safety | active | `.github/workflows/toefl-v2-design.yml` | yes |
| TOEFL House V2 Program and Admissions Visual QA | active | `.github/workflows/toefl-v2-detail-browser.yml` | yes |
| TOEFL House V2 — Exact Preview Final Acceptance | active | `.github/workflows/toefl-v2-final-preview.yml` | yes |
| TOEFL House V2 Final Production Navigation Acceptance | active | `.github/workflows/toefl-v2-final-production-navigation.yml` | yes |
| TOEFL House V2 Lighthouse Mobile Baseline | active | `.github/workflows/toefl-v2-lighthouse-baseline.yml` | yes |
| TOEFL House V2 Live Browser Final Acceptance | active | `.github/workflows/toefl-v2-live-browser.yml` | yes |
| TOEFL House V2 Production Anonymous Conversion Acceptance | active | `.github/workflows/toefl-v2-live-conversion-qa.yml` | yes |
| TOEFL House V2 Navigation Preview Gate | active | `.github/workflows/toefl-v2-navigation-gate.yml` | yes |
| TOEFL House V2 — Production Quality Gate | active | `.github/workflows/toefl-v2-production-quality.yml` | yes |
| TOEFL House V2 Production Full Acceptance | active | `.github/workflows/toefl-v2-production.yml` | yes |
| TOEFL House V2 Candidate Preview Acceptance | active | `.github/workflows/toefl-v2-quality-preview.yml` | yes |
| TOEFL House V2 Content Schema Read-Only | active | `.github/workflows/toefl-v2-schema.yml` | yes |
| TOEFL House V2 Legacy Tools Browser Acceptance | active | `.github/workflows/toefl-v2-tools.yml` | yes |
| TOEFL House — Full-brand free production address QA | active | `.github/workflows/toeflhouse-fullname-alias.yml` | yes |
| TOEFL House — Vendor licensed Persian font (one-time) | active | `.github/workflows/vendor-persian-font.yml` | yes |

## Cleanup procedure and remaining audit

1. Preserve all open PR heads and bases, `main`, managed agent branches, and any release/QA evidence until ownership and dependency checks are complete. Exact same tips are candidates for investigation only, not deletion approval.
2. For each proposed deletion, record current tip SHA, PR status, branch protection/rules, workflow and deployment references, unmerged commits and their content, agent ownership, backups/recovery, and explicit approval for that named branch. Recheck immediately before execution; stop if the tip or dependencies change.
3. Review and test branch protection with repository administrators. Required checks must be appropriate for this repository: existing live checks and historical-preview checks are not exact-candidate checks. Do not break documented operator workflows or silently grant bypass.
4. Automatic branch deletion is currently off. Before enabling, establish how the policy interacts with dependent PRs, release evidence and explicit branch-deletion approval; coordinate with active agents and maintainers.
5. Inventory deployment configuration and actual Cloudflare bindings with authorized read-only access. Audit every runtime dependency, dynamic route, database binding, external consumer and historical workflow before consolidating or removing code or dependencies. No code/dependency is classified dead from this census alone.
6. Review individual unmerged commits and PR diffs, workflow ownership and current execution patterns; agree a single authoritative document per operational concern, retain historical evidence with clear dates, and migrate only through small tested changes.
