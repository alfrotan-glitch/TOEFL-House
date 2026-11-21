/**
 * Canonical public host for The TOEFL House.
 * The browser stays on toeflhouse.pages.dev; the legacy Pages origin is an
 * internal read-only content/asset source while the CMS migration is completed.
 */
const UPSTREAM = "https://the-toefl-house.pages.dev";
const SHORT_ORIGIN = "https://toeflhouse.pages.dev";
const SHORT_HOST = "toeflhouse.pages.dev";
const HTML_TYPE = /text\/html(?:\s*;|$)/i;
const BLOCKED = /^\/(?:admin(?:\/|$)|cms(?:\/|$)|login(?:\/|$)|logout(?:\/|$)|dashboard(?:\/|$)|api\/(?!content(?:\/|$))|__th\/(?!v2\/(?:site\.(?:css|js)|font\/vazirmatn-33\.003\.woff2)$|engagement-v1\.js$))/i;
const NOINDEX = /^\/(?:tools(?:\/|$)|api(?:\/|$))/i;
const POLISH_CSS = ".footer-main{gap:44px;padding:52px 0 40px}\n.footer-brand h2{font-size:27px;margin-bottom:10px}\n.footer-links{padding-top:12px;gap:12px 22px}\n.footer-bottom{padding:16px 0 18px}\n.footer-cta{margin-top:22px;min-height:46px;padding:12px 18px;font-size:12px;align-self:flex-start}\n@media(max-width:760px){.footer-main{padding:36px 0 28px}.footer-brand h2{font-size:23px}.footer-links{padding-top:20px;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px}.footer-bottom{padding:13px 0 15px}.footer-bottom span{margin:0}.footer-cta{margin-top:18px}}";
function plain(message,status=200,headers={}) {
 return new Response(message,{status,headers:{"Content-Type":"text/plain; charset=utf-8","X-Content-Type-Options":"nosniff",...headers}});
}
function canonicalPath(path) {
 if(path==="/") return "/fa/";
 if(path==="/en"||path==="/en/") return "/en/";
 return path.endsWith("/")?path:path+"/";
}
function localeFor(path) {
 if(path==="/"||path.startsWith("/fa/")||path==="/fa") return "fa";
 if(path.startsWith("/ps/")||path==="/ps") return "ps";
 return "en";
}
function admissionsCta(path) {
 const locale=localeFor(path);
 const prefix=locale==="en"?"/":"/"+locale+"/";
 const label=locale==="fa"?"درخواست تعیین سطح رایگان":locale==="ps"?"د سویې د وړیا ارزونې غوښتنه":"Request a free placement assessment";
 return '<a class="button button-primary footer-cta" href="'+prefix+'admissions/">'+label+' <span aria-hidden="true">↗</span></a>';
}
function polishHtml(html,path) {
 const canonical=SHORT_ORIGIN+canonicalPath(path);
 html=html.replaceAll(UPSTREAM,SHORT_ORIGIN);
 html=html.replace(/<link rel="canonical" href="[^"]*"[^>]*>/i,'<link rel="canonical" href="'+canonical+'">');
 html=html.replace(/<meta property="og:url" content="[^"]*"[^>]*>/i,'<meta property="og:url" content="'+canonical+'">');
 html=html.replace(/(<link rel="alternate" hreflang="en" href=")[^"]*(")/i,'$1'+SHORT_ORIGIN+'/en/$2');
 html=html.replace(/<a\b[^>]*>/gi,tag=>/\bhreflang="en"/i.test(tag)?tag.replace(/href="\/"/i,'href="/en/"'):tag);
 html=html.replaceAll("تعیین سطح رایگان · صنف‌های آموزشی دارای فیس","");
 html=html.replaceAll("تعیین سطح رایگان است؛ صنف‌های آموزشی فیس دارند.","");
 html=html.replaceAll("رایگان‌بودن تعیین سطح به معنای رایگان‌بودن صنف‌ها نیست.","");
 html=html.replaceAll("It does not make course tuition free.","");
 html=html.replaceAll("د سویې وړیا ارزونه د دې معنا نه لري چې درسي ټولګي هم وړیا دي.","");
 html=html.replaceAll("روبروی","روبه‌روی");
 html=html.replaceAll("آدرس ما","نشانی مرکز");
 html=html.replaceAll("پیدا کردن آدرس کورس","مسیریابی تا مرکز");
 html=html.replaceAll("در کابل پذیرای شما هستیم.","تافل هوس در کابل");
 html=html.replace(/<p class="semester-free">[\s\S]*?<\/p>/gi,"");
 html=html.replace(/<div class="footer-bottom">([\s\S]*?)<span>\s*<\/span>/i,'<div class="footer-bottom">$1');
 if(!html.includes("footer-cta")) {
  html=html.replace(/(<span class="footer-hours">[\s\S]*?<\/span>)/i,"$1"+admissionsCta(path));
 }
 if(!html.includes("/__th/short-polish.css")) {
  html=html.replace("</head>",'<link rel="stylesheet" href="/__th/short-polish.css?v=1"></head>');
 }
 return html;
}
export default {
 async fetch(request) {
  const incoming=new URL(request.url);
  if(incoming.hostname!==SHORT_HOST&&!incoming.hostname.endsWith("."+SHORT_HOST))return plain("Unknown hostname",421);
  const isPreview=incoming.hostname!==SHORT_HOST;
  if(request.method!=="GET"&&request.method!=="HEAD")return plain("Method not allowed",405,{"Allow":"GET, HEAD"});
  if(incoming.pathname==="/robots.txt") {
   return plain("User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /cms/\nDisallow: /login\nDisallow: /logout\nDisallow: /dashboard/\nDisallow: /api/\nDisallow: /tools/\nSitemap: "+SHORT_ORIGIN+"/sitemap.xml\n",200,{"Cache-Control":"public, max-age=3600"});
  }
  if(incoming.pathname==="/__th/short-polish.css")return new Response(POLISH_CSS,{status:200,headers:{"Content-Type":"text/css; charset=utf-8","Cache-Control":"public, max-age=3600","X-Content-Type-Options":"nosniff"}});
  if(BLOCKED.test(incoming.pathname))return plain("Not found",404,{"X-Robots-Tag":"noindex, nofollow"});
  const translated=incoming.pathname==="/" ? "/fa/" :
   incoming.pathname==="/en/" ? "/" :
   incoming.pathname.startsWith("/en/") ? incoming.pathname.slice(3) : incoming.pathname;
  const upstreamUrl=new URL(translated+incoming.search,UPSTREAM);
  const headers=new Headers();
  const accept=request.headers.get("accept");
  headers.set("Accept",accept&&accept.length<256?accept:"*/*");
  headers.set("Accept-Language",request.headers.get("accept-language")?.slice(0,128)||"fa-AF,fa;q=0.9,en;q=0.7");
  let upstream;
  try {
   upstream=await fetch(new Request(upstreamUrl.href,{method:request.method,headers,redirect:"follow"}));
  } catch(error) {
   console.error("Short canonical origin temporarily unavailable",String(error));
   return plain("The TOEFL House is temporarily unavailable. Please try again shortly.",503,{"Retry-After":"60"});
  }
  const responseHeaders=new Headers(upstream.headers);
  responseHeaders.delete("set-cookie");
  responseHeaders.delete("content-length");
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("X-Robots-Tag");
  responseHeaders.set("X-Content-Type-Options","nosniff");
  responseHeaders.set("Referrer-Policy","strict-origin-when-cross-origin");
  if(isPreview||NOINDEX.test(incoming.pathname))responseHeaders.set("X-Robots-Tag","noindex, nofollow, noarchive");
  if(request.method==="HEAD")return new Response(null,{status:upstream.status,statusText:upstream.statusText,headers:responseHeaders});
  const contentType=upstream.headers.get("content-type")||"";
  if(HTML_TYPE.test(contentType)&&upstream.ok) {
   const html=polishHtml(await upstream.text(),incoming.pathname);
   responseHeaders.set("Cache-Control","no-cache, no-store, must-revalidate");
   return new Response(html,{status:upstream.status,statusText:upstream.statusText,headers:responseHeaders});
  }
  if(incoming.pathname==="/sitemap.xml"&&upstream.ok) {
   const xml=(await upstream.text()).replaceAll(UPSTREAM,SHORT_ORIGIN);
   return new Response(xml,{status:upstream.status,headers:responseHeaders});
  }
  return new Response(upstream.body,{status:upstream.status,statusText:upstream.statusText,headers:responseHeaders});
 }
};
