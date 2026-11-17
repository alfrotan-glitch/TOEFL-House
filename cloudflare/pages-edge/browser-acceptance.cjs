(async()=>{
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const { chromium }=require("/tmp/toefl-browser/node_modules/playwright-core");

const root="https://the-toefl-house.pages.dev";
const chrome=process.env.CHROME_PATH||"/usr/bin/google-chrome";
const browser=await chromium.launch({headless:true,executablePath:chrome,args:["--no-sandbox","--disable-dev-shm-usage"]});
const locales=[["/","english"],["/fa/","dari"],["/ps/","pashto"]];
const results=[];
try{
  fs.mkdirSync("cloudflare-pages-browser-evidence",{recursive:true});
  for(const [route,lang] of locales){
    const ctx=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,locale:lang==="english"?"en-US":lang==="dari"?"fa-AF":"ps-AF"});
    const page=await ctx.newPage();
    const captured=[];
    const errors=[];
    await page.route("https://toefl-house-conversions.alfrotan2.workers.dev/e", async r=>{
      const req=r.request();
      const body=req.postData()||"";
      if(req.method()==="POST"){
        try{captured.push(JSON.parse(body));}catch(e){errors.push("Unparseable event "+String(e));}
      }
      await r.fulfill({status:204,headers:{"Access-Control-Allow-Origin":root,"Access-Control-Allow-Methods":"POST,OPTIONS"}});
    });
    page.on("pageerror",error=>errors.push(String(error)));
    const response=await page.goto(root+route,{waitUntil:"domcontentloaded",timeout:30000});
    await page.waitForTimeout(900);
    const data=await page.evaluate(()=>{
      const h1=[...document.querySelectorAll("h1")].filter(x=>{
        const cs=getComputedStyle(x),rect=x.getBoundingClientRect();
        return cs.display!=="none"&&cs.visibility!=="hidden"&&rect.width>0&&rect.height>0;
      });
      return {title:document.title,lang:document.documentElement.lang,dir:document.documentElement.dir,
        h1:h1.map(x=>x.textContent.trim().slice(0,80)),
        scriptPresent:!!document.querySelector('script[src="/__th/engagement-v1.js"]')};
    });
    assert.equal(response.status(),200);
    assert.equal(data.scriptPresent,true,route+" missing tracking script");
    assert.ok(data.h1.length>0,route+" no visible heading");
    // Use synthetic links without navigation or submitting a form.
    await page.evaluate(()=>{
      const targets=["tel:+93745651844","https://wa.me/93794357509","/admissions/"];
      for(const href of targets){
        const a=document.createElement("a");
        a.href=href;a.textContent="synthetic tracking acceptance";
        a.addEventListener("click",e=>e.preventDefault());
        document.body.appendChild(a);
        a.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));
        a.remove();
      }
    });
    await page.waitForTimeout(1100);
    const seen=[...new Set(captured.map(x=>x.action))].sort();
    assert.deepEqual(seen,["admissions","phone","whatsapp"],route+" missing recorded CTA intent");
    assert.ok(captured.every(x=>Object.keys(x).every(k=>["action","source","campaign","course"].includes(k))),"Unexpected PII/event payload");
    assert.ok(captured.every(x=>x.source==="website"||x.source==="facebook"||x.source==="google"||x.source==="instagram"));
    await page.screenshot({path:path.join("cloudflare-pages-browser-evidence",lang+"-mobile.png"),fullPage:true});
    results.push({route,...data,captured:captured.map(x=>({action:x.action,source:x.source,campaign:x.campaign,course:x.course})),pageErrors:errors});
    await ctx.close();
  }
  console.log(JSON.stringify({checked:results.length,results},null,2));
}finally{await browser.close();}

})().catch(e=>{console.error(e);process.exitCode=1});
