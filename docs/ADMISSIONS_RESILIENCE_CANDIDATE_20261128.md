# Admissions resilience candidate — 28 November 2026

## Change and scope

The admissions message builder begins disabled. Once its client submit handler is installed, it is enabled and the direct-contact fallback is hidden. If scripting is disabled or the client bundle fails, the fallback explains in English, Dari or Pashto that the form selections will not be included and offers the existing WhatsApp and telephone contacts. Tests intercept every WhatsApp navigation; no enquiry is sent. Language-copy review by fluent speakers remains necessary.

When the CMS cannot be read, the existing public one-to-one online program is now included in the trilingual fallback, so its historical `online-individual-zoom` URL and admissions choice remain available and describe Google Meet. A valid CMS response that deliberately omits the program is not overridden. The header's online-course admissions links now preserve the selected program. Generic course summary cards only render fields supplied by the CMS, rather than showing empty skills or duration labels. No program details or prices were invented.

## Local candidate and checks

- Compiled Worker SHA-256 `0d0a88f81adca2f67402f0166e3ccedb6739f6438278bf252db13a51e9a1661c`, 398,906 bytes; source CSS 75,177 bytes, shipped CSS 74,975 bytes, client JS 9,765 bytes. Existing ceilings were not raised; only 1,094 bytes of Worker and 235 bytes of client-JS headroom remain.
- 124 offline Node tests passed. With synthetic CMS and intercepted networking, all 51 sitemap routes passed at 320, 390, 768, 1024, 1440 and 1920px (306 checks). Full-page initial-state axe scans on all 51 routes found zero automated WCAG 2/2.1 A/AA violations. The three admissions locales were checked for online-format enforcement, language switch state and intercepted message content, as well as no-JavaScript and blocked-client-script fallbacks. Automated checks are not a complete WCAG 2.2 AA audit.
- A separate fallback test requests all 51 sitemap URLs without CMS bindings and verifies the online course and admissions choice in all three languages. The valid-CMS omission test ensures an intentional removal is not silently reversed. CMS field combinations are tested for empty and populated summary cards.
- Compared with `de6de6d`, 252/306 initial viewport captures were byte-identical. All 54 changes correspond to the three generic course routes in three locales across six widths; their synthetic fixtures omit skills, so the empty label disappears. Full-page comparison: 81/102 identical, 18 intended course changes and three homepage differences (dynamic video-frame rendering). Screenshots under `.sandbox/visual-journey/`, `.sandbox/fullpage-journey/` and `.sandbox/journey-screenshots/` are local fixtures, not production images; course titles/durations in them are synthetic.
- Local Lighthouse 12.8.2 admissions samples for English/Dari/Pashto: performance 100/99/99, accessibility and best practices 100, LCP 1.44/2.04/2.03 s, CLS 0. SEO 69 because the fixture is intentionally noindex. These omit real production images/bindings and are neither production measurements nor field INP.

## Remaining release gates

No Cloudflare candidate deployment or binding/asset verification, artifact-byte comparison against a Pages deployment, production release or production database change was performed. Vercel access and failure remain unresolved. The fixture cannot validate real imagery, CMS editing, full user experience or assistive technology. Site-wide visual and educational completion, authentic owner-approved images, manual language/accessibility review and deployment verification remain open. Do not merge or release based on these checks alone.
