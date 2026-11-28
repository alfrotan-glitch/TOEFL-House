import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/_worker.js';

const ids=['general-english','academic-english','toefl-preparation','special-speaking','professional-writing','teacher-training','online-individual-zoom'];
const programs=()=>ids.map(id=>({id,title:'Published '+id,summary:'Published summary',duration:'2 months'}));
const fixtures=()=>({main:{locales:{en:{programs:programs()},fa:{programs:programs()}}},ps:{programs:programs()}});
const root='https://toeflhouse.pages.dev';
function binding(main,ps){
 const queries=[];
 return {queries,env:{CMS_DB:{prepare(sql){
  assert.match(sql,/^SELECT body,revision(?:,updated_at)? FROM (?:content|pashto_content) WHERE id='main'$/);
  queries.push(sql);
  return {async first(){return {body:JSON.stringify(sql.includes('pashto_content')?ps:main),revision:1};}};
 }}}};
}
async function request(path,env,method='GET'){return worker.fetch(new Request(root+path,{method}),env);}
async function withoutExpectedErrors(fn){const original=console.error;console.error=()=>{};try{return await fn();}finally{console.error=original;}}

test('invalid published program collections fall back on pages and fail closed on the public API',async()=>withoutExpectedErrors(async()=>{
 const sitemap=await (await request('/sitemap.xml',{})).text();
 const paths=[...sitemap.matchAll(/<loc>https:\/\/toeflhouse\.pages\.dev([^<]+)<\/loc>/g)].map(x=>x[1]);
 assert.equal(paths.length,51);
 const cases=[
  ({main})=>{main.locales.en.programs={};},
  ({main})=>{main.locales.fa.programs[0]=null;},
  ({ps})=>{ps.programs[0]={title:'No id'};},
  ({ps})=>{ps.programs[1].id=ps.programs[0].id;}
 ];
 for(const damage of cases){
  const data=fixtures();damage(data);const before=JSON.stringify(data),{env,queries}=binding(data.main,data.ps);
  for(const path of paths){const r=await request(path,env);assert.equal(r.status,200,path);}
  const api=await request('/api/content',env);assert.equal(api.status,503);assert.deepEqual(await api.json(),{error:'Public content temporarily unavailable'});
  const head=await request('/api/content',env,'HEAD');assert.equal(head.status,503);assert.equal(await head.text(),'');
  assert.ok(queries.length>0);assert.equal(JSON.stringify(data),before,'published input was not modified');
 }
}));

test('valid editorial omission is preserved and does not trigger fallback',async()=>withoutExpectedErrors(async()=>{
 const {main,ps}=fixtures();for(const locale of [main.locales.en,main.locales.fa,ps])locale.programs=locale.programs.filter(p=>p.id!=='online-individual-zoom');
 const {env}=binding(main,ps);
 for(const prefix of ['/','/fa/','/ps/']){
  const home=await request(prefix,env);assert.equal(home.status,200);assert.match(await home.text(),/Published summary/);
  const html=await (await request(prefix+'admissions/',env)).text();assert.doesNotMatch(html,/<option value="online-individual-zoom"/);
  assert.equal((await request(prefix+'courses/online-individual-zoom/',env)).status,404);
 }
 // The API's existing seven-program gate remains deliberately stricter.
 assert.equal((await request('/api/content',env)).status,503);
}));

test('home course discovery and structured data respect valid per-locale omissions',async()=>{
 const {main,ps}=fixtures();
 main.locales.en.programs=main.locales.en.programs.filter(p=>p.id!=='general-english');
 main.locales.fa.programs=main.locales.fa.programs.filter(p=>p.id!=='academic-english');
 ps.programs=ps.programs.filter(p=>p.id!=='toefl-preparation');
 const {env}=binding(main,ps);
 for(const [prefix,missing] of [['/','general-english'],['/fa/','academic-english'],['/ps/','toefl-preparation']]){
  const html=await (await request(prefix,env)).text();
  const quick=html.match(/<div class="shell home-paths">([\s\S]*?)<\/nav><\/div>/)?.[1];
  assert.ok(quick);assert.doesNotMatch(quick,new RegExp('courses/'+missing+'/'));
  const catalog=html.match(/<section class="programs-section section"[\s\S]*?<\/section>/)?.[0];
  assert.ok(catalog);assert.doesNotMatch(catalog,new RegExp('(?:id="course-|href="#course-)'+missing+'"'));
  assert.equal((catalog.match(/class="course-card /g)||[]).length,5);
  const comparison=catalog.match(/<details class="program-comparison">([\s\S]*?)<\/details>/)?.[1];
  assert.ok(comparison);assert.equal((comparison.match(/<th scope="row">/g)||[]).length,5);
  assert.doesNotMatch(comparison,new RegExp('courses/'+missing+'/'));
  const blocks=[...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap(m=>JSON.parse(m[1]));
  const list=blocks.find(x=>x['@type']==='ItemList');assert.ok(list);
  assert.equal(list.itemListElement.length,5);
  assert.ok(list.itemListElement.every((entry,index)=>entry.position===index+1&&!entry.url.endsWith('/'+missing+'/')));
 }
 for(const locale of [main.locales.en,main.locales.fa,ps])locale.programs=[];
 const empty=binding(main,ps).env;
 for(const prefix of ['/','/fa/','/ps/']){
  const html=await (await request(prefix,empty)).text();
  assert.doesNotMatch(html,/class="shell home-paths"/);
  const catalog=html.match(/<section class="programs-section section"[\s\S]*?<\/section>/)?.[0];
  assert.ok(catalog);assert.doesNotMatch(catalog,/class="goal-finder"|class="course-card /);
  assert.ok(catalog.includes('href="'+prefix+'admissions/"'));
 }
});

test('comparison uses current course facts, escapes content and labels missing values',async()=>{
 const {main,ps}=fixtures();
 for(const locale of [main.locales.en,main.locales.fa,ps]){
  const program=locale.programs.find(p=>p.id==='professional-writing');
  program.summary='<script>untrusted</script>';
  delete locale.programs.find(p=>p.id==='teacher-training').summary;
 }
 const {env}=binding(main,ps);
 for(const [prefix,missing] of [['/','Ask admissions'],['/fa/','از پذیرش بپرسید'],['/ps/','له نوم‌لیکنې وپوښتئ']]){
  const html=await (await request(prefix,env)).text();
  const table=html.match(/<details class="program-comparison">([\s\S]*?)<\/details>/)?.[1];assert.ok(table);
  assert.ok(table.includes(missing));assert.match(table,/&lt;script&gt;untrusted&lt;\/script&gt;/);
  assert.doesNotMatch(table,/<script>untrusted<\/script>/);
 }
});

test('related courses use localized names and never link to omitted records',async()=>{
 const {main,ps}=fixtures();
 for(const locale of [main.locales.en,main.locales.fa,ps])locale.programs=locale.programs.filter(p=>['professional-writing','teacher-training'].includes(p.id));
 const {env}=binding(main,ps);
 for(const prefix of ['/','/fa/','/ps/']){
  const html=await (await request(prefix+'courses/professional-writing/',env)).text();
  const block=html.match(/<section class="detail-related section">([\s\S]*?)<\/section>/)?.[1];
  assert.ok(block);assert.match(block,new RegExp('href="'+prefix+'courses/teacher-training/"'));
  assert.doesNotMatch(block,/courses\/general-english|courses\/academic-english/);
  if(prefix!=='/')assert.doesNotMatch(block,/Published teacher-training/);
 }
 for(const locale of [main.locales.en,main.locales.fa,ps])locale.programs=locale.programs.filter(p=>p.id==='professional-writing');
 const single=binding(main,ps).env;
 for(const prefix of ['/','/fa/','/ps/'])assert.doesNotMatch(await (await request(prefix+'courses/professional-writing/',single)).text(),/class="detail-related section"/);
});

test('malformed optional FAQ, stats and schedule entries cannot hide healthy published data',async()=>{
 const {main,ps}=fixtures();
 main.locales.en.faq={items:[null,{q:'Valid published question?',a:'Valid published answer'}, {q:{toString:null},a:'bad'}]};
 main.locales.fa.faq={items:'not an array'};
 ps.faq=[null,{question:'Valid Pashto question?',answer:'Valid Pashto answer'}];
 ps.statistics=[null,{value:'PUBLISHED-STAT',label:'Published label'}];
 main.timetable=[null,{timeEn:{toString:null}},{timeEn:'Men 8:00 AM – 9:00 AM · Women 9:00 AM – 10:00 AM',timeFa:'Published shift',open:true}];
 main.locales.en.programs.find(p=>p.id==='professional-writing').title={toString:null};
 const {env}=binding(main,ps),before=JSON.stringify({main,ps});
 const en=await request('/',env);assert.equal(en.status,200);const enHtml=await en.text();
 assert.match(enHtml,/Valid published question\?/);assert.match(enHtml,/Valid published answer/);assert.match(enHtml,/8:00 AM – 9:00 AM/);
 const fa=await request('/fa/',env);assert.equal(fa.status,200);assert.match(await fa.text(),/Published summary/);
 const pashto=await request('/ps/',env);assert.equal(pashto.status,200);const psHtml=await pashto.text();assert.match(psHtml,/PUBLISHED-STAT/);assert.match(psHtml,/Valid Pashto question/);
 assert.equal((await request('/courses/professional-writing/',env)).status,200);
 assert.equal((await request('/api/content',env)).status,503);
 assert.equal(JSON.stringify({main,ps}),before,'published input was not modified');
});

test('API HEAD for a missing binding has no response body',async()=>{
 const head=await request('/api/content',{},'HEAD');assert.equal(head.status,503);assert.equal(await head.text(),'');
 const get=await request('/api/content',{});assert.equal(get.status,503);assert.deepEqual(await get.json(),{error:'Public content temporarily unavailable'});
});

test('candidate API refuses all records without querying or leaking even unknown nested fields',async()=>{
 const {main,ps}=fixtures();main.locales.en.contact={safe:'Public address',internal_note:'do-not-publish-one',nested:{unreviewed:'do-not-publish-two'}};
 const {env,queries}=binding(main,ps);
 for(const method of ['GET','HEAD']){
  const response=await request('/api/content',env,method);assert.equal(response.status,503);
  const text=await response.text();assert.doesNotMatch(text,/Public address|do-not-publish|internal_note|unreviewed/);
  if(method==='HEAD')assert.equal(text,'');
 }
 assert.deepEqual(queries,[]);
});

test('untrusted CMS strings remain text in HTML, attributes and JSON-LD',async()=>{
 const {main,ps}=fixtures(),attack='</script><img src=x onerror=alert(1)>';
 main.locales.en.programs.find(p=>p.id==='professional-writing').title=attack;
 main.locales.en.faq=[{q:attack,a:attack}];
 main.timetable=[{timeEn:attack}];
 const {env}=binding(main,ps);
 for(const path of ['/','/courses/professional-writing/','/admissions/']){
  const r=await request(path,env);assert.equal(r.status,200,path);const html=await r.text();
  assert.ok(!html.includes(attack),path+' must not contain the raw injection');
  if(path!=='/admissions/')assert.ok(html.includes('&lt;/script&gt;&lt;img'),path+' renders escaped text');
  const blocks=[...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.ok(blocks.length);for(const block of blocks)assert.doesNotThrow(()=>JSON.parse(block[1]));
 }
});

test('unavailable or unreadable published records preserve page fallback and API 503',async()=>withoutExpectedErrors(async()=>{
 for(const first of [async()=>null,async()=>({body:'{bad json',revision:1}),async()=>{throw Error('fixture database failure');}]){
  const env={CMS_DB:{prepare(sql){assert.match(sql,/^SELECT /);return {first};}}};
  for(const prefix of ['/','/fa/','/ps/']){
   assert.equal((await request(prefix,env)).status,200);
   assert.equal((await request(prefix+'admissions/',env)).status,200);
  }
  for(const method of ['GET','HEAD']){const api=await request('/api/content',env,method);assert.equal(api.status,503);if(method==='HEAD')assert.equal(await api.text(),'');}
 }
}));

test('course details handle incomplete content without duplicate or invented sections',async()=>{
 const {main,ps}=fixtures();
 for(const locale of [main.locales.en,main.locales.fa,ps]){
  const p=locale.programs.find(p=>p.id==='professional-writing');
  Object.assign(p,{title:'professional-writing',summary:'ONLY-ONCE',details:'ONLY-ONCE',duration:' ',highlights:[null,{},'  '],levels:{},schedule:[],recommendedFor:{}});
 }
 const {env}=binding(main,ps);
 for(const [prefix,title] of [['/','Professional Writing'],['/fa/','نگارش'],['/ps/','لیکن']]){
  const response=await request(prefix+'courses/professional-writing/',env);assert.equal(response.status,200);
  const html=await response.text(),mainHtml=html.match(/<main id="main"[\s\S]*?<\/main>/)?.[0];assert.ok(mainHtml);
  const hero=mainHtml.match(/<h1>(.*?)<\/h1>/)?.[1];assert.ok(hero.includes(title),hero);assert.notEqual(hero,'professional-writing');
  assert.equal((mainHtml.match(/ONLY-ONCE/g)||[]).length,1);
  assert.doesNotMatch(mainHtml,/class="detail-summary"|class="detail-longcopy"|class="detail-info"|\[object Object\]/);
  assert.match(mainHtml,/<aside class="detail-aside"><h2>/);
  assert.match(mainHtml,/href="(?:\/|\/fa\/|\/ps\/)admissions\/\?program=professional-writing"/);
 }
});

test('course details preserve meaningful CMS text and localize accessible catalogue link names',async()=>{
 const {main,ps}=fixtures();
 for(const locale of [main.locales.en,main.locales.fa,ps]){
  const p=locale.programs.find(p=>p.id==='professional-writing');
  Object.assign(p,{title:'Edited English title',summary:'Intro text',details:'Distinct detail',duration:'Eight weeks',highlights:['First skill',null,' ', 'Second skill'],levels:'Intermediate',schedule:'Evenings',recommendedFor:'Working adults'});
 }
 const {env}=binding(main,ps);
 for(const prefix of ['/','/fa/','/ps/']){
  const html=await (await request(prefix+'courses/professional-writing/',env)).text();
  for(const text of ['Intro text','Distinct detail','Eight weeks','First skill','Second skill','Intermediate','Evenings','Working adults'])assert.ok(html.includes(text),prefix+' '+text);
  assert.equal((html.match(/<li>First skill<\/li>/g)||[]).length,1);
  if(prefix==='/')assert.match(html,/<h1>Edited English title<\/h1>/);
  else assert.doesNotMatch(html,/<h1>Edited English title<\/h1>/);
  const home=await (await request(prefix,env)).text();
  const card=home.match(/<article id="course-professional-writing"[\s\S]*?<\/article>/)?.[0];assert.ok(card);
  const heading=card.match(/<h3>(.*?)<\/h3>/)?.[1],label=card.match(/aria-label="([^"]+)"/)?.[1];
  assert.ok(heading&&label?.includes(heading),prefix+' link accessible name matches visible course');
 }
});

test('online course retains localized published titles and uses a localized fallback for an ID-only title',async()=>{
 const {main,ps}=fixtures();
 for(const [locale,title] of [[main.locales.en,'Private classes'],[main.locales.fa,'صنف خصوصی'],[ps,'ځانګړی ټولګی']])locale.programs.find(p=>p.id==='online-individual-zoom').title=title;
 for(const [prefix,title] of [['/','Private classes'],['/fa/','صنف خصوصی'],['/ps/','ځانګړی ټولګی']]){
  const html=await (await request(prefix+'courses/online-individual-zoom/',binding(main,ps).env)).text();assert.ok(html.includes('<h1>'+title+'</h1>'));
 }
 for(const locale of [main.locales.en,main.locales.fa,ps])locale.programs.find(p=>p.id==='online-individual-zoom').title='online-individual-zoom';
 for(const prefix of ['/','/fa/','/ps/']){
  const html=await (await request(prefix+'courses/online-individual-zoom/',binding(main,ps).env)).text();assert.doesNotMatch(html,/<h1>online-individual-zoom<\/h1>/);
 }
});
