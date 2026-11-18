(async()=>{
const assert=require("node:assert/strict");
const {chromium}=require("/tmp/toefl-v2-quality-browser/node_modules/playwright-core");
const base="https://3a0bc72a.the-toefl-house.pages.dev";
const cases=[["/","en"],["/fa/","fa-AF"],["/ps/","ps-AF"]];
let browser,results=[],errors=[];
try{
 browser=await chromium.launch({headless:true,executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
 for(const [route,lang] of cases){
  const ctx=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1});
  const page=await ctx.newPage();
  page.on("pageerror",e=>errors.push(route+" "+String(e)));
  const r=await page.goto(base+route,{waitUntil:"networkidle",timeout:25000});
  const m=await page.evaluate(()=>{
    const hero=document.querySelector(".photo-frame img");
    const preload=document.querySelector('link[rel="preload"][as="image"]');
    return {lang:document.documentElement.lang,h1:document.querySelectorAll("h1").length,
      currentSrc:hero?.currentSrc||"",naturalWidth:hero?.naturalWidth||0,
      srcset:hero?.getAttribute("srcset")||"",
      preloadSet:preload?.getAttribute("imagesrcset")||"",
      overflow:document.documentElement.scrollWidth>innerWidth+2,
      courseCards:document.querySelectorAll(".course-card").length};
  });
  assert.equal(r.status(),200,route);
  assert.equal(m.lang,lang,route);
  assert.equal(m.h1,1,route);
  assert.ok(m.naturalWidth>200,route+" campus image not loaded");
  assert.match(m.currentSrc,/campus-640_c222a08a\.webp/,route+" should select smaller 640px image");
  assert.match(m.srcset,/640w.*960w.*1280w/,route+" image selection missing");
  assert.match(m.preloadSet,/640w.*960w.*1280w/,route+" preload resolution missing");
  assert.equal(m.courseCards,6,route);
  assert.equal(m.overflow,false,route+" horizontal overflow");
  assert.match(r.headers()["x-robots-tag"]||"",/noindex/,route+" preview indexable");
  results.push({route,...m});
  await ctx.close();
 }
 const pages=["/","/fa/","/ps/","/admissions/","/fa/admissions/","/ps/admissions/"];
 for(const prefix of ["","fa/","ps/"])for(const id of ["general-english","academic-english","toefl-preparation","special-speaking","professional-writing","teacher-training","online-individual-zoom"])pages.push("/"+prefix+"courses/"+id+"/");
 for(const path of pages){
  const response=await fetch(base+path,{signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200,path);
  assert.match(response.headers.get("X-Robots-Tag")||"",/noindex/,path+" preview robots");
  const html=await response.text();
  assert.ok(html.includes("/__th/v2/site.css"),path+" V2 design absent");
  if(path.includes("toefl-preparation"))assert.match(html,/4 months|۴ ماه|څلور میاشتې/,path+" TOEFL four months");
 }
 const [api,tools]=await Promise.all([fetch(base+"/api/content"),fetch(base+"/fa/tools/")]);
 assert.equal(api.status,200);assert.equal(tools.status,200);
 assert.ok((await api.text()).includes('"cmsStatus":"connected"'));
 assert.match(tools.headers.get("X-Robots-Tag")||"",/noindex/);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({homeBrowserResults:results,checkedPages:pages.length,errors},null,2));
}finally{if(browser)await browser.close();}

})().catch(e=>{console.error(e);process.exitCode=1});
