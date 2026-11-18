(async()=>{
const assert=require("node:assert/strict");
const {chromium}=require("/tmp/toefl-final-qa/node_modules/playwright-core");
const base="https://fccf6b61.the-toefl-house.pages.dev";
const langs=[{prefix:"",lang:"en",needle:"Campaign reference:"},{prefix:"fa/",lang:"fa",needle:"کُد کمپاین:"},{prefix:"ps/",lang:"ps",needle:"د کمپاین کوډ:"}];
const expectedRev="e047825a59a7";
const results=[],errors=[];
const browser=await chromium.launch({headless:true,executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
try{
 for(const l of langs){
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  page.on("pageerror",x=>errors.push(String(x)));
  await page.route("https://wa.me/**",r=>r.fulfill({status:200,contentType:"text/html",body:"<html><title>Intercepted private WhatsApp handoff</title></html>"}));
  const sourcePath="/"+l.prefix+"courses/toefl-preparation/?utm_source=facebook&utm_campaign=canada_nov_2026";
  const start=await page.goto(base+sourcePath,{waitUntil:"networkidle",timeout:30000});
  assert.equal(start.status(),200);
  assert.match(start.headers()["x-robots-tag"]||"",/noindex/);
  const website=await page.evaluate(()=>({
   htmlLang:document.documentElement.lang,
   href:document.querySelector("link[rel=stylesheet][href^='/__th/v2/site.css']")?.getAttribute("href"),
   js:document.querySelector("script[src^='/__th/v2/site.js']")?.getAttribute("src"),
   guides:[...document.querySelectorAll("a")].filter(a=>a.getAttribute("href")==="/"+location.pathname.split("/").filter(x=>x==="fa"||x==="ps")[0]+"/guides/").length
  }));
  assert.ok(website.href?.endsWith("?v="+expectedRev),l.lang+" CSS fingerprint");
  assert.ok(website.js?.endsWith("?v="+expectedRev),l.lang+" JS fingerprint");
  await page.locator(".detail-actions .button-primary").first().click();
  await page.waitForURL(new RegExp("/"+l.prefix+"admissions/"),{timeout:15000});
  const selected=await page.locator("#v2-program").inputValue();
  assert.equal(selected,"toefl-preparation",l.lang+" course preselection");
  await page.locator("#v2-format").selectOption("online");
  await page.locator("#v2-when").selectOption("afternoon");
  const promise=page.waitForRequest(r=>r.url().startsWith("https://wa.me/93794357509?text="),{timeout:14000});
  await page.locator("#v2-enquiry-form button[type=submit]").click();
  const req=await promise;
  const msg=new URL(req.url()).searchParams.get("text")||"";
  assert.ok(msg.includes(l.needle),l.lang+" campaign reference label missing");
  assert.match(msg,/facebook\s*\/\s*canada_nov_2026/,l.lang+" campaign code missing");
  assert.ok(!/@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(msg),"Message should not contain invented email");
  results.push({lang:l.lang,source:sourcePath,selected,assetRev:expectedRev,whatsappMessage:msg.slice(0,280),pageErrors:[]});
  await context.close();
 }
 const [guides,api,admin]=await Promise.all([
  fetch(base+"/guides/",{signal:AbortSignal.timeout(20000)}),
  fetch(base+"/api/content",{signal:AbortSignal.timeout(20000)}),
  fetch(base+"/admin/",{signal:AbortSignal.timeout(20000)})
 ]);
 assert.equal(guides.status,200,"Learning guides page");
 assert.equal(api.status,200,"CMS published content");
 assert.match(await api.text(),/"cmsStatus":"connected"/);
 assert.match(admin.headers.get("X-Robots-Tag")||"",/noindex/);
 assert.deepEqual(errors,[],"Browser errors");
 console.log(JSON.stringify({tested:results.length,results,guides:guides.status,cms:api.status,adminNoindex:true,errors},null,2));
}finally{await browser.close();}

})().catch(x=>{console.error(x);process.exitCode=1});
