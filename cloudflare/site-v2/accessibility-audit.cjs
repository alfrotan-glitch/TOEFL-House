(async()=>{
const assert=require("node:assert/strict");
const {chromium}=require("/tmp/toefl-accessibility/node_modules/playwright-core");
const axe=require("/tmp/toefl-accessibility/node_modules/axe-core");
const base="https://the-toefl-house.pages.dev";
const pages=["/","/fa/","/ps/","/courses/toefl-preparation/","/fa/courses/toefl-preparation/","/ps/courses/toefl-preparation/","/admissions/","/fa/admissions/","/ps/admissions/"];
let browser;
const results=[],failures=[];
try{
 browser=await chromium.launch({headless:true,executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
 const context=await browser.newContext({viewport:{width:390,height:844},bypassCSP:true});
 for(const path of pages){
  const page=await context.newPage();
  const response=await page.goto(base+path,{waitUntil:"networkidle",timeout:30000});
  assert.equal(response.status(),200,path);
  await page.addScriptTag({content:axe.source});
  const output=await page.evaluate(async()=>await window.axe.run(document,{
   runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21a","wcag21aa"]},
   rules:{"region":{enabled:false}}
  }));
  const issues=output.violations.map(v=>({id:v.id,impact:v.impact,description:v.description,nodes:v.nodes.slice(0,4).map(n=>({target:n.target,summary:n.failureSummary?.slice(0,330)}))}));
  const blocking=issues.filter(x=>["critical","serious"].includes(x.impact));
  results.push({path,passed:output.passes.length,violations:issues});
  if(blocking.length)failures.push({path,blocking});
  await page.close();
 }
 await context.close();
 console.log(JSON.stringify({tested:results.length,failures,results},null,2));
 assert.equal(failures.length,0,"Serious/critical WCAG violations found");
}finally{if(browser)await browser.close();}

})().catch(e=>{console.error(e);process.exitCode=1});
