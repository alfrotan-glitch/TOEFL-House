(async()=>{
const assert=require("node:assert/strict");
const {chromium}=require("/tmp/toefl-production-admissions/node_modules/playwright-core");
const base="https://the-toefl-house.pages.dev";
const collector="https://toefl-house-conversions.alfrotan2.workers.dev/e";
const browser=await chromium.launch({headless:true,executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
const events=[],errors=[],results=[];
try{
 const ctx=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1});
 const page=await ctx.newPage();
 page.on("pageerror",e=>errors.push(String(e)));
 await page.addInitScript(()=>{
  try{Object.defineProperty(navigator,"sendBeacon",{configurable:true,value:()=>false})}catch(_){}
 });
 await page.route(collector,async route=>{
  try{events.push(JSON.parse(route.request().postData()||"{}"))}catch(e){errors.push("Invalid event")}
  await route.fulfill({status:204,headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"POST,OPTIONS"},body:""});
 });
 await page.route("https://wa.me/**",route=>route.fulfill({status:200,contentType:"text/html",body:"<title>Intercepted WhatsApp</title>"}));
 const r=await page.goto(base+"/courses/toefl-preparation/?utm_source=facebook&utm_campaign=admissions_qa_nov_2026",{waitUntil:"networkidle",timeout:30000});
 assert.equal(r.status(),200);
 assert.ok(!/noindex/.test(r.headers()["x-robots-tag"]||""),"Production public page must be indexable");
 await page.locator(".detail-actions .button-primary").first().click();
 await page.waitForURL(/\/admissions\//,{timeout:16000});
 assert.equal(await page.locator("#v2-program").inputValue(),"toefl-preparation");
 await page.locator("#v2-format").selectOption("online");
 await page.locator("#v2-when").selectOption("afternoon");
 await page.waitForTimeout(320);
 const first=events.filter(x=>x.action==="admissions").length;
 assert.equal(first,1,"Actual course CTA must count once");
 await page.locator(".mobile-menu summary").click();
 await page.locator('.mobile-language a[hreflang="fa-AF"]').click();
 await page.waitForURL(/\/fa\/admissions\/\?/,{timeout:14000});
 assert.equal(await page.locator("#v2-program").inputValue(),"toefl-preparation");
 assert.equal(await page.locator("#v2-format").inputValue(),"online");
 assert.equal(await page.locator("#v2-when").inputValue(),"afternoon");
 await page.locator("#v2-when").selectOption("morning");
 await page.locator(".mobile-menu summary").click();
 await page.locator('.mobile-language a[hreflang="ps-AF"]').click();
 await page.waitForURL(/\/ps\/admissions\/\?/,{timeout:14000});
 assert.equal(await page.locator("#v2-program").inputValue(),"toefl-preparation");
 assert.equal(await page.locator("#v2-format").inputValue(),"online");
 assert.equal(await page.locator("#v2-when").inputValue(),"morning");
 await page.waitForTimeout(350);
 const languageEvents=events.filter(x=>x.action==="admissions").length;
 assert.equal(languageEvents,1,"Language switching must not count as another lead");
 results.push({mobileLanguages:"EN → FA → PS",selectedProgram:"toefl-preparation",time:"morning",newLeadCountOnLanguageSwitch:0});
 const promise=page.waitForRequest(q=>q.url().startsWith("https://wa.me/")&&q.url().includes("?text="),{timeout:15000});
 await page.locator("#v2-enquiry-form button[type=submit]").click();
 const whatsapp=await promise;
 const msg=new URL(whatsapp.url()).searchParams.get("text")||"";
 assert.match(msg,/facebook\s*\/\s*admissions_qa_nov_2026/);
 await page.waitForTimeout(500);
 const w=events.find(x=>x.action==="whatsapp");
 assert.ok(w,"WhatsApp click intent not captured");
 assert.equal(w.course,"toefl-preparation");
 assert.equal(w.source,"facebook");
 assert.equal(w.campaign,"admissions_qa_nov_2026");
 for(const e of events)assert.deepEqual(Object.keys(e).sort(),["action","campaign","course","source"]);
 results.push({interceptedWhatsApp:true,recordedCourse:w.course,realMessagesSent:0,realQARecordsWritten:0});
 const admin=await fetch(base+"/api/admin/revisions",{signal:AbortSignal.timeout(18000)});
 assert.ok([401,403].includes(admin.status),"Unauthorized admin revision exposure");
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({success:true,results,analyticsEventsIntercepted:events.length,errors},null,2));
 await ctx.close();
}finally{await browser.close();}

})().catch(e=>{console.error(e);process.exitCode=1});
