const assert=require("node:assert/strict");
const {createHash}=require("node:crypto");
const fs=require("node:fs");
const {chromium}=require("/tmp/toefl-dari-browser/node_modules/playwright-core");
const base=(process.env.TH_DARI_BASE||"https://76c73b0a.the-toefl-house.pages.dev").replace(/\/$/,"");
const fontPath="/__th/v2/font/vazirmatn-33.003.woff2";
const expected="4e3fa217d38fdafc1fea4414ceb58ca5e662cf0ab5fa735a8c8c20e8b42cad92";
async function checkFont(){
 const r=await fetch(base+fontPath,{signal:AbortSignal.timeout(20000)});
 assert.equal(r.status,200,"font endpoint must be HTTP 200");
 assert.match(r.headers.get("content-type")||"",/font\/woff2/);
 const bytes=Buffer.from(await r.arrayBuffer());
 assert.ok(bytes.length>80000&&bytes.length<160000);
 assert.equal(bytes.subarray(0,4).toString(),"wOF2");
 assert.equal(createHash("sha256").update(bytes).digest("hex"),expected,"font bytes must be authentic pinned OFL file");
 const head=await fetch(base+fontPath,{method:"HEAD",signal:AbortSignal.timeout(15000)});
 assert.equal(head.status,200);
 const blocked=await fetch(base+fontPath,{method:"POST",signal:AbortSignal.timeout(15000)});
 assert.equal(blocked.status,405);
}
(async()=>{
 await checkFont();
 const browser=await chromium.launch({headless:true,executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
 fs.mkdirSync("/tmp/toefl-dari-evidence",{recursive:true});
 const summary=[];
 try{
  for(const [locale,width] of [["fa",320],["fa",390],["fa",1440],["ps",390]]){
   const root=locale==="fa"?"/fa/":"/ps/";
   const page=await browser.newPage({viewport:{width,height:844},deviceScaleFactor:1});
   const errors=[];
   page.on("pageerror",e=>errors.push(String(e)));
   const r=await page.goto(base+root+"#faq",{waitUntil:"networkidle",timeout:35000});
   assert.equal(r.status(),200);
   await page.evaluate(()=>document.fonts.ready);
   const view=await page.evaluate(()=>{
    const h=document.querySelector(".site-header").getBoundingClientRect();
    const f=document.querySelector("#faq").getBoundingClientRect();
    const title=document.querySelector(".faq-aside h2").getBoundingClientRect();
    const css=getComputedStyle(document.body);
    const raw=document.querySelector(".faq-aside h2").textContent;
    return {lang:document.documentElement.lang,font:css.fontFamily,headingY:title.top,headerBottom:h.bottom,faqTop:f.top,overflow:document.documentElement.scrollWidth>innerWidth+2,wordPeh:raw.includes("پ"),pehCp:"پ".codePointAt(0),color:css.color};
   });
   assert.equal(view.lang,locale==="fa"?"fa-AF":"ps-AF");
   assert.equal(view.overflow,false,root+" "+width+" horizontal overflow");
   assert.ok(view.headingY>=view.headerBottom+8,root+" "+width+" sticky header covers FAQ: "+JSON.stringify(view));
   if(locale==="fa"){
    assert.ok(view.font.startsWith("THDari"),"Dari font must be selected: "+view.font);
    assert.equal(view.pehCp,0x067e);
    assert.equal(view.wordPeh,true,"FAQ heading must use genuine Unicode Peh");
    const count=await page.evaluate(()=>document.fonts.load("400 16px THDari").then(x=>x.length));
    assert.ok(count>=1,"FontFace failed to load");
   }else assert.ok(view.font.startsWith("THArabic"),"Pashto font must remain original: "+view.font);
   await page.screenshot({path:"/tmp/toefl-dari-evidence/"+locale+"-faq-"+width+".png",fullPage:false});
   assert.deepEqual(errors,[],root+" "+width+" browser errors");
   summary.push({locale,width,...view});
   await page.close();
  }
  const page=await browser.newPage({viewport:{width:390,height:844}});
  for(const path of ["/fa/","/fa/courses/academic-english/","/fa/courses/toefl-preparation/","/fa/admissions/"]){
   const r=await page.goto(base+path,{waitUntil:"domcontentloaded",timeout:30000});
   assert.equal(r.status(),200,path);
   const text=await page.locator("body").innerText();
   assert.ok(!text.includes("پوهنتون"),path+" contains legacy terminology");
   if(path==="/fa/"||path.includes("academic-english"))assert.ok(text.includes("دانشگاه"),path+" needs university wording");
  }
  await page.goto(base+"/ps/",{waitUntil:"domcontentloaded"});
  assert.ok((await page.locator("body").innerText()).includes("پوهنتون"),"Pashto terms must be preserved");
  await page.close();
  console.log("DARI_TYPOGRAPHY_QA "+JSON.stringify({pass:true,base,fontVerified:true,screenshots:summary.length,summary}));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
