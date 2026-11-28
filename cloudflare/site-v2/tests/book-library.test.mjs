import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/_worker.js';

const host='https://toeflhouse.pages.dev';
const preview='https://candidate.toeflhouse.pages.dev';
const ids=['general-english','academic-english','toefl-preparation','special-speaking','professional-writing','teacher-training','online-individual-zoom'];
const programs=ids.map(id=>({id,title:id,summary:'Example course',duration:'2 months'}));
const enfa={locales:{en:{programs},fa:{programs}}},ps={programs};
const env={CMS_DB:{prepare(sql){return {async first(){return {body:JSON.stringify(sql.includes('pashto_content')?ps:enfa),revision:1};}}}}};
const slugs=['got-it-series','active-skills-for-reading','longman-academic-writing','contemporary-topics'];

test('all 12 book guides preserve localized routes, canonical links and preview safety',async()=>{
 const sitemap=await (await worker.fetch(new Request(host+'/sitemap.xml'),env)).text();
 for(const [prefix,lang,dir] of [['/','en','ltr'],['/fa/','fa-AF','rtl'],['/ps/','ps-AF','rtl']]){
  const index=await (await worker.fetch(new Request(host+prefix+'guides/'),env)).text();
  const fontPreload='<link rel="preload" href="/__th/v2/font/vazirmatn-33.003.woff2" as="font" type="font/woff2" crossorigin>';
  if(dir==='rtl')assert.ok(index.includes(fontPreload)&&index.indexOf(fontPreload)<index.indexOf('rel="stylesheet"'),prefix+' preload before CSS');
  else assert.ok(!index.includes(fontPreload),'English must not preload RTL font');
  for(const [i,slug] of slugs.entries()){
   const path=prefix+'guides/'+slug+'/',program=i===0?'general-english':'academic-english';
   assert.ok(index.includes('href="'+path+'"'),path);
   assert.ok(sitemap.includes('<loc>'+host+path+'</loc>'),path);
   const response=await worker.fetch(new Request(host+path),env);
   assert.equal(response.status,200,path);
   const html=await response.text();
   assert.ok(html.includes('<html lang="'+lang+'" dir="'+dir+'"'),path);
   if(dir==='rtl')assert.ok(html.includes(fontPreload)&&html.indexOf(fontPreload)<html.indexOf('rel="stylesheet"'),path+' preload before CSS');
   else assert.ok(!html.includes(fontPreload),path+' English font preload');
   assert.ok(html.includes('rel="canonical" href="'+host+path+'"'),path);
   assert.equal((html.match(/<h1(?:\s|>)/g)||[]).length,1,path);
   if(dir==='rtl'){
    assert.match(html,/<h1><bdi lang="en" dir="ltr">[^<]+<\/bdi><\/h1>/,path+' isolated English display title');
    assert.match(index,/<h2><bdi lang="en" dir="ltr">[^<]+<\/bdi><\/h2>/,path+' isolated book card title');
   }
   for(const alternate of ['/','/fa/','/ps/'])assert.ok(html.includes(host+alternate+'guides/'+slug+'/'),path+' alternate');
   assert.ok(html.includes('href="'+prefix+'courses/'+program+'/"'),path+' course');
   assert.ok(html.includes('href="'+prefix+'admissions/?program='+program+'"'),path+' admissions');
   assert.match(html,/<details class="book-feedback"><summary>[^<]+<\/summary><p>[^<]+<\/p>/,path+' native feedback disclosure');
   if(slug==='longman-academic-writing')assert.match(html,/<p lang="en" dir="ltr">Daily English practice helps me communicate\./,path+' original writing example isolated LTR');
   const course=await (await worker.fetch(new Request(host+prefix+'courses/'+program+'/'),env)).text();
   assert.match(course,new RegExp('href="'+path+'" aria-label="[^"]+"'),path+' named inbound link');
   const candidate=await worker.fetch(new Request(preview+path),env);
   assert.match(candidate.headers.get('x-robots-tag')||'',/noindex/,path);
   assert.equal((await worker.fetch(new Request(preview+path,{method:'POST'}),env)).status,403,path);
   assert.equal((await worker.fetch(new Request(host+path,{method:'POST'}),env)).status,405,path);
  }
 }
});

test('all localized course, admissions and guide pages preload only the RTL font',async()=>{
 const marker='<link rel="preload" href="/__th/v2/font/vazirmatn-33.003.woff2" as="font" type="font/woff2" crossorigin>';
 for(const prefix of ['/','/fa/','/ps/']){
  const paths=['admissions/','guides/',...ids.map(id=>'courses/'+id+'/'),...['english-courses-kabul','toefl-ibt-2026','speaking-practice',...slugs].map(id=>'guides/'+id+'/')];
  for(const path of paths){
   const html=await (await worker.fetch(new Request(host+prefix+path),env)).text();
   if(prefix==='/')assert.ok(!html.includes(marker),prefix+path);
   else assert.ok(html.includes(marker)&&html.indexOf(marker)<html.indexOf('rel="stylesheet"'),prefix+path);
  }
 }
});
