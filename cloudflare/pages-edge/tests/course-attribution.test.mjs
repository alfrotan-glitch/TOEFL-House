import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import worker from "../worker.mjs";

const resp=await worker.fetch(new Request("https://the-toefl-house.pages.dev/__th/engagement-v1.js"),{});
assert.equal(resp.status,200);
const script=await resp.text();

function eventFrom({pathname="/fa/admissions/",search="",selected=null,href="https://wa.me/93794357509",expectedEvents=1}){
 const handlers={},sent=[];
 const ElementClass=class {
  closest(selector){return selector==="a[href]"?{getAttribute(){return href;}}:null;}
 };
 const location={hostname:"the-toefl-house.pages.dev",origin:"https://the-toefl-house.pages.dev",pathname,search,href:"https://the-toefl-house.pages.dev"+pathname+search};
 const data=new Map();
 const context={
  location,
  document:{
   referrer:"",
   querySelector:q=>q==="#v2-program"&&selected?{value:selected}:null,
   addEventListener:(name,fn)=>{handlers[name]=fn;}
  },
  sessionStorage:{
   setItem:(k,v)=>data.set(k,v),
   getItem:k=>data.get(k)||null
  },
  navigator:{sendBeacon:()=>false},
  fetch:(url,options)=>{sent.push(JSON.parse(options.body));return Promise.resolve({ok:true});},
  URL,URLSearchParams,Blob,Element:ElementClass,
  Date,JSON
 };
 vm.runInNewContext(script,context,{timeout:1000});
 assert.equal(typeof handlers.click,"function");
 handlers.click({target:new ElementClass()});
 assert.equal(sent.length,expectedEvents);
 return sent[0];
}

test("Selected admissions program wins over old URL query on WhatsApp intent",()=>{
 const e=eventFrom({selected:"special-speaking",search:"?program=toefl-preparation&utm_source=facebook&utm_campaign=nov_2026"});
 assert.deepEqual(JSON.parse(JSON.stringify(e)),{action:"whatsapp",source:"facebook",campaign:"nov_2026",course:"special-speaking"});
});
test("Admissions URL program query is used when form is not yet selected",()=>{
 const e=eventFrom({selected:null,search:"?program=toefl-preparation&utm_source=instagram"});
 assert.equal(e.course,"toefl-preparation");
 assert.equal(e.source,"instagram");
});
test("The actual course page takes precedence over admissions controls",()=>{
 const e=eventFrom({pathname:"/courses/academic-english/",selected:"general-english",search:"?program=toefl-preparation"});
 assert.equal(e.course,"academic-english");
});
test("No personal form values or visitor identifiers are sent to analytics",()=>{
 const e=eventFrom({selected:"teacher-training"});
 assert.deepEqual(Object.keys(e).sort(),["action","campaign","course","source"]);
 assert.equal(e.course,"teacher-training");
});

test("Changing admissions language is NOT a new admissions conversion",()=>{
 const e=eventFrom({pathname:"/fa/admissions/",href:"/ps/admissions/?program=toefl-preparation",selected:"toefl-preparation",expectedEvents:0});
 assert.equal(e,undefined);
});
test("Real course-to-admissions CTA remains counted once",()=>{
 const e=eventFrom({pathname:"/ps/courses/toefl-preparation/",href:"/ps/admissions/?program=toefl-preparation",expectedEvents:1});
 assert.equal(e.action,"admissions");
 assert.equal(e.course,"toefl-preparation");
});
