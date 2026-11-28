// Offline behavioral comparison against a separately supplied, trusted Worker.
// Synthetic fixtures only; does not establish deployed Pages or CMS behavior.
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const [oldPath,newPath]=process.argv.slice(2);
if(!oldPath||!newPath)throw Error('Usage: node compare-worker-contract.mjs BASELINE-WORKER CANDIDATE-WORKER');
const [oldWorker,newWorker]=await Promise.all([oldPath,newPath].map(async path=>(await import(pathToFileURL(resolve(path)).href)).default));
const ids=['general-english','academic-english','toefl-preparation','special-speaking','professional-writing','teacher-training','online-individual-zoom'];
const locales=['','fa/','ps/'];
const pages=locales.flatMap(prefix=>['/','/admissions/',...ids.map(id=>'/courses/'+id+'/'),'/guides/',...['english-courses-kabul','toefl-ibt-2026','speaking-practice','got-it-series','active-skills-for-reading','longman-academic-writing','contemporary-topics'].map(id=>'/guides/'+id+'/')].map(path=>'/'+prefix+path.slice(1)));
const extra=['/robots.txt','/sitemap.xml','/api/content','/api/admin/content','/tools/','/fa/tools/','/ps/tools/','/index.html','/fa/404.html','/assets/example.jpg','/not-a-real-page'];
const sha=body=>createHash('sha256').update(body).digest('hex');
function fixture(mode){
 const programs=mode==='empty'?[]:ids.map(id=>({id,title:'Example '+id,summary:'Example summary',duration:'2 months'}));
 const main={locales:{en:{programs},fa:{programs}},media:{},timetable:{}},pashto={programs};
 const calls=[];
 const bindings={ASSETS:{async fetch(request){calls.push('asset:'+new URL(request.url).pathname);return new Response('fixture asset',{status:200,headers:{'Content-Type':'text/plain'}});}},LEGACY_CMS:{async fetch(request){calls.push('legacy:'+new URL(request.url).pathname);return new Response('fixture legacy',{status:200,headers:{'Content-Type':'text/plain'}});}}};
 if(mode!=='fallback')bindings.CMS_DB={prepare(sql){return {async first(){calls.push('db:'+sql);return {body:JSON.stringify(sql.includes('pashto_content')?pashto:main),revision:1};}}}};
 return {bindings,calls};
}
async function response(worker,host,path,method,mode){
 const {bindings,calls}=fixture(mode),r=await worker.fetch(new Request(host+path,{method}),bindings,{});
 const type=r.headers.get('content-type')||'';
 let body=Buffer.from(await r.arrayBuffer());
 // Asset version is expected to change when equivalent CSS source is consolidated.
 if(type.includes('text/html'))body=Buffer.from(body.toString().replace(/(\/__th\/v2\/site\.(?:css|js)\?v=)[a-f0-9]{12}/g,'$1REVISION'));
 return {status:r.status,headers:[...r.headers].sort(([a],[b])=>a.localeCompare(b)),body:sha(body),calls:calls.sort()};
}
let count=0;
for(const mode of ['full','empty','fallback'])for(const host of ['https://toeflhouse.pages.dev','https://candidate.toeflhouse.pages.dev'])for(const path of [...pages,...extra])for(const method of ['GET','HEAD','POST']){
 const actual=await response(newWorker,host,path,method,mode),expected=await response(oldWorker,host,path,method,mode);
 assert.deepEqual(actual,expected,`${mode} ${host} ${method} ${path}`);count++;
}
console.log(JSON.stringify({status:'passed',comparisons:count,pages:pages.length,fixtures:['full','empty','fallback'],hosts:2,methods:['GET','HEAD','POST'],limits:['Local synthetic bindings only','HTML asset revision normalized','CSS visual parity assessed separately','HTMLRewriter unavailable in Node; tools compare their 503 fallback, not the rendered legacy portal','Empty CMS fixture deliberately yields public API 503']},null,2));
