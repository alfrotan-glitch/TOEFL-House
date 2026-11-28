// Read-only proposal preflight. It does not fetch, archive, project or publish
// CMS content. Output consists only of fixed category names and counts; values
// and unrecognized key names are never emitted. This is a renderer-derived
// *subset*, not an approved public API schema or compatibility guarantee.
import {pathToFileURL} from 'node:url';
const MAX_BYTES=3_000_000;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const localeFields=new Set(['programs','faq','stats','statistics','contact']);
const programFields=new Set(['id','title','subtitle','summary','details','duration','highlights','levels','schedule','recommendedFor','recommended']);
const faqFields=new Set(['q','question','a','answer']);
const statFields=new Set(['graduates','graduatesLabel','toeflTakers','toeflLabel','universityAdmissions','universityLabel']);
const statisticFields=new Set(['value','label']);
const contactFields=new Set(['title','address','operatingHours','hours']);
const shiftFields=new Set(['id','timeEn','timeFa','open','popular']);
const scalar=value=>typeof value==='string'||typeof value==='number';

export function auditPublicShape(input){
 const report={status:'proposal-only',unknownFields:0,invalidShapes:0,unreviewedMedia:0,byCategory:{root:0,locale:0,program:0,faq:0,statistics:0,contact:0,timetable:0}};
 const invalid=()=>report.invalidShapes++;
 const unknown=(value,allowed,category)=>{for(const key of Object.keys(value))if(!allowed.has(key)){report.unknownFields++;report.byCategory[category]++;}};
 const leaves=(value,allowed,category)=>{
  if(!record(value)){invalid();return;}
  unknown(value,allowed,category);
  for(const [key,item] of Object.entries(value))if(allowed.has(key)&&item!=null&&!scalar(item))invalid();
 };
 const locale=value=>{
  if(!record(value)){invalid();return;}
  unknown(value,localeFields,'locale');
  if(!Array.isArray(value.programs))invalid();
  else for(const program of value.programs){
   if(!record(program)){invalid();continue;}
   unknown(program,programFields,'program');
   for(const [key,item] of Object.entries(program))if(programFields.has(key)&&item!=null){
    if(key==='highlights'){if(!Array.isArray(item)||item.some(x=>!scalar(x)))invalid();}
    else if(!scalar(item))invalid();
   }
  }
  if(value.faq!=null){
   let entries=value.faq;
   if(record(entries)){unknown(entries,new Set(['items']),'faq');entries=entries.items;}
   if(!Array.isArray(entries))invalid();else for(const item of entries)leaves(item,faqFields,'faq');
  }
  if(value.stats!=null)leaves(value.stats,statFields,'statistics');
  if(value.statistics!=null){if(!Array.isArray(value.statistics))invalid();else for(const item of value.statistics)leaves(item,statisticFields,'statistics');}
  if(value.contact!=null)leaves(value.contact,contactFields,'contact');
 };
 if(!record(input)){invalid();return report;}
 unknown(input,new Set(['locales','media','timetable','revision','updatedAt','cmsStatus','psRevision']),'root');
 for(const key of ['revision','updatedAt','cmsStatus','psRevision'])if(input[key]!=null&&!scalar(input[key]))invalid();
 const locales=input.locales;
 if(!record(locales))invalid();
 else {unknown(locales,new Set(['en','fa','ps']),'root');locale(locales.en);locale(locales.fa);locale(locales.ps);}
 if(input.media!=null&&(!record(input.media)||Object.keys(input.media).length))report.unreviewedMedia++;
 if(input.timetable!=null){
  if(Array.isArray(input.timetable))for(const shift of input.timetable){
   if(!record(shift)){invalid();continue;}
   unknown(shift,shiftFields,'timetable');
   for(const [key,item] of Object.entries(shift))if(shiftFields.has(key)&&item!=null){
    if(key==='open'||key==='popular'){if(typeof item!=='boolean')invalid();}else if(!scalar(item))invalid();
   }
  }
  else if(!record(input.timetable)||Object.keys(input.timetable).length)invalid();
 }
 return report;
}

async function main(){
 let size=0;const chunks=[];
 try{
  for await(const chunk of process.stdin){size+=chunk.length;if(size>MAX_BYTES)throw Error('too large');chunks.push(chunk);}
  const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  process.stdout.write(JSON.stringify(auditPublicShape(input))+'\n');
 }catch{
  // Never include source text, parser messages or exception details.
  process.stderr.write('Unable to audit input: expected a bounded JSON envelope.\n');process.exitCode=1;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
