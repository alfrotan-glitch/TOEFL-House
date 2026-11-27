// Exact read-only preview acceptance; no admissions, CMS writes or analytics.
const assert = require("node:assert/strict");
const { chromium } = require("playwright-core");
const axe = require("axe-core");
(async () => {
 const base = process.env.TOEFL_GE_PREVIEW;
 assert.match(base || "", /^https:\/\/[a-f0-9]{8}\.toeflhouse\.pages\.dev$/);
 const browser = await chromium.launch({headless:true, executablePath:process.env.CHROME_PATH || "/usr/bin/google-chrome", args:["--no-sandbox","--disable-dev-shm-usage"]});
 const results=[];
 try {
  for (const prefix of ["/","/fa/","/ps/"]) {
   const url=base+prefix+"courses/general-english/";
   for (const width of [320,390,768,1440]) {
    const ctx=await browser.newContext({viewport:{width,height:900},bypassCSP:true});
    try {
     const page=await ctx.newPage(), errors=[];
     page.on("pageerror",e=>errors.push(String(e)));
     const response=await page.goto(url,{waitUntil:"networkidle"});
     assert.equal(response.status(),200);
     assert.match(response.headers()["x-robots-tag"]||"",/noindex/);
     const panel=page.locator("[data-ge-practice]"), qs=panel.locator("[data-ge-question]");
     assert.equal(await qs.count(),3);
     const labels=await panel.evaluate(e=>({...e.dataset}));
     for(const key of ["correctLabel","incorrectLabel","progressLabel","scoreLabel"])assert.ok(labels[key],key);
     const progress=panel.locator("[data-ge-progress]");
     const expected=(n,score)=>labels.progressLabel+": "+n+"/3 · "+labels.scoreLabel+": "+score+"/3";
     assert.equal(await progress.textContent(),expected(0,0));
     for(const [i,value,correct,score] of [[0,"1",true,1],[1,"0",false,1],[2,"0",true,2]]){
      const q=qs.nth(i), check=q.locator("[data-ge-check]");
      assert.equal(await check.isDisabled(),true);
      await q.locator('input[value="'+value+'"]').check();
      assert.equal(await check.isEnabled(),true);
      await check.click();
      assert.equal(await q.locator("[data-ge-feedback]").textContent(),correct?labels.correctLabel:labels.incorrectLabel);
      assert.equal(await q.locator("[data-ge-answer]").evaluate(e=>e.open&&!e.hidden),true);
      assert.equal(await check.isDisabled(),true);
      assert.equal(await q.locator("input:disabled").count(),3);
      assert.equal(await progress.textContent(),expected(i+1,score));
     }
     await page.addScriptTag({content:axe.source});
     const violations=await panel.evaluate(async e=>(await window.axe.run(e,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21a","wcag21aa"]}})).violations.map(v=>({id:v.id,impact:v.impact})));
     assert.deepEqual(violations,[]);
     await panel.locator("[data-ge-reset]").click();
     assert.equal(await progress.textContent(),expected(0,0));
     assert.equal(await panel.locator("input:checked").count(),0);
     assert.equal(await panel.locator("input:disabled").count(),0);
     assert.equal(await panel.locator("[data-ge-answer][hidden]").count(),3);
     assert.equal(await qs.first().locator("input").first().evaluate(e=>e===document.activeElement),true);
     assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
     assert.deepEqual(errors,[]);
     results.push({prefix,width,scoreReset:true,localizedFeedback:true,violations:0});
    } finally {await ctx.close();}
   }
   const fallback=await browser.newContext({javaScriptEnabled:false});
   try {
    const page=await fallback.newPage();
    assert.equal((await page.goto(url)).status(),200);
    const panel=page.locator("[data-ge-practice]");
    assert.equal(await panel.locator("[data-ge-fallback]:visible").count(),3);
    const answer=panel.locator("[data-ge-answer]").first();
    await answer.locator("summary").click();
    assert.equal(await answer.getAttribute("open"),"");
   } finally {await fallback.close();}
  }
  console.log(JSON.stringify({status:"passed",results},null,2));
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
