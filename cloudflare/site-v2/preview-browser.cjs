(async()=>{
const assert=require("node:assert/strict");
const fs=require("node:fs");
const {chromium}=require("/tmp/toefl-v2-browser/node_modules/playwright-core");
const base="https://5f7d9940.the-toefl-house.pages.dev";
const live="https://the-toefl-house.pages.dev";
const r=await fetch(base+"/__th/v2/site.css");
assert.equal(r.status,200);
const browser=await chromium.launch({headless:true,executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
const configs=[["/","en","ltr"],["/fa/","fa-AF","rtl"],["/ps/","ps-AF","rtl"]];
let failures=[],summaries=[];
fs.mkdirSync("toefl-v2-browser-results",{recursive:true});
try{
 for(const [route,lang,dir] of configs){
  for(const [device,width,height] of [["mobile",390,844],["desktop",1366,900]]){
   const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:1});
   const page=await context.newPage();let errors=[];
   page.on("pageerror",x=>errors.push("pageerror "+String(x)));
   page.on("response",x=>{if(x.status()>=500&&x.url().startsWith(base))errors.push("HTTP "+x.status()+" "+x.url())});
   const response=await page.goto(base+route,{waitUntil:"networkidle",timeout:30000});
   const metrics=await page.evaluate(()=>{
    const h1=[...document.querySelectorAll("h1")].filter(x=>{const b=x.getBoundingClientRect(),s=getComputedStyle(x);return b.width>0&&b.height>0&&s.visibility!=="hidden"&&s.display!=="none"});
    const cards=[...document.querySelectorAll(".course-card")];
    const xScroll=document.documentElement.scrollWidth>innerWidth+2;
    const lang=document.documentElement.lang,dir=document.documentElement.dir;
    return {lang,dir,h1:h1.map(x=>x.textContent.trim().slice(0,120)),cards:cards.length,links:[...document.querySelectorAll("a[href]")].length,xScroll,
      photo:document.querySelector(".photo-frame img")?.naturalWidth||0,
      courseLinks:cards.map(c=>c.querySelector("a")?.getAttribute("href")),
      toolsHref:document.querySelector(".tools-strip a")?.getAttribute("href"),
      font:getComputedStyle(document.querySelector("h1")).fontFamily};
   });
   await page.screenshot({path:"toefl-v2-browser-results/"+lang.replace("-","_")+"-"+device+".png",fullPage:true});
   if(response.status()!==200)failures.push(route+device+" HTTP "+response.status());
   if(metrics.lang!==lang||metrics.dir!==dir)failures.push(route+device+" locale mismatch");
   if(metrics.h1.length!==1)failures.push(route+device+" heading count "+metrics.h1.length);
   if(metrics.cards!==6)failures.push(route+device+" expected 6 course cards");
   if(metrics.xScroll)failures.push(route+device+" horizontal overflow");
   if(metrics.photo<250)failures.push(route+device+" campus image missing");
   if(metrics.courseLinks.some(x=>!x||!x.includes("/courses/")))failures.push(route+device+" bad course links");
   if(!metrics.toolsHref?.includes("/tools/"))failures.push(route+device+" tools route missing");
   if(errors.length)failures.push(...errors.map(x=>route+device+" "+x));
   if(device==="mobile"){
    await page.locator(".mobile-menu summary").click();
    if(!await page.locator(".mobile-menu").evaluate(e=>e.open))failures.push(route+" mobile menu failed");
    const navVisible=await page.locator(".mobile-menu nav a").first().isVisible();
    if(!navVisible)failures.push(route+" mobile links hidden");
   }
   summaries.push({route,device,...metrics,errors});
   await context.close();
  }
 }
 for(const route of ["/","/fa/","/ps/"]){
   const tools=await fetch(base+(route==="/"?"/tools/":route+"tools/"),{redirect:"manual",signal:AbortSignal.timeout(25000)});
   const html=await tools.text();
   summaries.push({path:route+"tools/",status:tools.status,robots:tools.headers.get("x-robots-tag"),bytes:html.length});
   if(tools.status!==200||!html.includes("index-Ch3KjNPK"))failures.push(route+" legacy portal lost");
   if(!/noindex/.test(tools.headers.get("x-robots-tag")||""))failures.push(route+" tools not noindex");
 }
 const cms=await fetch(base+"/api/content",{signal:AbortSignal.timeout(20000)});
 const apiBody=await cms.text();
 if(cms.status!==200||!apiBody.includes('"cmsStatus":"connected"'))failures.push("legacy CMS disconnected");
 summaries.push({apiStatus:cms.status,bytes:apiBody.length});
 console.log(JSON.stringify({checked:summaries.length,failures,summaries},null,2));
 assert.deepEqual(failures,[]);
}finally{await browser.close();}

})().catch(e=>{console.error(e);process.exitCode=1});
