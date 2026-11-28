// Read-only comparison of a package with public canonical URLs, not Pages API provenance.
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const origin='https://toeflhouse.pages.dev';
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function comparePublicAssets(inventory,{get=fetch}={}){
 if(!Array.isArray(inventory.files)||inventory.files.length!==25)throw Error('Expected 25 package assets');
 const seen=new Set(),results=new Array(inventory.files.length);
 for(const asset of inventory.files){
  if(!/^\/[A-Za-z0-9/_\-.]+$/.test(asset.path)||asset.path.includes('..')||seen.has(asset.path)||!(/^[a-f0-9]{64}$/).test(asset.sha256))throw Error('Unsafe or duplicate package asset');
  seen.add(asset.path);
 }
 let next=0;
 async function check(){while(next<inventory.files.length){
  const index=next++,asset=inventory.files[index];
  const result={path:asset.path,packageSha256:asset.sha256};
  try{
   const response=await get(origin+asset.path,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(20000)});
   result.status=response.status;
   if(response.status===200){
    const bytes=Buffer.from(await response.arrayBuffer());result.publicBytes=bytes.length;result.publicSha256=sha256(bytes);result.matches=result.publicSha256===asset.sha256;
   }else result.matches=false;
  }catch(error){result.matches=false;result.error=String(error);}
  results[index]=result;
 }}
 await Promise.all(Array.from({length:5},check));
 return {origin,checkedAt:new Date().toISOString(),allMatch:results.every(x=>x.matches),results,limitations:['Public responses do not prove the Pages deployment manifest or deployed Worker identity','The active public site can change during or after this check','This is not a preview, permission check, binding check or release authorization']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('Usage: node compare-public-assets.mjs INVENTORY OUTPUT');
 const report=await comparePublicAssets(JSON.parse(await readFile(input,'utf8')));
 await writeFile(output,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({origin:report.origin,allMatch:report.allMatch,matched:report.results.filter(x=>x.matches).length,total:report.results.length,differences:report.results.filter(x=>!x.matches).map(({path,status,error})=>({path,status,error}))}));
 if(!report.allMatch)process.exitCode=1;
}
