/**
 * The official TOEFL House logo, as a component.
 * ============================================================================
 * The one way to render the logo on screen. It reads the asset path from
 * src/config/branding.ts, so no component ever hardcodes a logo URL and a
 * rebrand touches a single file.
 *
 * Never substitute an icon, an initial, a coloured circle or a redrawn mark
 * for this component — printed student ID cards used to show a hand-made "TH"
 * circle because no shared logo component existed.
 */
import { BRAND_LOGO_URL, BRAND_NAME, BRAND_SLOGAN } from '../../config/branding';

interface BrandLogoProps {
  /** Rendered height in pixels. Width always follows the logo's aspect ratio. */
  height?: number;
  className?: string;
  /** Show the official slogan beneath the logo. */
  withSlogan?: boolean;
}

export function BrandLogo({ height = 40, className = '', withSlogan = false }: BrandLogoProps) {
  return (
    <div className={`flex flex-col items-start gap-1 ${className}`}>
      <img
        src={BRAND_LOGO_URL}
        alt={BRAND_NAME}
        height={height}
        style={{ height, width: 'auto', objectFit: 'contain' }}
        // The logo is decorative-adjacent branding; a broken asset must never
        // collapse the layout of an invoice or an ID card.
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
      />
      {withSlogan && (
        <span className="text-[10px] font-semibold tracking-wide text-slate-500">{BRAND_SLOGAN}</span>
      )}
    </div>
  );
}

export default BrandLogo;
