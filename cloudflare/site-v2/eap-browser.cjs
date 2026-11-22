const assert=require("node:assert/strict");
const fs=require("node:fs");
const {chromium}=require("/tmp/toefl-eap-browser/node_modules/playwright-core");
const base=(process.env.TH_EAP_URL||"https://toeflhouse.pages.dev").replace(/\/$/,"");
const locales=[["/","en"],["/fa/","fa-AF"],["/ps/","ps-AF"]];
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:"/usr/bin/google-chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
 fs.mkdirSync("/tmp/eap-browser-evidence",{recursive:true});
 const checks=[],errors=[];
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
  page.on("pageerror",err=>errors.push(String(err)));
  for(const [root,lang] of locales){
   const path=root+"courses/academic-english/";
   const response=await page.goto(base+path,{waitUntil:"networkidle",timeout:40000});
   assert.equal(response.status(),200,path);
   const d=await page.evaluate(()=>{
    const levels=[...document.querySelectorAll(".eap-level")];
    const ctas=[...document.querySelectorAll(".eap-actions a")].map(a=>a.href);
    const video=document.querySelector("video");
    return {
     lang:document.documentElement.lang,
     title:document.querySelector(".eap-hero-copy h1")?.innerText,
     levels:levels.map(x=>({heading:x.querySelector("h3")?.textContent,books:[...x.querySelectorAll(".eap-assigned-books li")].map(n=>n.textContent),fourthNote:x.querySelector(".eap-fourth-note")?.textContent||""})),
     books:document.querySelectorAll(".eap-book").length,
     goals:document.querySelectorAll(".eap-goal").length,
     faqs:document.querySelectorAll(".eap-faq-list details").length,
     fees:document.querySelector(".eap-fee-grid")?.innerText,
     rootWidth:document.documentElement.scrollWidth,
     viewport:innerWidth,
     ctas,video:!!video,
     unindexed:document.querySelector('meta[name="robots"]')?.content||null
    }
   });
   assert.equal(d.lang,lang);
   assert.equal(d.levels.length,4);
   assert.equal(d.books,3);
   assert.equal(d.goals,4);
   assert.equal(d.faqs,6);
   assert.ok(d.rootWidth<=d.viewport+3,path+" horizontal scroll");
   assert.ok(d.ctas.some(c=>c.endsWith(root+"admissions/?program=academic-english")),path+" CTA");
   assert.equal(d.video,false,path+" should not download semester video");
   for(let i=1;i<=4;i++){
    assert.ok(d.levels[i-1].heading.includes("EAP "+i));
    assert.equal(d.levels[i-1].books.length,3);
    for(const series of ["ACTIVE Skills for Reading","Longman Academic Writing"]){
     assert.ok(d.levels[i-1].books.some(x=>x.includes(series+" "+i)),path+" missing "+series+" "+i);
    }
    // Publisher's Contemporary Topics 4th edition lists Books 1–3.
    // EAP 4 therefore must disclose that its listening book/material requires
    // academic-department confirmation, not invent a fourth-edition Book 4.
    if(i<=3)assert.ok(d.levels[i-1].books.some(x=>x.includes("Contemporary Topics "+i)),path+" missing Contemporary Topics "+i);
    else {
     assert.ok(d.levels[i-1].books.some(x=>x.includes("Contemporary Topics")&&!x.includes("Contemporary Topics 4")),path+" invented Contemporary Topics 4");
     assert.ok(d.levels[i-1].fourthNote.includes("EAP 4")&&d.levels[i-1].fourthNote.trim().length>50,path+" EAP 4 selection needs an explicit academic-department note");
    }
   }
   assert.ok(d.fees.includes("2,000")||d.fees.includes("۲٬۰۰۰"));
   const key=lang==="fa-AF"?"fa":lang==="ps-AF"?"ps":"en";
   await page.evaluate(()=>{let a=document.activeElement;if(a&&a!==document.body&&a.blur)a.blur();});
   await page.locator(".eap-hero").screenshot({path:"/tmp/eap-browser-evidence/eap-"+key+"-hero-mobile.png"});
   await page.locator("#eap-books").screenshot({path:"/tmp/eap-browser-evidence/eap-"+key+"-books-mobile.png"});
   await page.locator("#eap-fees").screenshot({path:"/tmp/eap-browser-evidence/eap-"+key+"-fees-mobile.png"});
   checks.push({path,status:response.status(),lang,levels:d.levels.length,books:d.books,goals:d.goals,faqs:d.faqs,noHorizontalOverflow:true});
  }
  await page.setViewportSize({width:1440,height:900});
  await page.goto(base+"/fa/courses/academic-english/",{waitUntil:"networkidle",timeout:40000});
  const layout=await page.evaluate(()=>({
   overflow:document.documentElement.scrollWidth>innerWidth+3,
   levelColumns:getComputedStyle(document.querySelector(".eap-levels")).gridTemplateColumns,
   bookColumns:getComputedStyle(document.querySelector(".eap-books-grid")).gridTemplateColumns,
   missingImages:[...document.images].filter(i=>!i.complete||i.naturalWidth===0).length
  }));
  assert.equal(layout.overflow,false);
  assert.equal(layout.missingImages,0);
  await page.locator(".eap-hero").screenshot({path:"/tmp/eap-browser-evidence/eap-fa-hero-desktop.png"});
  await page.locator("#eap-levels").screenshot({path:"/tmp/eap-browser-evidence/eap-fa-levels-desktop.png"});
  await page.locator("#eap-books").screenshot({path:"/tmp/eap-browser-evidence/eap-fa-books-desktop.png"});
  const home=await page.goto(base+"/fa/",{waitUntil:"networkidle",timeout:40000});
  assert.equal(home.status(),200);
  const card=page.locator(".semester-eap-spotlight");
  assert.equal(await card.count(),1);
  assert.equal((await card.getAttribute("href")),"/fa/courses/academic-english/");
  assert.match(await card.innerText(),/EAP/);
  await card.screenshot({path:"/tmp/eap-browser-evidence/eap-semester-home-spotlight.png"});
  await card.click();
  await page.waitForURL("**/fa/courses/academic-english/");
  assert.equal(await page.locator(".eap-fee-grid").count(),1);
  assert.deepEqual(errors,[],"Uncaught browser errors");
  console.log(JSON.stringify({result:"PASS",preview:base,checks,desktop:layout,homeToEapNavigation:"PASS",errors},null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
