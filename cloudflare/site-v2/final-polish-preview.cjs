// Read-only release acceptance against an isolated Pages Preview deployment.
// This never saves/publishes CMS data, sends WhatsApp, or generates production click events.
(async()=>{
 const assert=require("node:assert/strict");
 const {chromium}=require("/tmp/toefl-v2-final-browser/node_modules/playwright-core");
 const base=process.env.V2_PREVIEW_BASE;
 assert.match(base||"",/^https:\/\/[a-f0-9]{8}\.the-toefl-house\.pages\.dev$/,"Provide an immutable Pages preview URL");
 const prefixes=["/","/fa/","/ps/"];
 const ids=["general-english","academic-english","toefl-preparation","special-speaking","professional-writing","teacher-training","online-individual-zoom"];
 const pages=[...prefixes,...prefixes.map(p=>p+"admissions/"),...prefixes.flatMap(p=>ids.map(id=>p+"courses/"+id+"/"))];
 const checks=[],errors=[];
 for(const path of pages){
  const res=await fetch(base+path,{signal:AbortSignal.timeout(22000),redirect:"manual"});
  const html=await res.text();
  assert.equal(res.status,200,"Page "+path);
  assert.match(res.headers.get("x-robots-tag")||"",/noindex/,"Preview must be unindexed: "+path);
  assert.match(html,/<html lang="(?:en|fa-AF|ps-AF)"/,"Language not set: "+path);
  assert.match(html,/\/__th\/v2\/site\.css\?v=6077011585aa/,"Candidate asset hash missing: "+path);
  assert.equal((html.match(/<h1(?:\s|>)/gi)||[]).length,1,"H1 count "+path);
  if(path.endsWith("toefl-preparation/")) assert.match(html,/4 months|۴ ماه|څلور میاشتې/,"TOEFL 4 months: "+path);
  if(path==="/fa/")assert.match(html,/<title>تافل هوس \| کورس زبان انگلیسی/);
  if(path==="/fa/admissions/")assert.match(html,/تافل هوس/);
  checks.push({path,status:res.status,noindex:true});
 }
 const [cms,tools,admin,css,js]=await Promise.all([
  fetch(base+"/api/content"),fetch(base+"/fa/tools/"),fetch(base+"/admin/"),
  fetch(base+"/__th/v2/site.css?v=6077011585aa"),
  fetch(base+"/__th/v2/site.js?v=6077011585aa")
 ]);
 assert.equal(cms.status,200);
 assert.ok((await cms.text()).includes('"cmsStatus":"connected"'),"Preview CMS not connected to published content");
 assert.equal(tools.status,200);
 assert.match(tools.headers.get("x-robots-tag")||"",/noindex/);
 assert.equal(admin.status,200);
 assert.match(admin.headers.get("x-robots-tag")||"",/noindex/);
 assert.equal(css.status,200);assert.equal(js.status,200);
 const jsBody=await js.text();
 assert.match(jsBody,/if\(location\.hash\)\{try\{known=decodeURIComponent/,"Unexpected Javascript bundle");
 assert.match(jsBody,/صنف‌های تافل هوس/,"Dari WhatsApp draft brand not corrected");
 let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
  for(const width of [390,1366]){
   for(const [path,lang] of [["/","en"],["/fa/","fa-AF"],["/ps/","ps-AF"]]){
    const context=await browser.newContext({viewport:{width,height:844}});
    const page=await context.newPage();
    page.on("pageerror",e=>errors.push(width+":"+path+": "+String(e)));
    const response=await page.goto(base+path,{waitUntil:"networkidle",timeout:30000});
    const state=await page.evaluate(()=>({
      lang:document.documentElement.lang,
      title:document.title,
      h1:document.querySelectorAll("h1").length,
      cards:document.querySelectorAll(".course-card").length,
      overflow:document.documentElement.scrollWidth>innerWidth+2,
      imageLoaded:document.querySelector(".photo-frame img")?.naturalWidth>100
    }));
    assert.equal(response.status(),200);
    assert.equal(state.lang,lang);
    assert.equal(state.h1,1);
    assert.equal(state.cards,6);
    assert.equal(state.overflow,false,"Horizontal overflow "+width+" "+path);
    assert.equal(state.imageLoaded,true,"Hero photo unavailable "+width+" "+path);
    await context.close();
   }
  }
  const page=await browser.newPage({viewport:{width:390,height:844}});
  page.on("pageerror",e=>errors.push("malformed-hash: "+String(e)));
  await page.goto(base+"/fa/#%not-valid",{waitUntil:"networkidle",timeout:30000});
  assert.ok((await page.locator(".mobile-menu").count())>0,"Mobile nav did not mount");
  await page.close();
 }finally{if(browser)await browser.close();}
 assert.deepEqual(errors,[],"Browser JavaScript exceptions");
 console.log(JSON.stringify({ok:true,base,pages:pages.length,viewports:[390,1366],browserPages:7,htmlAndCMS:"passed",legacy:"preserved",auth:"read-only",errors},null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
