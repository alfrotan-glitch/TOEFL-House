// Read the authoritative route catalog and indexed practice data from the
// standalone edge/renderer sources without executing them. Keep the syntax
// deliberately narrow: an ambiguous or changed declaration fails the build.
function declaration(source,name){
 const pattern=new RegExp('^const '+name+'=([^\\n;]+);$','gm');
 const found=[...source.matchAll(pattern)];
 if(found.length!==1)throw Error('Missing or duplicate catalog declaration: '+name);
 return found[0][1];
}
function literalArray(value,name){
 let result;
 try{result=JSON.parse(value);}catch{throw Error('Invalid catalog array: '+name);}
 if(!Array.isArray(result)||!result.length)throw Error('Invalid catalog array: '+name);
 return result;
}
function ids(values,name){
 if(values.some(x=>typeof x!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x))||new Set(values).size!==values.length)throw Error('Invalid catalog IDs: '+name);
 return values;
}
export function extractContentContract(edge,renderer){
 const courses=ids(literalArray(declaration(edge,'V2_COURSE_IDS'),'courses'),'courses');
 const books=ids(literalArray(declaration(edge,'V2_PUBLIC_BOOK_GUIDES'),'books'),'books');
 const publicExpression=declaration(edge,'V2_PUBLIC_COURSES').match(/^\[\.\.\.V2_COURSE_IDS,("[a-z0-9-]+")\]$/);
 const guidesExpression=declaration(edge,'V2_PUBLIC_GUIDES').match(/^\[(.*),\.\.\.V2_PUBLIC_BOOK_GUIDES\]$/);
 if(!publicExpression||!guidesExpression)throw Error('Invalid derived route catalog');
 const publicCourses=ids([...courses,JSON.parse(publicExpression[1])],'public courses');
 const articles=ids(literalArray('['+guidesExpression[1]+']','guides'),'guides');
 const guides=ids([...articles,...books],'guides');
 const stages=literalArray(declaration(renderer,'V2_GE_STAGE_IDS'),'stages');
 if(stages.some(x=>typeof x!=='string'||!x.trim())||new Set(stages).size!==stages.length)throw Error('Invalid General English stages');
 const questions=literalArray(declaration(renderer,'V2_GE_PRACTICE_QUESTIONS'),'practice');
 for(const question of questions){
  if(!question||typeof question.prompt!=='string'||!question.prompt.trim()||!Array.isArray(question.choices)||question.choices.length<2||question.choices.some(x=>typeof x!=='string'||!x.trim())||!Number.isInteger(question.correct)||question.correct<0||question.correct>=question.choices.length)throw Error('Invalid practice question');
 }
 return {courses,publicCourses,articles,books,guides,stageCount:stages.length,practiceCount:questions.length};
}
