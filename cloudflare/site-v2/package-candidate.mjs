// Assemble a traceable *unapproved* candidate from an existing public snapshot.
// Hashes identify these bytes; they do not prove they match the active Pages deployment.
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,realpath,stat} from 'node:fs/promises';
import {dirname,basename,join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const historicalManifest=fileURLToPath(new URL('../website-verification/pages-static-manifest.json',import.meta.url));
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
function inside(root,path){const rel=relative(root,path);return rel!==''&&!rel.startsWith('..')&&!isAbsolute(rel);}

export async function packageCandidate({snapshot,worker,output,commit,buildRef,manifestPath=historicalManifest}){
 if(!/^[a-f0-9]{40}$/.test(commit)||!/^[a-f0-9]{40}$/.test(buildRef))throw Error('Full source and tested build Git SHAs are required');
 const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
 const entries=Object.entries(manifest.files||{}).sort(([a],[b])=>a.localeCompare(b,'en'));
 if(entries.length!==25)throw Error('Expected exactly 25 historical asset paths');
 const root=await realpath(snapshot), report=JSON.parse(await readFile(join(root,'BACKUP-REPORT.json'),'utf8'));
 if(report.project!==manifest.project||report.deployment_id!==manifest.deployment_id||!Array.isArray(report.files))throw Error('Snapshot provenance does not match historical manifest');
 const byPath=new Map(report.files.map(item=>[item.path,item]));
 if(report.files.length!==entries.length||byPath.size!==entries.length)throw Error('Snapshot report must contain each historical asset once');
 const files=[];
 for(const [path,historicalHash] of entries){
  if(!/^\/[A-Za-z0-9/_\-.]+$/.test(path)||path.includes('..')||path==='/'||path==='/_worker.js')throw Error('Unsafe historical asset path');
  const record=byPath.get(path);
  if(!record||record.status!==200||record.error||record.deployment_hash!==historicalHash)throw Error('Snapshot report missing or invalid for '+path);
  const filename=await realpath(join(root,path.slice(1)));
  if(!inside(root,filename)||(await stat(filename)).isFile()===false)throw Error('Asset is not a file within snapshot: '+path);
  const bytes=await readFile(filename);
  if(!bytes.length||record.bytes!==bytes.length)throw Error('Missing or truncated snapshot asset: '+path);
  files.push({path,bytes:bytes.length,sha256:sha256(bytes),historicalDeploymentHash:historicalHash,data:bytes});
 }
 const workerBytes=await readFile(worker);
 if(!workerBytes.length)throw Error('Worker is empty');
 const dest=resolve(output),parent=await realpath(dirname(dest));
 if(parent===root||inside(root,parent)||join(parent,basename(dest))===root)throw Error('Output must be separate from snapshot');
 await mkdir(dest); // Never overwrite an existing directory.
 const site=join(dest,'site');await mkdir(site);
 await writeFile(join(site,'_worker.js'),workerBytes,{flag:'wx'});
 for(const file of files){const target=join(site,file.path.slice(1));await mkdir(dirname(target),{recursive:true});await writeFile(target,file.data,{flag:'wx'});}
 const inventory={
  status:'UNAPPROVED: historical snapshot only; compare against authorized current Pages deployment before any upload',
  sourceCommit:commit,testedBuildRef:buildRef,worker:{path:'/_worker.js',bytes:workerBytes.length,sha256:sha256(workerBytes)},
  historicalSnapshot:{project:report.project,deploymentId:report.deployment_id,capturedAt:report.timestamp,source:'GitHub Actions public snapshot; not CMS or Functions'},
  files:files.map(({data,...record})=>record),
  caveats:['SHA-256 records package bytes, not authenticity or parity with current production','Historical deployment hashes are copied identifiers, not independently validated cryptographic hashes','CMS_DB, LEGACY_CMS, ASSETS, deployment configuration and current production manifest must be checked separately','No preview or production deployment is authorized by this package']
 };
 await writeFile(join(dest,'PACKAGE-INVENTORY.json'),JSON.stringify(inventory,null,2)+'\n',{flag:'wx'});
 return inventory;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [snapshot,worker,output,commit,buildRef]=process.argv.slice(2);
 if(!snapshot||!worker||!output||!commit||!buildRef)throw Error('Usage: node package-candidate.mjs SNAPSHOT WORKER OUTPUT SOURCE_COMMIT TESTED_BUILD_REF');
 const result=await packageCandidate({snapshot,worker,output,commit,buildRef});
 console.log(JSON.stringify({status:result.status,sourceCommit:result.sourceCommit,testedBuildRef:result.testedBuildRef,worker:result.worker,assetCount:result.files.length},null,2));
}
