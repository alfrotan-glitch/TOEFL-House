/* Browser QA for the complete public website, not just the EAP course.
 * Chrome checks actual Cloudflare Pages output in EN, Afghan Dari and Pashto.
 */
const assert=require("node:assert/strict");
const fs=require("node:fs");
const {chromium}=require("/tmp/toefl-eap-browser/node_modules/playwright-core");
const base=(process.env.TH_EAP_URL||"https://the-toefl-house.pages.dev").replace(/\/$/,"");
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
 const results=[],errors=[],dir="/tmp/eap-browser-evidence";
 fs.mkdirSync(dir,{recursive:true});
 const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
 page.on("pageerror",x=>errors.push(String(x)));
 async function open(path){
  const response=await page.goto(base+path,{waitUntil:"networkidle",timeout:40000});
  assert.equal(response.status(),200,path+" HTTP status");
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+3),path+" horizontal overflow");
  assert.equal(await page.locator("h1").count(),1,path+" must have one principal heading");
 }
 const locales=[["/","en"],["/fa/","fa-AF"],["/ps/","ps-AF"]];
 try{
  for(const [prefix,lang] of locales){
   await open(prefix);
   assert.equal(await page.locator("html").getAttribute("lang"),lang);
   assert.equal(await page.locator(".course-card").count(),6);
   const d=await page.evaluate(()=>{
    const px=s=>parseFloat(getComputedStyle(document.querySelector(s)).fontSize);
    const h=s=>parseFloat(getComputedStyle(document.querySelector(s)).minHeight);
    return {course: px(".course-copy"),cta:px(".course-bottom a"),nav:h(".language-links a"),button:h(".desktop-apply"),guideUrl:document.querySelector('a[href*="guides/"]')?.getAttribute("href")};
   });
   assert.ok(d.course>=14,"course descriptions must be readable at mobile width "+lang);
   assert.ok(d.cta>=13,"course detail links must be legible "+lang);
   assert.ok(d.nav>=40,"language controls must have touch-friendly height "+lang);
   await page.screenshot({path:dir+"/world-home-"+lang+".png",fullPage:false});
   results.push({path:prefix,lang,courseSize:d.course,ctaSize:d.cta,languageTapHeight:d.nav});
  }
  for(const [prefix,lang] of locales){
   const route=prefix+"guides/";
   await open(route);
   assert.equal(await page.locator("html").getAttribute("lang"),lang);
   assert.equal(await page.locator("main.editorial-guides").count(),1,route+" must use canonical site shell");
   assert.equal(await page.locator(".site-header").count(),1);
   assert.equal(await page.locator(".growth-card h2").count(),3,"guide cards must expose headings");
   assert.equal(await page.locator(".growth-card").count(),3);
   const small=await page.locator(".growth-card p").first().evaluate(x=>parseFloat(getComputedStyle(x).fontSize));
   assert.ok(small>=15,route+" guide descriptions too small");
   await page.screenshot({path:dir+"/world-guides-"+lang+".png",fullPage:false});
   results.push({path:route,lang,guideCards:3,guideTextSize:small});
  }
  for(const path of ["/guides/toefl-ibt-2026/","/fa/guides/speaking-practice/","/ps/guides/english-courses-kabul/"]){
   await open(path);
   assert.equal(await page.locator("main.editorial-guides .growth-article").count(),1);
   assert.ok(await page.locator("main .growth-article h2").count()>=4);
   assert.equal(await page.locator('.growth-article a[href*="#start"]').count(),0,"old anchor should be replaced");
   await page.screenshot({path:dir+"/world-article-"+path.split("/").filter(Boolean).join("-")+".png",fullPage:false});
   results.push({path,article:true});
  }
  await open("/fa/admissions/");
  const fields=await page.locator("#v2-enquiry-form select").count();
  assert.equal(fields,3);
  assert.ok(await page.locator("#v2-enquiry-form").isVisible());
  await open("/fa/courses/academic-english/");
  const fact=await page.locator(".eap-fact span").first().evaluate(x=>parseFloat(getComputedStyle(x).fontSize));
  assert.ok(fact>=13, "EAP facts must not be rendered at 10px");
  const books=await page.locator(".eap-assigned-books li").first().evaluate(x=>parseFloat(getComputedStyle(x).fontSize));
  assert.ok(books>=13,"EAP textbook labels must be legible");
  results.push({path:"/fa/courses/academic-english/",factTextSize:fact,bookTextSize:books});
  await page.setViewportSize({width:1440,height:900});
  for(const path of ["/fa/","/fa/guides/","/fa/guides/speaking-practice/","/fa/courses/academic-english/"]){
   await open(path);
   assert.equal(await page.locator(".site-header").count(),1);
  }
  assert.deepEqual(errors,[],"No uncaught JS errors");
  console.log(JSON.stringify({result:"PASS",base,checks:results,desktop:"PASS",jsErrors:errors},null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
