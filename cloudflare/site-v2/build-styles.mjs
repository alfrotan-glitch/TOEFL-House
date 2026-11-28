// One versioned CSS response: tokens, legacy components, and the shared signature.
// Keeping these source boundaries does not change Pages bindings or add requests.
import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
export const STYLE_FILES=['tokens.css','site.css','signature.css'];
export async function buildStyles(){
 const parts=await Promise.all(STYLE_FILES.map(name=>readFile(join(here,name),'utf8')));
 const css=parts.join('\n').replace(/\/\*[\s\S]*?\*\//g,'').split('\n').map(line=>line.trim()).join('');
 return {css,sourceBytes:parts.reduce((total,part)=>total+Buffer.byteLength(part),0)};
}
