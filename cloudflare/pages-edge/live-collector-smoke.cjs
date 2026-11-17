(async()=>{
const assert=require("node:assert/strict");
const {chromium}=require("/tmp/toefl-live-browser/node_modules/playwright-core");
const site="https://the-toefl-house.pages.dev/?utm_source=qa&utm_campaign=acceptance_20261118";
const browser=await chromium.launch({headless:true,executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const r=await page.goto(site,{waitUntil:"domcontentloaded",timeout:30000});
  assert.equal(r.status(),200);
  const collector=page.waitForResponse(x=>x.url()==="https://toefl-house-conversions.alfrotan2.workers.dev/e"&&x.request().method()==="POST",{timeout:20000});
  await page.evaluate(()=>{
    const a=document.createElement("a");
    a.href="https://wa.me/93794357509";
    a.addEventListener("click",e=>e.preventDefault());
    document.body.appendChild(a);
    a.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));
    a.remove();
  });
  const accepted=await collector;
  const body=JSON.parse(accepted.request().postData()||"{}");
  assert.equal(accepted.status(),204);
  assert.deepEqual(body,{action:"whatsapp",source:"qa",campaign:"acceptance_20261118",course:"all"});
  console.log(JSON.stringify({status:accepted.status(),recorded:body,origin:accepted.request().headers().origin||"browser"}));
}finally{await browser.close();}

})().catch(error=>{console.error(error);process.exitCode=1});
