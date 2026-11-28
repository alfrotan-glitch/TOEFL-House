import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';

const site=dirname(dirname(fileURLToPath(import.meta.url)));

test('course identity survives catalog reordering in cards, fallback, structured data, details and admissions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'toefl-courses-'));
 try{
  const copy=join(root,'site-v2'),edge=join(root,'pages-edge');
  await mkdir(copy);await mkdir(edge);await mkdir(join(copy,'content'));
  for(const name of await readdir(site))if(name.endsWith('.mjs')||name.endsWith('.css')||name==='site.js')await copyFile(join(site,name),join(copy,name));
  for(const name of await readdir(join(site,'content')))await copyFile(join(site,'content',name),join(copy,'content',name));
  const edgePath=join(edge,'worker.mjs');let edgeSource=await readFile(join(site,'../pages-edge/worker.mjs'),'utf8');
  const match=edgeSource.match(/^const V2_COURSE_IDS=(\[[^\n]+\]);$/m);assert.ok(match);
  const ids=JSON.parse(match[1]),reordered=[...ids].reverse();
  edgeSource=edgeSource.replace(match[0],'const V2_COURSE_IDS='+JSON.stringify(reordered)+';');await writeFile(edgePath,edgeSource);
  const contentPath=join(copy,'content/home.json'),home=JSON.parse(await readFile(contentPath,'utf8'));
  for(const locale of ['en','fa','ps'])for(const id of ids){
   home.courseCards[locale][id]={name:`NAME ${locale} ${id}`,shortDuration:`SHORT ${locale} ${id}`,fallbackDuration:`FALLBACK ${locale} ${id}`};
  }
  home.paths.catalog.reverse();
  for(const path of home.paths.catalog){
   path.tag=`TAG ${path.id}`;
   for(const locale of ['en','fa','ps'])home.paths.locales[locale].links[path.id]=`PATH ${locale} ${path.id}`;
  }
  await writeFile(contentPath,JSON.stringify(home));
  execFileSync(process.execPath,[join(copy,'build.mjs')],{stdio:'pipe'});
  const {default:worker}=await import(pathToFileURL(join(copy,'dist/_worker.js')).href);
  for(const [locale,prefix] of [['en','/'],['fa','/fa/'],['ps','/ps/']]){
   const get=async path=>{const response=await worker.fetch(new Request('https://toeflhouse.pages.dev'+path),{});assert.equal(response.status,200,path);return response.text();};
   const html=await get(prefix);
   const pathNav=html.match(/<div class="shell home-paths">([\s\S]*?)<\/nav><\/div>/)?.[1];
   assert.ok(pathNav,`${locale} quick paths`);
   let last=-1;
   for(const path of home.paths.catalog){
    const link=`<a href="${prefix}courses/${path.id}/"><span class="home-path-label"><small lang="en" dir="ltr">${path.tag}</small><strong>${home.paths.locales[locale].links[path.id]}</strong></span>`;
    const index=pathNav.indexOf(link);assert.ok(index>last,`${locale} ${path.id} path label and order`);last=index;
   }
   const list=[...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap(x=>JSON.parse(x[1])).find(x=>x['@type']==='ItemList');
   assert.ok(list,'course list schema');
   for(const [i,id] of reordered.entries()){
    const card=html.match(new RegExp('<article id="course-'+id+'" class="course-card [^"]*">([\\s\\S]*?)<\\/article>'))?.[1];
    assert.ok(card,`${locale} ${id} card`);
    assert.ok(card.includes(home.courseCards[locale][id].name),`${id} name`);
    assert.ok(card.includes(home.courseCards[locale][id].shortDuration),`${id} short duration`);
    assert.ok(card.includes(home.courseGlyphs[id]),`${id} glyph`);
    const item=list.itemListElement[i];assert.equal(item.position,i+1);assert.equal(item.item.name,home.courseCards[locale][id].name);
    assert.ok(item.url.endsWith('/courses/'+id+'/'));
   }
   const admissions=await get(prefix+'admissions/');
   for(const id of ids){
    const option=admissions.match(new RegExp('<option value="'+id+'" data-summary="[^"]*">([^<]*)<\\/option>'));
    assert.equal(option?.[1],home.courseCards[locale][id].name,`${locale} ${id} admissions`);
   }
   // These generic detail pages preserve their fallback program title and
   // full duration, unlike specialized pages with their own editorial copy.
   for(const id of ['professional-writing','teacher-training']){
    const detail=await get(prefix+'courses/'+id+'/');
    assert.ok(detail.includes(home.courseCards[locale][id].name),`${locale} ${id} detail`);
    assert.ok(detail.includes(home.courseCards[locale][id].fallbackDuration),`${locale} ${id} full duration`);
   }
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
