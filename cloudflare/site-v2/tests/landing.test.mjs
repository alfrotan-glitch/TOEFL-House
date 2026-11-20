import test from "node:test";
import assert from "node:assert/strict";
import worker from "../dist/_worker.js";
const allIds=["general-english","academic-english","toefl-preparation","special-speaking","professional-writing","teacher-training","online-individual-zoom"];
const main={
 locales:{
  en:{programs:allIds.map((id,i)=>({id,title:"English program "+i,summary:"Program details",duration:id==="toefl-preparation"?"4 months":"2 months"})),stats:{graduates:"6,000+",graduatesLabel:"Graduates",toeflTakers:"500+",toeflLabel:"Candidates",universityAdmissions:"100+",universityLabel:"Admissions"},faq:{items:[{q:"Is placement free?",a:"Yes"},{q:"Email required?",a:"No"},{q:"Online available?",a:"By arrangement"}]}},
  fa:{programs:allIds.map((id,i)=>({id,title:"کورس "+i,summary:"معلومات کورس",duration:id==="toefl-preparation"?"۴ ماه":"۲ ماه"})),stats:{graduates:"۶۰۰۰+",graduatesLabel:"فارغان",toeflTakers:"۵۰۰+",toeflLabel:"شاگردان",universityAdmissions:"۱۰۰+",universityLabel:"پذیرش"},faq:{items:[{q:"آیا تعیین سطح رایگان است؟",a:"بلی"},{q:"آیا ایمیل ضروری است؟",a:"نخیر"},{q:"آیا صنف آنلاین است؟",a:"با هماهنگی"}]}}
 }
};
const ps={programs:allIds.map((id,i)=>({id,title:"پروګرام "+i,summary:"زده کړې",duration:id==="toefl-preparation"?"څلور میاشتې":"دوه میاشتې"})),statistics:[{value:"۶۰۰۰+",label:"فارغان"},{value:"۵۰۰+",label:"شاګردان"},{value:"۱۰۰+",label:"منل شوي"}],faq:{items:[{q:"آیا سویې معلومول وړیا دي؟",a:"هو"},{q:"آیا ایمیل پکار دی؟",a:"نه"},{q:"آنلاین زده‌کړه",a:"هو"}]}};
const reads=[];
function env(testMain=main,testPs=ps){
 return{CMS_DB:{prepare(sql){
  assert.match(sql,/SELECT body,revision/);
  reads.push(sql);
  return{async first(){return {body:JSON.stringify(sql.includes("pashto_content")?testPs:testMain),revision:40}}};
 }}};
}
for(const [route,lang,dir] of [["/","en","ltr"],["/fa/","fa-AF","rtl"],["/ps/","ps-AF","rtl"]]){
 test("full trilingual V2 SSR "+route,async()=>{
  const r=await worker.fetch(new Request("https://the-toefl-house.pages.dev"+route),env());
  assert.equal(r.status,200);
  assert.match(r.headers.get("Content-Type"),/text\/html/);
  assert.equal(r.headers.get("Content-Language"),lang);
  assert.equal(r.headers.get("X-Robots-Tag"),null);
  const html=await r.text();
  assert.match(html,new RegExp('<html lang="'+lang+'" dir="'+dir+'">'));
  assert.equal((html.match(/<h1>/g)||[]).length,1);
  assert.equal((html.match(/class="course-card /g)||[]).length,6);
  assert.match(html,/4 months|۴ ماه|څلور میاشتې/);
  assert.match(html,/v2\/site\.css/);
  assert.match(html,/v2\/site\.js/);
  assert.match(html,/engagement-v1\.js/);
  assert.match(html,/<link rel="canonical"/);
  assert.match(html,/href="\/(?:fa\/|ps\/)?tools\/"/);
  assert.match(html,/href="\/(?:fa\/|ps\/)?admissions\/"/);
  assert.match(html,/<script type="application\/ld\+json">/);
  assert.doesNotMatch(html,/500 Internal Server Error/);
  assert.doesNotMatch(html,/Figures reported by The TOEFL House|آمار منتشرشده توسط تافل هوس|د خانه موفقیت خپاره کړي شمېرې|The course itself is not free|01:01/,"No editorial/design leftovers in public content");
 });
}
test("Preview home is noindex but visible",async()=>{
 const r=await worker.fetch(new Request("https://v2.the-toefl-house.pages.dev/fa/"),env());
 assert.equal(r.status,200);assert.match(r.headers.get("X-Robots-Tag"),/noindex/);
});
test("HEAD home does not download HTML",async()=>{
 const r=await worker.fetch(new Request("https://the-toefl-house.pages.dev/ps/",{method:"HEAD"}),env());
 assert.equal(r.status,200);assert.equal(await r.text(),"");
});
test("new CSS, JS are local, security-hardened assets",async()=>{
 for(const [p,type] of [["site.css","text/css"],["site.js","javascript"]]){
  const r=await worker.fetch(new Request("https://the-toefl-house.pages.dev/__th/v2/"+p),env());
  assert.equal(r.status,200);assert.match(r.headers.get("Content-Type"),new RegExp(type));
  assert.match(r.headers.get("X-Robots-Tag"),/noindex/);
  assert.ok((await r.text()).length>400);
 }
});
test("CMS DB failure gracefully preserves immutable original homepage",async()=>{
 const orig=globalThis.fetch;
 globalThis.fetch=async r=>new Response("previous site remains available",{status:200,headers:{"Content-Type":"text/plain"}});
 try{
  const r=await worker.fetch(new Request("https://the-toefl-house.pages.dev/"),{});
  assert.equal(r.status,200);
  assert.equal(await r.text(),"previous site remains available");
 }finally{globalThis.fetch=orig;}
});
test("V2 home does not reveal user data from CMS",async()=>{
 const r=await worker.fetch(new Request("https://the-toefl-house.pages.dev/"),env());
 const html=await r.text();
 assert.ok(!html.includes("password_hash"));
 assert.ok(!html.includes("session_token"));
 assert.ok(!html.includes("admin_secret"));
});


for(const [prefix,lang] of [["/","en"],["/fa/","fa-AF"],["/ps/","ps-AF"]]){
 test("Course details preserve four-month TOEFL and semantic SEO in "+prefix,async()=>{
  const req=new Request("https://the-toefl-house.pages.dev"+prefix+"courses/toefl-preparation/");
  const r=await worker.fetch(req,env());
  assert.equal(r.status,200);
  assert.equal(r.headers.get("Content-Language"),lang);
  assert.equal(r.headers.get("X-Robots-Tag"),null);
  const html=await r.text();
  assert.equal((html.match(/<h1>/g)||[]).length,1);
  assert.match(html,/TOEFL/);
  assert.match(html,/4 months|۴ ماه|څلور میاشتې/);
  assert.match(html,/<link rel="canonical"/);
  assert.match(html,/application\/ld\+json/);
  assert.match(html,/"@type":"Course"/);
  assert.match(html,/v2\/site\.css/);
  assert.match(html,new RegExp('href="'+prefix+'admissions/'));
 });
 test("Admissions page offers no-email WhatsApp only funnel in "+prefix,async()=>{
  const req=new Request("https://the-toefl-house.pages.dev"+prefix+"admissions/");
  const r=await worker.fetch(req,env());
  assert.equal(r.status,200);
  const html=await r.text();
  assert.equal((html.match(/<h1>/g)||[]).length,1);
  assert.match(html,/id="v2-enquiry-form"/);
  assert.match(html,/name="program"/);
  assert.match(html,/name="format"/);
  assert.match(html,/name="when"/);
  assert.match(html,/wa\.me\/93794357509/);
  assert.doesNotMatch(html,/<input[^>]+type="email"/);
  assert.doesNotMatch(html,/<input[^>]+type="password"/);
  assert.match(html,/<link rel="canonical"/);
 });
 test("Legacy tools route remains read-only and is noindexed in "+prefix,async()=>{
  const prior=globalThis.fetch;
  globalThis.fetch=async request=>new Response('Prior React app is preserved',{headers:{"Content-Type":"text/plain"}});
  try{
   const route=prefix+"tools/";
   const r=await worker.fetch(new Request("https://the-toefl-house.pages.dev"+route),env());
   assert.equal(r.status,200);
   assert.match(await r.text(),/Prior React app/);
   assert.match(r.headers.get("X-Robots-Tag")||"",/noindex/);
  }finally{globalThis.fetch=prior;}
 });
}

test("Course language switcher retains current program, and all subpage menu links target existing home anchors",async()=>{
 const r=await worker.fetch(new Request("https://the-toefl-house.pages.dev/fa/courses/toefl-preparation/"),env());
 const html=await r.text();
 assert.match(html,/href="\/courses\/toefl-preparation\/"/);
 assert.match(html,/href="\/fa\/courses\/toefl-preparation\/"/);
 assert.match(html,/href="\/ps\/courses\/toefl-preparation\/"/);
 assert.match(html,/href="\/fa\/#programs"/);
 assert.match(html,/href="\/fa\/#why-us"/);
 assert.match(html,/href="\/fa\/#online"/);
 assert.match(html,/href="\/fa\/#faq"/);
});
test("Admissions language switcher retains admissions context",async()=>{
 const r=await worker.fetch(new Request("https://the-toefl-house.pages.dev/ps/admissions/"),env());
 const html=await r.text();
 assert.match(html,/href="\/admissions\/"/);
 assert.match(html,/href="\/fa\/admissions\/"/);
 assert.match(html,/href="\/ps\/admissions\/"/);
 assert.match(html,/href="\/ps\/#programs"/);
});

test("Public editor changes to address and hours appear in V2 footer without source rebuild",async()=>{
 const custom=structuredClone(main);
 custom.locales.fa.contact={title:"آدرس جدید کورس",address:"CMS_DYNAMIC_ADDRESS_QA",operatingHours:"CMS_DYNAMIC_HOURS_QA"};
 const r=await worker.fetch(new Request("https://the-toefl-house.pages.dev/fa/"),env(custom));
 const html=await r.text();
 assert.match(html,/CMS_DYNAMIC_ADDRESS_QA/);
 assert.match(html,/CMS_DYNAMIC_HOURS_QA/);
 const d=await worker.fetch(new Request("https://the-toefl-house.pages.dev/fa/courses/toefl-preparation/"),env(custom));
 const page=await d.text();
 assert.match(page,/CMS_DYNAMIC_ADDRESS_QA/);
 assert.match(page,/CMS_DYNAMIC_HOURS_QA/);
});
test("Both marketing assets use fingerprinted URLs so old CSS and JS cannot persist after release",async()=>{
 const r=await worker.fetch(new Request("https://the-toefl-house.pages.dev/"),env());
 const html=await r.text();
 const css=html.match(/\/__th\/v2\/site\.css\?v=([a-f0-9]{12})/);
 const js=html.match(/\/__th\/v2\/site\.js\?v=([a-f0-9]{12})/);
 assert.ok(css,"Missing content-hash CSS");
 assert.ok(js,"Missing content-hash JS");
 assert.equal(css[1],js[1]);
 const file=await worker.fetch(new Request("https://the-toefl-house.pages.dev/__th/v2/site.css?v="+css[1]),env());
 assert.equal(file.status,200);
 assert.match(file.headers.get("Cache-Control")||"",/immutable/);
});
test("Learning guides are reachable from main header and footer in all languages",async()=>{
 for(const prefix of ["/","/fa/","/ps/"]){
  const r=await worker.fetch(new Request("https://the-toefl-house.pages.dev"+prefix),env());
  const html=await r.text();
  assert.ok(html.includes('href="'+prefix+'guides/"'),"Missing guides: "+prefix);
 }
});


test("Afghan Dari V2 public marketing uses the current TOEFL House name",async()=>{
 const home=await worker.fetch(new Request("https://the-toefl-house.pages.dev/fa/"),env());
 const html=await home.text();
 assert.match(html,/<title>تافل هوس \| کورس زبان انگلیسی و آمادگی تافل در کابل<\/title>/);
 assert.match(html,/تافل هوس/);
 const admissions=await worker.fetch(new Request("https://the-toefl-house.pages.dev/fa/admissions/"),env());
 assert.match(await admissions.text(),/تافل هوس/);
});

test("Malformed URL hash does not crash the student menu or enrolment script",async()=>{
 const {runInNewContext}=await import("node:vm");
 const client=await worker.fetch(new Request("https://the-toefl-house.pages.dev/__th/v2/site.js"),env());
 const source=await client.text();
 const handlers=[];
 const menu={querySelectorAll(){return []},open:false,contains(){return true}};
 runInNewContext(source,{
  location:{hash:"#%not-valid",pathname:"/fa/",search:"",replace(){throw Error("Unexpected redirect")}},
  document:{
   querySelector(selector){return selector===".mobile-menu"?menu:null},
   getElementById(){return null},
   addEventListener(type){handlers.push(type)}
  },
  URLSearchParams,decodeURIComponent,sessionStorage:{setItem(){},getItem(){return null}}
 });
 assert.ok(handlers.includes("keydown"),"Mobile navigation handlers must still initialize");
});


test("General English exposes five school levels, realistic AFN tuition and Oxford book-level distinction in EN/FA/PS",async()=>{
 const cases=[
  {path:"/courses/general-english/",two:"2 instructors",monthly:"500 AFN",semester:"1,000 AFN",total:"4,500 AFN",free:"Free"},
  {path:"/fa/courses/general-english/",two:"۲ استاد",monthly:"۵۰۰ افغانی",semester:"۱٬۰۰۰ افغانی",total:"۴٬۵۰۰ افغانی",free:"رایگان"},
  {path:"/ps/courses/general-english/",two:"۲ ښوونکي",monthly:"۵۰۰ افغانۍ",semester:"۱٬۰۰۰ افغانۍ",total:"۴٬۵۰۰ افغانۍ",free:"وړیا"}
 ];
 for(const c of cases){
  const res=await worker.fetch(new Request("https://the-toefl-house.pages.dev"+c.path),env());
  assert.equal(res.status,200,c.path);
  const html=await res.text();
  assert.match(html,/id="general-english-details"/,c.path);
  assert.match(html,/id="ge-fees-title"/,c.path);
  assert.match(html,/Got it!/);
  assert.match(html,/Oxford University Press/);
  assert.ok(html.includes(c.two),c.path+" two instructors");
  assert.ok(html.includes(c.monthly),c.path+" monthly AFN 500");
  assert.ok(html.includes(c.semester),c.path+" semester AFN 1000");
  assert.ok(html.includes(c.total),c.path+" optional complete path AFN 4500");
  assert.ok(html.includes(c.free),c.path+" free assessment");
  for(const level of ["Pre-Starter","Starter","Prep One","Prep Two","Prep Three"]){
   assert.ok(html.includes('>'+level+'</h4>'),c.path+" "+level);
  }
  assert.equal((html.match(/class="ge-stage"/g)||[]).length,5,"Exactly five stages");
  assert.equal((html.match(/class="ge-faq"/g)||[]).length,3,"Three useful FAQs");
  assert.ok(html.includes("Got it! Level 3"),"Four publisher book levels explained");
  assert.doesNotMatch(html,/class="ge-references"/,"Internal bibliography not displayed to visitors");
  assert.ok(html.includes("Speaking"),"Dedicated Speaking chapter");
  assert.match(html,/admissions\/\?program=general-english/,"GE placement CTA");
  assert.doesNotMatch(html,/<img[^>]+(?:got-it|gotit|oxford-cover)/i,"No unlicensed Oxford images");
 }
});
test("General English supplement is exclusive to General English; other courses unchanged",async()=>{
 for(const route of ["/courses/toefl-preparation/","/fa/courses/academic-english/","/ps/courses/special-speaking/"]){
  const res=await worker.fetch(new Request("https://the-toefl-house.pages.dev"+route),env());
  assert.equal(res.status,200);
  const html=await res.text();
  assert.doesNotMatch(html,/id="general-english-details"/,route);
 }
});
test("General English course preview remains noindex and HEAD has no body",async()=>{
 const q=await worker.fetch(new Request("https://abc12345.the-toefl-house.pages.dev/fa/courses/general-english/"),env());
 assert.equal(q.status,200);
 assert.match(q.headers.get("X-Robots-Tag"),/noindex/);
 const h=await worker.fetch(new Request("https://the-toefl-house.pages.dev/ps/courses/general-english/",{method:"HEAD"}),env());
 assert.equal(h.status,200);
 assert.equal(await h.text(),"");
});

test("Published CMS historical name uses visitor brand without modifying saved data",async()=>{
 const fa=structuredClone(main);
 fa.locales.fa.faq.items[0].a="بلی، در خانه موفقیت تعیین سطح رایگان است.";
 const pashto=structuredClone(ps);
 pashto.faq.items[0].a="په خانه موفقیت کې د سویې معلومول وړیا دي.";
 const [faResponse,psResponse]=await Promise.all([
  worker.fetch(new Request("https://the-toefl-house.pages.dev/fa/"),env(fa,pashto)),
  worker.fetch(new Request("https://the-toefl-house.pages.dev/ps/"),env(fa,pashto))
 ]);
 assert.match(await faResponse.text(),/در تافل هوس تعیین سطح رایگان است/);
 assert.match(await psResponse.text(),/په تافل هوس کې د سویې معلومول وړیا دي/);
 assert.equal(fa.locales.fa.faq.items[0].a,"بلی، در خانه موفقیت تعیین سطح رایگان است.");
});

test("Public course and admissions pages remove legacy branding and internal-version wording",async()=>{
 const updated=structuredClone(main);
 updated.locales.fa.programs[0].details="در خانه موفقیت معلومات داخلی مرکز";
 const pashto=structuredClone(ps);
 pashto.programs[0].details="په خانه موفقیت کې د کورس معلومات";
 for(const [path,site] of [
  ["/fa/courses/general-english/",updated],
  ["/ps/courses/general-english/",updated],
  ["/ps/admissions/",updated],
  ["/fa/admissions/",updated],
  ["/admissions/",updated]
 ]){
  const response=await worker.fetch(new Request("https://the-toefl-house.pages.dev"+path),env(updated,pashto));
  assert.equal(response.status,200,path);
  const html=await response.text();
  assert.doesNotMatch(html,/خانه موفقیت|View original student form|فورم قبلی|پخوانی فورم/,path);
  assert.match(html,/THE TOEFL HOUSE/,path);
 }
 assert.ok(updated.locales.fa.programs[0].details.includes("خانه موفقیت"),"Original CMS remains unchanged");
});

test("Legacy published timetable blurbs use a consistent, verifiable public schedule",async()=>{
 const e=structuredClone(main),p=structuredClone(ps);
 e.locales.en.contact={operatingHours:"Teaching: Saturday–Thursday · Men: 6:20 AM–5:50 PM · Women: 6:30 AM–5:40 PM · Friday: Closed"};
 e.locales.fa.contact={operatingHours:"جلسات درسی: شنبه الی پنج‌شنبه · برادران: ۶:۲۰ صبح تا ۵:۵۰ شام · خواهران: ۶:۳۰ صبح تا ۵:۴۰ شام · جمعه: رخصت"};
 p.contact={hours:"شنبه تر پنجشنبې: سهار ۶:۲۰ تر ماښام ۶:۰۰؛ جمعه رخصتي، ځانګړي پروګرامونه جلا اعلانېږي"};
 for(const path of ["/","/fa/","/ps/"]){
  const r=await worker.fetch(new Request("https://the-toefl-house.pages.dev"+path),env(e,p));
  const html=await r.text();
  assert.equal(r.status,200,path);
  assert.doesNotMatch(html,/6:20 AM–5:50 PM|۶:۲۰ صبح تا ۵:۵۰ شام|سهار ۶:۲۰ تر ماښام ۶:۰۰/);
  assert.match(html,/Confirm class times with admissions|وقت دقیق صنف را از پذیرش بپرسید|د ټولګي دقیق وخت له ادارې وپوښتئ/);
 }
 p.contact.hours="د نوې دورې مهالوېش CMS_EDITED_HOURS";
 const page=await worker.fetch(new Request("https://the-toefl-house.pages.dev/ps/"),env(e,p));
 assert.match(await page.text(),/CMS_EDITED_HOURS/);
});

test("Semester Qaws 1405 video announcement is visible, accessible and localised without autoplay",async()=>{
 for(const [path,lang,teaser] of [["/","en","New semester"],["/fa/","fa","سمستر قوس ۱۴۰۵"],["/ps/","ps","قوس ۱۴۰۵"]]){
  const r=await worker.fetch(new Request("https://the-toefl-house.pages.dev"+path),env());
  const html=await r.text();
  assert.equal(r.status,200,path);
  assert.equal((html.match(/id="semester-qaws-1405"/g)||[]).length,1,path);
  assert.ok(html.includes(teaser),path+" does not show new semester offer");
  assert.match(html,/class="semester-video" controls playsinline preload="none" poster="\/assets\/aistudio\/campus-640_/);
  assert.match(html,/type="video\/mp4"/);
  assert.match(html,/src="https:\/\/d2ol7oe51mr4n9\.cloudfront\.net\/user_[^"]+\.mp4"/);
  assert.match(html,/href="\/(?:fa\/|ps\/)?admissions\/\?utm_source=website&amp;utm_campaign=qaws_1405_semester"/);
  assert.match(html,/href="#programs"/);
  assert.doesNotMatch(html,/<video[^>]+autoplay/);
  assert.match(r.headers.get("Content-Security-Policy"),/media-src 'self' https:\/\/d2ol7oe51mr4n9\.cloudfront\.net/);
  assert.match(html,/تعیین سطح رایگان|placement assessment|سویې معلومول/);
 }
});

test("Semester campaign has a keyboard-accessible poster play control with native video fallback",async()=>{
 const r=await worker.fetch(new Request("https://the-toefl-house.pages.dev/fa/"),env());
 assert.equal(r.status,200);
 const html=await r.text();
 assert.match(html,/<button class="semester-video-cover" type="button" hidden aria-label="پخش ویدیوی معرفی سمستر جدید"/);
 assert.match(html,/class="semester-play-circle"/);
 const client=await worker.fetch(new Request("https://the-toefl-house.pages.dev/__th/v2/site.js"),env());
 const code=await client.text();
 assert.match(code,/semesterCover\.addEventListener\("click"/);
 assert.match(code,/semesterVideo\.play\(\)/);
 assert.doesNotMatch(code,/semesterVideo\.autoplay\s*=\s*true/);
});


test("EAP is a complete, stand-alone multilingual academic guide with owner-confirmed tuition",async()=>{
 const cases=[
  ["/courses/academic-english/","en","AFN 1,000","AFN 2,000"],
  ["/fa/courses/academic-english/","fa-AF","۱٬۰۰۰ افغانی","۲٬۰۰۰ افغانی"],
  ["/ps/courses/academic-english/","ps-AF","۱٬۰۰۰ افغانۍ","۲٬۰۰۰ افغانۍ"]
 ];
 for(const [path,lang,monthly,semester] of cases){
  const result=await worker.fetch(new Request("https://the-toefl-house.pages.dev"+path),env());
  assert.equal(result.status,200,path);
  const html=await result.text();
  assert.match(html,new RegExp('<html lang="'+lang+'" dir="'));
  assert.equal((html.match(/<h1>/g)||[]).length,1,path);
  assert.match(html,/<meta name="description"/,path);
  assert.match(html,/<script type="application\/ld\+json">/,path);
  assert.match(html,/id="eap-levels"/,path);
  assert.match(html,/id="eap-books"/,path);
  assert.match(html,/id="eap-fees"/,path);
  assert.equal((html.match(/<li class="eap-level">/g)||[]).length,4,path);
  assert.equal((html.match(/<article class="eap-book">/g)||[]).length,3,path);
  assert.equal((html.match(/<article class="eap-goal">/g)||[]).length,4,path);
  for(const book of ["ACTIVE Skills for Reading","Contemporary Topics","Longman Academic Writing Series"]){
   assert.ok(html.toLowerCase().includes(book.toLowerCase()),path+" missing "+book);
  }
  for(const level of ["EAP 1","EAP 2","EAP 3","EAP 4"]){
   assert.ok(html.includes(level),path+" missing "+level);
  }
  assert.ok(html.includes(monthly),path+" monthly fee missing");
  assert.ok(html.includes(semester),path+" two-month level fee missing");
  assert.match(html,/Cengage/);
  assert.match(html,/Pearson/);
   assert.ok(html.includes('href="'+path.replace("courses/academic-english/","admissions/")+'?program=academic-english"'),path+" EAP admissions CTA missing");
  assert.doesNotMatch(html,/خانه موفقیت|EAP 1 uses Active Skills for Reading 1|EAP 4 uses Contemporary Topics 4/);
 }
});
test("EAP preview remains unindexed, HEAD returns no body and no CMS records are mutated",async()=>{
 const before=JSON.stringify(main)+JSON.stringify(ps);
 const preview=await worker.fetch(new Request("https://preview.the-toefl-house.pages.dev/fa/courses/academic-english/"),env());
 assert.equal(preview.status,200);
 assert.match(preview.headers.get("X-Robots-Tag"),/noindex/);
 const h=await worker.fetch(new Request("https://the-toefl-house.pages.dev/ps/courses/academic-english/",{method:"HEAD"}),env());
 assert.equal(h.status,200);
 assert.equal(await h.text(),"");
 assert.equal(JSON.stringify(main)+JSON.stringify(ps),before,"published CMS object must not be changed");
});
test("New semester billboard promotes the EAP page directly on all three homepages",async()=>{
 for(const path of ["/","/fa/","/ps/"]){
  const r=await worker.fetch(new Request("https://the-toefl-house.pages.dev"+path),env());
  assert.equal(r.status,200);
  const html=await r.text();
  assert.match(html,/class="semester-eap-spotlight"/);
  assert.match(html,new RegExp('href="'+path+'courses/academic-english/"'));
  assert.ok(html.includes("EAP"));
  assert.ok(html.includes("2,000")||html.includes("۲٬۰۰۰"));
  assert.match(html,/id="semester-qaws-1405"/);
  assert.match(html,/class="semester-video" controls playsinline preload="none"/);
  assert.match(html,/href="\/(?:fa\/|ps\/)?admissions\/\?utm_source=website&amp;utm_campaign=qaws_1405_semester"/);
 }
});

test("EAP four levels retain three series while distinguishing publisher editions and book numbers",async()=>{
 for(const lang of ["/","/fa/","/ps/"]){
  const response=await worker.fetch(new Request("https://the-toefl-house.pages.dev"+lang+"courses/academic-english/"),env());
  assert.equal(response.status,200);
  const html=await response.text();
  const sections=[...html.matchAll(/<li class="eap-level">([\s\S]*?)(?=<li class="eap-level">|<\/ol>)/g)];
  assert.equal(sections.length,4,lang+" needs four distinct curriculum levels");
  for(let i=1;i<=4;i++){
   const block=sections[i-1][1];
   assert.match(block,new RegExp('EAP '+i));
   for(const name of ["ACTIVE Skills for Reading","Longman Academic Writing"]){
    assert.ok(block.includes(name+" "+i),lang+" "+name+" does not match EAP "+i);
   }
   assert.ok(block.includes("Third Edition"),lang+" needs Cengage verified third edition");
   assert.ok(block.includes("Updated release"),lang+" needs Longman updated release");
   assert.ok(block.includes(["2nd Edition","3rd Edition","4th Edition","5th Edition"][i-1]),lang+" must show current Longman edition for EAP "+i);
   assert.ok(block.includes("Contemporary Topics"),lang+" needs Contemporary Topics series");
   assert.ok(block.includes("Fourth Edition"),lang+" needs Pearson fourth edition");
   if(i<=3)assert.ok(block.includes("Contemporary Topics "+i),lang+" Pearson published books 1 to 3");
   else {
    assert.ok(!block.includes("Contemporary Topics 4"),lang+" must not invent a publisher book 4");
    assert.ok(block.includes('class="eap-fourth-note"'),lang+" must explain EAP4 book selection in the page language");
   }
   assert.equal((block.match(/<li dir="ltr" lang="en">/g)||[]).length,3,lang+" must show precisely three assigned books per EAP level");
  }
  assert.match(html,/Reading|خواندن|لوستل/);
  assert.match(html,/Vocabulary|واژگان|لغات|لغتونو/);
  assert.match(html,/Listening|شنیدن|اورېدو|اورېدل/);
  assert.match(html,/Speaking|مکالمه|خبرې/);
  assert.match(html,/Academic Writing|نگارش|لیکنه/);
  assert.match(html,/Longman Academic Writing 4: Essays/);
  assert.match(html,/۲٬۰۰۰ افغانی|AFN 2,000|۲٬۰۰۰ افغانۍ/);
 }
});

test("Published read-only API restores the exact public CMS contract in all languages",async()=>{
 const response=await worker.fetch(new Request("https://the-toefl-house.pages.dev/api/content"),env());
 assert.equal(response.status,200);
 assert.match(response.headers.get("Content-Type"),/application\/json/);
 assert.match(response.headers.get("X-Robots-Tag"),/noindex/);
 const publicContent=await response.json();
 assert.deepEqual(Object.keys(publicContent).sort(),["locales","media","timetable","revision","psRevision","updatedAt","cmsStatus"].sort());
 assert.equal(publicContent.cmsStatus,"connected");
 assert.equal(publicContent.revision,40);
 assert.equal(publicContent.psRevision,40);
 for(const l of ["en","fa","ps"])assert.equal(publicContent.locales[l].programs.length,7);
 assert.deepEqual(publicContent.locales.en.programs.map(p=>p.id),allIds);
 const head=await worker.fetch(new Request("https://the-toefl-house.pages.dev/api/content",{method:"HEAD"}),env());
 assert.equal(head.status,200);
 assert.equal(await head.text(),"");
});
test("Public CMS endpoint rejects protected fields and never leaks drafts",async()=>{
 const unsafe={...main,locales:{...main.locales,en:{...main.locales.en, password_hash:"secret-do-not-publish"}}};
 const bad=await worker.fetch(new Request("https://the-toefl-house.pages.dev/api/content"),env(unsafe,ps));
 assert.equal(bad.status,503);
 assert.ok(!(await bad.text()).includes("secret-do-not-publish"));
 const missing=await worker.fetch(new Request("https://the-toefl-house.pages.dev/api/content"),{});
 assert.equal(missing.status,503);
 const before=JSON.stringify(main)+JSON.stringify(ps);
 const normal=await worker.fetch(new Request("https://the-toefl-house.pages.dev/api/content"),env());
 assert.equal(normal.status,200);
 assert.equal(JSON.stringify(main)+JSON.stringify(ps),before,"GET may not mutate CMS fixtures");
});

test("Language selector labels and textbook pronunciation are accessible in all three languages",async()=>{
 for(const [path,label] of [["/","Choose language"],["/fa/","انتخاب زبان"],["/ps/","ژبه وټاکئ"]]){
  const home=await worker.fetch(new Request("https://the-toefl-house.pages.dev"+path),env());
  assert.equal(home.status,200);
  const html=await home.text();
  assert.ok(html.includes('class="language-links" role="group" aria-label="'+label+'">'),path+" chooser has invalid accessible label");
  const academic=await worker.fetch(new Request("https://the-toefl-house.pages.dev"+path+"courses/academic-english/"),env());
  assert.equal(academic.status,200);
  const eapHtml=await academic.text();
  assert.match(eapHtml,/<li dir="ltr" lang="en">ACTIVE Skills for Reading 1/);
  assert.match(eapHtml,/<h3 dir="ltr" lang="en">ACTIVE Skills for Reading/);
 }
});

test("Public pages expose canonical branded social previews in EN, Dari and Pashto",async()=>{
 for(const root of ["/","/fa/","/ps/"]){
  for(const route of ["","courses/academic-english/","admissions/"]){
   const path=root+route,source="https://the-toefl-house.pages.dev"+path;
   const res=await worker.fetch(new Request(source),env());
   assert.equal(res.status,200,path);
   const html=await res.text();
   assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'),path+" needs large preview card");
   assert.ok(html.includes('<meta property="og:site_name" content="The TOEFL House">'),path+" missing brand metadata");
   assert.match(html,/<meta property="og:image:alt" content="[^"]+">/);
   assert.ok(html.includes('<meta property="og:url" content="'+source+'">'),path+" missing canonical share URL");
  }
 }
});

test("Known retired anchors use current admissions, while unknown fragments never hijack visitors",async()=>{
 const {runInNewContext}=await import("node:vm");
 const client=await worker.fetch(new Request("https://the-toefl-house.pages.dev/__th/v2/site.js"),env());
 const source=await client.text();
 function visit(pathname,hash,hasTarget=false){
  const redirects=[];
  const location={pathname,hash,search:"",replace(value){redirects.push(value)}};
  const menu={querySelectorAll(){return []},open:false,contains(){return true}};
  const document={
   querySelector(selector){return selector===".mobile-menu"?menu:null},
   getElementById(id){return hasTarget&&id===hash.slice(1)?{}:null},
   addEventListener(){}
  };
  runInNewContext(source,{location,document,URLSearchParams,decodeURIComponent,sessionStorage:{setItem(){},getItem(){return null}}});
  return redirects;
 }
 for(const root of ["/","/fa/","/ps/"]){
  assert.deepEqual(visit(root,"#start"),[root+"admissions/"],root+" should restore admissions");
  assert.deepEqual(visit(root,"#advisor"),[root+"admissions/"],root+" should restore advisor");
  assert.deepEqual(visit(root,"#th-pathways"),[root+"#programs"],root+" should restore program list");
  assert.deepEqual(visit(root,"#new-campaign"),[],root+" unknown anchor must remain");
  assert.deepEqual(visit(root,"#start",true),[],root+" existing section must remain");
  assert.deepEqual(visit(root+"courses/academic-english/","#start"),[],root+" subpage fragment must remain");
 }
});
