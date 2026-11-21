/* Browser regression for Cloudflare's short, Dari-first free Pages hostname.
 * No personal data or CMS operations; public pages and navigation only.
 */
const assert=require("node:assert/strict");
const fs=require("node:fs");
const {chromium}=require("/tmp/toefl-short-browser/node_modules/playwright-core");
const base=(process.env.TH_SHORT_BASE||"https://thaf.pages.dev").replace(/\/$/,"");

(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
 fs.mkdirSync("/tmp/toefl-short-evidence",{recursive:true});
 let checked=0;
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1});
  const page=await context.newPage();
  const errors=[];
  page.on("pageerror",e=>errors.push(String(e)));
  for(const [path,lang] of [["/","fa-AF"],["/en/","en"],["/ps/","ps-AF"],["/fa/","fa-AF"]]){
   const r=await page.goto(base+path,{waitUntil:"networkidle",timeout:35000});
   assert.equal(r.status(),200,"public alias "+path);
   assert.match(r.headers()["x-robots-tag"]||"",/noindex/,"avoid duplicate search indexing");
   const view=await page.evaluate(()=>{
    const logo=document.querySelector(".brand img");
    return {lang:document.documentElement.lang,logo:logo?.naturalWidth||0,
      overflow:document.documentElement.scrollWidth>window.innerWidth+2,
      title:document.querySelector("h1")?.textContent.trim()};
   });
   assert.equal(view.lang,lang,path+" language");
   assert.equal(view.overflow,false,path+" horizontal overflow");
   assert.ok(view.logo>=30,path+" image assets not loaded");
   assert.ok(view.title&&view.title.length>10,path+" empty page");
   await page.screenshot({path:"/tmp/toefl-short-evidence/home-"+lang+"-"+(path==="/"?"root":"localized")+".png"});
   checked++;
  }
  await page.goto(base+"/",{waitUntil:"networkidle",timeout:35000});
  await page.locator(".mobile-menu summary").click();
  await page.locator('.mobile-menu a[hreflang="en"]').click();
  await page.waitForURL(base+"/en/",{timeout:12000});
  assert.equal(await page.locator("html").getAttribute("lang"),"en","English switch at short root");
  checked++;
  await page.locator(".mobile-menu summary").click();
  await page.locator('.mobile-menu a[hreflang="fa-AF"]').click();
  await page.waitForURL(base+"/fa/",{timeout:12000});
  assert.equal(await page.locator("html").getAttribute("lang"),"fa-AF","Dari switch at short root");
  checked++;
  await page.locator("#course-special-speaking").click();
  await page.waitForURL(base+"/fa/courses/special-speaking/",{timeout:12000});
  assert.equal(await page.locator("h1").count(),1,"course detail");
  checked++;
  await page.locator(".mobile-quick-apply").click();
  await page.waitForURL(/\/fa\/admissions\/\?program=special-speaking/,{timeout:12000});
  assert.equal(await page.locator("#v2-program").inputValue(),"special-speaking");
  assert.equal(await page.locator("#v2-program-preview").isVisible(),true);
  await page.screenshot({path:"/tmp/toefl-short-evidence/admissions-fa.png"});
  checked++;
  assert.deepEqual(errors,[],"no browser JavaScript errors");
  await context.close();
  console.log(JSON.stringify({pass:true,shortDomain:base,checked,languageSwitches:true,assetsLoaded:true,admissions:true}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
