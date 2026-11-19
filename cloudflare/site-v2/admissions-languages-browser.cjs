(async()=>{
const assert=require("node:assert/strict");
const {chromium}=require("/tmp/toefl-admission-continuity/node_modules/playwright-core");
const base=process.env.TOEFL_PREVIEW_BASE;
assert.ok(/^https:\/\/[a-f0-9]{8}\.the-toefl-house\.pages\.dev$/.test(base||""),"Must point to one exact Cloudflare Preview version");
const browser=await chromium.launch({headless:true,executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
const errors=[],results=[],campaign="enroll_nov_2026";
try{
 const ctx=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1});
 const page=await ctx.newPage();
 page.on("pageerror",e=>errors.push(String(e)));
 await page.route("https://wa.me/**",r=>r.fulfill({status:200,contentType:"text/html",body:"<title>Intercepted WhatsApp handoff</title>"}));
 const start=await page.goto(base+"/admissions/?program=toefl-preparation&utm_source=facebook&utm_campaign="+campaign,{waitUntil:"networkidle",timeout:30000});
 assert.equal(start.status(),200,"EN admissions");
 assert.match(start.headers()["x-robots-tag"]||"",/noindex/,"Preview must never be indexed");
 assert.equal(await page.locator("#v2-program").inputValue(),"toefl-preparation");
 await page.locator("#v2-format").selectOption("online");
 await page.locator("#v2-when").selectOption("afternoon");
 const course1=page.locator('.mobile-language a[hreflang="fa-AF"]');
 const firstHref=await course1.getAttribute("href");
 assert.match(firstHref,/\/fa\/admissions\/\?program=toefl-preparation&format=online&when=afternoon$/);
 await page.locator(".mobile-menu summary").click();
 await course1.click();
 await page.waitForURL(/\/fa\/admissions\/\?/);
 assert.equal(await page.locator("#v2-program").inputValue(),"toefl-preparation");
 assert.equal(await page.locator("#v2-format").inputValue(),"online");
 assert.equal(await page.locator("#v2-when").inputValue(),"afternoon");
 results.push({locale:"fa",path:new URL(page.url()).pathname,selection:"toefl-preparation online afternoon"});
 await page.locator("#v2-when").selectOption("morning");
 const psLink=page.locator('.mobile-language a[hreflang="ps-AF"]');
 assert.match(await psLink.getAttribute("href"),/when=morning/);
 await page.locator(".mobile-menu summary").click();
 await psLink.click();
 await page.waitForURL(/\/ps\/admissions\/\?/);
 assert.equal(await page.locator("#v2-program").inputValue(),"toefl-preparation");
 assert.equal(await page.locator("#v2-format").inputValue(),"online");
 assert.equal(await page.locator("#v2-when").inputValue(),"morning");
 results.push({locale:"ps",path:new URL(page.url()).pathname,selection:"toefl-preparation online morning"});
 const ev=await page.evaluate(()=>{
  const s=sessionStorage.getItem("th_campaign");return s?JSON.parse(s):null;
 });
 assert.equal(ev?.source,"facebook");
 assert.equal(ev?.campaign,campaign);
 const draftRequest=page.waitForRequest(req=>req.url().startsWith("https://wa.me/")&&req.url().includes("?text="),{timeout:12000});
 await page.locator("#v2-enquiry-form button[type=submit]").click();
 const req=await draftRequest;
 const draft=new URL(req.url()).searchParams.get("text")||"";
 assert.match(draft,/facebook\s*\/\s*enroll_nov_2026/,"Campaign reference lost");
 assert.match(draft,/TOEFL|تافل/,"Course name missing from WhatsApp");
 results.push({locale:"ps-whatsapp",intercepted:true,hasCampaign:true});
 // No user-supplied private field should appear in the language URL.
 for(const q of ["program","format","when"])assert.ok(new URL(base+"/ps/admissions/?"+new URL(page.url()).search.slice(1)).searchParams.get(q)!=="[object Object]");
 // Validate hostile/invalid query values are not accepted.
 const invalid=await page.goto(base+"/fa/admissions/?program=%3Cscript%3E&format=other&when=midnight",{waitUntil:"networkidle",timeout:30000});
 assert.equal(invalid.status(),200);
 assert.equal(await page.locator("#v2-program").inputValue(),"");
 assert.equal(await page.locator("#v2-format").inputValue(),"campus");
 assert.equal(await page.locator("#v2-when").inputValue(),"flexible");
 results.push({locale:"fa-invalid-query",rejected:true});
 // Desktop switch should preserve state too.
 await page.setViewportSize({width:1366,height:768});
 await page.locator("#v2-program").selectOption("special-speaking");
 await page.locator("#v2-format").selectOption("online");
 await page.locator("#v2-when").selectOption("afternoon");
 const en=page.locator('.language-links a[hreflang="en"]');
 assert.match(await en.getAttribute("href"),/program=special-speaking&format=online&when=afternoon$/);
 await en.click();
 await page.waitForURL(/\/admissions\/\?/);
 assert.equal(await page.locator("#v2-program").inputValue(),"special-speaking");
 assert.equal(await page.locator("#v2-when").inputValue(),"afternoon");
 results.push({locale:"en-desktop",selection:"special-speaking online afternoon"});
 assert.deepEqual(errors,[],"JavaScript errors");
 console.log(JSON.stringify({success:true,results,errors,preview:base},null,2));
 await ctx.close();
}finally{await browser.close();}

})().catch(e=>{console.error(e);process.exitCode=1});
