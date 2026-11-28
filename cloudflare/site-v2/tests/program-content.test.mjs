import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {compileContent} from '../content-compiler.mjs';
import {extractContentContract} from '../content-contract.mjs';
const load=async name=>JSON.parse(await readFile(new URL('../content/'+name,import.meta.url),'utf8'));
const sources=async()=>Promise.all(['../../pages-edge/worker.mjs','../general-english.mjs'].map(path=>readFile(new URL(path,import.meta.url),'utf8')));
const content=async()=>Promise.all(['general.json','academic.json','special.json','guides.json','home.json','ui.json'].map(load));

test('localized content compiles deterministically and rejects missing or malformed translations',async()=>{
 const [general,academic,special,guides,home,ui]=await content(),contract=extractContentContract(...await sources());
 const compile=(g=general,a=academic,s=special,d=guides,h=home,u=ui)=>compileContent(g,a,s,d,h,u,contract);
 const output=compile();
 assert.equal(output,compile());
 assert.match(output,/^const V2_GENERAL_ENGLISH=/);
 assert.match(output,/const V2_EAP=/);
 assert.match(output,/const V2_SPECIAL_COURSES=/);
 const missing=structuredClone(academic);delete missing.ps;
 assert.throws(()=>compile(general,missing),/locales/);
 const keys=structuredClone(special);delete keys.ui.fa.cta;
 assert.throws(()=>compile(general,academic,keys),/keys/);
 const wrong=structuredClone(special);wrong.courses.ps.special.facts='invalid';
 assert.throws(()=>compile(general,academic,wrong),/array/);
 const missingUi=structuredClone(ui);delete missingUi.detail.ps.whatsapp;
 assert.throws(()=>compile(general,academic,special,guides,home,missingUi),/keys/);
 const book=structuredClone(guides);delete book.bookData.fa['got-it-series'];
 assert.throws(()=>compile(general,academic,special,book),/keys/);
});

test('indexed content and routes fail closed even when all locales drift together',async()=>{
 const [general,academic,special,guides,home,ui]=await content(),contract=extractContentContract(...await sources());
 const compile=(g=general,a=academic,s=special,d=guides,h=home,u=ui)=>compileContent(g,a,s,d,h,u,contract);
 const locales=['en','fa','ps'];
 const short=structuredClone(general);for(const l of locales)delete short.locales[l].stageData['Prep Three'];
 assert.throws(()=>compile(short),/catalog keys.*General English stages/);
 const catalog=structuredClone(general);catalog.catalog.pop();
 assert.throws(()=>compile(catalog),/indexed length.*general stage catalog/);
 const duplicateStage=structuredClone(general);duplicateStage.catalog[1].id=duplicateStage.catalog[0].id;
 assert.throws(()=>compile(duplicateStage),/Duplicate General English stage/);
 const duration=structuredClone(general);duration.catalog[0].durationKey='semester';
 assert.throws(()=>compile(duration),/stage duration/);
 const missingDuration=structuredClone(general);for(const l of locales)delete missingDuration.locales[l].foundation;
 assert.throws(()=>compile(missingDuration),/Missing required field.*general\.foundation/);
 const pair=structuredClone(academic);for(const l of locales)pair[l].facts[0].pop();
 assert.throws(()=>compile(general,pair),/indexed length.*facts/);
 const levels=structuredClone(academic);for(const l of locales)levels[l].levels.pop();
 assert.throws(()=>compile(general,levels),/indexed length.*academic levels/);
 const wrongBook=structuredClone(academic);for(const l of locales)wrongBook[l].books[0].guide='got-it-series';
 assert.throws(()=>compile(general,wrongBook),/Invalid academic book guide/);
 const duplicateBook=structuredClone(academic);for(const l of locales)duplicateBook[l].books[1].guide=duplicateBook[l].books[0].guide;
 assert.throws(()=>compile(general,duplicateBook),/academic book order/);
 const reordered=structuredClone(academic);reordered.fa.books.reverse();
 assert.throws(()=>compile(general,reordered),/academic book order/);
 const missingSeo=structuredClone(academic);for(const l of locales)delete missingSeo[l].seoTitle;
 assert.throws(()=>compile(general,missingSeo),/Missing required field.*academic\.seoTitle/);
 const deleted=structuredClone(guides);for(const l of locales)delete deleted.bookData[l]['got-it-series'];
 assert.throws(()=>compile(general,academic,special,deleted),/catalog keys.*books/);
 const badRoute=structuredClone(guides);for(const l of locales)badRoute.bookData[l]['got-it-series'].program='evil" onclick="alert(1)';
 assert.throws(()=>compile(general,academic,special,badRoute),/Unknown guide program/);
 const unsafe=structuredClone(guides);for(const l of locales)unsafe.bookData[l]['got-it-series'].source='javascript:alert(1)';
 assert.throws(()=>compile(general,academic,special,unsafe),/Invalid book source/);
 const missingSections=structuredClone(guides);for(const l of locales)delete missingSections.data[l]['english-courses-kabul'].sections;
 assert.throws(()=>compile(general,academic,special,missingSections),/Missing required field.*sections/);
 const brokenLink=structuredClone(home);for(const l of locales)brokenLink.habits[l].links[0][0]='not-a-guide';
 assert.throws(()=>compile(general,academic,special,guides,brokenLink),/route references/);
 const drift=structuredClone(home);drift.goals.ps.items[0][0]='academic-english';
 assert.throws(()=>compile(general,academic,special,guides,drift),/route references/);
 const missingCourse=structuredClone(home);for(const l of locales)delete missingCourse.courseCards[l]['academic-english'];
 assert.throws(()=>compile(general,academic,special,guides,missingCourse),/catalog keys.*course cards/);
 const missingGlyph=structuredClone(home);delete missingGlyph.courseGlyphs['academic-english'];
 assert.throws(()=>compile(general,academic,special,guides,missingGlyph),/catalog keys.*glyph/);
 const unsafeGlyph=structuredClone(home);unsafeGlyph.courseGlyphs['academic-english']='<script>alert(1)</script>';
 assert.throws(()=>compile(general,academic,special,guides,unsafeGlyph),/Invalid course glyph/);
 const blankCourse=structuredClone(home);for(const l of locales)blankCourse.courseCards[l]['academic-english'].shortDuration=' ';
 assert.throws(()=>compile(general,academic,special,guides,blankCourse),/Missing required text.*courseCards.*shortDuration/);
 const badPath=structuredClone(home);badPath.paths.catalog[0].id='not-a-course';
 assert.throws(()=>compile(general,academic,special,guides,badPath),/Invalid home path ID/);
 const dupPath=structuredClone(home);dupPath.paths.catalog[1].id=dupPath.paths.catalog[0].id;
 assert.throws(()=>compile(general,academic,special,guides,dupPath),/Invalid home path ID/);
 const missingPath=structuredClone(home);for(const l of locales)delete missingPath.paths.locales[l].links['academic-english'];
 assert.throws(()=>compile(general,academic,special,guides,missingPath),/catalog keys.*home paths/);
 const language=structuredClone(home);language.copy.fa.dir='ltr';
 assert.throws(()=>compile(general,academic,special,guides,language),/language or direction/);
 const missingHeader=structuredClone(home);for(const l of locales)delete missingHeader.header[l].skip;
 assert.throws(()=>compile(general,academic,special,guides,missingHeader),/catalog keys.*header/);
 const blank=structuredClone(general);for(const l of locales)blank.locales[l].stageData.Starter.description=' ';
 assert.throws(()=>compile(blank),/Missing required text/);
 const explanations=structuredClone(ui);for(const l of locales)explanations.practice[l].explanations.pop();
 assert.throws(()=>compile(general,academic,special,guides,home,explanations),/practice explanations/);
 // Shape equality alone must not let an essential label disappear in all locales.
 const emptyMenu=structuredClone(home);for(const l of locales)emptyMenu.copy[l].navMenu='  ';
 assert.throws(()=>compile(general,academic,special,guides,emptyMenu),/Missing required text.*navMenu/);
 const emptyCta=structuredClone(ui);emptyCta.detail.fa.submit='';
 assert.throws(()=>compile(general,academic,special,guides,home,emptyCta),/Missing required text.*submit/);
 const emptyTopic=structuredClone(special);for(const l of locales)emptyTopic.courses[l].toefl.path[0].title='';
 assert.throws(()=>compile(general,academic,emptyTopic),/Missing required text.*title/);
 const whitespaceProgram=structuredClone(guides);for(const l of locales)whitespaceProgram.data[l]['english-courses-kabul'].program='  ';
 assert.throws(()=>compile(general,academic,special,whitespaceProgram),/Missing required text.*program/);
 const noHomeTitle=structuredClone(home);for(const l of locales)delete noHomeTitle.copy[l].seoTitle;
 assert.throws(()=>compile(general,academic,special,guides,noHomeTitle),/Missing required field.*homeCopy\.seoTitle/);
 const noDuration=structuredClone(special);for(const l of locales)delete noDuration.courses[l].toefl.durationDisplay;
 assert.throws(()=>compile(general,academic,noDuration),/Missing required field.*durationDisplay/);
 // A general-interest article intentionally has no single course association.
 assert.equal(guides.data.en['english-courses-kabul'].program,'');assert.doesNotThrow(()=>compile());
});

test('authoritative source catalog parsing rejects changed, invalid or ambiguous declarations',async()=>{
 const [edge,renderer]=await sources(),contract=extractContentContract(edge,renderer);
 assert.equal(contract.courses.length,6);assert.equal(contract.books.length,4);assert.equal(contract.guides.length,7);
 assert.throws(()=>extractContentContract(edge+'\nconst V2_COURSE_IDS=["duplicate"];',renderer),/duplicate/);
 assert.throws(()=>extractContentContract(edge.replace('const V2_PUBLIC_COURSES=', 'const REMOVED='),renderer),/Missing/);
 assert.throws(()=>extractContentContract(edge.replace('"general-english","academic-english"','"bad/route","academic-english"'),renderer),/catalog IDs/);
 assert.throws(()=>extractContentContract(edge,renderer.replace('"correct":1','"correct":9')),/practice question/);
});

test('reordering non-foundation General English stages keeps localized focus, description, duration and fee attached to their identities',async()=>{
 const [general,academic,special,guides,home,ui]=await content();
 const [edge,renderer]=await sources(),contract=extractContentContract(edge,renderer);
 const updated=structuredClone(general);
 [updated.catalog[1],updated.catalog[4]]=[updated.catalog[4],updated.catalog[1]];
 // Distinct synthetic labels catch an accidental reliance on position, even if
 // the actual published prices currently happen to be identical.
 for(const locale of ['en','fa','ps'])for(const stage of updated.catalog){
  const record=updated.locales[locale].stageData[stage.id];
  record.focus=`FOCUS:${locale}:${stage.id}`;
  record.description=`DESCRIPTION:${locale}:${stage.id}`;
  record.fee=`FEE:${locale}:${stage.id}`;
 }
 const compiled=compileContent(updated,academic,special,guides,home,ui,contract);
 for(const locale of ['en','fa','ps']){
  const html=runInNewContext(compiled+'\n'+renderer+'\nv2GeneralEnglish(locale)',{
   locale,v2T:value=>String(value),v2Prefix:()=> '/',v2BookGuideLink:()=>''
  });
  const stages=[...html.matchAll(/<li class="ge-stage">([\s\S]*?)<\/li>/g)].map(m=>m[1]);
  const table=html.match(/<table class="ge-fee-table">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/)[1];
  const rows=[...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(m=>m[1]);
  assert.equal(stages.length,5);assert.equal(rows.length,5);
  for(const [i,stage] of updated.catalog.entries()){
   const data=updated.locales[locale].stageData[stage.id];
   assert.ok(stages[i].includes('<h4 dir="ltr">'+stage.id+'</h4>'));
   assert.ok(stages[i].includes(data.focus));assert.ok(stages[i].includes(data.description));
   assert.ok(stages[i].includes(updated.locales[locale][stage.durationKey]));
   assert.ok(rows[i].includes('>'+stage.id+'</th>'));assert.ok(rows[i].includes(data.fee));
   assert.ok(rows[i].includes(updated.locales[locale][stage.durationKey]));
  }
 }
 const invalid=structuredClone(updated);[invalid.catalog[0],invalid.catalog[1]]=[invalid.catalog[1],invalid.catalog[0]];
 assert.throws(()=>compileContent(invalid,academic,special,guides,home,ui,contract),/stage duration/);
});

test('required renderer fields and learning lists cannot disappear in every locale together',async()=>{
 const original=await content(),contract=extractContentContract(...await sources());
 const locales=['en','fa','ps'];
 const cases=[
  {kind:4,field:'navMenu',path:'homeCopy',remove:(o,l)=>delete o.copy[l].navMenu},
  {kind:4,field:'videoCaption',path:'homeSemester',remove:(o,l)=>delete o.semester[l].videoCaption},
  {kind:0,field:'heroTitle',path:'general',remove:(o,l)=>delete o.locales[l].heroTitle},
  {kind:1,field:'title',path:'academic level',remove:(o,l)=>delete o[l].levels[0].title},
  {kind:1,field:'publisher',path:'academic book',remove:(o,l)=>delete o[l].books[0].publisher},
  {kind:2,field:'source',path:'specialUi',remove:(o,l)=>delete o.ui[l].source},
  {kind:2,field:'title',path:'special\\.path',remove:(o,l)=>delete o.courses[l].special.path[0].title},
  {kind:2,field:'by',path:'toefl\\.resources',remove:(o,l)=>delete o.courses[l].toefl.resources[0].by},
  {kind:3,field:'contents',path:'guideNav',remove:(o,l)=>delete o.nav[l].contents},
  {kind:5,field:'submit',path:'detail',remove:(o,l)=>delete o.detail[l].submit},
  {kind:5,field:'question',path:'practice',remove:(o,l)=>delete o.practice[l].question}
 ];
 for(const {kind,field,path,remove} of cases){
  const data=structuredClone(original);for(const locale of locales)remove(data[kind],locale);
  assert.throws(()=>compileContent(...data,contract),new RegExp('Missing required field.*'+path+'.*'+field),path+'.'+field);
 }
 for(const [kind,remove] of [
  [1,(o,l)=>{o[l].levels[0].skills=[];}],
  [1,(o,l)=>{o[l].books[0].points=[];}],
  [2,(o,l)=>{o.courses[l].special.path=[];}],
  [2,(o,l)=>{o.courses[l].toefl.resources[0].points=[];}]
 ]){
  const data=structuredClone(original);for(const locale of locales)remove(data[kind],locale);
  assert.throws(()=>compileContent(...data,contract),/Missing required list/);
 }
});
