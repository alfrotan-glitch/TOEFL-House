import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
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
  const r=await worker.fetch(new Request("https://toeflhouse.pages.dev"+route),env());
  assert.equal(r.status,200);
  assert.match(r.headers.get("Content-Type"),/text\/html/);
  assert.equal(r.headers.get("Content-Language"),lang);
  assert.equal(r.headers.get("X-Robots-Tag"),null);
  const html=await r.text();
  assert.match(html,new RegExp('<html lang="'+lang+'" dir="'+dir+'">'));
  assert.equal((html.match(/<h1>/g)||[]).length,1);
  assert.equal((html.match(/class="course-card /g)||[]).length,6);
  const eapCard=html.match(/<article id="course-academic-english" class="course-card [^"]*">([\s\S]*?)<\/article>/);
  assert.ok(eapCard,"EAP catalog card must exist");
  assert.match(eapCard[1],/<bdi class="course-full-name" lang="en" dir="ltr">EAP \(English for Academic Purposes\)<\/bdi>/);
  assert.ok(eapCard[1].includes('href="'+(route==="/"?"/":route)+'courses/academic-english/"'),"EAP link must retain locale");
  assert.match(html,/4 months|۴ ماه|څلور میاشتې/);
  assert.match(html,/v2\/site\.css/);
  assert.match(html,/v2\/site\.js/);
  assert.match(html,/engagement-v1\.js/);
  assert.match(html,/<link rel="canonical"/);
  assert.match(html,/https:\/\/toeflhouse\.pages\.dev/);
  assert.match(html,/footer-cta/);
  assert.doesNotMatch(html,/صنف‌های آموزشی دارای فیس|درسی ټولګي فیس لري|Tuition applies to courses|course tuition is separate|It does not make course tuition free/i);
  assert.doesNotMatch(html,/href="\/(?:fa\/|ps\/)?tools\/"/);
  assert.match(html,/href="\/(?:fa\/|ps\/)?admissions\/"/);
  assert.match(html,/<script type="application\/ld\+json">/);
  assert.doesNotMatch(html,/500 Internal Server Error/);
  assert.doesNotMatch(html,/the-toefl-house\\.pages\\.dev/);
  assert.doesNotMatch(html,/Figures reported by The TOEFL House|آمار منتشرشده توسط تافل هوس|د خانه موفقیت خپاره کړي شمېرې|The course itself is not free|01:01/,"No editorial/design leftovers in public content");
 });
}
test("Preview home is noindex but visible",async()=>{
 const r=await worker.fetch(new Request("https://v2.toeflhouse.pages.dev/fa/"),env());
 assert.equal(r.status,200);assert.match(r.headers.get("X-Robots-Tag"),/noindex/);
});
test("HEAD home does not download HTML",async()=>{
 const r=await worker.fetch(new Request("https://toeflhouse.pages.dev/ps/",{method:"HEAD"}),env());
 assert.equal(r.status,200);assert.equal(await r.text(),"");
});
test("new CSS, JS are local, security-hardened assets",async()=>{
 for(const [p,type] of [["site.css","text/css"],["site.js","javascript"]]){
  const r=await worker.fetch(new Request("https://toeflhouse.pages.dev/__th/v2/"+p),env());
  assert.equal(r.status,200);assert.match(r.headers.get("Content-Type"),new RegExp(type));
  assert.match(r.headers.get("X-Robots-Tag"),/noindex/);
  assert.ok((await r.text()).length>400);
 }
});
test("CMS DB failure keeps the standalone homepage available without an upstream proxy",async()=>{
 const orig=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response("retired origin must not be contacted",{status:500});};
 try{
  const r=await worker.fetch(new Request("https://toeflhouse.pages.dev/"),{});
  assert.equal(r.status,200);
  assert.match(await r.text(),/<h1>/);
  assert.equal(calls,0);
 }finally{globalThis.fetch=orig;}
});
test("V2 home does not reveal user data from CMS",async()=>{
 const r=await worker.fetch(new Request("https://toeflhouse.pages.dev/"),env());
 const html=await r.text();
 assert.ok(!html.includes("password_hash"));
 assert.ok(!html.includes("session_token"));
 assert.ok(!html.includes("admin_secret"));
});


for(const [prefix,lang] of [["/","en"],["/fa/","fa-AF"],["/ps/","ps-AF"]]){
 test("Course details preserve four-month TOEFL and semantic SEO in "+prefix,async()=>{
  const req=new Request("https://toeflhouse.pages.dev"+prefix+"courses/toefl-preparation/");
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
  const req=new Request("https://toeflhouse.pages.dev"+prefix+"admissions/?program=special-speaking");
  const r=await worker.fetch(req,env());
  assert.equal(r.status,200);
  const html=await r.text();
  assert.equal((html.match(/<h1>/g)||[]).length,1);
  assert.match(html,/id="v2-enquiry-form"/);
  assert.doesNotMatch(html,/Tuition is charged separately|فیس صنف‌های آموزشی جداگانه است|درسي ټولګي فیس لري|tuition is payable for courses|صنف‌ها فیس دارند|درسي ټولګي فیس لري/);
  if(prefix==="fa/")assert.ok(html.includes("Grammar (۱۶ درس)"),"Dari Special Speaking book details");
  if(prefix==="ps/")assert.ok(html.includes("Grammar ۱۶ درسي کتاب"),"Pashto Special Speaking book details");
  if(prefix==="")assert.ok(html.includes("16-lesson Grammar book"),"English Special Speaking book details");
  assert.match(html,/name="program"/);
  assert.match(html,/name="format"/);
  assert.match(html,/name="when"/);
  assert.match(html,/wa\.me\/93794357509/);
  assert.doesNotMatch(html,/<input[^>]+type="email"/);
  assert.doesNotMatch(html,/<input[^>]+type="password"/);
  assert.match(html,/<link rel="canonical"/);
 });
 test("Legacy tools route is safely disabled and noindexed in "+prefix,async()=>{
  const route=prefix+"tools/";
  const r=await worker.fetch(new Request("https://toeflhouse.pages.dev"+route),{});
  assert.equal(r.status,503);
  assert.match(await r.text(),/temporarily unavailable/i);
  assert.match(r.headers.get("X-Robots-Tag")||"",/noindex/);
 });
}

test("Course language switcher retains current program, and all subpage menu links target existing home anchors",async()=>{
 const r=await worker.fetch(new Request("https://toeflhouse.pages.dev/fa/courses/toefl-preparation/"),env());
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
 const r=await worker.fetch(new Request("https://toeflhouse.pages.dev/ps/admissions/"),env());
 const html=await r.text();
 assert.match(html,/href="\/admissions\/"/);
 assert.match(html,/href="\/fa\/admissions\/"/);
 assert.match(html,/href="\/ps\/admissions\/"/);
 assert.match(html,/href="\/ps\/#programs"/);
});

test("Public editor changes to address and hours appear in V2 footer without source rebuild",async()=>{
 const custom=structuredClone(main);
 custom.locales.fa.contact={title:"آدرس جدید کورس",address:"CMS_DYNAMIC_ADDRESS_QA",operatingHours:"CMS_DYNAMIC_HOURS_QA"};
 const r=await worker.fetch(new Request("https://toeflhouse.pages.dev/fa/"),env(custom));
 const html=await r.text();
 assert.match(html,/CMS_DYNAMIC_ADDRESS_QA/);
 assert.match(html,/CMS_DYNAMIC_HOURS_QA/);
 const d=await worker.fetch(new Request("https://toeflhouse.pages.dev/fa/courses/toefl-preparation/"),env(custom));
 const page=await d.text();
 assert.match(page,/CMS_DYNAMIC_ADDRESS_QA/);
 assert.match(page,/CMS_DYNAMIC_HOURS_QA/);
});
test("Both marketing assets use fingerprinted URLs so old CSS and JS cannot persist after release",async()=>{
 const r=await worker.fetch(new Request("https://toeflhouse.pages.dev/"),env());
 const html=await r.text();
 const css=html.match(/\/__th\/v2\/site\.css\?v=([a-f0-9]{12})/);
 const js=html.match(/\/__th\/v2\/site\.js\?v=([a-f0-9]{12})/);
 assert.ok(css,"Missing content-hash CSS");
 assert.ok(js,"Missing content-hash JS");
 assert.equal(css[1],js[1]);
 const file=await worker.fetch(new Request("https://toeflhouse.pages.dev/__th/v2/site.css?v="+css[1]),env());
 assert.equal(file.status,200);
 assert.match(file.headers.get("Cache-Control")||"",/immutable/);
});
test("Learning guides are reachable from main header and footer in all languages",async()=>{
 for(const prefix of ["/","/fa/","/ps/"]){
  const r=await worker.fetch(new Request("https://toeflhouse.pages.dev"+prefix),env());
  const html=await r.text();
  assert.ok(html.includes('href="'+prefix+'guides/"'),"Missing guides: "+prefix);
 }
});


test("Afghan Dari V2 public marketing uses the current TOEFL House name",async()=>{
 const home=await worker.fetch(new Request("https://toeflhouse.pages.dev/fa/"),env());
 const html=await home.text();
 assert.match(html,/<title>تافل هوس \| کورس زبان انگلیسی و آمادگی تافل در کابل<\/title>/);
 assert.match(html,/تافل هوس/);
 const admissions=await worker.fetch(new Request("https://toeflhouse.pages.dev/fa/admissions/"),env());
 assert.match(await admissions.text(),/تافل هوس/);
});

test("Malformed URL hash does not crash the student menu or enrolment script",async()=>{
 const {runInNewContext}=await import("node:vm");
 const client=await worker.fetch(new Request("https://toeflhouse.pages.dev/__th/v2/site.js"),env());
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
  const res=await worker.fetch(new Request("https://toeflhouse.pages.dev"+c.path),env());
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
  const res=await worker.fetch(new Request("https://toeflhouse.pages.dev"+route),env());
  assert.equal(res.status,200);
  const html=await res.text();
  assert.doesNotMatch(html,/id="general-english-details"/,route);
 }
});
test("General English course preview remains noindex and HEAD has no body",async()=>{
 const q=await worker.fetch(new Request("https://abc12345.toeflhouse.pages.dev/fa/courses/general-english/"),env());
 assert.equal(q.status,200);
 assert.match(q.headers.get("X-Robots-Tag"),/noindex/);
 const h=await worker.fetch(new Request("https://toeflhouse.pages.dev/ps/courses/general-english/",{method:"HEAD"}),env());
 assert.equal(h.status,200);
 assert.equal(await h.text(),"");
});

test("Published CMS historical name uses visitor brand without modifying saved data",async()=>{
 const fa=structuredClone(main);
 fa.locales.fa.faq.items[0].a="بلی، در خانه موفقیت تعیین سطح رایگان است.";
 const pashto=structuredClone(ps);
 pashto.faq.items[0].a="په خانه موفقیت کې د سویې معلومول وړیا دي.";
 const [faResponse,psResponse]=await Promise.all([
  worker.fetch(new Request("https://toeflhouse.pages.dev/fa/"),env(fa,pashto)),
  worker.fetch(new Request("https://toeflhouse.pages.dev/ps/"),env(fa,pashto))
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
  const response=await worker.fetch(new Request("https://toeflhouse.pages.dev"+path),env(updated,pashto));
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
  const r=await worker.fetch(new Request("https://toeflhouse.pages.dev"+path),env(e,p));
  const html=await r.text();
  assert.equal(r.status,200,path);
  assert.doesNotMatch(html,/6:20 AM–5:50 PM|۶:۲۰ صبح تا ۵:۵۰ شام|سهار ۶:۲۰ تر ماښام ۶:۰۰/);
  assert.match(html,/Confirm class times with admissions|وقت دقیق صنف را از پذیرش بپرسید|د ټولګي دقیق وخت له ادارې وپوښتئ/);
 }
 p.contact.hours="د نوې دورې مهالوېش CMS_EDITED_HOURS";
 const page=await worker.fetch(new Request("https://toeflhouse.pages.dev/ps/"),env(e,p));
 assert.match(await page.text(),/CMS_EDITED_HOURS/);
});

test("Homepage renders the published seven-shift timetable from CMS in all languages",async()=>{
 const shifts=[
  {id:"shift-1",timeEn:"Men 6:20 – 7:30 AM · Women 6:30 – 7:40 AM",timeFa:"برادران: ۶:۲۰ – ۷:۳۰ صبح · خواهران: ۶:۳۰ – ۷:۴۰ صبح",open:true,popular:true},
  {id:"shift-2",timeEn:"Men 7:50 – 9:00 AM · Women 8:00 – 9:10 AM",timeFa:"برادران: ۷:۵۰ – ۹:۰۰ صبح · خواهران: ۸:۰۰ – ۹:۱۰ صبح",open:true,popular:true},
  {id:"shift-3",timeEn:"Men 9:10 – 10:20 AM · Women 9:20 – 10:30 AM",timeFa:"برادران: ۹:۱۰ – ۱۰:۲۰ قبل از ظهر · خواهران: ۹:۲۰ – ۱۰:۳۰ قبل از ظهر",open:true,popular:false},
  {id:"shift-4",timeEn:"Men 10:30 – 11:40 AM · Women 10:40 – 11:50 AM",timeFa:"برادران: ۱۰:۳۰ – ۱۱:۴۰ قبل از ظهر · خواهران: ۱۰:۴۰ – ۱۱:۵۰ قبل از ظهر",open:true,popular:false},
  {id:"shift-5",timeEn:"Men 2:00 – 3:10 PM · Women 1:50 – 3:00 PM",timeFa:"برادران: ۲:۰۰ – ۳:۱۰ بعد از ظهر · خواهران: ۱:۵۰ – ۳:۰۰ بعد از ظهر",open:true,popular:true},
  {id:"shift-6",timeEn:"Men 3:20 – 4:30 PM · Women 3:10 – 4:20 PM",timeFa:"برادران: ۳:۲۰ – ۴:۳۰ عصر · خواهران: ۳:۱۰ – ۴:۲۰ عصر",open:true,popular:true},
  {id:"shift-7",timeEn:"Men 4:40 – 5:50 PM · Women 4:30 – 5:40 PM",timeFa:"برادران: ۴:۴۰ – ۵:۵۰ شام · خواهران: ۴:۳۰ – ۵:۴۰ شام",open:false,popular:true}
 ];
 const e=structuredClone(main);e.timetable=shifts;
 const cases=[
  ["/",["6:20 – 7:30 AM","6:30 – 7:40 AM","4:40 – 5:50 PM","4:30 – 5:40 PM","Shift 1","Shift 7"]],
  ["/fa/",["۶:۲۰ – ۷:۳۰ صبح","۶:۳۰ – ۷:۴۰ صبح","۴:۴۰ – ۵:۵۰ شام","۴:۳۰ – ۵:۴۰ شام","شیفت ۱","شیفت ۷"]],
  ["/ps/",["۶:۲۰ – ۷:۳۰ سهار","۶:۳۰ – ۷:۴۰ سهار","۴:۴۰ – ۵:۵۰ ماښام","۴:۳۰ – ۵:۴۰ ماښام","شفټ ۱","شفټ ۷"]]
 ];
 for(const [path,terms] of cases){
  const r=await worker.fetch(new Request("https://toeflhouse.pages.dev"+path),env(e,ps));
  assert.equal(r.status,200,path);
  const html=await r.text();
  assert.equal((html.match(/id="schedule"/g)||[]).length,1,path+" needs exactly one timetable section");
  assert.equal((html.match(/class="schedule-row/g)||[]).length,7,path+" needs seven shifts");
  assert.equal((html.match(/class="schedule-popular"/g)||[]).length,4,path+" needs four popular badges (closed shift 7 shows full instead)");
  assert.equal((html.match(/class="schedule-full"/g)||[]).length,1,path+" needs one closed shift");
  for(const term of terms)assert.ok(html.includes(term),path+" missing "+term);
 }
 const absent=await worker.fetch(new Request("https://toeflhouse.pages.dev/"),env());
 assert.doesNotMatch(await absent.text(),/id="schedule"/,"No timetable section without CMS timetable data");
});

test("Semester Qaws 1405 video announcement is visible, accessible and localised without autoplay",async()=>{
 for(const [path,lang,teaser] of [["/","en","New semester"],["/fa/","fa","سمستر قوس ۱۴۰۵"],["/ps/","ps","قوس ۱۴۰۵"]]){
  const r=await worker.fetch(new Request("https://toeflhouse.pages.dev"+path),env());
  const html=await r.text();
  assert.equal(r.status,200,path);
  assert.equal((html.match(/id="semester-qaws-1405"/g)||[]).length,1,path);
  assert.ok(html.includes(teaser),path+" does not show new semester offer");
  assert.match(html,/class="semester-video" controls playsinline preload="none" poster="\/assets\/aistudio\/FB_IMG_1793645643808_dad823ce\.jpg/);
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
 const r=await worker.fetch(new Request("https://toeflhouse.pages.dev/fa/"),env());
 assert.equal(r.status,200);
 const html=await r.text();
 assert.match(html,/<button class="semester-video-cover" type="button" hidden aria-label="ویدیو را تماشا کنید — پخش ویدیوی معرفی سمستر جدید"/);
 assert.match(html,/class="semester-play-circle"/);
 const client=await worker.fetch(new Request("https://toeflhouse.pages.dev/__th/v2/site.js"),env());
 const code=await client.text();
 assert.match(code,/semesterCover\.addEventListener\("click"/);
 assert.match(code,/semesterVideo\.play\(\)/);
 assert.match(code,/if\(restoreFocus\)semesterVideo\.focus\(\)/);
 assert.doesNotMatch(code,/semesterVideo\.autoplay\s*=\s*true/);
});


test("EAP is a complete, stand-alone multilingual academic guide with owner-confirmed tuition",async()=>{
 const cases=[
  ["/courses/academic-english/","en","AFN 1,000","AFN 2,000"],
  ["/fa/courses/academic-english/","fa-AF","۱٬۰۰۰ افغانی","۲٬۰۰۰ افغانی"],
  ["/ps/courses/academic-english/","ps-AF","۱٬۰۰۰ افغانۍ","۲٬۰۰۰ افغانۍ"]
 ];
 for(const [path,lang,monthly,semester] of cases){
  const result=await worker.fetch(new Request("https://toeflhouse.pages.dev"+path),env());
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
 const preview=await worker.fetch(new Request("https://preview.toeflhouse.pages.dev/fa/courses/academic-english/"),env());
 assert.equal(preview.status,200);
 assert.match(preview.headers.get("X-Robots-Tag"),/noindex/);
 const h=await worker.fetch(new Request("https://toeflhouse.pages.dev/ps/courses/academic-english/",{method:"HEAD"}),env());
 assert.equal(h.status,200);
 assert.equal(await h.text(),"");
 assert.equal(JSON.stringify(main)+JSON.stringify(ps),before,"published CMS object must not be changed");
});
test("New semester billboard promotes the EAP page directly on all three homepages",async()=>{
 for(const path of ["/","/fa/","/ps/"]){
  const r=await worker.fetch(new Request("https://toeflhouse.pages.dev"+path),env());
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
  const response=await worker.fetch(new Request("https://toeflhouse.pages.dev"+lang+"courses/academic-english/"),env());
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
 const response=await worker.fetch(new Request("https://toeflhouse.pages.dev/api/content"),env());
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
 const head=await worker.fetch(new Request("https://toeflhouse.pages.dev/api/content",{method:"HEAD"}),env());
 assert.equal(head.status,200);
 assert.equal(await head.text(),"");
});
test("Public CMS endpoint rejects protected fields and never leaks drafts",async()=>{
 const unsafe={...main,locales:{...main.locales,en:{...main.locales.en, password_hash:"secret-do-not-publish"}}};
 const bad=await worker.fetch(new Request("https://toeflhouse.pages.dev/api/content"),env(unsafe,ps));
 assert.equal(bad.status,200);
 const safe=await bad.text();
 assert.ok(safe.includes('"cmsStatus":"connected"'));
 assert.ok(!safe.includes("secret-do-not-publish"));
 const missing=await worker.fetch(new Request("https://toeflhouse.pages.dev/api/content"),{});
 assert.equal(missing.status,503);
 const before=JSON.stringify(main)+JSON.stringify(ps);
 const normal=await worker.fetch(new Request("https://toeflhouse.pages.dev/api/content"),env());
 assert.equal(normal.status,200);
 assert.equal(JSON.stringify(main)+JSON.stringify(ps),before,"GET may not mutate CMS fixtures");
});

test("Language selector labels and textbook pronunciation are accessible in all three languages",async()=>{
 for(const [path,label] of [["/","Choose language"],["/fa/","انتخاب زبان"],["/ps/","ژبه وټاکئ"]]){
  const home=await worker.fetch(new Request("https://toeflhouse.pages.dev"+path),env());
  assert.equal(home.status,200);
  const html=await home.text();
  assert.ok(html.includes('class="language-links" role="group" aria-label="'+label+'">'),path+" chooser has invalid accessible label");
  const academic=await worker.fetch(new Request("https://toeflhouse.pages.dev"+path+"courses/academic-english/"),env());
  assert.equal(academic.status,200);
  const eapHtml=await academic.text();
  assert.match(eapHtml,/<li dir="ltr" lang="en">ACTIVE Skills for Reading 1/);
  assert.match(eapHtml,/<h3 dir="ltr" lang="en">ACTIVE Skills for Reading/);
 }
});

test("Public pages expose canonical branded social previews in EN, Dari and Pashto",async()=>{
 for(const root of ["/","/fa/","/ps/"]){
  for(const route of ["","courses/academic-english/","admissions/"]){
   const path=root+route,source="https://toeflhouse.pages.dev"+path;
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
 const client=await worker.fetch(new Request("https://toeflhouse.pages.dev/__th/v2/site.js"),env());
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

test("Dari and Pashto course breadcrumbs announce a localized navigation name",async()=>{
 for(const [prefix,label] of [["/","Breadcrumb"],["/fa/","مسیر دسترسی به صفحه"],["/ps/","د پاڼې د لاسرسي لاره"]]){
  for(const section of ["courses/academic-english/","courses/toefl-preparation/"]){
   const response=await worker.fetch(new Request("https://toeflhouse.pages.dev"+prefix+section),env());
   assert.equal(response.status,200);
   const html=await response.text();
   assert.ok(html.includes('class="breadcrumbs" aria-label="'+label+'"'),prefix+section+" breadcrumb not translated");
  }
 }
});

test("Program tiles expose a full tap target, and EAP level order is stable in RTL",async()=>{
 const cssResponse=await worker.fetch(new Request("https://toeflhouse.pages.dev/__th/v2/site.css"),env());
 assert.equal(cssResponse.status,200);
 const css=await cssResponse.text();
 assert.ok(css.includes('.course-card{position:relative}.course-bottom a::after{content:"";position:absolute;inset:0}'));
 for(const root of ["/","/fa/","/ps/"]){
  const response=await worker.fetch(new Request("https://toeflhouse.pages.dev"+root+"courses/academic-english/"),env());
  assert.equal(response.status,200);
  const html=await response.text();
  assert.match(html,/<span class="eap-visual-number" dir="ltr">01 — 04<\/span>/);
 }
});

test("Special Speaking course pages use verified two-month curriculum and semester fee in all languages",async()=>{
 const langs=[["/","en","AFN 2,000"],["/fa/","fa-AF","۲٬۰۰۰ افغانی"],["/ps/","ps-AF","۲٬۰۰۰ افغانۍ"]];
 for(const [prefix,lang,tuition] of langs){
  const url="https://toeflhouse.pages.dev"+prefix+"courses/special-speaking/";
  const res=await worker.fetch(new Request(url),env());
  assert.equal(res.status,200,prefix);
  assert.equal(res.headers.get("Content-Language"),lang,prefix);
  const html=await res.text();
  assert.equal((html.match(/<h1>/g)||[]).length,1);
  assert.ok(html.includes(tuition),prefix+" must disclose full-semester fee");
  assert.ok(html.includes("Master Speaking")&&html.includes("Grammar for Special Speaking"),prefix+" missing both school books");
  assert.ok(html.includes("16")||html.includes("۱۶"),prefix+" must document 16 grammar lessons");
  assert.match(html,/P2M/);
  assert.match(html,/"price":"2000","priceCurrency":"AFN"/);
  assert.match(html,/v2\/site.css\?v=/);
  assert.match(html,/class="eap-faq-list"/);
  assert.ok(html.includes('href="'+prefix+'admissions/?program=special-speaking"'));
  assert.ok(html.includes('<meta property="og:url" content="'+url+'">'));
  const head=await worker.fetch(new Request(url,{method:"HEAD"}),env());
  assert.equal(head.status,200);
  assert.equal(await head.text(),"");
 }
});

test("TOEFL 2026 course describes all current ETS tasks, four months, and 1–6 scores, not old exam",async()=>{
 const categories=["Complete the Words","Read in Daily Life","Read an Academic Passage",
 "Listen and Choose a Response","Listen to a Conversation","Listen to an Announcement","Listen to an Academic Talk",
 "Build a Sentence","Write an Email","Write for an Academic Discussion",
 "Listen and Repeat","Take an Interview"];
 for(const root of ["/","/fa/","/ps/"]){
  const url="https://toeflhouse.pages.dev"+root+"courses/toefl-preparation/";
  const response=await worker.fetch(new Request(url),env());
  assert.equal(response.status,200,root);
  const html=await response.text();
  assert.equal((html.match(/<h1>/g)||[]).length,1);
  for(const category of categories)assert.ok(html.includes(category),root+" missing "+category);
  assert.match(html,/P4M/);
  assert.match(html,/2026|۲۰۲۶/);
  assert.match(html,/1–6|۱ تا ۶|۱ تر ۶/);
  assert.ok(html.includes("ets.org/toefl/test-takers/ibt/about/content.html"),"must link to primary ETS source");
  assert.doesNotMatch(html,/"price":"2000"/,root+" must not invent TOEFL Preparation tuition");
  assert.ok(html.includes('href="'+root+'admissions/?program=toefl-preparation"'));
  assert.ok(html.includes('<meta property="og:url" content="'+url+'">'));
  assert.equal((html.match(/class="eap-faq-plus"/g)||[]).length,5,"must answer five current exam questions");
 }
});

test("Home programme cards disclose the owner-approved speaking semester fee and updated TOEFL",async()=>{
 for(const root of ["/","/fa/","/ps/"]){
  const r=await worker.fetch(new Request("https://toeflhouse.pages.dev"+root),env());
  assert.equal(r.status,200);
  const html=await r.text();
  assert.ok(html.includes("Master Speaking"),root+" card missing authentic school text");
  assert.ok(html.includes("2026")||html.includes("۲۰۲۶"),root+" card missing 2026 TOEFL update");
  assert.match(html,/2,000|۲٬۰۰۰/);
  assert.ok(html.includes('href="'+root+'courses/special-speaking/"'));
  assert.ok(html.includes('href="'+root+'courses/toefl-preparation/"'));
 }
});

test("High-visibility mobile admissions action exists on every language and preserves the selected course",async()=>{
 const cases=[["/","Free assessment"],["/fa/","تعیین سطح"],["/ps/","وړیا ارزونه"]];
 for(const [root,label] of cases){
  const home=await worker.fetch(new Request("https://toeflhouse.pages.dev"+root),env());
  assert.equal(home.status,200);
  const html=await home.text();
  assert.match(html,new RegExp('class="mobile-quick-apply" href="'+root+'admissions/"'));
  assert.ok(html.includes('>'+label+'</a>'),root+" missing localized mobile CTA");
  for(const id of ["special-speaking","toefl-preparation","academic-english"]){
   const course=await worker.fetch(new Request("https://toeflhouse.pages.dev"+root+"courses/"+id+"/"),env());
   assert.equal(course.status,200,root+id);
   const page=await course.text();
   assert.ok(page.includes('class="mobile-quick-apply" href="'+root+'admissions/?program='+id+'"'),root+id+" mobile context lost");
   assert.ok(page.includes('class="button button-primary desktop-apply" href="'+root+'admissions/?program='+id+'"'),root+id+" desktop context lost");
  }
 }
});

test("Premium header uses CSS sticky layout and maintains usable mobile touch targets",async()=>{
 const r=await worker.fetch(new Request("https://toeflhouse.pages.dev/__th/v2/site.css"),env());
 assert.equal(r.status,200);
 const css=await r.text();
 assert.ok(css.includes('.site-header{position:sticky;'),"header must stay available when navigating long course pages");
 assert.ok(css.includes('.mobile-quick-apply{display:inline-flex;'),"mobile CTA must not be hidden");
 assert.ok(css.includes('.mobile-menu nav{max-height:'),"long translated navigation needs bounded height");
 assert.ok(css.includes('@media(forced-colors:active)'),"respect Windows high-contrast users");
});

test("Goal-first discovery is localized and routes visitors to actual program cards",async()=>{
 const cases=[
  ["/","Explore English programs by goal",["Start with the foundations","Speak with confidence","Prepare for university","Prepare for TOEFL"]],
  ["/fa/","انتخاب برنامه بر اساس هدف آموزشی",["از پایه شروع کنم","با اطمینان صحبت کنم","برای دانشگاه آماده شوم","برای TOEFL آماده شوم"]],
  ["/ps/","د زده‌کړې د موخې له مخې د پروګرام ټاکنه",["له بنسټ څخه پیل کوم","په ډاډه زړه خبرې کوم","پوهنتون ته چمتو کېږم","TOEFL ته چمتو کېږم"]]
 ];
 const goals=["general-english","special-speaking","academic-english","toefl-preparation"];
 for(const [root,label,phrases] of cases){
  const response=await worker.fetch(new Request("https://toeflhouse.pages.dev"+root),env());
  assert.equal(response.status,200,root);
  const html=await response.text();
  assert.ok(html.includes('class="goal-finder" aria-label="'+label+'"'),root+" missing accessible localized discoverability");
  for(let i=0;i<goals.length;i++){
   assert.ok(html.includes('href="#course-'+goals[i]+'"'),root+" unlinked course goal "+goals[i]);
   assert.ok(html.includes('id="course-'+goals[i]+'" class="course-card '),root+" missing goal anchor");
   assert.ok(html.includes(phrases[i]),root+" missing native language goal label");
  }
  const goalMatches=[...html.matchAll(/href="#course-(general-english|special-speaking|academic-english|toefl-preparation)"/g)];
  assert.equal(goalMatches.length,4,root+" should contain exactly four goal pathways");
  assert.equal((html.match(/class="course-card /g)||[]).length,6,root+" must retain all six programs");
 }
});

test("Sticky navigation offsets preserve focused anchors and goal controls have touch targets",async()=>{
 const response=await worker.fetch(new Request("https://toeflhouse.pages.dev/__th/v2/site.css"),env());
 assert.equal(response.status,200);
 const css=await response.text();
 assert.ok(css.includes("html{scroll-padding-top:112px}"));
 assert.ok(css.includes(".course-card[id]:target{outline:3px"),"target card must visibly respond to navigation");
 assert.ok(css.includes(".goal-finder-links a{min-height:44px"),"quick goals need large targets");
 assert.ok(css.includes(".goal-finder-links{display:grid;grid-template-columns:"),"mobile goals must reflow responsively");
});

test("International SEO declares the English fallback on every trilingual course and admissions page",async()=>{
 for(const root of ["/","/fa/","/ps/"]){
  for(const path of ["courses/special-speaking/","courses/toefl-preparation/","courses/academic-english/","admissions/"]){
   const url="https://toeflhouse.pages.dev"+root+path;
   const response=await worker.fetch(new Request(url),env());
   assert.equal(response.status,200,root+path);
   const html=await response.text();
   assert.ok(html.includes('<link rel="canonical" href="'+url+'">'),url+" canonical");
   assert.ok(html.includes('<link rel="alternate" hreflang="x-default" href="https://toeflhouse.pages.dev/'+path+'">'),url+" default international alternate");
   for(const [tag,prefix] of [["en","/"],["fa-AF","/fa/"],["ps-AF","/ps/"]]){
    assert.ok(html.includes('<link rel="alternate" hreflang="'+tag+'" href="https://toeflhouse.pages.dev'+prefix+path+'">'),url+" locale "+tag);
   }
  }
 }
});

test("Home publishes six genuine localized courses in valid search structured data",async()=>{
 const expected=["general-english","academic-english","toefl-preparation","special-speaking","professional-writing","teacher-training"];
 for(const prefix of ["/","/fa/","/ps/"]){
  const r=await worker.fetch(new Request("https://toeflhouse.pages.dev"+prefix),env());
  assert.equal(r.status,200);
  const html=await r.text();
  const match=html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(match,prefix+" lacks structured data");
  const nodes=JSON.parse(match[1]);
  assert.ok(Array.isArray(nodes),prefix+" must expose Organization and ItemList");
  assert.equal(nodes[0]["@type"],"EducationalOrganization");
  const list=nodes.find(x=>x["@type"]==="ItemList");
  assert.ok(list,"course list missing");
  assert.equal(list.itemListElement.length,6);
  for(let i=0;i<expected.length;i++){
   const row=list.itemListElement[i],url="https://toeflhouse.pages.dev"+prefix+"courses/"+expected[i]+"/";
   assert.equal(row.position,i+1);
   assert.equal(row.url,url);
   assert.equal(row.item["@type"],"Course");
   assert.equal(row.item.url,url);
   assert.ok(row.item.name.length>=3);
   assert.ok(row.item.description.length>=10);
   assert.equal(row.item.provider.name,"The TOEFL House");
  }
  assert.equal(list.itemListElement.some(x=>x.url.includes("online-individual-zoom")),false,"online is a format not a seventh course");
 }
});

test("Admissions displays the actual verified fee and never invents TOEFL tuition",async()=>{
 const checks=[
  ["/",["AFN 500","AFN 1,000","AFN 2,000","Four-month preparation"]],
  ["/fa/",["۵۰۰ افغانی","۱٬۰۰۰ افغانی","۲٬۰۰۰ افغانی","چهارماهه"]],
  ["/ps/",["۵۰۰ افغانۍ","۱٬۰۰۰ افغانۍ","۲٬۰۰۰ افغانۍ","څلور میاشتنی"]]
 ];
 for(const [root,terms] of checks){
  const r=await worker.fetch(new Request("https://toeflhouse.pages.dev"+root+"admissions/"),env());
  assert.equal(r.status,200);
  const body=await r.text();
  assert.ok(body.includes('id="v2-program-preview" role="status" aria-live="polite" hidden'),root+" missing accessible summary");
  for(const term of terms)assert.ok(body.includes(term),root+" missing "+term);
  const toe=body.match(/<option value="toefl-preparation" data-summary="([^"]+)"/);
  assert.ok(toe,root+" missing TOEFL program");
  assert.ok(!/AFN [0-9]|فیس [۰-۹]|فیس: [۰-۹]/.test(toe[1]),root+" must not invent TOEFL tuition");
  assert.ok(body.includes('value="special-speaking" data-summary="'),root+" speaking facts missing");
 }
});

test("Course cards use concise localized headings, whole-card native hit areas, and descriptive campus images",async()=>{
 const expected=[
  ["/","en_US","Exterior of The TOEFL House campus in Dasht-e-Barchi, Kabul","Special Speaking"],
  ["/fa/","fa_AF","نمای ساختمان تافل هوس در دشت برچی، کابل","مکالمهٔ ویژه"],
  ["/ps/","ps_AF","د کابل په دشت برچي کې د تافل هوس د ودانۍ بڼه","ځانګړې خبرې"]
 ];
 for(const [root,ogLocale,photoAlt,speakingTitle] of expected){
  const response=await worker.fetch(new Request("https://toeflhouse.pages.dev"+root),env());
  assert.equal(response.status,200);
  const page=await response.text();
  assert.ok(page.includes('<meta property="og:locale" content="'+ogLocale+'">'),root+" missing correct OpenGraph locale");
  assert.ok(page.includes('alt="'+photoAlt+'" loading="lazy"'),root+" campus image requires meaningful native language alt");
  const card=page.match(/<article id="course-special-speaking" class="course-card [^"]*">([\s\S]*?)<\/article>/);
  assert.ok(card,root+" missing Special Speaking card");
  assert.ok(card[1].includes("<h3>"+speakingTitle+"</h3>"),root+" course card title too verbose");
  assert.ok(card[1].includes('href="'+root+'courses/special-speaking/"'),root+" card must keep direct navigation without scripts");
  const admissions=await worker.fetch(new Request("https://toeflhouse.pages.dev"+root+"admissions/"),env());
  assert.equal(admissions.status,200);
  const form=await admissions.text();
  assert.ok(form.includes('<meta property="og:locale" content="'+ogLocale+'">'),root+" admissions OG locale");
  assert.ok(form.includes('alt="'+photoAlt+'" loading="lazy"'),root+" admissions campus photo needs descriptive alt");
 }
 const cssResponse=await worker.fetch(new Request("https://toeflhouse.pages.dev/__th/v2/site.css"),env());
 assert.equal(cssResponse.status,200);
 const css=await cssResponse.text();
 assert.ok(css.includes(".course-card{position:relative;cursor:pointer"),"whole-card click needs positioned card");
 assert.ok(css.includes('.course-bottom a::after{content:"";position:absolute;inset:0;z-index:1'),"native link must have a full-card hit area");
 assert.ok(css.includes(".course-card:focus-within"),"keyboard focus must reveal the selected card");
});

test("Dari editorial keeps standard Peh and says university; Pashto remains unchanged",async()=>{
 const d=structuredClone(main);
 d.locales.fa.programs[4].summary="برای محصلان پوهنتونی و تحصیل در پوهنتون‌های جهان.";
 d.locales.fa.stats.universityLabel="پذیرش پوهنتونی";
 const dari=await worker.fetch(new Request("https://toeflhouse.pages.dev/fa/"),env(d,ps));
 assert.equal(dari.status,200);
 const html=await dari.text();
 assert.ok(html.includes("دانشگاه‌های جهان"),"CMS Dari output must use edited university term");
 assert.ok(html.includes("پذیرش دانشگاهی"),"Dari compound form should be grammatically correct");
 assert.ok(html.includes("روبه‌روی مرکز جلیلی"),"Dari campus address uses standard spelling");
 assert.equal(html.includes("روبروی مرکز جلیلی"),false,"legacy address spelling is normalized");
 assert.ok(html.includes("برای دانشگاه آماده شوم"),"new Dari discovery choice");
 assert.equal(html.includes("پوهنتون"),false,"no Pashto university noun in Dari HTML");
 assert.equal("پرسش‌های".codePointAt(0),0x067e,"Peh must remain U+067E");
 const pashto=await worker.fetch(new Request("https://toeflhouse.pages.dev/ps/"),env(d,ps));
 assert.equal(pashto.status,200);
 assert.match(await pashto.text(),/پوهنتون/,"Pashto vocabulary must not be changed");
 const academic=await worker.fetch(new Request("https://toeflhouse.pages.dev/fa/courses/academic-english/"),env(d,ps));
 assert.equal(academic.status,200);
 const academicHtml=await academic.text();
 assert.equal(academicHtml.includes("پوهنتون"),false);
 assert.ok(academicHtml.includes("دانشگاه"));
});
test("Dari font is localized and mobile FAQ has a readable compact layout",async()=>{
 const r=await worker.fetch(new Request("https://toeflhouse.pages.dev/__th/v2/site.css"),env());
 assert.equal(r.status,200);
 const css=await r.text();
 assert.match(css,/font-family:THDari;src:url\("\/__th\/v2\/font\/vazirmatn-33\.003\.woff2"\)/);
 assert.ok(css.includes("html[lang=fa-AF] body{font-family:THDari"),"Dari only");
 assert.ok(css.includes('html[dir=rtl] body{font-family:Tahoma,"Noto Sans Arabic",Arial,sans-serif'),"Pashto uses a stable Arabic-script fallback");
 assert.ok(css.includes(".faq-section.section{padding:54px 0 64px}"),"FAQ section compact on phones");
});

test("Unknown paths return a branded trilingual 404 page, not bare text",async()=>{
 const cases=[["/no-such-page/","en","Page not found","Back to the homepage","/"],["/fa/no-such-page/","fa-AF","صفحه پیدا نشد","بازگشت به صفحهٔ اصلی","/fa/"],["/ps/no-such-page/","ps-AF","پاڼه ونه موندل شوه","کورپاڼې ته لاړ شئ","/ps/"]];
 for(const [path,lang,title,home,homeHref] of cases){
  const r=await worker.fetch(new Request("https://toeflhouse.pages.dev"+path),env());
  assert.equal(r.status,404,path);
  assert.match(r.headers.get("Content-Type"),/text\/html/);
  assert.equal(r.headers.get("Content-Language"),lang,path);
  assert.match(r.headers.get("X-Robots-Tag"),/noindex/);
  const html=await r.text();
  assert.ok(html.length>2000,path+" 404 must be a full page, not bare text");
  assert.equal((html.match(/<h1>/g)||[]).length,1,path+" must have exactly one h1");
  assert.ok(html.includes(title),path+" missing localized title");
  assert.ok(html.includes('class="site-header"'),path+" missing branded header");
  assert.ok(html.includes('href="'+homeHref+'"'),path+" missing home link");
  assert.ok(html.includes(home),path+" missing home button label");
  assert.ok(html.includes('class="notfound-code"'),path+" missing 404 mark");
  assert.ok(html.includes('href="/404/"')&&html.includes('href="/fa/404/"')&&html.includes('href="/ps/404/"'),path+" language switcher must stay on the 404 page");
  assert.doesNotMatch(html,/<link rel="canonical"/,path+" 404 must not carry a canonical URL");
  assert.doesNotMatch(html,/the-toefl-house\\.pages\\.dev/,path+" 404 must not reference the retired address");
 }
});

test("HEAD and non-GET unknown paths still fail safely",async()=>{
 const head=await worker.fetch(new Request("https://toeflhouse.pages.dev/no-such-page/",{method:"HEAD"}),env());
 assert.equal(head.status,404);
 assert.equal(await head.text(),"");
 const post=await worker.fetch(new Request("https://toeflhouse.pages.dev/api/private/action",{method:"POST",headers:{"Content-Type":"application/json"},body:'{"test":true}'}),env());
 assert.equal(post.status,404);
 assert.equal(await post.text(),"Not found");
});

test("Retired anchor-only routes show the branded 404",async()=>{
 for(const path of ["/online/","/contact/","/faq/"]){
  const r=await worker.fetch(new Request("https://toeflhouse.pages.dev"+path),env());
  assert.equal(r.status,404,path);
  const html=await r.text();
  assert.ok(html.includes('class="site-header"'),path+" must show the branded 404");
  assert.ok(html.includes("Page not found"),path+" must carry the 404 heading");
 }
});

test("Sitemap carries a truthful lastmod on every URL",async()=>{
 const r=await worker.fetch(new Request("https://toeflhouse.pages.dev/sitemap.xml"),env());
 assert.equal(r.status,200);
 const xml=await r.text();
 assert.equal((xml.match(/<loc>/g)||[]).length,39);
 const lastmods=xml.match(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g)||[];
 assert.equal(lastmods.length,39,"every sitemap URL must carry lastmod");
 assert.equal(new Set(lastmods).size,1,"all lastmod dates must be the single build date");
 const date=lastmods[0].replace(/<\/?lastmod>/g,"");
 assert.ok(!Number.isNaN(Date.parse(date+"T00:00:00Z")),"lastmod must be a valid date");
 assert.ok(Date.parse(date+"T00:00:00Z")<=Date.now(),"lastmod must not be in the future");
});

test("TOEFL Listening tasks render as separate lines in English; FA/PS bilingual lines unchanged",async()=>{
 const en=await worker.fetch(new Request("https://toeflhouse.pages.dev/courses/toefl-preparation/"),env());
 assert.equal(en.status,200);
 const enHtml=await en.text();
 assert.ok(enHtml.includes("<li>Listen to an Announcement</li>"),"Announcement must be its own list item");
 assert.ok(enHtml.includes("<li>Listen to an Academic Talk</li>"),"Academic Talk must be its own list item");
 assert.doesNotMatch(enHtml,/Listen to an Announcement; Listen to an Academic Talk/,"the semicolon join must be gone");
 const fa=await worker.fetch(new Request("https://toeflhouse.pages.dev/fa/courses/toefl-preparation/"),env());
 assert.ok((await fa.text()).includes("Listen to an Announcement و Listen to an Academic Talk"),"FA bilingual line must be untouched");
 const ps=await worker.fetch(new Request("https://toeflhouse.pages.dev/ps/courses/toefl-preparation/"),env());
 assert.ok((await ps.text()).includes("Listen to an Announcement او Listen to an Academic Talk"),"PS bilingual line must be untouched");
});


test("Google Meet copy across three languages preserves legacy online routes and identifiers",async()=>{
 const m=structuredClone(main),p=structuredClone(ps);
 for(const locale of [m.locales.en,m.locales.fa,p]){
  const program=locale.programs.find(x=>x.id==="online-individual-zoom");
  program.title="Private Zoom classes";program.summary="Live Zoom lessons";program.details="Live Zoom lessons";program.highlights=["Zoom practice"];
 }
 for(const prefix of ["/","/fa/","/ps/"]){
  for(const path of [prefix,prefix+"admissions/?program=online-individual-zoom",prefix+"courses/online-individual-zoom/"]){
   const r=await worker.fetch(new Request("https://toeflhouse.pages.dev"+path),env(m,p));
   assert.equal(r.status,200,path);
   const h=await r.text();
   assert.match(h,/Google Meet/,path);
   assert.doesNotMatch(h,/(?<![\w-])Zoom(?![\w-])/i,path);
   if(path.endsWith("online-individual-zoom/"))assert.match(h,/online-individual-zoom/);
  }
 }
 const r=await worker.fetch(new Request("https://toeflhouse.pages.dev/api/content"),env(m,p));
 assert.equal(r.status,200);
 const data=await r.json();
 for(const locale of Object.values(data.locales)){
  const item=locale.programs.find(x=>x.id==="online-individual-zoom");
  assert.equal(item.title,"Private Google Meet classes");assert.equal(item.highlights[0],"Google Meet practice");
 }
});

test("Desktop-only image preload and revision-qualified cache lifetime",async()=>{
 const root=await worker.fetch(new Request("https://toeflhouse.pages.dev/"),env());
 const html=await root.text();
 assert.match(html,/<link rel="preload" media="\(min-width: 761px\)"[^>]+as="image"/);
 const rev=html.match(/site\.css\?v=([a-f0-9]{12})/)[1];
 for(const path of ["site.css","site.js"]){
  const versioned=await worker.fetch(new Request("https://toeflhouse.pages.dev/__th/v2/"+path+"?v="+rev),env());
  assert.match(versioned.headers.get("Cache-Control"),/max-age=31536000/);
  for(const suffix of ["","?v=outdated"]){
   const stale=await worker.fetch(new Request("https://toeflhouse.pages.dev/__th/v2/"+path+suffix),env());
   assert.match(stale.headers.get("Cache-Control"),/max-age=3600/);
  }
 }
});


test("Public design system uses only approved red, white and neutral colors",async()=>{
 const r=await worker.fetch(new Request("https://toeflhouse.pages.dev/__th/v2/site.css"),env());
 assert.equal(r.status,200);
 const css=await r.text();
 const allowed=new Set(["ffffff","faf9f8","f4f2f1","e5e1e1","d0cacc","bcb4b9","a6a0a2","817b7d","6a6568","55555b","424247","292629","242427","171719","fff3f3","fde8e9","f8d7dc","ffb3bf","e85c6f","e30613","c00818","980616","690912"]);
 for(const match of css.matchAll(/#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-f])/gi)){
  const hex=match[1].toLowerCase();
  const base=hex.length===3?hex.split("").map(c=>c+c).join(""):hex.slice(0,6);
  assert.ok(allowed.has(base),"Unapproved public UI color: "+match[0]);
 }
 assert.match(css,/\.detail-summary\{background:#fff;color:var\(--ink\);border:1px solid var\(--line\);border-inline-start:4px solid var\(--red\)/);
 assert.match(css,/\.detail-summary li::before\{[^}]*background:var\(--red\);color:#fff/);
 assert.match(css,/\.online-panel\{background:linear-gradient\(125deg,var\(--red-dark\),var\(--red\)\)/);
 assert.match(css,/\.footer\{background:var\(--red-dark\)/);
});

test("Shared logo preserves exact artwork, versioned caching and preview indexing rules",async()=>{
 const url="https://toeflhouse.pages.dev/__th/v2/brand.webp?v=753895f6e945";
 for(const root of ["/","/fa/","/ps/"])for(const route of [root,root+"admissions/"]){
  const response=await worker.fetch(new Request("https://toeflhouse.pages.dev"+route),env());
  const html=await response.text();
  assert.ok(html.includes('rel="icon" href="/__th/v2/brand.webp?v=753895f6e945"'),route);
  assert.ok(html.includes('src="/__th/v2/brand.webp?v=753895f6e945"'),route);
  assert.ok(!html.includes("data:image/webp;base64,"),route);
 }
 const logo=await worker.fetch(new Request(url),env());
 assert.equal(logo.status,200);
 assert.equal(logo.headers.get("content-type"),"image/webp");
 assert.match(logo.headers.get("cache-control"),/max-age=31536000/);
 assert.equal(logo.headers.get("x-robots-tag"),null);
 const bytes=Buffer.from(await logo.arrayBuffer());
 assert.equal(bytes.length,13814);
 assert.equal(createHash("sha256").update(bytes).digest("hex"),"753895f6e9453eb62d4ee6feab020570d0c4113ac8263a417e6588fe55560e1e");
 const head=await worker.fetch(new Request(url,{method:"HEAD"}),env());
 assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);
 const old=await worker.fetch(new Request(url.replace("753895f6e945","stale")),env());
 assert.match(old.headers.get("cache-control"),/max-age=3600/);
 const preview=await worker.fetch(new Request(url.replace("https://toeflhouse","https://test-preview.toeflhouse")),env());
 assert.match(preview.headers.get("x-robots-tag"),/noindex/);
});
