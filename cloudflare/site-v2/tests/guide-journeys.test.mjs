import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/_worker.js';

const host='https://toeflhouse.pages.dev';
const slugs=['english-courses-kabul','toefl-ibt-2026','speaking-practice','got-it-series','active-skills-for-reading','longman-academic-writing','contemporary-topics'];
const program=['','toefl-preparation','special-speaking','general-english','academic-english','academic-english','academic-english'];

test('all localized guides have valid in-page navigation and local related learning journeys',async()=>{
 for(const prefix of ['/','/fa/','/ps/'])for(const [i,slug] of slugs.entries()){
  const path=prefix+'guides/'+slug+'/';
  const response=await worker.fetch(new Request(host+path),{});
  assert.equal(response.status,200,path);
  const html=await response.text();
  const nav=html.match(/<nav class="guide-contents"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
  assert.ok(nav,path+' contents');
  const anchors=[...nav.matchAll(/href="#(guide-section-\d+)"/g)].map(x=>x[1]);
  assert.ok(anchors.length>=2,path+' section list');
  assert.equal(new Set(anchors).size,anchors.length,path+' unique section links');
  for(const anchor of anchors)assert.equal((html.match(new RegExp('id="'+anchor+'"','g'))||[]).length,1,path+' '+anchor);
  assert.ok(nav.includes('href="'+prefix+'guides/"'),path+' index');
  const related=html.match(/<section class="guide-related"[\s\S]*?<\/section>/)?.[0];
  assert.ok(related,path+' related section');
  const targets=[...related.matchAll(/href="([^"#]+guides\/([^/]+)\/)"/g)];
  assert.equal(targets.length,2,path+' two related guides');
  assert.notEqual(targets[0][2],targets[1][2],path+' distinct links');
  for(const [,target,id] of targets){
   assert.ok(target.startsWith(prefix+'guides/'),path+' locale retained');
   assert.ok(slugs.includes(id)&&id!==slug,path+' known distinct related guide');
   assert.equal((await worker.fetch(new Request(host+target),{})).status,200,target);
  }
  if(program[i])assert.ok(html.includes('href="'+prefix+'courses/'+program[i]+'/"'),path+' related program');
  if(slug==='toefl-ibt-2026'){
   assert.ok(html.includes('https://www.ets.org/toefl/test-takers/ibt/about/content.html?version=after-jan-2026'),path+' official ETS source');
   if(prefix!=='/')assert.match(html,/<bdi class="guide-mark" lang="en" dir="ltr">TOEFL iBT<\/bdi>/,path+' isolated test name');
  }
  assert.ok(html.includes('href="'+prefix+'admissions/'),path+' admissions');
 }
});
