// One versioned CSS response: tokens, legacy components, and the shared signature.
// Keeping these source boundaries does not change Pages bindings or add requests.
import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
export const STYLE_FILES=['tokens.css','site.css','signature.css'];
// Ignore comments only outside quoted strings and escaped characters. Preserve
// line breaks inside CSS strings; source indentation outside strings is free.
export function compactStyles(source){
 let out='',quote='',lineStart=true;
 for(let i=0;i<source.length;i++){
  const c=source[i];
  if(quote){
   out+=c;
   if(c==='\\'&&i+1<source.length)out+=source[++i];
   else if(c===quote)quote='';
   continue;
  }
  if(c==='\\'&&i+1<source.length){out+=c+source[++i];lineStart=false;continue;}
  if(c==='"'||c==="'"){quote=c;out+=c;lineStart=false;continue;}
  if(c==='/'&&source[i+1]==='*'){
   const end=source.indexOf('*/',i+2);
   if(end<0)throw Error('Unterminated CSS comment');
   i=end+1;continue;
  }
  if(c==='\n'){out=out.replace(/[\t\r\f ]+$/,'');lineStart=true;continue;}
  if(lineStart&&/[\t\r\f ]/.test(c))continue;
  out+=c;lineStart=false;
 }
 if(quote)throw Error('Unterminated CSS string');
 return out.trim();
}
export async function buildStyles(){
 const parts=await Promise.all(STYLE_FILES.map(name=>readFile(join(here,name),'utf8')));
 const css=compactStyles(parts.join('\n'));
 return {css,sourceBytes:parts.reduce((total,part)=>total+Buffer.byteLength(part),0)};
}
