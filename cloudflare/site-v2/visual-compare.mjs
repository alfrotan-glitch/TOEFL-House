// Compare viewport PNGs captured by candidate-browser.cjs via TOEFL_VISUAL_DIR.
// Strict bytes are useful for same-browser, same-fixture refactors; a change in
// browser, fonts, OS, images or fixture content invalidates the comparison.
import {readdir,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

const [before,after,...args]=process.argv.slice(2);
if(!before||!after||args.some(arg=>!arg.startsWith('--allow='))){
 console.error('Usage: node visual-compare.mjs BEFORE AFTER [--allow=/path/ ...]');
 process.exit(2);
}
const allowed=new Set(args.map(arg=>arg.slice('--allow='.length)));
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
console.log(JSON.stringify({before:oldFiles.length,after:newFiles.length,unchanged:oldFiles.length-missing.length-changed.length,changed,missing,added,unexpected},null,2));
if(!oldFiles.length||missing.length||added.length||unexpected.length)process.exitCode=1;
