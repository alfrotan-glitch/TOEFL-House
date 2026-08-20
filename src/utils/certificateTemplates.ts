import QRCode from 'qrcode';
import { Student } from '../types';
import { BRAND_NAME, BRAND_NAME_DARI, BRAND_SLOGAN, brandLogoAbsoluteUrl } from '../config/branding';
import { openPrintDocument, type PrintDocumentOptions } from '../design-system/print';

export type PrintLang = 'en' | 'dari';

/** Brand rose palette (the only brand accent — with white and black text). */
export const BRAND_ROSE = '#e11d48';
export const BRAND_ROSE_DARK = '#9f1239';
export const BRAND_ROSE_DEEP = '#4c0519';

/** Card contact + identity design. Photo is a data URL from the uploader. */
export interface IdCardDesign {
  primaryColor: string;
  bgStyle: string;
  customMotto: string;
  showQrCode: boolean;
  photo?: string | null;
  officePhone?: string;
  whatsapp?: string;
  socials?: { facebook?: string; instagram?: string; website?: string };
}

function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Student ID card print — brand rose + white + black, with photo, real QR
 *  (verification/tracking), office phone, WhatsApp and social handles.
 *  Default English; pass lang: 'dari' for local copies. */
/**
 * Builds the student ID card as print-document options.
 *
 * Separated from opening the window so the card can be asserted in a test; a
 * popup cannot be reviewed by eye. Paper is `card` — the card is laid out on a
 * sheet the operator cuts — and the page rule comes from the print authority.
 * With no `@page` at all, paper size and margins are whatever the browser
 * chooses.
 */
export async function buildStudentIdCardDocument(
  student: Student,
  design: IdCardDesign,
  lang: PrintLang = 'en'
): Promise<PrintDocumentOptions> {
  const { customMotto, showQrCode, photo, officePhone, whatsapp, socials } = design;
  const dir = lang === 'dari' ? 'rtl' : 'ltr';
  const labels =
    lang === 'dari'
      ? {
          org: BRAND_NAME_DARI,
          title: 'کارت هویت شاگرد',
          name: 'نام',
          code: 'کد',
          gender: 'جنسیت',
          registered: 'تاریخ ثبت',
          branch: 'شعبه',
          phone: 'تلفن دفتر',
          whatsapp: 'واتساپ',
          web: 'وب‌سایت',
          scan: 'برای تأیید اسکن کنید',
          male: 'آقا',
          female: 'خانم',
        }
      : {
          org: BRAND_NAME,
          title: 'STUDENT IDENTITY CARD',
          name: 'Name',
          code: 'Code',
          gender: 'Gender',
          registered: 'Registered',
          branch: 'Branch',
          phone: 'Office',
          whatsapp: 'WhatsApp',
          web: 'Website',
          scan: 'Scan to verify',
          male: 'Male',
          female: 'Female',
        };

  const gender = student.gender === 'male' ? labels.male : student.gender === 'female' ? labels.female : '—';

  // Real, scannable QR that encodes a verification/tracking URL.
  let qrDataUrl = '';
  if (showQrCode) {
    try {
      const verifyUrl = `${window.location.origin}/verify/${encodeURIComponent(student.studentCode || student.id)}`;
      qrDataUrl = await QRCode.toDataURL(verifyUrl, { errorCorrectionLevel: 'M', margin: 1, width: 220, color: { dark: '#1a1a1a', light: '#ffffff' } });
    } catch {
      qrDataUrl = '';
    }
  }

  const initials = (student.fullName || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  const photoHtml = photo
    ? `<img src="${esc(photo)}" alt="" style="width:100%;height:100%;object-fit:cover;" />`
    : `<span style="font-size:26px;font-weight:800;color:${BRAND_ROSE};">${esc(initials)}</span>`;

  const contacts: string[] = [];
  if (officePhone) contacts.push(`${esc(labels.phone)}: ${esc(officePhone)}`);
  if (whatsapp) contacts.push(`${esc(labels.whatsapp)}: ${esc(whatsapp)}`);
  if (socials?.facebook) contacts.push(esc(socials.facebook));
  if (socials?.instagram) contacts.push(esc(socials.instagram));
  if (socials?.website) contacts.push(`${esc(labels.web)}: ${esc(socials.website)}`);

  const cardCss = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, Tahoma, sans-serif; background: #f1f5f9; display: flex; justify-content: center; padding: 32px; color: #111; }
    .card { width: 360px; border-radius: 18px; background: #fff; border: 1px solid #fecdd3; box-shadow: 0 12px 30px rgba(76,5,25,0.18); overflow: hidden; }
    .head { background: linear-gradient(135deg, ${BRAND_ROSE_DEEP} 0%, ${BRAND_ROSE} 100%); color: #fff; padding: 14px 18px; display: flex; justify-content: space-between; align-items: center; }
    .head .brand { font-weight: 800; font-size: 15px; letter-spacing: 0.03em; }
    .head .title { font-size: 9px; opacity: 0.9; margin-top: 2px; letter-spacing: 0.06em; }
    .head .logo { height: 34px; width: auto; background: #fff; border-radius: 8px; padding: 3px 6px; display: flex; align-items: center; justify-content: center; }
    .head .logo img { height: 26px; width: auto; object-fit: contain; display: block; }
    .body { padding: 16px 18px; display: flex; gap: 14px; }
    .photo { width: 96px; height: 112px; border-radius: 12px; border: 2px solid ${BRAND_ROSE}; background: #fff1f2; display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; }
    .info { flex: 1; min-width: 0; }
    .row { font-size: 12px; margin: 5px 0; }
    .k { color: ${BRAND_ROSE}; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
    .v { font-weight: 700; color: #111; word-break: break-word; }
    .motto { font-size: 10px; font-style: italic; color: ${BRAND_ROSE_DARK}; margin-top: 6px; }
    .foot { border-top: 2px solid ${BRAND_ROSE}; padding: 10px 18px 14px; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .qr { width: 62px; height: 62px; background: #fff; border: 1px solid #fecdd3; border-radius: 8px; padding: 3px; flex-shrink: 0; }
    .qr img { width: 100%; height: 100%; }
    .qr-hint { font-size: 8px; color: ${BRAND_ROSE_DARK}; font-weight: 700; text-align: center; margin-top: 3px; }
    .contact { font-size: 9.5px; color: #334155; line-height: 1.6; }
    .contact b { color: #111; }
    @media print { body { background: #fff; padding: 0; } .card { box-shadow: none; } }
  `;

  const cardHtml = `
  <div class="card">
    <div class="head">
      <div>
        <div class="brand">${labels.org}</div>
        <div class="title">${labels.title}</div>
      </div>
      <div class="logo"><img src="${brandLogoAbsoluteUrl()}" alt="${BRAND_NAME}" /></div>
    </div>
    <div class="body">
      <div class="photo">${photoHtml}</div>
      <div class="info">
        <div class="row"><span class="k">${labels.name}</span><br/><span class="v">${esc(student.fullName)}</span></div>
        <div class="row"><span class="k">${labels.code}</span><br/><span class="v">${esc(student.studentCode || student.id)}</span></div>
        <div class="row"><span class="k">${labels.gender}</span> · <span class="v">${gender}</span></div>
        <div class="row"><span class="k">${labels.registered}</span> · <span class="v">${esc(student.registrationDate || '—')}</span></div>
        <div class="motto">${esc(customMotto || BRAND_SLOGAN)}</div>
      </div>
    </div>
    <div class="foot">
      <div class="contact">
        ${contacts.length ? contacts.map((c) => `<div><b>${c}</b></div>`).join('') : ''}
      </div>
      ${showQrCode && qrDataUrl ? `<div><div class="qr"><img src="${qrDataUrl}" alt="QR" /></div><div class="qr-hint">${labels.scan}</div></div>` : ''}
    </div>
  </div>`;

  return {
    title: `ID — ${student.fullName}`,
    lang: lang === 'dari' ? 'fa' : 'en',
    dir,
    paper: 'card',
    hideFooter: true,
    extraCss: cardCss,
    bodyHtml: cardHtml,
  };
}

/**
 * Prints the student ID card. Returns false when the popup was blocked, so the
 * caller can say so rather than appearing to do nothing.
 */
export async function printStudentIdCard(
  student: Student,
  design: IdCardDesign,
  lang: PrintLang = 'en'
): Promise<boolean> {
  return openPrintDocument(await buildStudentIdCardDocument(student, design, lang));
}
