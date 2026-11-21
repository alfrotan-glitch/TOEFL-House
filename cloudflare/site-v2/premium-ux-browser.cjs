/* Read-only mobile conversion, navigation and responsive visual acceptance.
 * Runs on an approved Pages preview, not against genuine enrollment writes.
 */
const assert=require("node:assert/strict");
const fs=require("node:fs");
const {chromium}=require("/tmp/toefl-premium-browser/node_modules/playwright-core");
const axe=require("/tmp/toefl-premium-browser/node_modules/axe-core");
const base=(process.env.TH_PREMIUM_BASE||"https://the-toefl-house.pages.dev").replace(/\/$/,"");
const isPreview=new URL(base).hostname!=="the-toefl-house.pages.dev";
const locales=[["/","en"],["/fa/","fa-AF"],["/ps/","ps-AF"]];
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
 fs.mkdirSync("/tmp/toefl-premium-evidence",{recursive:true});
 let checked=0;
 const summaries=[];
 try{
  for(const [root,lang] of locales){
   for(const width of [320,390,768,1440]){
    const mobile=width<=760;
    const context=await browser.newContext({viewport:{width,height:900},bypassCSP:true,deviceScaleFactor:1});
    const page=await context.newPage();
    const browserErrors=[];
    page.on("pageerror",e=>browserErrors.push(String(e)));
    const res=await page.goto(base+root,{waitUntil:"networkidle",timeout:30000});
    assert.equal(res.status(),200,root+" "+width);
    if(isPreview)assert.match(res.headers()["x-robots-tag"]||"",/noindex/,root+" preview indexing");
    const d=await page.evaluate(()=>{
     const b=document.querySelector(".brand img"),cta=document.querySelector(".mobile-quick-apply"),nav=document.querySelector(".site-header");
     return {lang:document.documentElement.lang,overflow:document.documentElement.scrollWidth>innerWidth+2,logo:b?.naturalWidth||0,
       ctaVisible:!!cta&&getComputedStyle(cta).display!=="none",
       ctaHref:cta?.getAttribute("href"),navVisible:!!nav&&nav.getBoundingClientRect().height>0,
       cards:document.querySelectorAll(".course-card").length,
       headerHeight:nav?.getBoundingClientRect().height||0,
       title:document.querySelector("h1")?.textContent.trim().slice(0,100)};
    });
    assert.equal(d.lang,lang,root+" "+width+" language");
    assert.equal(d.overflow,false,root+" "+width+" horizontal overflow");
    assert.ok(d.logo>30,root+" "+width+" brand logo");
    assert.equal(d.cards,6,root+" "+width+" course choices");
    assert.equal(d.ctaVisible,mobile,root+" "+width+" visibility of quick placement");
    assert.equal(d.ctaHref,root+"admissions/");
    await page.evaluate(()=>window.scrollTo(0,1000));
    await page.waitForTimeout(90);
    const pinned=await page.locator(".site-header").evaluate(el=>Math.abs(el.getBoundingClientRect().top)<4);
    assert.equal(pinned,true,root+" "+width+" sticky header fails");
    await page.evaluate(()=>window.scrollTo(0,0));
    if(mobile){
     await page.locator(".mobile-menu summary").click();
     assert.equal(await page.locator(".mobile-menu").evaluate(el=>el.open),true,root+" "+width+" menu");
     const rect=await page.locator(".mobile-menu nav").boundingBox();
     assert.ok(rect&&rect.x>=-2&&rect.x+rect.width<=width+2,root+" "+width+" menu offscreen");
     await page.keyboard.press("Escape");
     assert.equal(await page.locator(".mobile-menu").evaluate(el=>el.open),false);
     await page.screenshot({path:"/tmp/toefl-premium-evidence/home-"+lang+"-"+width+".png",fullPage:false});
    }else{
     await page.screenshot({path:"/tmp/toefl-premium-evidence/home-"+lang+"-desktop.png",fullPage:false});
    }
    if(width===320||width===1440){
     await page.addScriptTag({content:axe.source});
     const audit=await page.evaluate(()=>window.axe.run(document,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21a","wcag21aa"]},rules:{"region":{enabled:false}}}));
     assert.deepEqual(audit.violations.filter(v=>["critical","serious"].includes(v.impact)).map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)})),[],root+" "+width+" blocking accessibility");
    }
    assert.deepEqual(browserErrors,[],root+" "+width+" browser errors");
    summaries.push({route:root,width,...d,sticky:true});
    checked++;
    await context.close();
   }
   for(const program of ["special-speaking","toefl-preparation","academic-english"]){
    const ctx=await browser.newContext({viewport:{width:390,height:844}});
    const page=await ctx.newPage();
    const route=root+"courses/"+program+"/";
    const res=await page.goto(base+route,{waitUntil:"networkidle",timeout:30000});
    assert.equal(res.status(),200,route);
    assert.equal(await page.locator(".mobile-quick-apply").getAttribute("href"),root+"admissions/?program="+program,route+" mobile selection");
    assert.equal(await page.locator(".desktop-apply").getAttribute("href"),root+"admissions/?program="+program,route+" desktop selection");
    assert.equal(await page.locator("h1").count(),1,route+" heading");
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false,route+" overflow");
    await page.locator(".mobile-quick-apply").click();
    await page.waitForURL(new RegExp("/admissions/\\?program="+program),{timeout:12000});
    assert.equal(await page.locator("#v2-program").inputValue(),program,route+" enrollment context should survive");
    checked++;
    await ctx.close();
   }
  }
  console.log(JSON.stringify({pass:true,base,checked,summaries},null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
