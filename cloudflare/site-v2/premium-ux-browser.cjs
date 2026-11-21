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
    const schema=await page.locator('script[type="application/ld+json"]').first().evaluate(el=>JSON.parse(el.textContent));
    assert.equal(schema.find(x=>x["@type"]==="ItemList")?.itemListElement?.length,6,root+" "+width+" search course list");
    assert.equal(d.ctaVisible,mobile,root+" "+width+" visibility of quick placement");
    assert.equal(d.ctaHref,root+"admissions/");
    await page.evaluate(()=>{document.documentElement.style.scrollBehavior="auto";window.scrollTo(0,1000);});
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
    const goalLinks=page.locator(".goal-finder-links a");
    assert.equal(await goalLinks.count(),4,root+" "+width+" must offer four goal choices");
    for(const goal of ["general-english","special-speaking","academic-english","toefl-preparation"]){
     assert.equal(await page.locator('.goal-finder-links a[href="#course-'+goal+'"]').count(),1,root+" "+width+" missing "+goal);
     assert.equal(await page.locator("#course-"+goal).count(),1,root+" "+width+" anchor target absent");
    }
    if(width===390){
     await page.locator(".goal-finder").screenshot({path:"/tmp/toefl-premium-evidence/goals-"+lang+"-390.png"});
    }
    await page.locator('.goal-finder-links a[href="#course-special-speaking"]').click();
    assert.equal(await page.evaluate(()=>location.hash),"#course-special-speaking",root+" "+width+" goal anchor did not navigate");
    const target=await page.locator("#course-special-speaking").evaluate(el=>({
     y:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom,outline:getComputedStyle(el).outlineStyle
    }));
    assert.ok(target.y>=d.headerHeight-18&&target.y<900,root+" "+width+" sticky header obscures program card: "+target.y);
    assert.equal(target.outline,"solid",root+" "+width+" selected course is not highlighted");
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
    const preview=page.locator("#v2-program-preview");
    assert.equal(await preview.isVisible(),true,route+" must show course facts before WhatsApp");
    const note=await preview.textContent();
    assert.ok(note&&note.length>35,route+" facts not informative");
    if(program==="toefl-preparation")assert.equal(/AFN [0-9]|فیس [۰-۹]|فیس: [۰-۹]/.test(note),false,"Unconfirmed TOEFL fee invented");
    if(program==="special-speaking")assert.match(note,/2,000|۲٬۰۰۰/,route+" speaking semester fee");
    if(program==="academic-english")assert.match(note,/1,000|۱٬۰۰۰/,route+" EAP monthly fee");
    if(lang==="fa-AF"&&program==="special-speaking"){
     await page.screenshot({path:"/tmp/toefl-premium-evidence/admissions-fa-AF-speaking.png",fullPage:false});
    }
    await page.locator("#v2-program").selectOption("general-english");
    assert.match(await preview.textContent(),/500|۵۰۰/,route+" program switching must refresh fee");
    await page.locator("#v2-program").selectOption("toefl-preparation");
    assert.ok((await preview.textContent()).length>25,route+" fee unknown still needs useful duration");
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false,route+" form overflow");
    checked++;
    await ctx.close();
   }
  }
  console.log(JSON.stringify({pass:true,base,checked,summaries},null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
