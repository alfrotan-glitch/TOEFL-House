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
function lengthIs(value,length,path){
 if(!Array.isArray(value)||value.length!==length)throw Error('Invalid indexed length: '+path+' (expected '+length+')');
}
function tuples(value,length,path){
 if(!Array.isArray(value))throw Error('Invalid tuples: '+path);
 for(const [i,tuple] of value.entries()){
  lengthIs(tuple,length,path+'['+i+']');
  for(const [j,text] of tuple.entries())requireText(text,path+'['+i+']['+j+']');
 }
}
function sameKeys(value,keys,path){
 if(!value||typeof value!=='object'||Array.isArray(value)||JSON.stringify(Object.keys(value).sort())!==JSON.stringify([...keys].sort()))throw Error('Invalid catalog keys: '+path);
}
function requireText(value,path){
 if(typeof value!=='string'||!value.trim())throw Error('Missing required text: '+path);
}
function validateReferences(general,academic,special,guides,home,ui,contract){
 if(!contract)throw Error('Content contract required');
 for(const locale of locales){
  const prefix=locale+'.';
  const expectedLanguage={en:['en','ltr'],fa:['fa-AF','rtl'],ps:['ps-AF','rtl']}[locale];
  if(home.copy[locale].lang!==expectedLanguage[0]||home.copy[locale].dir!==expectedLanguage[1])throw Error('Invalid language or direction: '+locale);
  sameKeys(home.courseCards[locale],contract.courses,prefix+'course cards');
  for(const [id,card] of Object.entries(home.courseCards[locale])){
   sameKeys(card,['name','fallbackDuration','shortDuration'],prefix+'course card '+id);
   for(const value of Object.values(card))requireText(value,prefix+'course card '+id);
  }
  for(const id of Object.keys(home.reviewedCards[locale]))if(!contract.courses.includes(id))throw Error('Unknown reviewed course: '+prefix+id);
  sameKeys(home.header[locale],['compact','skip','language'],prefix+'header');
  for(const value of Object.values(home.header[locale]))requireText(value,prefix+'header');
  lengthIs(home.paths[locale].links,3,prefix+'home paths'); // Three renderer-owned quick paths.
  sameKeys(general.locales[locale].stageData,general.catalog.map(stage=>stage.id),prefix+'General English stages');
  for(const stage of general.catalog){
   const data=general.locales[locale].stageData[stage.id];
   sameKeys(data,['focus','description','fee'],prefix+stage.id);
   for(const value of Object.values(data))requireText(value,prefix+stage.id);
   requireText(general.locales[locale][stage.durationKey],prefix+'duration '+stage.durationKey);
  }
  lengthIs(ui.practice[locale].explanations,contract.practiceCount,prefix+'practice explanations');
  for(const value of [...home.paths[locale].links,...ui.practice[locale].explanations])requireText(value,prefix+'indexed content');
  lengthIs(academic[locale].levels,4,prefix+'academic levels'); // The fourth-level note is renderer-indexed.
  for(const key of ['seoTitle','seoDescription','feeMonthDisplay','feeLevelDisplay','levelDuration'])requireText(academic[locale][key],prefix+'academic.'+key);
  if(!Array.isArray(academic[locale].books)||!academic[locale].books.length)throw Error('Missing academic books: '+locale);
  const bookIds=academic[locale].books.map(book=>book.guide);
  if(new Set(bookIds).size!==bookIds.length||JSON.stringify(bookIds)!==JSON.stringify(academic.en.books.map(book=>book.guide)))throw Error('Invalid localized academic book order: '+locale);
  for(const book of academic[locale].books){
   requireText(book.title,prefix+'academic book title');
   if(!contract.books.includes(book.guide)||guides.bookData[locale]?.[book.guide]?.program!=='academic-english')throw Error('Invalid academic book guide: '+prefix+book.guide);
  }
  for(const [value,size,path] of [
   [general.locales[locale].facts,2,'general facts'],[general.locales[locale].faqs,2,'general FAQs'],[general.locales[locale].skills,2,'general skills'],
   [academic[locale].facts,2,'academic facts'],[academic[locale].outcomes,2,'academic outcomes'],[academic[locale].faq,2,'academic FAQs'],
   [home.copy[locale].steps,3,'home steps'],[home.copy[locale].statsFallback,2,'home stats'],[home.copy[locale].fallbackFaq,2,'home FAQs'],
   [home.goals[locale].items,2,'goals'],[home.habits[locale].habits,3,'habits'],[home.habits[locale].links,3,'habit links'],[ui.detail[locale].faqs,2,'admissions FAQs']
  ])tuples(value,size,prefix+path);
  for(const [id,page] of Object.entries(special.courses[locale])){
   for(const [field,size] of [['facts',2],['outcomes',2],['method',3],['faq',2]])tuples(page[field],size,prefix+id+'.'+field);
  }
  sameKeys(guides.data[locale],contract.articles,prefix+'articles');
  sameKeys(guides.bookData[locale],contract.books,prefix+'books');
  sameKeys(guides.feedback[locale].hints,contract.books,prefix+'book feedback');
  sameKeys(ui.facts[locale],contract.publicCourses,prefix+'admissions facts');
  for(const [kind,entries] of [['article',guides.data[locale]],['book',guides.bookData[locale]]])for(const [id,item] of Object.entries(entries)){
   for(const key of ['title','description','intro'])requireText(item[key],prefix+id+'.'+key);
   if(typeof item.program!=='string'||(kind==='book'&&!item.program)||(item.program&&!contract.publicCourses.includes(item.program)))throw Error('Unknown guide program: '+prefix+id);
   if(item.program!==guides[kind==='article'?'data':'bookData'].en[id].program)throw Error('Different guide program across locales: '+prefix+id);
   if(!Array.isArray(item.sections)||!item.sections.length)throw Error('Missing guide sections: '+prefix+id);
   for(const [index,section] of item.sections.entries()){
    requireText(section.heading,prefix+id+'.sections['+index+'].heading');
    if(!Array.isArray(section.paragraphs)||!section.paragraphs.length)throw Error('Missing guide paragraphs: '+prefix+id);
    for(const paragraph of section.paragraphs)requireText(paragraph,prefix+id+'.paragraph');
    if(section.bullets!==undefined){if(!Array.isArray(section.bullets))throw Error('Invalid guide bullets: '+prefix+id);for(const bullet of section.bullets)requireText(bullet,prefix+id+'.bullet');}
   }
   if(kind==='book'){
    requireText(item.publisher,prefix+id+'.publisher');
    let source;try{source=new URL(item.source);}catch{throw Error('Invalid book source: '+prefix+id);}
    if(source.protocol!=='https:'||source.username||source.password)throw Error('Invalid book source: '+prefix+id);
   }
  }
  for(const [items,allowed,path] of [[home.goals[locale].items,contract.courses,'goals'],[home.habits[locale].links,contract.guides,'habit links']]){
   const reference=(path==='goals'?home.goals.en.items:home.habits.en.links).map(item=>item[0]);
   if(items.some(item=>!allowed.includes(item[0]))||JSON.stringify(items.map(item=>item[0]))!==JSON.stringify(reference))throw Error('Invalid localized route references: '+prefix+path);
  }
 }
}
export function compileContent(general,academic,special,guides,home,ui,contract){
 const uiKeys=['breadcrumb','campusAlt','detail','facts','fallback','practice'];
 if(!ui||JSON.stringify(Object.keys(ui).sort())!==JSON.stringify(uiKeys))throw Error('Invalid shared UI content');
 for(const key of uiKeys)localized(ui[key],'ui.'+key);
 const homeKeys=['copy','courseCards','courseGlyphs','goals','habits','header','paths','reviewedCards','semester'];
 if(!home||JSON.stringify(Object.keys(home).sort())!==JSON.stringify(homeKeys))throw Error('Invalid home content');
 for(const key of homeKeys.filter(key=>key!=='courseGlyphs'))localized(home[key],'home.'+key);
 if(!contract)throw Error('Content contract required');
 sameKeys(home.courseGlyphs,contract.courses,'home course glyphs');
 // Trusted source graphics, not user markup. Limit to the exact primitive and
 // attribute forms used by these decorative icons before embedding as SVG.
 const glyphPattern=/^(?:<path d="[A-Za-z0-9 .,-]+"\/>|<circle cx="[0-9]+" cy="[0-9]+" r="[0-9]+"\/>|<rect x="[0-9]+" y="[0-9]+" width="[0-9]+" height="[0-9]+" rx="[0-9]+"\/>)+$/;
 for(const [id,glyph] of Object.entries(home.courseGlyphs))if(typeof glyph!=='string'||!glyphPattern.test(glyph))throw Error('Invalid course glyph: '+id);
 sameKeys(general,['catalog','locales'],'general');
 lengthIs(general.catalog,5,'general stage catalog');
 for(const [i,stage] of general.catalog.entries()){
  sameKeys(stage,['id','durationKey'],'general stage '+i);
  requireText(stage.id,'general stage ID');
  if(stage.durationKey!==(i===0?'foundation':'semester'))throw Error('Invalid General English stage duration: '+stage.id);
 }
 if(new Set(general.catalog.map(stage=>stage.id)).size!==general.catalog.length)throw Error('Duplicate General English stage');
 localized(general.locales,'general.locales');
 localized(academic,'academic');
 if(!special||JSON.stringify(Object.keys(special).sort())!==JSON.stringify(['courses','ui']))throw Error('Invalid special program content');
 localized(special.ui,'special.ui');
 localized(special.courses,'special.courses');
 for(const locale of locales)if(JSON.stringify(Object.keys(special.courses[locale]).sort())!==JSON.stringify(['special','toefl']))throw Error('Missing special course: '+locale);
 const guideKeys=['bookData','bookUi','data','feedback','nav','ui'];
 if(!guides||JSON.stringify(Object.keys(guides).sort())!==JSON.stringify(guideKeys))throw Error('Invalid guide content');
 for(const key of guideKeys)localized(guides[key],'guides.'+key);
 validateReferences(general,academic,special,guides,home,ui,contract);
 return ['const V2_GENERAL_ENGLISH='+JSON.stringify(general.locales)+';', 'const V2_GE_STAGES='+JSON.stringify(general.catalog)+';', 'const V2_EAP='+JSON.stringify(academic)+';', 'const V2_SPECIAL_UI='+JSON.stringify(special.ui)+';', 'const V2_SPECIAL_COURSES='+JSON.stringify(special.courses)+';',
  ...[['V2_GUIDE_UI','ui'],['V2_GUIDE_DATA','data'],['V2_BOOK_UI','bookUi'],['V2_BOOK_DATA','bookData'],['V2_BOOK_FEEDBACK','feedback'],['V2_GUIDE_NAV','nav']].map(([name,key])=>'const '+name+'='+JSON.stringify(guides[key])+';'),
  ...[['V2_COPY','copy'],['V2_SEMESTER','semester'],['V2_GOALS','goals'],['V2_HOME_PATHS','paths'],['V2_LEARNING_HABITS','habits'],['V2_HOME_HEADER','header'],['V2_HOME_COURSE_CARDS','courseCards'],['V2_COURSE_GLYPHS','courseGlyphs'],['V2_HOME_REVIEWED_CARDS','reviewedCards']].map(([name,key])=>'const '+name+'='+JSON.stringify(home[key])+';'),
  ...[['V2_BREADCRUMB','breadcrumb'],['V2_CAMPUS_ALT','campusAlt'],['V2_DETAIL_LABELS','detail'],['V2_ADMISSIONS_FACTS','facts'],['V2_ADMISSIONS_FALLBACK','fallback'],['V2_GE_PRACTICE_UI','practice']].map(([name,key])=>'const '+name+'='+JSON.stringify(ui[key])+';')].join('\n');
}
export async function loadContent(contract){
 const [general,academic,special,guides,home,ui]=await Promise.all(['general.json','academic.json','special.json','guides.json','home.json','ui.json'].map(async name=>JSON.parse(await readFile(join(here,'content',name),'utf8'))));
 return compileContent(general,academic,special,guides,home,ui,contract);
}
