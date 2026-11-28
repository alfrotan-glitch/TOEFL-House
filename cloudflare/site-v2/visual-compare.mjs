// Compare PNGs captured by candidate-browser.cjs. Strict bytes are useful only
// with the same browser, fonts, OS, fixtures and blocked external media.
import {readdir,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const [before,after,...args]=process.argv.slice(2);
const usage='Usage: node visual-compare.mjs BEFORE AFTER [--allow=/path/ ...] [--expect-worker=FILE --widths=390,1440 --expected-count=51]';
const allowArgs=args.filter(arg=>arg.startsWith('--allow='));
const option=name=>args.filter(arg=>arg.startsWith('--'+name+'='));
const workers=option('expect-worker'),widthArgs=option('widths'),countArgs=option('expected-count');
const known=allowArgs.length+workers.length+widthArgs.length+countArgs.length;
if(!before||!after||known!==args.length||workers.length>1||widthArgs.length>1||countArgs.length>1||
  ([workers,widthArgs,countArgs].some(x=>x.length)&&![workers,widthArgs,countArgs].every(x=>x.length))){
 console.error(usage);process.exit(2);
}
const allowed=new Set(allowArgs.map(arg=>arg.slice('--allow='.length)));
const collect=async dir=>(await readdir(dir)).filter(f=>/^.+-\d+\.png$/.test(f)).sort();
const [oldFiles,newFiles]=await Promise.all([collect(before),collect(after)]);
const oldSet=new Set(oldFiles),newSet=new Set(newFiles);
const missing=oldFiles.filter(f=>!newSet.has(f)),added=newFiles.filter(f=>!oldSet.has(f));
const digest=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const changed=[];
for(const file of oldFiles){
 if(!newSet.has(file))continue;
 if(await digest(join(before,file))!==await digest(join(after,file))){
  const match=file.match(/^(.*)-(\d+)\.png$/);
  changed.push({path:decodeURIComponent(match[1]),width:Number(match[2]),file});
 }
}
const unexpected=changed.filter(item=>!allowed.has(item.path));
let coverage={verified:false,reason:'No independent expected route/width matrix was supplied'};
if(workers.length){
 // The Worker is executable code: only import a locally trusted build. The
 // sitemap supplies candidate routes, and expected-count is an independent
 // assertion so two identically incomplete directories cannot silently pass.
 const widths=widthArgs[0].slice('--widths='.length).split(',').map(Number);
 const expectedCount=Number(countArgs[0].slice('--expected-count='.length));
 if(!Number.isSafeInteger(expectedCount)||expectedCount<1||widths.some(x=>!Number.isSafeInteger(x)||x<1)||new Set(widths).size!==widths.length){console.error(usage);process.exit(2);}
 const workerPath=resolve(workers[0].slice('--expect-worker='.length));
 const workerHash=await digest(workerPath);
 const {default:worker}=await import(pathToFileURL(workerPath).href);
 const response=await worker.fetch(new Request('https://candidate.toeflhouse.pages.dev/sitemap.xml'),{});
 if(response.status!==200)throw Error('Expected Worker sitemap unavailable');
 const xml=await response.text();
 const urls=[...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match=>match[1]);
 const canonical='https://toeflhouse.pages.dev';
 if(urls.some(url=>!url.startsWith(canonical+'/')))throw Error('Unexpected Worker sitemap origin');
 const paths=urls.map(url=>url.slice(canonical.length));
 if(paths.length!==expectedCount||new Set(paths).size!==paths.length||paths.some(path=>!path.startsWith('/')||/[?#&]/.test(path)))throw Error('Unexpected Worker sitemap route count or identities');
 const expected=new Set(paths.flatMap(path=>widths.map(width=>encodeURIComponent(path)+'-'+width+'.png')));
 coverage={verified:true,workerSha256:workerHash,routes:paths.length,widths,expected:expected.size,
  missingBefore:[...expected].filter(file=>!oldSet.has(file)),missingAfter:[...expected].filter(file=>!newSet.has(file)),
  extraBefore:oldFiles.filter(file=>!expected.has(file)),extraAfter:newFiles.filter(file=>!expected.has(file))};
}
console.log(JSON.stringify({before:oldFiles.length,after:newFiles.length,unchanged:oldFiles.length-missing.length-changed.length,changed,missing,added,unexpected,coverage},null,2));
if(!oldFiles.length||missing.length||added.length||unexpected.length||
 (coverage.verified&&(coverage.missingBefore.length||coverage.missingAfter.length||coverage.extraBefore.length||coverage.extraAfter.length)))process.exitCode=1;
