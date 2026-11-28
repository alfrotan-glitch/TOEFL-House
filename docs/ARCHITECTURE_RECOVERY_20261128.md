# Architecture recovery decision — 28 November 2026

## Decision: incremental, test-led refactoring

Use **A: incremental refactoring**, with small, controlled modular extraction (B) where dependency boundaries and regression tests are known. Do **not** pursue C, a clean rebuild, at this stage: feature parity is not demonstrated and the original legacy CMS/auth runtime, its dependencies, deployed assets and operational recovery have not all been recovered. Historical Git branches and commits are not themselves runtime complexity. This decision is reversible after a complete dependency and parity audit.

## Evidence and boundaries

- The canonical public Pages site is a composed server-rendered Worker: `site-v2/build.mjs` assembles the edge layer, page renderers, trilingual copy, CSS and client JS. Public data is read from `CMS_DB`, with a reviewed fallback; `LEGACY_CMS`/`ASSETS` are distinct runtime dependencies. Existing Pages assets and the 25-file historical manifest must not be removed based on static searches alone.
- The Laravel/PHP/PostgreSQL management system is a **separate application**, not the Pages site's build target. `composer.json` declares PHP 8.2 and Laravel 12 plus development tools. The environment used for this iteration has no PHP or Composer, so its application behavior, dependencies and tests were not independently qualified. Do not discard its patch, migrations or operations scripts as dead code.
- Public renderers contain extensive static locale data and large templates; CSS is one shared, nearly budget-full stylesheet, with multiple breakpoint layers. These are real maintenance risks. A phased extraction should first preserve byte/behavioral tests and establish ownership of CSS tokens, locale strings, routes and CMS fields; source length alone does not establish dead code.
- `CONTRIBUTING.md` maps current ownership. Dated audit/release reports are evidence at their date, not authoritative current deployment metadata. Published business facts require authorized institutional review; code and CMS are not automatically proof of current accuracy.
- The GitHub workflow API registered 92 workflows while this checkout contains 44 workflow files. These numbers are not a reason to remove 48 workflows: other branch refs, external workflow dispatches and historical release attestations remain dependencies to examine. A current workflow (`vendor-persian-font.yml`) writes directly to `main` if its path changes; its controlled replacement requires coordination and a safe transition, not an unreviewed deletion.

## PR reconciliation

- **#56:** original trilingual English exercise was ported from its existing source (head `d47e51e7fdd083b6b19552a0f8be3882423d5614`) onto this branch, then refined for touch targets, RTL isolation and local candidate browser testing. The original PR remains open and untouched; avoid merging both copies. Coordinate disposition after validation. This port is not yet a production deployment.
- **#58:** four trilingual textbook guides (12 routes) remain valuable but conflict with `main` and overlap #56 in General English. They require reconciliation of the 39→51 route expectations across existing CI, publisher/content validation, exact preview and performance checks. No duplicate library was created.
- **#60:** prepared showcase depends on two owner-supplied images absent from that branch. Preserve the real campus image, the existing feature branch, and #60's base branch; do not publish a substitute or characterize a rendering as a photograph.
- **#61:** reproducible Worker and honest sitemap metadata are retained in this candidate. The merged-branch cleanup decision is independent of this PR.

## Candidate browser qualification

The candidate test (`cloudflare/site-v2/candidate-browser.cjs`) loads the compiled Worker itself into a browser request interceptor, permits only GET/HEAD and blocks external requests. It uses synthetic public CMS content, the repository's licensed font and no production bindings; production images and legacy services are intentionally unavailable. It is **not a Cloudflare Pages preview** and cannot certify real bindings, asset parity, deployment behavior, field performance or an entire WCAG standard. The quality workflow downloads the exact Worker artifact built by its preceding job for this browser check; that is not proof that any Cloudflare deployment uses it.

In this iteration it checked all 39 sitemap routes at 320, 390, 768, 1024, 1440 and 1920 CSS pixels (234 route/viewport combinations), keyboard navigation at 768, 1024 and 1200, and all three practice locales with and without JavaScript. An axe audit of the practice component reported no violations in those three locales. At 1024px the preceding candidate overflowed by 105px; the header breakpoint was corrected. Screenshots are browser evidence of the isolated candidate, not evidence of actual production imagery or manual screen-reader testing.

## Next safe steps

1. Preserve an exact candidate artifact/hash, and arrange an authorized **unique read-only Cloudflare preview** with the original static manifest and bindings. Test every sitemap route, business flow, real imagery, multilingual keyboard/screen-reader behavior, security and performance without sending applications or modifying data. Verify uploaded bytes and production only after approved promotion.
2. Resolve #56/#58 overlap and stale fixed-count acceptance before adding 12 routes; validate all relevant course and language links. Obtain missing #60 assets from the owner and verify rights, labeling and sizes.
3. Build an authoritative workflow matrix including owners, required check names, triggers, other-ref variants and external dispatch/deployment dependencies. Replace unsafe direct-to-main automation only through a reviewed transition. Keep existing checks until equivalent replacements have actually passed.
4. GitHub reports a failing Vercel deployment status. Current documentation identifies Cloudflare Pages Direct Upload as canonical, but Vercel deployment logs, project settings and external consumers were not available in this environment; necessity is not conclusively established. Do not disable the integration without authorized review.
5. Inspect duplication, business rules, configuration, design tokens and language content per module; extract only where behavioral and security regression tests cover the affected boundary. Do not claim comprehensive dead-code detection or architectural consolidation yet.
