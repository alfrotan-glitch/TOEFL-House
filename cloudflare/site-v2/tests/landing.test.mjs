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
