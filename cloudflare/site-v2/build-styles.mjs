// One versioned CSS response: tokens, legacy components, and the shared signature.
// Keeping these source boundaries does not change Pages bindings or add requests.
import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
export const STYLE_FILES=['tokens.css','site.css','signature.css'];

// A CSS hexadecimal escape consumes up to six hex digits and one optional
// whitespace terminator (CRLF counts as one). That terminator is not a
// descendant-combinator space; never merge it with subsequent whitespace.
function escapeEnd(source,index){
 let end=index+1;
 if(end>=source.length)return end;
 if(/[0-9a-f]/i.test(source[end])){
  let count=0;while(end<source.length&&count<6&&/[0-9a-f]/i.test(source[end])){end++;count++;}
  if(/[\t\r\f \n]/.test(source[end]||'')){
   if(source[end]==='\r'&&source[end+1]==='\n')end+=2;else end++;
  }
  return end;
 }
 if(source[end]==='\r'&&source[end+1]==='\n')return end+2;
 return end+1;
}

// This is deliberately not a general CSS minifier. Only comments occupying
// complete lines are removed; inline comments can delimit CSS tokens and must
// remain intact. Newlines remain whitespace except after a completed top-level
// block (or at EOF). Quoted, escaped and retained-comment content is untouched.
export function compactStyles(source){
 let stripped='',quote='';
 for(let i=0;i<source.length;i++){
  const c=source[i];
  if(quote){
   stripped+=c;
   if(c==='\\'&&i+1<source.length)stripped+=source[++i];
   else if(c===quote)quote='';
   continue;
  }
  if(c==='\\'){const end=escapeEnd(source,i);stripped+=source.slice(i,end);i=end-1;continue;}
  if(c==='"'||c==="'"){quote=c;stripped+=c;continue;}
  if(c==='/'&&source[i+1]==='*'){
   const end=source.indexOf('*/',i+2);
   if(end<0)throw Error('Unterminated CSS comment');
   const lineStart=source.lastIndexOf('\n',i-1)+1;
   const nextLine=source.indexOf('\n',end+2);
   const lineEnd=nextLine<0?source.length:nextLine;
   const standalone=/^[\t\r\f ]*$/.test(source.slice(lineStart,i))&&/^[\t\r\f ]*$/.test(source.slice(end+2,lineEnd));
   if(!standalone)stripped+=source.slice(i,end+2);
   i=end+1;continue;
  }
  stripped+=c;
 }
 if(quote)throw Error('Unterminated CSS string');
 let out='',depth=0,parens=0,brackets=0,lastTopLevelBlock=false;
 quote='';
 for(let i=0;i<stripped.length;i++){
  const c=stripped[i];
  if(quote){
   out+=c;
   if(c==='\\'&&i+1<stripped.length)out+=stripped[++i];
   else if(c===quote)quote='';
   continue;
  }
  if(c==='\\'){const end=escapeEnd(stripped,i);out+=stripped.slice(i,end);i=end-1;lastTopLevelBlock=false;continue;}
  if(c==='"'||c==="'"){quote=c;out+=c;lastTopLevelBlock=false;continue;}
  if(c==='/'&&stripped[i+1]==='*'){
   const end=stripped.indexOf('*/',i+2);
   if(end<0)throw Error('Unterminated CSS comment');
   out+=stripped.slice(i,end+2);i=end+1;lastTopLevelBlock=false;continue;
  }
  if(/[\t\r\f \n]/.test(c)){
   let end=i+1;while(end<stripped.length&&/[\t\r\f \n]/.test(stripped[end]))end++;
   const space=stripped.slice(i,end),hasLineBreak=/[\r\n\f]/.test(space);
   if(out&&end<stripped.length){
    if(hasLineBreak){if(!lastTopLevelBlock)out+=' ';}
    else out+=space;
   }
   i=end-1;continue;
  }
  if(c==='(')parens++;
  else if(c===')')parens=Math.max(0,parens-1);
  else if(c==='[')brackets++;
  else if(c===']')brackets=Math.max(0,brackets-1);
  if(!parens&&!brackets&&c==='{')depth++;
  else if(!parens&&!brackets&&c==='}')depth=Math.max(0,depth-1);
  out+=c;lastTopLevelBlock=c==='}'&&depth===0&&!parens&&!brackets;
 }
 return out;
}
export async function buildStyles(){
 const parts=await Promise.all(STYLE_FILES.map(name=>readFile(join(here,name),'utf8')));
 const css=compactStyles(parts.join('\n'));
 return {css,sourceBytes:parts.reduce((total,part)=>total+Buffer.byteLength(part),0)};
}
