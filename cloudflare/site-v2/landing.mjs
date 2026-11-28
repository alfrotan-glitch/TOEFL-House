/* TOEFL House V2 — CMS-driven, accessible, server-rendered public homepage.
 * No enrollment, account, or finance data is fetched. CMS reads are read-only.
 * The original interactive portal remains reachable at /tools/ per language.
 */
// This is the only public/canonical website host; legacy origin stays internal to the edge worker.
const V2_ORIGIN="https://toeflhouse.pages.dev";
const V2_IMG="/assets/aistudio/FB_IMG_1793645643808_dad823ce.jpg";
// V2_CAMPUS_ALT is compiled from content/ui.json.
const V2_OG_LOCALE={en:"en_US",fa:"fa_AF",ps:"ps_AF"};

// Only one campus image exists; do not advertise fictitious resized variants.
const V2_IMG_640=V2_IMG;
// V2_LOGO_REV is derived from the pinned brand checksum at build time.
const V2_LOGO="/__th/v2/brand.webp?v="+V2_LOGO_REV;
// V2_LOGO_DATA is compiled from the integrity-pinned brand asset.
const V2_OG="/assets/aistudio/FB_IMG_1793645643808_dad823ce.jpg";
// V2_COURSE_IDS is declared once in the edge layer and reused by the sitemap.
// V2_COPY is compiled from content/home.json.
const V2_SEMESTER_VIDEO="https://d2ol7oe51mr4n9.cloudfront.net/user_3LPLI9IxwqxpPOe3cVF5EVhg2wd/21a66634-3b32-49c7-9034-8680714ebf17.mp4";
// V2_SEMESTER is compiled from content/home.json.
function v2SemesterCampaign(locale){
 const p=v2Prefix(locale),c=V2_SEMESTER[locale];
 const signup=p+"admissions/?utm_source=website&amp;utm_campaign=qaws_1405_semester";
 return '<section class="semester-section" id="semester-qaws-1405" aria-labelledby="semester-heading"><div class="shell"><div class="semester-card"><div class="semester-copy"><p class="semester-eyebrow"><span class="semester-dot" aria-hidden="true"></span>'+v2T(c.eyebrow)+'</p><h2 id="semester-heading" class="semester-title">'+v2T(c.title)+' <span>'+v2T(c.accent)+'</span></h2><p class="semester-lead">'+v2T(c.lead)+'</p><ul class="semester-chips">'+c.chips.map(x=>'<li>'+v2T(x)+'</li>').join("")+'</ul><div class="semester-actions"><a class="button semester-primary" href="'+signup+'">'+v2T(c.cta)+' <span aria-hidden="true">↗</span></a><a class="button semester-secondary" href="#programs">'+v2T(c.secondary)+'</a></div></div><div class="semester-media"><div class="semester-video-frame"><video class="semester-video" controls playsinline preload="none" poster="'+V2_IMG_640+'" width="720" height="1280" aria-label="'+v2T(c.videoLabel)+'"><source src="'+V2_SEMESTER_VIDEO+'" type="video/mp4">'+v2T(c.videoFallback)+'</video><button class="semester-video-cover" type="button" hidden aria-label="'+v2T(c.playText)+' — '+v2T(c.play)+'"><img src="'+V2_IMG_640+'" width="640" height="820" loading="lazy" decoding="async" alt=""><span class="semester-cover-shade" aria-hidden="true"></span><span class="semester-play-circle" aria-hidden="true"><svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M8 5.6c0-.8.9-1.3 1.6-.9L20 11.2c.6.4.6 1.2 0 1.6L9.6 19.3C8.9 19.7 8 19.2 8 18.4V5.6z"/></svg></span><span class="semester-play-caption" aria-hidden="true">'+v2T(c.playText)+'</span></button><span class="semester-filmmark" aria-hidden="true">THE TOEFL HOUSE · 00:36</span></div><p class="semester-video-caption">'+v2T(c.videoCaption)+'</p></div></div><a class="semester-eap-spotlight" href="'+p+'courses/academic-english/"><span class="semester-eap-mark">EAP</span><span class="semester-eap-copy"><small>'+v2T(c.eapLabel)+'</small><strong>'+v2T(c.eapTeaser)+'</strong><span>'+v2T(c.eapDetail)+'</span></span><span class="semester-eap-link">'+v2T(c.eapLink)+' <span aria-hidden="true">↗</span></span></a></div></section>';
}
// Keep the legacy online program ID and URL stable; normalize only its public editorial fields.
function v2OnlineProgramCopy(locale){
 const editorial=value=>Array.isArray(value)?value.map(editorial):typeof value==="string"?value.replace(/https?:\/\/[^\s<>]+|(?<![\w\-./])Zoom(?![\w\-/]|\.(?:us|com)\b)|زوم/gi,match=>/^https?:\/\//i.test(match)?match:"Google Meet"):value;
 const program=locale?.programs?.find(p=>p.id==="online-individual-zoom");
 if(program)for(const key of ["title","summary","details","duration","highlights","levels","schedule","recommendedFor","recommended"])if(Object.hasOwn(program,key))program[key]=editorial(program[key]);
 const faq=Array.isArray(locale?.faq)?locale.faq:locale?.faq?.items;
 if(Array.isArray(faq))for(const item of faq)if(item&&typeof item==="object"&&!Array.isArray(item)&&/آنلاین|online|آنلاين|Zoom|زوم/i.test((typeof item.q==="string"&&item.q)||(typeof item.question==="string"&&item.question)||""))for(const key of ["q","question","a","answer"])if(Object.hasOwn(item,key))item[key]=editorial(item[key]);
}
function v2String(s){try{return String(s??"");}catch{return "";}}
function v2Esc(s){return v2String(s).replace(/[&<>"']/g,x=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[x]));}
function v2T(s,max=1000){const publicCopy=v2String(s).replace(/خانه موفقیت/g,"تافل هوس");return v2Esc(publicCopy.slice(0,max));}
// Present the Owner's selected university terminology only on Dari pages.
// This also normalizes legacy, editable CMS copy at render time without
// rewriting the database or altering Pashto's correct "پوهنتون".
function v2DariEditorial(html,locale){
 return locale!=="fa"?html:html.replace(/پوهنتونی/g,"دانشگاهی").replace(/پوهنتون/g,"دانشگاه").replace(/روبروی/g,"روبه‌روی");
}

function v2Short(s,max=140){const text=v2String(s).replace(/\s+/g," ").trim();return v2T(text.length>max?text.slice(0,max-1).replace(/\s+\S*$/,"")+"…":text,max+3);}
// The legacy online URL is advertised in the sitemap even when CMS data is unavailable.
function v2OnlineFallback(locale){const c=V2_COPY[locale];return {id:"online-individual-zoom",title:c.onlineLabel,summary:c.onlineText};}
async function v2FallbackCms(){
 const ids=V2_COURSE_IDS;
 const programs=locale=>[...ids.map(id=>({id,title:V2_HOME_COURSE_CARDS[locale][id].name,summary:V2_COPY[locale].subtitle,duration:V2_HOME_COURSE_CARDS[locale][id].fallbackDuration})),v2OnlineFallback(locale)];
 return {main:{locales:{en:{programs:programs("en")},fa:{programs:programs("fa")}},media:{},timetable:{}},pashto:{programs:programs("ps")},revision:0,psRevision:0,cmsStatus:"fallback"};
}
async function v2Cms(env){
 if(!env?.CMS_DB)return v2FallbackCms();
 try{
  const [main,ps]=await Promise.all([
   env.CMS_DB.prepare("SELECT body,revision FROM content WHERE id='main'").first(),
   env.CMS_DB.prepare("SELECT body,revision FROM pashto_content WHERE id='main'").first()
  ]);
  if(!main?.body||!ps?.body)throw Error("Published CMS not available");
  const parsed=JSON.parse(main.body),pashto=JSON.parse(ps.body);
  if(!v2PublishedProgramsValid(parsed,pashto))throw Error("Unexpected CMS programs schema");
  for(const locale of [parsed.locales.en,parsed.locales.fa,pashto])v2OnlineProgramCopy(locale);
  return {main:parsed,pashto,revision:main.revision,psRevision:ps.revision};
 }catch(error){
  console.error("Published CMS read failed; serving reviewed static fallback",String(error));
  return v2FallbackCms();
 }
}
function v2Prefix(locale){return locale==="en"?"/":"/"+locale+"/";}
function v2BreadcrumbLabel(locale){return V2_BREADCRUMB[locale]||V2_BREADCRUMB.en;}
function v2Languages(locale,suffix=""){
 return [["en","EN","/"],["fa","دری","/fa/"],["ps","پښتو","/ps/"]].map(([id,title,path])=>'<a lang="'+(id==="fa"?"fa-AF":id==="ps"?"ps-AF":"en")+'" hreflang="'+(id==="en"?"en":id==="fa"?"fa-AF":"ps-AF")+'" href="'+path+suffix+'"'+(id===locale?' aria-current="page" class="is-active"':'')+'>'+title+'</a>').join("");
}
function v2Header(c,locale,suffix=""){
 const prefix=v2Prefix(locale);
 const l=v2Languages(locale,suffix);
 const anchorBase=suffix?v2Prefix(locale):"";
 const courseMatch=/^courses\/([a-z0-9-]+)\/$/.exec(suffix);
 const applyHref=prefix+"admissions/"+(courseMatch&&(V2_COURSE_IDS.includes(courseMatch[1])||courseMatch[1]==="online-individual-zoom")?"?program="+courseMatch[1]:"");
 const header=V2_HOME_HEADER[locale],compactLabel=header.compact;
 const nav=[[anchorBase+"#programs",c.navPrograms],[prefix+"guides/",c.navGuides],[anchorBase+"#why-us",c.navWhy],[anchorBase+"#online",c.navOnline],[anchorBase+"#faq",c.navFaq],[anchorBase+"#contact",c.navContact]];
 const links=nav.map(([href,label])=>'<a href="'+href+'">'+v2T(label)+'</a>').join("");
 return '<a class="skip" href="#main">'+v2T(header.skip)+'</a>'
  +'<div class="topline"><div class="shell topline-inner"><span class="top-dots"></span><span>'+v2T(c.badge)+'</span><a class="toplink" href="https://wa.me/93794357509" rel="noopener noreferrer">'+v2T(c.wa)+' <span aria-hidden="true">↗</span></a></div></div>'
  +'<header class="site-header"><div class="shell header-inner"><a class="brand" href="'+prefix+'" aria-label="'+v2T(c.name)+'"><img src="'+V2_LOGO+'" width="48" height="48" alt="" decoding="async"><span><strong>THE TOEFL HOUSE</strong><small>'+v2T(c.localName)+'</small></span></a>'
  +'<nav class="main-nav" aria-label="'+v2T(c.navMenu)+'">'+links+'</nav>'
  +'<div class="header-actions"><div class="language-links" role="group" aria-label="'+v2T(header.language)+'">'+l+'</div><a class="button button-primary desktop-apply" href="'+applyHref+'">'+v2T(c.navApply)+' <span aria-hidden="true">↗</span></a></div>'
  +'<a class="mobile-quick-apply" href="'+applyHref+'" aria-label="'+v2T(compactLabel)+' — '+v2T(c.heroCta)+'">'+v2T(compactLabel)+'</a>'
  +'<details class="mobile-menu"><summary aria-label="'+v2T(c.navMenu)+'"><span></span><span></span><span></span></summary><nav aria-label="'+v2T(c.navMenu)+'">'+links+'<div class="mobile-language">'+l+'</div><a class="mobile-apply" href="'+applyHref+'">'+v2T(c.navApply)+'</a></nav></details></div></header>';
}
function v2Stats(c,content,locale){
 const stats=locale==="ps"?content.pashto.statistics:content.main.locales[locale].stats;
 const fallback=c.statsFallback;
 const values=locale==="ps" && Array.isArray(stats)?stats.slice(0,3).map(x=>[x?.value,x?.label]):
 (stats&&typeof stats==="object")?[
 [stats.graduates,stats.graduatesLabel],
 [stats.toeflTakers,stats.toeflLabel],
 [stats.universityAdmissions,stats.universityLabel]]:fallback;
 const display=(value,backup)=>((typeof value==="string"||typeof value==="number")&&value)?value:backup;
 return '<section class="stats-wrap" aria-label="'+v2T(c.trustTitle)+'"><div class="shell">'
 +'<div class="stat-head"><h2>'+v2T(c.trustTitle)+'</h2><p>'+v2T(c.trustSub)+'</p></div>'
 +'<div class="stat-grid">'+values.map(([n,t],i)=>'<div class="stat-item"><strong dir="ltr">'+v2T(display(n,fallback[i][0]))+'</strong><span>'+v2T(display(t,fallback[i][1]))+'</span></div>').join("")+'</div></div></section>';
}
// V2_GOALS is compiled from content/home.json.
// Original, decorative program illustrations. Shared stroke geometry, no third-party assets.
// V2_COURSE_GLYPHS is compiled from the trusted, validated graphic data in content/home.json.
function v2CourseGlyph(id){return '<svg viewBox="0 0 30 30" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'+V2_COURSE_GLYPHS[id]+'</svg>';}
// V2_HOME_PATHS is compiled from content/home.json.
function v2HomeQuickPaths(locale,content){
 const c=V2_HOME_PATHS.locales[locale],p=v2Prefix(locale);
 const programs=locale==="ps"?content.pashto.programs:content.main.locales[locale].programs;
 const paths=V2_HOME_PATHS.catalog.filter(({id})=>programs.some(program=>program.id===id));
 if(!paths.length)return "";
 return '<div class="shell home-paths"><nav class="goal-finder" aria-label="'+v2T(c.label)+'"><div class="goal-finder-intro"><strong>'+v2T(c.label)+'</strong><span>'+v2T(c.hint)+'</span></div><div class="goal-finder-links">'+paths.map(({id,tag})=>'<a href="'+p+'courses/'+id+'/">'+'<span class="home-path-label"><small lang="en" dir="ltr">'+v2T(tag)+'</small><strong>'+v2T(c.links[id])+'</strong></span><span aria-hidden="true">↗</span></a>').join("")+'</div></nav></div>';
}
function v2Programs(c,content,locale){
 const prefix=v2Prefix(locale);
 const src=locale==="ps"?content.pashto.programs:content.main.locales[locale].programs;
 const available=V2_COURSE_IDS.filter(id=>src.some(program=>program.id===id));
 const goal=V2_GOALS[locale],goals=goal.items.filter(([id])=>available.includes(id));
 const goalNav=goals.length?'<nav class="goal-finder" aria-label="'+v2T(goal.label)+'"><div class="goal-finder-intro"><strong>'+v2T(goal.title)+'</strong><span>'+v2T(goal.hint)+'</span></div><div class="goal-finder-links">'+goals.map(([id,label])=>'<a href="#course-'+id+'">'+v2T(label)+' <span aria-hidden="true">↗</span></a>').join("")+'</div></nav>':"";
 const items=available.map(id=>{
  const program=src.find(x=>x.id===id),card=V2_HOME_COURSE_CARDS[locale][id];
  const duration=card.shortDuration||program.duration||"";
  // Owner-confirmed program facts take precedence over older CMS summaries.
  const desc=V2_HOME_REVIEWED_CARDS[locale]?.[id]||program.summary||program.subtitle||"";
  return {id,program,card,duration,desc};
 });
 const cards=items.map(({id,program,card,duration,desc})=>'<article id="course-'+id+'" class="course-card '+(id==="toefl-preparation"?"course-featured":"")+'"><div class="course-top"><span class="course-number">'+v2CourseGlyph(id)+'</span><span class="course-mark" aria-hidden="true">↗</span></div><h3>'+v2T(card.name||program.title||id)+'</h3>'+(id==="academic-english"?'<bdi class="course-full-name" lang="en" dir="ltr">EAP (English for Academic Purposes)</bdi>':"")+'<p class="course-copy">'+v2Short(desc,160)+'</p><div class="course-bottom"><span><small>'+v2T(c.courseDuration)+'</small><strong>'+v2Short(duration||"",85)+'</strong></span><a aria-label="'+v2T(c.courseDetail+' — '+card.name)+'" href="'+prefix+'courses/'+id+'/">'+v2T(c.courseDetail)+' <span aria-hidden="true">↗</span></a></div></article>').join("");
 // A compact native comparison remains usable with no JavaScript and contains
 // exactly the same available programs and facts as the visual cards.
 const rows=items.map(({id,card,duration,desc})=>'<tr><th scope="row"><a href="'+prefix+'courses/'+id+'/">'+v2T(card.name)+' <span aria-hidden="true">↗</span></a></th><td>'+v2Short(duration||c.compareUnknown,85)+'</td><td>'+v2Short(desc||c.compareUnknown,160)+'</td></tr>').join("");
 const comparison=rows?'<details class="program-comparison"><summary>'+v2T(c.compareTitle)+'</summary><p class="comparison-scroll-hint">'+v2T(c.compareScroll)+'</p><div class="schedule-table-wrap" tabindex="0" role="region" aria-label="'+v2T(c.compareTitle)+'"><table class="schedule-table"><thead><tr><th scope="col">'+v2T(c.navPrograms)+'</th><th scope="col">'+v2T(c.courseDuration)+'</th><th scope="col">'+v2T(c.compareFocus)+'</th></tr></thead><tbody>'+rows+'</tbody></table></div></details>':"";
 return '<section class="programs-section section" id="programs"><div class="shell"><div class="section-head"><div><p class="eyebrow">'+v2T(c.courseEyebrow)+'</p><h2>'+v2T(c.coursesTitle)+' <em>'+v2T(c.coursesAccent)+'</em></h2></div>'+(available.length===V2_COURSE_IDS.length?'<p class="section-intro">'+v2T(c.coursesLead)+'</p>':'')+'</div>'+goalNav+(cards?'<div class="courses-grid">'+cards+'</div>'+comparison:'<a class="button button-primary button-xl" href="'+prefix+'admissions/">'+v2T(c.heroCta)+' <span aria-hidden="true">↗</span></a>')+'</div></section>';
}
function v2ShiftRaw(shift,locale){
 const fa=typeof shift.timeFa==="string"?shift.timeFa:"",en=typeof shift.timeEn==="string"?shift.timeEn:"";
 return locale==="fa"?(fa||en):en;
}
function v2ShiftParts(shift,locale){
 const raw=v2ShiftRaw(shift,locale);
 const parts=String(raw).split("·").map(x=>x.trim());
 if(parts.length<2)return null;
 const men=parts[0].replace(/^(Men|برادران:)\s*/,"");
 const women=parts[1].replace(/^(Women|خواهران:)\s*/,"");
 return men&&women?{men,women}:null;
}
function v2PsDigits(s){return String(s).replace(/[0-9]/g,d=>"۰۱۲۳۴۵۶۷۸۹"[d]);}
function v2PsTime(part){
 const m=/^(\d{1,2}):(\d{2})\s*–\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/.exec(String(part).trim());
 if(!m)return v2PsDigits(part);
 const h24=parseInt(m[1],10)%12+(m[5]==="PM"?12:0);
 const word=h24<12?"سهار":h24<16?"ماسپښین":"ماښام";
 return v2PsDigits(m[1]+":"+m[2]+" – "+m[3]+":"+m[4])+" "+word;
}
function v2Schedule(c,content,locale){
 const shifts=content?.main?.timetable;
 if(!Array.isArray(shifts)||!shifts.length)return "";
 const rows=shifts.map((shift,i)=>{
  if(!shift||typeof shift!=="object"||Array.isArray(shift)||!v2ShiftRaw(shift,locale))return "";
  const num=locale==="en"?String(i+1):v2PsDigits(i+1);
  const badge=shift.open===false?'<span class="schedule-full">'+v2T(c.scheduleFull)+'</span>':shift.popular?'<span class="schedule-popular">'+v2T(c.schedulePopular)+'</span>':"";
  const parts=v2ShiftParts(shift,locale);
  const closed=shift.open===false?' is-closed':"";
  if(!parts){
   const raw=v2ShiftRaw(shift,locale);
   return '<tr class="schedule-row'+closed+'"><th scope="row">'+v2T(c.scheduleShift+" "+num)+badge+'</th><td colspan="2"><strong>'+v2T(raw)+'</strong></td></tr>';
  }
  const men=locale==="ps"?v2PsTime(parts.men):parts.men;
  const women=locale==="ps"?v2PsTime(parts.women):parts.women;
  return '<tr class="schedule-row'+closed+'"><th scope="row">'+v2T(c.scheduleShift+" "+num)+badge+'</th><td><strong>'+v2T(men)+'</strong></td><td><strong>'+v2T(women)+'</strong></td></tr>';
 }).join("");
 if(!rows)return "";
 return '<section class="schedule-section section" id="schedule"><div class="shell"><div class="section-head"><div><p class="eyebrow">'+v2T(c.scheduleEyebrow)+'</p><h2 id="schedule-title">'+v2T(c.scheduleTitle)+'</h2></div><p class="section-intro">'+v2T(c.scheduleLead)+'</p></div><div class="schedule-table-wrap" tabindex="0" role="region" aria-labelledby="schedule-title"><table class="schedule-table"><thead><tr><th scope="col">'+v2T(c.scheduleShift)+'</th><th scope="col">'+v2T(c.scheduleMen)+'</th><th scope="col">'+v2T(c.scheduleWomen)+'</th></tr></thead><tbody>'+rows+'</tbody></table></div><p class="schedule-note">'+v2T(c.scheduleNote)+'</p></div></section>';
}
function v2CleanFaqAnswer(value){
 return String(value||"").replace(/\s*(?:رایگان‌بودن تعیین سطح به معنای رایگان‌بودن صنف‌ها نیست|It does not make course tuition free|د سویې وړیا ارزونه د دې معنا نه لري چې درسي ټولګي هم وړیا دي)\.?/gi,"").trim();
}
function v2Faq(c,content,locale){
 const raw=locale==="ps"?content.pashto.faq:content.main.locales[locale].faq;
 const candidate=Array.isArray(raw)?raw:raw?.items;
 const items=Array.isArray(candidate)?candidate.filter(item=>{
  if(!item||typeof item!=="object"||Array.isArray(item))return false;
  const q=item.q||item.question||"",a=item.a||item.answer||"";
  return typeof q==="string"&&!!q.trim()&&typeof a==="string";
 }):[];
 const prioritized=[
  items.find(x=>/تعیین سطح|placement|سویې معلومولو|سویې ارزونه/i.test(x.q||x.question||"")),
  items.find(x=>/ایمیل|email|ایمېل/i.test(x.q||x.question||"")),
  items.find(x=>/آنلاین|online|آنلاين/i.test(x.q||x.question||""))
 ].filter(Boolean);
 const list=prioritized.length===3?prioritized:items.slice(0,3);
 const entries=list.length?list.map(x=>[x.q||x.question,x.a||x.answer]):c.fallbackFaq;
 return '<section class="faq-section section" id="faq"><div class="shell faq-layout"><div class="faq-aside"><p class="eyebrow">'+v2T(c.faqLabel)+'</p><h2>'+v2T(c.faqTitle)+'</h2><p>'+v2T(c.faqLead)+'</p><a class="text-link" href="https://wa.me/93794357509" rel="noopener noreferrer">'+v2T(c.faqMore)+' <span aria-hidden="true">↗</span></a></div><div class="faq-list">'+entries.map(([q,a],i)=>'<details'+(i===0?' open':'')+'><summary>'+v2Short(q,160)+'<span class="faq-plus" aria-hidden="true"></span></summary><p>' +v2T(v2CleanFaqAnswer(a),680)+'</p></details>').join("")+'</div></div></section>';
}
function v2Footer(c,locale,content){
 const prefix=v2Prefix(locale);
 const contact=locale==="ps"?content?.pashto?.contact:content?.main?.locales?.[locale]?.contact;
 const published=(value,fallback,max)=>typeof value==="string"&&value.trim()&&value.length<=max?value:fallback;
 const storedTitle=published(contact?.title,c.visitTitle,180);
 const visitTitle=locale==="fa"&&storedTitle==="در کابل پذیرای شما هستیم."?"تافل هوس در کابل":storedTitle;
 const storedAddress=published(contact?.address,c.visitText,350);
 const visitAddress=locale==="fa"?storedAddress.replace("روبروی","روبه‌روی"):storedAddress;
 const storedHours=published(contact?.operatingHours||contact?.hours,c.hours,250);
 // Keep later CMS edits visible; normalize only the exact three stale published summaries.
 const outdatedHours={
  en:"Teaching: Saturday–Thursday · Men: 6:20 AM–5:50 PM · Women: 6:30 AM–5:40 PM · Friday: Closed",
  fa:"جلسات درسی: شنبه الی پنج‌شنبه · برادران: ۶:۲۰ صبح تا ۵:۵۰ شام · خواهران: ۶:۳۰ صبح تا ۵:۴۰ شام · جمعه: رخصت",
  ps:"شنبه تر پنجشنبې: سهار ۶:۲۰ تر ماښام ۶:۰۰؛ جمعه رخصتي، ځانګړي پروګرامونه جلا اعلانېږي"
 };
 const visitHours=storedHours===outdatedHours[locale]?c.hours:storedHours;
 const maps="https://www.google.com/maps/search/?api=1&query=The%20TOEFL%20House%20Dasht-e-Barchi%20Kabul";
 return '<footer class="footer" id="contact"><div class="shell"><div class="footer-main"><div class="footer-brand"><span class="eyebrow">'+v2T(c.visitLabel)+'</span><h2>'+v2T(visitTitle)+'</h2><p>'+v2T(visitAddress)+'</p><span class="footer-hours">'+v2T(visitHours)+'</span><a class="button button-primary footer-cta" href="'+prefix+'admissions/">'+v2T(c.finalCta)+' <span aria-hidden="true">↗</span></a></div><div class="footer-links"><a href="'+prefix+'#programs">'+v2T(c.footPrograms)+'</a><a href="'+prefix+'guides/">'+v2T(c.navGuides)+'</a><a href="https://wa.me/93794357509" rel="noopener noreferrer">'+v2T(c.wa)+'</a><a href="tel:+93745651844">'+v2T(c.phone)+'</a><a href="'+maps+'" target="_blank" rel="noopener noreferrer">'+v2T(c.map)+' ↗</a></div></div><div class="footer-bottom"><span>© '+new Date().getUTCFullYear()+' THE TOEFL HOUSE · '+v2T(c.footerRights)+'</span></div></div></footer>';
}
// Google Course list: only six real, publicly described curricula; online is a format, not a seventh course.
function v2CourseListSchema(locale,content){
 const cards=V2_HOME_COURSE_CARDS[locale],root=v2Prefix(locale);
 const programs=locale==="ps"?content.pashto.programs:content.main.locales[locale].programs;
 const provider={"@type":"Organization","name":"The TOEFL House","url":V2_ORIGIN+"/"};
 return {"@context":"https://schema.org","@type":"ItemList","itemListElement":V2_COURSE_IDS.filter(id=>programs.some(program=>program.id===id)).map((id,i)=>{
  const course=programs.find(p=>p.id===id);
  const url=V2_ORIGIN+root+"courses/"+id+"/";
  const name=v2String(course.title||cards[id].name).trim().slice(0,180)||cards[id].name;
  const summary=v2String(course.summary||course.details||"").replace(/\s+/g," ").trim();
  const description=(summary.length>=10?summary:name+" course at The TOEFL House in Kabul.").slice(0,280);
  return {"@type":"ListItem","position":i+1,"url":url,"item":{"@type":"Course","name":name,"description":description,"url":url,"provider":provider}};
 })};
}
// Original learner guidance. Links point only to existing localized public guides.
// V2_LEARNING_HABITS is compiled from content/home.json.
function v2LearningHabits(locale){
 const c=V2_LEARNING_HABITS[locale]||V2_LEARNING_HABITS.en,p=v2Prefix(locale);
 return '<section class="journey-section section" id="learning-habits" aria-labelledby="learning-habits-title"><div class="shell"><div class="section-head"><div><p class="eyebrow">'+v2T(c.label)+'</p><h2 id="learning-habits-title">'+v2T(c.title)+'</h2></div><p class="section-intro">'+v2T(c.intro)+'</p></div><div class="journey-grid">'+c.habits.map(([n,h,t])=>'<article class="journey-step"><span class="step-no" aria-hidden="true">'+v2T(n)+'</span><div class="step-line"></div><h3>'+v2T(h)+'</h3><p>'+v2T(t)+'</p></article>').join("")+'</div><div class="section-head"><div><h3>'+v2T(c.resourceTitle)+'</h3></div><p class="section-intro">'+v2T(c.resourceIntro)+'</p></div><div class="growth-card-grid">'+c.links.map(([slug,h,t])=>'<a class="growth-card" href="'+p+'guides/'+slug+'/"><h4>'+v2T(h)+'</h4><p>'+v2T(t)+'</p><span class="growth-arrow">'+v2T(c.open)+' <span aria-hidden="true">↗</span></span></a>').join("")+'</div><a class="text-link" href="'+p+'guides/">'+v2T(c.all)+' <span aria-hidden="true">↗</span></a></div></section>';
}
function v2FontPreload(locale){return locale==="en"?"":'<link rel="preload" href="'+DARI_FONT_PATH+'" as="font" type="font/woff2" crossorigin>';}
function v2Page(locale,content){
 const c=V2_COPY[locale],prefix=v2Prefix(locale),title=c.seoTitle;
 const desc=c.subtitle,canonical=V2_ORIGIN+prefix;
 const language="<link rel=\"alternate\" hreflang=\"en\" href=\""+V2_ORIGIN+"/\"><link rel=\"alternate\" hreflang=\"fa-AF\" href=\""+V2_ORIGIN+"/fa/\"><link rel=\"alternate\" hreflang=\"ps-AF\" href=\""+V2_ORIGIN+"/ps/\"><link rel=\"alternate\" hreflang=\"x-default\" href=\""+V2_ORIGIN+"/\">";
 const ld=JSON.stringify([{"@context":"https://schema.org","@type":"EducationalOrganization","name":"The TOEFL House","alternateName":"تافل هوس","url":V2_ORIGIN+"/","description":c.subtitle,"address":{"@type":"PostalAddress","streetAddress":"Opposite Jalili Center, Maghaza Station, Dasht-e-Barchi","addressLocality":"Kabul","addressCountry":"AF"},"telephone":"+93745651844","availableLanguage":["en","fa-AF","ps-AF"]},v2CourseListSchema(locale,content)]).replace(/</g,"\\u003c");
 return '<!doctype html><html lang="'+c.lang+'" dir="'+c.dir+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'+v2T(title)+'</title><meta name="description" content="'+v2T(desc,400)+'"><meta name="theme-color" content="#faf9f8"><meta property="og:type" content="website"><meta property="og:locale" content="'+V2_OG_LOCALE[locale]+'"><meta property="og:title" content="'+v2T(title)+'"><meta property="og:description" content="'+v2T(desc)+'"><meta property="og:url" content="'+canonical+'"><meta property="og:image" content="'+V2_ORIGIN+V2_OG+'"><meta property="og:image:alt" content="'+v2T(c.photoSub,180)+'"><meta property="og:site_name" content="The TOEFL House"><meta name="twitter:card" content="summary_large_image"><link rel="canonical" href="'+canonical+'">'+language+v2FontPreload(locale)+'<link rel="icon" href="' + V2_LOGO + '"><link rel="preload"'+(locale==="fa"?'':' media="(min-width: 761px)"')+' href="'+V2_IMG_640+'" as="image" fetchpriority="high"><link rel="stylesheet" href="/__th/v2/site.css?v='+V2_REV+'"><script defer src="/__th/v2/site.js?v='+V2_REV+'"></script><script defer src="/__th/engagement-v1.js"></script><script type="application/ld+json">'+ld+'</script></head><body class="home-editorial">'
 +v2Header(c,locale)
 +'<main id="main"><section class="hero"><div class="shell hero-grid"><div class="hero-copy"><span class="eyebrow eyebrow-hero"><span class="eyebrow-rule"></span>'+v2T(c.tag)+'</span><a class="semester-hero-pill" href="#semester-qaws-1405"><span class="semester-mini-dot" aria-hidden="true"></span>'+v2T(V2_SEMESTER[locale].heroTeaser)+' <span aria-hidden="true">↗</span></a><h1>'+v2T(c.lead)+' <span>'+v2T(c.leadAccent)+'</span></h1><p class="hero-lead">'+v2T(c.subtitle)+'</p><div class="hero-actions"><a class="button button-primary button-xl" href="'+prefix+'admissions/">'+v2T(c.heroCta)+' <span aria-hidden="true">↗</span></a><a class="button button-quiet button-xl" href="#programs">'+v2T(c.heroSecondary)+'</a></div><div class="hero-fine"><span aria-hidden="true">✦</span>'+v2T(c.heroBottom)+'</div></div><div class="hero-art"><div class="photo-frame"><img src="'+V2_IMG_640+'" width="680" height="820" alt="'+v2T(V2_CAMPUS_ALT[locale])+'" '+(locale==="fa"?'loading="eager" fetchpriority="high"':'loading="lazy"')+' decoding="async"><div class="photo-shade"></div><div class="photo-label"><strong>'+v2T(c.photoBadge)+'</strong><small>'+v2T(c.photoSub)+'</small></div></div><div class="photo-side"><span>'+v2T(c.micro)+'</span></div></div></div></section>'
 +v2HomeQuickPaths(locale,content)
 +v2Programs(c,content,locale)
 +v2Stats(c,content,locale)
 +v2SemesterCampaign(locale)
 +v2LearningHabits(locale)
 +v2Schedule(c,content,locale)
 +'<section class="online-section section" id="online"><div class="shell"><div class="online-panel"><div class="online-symbol" aria-hidden="true"><span>1:1</span><svg viewBox="0 0 70 70" fill="none" aria-hidden="true"><circle cx="35" cy="35" r="31" stroke="currentColor" stroke-width="1.5"/><path d="M15 35h40M35 15v40" stroke="currentColor" stroke-width="1.5"/></svg></div><div class="online-copy"><p class="eyebrow">'+v2T(c.onlineLabel)+'</p><h2>'+v2T(c.onlineTitle)+'</h2><p>'+v2T(c.onlineText)+'</p></div><a class="button button-light" href="'+prefix+'admissions/?program=online-individual-zoom&amp;format=online">'+v2T(c.onlineCta)+' <span aria-hidden="true">↗</span></a></div></div></section>'
 +'<section class="journey-section section" id="why-us"><div class="shell"><div class="section-head"><div><p class="eyebrow">'+v2T(c.whyLabel)+'</p><h2>'+v2T(c.whyTitle)+'</h2></div><p class="section-intro">'+v2T(c.whyLead)+'</p></div><div class="journey-grid">'+c.steps.map(([n,h,p])=>'<article class="journey-step"><span class="step-no">'+v2T(n)+'</span><div class="step-line"></div><h3>'+v2T(h)+'</h3><p>'+v2T(p)+'</p></article>').join("")+'</div><div class="tools-strip"><div class="tools-glyph" aria-hidden="true">✳</div><div class="tools-content"><span class="eyebrow">'+v2T(c.toolsLabel)+'</span><h3>'+v2T(c.toolsTitle)+'</h3><p>'+v2T(c.toolsText)+'</p></div><a class="text-link" href="'+prefix+'admissions/">'+v2T(c.toolsCta)+' <span aria-hidden="true">↗</span></a></div></div></section>'
 +v2Faq(c,content,locale)
 +'<section class="final-cta"><div class="shell final-inner"><div><p class="eyebrow">'+v2T(c.finalEyebrow)+'</p><h2>'+v2T(c.finalTitle)+'</h2><p>'+v2T(c.finalText)+'</p></div><a class="button button-white" href="'+prefix+'admissions/">'+v2T(c.finalCta)+' <span aria-hidden="true">↗</span></a></div></section>'
 +'</main>'+v2Footer(c,locale,content)+'</body></html>';
}
async function v2Home(request,env,locale){
 if(!["GET","HEAD"].includes(request.method))return new Response("Method not allowed",{status:405,headers:{"Allow":"GET, HEAD"}});
 try{
  const data=await v2Cms(env);
  const html=v2DariEditorial(v2Page(locale,data),locale),preview=new URL(request.url).hostname!=="toeflhouse.pages.dev";
  const headers=new Headers({"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-cache, no-store, must-revalidate","X-Content-Type-Options":"nosniff","Referrer-Policy":"strict-origin-when-cross-origin","X-Frame-Options":"DENY","Permissions-Policy":"camera=(), microphone=(), geolocation=()","Content-Language":V2_COPY[locale].lang,"Content-Security-Policy":"default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self'; font-src 'self'; img-src 'self' data:; media-src 'self' https://d2ol7oe51mr4n9.cloudfront.net; connect-src 'self' https://toefl-house-conversions.alfrotan2.workers.dev https://static.cloudflareinsights.com https://cloudflareinsights.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://wa.me"});
  if(preview)headers.set("X-Robots-Tag","noindex, nofollow, noarchive");
  return new Response(request.method==="HEAD"?null:html,{status:200,headers});
 }catch(error){
  console.error("V2 CMS page render unavailable; retaining original",String(error));
  return null;
 }
}
// Branded 404 page. No CMS dependency, so it renders even when the CMS is down.
// Locale comes from the URL prefix (/fa/, /ps/); anything else is English.
// No canonical or hreflang: a missing page must not present itself as a real URL.
function v2NotFound(request){
 const url=new URL(request.url);
 const locale=url.pathname==="/fa"||url.pathname.startsWith("/fa/")?"fa":url.pathname==="/ps"||url.pathname.startsWith("/ps/")?"ps":"en";
 const c=V2_COPY[locale],prefix=v2Prefix(locale);
 const title=c.notFoundTitle+" | The TOEFL House";
 const html='<!doctype html><html lang="'+c.lang+'" dir="'+c.dir+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'+v2T(title,200)+'</title><meta name="description" content="'+v2T(c.notFoundText,400)+'"><meta name="robots" content="noindex, nofollow"><meta name="theme-color" content="#faf9f8"><link rel="icon" href="'+V2_LOGO+'"><link rel="stylesheet" href="/__th/v2/site.css?v='+V2_REV+'"><script defer src="/__th/v2/site.js?v='+V2_REV+'"></script><script defer src="/__th/engagement-v1.js"></script></head><body>'
 +v2Header(c,locale,"404/")
 +'<main id="main"><section class="notfound-section"><div class="shell"><div class="notfound-inner"><span class="notfound-code" dir="ltr" aria-hidden="true">404</span><h1>'+v2T(c.notFoundTitle)+'</h1><p>'+v2T(c.notFoundText)+'</p><div class="notfound-actions"><a class="button button-primary button-xl" href="'+prefix+'">'+v2T(c.notFoundHome)+'</a><a class="button button-quiet button-xl" href="'+prefix+'#programs">'+v2T(c.navPrograms)+'</a></div></div></div></section></main>'
 +v2Footer(c,locale,undefined)+'</body></html>';
 const headers=new Headers({"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-cache, no-store, must-revalidate","X-Content-Type-Options":"nosniff","Referrer-Policy":"strict-origin-when-cross-origin","X-Frame-Options":"DENY","Permissions-Policy":"camera=(), microphone=(), geolocation=()","Content-Language":c.lang,"X-Robots-Tag":"noindex, nofollow, noarchive","Content-Security-Policy":"default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://toefl-house-conversions.alfrotan2.workers.dev https://static.cloudflareinsights.com https://cloudflareinsights.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://wa.me"});
 return new Response(request.method==="HEAD"?null:v2DariEditorial(html,locale),{status:404,headers});
}
