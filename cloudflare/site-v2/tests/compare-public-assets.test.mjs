import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {comparePublicAssets} from '../compare-public-assets.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const fixture=()=>({files:Array.from({length:25},(_,i)=>({path:'/assets/'+i+'.txt',sha256:hash('file '+i)}))});

test('compares all historical paths against read-only canonical responses',async()=>{
 const requested=[];
 const report=await comparePublicAssets(fixture(),{get:async(url,options)=>{
  requested.push({url,options});const i=Number(new URL(url).pathname.split('/').pop().split('.')[0]);
  return new Response('file '+i,{status:200});
 }});
 assert.equal(report.allMatch,true);assert.equal(report.results.length,25);
 assert.ok(requested.every(x=>x.url.startsWith('https://toeflhouse.pages.dev/assets/')&&x.options.method==='GET'&&x.options.redirect==='manual'));
 assert.ok(report.results.every(x=>x.matches&&/^[a-f0-9]{64}$/.test(x.publicSha256)));
});

test('mismatch, redirect, and fetch failure are reported, not accepted as parity',async()=>{
 const report=await comparePublicAssets(fixture(),{get:async url=>{
  if(url.endsWith('/0.txt'))return new Response('changed',{status:200});
  if(url.endsWith('/1.txt'))return new Response(null,{status:302,headers:{location:'https://example.org'}});
  if(url.endsWith('/2.txt'))throw Error('offline');
  const i=Number(new URL(url).pathname.split('/').pop().split('.')[0]);return new Response('file '+i);
 }});
 assert.equal(report.allMatch,false);assert.deepEqual(report.results.filter(x=>!x.matches).map(x=>x.path),['/assets/0.txt','/assets/1.txt','/assets/2.txt']);
});

test('rejects bad paths or incomplete inventory before network access',async()=>{
 for(const scenario of ['duplicate','escape','incomplete','hash']){
  const data=fixture();if(scenario==='duplicate')data.files[1].path=data.files[0].path;
  if(scenario==='escape')data.files[0].path='/../admin';if(scenario==='incomplete')data.files.pop();if(scenario==='hash')data.files[0].sha256='bad';
  let calls=0;await assert.rejects(comparePublicAssets(data,{get:async()=>{calls++;}}));assert.equal(calls,0);
 }
});
