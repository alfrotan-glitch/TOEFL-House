/**
 * TOEFL House — the single authoritative source of brand identity.
 * ============================================================================
 * Every branded surface (screen, print sheet, receipt, invoice, ID card,
 * certificate, report, PDF, auth screen, document header) MUST read its name,
 * slogan and logo from this module.
 *
 * Before this file existed the brand was retyped as a string literal in ~20
 * components, which had already produced five different spellings of one
 * institute name ("The TOEFL House", "The TOEFL House Academy", "TOEFL House
 * ERP", …) and a hand-drawn "TH" circle standing in for the logo on printed
 * student ID cards.
 *
 * Rules:
 *   - Do NOT retype the brand name, slogan or logo path anywhere else.
 *   - Do NOT recreate, recolour, redraw or approximate the logo. There is one
 *     official asset and every surface points at it.
 *   - A future rebrand should require editing THIS FILE ONLY.
 */

/**
 * The official institute name.
 * Note the leading "The" — it is part of the name.
 */
export const BRAND_NAME = 'The TOEFL House' as const;

/**
 * The official slogan, exactly as issued. Do not alter the wording, the
 * capitalisation, or translate it.
 */
export const BRAND_SLOGAN = 'Unlock the world with TOEFL' as const;

/**
 * Dari rendering of the institute name, used by the Dari-language printed
 * student ID card. This is a pre-existing localisation requirement, not an
 * invented alternative brand: the Dari card is a functional feature and its
 * header was already localised before branding was centralised. English
 * surfaces must always use BRAND_NAME.
 */
export const BRAND_NAME_DARI = 'تافل هاوس' as const;

/**
 * The official logo, served from /public. This is the ONE canonical asset;
 * it is never duplicated per-feature.
 *
 * It is referenced by URL rather than bundled through an `import` so that the
 * same constant works in three different contexts:
 *   1. React components (<img src={...}/>),
 *   2. printable HTML written into a popup window via document.write, which
 *      has no bundler and cannot resolve a hashed module import, and
 *   3. the favicon/meta tags in index.html.
 */
export const BRAND_LOGO_URL = '/brand/toefl-house-logo.png' as const;

/**
 * Absolute logo URL, for print windows and any document whose base URL is not
 * the app origin. A printable popup resolves relative URLs against `about:blank`
 * unless it is given an absolute one, which silently produced a broken image.
 */
export function brandLogoAbsoluteUrl(): string {
  if (typeof window === 'undefined') return BRAND_LOGO_URL;
  return new URL(BRAND_LOGO_URL, window.location.origin).href;
}

/**
 * Standard brand header for printable HTML documents (receipts, invoices,
 * reports, certificates). Centralised so every printed artefact carries the
 * same official logo, name and slogan without each template re-inventing one.
 *
 * Returns a self-contained HTML fragment; callers supply their own document
 * shell and any additional styling.
 */
export function brandPrintHeaderHtml(subtitle?: string): string {
  const logo = brandLogoAbsoluteUrl();
  return `
    <div class="th-brand-header" style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
      <img src="${logo}" alt="${BRAND_NAME}" style="height:44px;width:auto;object-fit:contain;" />
      <div style="line-height:1.25;">
        <div style="font-weight:800;font-size:15px;letter-spacing:0.01em;">${BRAND_NAME}</div>
        <div style="font-size:10px;opacity:0.72;">${BRAND_SLOGAN}</div>
        ${subtitle ? `<div style="font-size:11px;font-weight:600;margin-top:2px;">${subtitle}</div>` : ''}
      </div>
    </div>`;
}
