(async()=>{
const assert=require("node:assert/strict");
const {chromium}=require("/tmp/toefl-v2-live/node_modules/playwright-core");
const base="https://the-toefl-house.pages.dev";
const langs=[["","en","ltr"],["fa/","fa-AF","rtl"],["ps/","ps-AF","rtl"]];
const browser=await chromium.launch({headless:true,executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
let failures=[],results=[];
try{
 const ctx=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1});
 const page=await ctx.newPage();
 let pageErrors=[];
 page.on("pageerror",x=>pageErrors.push(String(x)));
 for(const [prefix,lang,dir] of langs){
  for(const [part,kind] of [["","home"],["courses/toefl-preparation/","course"],["admissions/?program=toefl-preparation","admissions"]]){
   const path="/"+prefix+part;
   const r=await page.goto(base+path,{waitUntil:"networkidle",timeout:30000});
   const m=await page.evaluate(()=>({lang:document.documentElement.lang,dir:document.documentElement.dir,title:document.title,
     h1:document.querySelectorAll("h1").length,scroll:document.documentElement.scrollWidth,viewport:innerWidth,
     css:!!document.querySelector('link[href="/__th/v2/site.css"]'),
     js:!!document.querySelector('script[src="/__th/v2/site.js"]'),
     logo:!!document.querySelector('.brand img'),
     cards:document.querySelectorAll(".course-card").length,
     selected:document.querySelector("#v2-program")?.value||null,
     scriptURLs:[...document.scripts].filter(s=>s.src).map(s=>new URL(s.src).pathname)}));
   if(r.status()!==200||m.lang!==lang||m.dir!==dir||m.h1!==1||m.scroll>m.viewport+2||!m.css||!m.js||!m.logo)failures.push(path+" invalid document/layout");
   if(kind==="home"&&m.cards!==6)failures.push(path+" six courses not visible");
   if(kind==="admissions"&&m.selected!=="toefl-preparation")failures.push(path+" program not selected");
   if(m.scriptURLs.includes("/assets/index-Ch3KjNPK.js"))failures.push(path+" legacy React loaded in public V2 page");
   results.push({path,kind,status:r.status(),...m});
  }
 }
 if(pageErrors.length)failures.push(...pageErrors);
 const tools=await page.goto(base+"/fa/tools/",{waitUntil:"networkidle",timeout:30000});
 const count=await page.locator("form").count();
 if(tools.status()!==200||count<1)failures.push("Legacy enquiry form not reachable");
 const admin=await fetch(base+"/api/admin/revisions",{signal:AbortSignal.timeout(20000)});
 const authJSON=await admin.text();
 if(admin.status===200&&authJSON.includes('"revisions"'))failures.push("Unauthorized CMS revision data exposure");
 results.push({toolsStatus:tools.status(),legacyForms:count,adminStatus:admin.status});
 console.log(JSON.stringify({checked:results.length,failures,results},null,2));
 assert.deepEqual(failures,[]);
 await ctx.close();
}finally{await browser.close();}

})().catch(e=>{console.error(e);process.exitCode=1});
