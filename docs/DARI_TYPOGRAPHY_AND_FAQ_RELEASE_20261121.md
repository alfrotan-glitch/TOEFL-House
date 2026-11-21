# TOEFL House — Dari Typography and Mobile FAQ Production Repair

**Release date:** 21 November 2026  
**Requested by:** Owner, from an actual Samsung/Android screenshot of the Dari FAQ page.  
**Languages:** Afghan Dari (`fa-AF`), Pashto (`ps-AF`), English (`en`).

## Confirmed defects and evidence

1. **Mirrored or misplaced dots of Persian Peh (پ)**. The existing site loaded Noto Sans Arabic globally for both RTL locales. The production D1 Dari content does **not** contain a wrong Pashto letter: inspection of the exact published main CMS row (revision 41) found 140 authentic `U+067E` Peh characters, zero Arabic YEH `U+064A`, and zero Arabic KAF `U+0643`. The font glyph/shaping — not the Unicode text — was causing the visitor's visible problem. Noto Sans Arabic has a publicly reported issue about inverted 3-dot PEH glyphs.
2. **Wrong term for the Owner-selected Dari editorial style**. The public CMS contains terms such as “پوهنتون” and “پوهنتونی” in admissions, academic English, writing program summaries, and advisor content. They are valid in common Afghan Dari, but the Owner explicitly requested “دانشگاه” and “دانشگاهی” for this site's Dari style. Pashto “پوهنتون” remains linguistically correct and untouched.
3. **Mobile FAQ reading and anchor position**. The user's screenshot shows the headline partly behind the sticky nav, tall accordion questions with visually disproportionate spacing. Smooth-scroll and mobile header composition required refining.
4. **Low-contrast brand subtitle**. Full Chrome + axe WCAG regression uncovered a color-contrast failure on the compact 320-pixel Dari header `.brand > span > small` once the new font changed text metrics.

## Applied fixes (source code)

- **Font**: adopted **Vazirmatn 33.003**, an open-source Persian typeface under SIL OFL 1.1, self-hosted on the original Cloudflare domain via a same-origin Cloudflare Worker endpoint `/__th/v2/font/vazirmatn-33.003.woff2`. Pin SHA-256 `4e3fa217d38fdafc1fea4414ceb58ca5e662cf0ab5fa735a8c8c20e8b42cad92`, verify on fetch, cache at Cloudflare edge. Exact source is vendored in the GitHub repository with license and checksums. No external font CSS or browser third-party font request. **Only `html[lang=fa-AF]` uses THDari; Pashto retains the existing THArabic family.**
- **Terminology**: normalized published Dari-only HTML from both static labels and the live CMS via `v2DariEditorial()` at the page-render boundary, replacing `پوهنتونی → دانشگاهی` then `پوهنتون → دانشگاه`. No D1 write or CMS revision changed. Course details, academics, admissions and editorial guides render consistently. Pashto is left intact. The user-visible term is changed, but the underlying editable CMS text **still contains the original source terms**, so future editors need to align those published values after the Owner's content approval.
- **Responsive FAQ**: compact mobile section rhythm, readable text scale, balanced links and accordion spacing, and mobile no-smooth-scroll on internal anchors so the FAQ heading lands clearly under the sticky header.
- **Brand contrast**: darkened logo subtitle from `#7b8081` to `#43555b`, and increased small-screen title size from 9 to 10px.
- **Free Cloudflare aliases**: updated both lightweight read-only proxy Workers `toeflhouse.pages.dev` and `thaf.pages.dev` to serve the new same-origin font without redirects or cross-origin CSP failures. The original `the-toefl-house.pages.dev` remains SEO canonical; aliases remain `noindex` and their private CMS routes are not proxied.

## Production deployment provenance

- Original pre-release live deployment: `bbb81b8c-1a5d-4e9e-b5a3-6a37b5be5dcf`; remains available as code rollback.
- Exact repaired code SHA: `ee0eaacd3cc8365190da038f2add830277623045`.
- Worker compiled byte-for-byte matching CI: **294,625 bytes**, revision `380d1ed0b8af`, served CSS 71,857 bytes, client JS 7,834 bytes. Worker near its 296KB quality cap; further substantial UI work should first reduce bundled code.
- Cloudflare **production** deployment: `30a3ae71-ba55-4795-920c-b13e97a68005`, **success**.
- All **25 original static assets** and **production D1 CMS_DB** id `045e1972-1c49-43b1-9eba-29afc8337a8a` preserved unchanged; preview bound to isolated test D1. No migrations, admin operations or student data writes.
- Free short alias production deployments: `toeflhouse` → `0aaf9809-380f-454d-9905-bd42566f98a7` success; `thaf` → `65865729-760c-4700-b8c2-85eb67d6e8fe` success. Both Workers preserve original CMS as the only source of truth.

## Automated and real-browser evidence

- [Source full quality gate](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44867174118): **success** — 56 website/unit tests, 16 Worker tests, 7 analytics tests, CMS/security and WCAG automated checks.
- [Final approved code preview — detailed Persian font, Peh and FAQ](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44867389496): **success**. HTTPS font 200 WOFF2 and SHA256 verified; Chrome screenshots at Dari 320,390,1440 and Pashto 390; FAQ heading stays below header; no horizontal overflow or browser errors; correct words in rendered course pages.
- [Final approved code preview — full 21-case browser regression](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44867396896): **success** — English, Dari and Pashto at responsive widths with keyboard navigation and automated accessibility.
- [Live canonical font, Peh and FAQ regression](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44867672900): **success**.
- [Short alias `toeflhouse.pages.dev` HTTP and mobile Chrome acceptance](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44867650503): **success**, including exact self-origin WOFF2 hash and Dari vocabulary.
- [Short alias `thaf.pages.dev` HTTP and mobile Chrome acceptance](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44867650594): **success**.
- [Final live canonical full browser regression](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44867680102): post-production 21-case run (confirm current result before stating final status).

## Operational limits

The Peh problem was fixed by changing the font, not by substituting a nonstandard alphabetic character. Since the canonical public CMS remains unchanged, future authenticated CMS edits should standardize the source text after the Owner approves wording and verify actual role-based publishing and independent D1 recovery separately. This release does **not** certify all possible real devices, all available screen readers, or actual Kabul network performance.
