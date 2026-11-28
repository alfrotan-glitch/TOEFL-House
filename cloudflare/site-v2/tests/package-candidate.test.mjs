import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {packageCandidate} from '../package-candidate.mjs';

const commit='a'.repeat(40),buildRef='b'.repeat(40);
const digest=b=>createHash('sha256').update(b).digest('hex');
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'toefl-package-')),snapshot=join(root,'snapshot');await mkdir(snapshot);
 const manifest={project:'historical',deployment_id:'historic-id',files:{}};
 const report={project:'historical',deployment_id:'historic-id',timestamp:'2026-11-17T00:00:00Z',files:[]};
 for(let i=0;i<25;i++){
  const path='/assets/file-'+i+'.txt',bytes=Buffer.from('synthetic '+i),hash=String(i).padStart(32,'0');
  manifest.files[path]=hash; report.files.push({path,status:200,bytes:bytes.length,deployment_hash:hash});
  await mkdir(dirname(join(snapshot,path.slice(1))),{recursive:true});await writeFile(join(snapshot,path.slice(1)),bytes);
 }
 const manifestPath=join(root,'historical.json'),worker=join(root,'_worker.js');
 await writeFile(manifestPath,JSON.stringify(manifest));await writeFile(worker,'synthetic worker');
 const writeReport=()=>writeFile(join(snapshot,'BACKUP-REPORT.json'),JSON.stringify(report));await writeReport();
 return {root,snapshot,worker,manifestPath,manifest,report,writeReport,output:join(root,'package'),commit,buildRef};
}

test('package includes every snapshot asset and records actual SHA-256 without claiming approval',async()=>{
 const f=await fixture();try{
  const inventory=await packageCandidate(f);
  assert.match(inventory.status,/UNAPPROVED/);assert.equal(inventory.files.length,25);
  assert.equal(inventory.sourceCommit,commit);assert.equal(inventory.testedBuildRef,buildRef);
  assert.equal(inventory.worker.sha256,digest(await readFile(f.worker)));
  for(const record of inventory.files){
   const bytes=await readFile(join(f.output,'site',record.path.slice(1)));
   assert.equal(record.sha256,digest(bytes));assert.equal(record.bytes,bytes.length);
  }
  assert.deepEqual(JSON.parse(await readFile(join(f.output,'PACKAGE-INVENTORY.json'),'utf8')),inventory);
  await assert.rejects(packageCandidate(f),/EEXIST/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('incomplete, tampered or mismatched snapshot report fails closed before output exists',async()=>{
 for(const scenario of ['missing','duplicate','status','length','provenance','unsafe','outside','sha']){
  const f=await fixture();try{
   if(scenario==='missing')await rm(join(f.snapshot,'assets/file-0.txt'));
   if(scenario==='duplicate'){f.report.files[1]=f.report.files[0];await f.writeReport();}
   if(scenario==='status'){f.report.files[0].status=404;await f.writeReport();}
   if(scenario==='length')await writeFile(join(f.snapshot,'assets/file-0.txt'),'changed size');
   if(scenario==='provenance'){f.report.deployment_id='other';await f.writeReport();}
   if(scenario==='unsafe'){
    const val=f.manifest.files['/assets/file-0.txt'];delete f.manifest.files['/assets/file-0.txt'];f.manifest.files['/../outside']=val;
    await writeFile(f.manifestPath,JSON.stringify(f.manifest));
   }
   if(scenario==='outside'){
    await rm(join(f.snapshot,'assets/file-0.txt'));await symlink(f.worker,join(f.snapshot,'assets/file-0.txt'));
   }
   if(scenario==='sha')f.commit='not-a-sha';
   await assert.rejects(packageCandidate(f),undefined,scenario);
   await assert.rejects(readFile(join(f.output,'PACKAGE-INVENTORY.json')),/ENOENT/,scenario+' created no inventory');
  }finally{await rm(f.root,{recursive:true,force:true});}
 }
});
