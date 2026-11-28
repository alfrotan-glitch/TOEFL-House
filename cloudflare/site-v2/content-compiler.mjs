// Build-time validation and compilation of separately reviewable translations.
// This file runs in Node during the build; it is not shipped to the Worker.
import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const locales=['en','fa','ps'];
function sameShape(reference,value,path){
 if(Array.isArray(reference)){
  if(!Array.isArray(value)||(!value.length&&reference.length))throw Error('Invalid localized array: '+path);
  // Translations may legitimately contain different numbers of list entries.
  for(const [index,item] of value.entries())if(reference.length)sameShape(reference[index]??reference[0],item,path+'['+index+']');
 }else if(reference&&typeof reference==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid localized object: '+path);
  const expected=Object.keys(reference).sort(),actual=Object.keys(value).sort();
  if(JSON.stringify(expected)!==JSON.stringify(actual))throw Error('Different localized keys: '+path);
  for(const key of expected)sameShape(reference[key],value[key],path+'.'+key);
 }else if(typeof value!==typeof reference)throw Error('Invalid localized value: '+path);
}
function localized(data,name){
 if(!data||JSON.stringify(Object.keys(data).sort())!==JSON.stringify([...locales].sort()))throw Error('Missing or unexpected locales: '+name);
 for(const locale of locales)sameShape(data.en,data[locale],name+'.'+locale);
}
export function compileContent(general,academic,special,guides,home){
 const homeKeys=['copy','goals','habits','paths','semester'];
 if(!home||JSON.stringify(Object.keys(home).sort())!==JSON.stringify(homeKeys))throw Error('Invalid home content');
 for(const key of homeKeys)localized(home[key],'home.'+key);
 localized(general,'general');
 localized(academic,'academic');
 if(!special||JSON.stringify(Object.keys(special).sort())!==JSON.stringify(['courses','ui']))throw Error('Invalid special program content');
 localized(special.ui,'special.ui');
 localized(special.courses,'special.courses');
 for(const locale of locales)if(JSON.stringify(Object.keys(special.courses[locale]).sort())!==JSON.stringify(['special','toefl']))throw Error('Missing special course: '+locale);
 const guideKeys=['bookData','bookUi','data','feedback','nav','ui'];
 if(!guides||JSON.stringify(Object.keys(guides).sort())!==JSON.stringify(guideKeys))throw Error('Invalid guide content');
 for(const key of guideKeys)localized(guides[key],'guides.'+key);
 return ['const V2_GENERAL_ENGLISH='+JSON.stringify(general)+';', 'const V2_EAP='+JSON.stringify(academic)+';', 'const V2_SPECIAL_UI='+JSON.stringify(special.ui)+';', 'const V2_SPECIAL_COURSES='+JSON.stringify(special.courses)+';',
  ...[['V2_GUIDE_UI','ui'],['V2_GUIDE_DATA','data'],['V2_BOOK_UI','bookUi'],['V2_BOOK_DATA','bookData'],['V2_BOOK_FEEDBACK','feedback'],['V2_GUIDE_NAV','nav']].map(([name,key])=>'const '+name+'='+JSON.stringify(guides[key])+';'),
  ...[['V2_COPY','copy'],['V2_SEMESTER','semester'],['V2_GOALS','goals'],['V2_HOME_PATHS','paths'],['V2_LEARNING_HABITS','habits']].map(([name,key])=>'const '+name+'='+JSON.stringify(home[key])+';')].join('\n');
}
export async function loadContent(){
 const [general,academic,special,guides,home]=await Promise.all(['general.json','academic.json','special.json','guides.json','home.json'].map(async name=>JSON.parse(await readFile(join(here,'content',name),'utf8'))));
 return compileContent(general,academic,special,guides,home);
}
