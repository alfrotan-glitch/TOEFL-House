(async()=>{
const assert=require("node:assert/strict");
const {chromium}=require("/tmp/toefl-live-conversion/node_modules/playwright-core");
const base="https://the-toefl-house.pages.dev";
const collector="https://toefl-house-conversions.alfrotan2.workers.dev/e";
const locales=[["","en"],["fa/","fa"],["ps/","ps"]];
const results=[],errors=[];
const browser=await chromium.launch({headless:true,executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
try{
 for(const [prefix,lang] of locales){
  const ctx=await browser.newContext({viewport:{width:390,height:844}});
  const page=await ctx.newPage(),captured=[];
  page.on("pageerror",e=>errors.push(lang+": "+String(e)));
  await page.addInitScript(()=>{
   // Force the client's harmless fetch fallback. Every real external analytics
   // request below is intercepted, so no QA row enters production D1.
   try{Object.defineProperty(navigator,"sendBeacon",{configurable:true,value:()=>false});}catch(_){}
  });
  await page.route(collector,async route=>{
   try{captured.push(JSON.parse(route.request().postData()||"{}"));}catch(e){errors.push(lang+" unparsable event "+String(e));}
   await route.fulfill({status:204,headers:{"Access-Control-Allow-Origin":base,"Access-Control-Allow-Methods":"POST,OPTIONS"},body:""});
  });
  await page.route("https://wa.me/**",r=>r.fulfill({status:200,contentType:"text/html",body:"<html><title>QA intercepted WhatsApp</title></html>"}));
  const url=base+"/"+prefix+"courses/toefl-preparation/?utm_source=facebook&utm_campaign=qa_release_20261118";
  const r=await page.goto(url,{waitUntil:"networkidle",timeout:30000});
  assert.equal(r.status(),200);
  await page.locator(".detail-actions a.button-primary").click();
  await page.waitForURL(new RegExp("/"+prefix+"admissions/"),{timeout:15000});
  assert.equal(await page.locator("#v2-program").inputValue(),"toefl-preparation");
  await page.locator("#v2-format").selectOption("online");
  const requestPromise=page.waitForRequest(req=>req.url().startsWith("https://wa.me/93794357509?text="),{timeout:15000});
  await page.locator("#v2-enquiry-form button[type=submit]").click();
  const whatsappReq=await requestPromise;
  const draft=new URL(whatsappReq.url()).searchParams.get("text")||"";
  assert.match(draft,/facebook\s*\/\s*qa_release_20261118/);
  await page.waitForTimeout(750);
  const actionKinds=[...new Set(captured.map(x=>x.action))];
  assert.ok(actionKinds.includes("admissions"),lang+" admissions intent missing");
  const wa=captured.find(x=>x.action==="whatsapp");
  assert.ok(wa,lang+" WhatsApp intent missing");
  assert.equal(wa.course,"toefl-preparation",lang+" selected course mismatch");
  assert.equal(wa.source,"facebook");
  assert.equal(wa.campaign,"qa_release_20261118");
  for(const item of captured)assert.deepEqual(Object.keys(item).sort(),["action","campaign","course","source"]);
  results.push({lang,events:captured.map(x=>({action:x.action,course:x.course,source:x.source,campaign:x.campaign})),approvedDraft:!!draft,privateMessagesSent:0,productionRecordsWritten:0});
  await ctx.close();
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({checked:results.length,errors,results},null,2));
}finally{await browser.close();}

})().catch(e=>{console.error(e);process.exitCode=1});
