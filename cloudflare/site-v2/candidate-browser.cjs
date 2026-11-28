// Isolated browser qualification of the compiled Worker. This is NOT a Pages deployment.
// Network is intercepted; no production CMS, legacy bindings, external assets or writes.
const assert=require('node:assert/strict');
const {readFile,mkdir}=require('node:fs/promises');
const {createHash}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {join}=require('node:path');
const {chromium}=require('playwright-core');
const axe=require('axe-core');

(async()=>{
 const artifact=join(__dirname,'dist/_worker.js');
 const bytes=await readFile(artifact);
 const sha256=createHash('sha256').update(bytes).digest('hex');
 const {default:worker}=await import(pathToFileURL(artifact));
 const font=Buffer.from(await readFile(join(__dirname,'vendor-font/Vazirmatn-33.003.woff2.base64'),'utf8'),'base64');
 assert.equal(createHash('sha256').update(font).digest('hex'),'4e3fa217d38fdafc1fea4414ceb58ca5e662cf0ab5fa735a8c8c20e8b42cad92','vendored font integrity');
 const origin='https://candidate.toeflhouse.pages.dev';
 // Synthetic public CMS fixture, not a copy of production data.
 const ids=['general-english','academic-english','toefl-preparation','special-speaking','professional-writing','teacher-training','online-individual-zoom'];
 const programs=ids.map(id=>({id,title:id,summary:'Example program',duration:id==='toefl-preparation'?'4 months':'2 months'}));
 const main={locales:{en:{programs},fa:{programs}},media:{},timetable:{}};
 const pashto={programs};
 const env={CMS_DB:{prepare(sql){return {async first(){return {body:JSON.stringify(sql.includes('pashto_content')?pashto:main),revision:1};}}}}};
 const out=process.env.TOEFL_SCREENSHOTS||'.sandbox/candidate-screenshots';
 await mkdir(out,{recursive:true});
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox','--disable-dev-shm-usage']});
 const context=await browser.newContext({bypassCSP:true,serviceWorkers:'block',reducedMotion:'reduce'});
 const intercept=async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==origin || !['GET','HEAD'].includes(request.method()))return route.abort();
  // Font is the checksum-pinned source already vendored in this repository. All
  // production-only assets/bindings deliberately remain unavailable in this test.
  if(url.pathname==='/__th/v2/font/vazirmatn-33.003.woff2')return route.fulfill({status:200,contentType:'font/woff2',body:font});
  const response=await worker.fetch(new Request(request.url(),{method:request.method()}),env);
  const headers=Object.fromEntries(response.headers.entries());
  return route.fulfill({status:response.status,headers,body:Buffer.from(await response.arrayBuffer())});
 };
 await context.route('**/*',intercept);
 let page;
 try{
  const sitemap=await worker.fetch(new Request(origin+'/sitemap.xml'),{});
  assert.match(sitemap.headers.get('x-robots-tag'),/noindex/);
  const xml=await sitemap.text();
  const paths=[...xml.matchAll(/<loc>https:\/\/toeflhouse\.pages\.dev([^<]+)<\/loc>/g)].map(m=>m[1]);
  assert.equal(paths.length,39); assert.equal(new Set(paths).size,39);
  const unsafe=await worker.fetch(new Request(origin+'/api/admin/content',{method:'POST',body:'{}'}),{});
  assert.equal(unsafe.status,403);
  page=await context.newPage();
  const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
  const widths=[320,390,768,1024,1440,1920];
  for(const width of widths){
   await page.setViewportSize({width,height:900});
   for(const path of paths){
    const response=await page.goto(origin+path,{waitUntil:'load',timeout:30000});
    assert.equal(response.status(),200,`${width} ${path}`);
    assert.match(response.headers()['x-robots-tag']||'',/noindex/,path);
    assert.equal(await page.locator('h1').count(),1,`${width} ${path} h1`);
    const overflow=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));
    if(overflow.scroll>overflow.client+2){
     const offenders=await page.evaluate(()=>[...document.querySelectorAll('body *')].map(e=>({tag:e.tagName,cls:e.className,left:Math.round(e.getBoundingClientRect().left),right:Math.round(e.getBoundingClientRect().right)})).filter(e=>e.left < -2 || e.right > document.documentElement.clientWidth+2).slice(0,20));
     assert.fail(`${width} ${path} overflow ${JSON.stringify(overflow)} ${JSON.stringify(offenders)}`);
    }
   }
  }
  for(const width of [768,1024,1200]){
   await page.setViewportSize({width,height:900});
   await page.goto(origin+'/',{waitUntil:'load'});
   const toggle=page.locator('.mobile-menu summary');
   assert.equal(await toggle.isVisible(),true,`${width} navigation toggle`);
   await toggle.focus(); await page.keyboard.press('Enter');
   assert.equal(await page.locator('.mobile-menu nav a').first().isVisible(),true,`${width} navigation links`);
   await page.keyboard.press('Escape');
   assert.equal(await page.locator('.mobile-menu').evaluate(e=>e.open),false);
   assert.equal(await toggle.evaluate(e=>document.activeElement===e),true);
  }
  for(const [prefix,lang] of [['/','en'],['/fa/','fa'],['/ps/','ps']]){
   await page.setViewportSize({width:390,height:900});
   await page.goto(origin+prefix+'courses/general-english/',{waitUntil:'load'});
   const panel=page.locator('[data-ge-practice]'), qs=panel.locator('[data-ge-question]');
   assert.equal(await qs.count(),3,lang);
   const labels=await panel.evaluate(e=>({...e.dataset}));
   for(const [i,value,correct] of [[0,'1',true],[1,'0',false],[2,'0',true]]){
    const q=qs.nth(i),check=q.locator('[data-ge-check]');
    assert.equal(await check.isDisabled(),true);
    await q.locator(`input[value="${value}"]`).check(); await check.click();
    assert.equal(await q.locator('[data-ge-feedback]').textContent(),correct?labels.correctLabel:labels.incorrectLabel);
    assert.equal(await q.locator('input:disabled').count(),3);
    assert.equal(await q.locator('[data-ge-answer]').evaluate(e=>e.open&&!e.hidden),true);
   }
   assert.match(await panel.locator('[data-ge-progress]').textContent(),/3\/3/);
   await page.addScriptTag({content:axe.source});
   const violations=await panel.evaluate(async e=>(await window.axe.run(e,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}})).violations.map(v=>({id:v.id,impact:v.impact})));
   assert.deepEqual(violations,[],`${lang} practice accessibility`);
   await panel.screenshot({path:join(out,`practice-${lang}-390.png`)});
   await panel.locator('[data-ge-reset]').click();
   assert.equal(await panel.locator('input:checked').count(),0);
   assert.equal(await panel.locator('input:disabled').count(),0);
   assert.equal(await qs.first().locator('input').first().evaluate(e=>e===document.activeElement),true);
  }
  const noScript=await browser.newContext({javaScriptEnabled:false,serviceWorkers:'block'});
  try{
   await noScript.route('**/*',intercept);
   const fallback=await noScript.newPage();
   await fallback.setViewportSize({width:1024,height:900});
   for(const prefix of ['/','/fa/','/ps/']){
    await fallback.goto(origin+prefix+'courses/general-english/',{waitUntil:'load'});
    await fallback.locator('.mobile-menu summary').click();
    assert.equal(await fallback.locator('.mobile-menu nav a').first().isVisible(),true,'navigation without JavaScript');
    await fallback.locator('.mobile-menu summary').click();
    const panel=fallback.locator('[data-ge-practice]');
    assert.equal(await panel.locator('[data-ge-fallback]:visible').count(),3);
    const answer=panel.locator('[data-ge-answer]').first();
    await answer.locator('summary').click();
    assert.equal(await answer.evaluate(e=>e.open),true);
   }
  }finally{await noScript.close();}
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:'passed',workerSha256:sha256,routeCount:paths.length,widths,routeViewportChecks:paths.length*widths.length,tabletMenuWidths:[768,1024,1200],practiceLocales:3,noScriptLocales:3,practiceAxeViolations:0,screenshots:out,limits:['Local interception, not Cloudflare Pages','Synthetic CMS, no production bindings or external images','Automated checks do not establish WCAG compliance']},null,2));
 }finally{await context.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
