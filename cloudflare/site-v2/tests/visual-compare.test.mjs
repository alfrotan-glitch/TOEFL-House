import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('../visual-compare.mjs',import.meta.url));
test('visual comparison requires the same files and explicitly allowed changed paths',async()=>{
 const root=await mkdtemp(join(tmpdir(),'toefl-visual-test-'));
 try{
  const before=join(root,'before'),after=join(root,'after');
  await mkdir(before);await mkdir(after);
  const run=(...args)=>spawnSync(process.execPath,[script,before,after,...args],{encoding:'utf8'});
  assert.equal(run().status,1,'empty baseline is not a valid visual comparison');
  await writeFile(join(before,'%2F-390.png'),'one');
  await writeFile(join(after,'%2F-390.png'),'one');
  let result=run();assert.equal(result.status,0);assert.equal(JSON.parse(result.stdout).unchanged,1);
  await writeFile(join(after,'%2F-390.png'),'two');
  result=run();assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).unexpected[0].path,'/');
  result=run('--allow=/');assert.equal(result.status,0);assert.equal(JSON.parse(result.stdout).changed.length,1);
  await writeFile(join(after,'%2Ffa%2F-390.png'),'extra');
  result=run('--allow=/');assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).added.length,1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('matrix coverage rejects matching but incomplete or extra screenshot sets',async()=>{
 const root=await mkdtemp(join(tmpdir(),'toefl-visual-matrix-'));
 try{
  const before=join(root,'before'),after=join(root,'after'),worker=join(root,'worker.mjs');
  await mkdir(before);await mkdir(after);
  await writeFile(worker,`export default {async fetch(){return new Response('<urlset><url><loc>https://toeflhouse.pages.dev/</loc></url><url><loc>https://toeflhouse.pages.dev/fa/</loc></url></urlset>')}};`);
  const opts=['--expect-worker='+worker,'--widths=390,1440','--expected-count=2'];
  const run=(...args)=>spawnSync(process.execPath,[script,before,after,...args],{encoding:'utf8'});
  for(const dir of [before,after])for(const file of ['%2F-390.png','%2F-1440.png','%2Ffa%2F-390.png'])await writeFile(join(dir,file),'same');
  let result=run(...opts);assert.equal(result.status,1);
  let report=JSON.parse(result.stdout);assert.equal(report.coverage.verified,true);assert.deepEqual(report.coverage.missingBefore,['%2Ffa%2F-1440.png']);assert.deepEqual(report.coverage.missingAfter,['%2Ffa%2F-1440.png']);
  for(const dir of [before,after])await writeFile(join(dir,'%2Ffa%2F-1440.png'),'same');
  result=run(...opts);assert.equal(result.status,0);report=JSON.parse(result.stdout);assert.equal(report.coverage.expected,4);assert.match(report.coverage.workerSha256,/^[a-f0-9]{64}$/);
  for(const dir of [before,after])await writeFile(join(dir,'%2Fextra%2F-390.png'),'same');
  result=run(...opts);assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).coverage.extraAfter.length,1);
  assert.equal(run('--expect-worker='+worker).status,2,'matrix flags must be supplied together');
  assert.equal(run('--expect-worker='+worker,'--widths=390,390','--expected-count=2').status,2,'duplicate widths fail closed');
  assert.notEqual(run('--expect-worker='+worker,'--widths=390','--expected-count=3').status,0,'unexpected sitemap count fails closed');
 }finally{await rm(root,{recursive:true,force:true});}
});
