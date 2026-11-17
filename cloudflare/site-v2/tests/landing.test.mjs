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
function env(){
 return{CMS_DB:{prepare(sql){
  assert.match(sql,/SELECT body,revision/);
  reads.push(sql);
  return{async first(){return {body:JSON.stringify(sql.includes("pashto_content")?ps:main),revision:40}}};
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
