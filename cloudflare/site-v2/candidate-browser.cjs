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
  assert.equal(paths.length,51); assert.equal(new Set(paths).size,51);
  const unsafe=await worker.fetch(new Request(origin+'/api/admin/content',{method:'POST',body:'{}'}),{});
  assert.equal(unsafe.status,403);
  page=await context.newPage();
  const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
  // Compare the browser's behavior for syntax that a whitespace-only
  // compactor must not merge. This exercises the build, not a deployed page.
  const {compactStyles}=await import(pathToFileURL(join(__dirname,'build-styles.mjs')));
  const cssFixture='.parent\n.child { color: rgb(1, 2, 3); }\n@media screen\nand (min-width: 10px) {\n.child { margin-top: 7px; }\n}\n.child { --ink: rgb(4, 5, 6); border-color: var(--ink); }\n.\\31 \n.child { padding-left: 9px; }';
  async function cssBehavior(css){
   await page.setContent('<div class="parent 1"><span class="child">Sample</span></div>');
   await page.addStyleTag({content:css});
   return page.locator('.child').evaluate(el=>{const style=getComputedStyle(el);return [style.color,style.marginTop,style.borderTopColor,style.paddingLeft];});
  }
  const originalStyle=await cssBehavior(cssFixture);
  assert.deepEqual(originalStyle,['rgb(1, 2, 3)','7px','rgb(4, 5, 6)','9px']);
  assert.deepEqual(await cssBehavior(compactStyles(cssFixture)),originalStyle,'stylesheet compactor preserves significant whitespace');
  const widths=[320,390,768,1024,1440,1920];
  for(const width of widths){
   await page.setViewportSize({width,height:900});
   for(const path of paths){
    const response=await page.goto(origin+path,{waitUntil:'load',timeout:30000});
    assert.equal(response.status(),200,`${width} ${path}`);
    assert.match(response.headers()['x-robots-tag']||'',/noindex/,path);
    assert.equal(await page.locator('h1').count(),1,`${width} ${path} h1`);
    if(process.env.TOEFL_VISUAL_DIR||process.env.TOEFL_FULLPAGE_DIR){
     await page.evaluate(()=>document.fonts.ready);
     const name=encodeURIComponent(path)+`-${width}.png`;
     if(process.env.TOEFL_VISUAL_DIR){
      await mkdir(process.env.TOEFL_VISUAL_DIR,{recursive:true});
      await page.screenshot({path:join(process.env.TOEFL_VISUAL_DIR,name),animations:'disabled'});
     }
     if(process.env.TOEFL_FULLPAGE_DIR&&[390,1440].includes(width)){
      await mkdir(process.env.TOEFL_FULLPAGE_DIR,{recursive:true});
      await page.screenshot({path:join(process.env.TOEFL_FULLPAGE_DIR,name),animations:'disabled',fullPage:true});
     }
    }
    const overflow=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));
    if(overflow.scroll>overflow.client+2){
     const offenders=await page.evaluate(()=>[...document.querySelectorAll('body *')].map(e=>({tag:e.tagName,cls:e.className,left:Math.round(e.getBoundingClientRect().left),right:Math.round(e.getBoundingClientRect().right)})).filter(e=>e.left < -2 || e.right > document.documentElement.clientWidth+2).slice(0,20));
     assert.fail(`${width} ${path} overflow ${JSON.stringify(overflow)} ${JSON.stringify(offenders)}`);
    }
   }
  }
  if(process.env.TOEFL_AXE_ALL==='1'){
   const violations=[];
   await page.setViewportSize({width:390,height:900});
   for(const path of paths){
    await page.goto(origin+path,{waitUntil:'load'});
    await page.addScriptTag({content:axe.source});
    const found=await page.evaluate(async()=>(await window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}})).violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.length})));
    if(found.length)violations.push({path,found});
   }
   console.log(JSON.stringify({fullPageAxeRoutes:paths.length,violations},null,2));
   assert.deepEqual(violations,[],'full-page automated accessibility checks');
  }
  const bookSlugs=['got-it-series','active-skills-for-reading','longman-academic-writing','contemporary-topics'];
  for(const [prefix,lang] of [['/','en'],['/fa/','fa'],['/ps/','ps']]){
   for(const width of [390,1440]){
    await page.setViewportSize({width,height:900});
    for(const [path,label] of [[prefix+'guides/','library'],[prefix+'guides/got-it-series/','book']]){
     await page.goto(origin+path,{waitUntil:'load'});
     await page.screenshot({path:join(out,`${label}-${lang}-${width}.png`)});
    }
   }
   await page.setViewportSize({width:390,height:900});
   for(const slug of ['english-courses-kabul','toefl-ibt-2026','speaking-practice',...bookSlugs]){
    await page.goto(origin+prefix+'guides/'+slug+'/',{waitUntil:'load'});
    const links=page.locator('.guide-contents ol a');
    assert.ok(await links.count()>=2,`${lang} ${slug} contents`);
    const href=await links.last().getAttribute('href');
    await links.last().focus();await page.keyboard.press('Enter');
    assert.equal(new URL(page.url()).hash,href,`${lang} ${slug} keyboard section navigation`);
    assert.equal(await page.locator(href).count(),1,`${lang} ${slug} section target`);
    const related=page.locator('.guide-related .growth-card');
    assert.equal(await related.count(),2,`${lang} ${slug} related guides`);
    const next=await related.first().getAttribute('href');
    assert.ok(next.startsWith(prefix+'guides/'),`${lang} ${slug} related locale`);
    await related.first().focus();
    await Promise.all([page.waitForURL(origin+next),page.keyboard.press('Enter')]);
    assert.equal(new URL(page.url()).pathname,next,`${lang} ${slug} keyboard related navigation`);
    assert.equal(await page.locator('h1').count(),1,`${lang} ${slug} related page`);
   }
   for(const slug of bookSlugs){
    await page.goto(origin+prefix+'guides/'+slug+'/',{waitUntil:'load'});
    const feedback=page.locator('.book-feedback'),notes=page.locator('#book-notes');
    assert.equal(await notes.count(),1,`${lang} ${slug} practice notes`);
    assert.equal(await notes.evaluate(e=>!!e.closest('form')),false,`${lang} ${slug} notes are not submitted`);
    const requests=[];const recordRequest=request=>requests.push(request.url());page.on('request',recordRequest);
    await notes.focus();await page.keyboard.type('My practice answer');
    assert.equal(await notes.inputValue(),'My practice answer');
    const answer=lang==='fa'?'تمرین من':lang==='ps'?'زما تمرین':'My practice answer';
    await notes.fill(answer);
    assert.equal(await notes.evaluate(e=>getComputedStyle(e).direction),lang==='en'?'ltr':'rtl',`${lang} ${slug} notes follow input direction`);
    assert.equal(await feedback.evaluate(e=>e.open),false,`${lang} ${slug} feedback starts closed`);
    await page.keyboard.press('Tab');
    assert.equal(await feedback.locator('summary').evaluate(e=>e===document.activeElement),true,`${lang} ${slug} keyboard path to feedback`);
    await page.keyboard.press('Enter');
    assert.equal(await feedback.evaluate(e=>e.open),true,`${lang} ${slug} feedback opens by keyboard`);
    assert.equal(await feedback.locator('p').first().isVisible(),true,`${lang} ${slug} feedback visible`);
    assert.equal(await notes.inputValue(),answer,`${lang} ${slug} answer remains while checking`);
    await page.waitForTimeout(100);page.off('request',recordRequest);
    assert.deepEqual(requests,[],`${lang} ${slug} typing and feedback do not send a request`);
    await page.locator('.book-exercise').screenshot({path:join(out,`exercise-${slug}-${lang}-390.png`),animations:'disabled'});
    await feedback.screenshot({path:join(out,`feedback-${slug}-${lang}-390.png`),animations:'disabled'});
    await page.addScriptTag({content:axe.source});
    const violations=await page.locator('main').evaluate(async e=>(await window.axe.run(e,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}})).violations.map(v=>({id:v.id,impact:v.impact})));
    assert.deepEqual(violations,[],`${lang} ${slug} accessibility`);
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
  // Intercept every WhatsApp handoff: no request leaves this browser fixture.
  for(const [prefix,lang] of [['/','en'],['/fa/','fa'],['/ps/','ps']]){
   await page.setViewportSize({width:390,height:900});
   await page.goto(origin+prefix+'admissions/?program=online-individual-zoom&format=campus&when=afternoon',{waitUntil:'load'});
   const form=page.locator('#v2-enquiry-form'),program=form.locator('#v2-program'),format=form.locator('#v2-format'),when=form.locator('#v2-when');
   assert.equal(await form.locator('.form-submit').isEnabled(),true,`${lang} message builder ready`);
   assert.equal(await form.locator('#v2-enquiry-fallback').isHidden(),true,`${lang} fallback hidden when ready`);
   assert.equal(await format.inputValue(),'online',`${lang} online-only program`);
   assert.equal(await format.locator('option[value="campus"]').isDisabled(),true);
   await program.selectOption('general-english');
   assert.equal(await format.locator('option[value="campus"]').isDisabled(),false);
   await program.selectOption('toefl-preparation');await format.selectOption('online');await when.selectOption('afternoon');
   assert.equal(await form.locator('#v2-program-preview').isVisible(),true,`${lang} program guidance`);
   const other=page.locator('.mobile-language a[hreflang="'+(lang==='en'?'fa-AF':'en')+'"]');
   const href=new URL(await other.getAttribute('href'),origin);
   assert.equal(href.searchParams.get('program'),'toefl-preparation');
   assert.equal(href.searchParams.get('format'),'online');
   assert.equal(href.searchParams.get('when'),'afternoon');
   const labels=await Promise.all([program,format,when].map(x=>x.locator('option:checked').textContent()));
   const draftRequest=page.waitForRequest(req=>req.url().startsWith('https://wa.me/')&&req.url().includes('?text='));
   await form.locator('.form-submit').click();
   const draft=new URL((await draftRequest).url()).searchParams.get('text');
   for(const label of labels)assert.ok(draft.includes(label),`${lang} selected option included in intercepted draft`);
  }
  // Simulate a broken client bundle, not just a browser with scripting disabled.
  const blockClient=route=>route.abort();
  await page.route('**/__th/v2/site.js?*',blockClient);
  for(const [prefix,lang] of [['/','en'],['/fa/','fa'],['/ps/','ps']]){
   await page.goto(origin+prefix+'admissions/',{waitUntil:'load'});
   const enquiry=page.locator('#v2-enquiry-form'),fallback=enquiry.locator('#v2-enquiry-fallback');
   assert.equal(await enquiry.locator('.form-submit').isDisabled(),true,`${lang} failed script keeps builder disabled`);
   assert.equal(await fallback.isVisible(),true,`${lang} failed script shows contact fallback`);
   await page.addScriptTag({content:axe.source});
   const violations=await fallback.evaluate(async e=>(await window.axe.run(e,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}})).violations.map(v=>v.id));
   assert.deepEqual(violations,[],`${lang} contact fallback axe`);
   await enquiry.screenshot({path:join(out,`admissions-fallback-${lang}-390.png`),animations:'disabled'});
  }
  await page.unroute('**/__th/v2/site.js?*',blockClient);
  // Verify the expanded native hit area, including keyboard focus, after CSS changes.
  for(const prefix of ['/','/fa/','/ps/'])for(const width of [390,1440]){
   await page.setViewportSize({width,height:900});
   await page.goto(origin+prefix,{waitUntil:'load'});
   const card=page.locator('#course-special-speaking');
   await card.scrollIntoViewIfNeeded();
   assert.deepEqual(await card.evaluate(e=>{
    const link=e.querySelector('.course-bottom a'),r=e.getBoundingClientRect();
    const hit=document.elementFromPoint(r.left+8,r.top+8);
    link.focus();
    return {position:getComputedStyle(e).position,hit:hit===link,focus:document.activeElement===link};
   }),{position:'relative',hit:true,focus:true},`${prefix} ${width} whole-card native link`);
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
    await fallback.goto(origin+prefix+'admissions/',{waitUntil:'load'});
    const enquiry=fallback.locator('#v2-enquiry-form');
    assert.equal(await enquiry.locator('.form-submit').isDisabled(),true,'unavailable builder cannot submit');
    assert.equal(await enquiry.locator('#v2-enquiry-fallback').isVisible(),true,'direct contact fallback visible');
    assert.equal(await enquiry.locator('#v2-enquiry-fallback a[href^="https://wa.me/"]').count(),1);
    assert.equal(await enquiry.locator('#v2-enquiry-fallback a[href^="tel:"]').count(),1);
    await fallback.goto(origin+prefix+'guides/active-skills-for-reading/',{waitUntil:'load'});
    const contentLink=fallback.locator('.guide-contents ol a').last(),fragment=await contentLink.getAttribute('href');
    await contentLink.focus();await fallback.keyboard.press('Enter');
    assert.equal(new URL(fallback.url()).hash,fragment,'guide contents work without JavaScript');
    const feedback=fallback.locator('.book-feedback'),notes=fallback.locator('#book-notes');
    await notes.fill('My practice answer');
    await notes.focus();await fallback.keyboard.press('Tab');
    assert.equal(await feedback.locator('summary').evaluate(e=>e===document.activeElement),true,'keyboard reaches feedback without JavaScript');
    await fallback.keyboard.press('Enter');
    assert.equal(await feedback.evaluate(e=>e.open),true,'book feedback without JavaScript');
    assert.equal(await feedback.locator('p').first().isVisible(),true);
    assert.equal(await notes.inputValue(),'My practice answer','notes remain available without JavaScript');
   }
  }finally{await noScript.close();}
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:'passed',workerSha256:sha256,routeCount:paths.length,widths,routeViewportChecks:paths.length*widths.length,bookGuidesAxeChecked:12,bookGuideAxeViolations:0,tabletMenuWidths:[768,1024,1200],practiceLocales:3,noScriptLocales:3,practiceAxeViolations:0,screenshots:out,limits:['Local interception, not Cloudflare Pages','Synthetic CMS, no production bindings or external images','Automated checks do not establish WCAG compliance']},null,2));
 }finally{await context.close();await browser.close();}
})().catch(error=>{
 console.error(error);
 if(process.env.GITHUB_ACTIONS==='true')console.log('::error title=Candidate browser failure::'+String(error.stack||error).replace(/%/g,'%25').replace(/\r/g,'%0D').replace(/\n/g,'%0A'));
 process.exitCode=1;
});
