(async()=>{
const assert=require("node:assert/strict");
const {chromium}=require("/tmp/toefl-ge-browser/node_modules/playwright-core");
const axe=require("/tmp/toefl-ge-browser/node_modules/axe-core");
const fs=require("node:fs/promises");
const base="https://818c8713.the-toefl-house.pages.dev";
const variants=[
 {path:"/courses/general-english/",lang:"en",dir:"ltr",staff:"2 instructors",monthly:"500 AFN",semester:"1,000 AFN",total:"4,500 AFN"},
 {path:"/fa/courses/general-english/",lang:"fa-AF",dir:"rtl",staff:"۲ استاد",monthly:"۵۰۰ افغانی",semester:"۱٬۰۰۰ افغانی",total:"۴٬۵۰۰ افغانی"},
 {path:"/ps/courses/general-english/",lang:"ps-AF",dir:"rtl",staff:"۲ استادان",monthly:"۵۰۰ افغانۍ",semester:"۱٬۰۰۰ افغانۍ",total:"۴٬۵۰۰ افغانۍ"}
];
const results=[];
const browser=await chromium.launch({headless:true,executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
try{
 await fs.mkdir("general-english-qa",{recursive:true});
 for(const view of [390,1366]){
  for(const c of variants){
   const context=await browser.newContext({viewport:{width:view,height:view===390?844:768},bypassCSP:true});
   const page=await context.newPage();
   const errors=[];
   page.on("pageerror",e=>errors.push(String(e)));
   const response=await page.goto(base+c.path,{waitUntil:"networkidle",timeout:30000});
   assert.equal(response.status(),200,c.path+" HTTP");
   assert.match(response.headers()["x-robots-tag"]||"",/noindex/,c.path+" Preview must be noindex");
   const info=await page.evaluate(()=>{
    const section=document.querySelector("#general-english-details");
    const cards=[...document.querySelectorAll(".ge-stage h4")].map(x=>x.textContent);
    const rows=[...document.querySelectorAll(".ge-fee-table tbody tr")].map(x=>x.textContent.trim());
    return {
     lang:document.documentElement.lang,dir:document.documentElement.dir,
     h1:document.querySelectorAll("h1").length,
     h2:section?.querySelectorAll("h2").length||0,
     guideVisible:!!section&&getComputedStyle(section).display!=="none",
     horizontalOverflow:document.documentElement.scrollWidth>window.innerWidth+2,
     courseLevels:cards,prices:rows,
     faqCount:section?.querySelectorAll("details").length||0,
     references:[...section.querySelectorAll(".ge-references a")].map(a=>({url:a.href,rel:a.rel})),
     cta:section?.querySelector(".ge-cta a")?.getAttribute("href"),
     cssUrl:document.querySelector("link[href*='/__th/v2/site.css']")?.getAttribute("href"),
     visibleText:section?.innerText?.slice(0,5000)
    };
   });
   assert.equal(info.lang,c.lang,c.path);
   assert.equal(info.dir,c.dir,c.path);
   assert.equal(info.h1,1,c.path);
   assert.equal(info.h2,1,c.path);
   assert.equal(info.guideVisible,true,c.path);
   assert.equal(info.horizontalOverflow,false,c.path+" body overflow");
   assert.deepEqual(info.courseLevels,["Pre-Starter","Starter","Prep One","Prep Two","Prep Three"],c.path);
   assert.equal(info.prices.length,5,c.path);
   assert.equal(info.faqCount,3,c.path);
   for(const x of [c.staff,c.monthly,c.semester,c.total,"Got it! Level 1","Got it! Level 2","Got it! Level 3","Speaking","Oxford University Press"])
    assert.ok(info.visibleText.includes(x),c.path+" missing "+x);
   assert.match(info.cta||"",/admissions\/\?program=general-english$/);
   assert.match(info.cssUrl||"",/\?v=[a-f0-9]{12}/);
   for(const a of info.references){assert.ok(a.url.startsWith("https://"));assert.match(a.rel,/noopener/);}
   await page.addScriptTag({content:axe.source});
   const axeResult=await page.evaluate(async()=>await window.axe.run(document,{
      runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21a","wcag21aa"]},
      rules:{region:{enabled:false}}
   }));
   const issues=axeResult.violations.filter(x=>["serious","critical"].includes(x.impact)).map(x=>({id:x.id,nodes:x.nodes.slice(0,5).map(z=>z.target)}));
   assert.equal(issues.length,0,c.path+" WCAG serious/critical "+JSON.stringify(issues));
   assert.deepEqual(errors,[],c.path+" JS errors");
   const slug=c.lang==="en"?"en":c.lang==="fa-AF"?"fa":"ps";
   await page.locator("#general-english-details").screenshot({path:"general-english-qa/"+slug+"-"+view+".png"});
   await page.locator(".ge-cta a").click();
   await page.waitForURL(new RegExp("/admissions/\\?program=general-english"),{timeout:13000});
   assert.equal(await page.locator("#v2-program").inputValue(),"general-english","Prefill admission");
   results.push({lang:c.lang,viewport:view,stages:5,prices:5,wcagSerious:0,crossPageCTA:true,jsErrors:0,overflow:false});
   await context.close();
  }
 }
 console.log(JSON.stringify({status:"passed",results},null,2));
}finally{await browser.close();}

})().catch(e=>{console.error(e);process.exitCode=1});
