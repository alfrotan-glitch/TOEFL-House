const assert=require("node:assert/strict");
const fs=require("node:fs");
const {chromium}=require("/tmp/toefl-campaign-browser/node_modules/playwright-core");
const base=(process.env.TH_SEMESTER_URL||"https://802cf8b6.the-toefl-house.pages.dev").replace(/\/$/,"");
const cases=[["/","en"],["/fa/","fa-AF"],["/ps/","ps-AF"]];
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required"]});
 const results=[],errors=[];
 fs.mkdirSync("/tmp/semester-proof",{recursive:true});
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1});
  const page=await context.newPage();
  page.on("pageerror",e=>errors.push(String(e)));
  for(const [path,lang] of cases){
   const response=await page.goto(base+path,{waitUntil:"networkidle",timeout:30000});
   assert.equal(response.status(),200,path);
   assert.match(response.headers()["x-robots-tag"]||"",/noindex/,path+" preview must not be indexed");
   const state=await page.evaluate(()=>{
    const section=document.querySelector("#semester-qaws-1405");
    const video=section?.querySelector("video");
    const link=section?.querySelector(".semester-primary");
    const campaignLink=new URL(link?.href||"",location.href);
    const source=video?.querySelector("source")?.src||"";
    return {
     language:document.documentElement.lang,section:!!section,
     headings:section?.querySelectorAll("h2").length||0,
     title:section?.querySelector("h2")?.innerText||"",
     source,poster:video?.poster||"",controls:video?.controls,
     playsinline:video?.playsInline,preload:video?.preload,
     autoplay:video?.autoplay,muted:video?.muted,
     width:document.documentElement.scrollWidth,viewport:innerWidth,
     ctaPath:campaignLink.pathname,sourceTag:campaignLink.searchParams.get("utm_source"),
     campaignTag:campaignLink.searchParams.get("utm_campaign"),
     programAnchor:section?.querySelector('a[href="#programs"]')!=null,
     rootVideos:document.querySelectorAll("video").length,
     cssLoaded:!!document.querySelector('link[href^="/__th/v2/site.css?v="]')
    };
   });
   assert.equal(state.language,lang,path);
   assert.equal(state.section,true,path);
   assert.equal(state.headings,1,path);
   assert.ok(state.title.length>30,path);
   assert.equal(state.controls,true,path);
   assert.equal(state.playsinline,true,path);
   assert.equal(state.preload,"none",path);
   assert.equal(state.autoplay,false,path);
   assert.ok(state.poster.includes("campus-640_"),path);
   assert.ok(state.source.includes("cloudfront.net/"),path);
   assert.equal(state.width<=state.viewport+3,true,path+" horizontal overflow");
   assert.equal(state.ctaPath,path+"admissions/",path);
   assert.equal(state.sourceTag,"website",path);
   assert.equal(state.campaignTag,"qaws_1405_semester",path);
   assert.equal(state.programAnchor,true,path);
   assert.equal(state.rootVideos,1,path);
   assert.equal(state.cssLoaded,true,path);
   results.push({path,status:response.status(),...state});
   await page.locator("#semester-qaws-1405").screenshot({path:"/tmp/semester-proof/campaign-"+(lang==="fa-AF"?"fa":lang==="ps-AF"?"ps":"en")+"-mobile.png"});
  }
  await page.goto(base+"/fa/",{waitUntil:"networkidle",timeout:30000});
  await page.locator("#semester-qaws-1405 video").evaluate(async video=>{
   video.muted=true;
   await video.play();
  });
  await page.waitForFunction(()=>document.querySelector("#semester-qaws-1405 video").currentTime>0.2,null,{timeout:15000});
  const playback=await page.locator("#semester-qaws-1405 video").evaluate(video=>({duration:video.duration,ready:video.readyState,time:video.currentTime,paused:video.paused,width:video.videoWidth,height:video.videoHeight}));
  assert.ok(playback.duration>35&&playback.duration<37,"Unexpected original video duration");
  assert.ok(playback.ready>=2,"Video did not buffer");
  assert.equal(playback.paused,false,"Video failed to play");
  assert.equal(playback.width,720);
  assert.equal(playback.height,1280);
  results.push({videoPlayback:"PASS",...playback});
  await page.locator("#semester-qaws-1405 video").evaluate(video=>video.pause());
  await page.setViewportSize({width:1440,height:900});
  await page.reload({waitUntil:"networkidle"});
  await page.locator("#semester-qaws-1405").screenshot({path:"/tmp/semester-proof/campaign-fa-desktop.png"});
  const desktop=await page.evaluate(()=>({viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth+3,videoWidth:Math.round(document.querySelector(".semester-video-frame").getBoundingClientRect().width)}));
  assert.equal(desktop.overflow,false,"Desktop horizontal overflow");
  assert.ok(desktop.videoWidth>=260,"Desktop video too narrow");
  results.push({desktop});
  assert.deepEqual(errors,[],"No uncaught browser JavaScript errors");
  console.log(JSON.stringify({base,status:"PASS",results,errors},null,2));
  await context.close();
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});