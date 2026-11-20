/* Safe read-only acceptance for the 2026-11-20 special-programme preview.
 * Never submits forms, sends WhatsApp messages or modifies CMS data.
 */
const assert=require("node:assert/strict");
const fs=require("node:fs");
const {chromium}=require("/tmp/toefl-special-preview/node_modules/playwright-core");
const axe=require("/tmp/toefl-special-preview/node_modules/axe-core");
const base=(process.env.TH_SPECIAL_PREVIEW||"https://4235e5bd.the-toefl-house.pages.dev").replace(/\/$/,"");
const languages=[["/","en","ltr"],["/fa/","fa-AF","rtl"],["/ps/","ps-AF","rtl"]];
const screenshotDir="/tmp/toefl-special-evidence";
fs.mkdirSync(screenshotDir,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
 const reports=[];
 try{
  for(const [root,lang,dir] of languages){
   for(const slug of ["special-speaking","toefl-preparation"]){
    for(const [device,width,height] of [["mobile",390,844],["desktop",1440,900]]){
     const context=await browser.newContext({viewport:{width,height},bypassCSP:true});
     const page=await context.newPage();
     const errors=[];
     page.on("pageerror",error=>errors.push(String(error)));
     const route=root+"courses/"+slug+"/";
     const response=await page.goto(base+route,{waitUntil:"networkidle",timeout:40000});
     assert.equal(response.status(),200,route);
     assert.match(response.headers()["x-robots-tag"]||"",/noindex/,route+" preview must be noindex");
     const detail=await page.evaluate(()=>{
      const html=document.documentElement;
      const anchors=[...document.querySelectorAll(".eap-actions a")].map(a=>a.getAttribute("href"));
      return {lang:html.lang,dir:html.dir,overflow:html.scrollWidth>innerWidth+2,
       heading:[...document.querySelectorAll("h1")].map(x=>x.textContent.trim()),
       goals:document.querySelectorAll(".eap-goals-grid .eap-goal").length,
       syllabus:document.querySelectorAll(".eap-level").length,
       resources:document.querySelectorAll(".sp-resources .eap-book").length,
       faq:document.querySelectorAll(".eap-faq-list details").length,
       fee:document.querySelector("#program-fee")?.innerText||"",
       content:document.querySelector("main")?.innerText||"",
       canonical:document.querySelector('link[rel="canonical"]')?.href||"",
       assets:[...document.querySelectorAll('link[rel="stylesheet"]')].map(x=>x.href),
       anchors};
     });
     assert.equal(detail.lang,lang,route);
     assert.equal(detail.dir,dir,route);
     assert.equal(detail.overflow,false,route+" horizontal overflow");
     assert.equal(detail.heading.length,1,route+" single h1");
     assert.equal(detail.syllabus,4,route+" four curriculum groups");
     assert.equal(detail.resources,slug==="special-speaking"?2:1,route+" textbooks or official resource");
     assert.equal(detail.faq,5,route+" FAQ items");
     assert.ok(detail.anchors.includes(root+"admissions/?program="+slug),route+" course CTA");
     assert.equal(detail.canonical,"https://the-toefl-house.pages.dev"+route,route+" canonical SEO");
     assert.ok(detail.assets.some(x=>x.includes("/__th/v2/site.css?v=")),route+" visual design must load");
     if(slug==="special-speaking"){
      assert.ok(detail.content.includes("Master Speaking")&&detail.content.includes("Grammar for Special Speaking"),route+" authentic textbooks");
      assert.match(detail.fee,/2,000|۲٬۰۰۰/,route+" total semester fee");
      assert.match(detail.content,/16|۱۶/,route+" 16 grammar lessons");
     }else{
      for(const task of ["Complete the Words","Write an Email","Take an Interview","Listen and Repeat"])
       assert.ok(detail.content.includes(task),route+" current 2026 exam task missing "+task);
      assert.match(detail.content,/2026|۲۰۲۶/);
     }
     await page.addScriptTag({content:axe.source});
     const audit=await page.evaluate(async()=>window.axe.run(document,{
      runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21a","wcag21aa"]},
      rules:{"region":{enabled:false}}
     }));
     const violations=audit.violations.filter(x=>["serious","critical"].includes(x.impact)).map(x=>({id:x.id,targets:x.nodes.map(n=>n.target)}));
     assert.deepEqual(violations,[],route+" accessibility blockers");
     assert.deepEqual(errors,[],route+" browser runtime errors");
     await page.locator(".eap-hero").screenshot({path:screenshotDir+"/"+lang+"-"+slug+"-"+device+"-hero.png"});
     if(device==="mobile")await page.locator("#program-detail").screenshot({path:screenshotDir+"/"+lang+"-"+slug+"-curriculum.png"});
     reports.push({route,device,status:response.status(),lang,goals:detail.goals,syllabus:detail.syllabus,faq:detail.faq,resources:detail.resources,accessibilityPasses:audit.passes.length});
     await context.close();
    }
   }
  }
  for(const route of ["/","/fa/","/ps/","/api/content","/tools/","/fa/tools/","/ps/tools/"]){
   const res=await fetch(base+route,{method:"GET",signal:AbortSignal.timeout(25000)});
   assert.equal(res.status,200,route+" legacy/public route regression");
   if(route.includes("/tools/"))assert.match(res.headers.get("X-Robots-Tag")||"",/noindex/,route+" tools should not be indexed");
   if(route==="/api/content")assert.ok((await res.text()).includes('"cmsStatus":"connected"'));
  }
  console.log(JSON.stringify({success:true,preview:base,checkedBrowserViews:reports.length,nonMutating:true,reports},null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
