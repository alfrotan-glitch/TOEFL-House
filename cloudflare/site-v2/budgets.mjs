// Engineering budgets, not Cloudflare platform limits. See the architecture audit.
import {readFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {buildStyles} from './build-styles.mjs';
const here=dirname(fileURLToPath(import.meta.url));
export const BUDGETS=Object.freeze({workerRaw:450000,workerGzip:140000,cssSource:84000,cssGzip:17000,clientRaw:10000});
export function checkBudgets(measures){
 return Object.entries(BUDGETS).filter(([name,max])=>!Number.isSafeInteger(measures[name])||measures[name]>=max).map(([name,max])=>`${name}: ${measures[name]} must be less than ${max}`);
}
export async function measureBudgets(){
 const [worker,client,styles]=await Promise.all([readFile(join(here,'dist/_worker.js')),readFile(join(here,'site.js')),buildStyles()]);
 return {workerRaw:worker.length,workerGzip:gzipSync(worker,{level:9}).length,cssSource:styles.sourceBytes,cssGzip:gzipSync(Buffer.from(styles.css),{level:9}).length,clientRaw:client.length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const measures=await measureBudgets(),failures=checkBudgets(measures);
 console.log(JSON.stringify({measures,budgets:BUDGETS,failures},null,2));
 if(failures.length)process.exitCode=1;
}
