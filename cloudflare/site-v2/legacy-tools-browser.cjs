(async()=>{
const assert=require("node:assert/strict");
const {chromium}=require("/tmp/toefl-tools-browser/node_modules/playwright-core");
const base="https://5f7d9940.the-toefl-house.pages.dev";
const browser=await chromium.launch({headless:true,executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
const results=[],errors=[];
try{
 const context=await browser.newContext({viewport:{width:390,height:844}});
 const page=await context.newPage();
 page.on("pageerror",e=>errors.push(String(e)));
 for(const path of ["/tools/","/fa/tools/","/ps/tools/"]){
  const r=await page.goto(base+path,{waitUntil:"networkidle",timeout:30000});
  const m=await page.evaluate(()=>({title:document.title,lang:document.documentElement.lang,root:document.getElementById("root")?.textContent?.length||0,
    forms:document.querySelectorAll("form").length,
    inputs:document.querySelectorAll("form input").length,
    buttons:document.querySelectorAll("button").length,
    tools:document.body.textContent.includes("TOEFL")}));
  results.push({path,status:r.status(),noindex:r.headers()["x-robots-tag"],...m});
  assert.equal(r.status(),200);
  assert.ok(m.root>1000,path+" original interactive app not mounted");
  assert.ok(m.forms>=1,path+" original enquiry form missing");
  assert.ok(m.tools,path+" original learning tools absent");
  assert.match(r.headers()["x-robots-tag"]||"",/noindex/);
 }
 assert.deepEqual(errors,[],"Legacy app must not throw browser exceptions");
 console.log(JSON.stringify({results,errors},null,2));
 await context.close();
}finally{await browser.close();}

})().catch(e=>{console.error(e);process.exitCode=1});
