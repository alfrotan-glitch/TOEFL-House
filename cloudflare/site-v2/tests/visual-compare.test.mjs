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
