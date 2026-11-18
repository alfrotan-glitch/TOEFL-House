(async()=>{
const assert=require("node:assert/strict");
const fs=require("node:fs");
const {chromium}=require("/tmp/toefl-v2-detail-browser/node_modules/playwright-core");
const base="https://e5c5d758.the-toefl-house.pages.dev";
const langs=[{key:"en",prefix:"/",lang:"en",dir:"ltr"},{key:"fa",prefix:"/fa/",lang:"fa-AF",dir:"rtl"},{key:"ps",prefix:"/ps/",lang:"ps-AF",dir:"rtl"}];
const ids=["general-english","academic-english","toefl-preparation","special-speaking","professional-writing","teacher-training","online-individual-zoom"];
let failures=[],summary=[];
const browser=await chromium.launch({headless:true,executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
fs.mkdirSync("toefl-v2-detail-evidence",{recursive:true});
try{
 const ctx=await browser.newContext({viewport:{width:390,height:844}});
 const page=await ctx.newPage();
 let errors=[];
 page.on("pageerror",x=>errors.push(String(x)));
 for(const l of langs){
  for(const id of ids){
   const route=l.prefix+"courses/"+id+"/";
   const response=await page.goto(base+route,{waitUntil:"domcontentloaded",timeout:22000});
   await page.waitForTimeout(80);
   const metric=await page.evaluate(()=>{
    const doc=document.documentElement;
    return {lang:doc.lang,dir:doc.dir,title:document.title,canonical:document.querySelector('link[rel="canonical"]')?.href,
      h1:document.querySelectorAll("h1").length,
      heading:document.querySelector("h1")?.textContent.trim().slice(0,70),
      highlights:document.querySelectorAll(".detail-summary li").length,
      css:document.querySelector('link[href^="/__th/v2/site.css?v="]')!==null,
      width:doc.scrollWidth,viewport:innerWidth,
      seo:document.querySelector('script[type="application/ld+json"]')?.textContent?.includes('"Course"'),
      duration:document.querySelector(".detail-summary-head strong")?.textContent.trim(),
      cta:document.querySelector('.detail-actions a')?.getAttribute("href")};
   });
   if(response.status()!==200)failures.push(route+" HTTP "+response.status());
   if(metric.lang!==l.lang||metric.dir!==l.dir)failures.push(route+" language");
   if(metric.h1!==1||!metric.seo||!metric.css)failures.push(route+" missing semantic SEO/style");
   if(metric.width>metric.viewport+2)failures.push(route+" horizontal overflow "+metric.width);
   if(!metric.cta?.startsWith(l.prefix+"admissions/?program="+id))failures.push(route+" bad CTA");
   if(id==="toefl-preparation"&&!/4 months|۴ ماه|څلور میاشتې/.test(metric.duration||""))failures.push(route+" four-month rule");
   if(id==="toefl-preparation")await page.screenshot({path:"toefl-v2-detail-evidence/"+l.key+"-toefl-mobile.png",fullPage:true});
   summary.push({route,status:response.status(),...metric});
  }
  const route=l.prefix+"admissions/";
  const response=await page.goto(base+route,{waitUntil:"networkidle",timeout:25000});
  const data=await page.evaluate(()=>({lang:document.documentElement.lang,dir:document.documentElement.dir,h1:document.querySelectorAll("h1").length,
    programOptions:document.querySelectorAll("#v2-program option").length,
    form:!!document.querySelector("#v2-enquiry-form"),hasEmail:!!document.querySelector('input[type="email"]'),
    width:document.documentElement.scrollWidth,viewport:innerWidth,css:!!document.querySelector('link[href^="/__th/v2/site.css?v="]'),
    canonical:document.querySelector('link[rel="canonical"]')?.href}));
  if(response.status()!==200||!data.form||data.hasEmail||data.h1!==1||!data.css||data.programOptions<7||data.width>data.viewport+2)failures.push(route+" admissions UI regression");
  await page.screenshot({path:"toefl-v2-detail-evidence/"+l.key+"-admissions-mobile.png",fullPage:true});
  summary.push({route,status:response.status(),...data});
 }
 const legacy=await fetch(base+"/fa/tools/",{signal:AbortSignal.timeout(25000)});
 const raw=await legacy.text();
 if(legacy.status!==200||!raw.includes("index-Ch3KjNPK"))failures.push("Original interactive form and curriculum unavailable");
 if(errors.length)failures.push(...errors);
 const preselected=await page.goto(base+"/fa/admissions/?program=toefl-preparation",{waitUntil:"networkidle",timeout:25000});
 const selectedValue=await page.locator("#v2-program").inputValue();
 if(preselected.status()!==200||selectedValue!=="toefl-preparation")failures.push("Admissions did not preselect TOEFL from program CTA");
 summary.push({route:"/fa/admissions/?program=toefl-preparation",selectedValue,status:preselected.status()});
 console.log(JSON.stringify({checked:summary.length,failures,summary},null,2));
 assert.deepEqual(failures,[]);
 await ctx.close();
}finally{await browser.close();}

})().catch(e=>{console.error(e);process.exitCode=1});
