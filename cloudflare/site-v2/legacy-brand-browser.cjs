// Real-browser, read-only compatibility acceptance. Never submits an enquiry.
const assert = require("node:assert/strict");
const {chromium}=require("/tmp/toefl-tools-browser/node_modules/playwright-core");
const base=(process.env.V2_TOOLS_BRAND_BASE || "https://the-toefl-house.pages.dev").replace(/\/$/,"");
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
 const results=[],errors=[];
 try{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  page.on("pageerror",e=>errors.push(String(e)));
  for(const path of ["/tools/","/fa/tools/","/ps/tools/"]){
   const response=await page.goto(base+path,{waitUntil:"networkidle",timeout:30000});
   assert.equal(response.status(),200,path);
   await page.waitForFunction(()=>!document.body.innerText.includes("خانه موفقیت")&&!document.title.includes("خانه موفقیت"),null,{timeout:12000});
   const state=await page.evaluate(()=>({
    title:document.title,
    oldVisibleName:document.body.innerText.includes("خانه موفقیت"),
    rootText:document.getElementById("root")?.textContent?.length||0,
    forms:document.querySelectorAll("form").length,
    buttons:document.querySelectorAll("button").length,
    scriptInjected:[...document.scripts].some(s=>s.src.includes("/__th/tools-brand-v1.js")),
    horizontalOverflow:document.documentElement.scrollWidth>innerWidth+3,
    hasNewName:document.body.innerText.includes("تافل هوس")
   }));
   assert.match(response.headers()["x-robots-tag"]||"",/noindex/);
   assert.ok(state.rootText>1000,path+" React student tools absent");
   assert.ok(state.forms>=1,path+" interactive enquiry form absent");
   assert.ok(state.buttons>=1,path+" UI buttons absent");
   assert.ok(state.scriptInjected,path+" scoped brand helper not loaded");
   assert.equal(state.oldVisibleName,false,path+" old public name still visible");
   assert.equal(state.horizontalOverflow,false,path+" mobile horizontal overflow");
   if(path!=="/tools/")assert.ok(state.hasNewName,path+" new school name absent");
   results.push({path,status:response.status(),...state});
  }
  const v2=await page.goto(base+"/fa/",{waitUntil:"networkidle",timeout:30000});
  assert.equal(v2.status(),200);
  assert.equal(await page.locator('script[src*="/__th/tools-brand-v1.js"]').count(),0,"Legacy helper must not run on V2 homepage");
  for(const path of ["/fa/guides/","/ps/guides/"]){
   const r=await page.goto(base+path,{waitUntil:"networkidle",timeout:30000});
   assert.equal(r.status(),200,path);
   const layout=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+3,badLinks:document.querySelectorAll('a[href*="#th-pathways"]').length}));
   assert.equal(layout.overflow,false,path+" mobile overflow");
   assert.equal(layout.badLinks,0,path+" obsolete navigation anchor");
   results.push({path,status:r.status(),...layout});
  }
  assert.deepEqual(errors,[],"No uncaught browser errors");
  console.log(JSON.stringify({base,results,errors,status:"PASS"},null,2));
  await context.close();
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
