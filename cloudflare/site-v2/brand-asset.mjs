// The existing embedded logo remains inside the Worker. This is not a new
// Pages asset and does not change the current release package or routing.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const BRAND_SHA256='753895f6e9453eb62d4ee6feab020570d0c4113ac8263a417e6588fe55560e1e';
export function compileBrand(base64){
 const text=base64.trim();
 if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))throw Error('Invalid brand base64');
 const bytes=Buffer.from(text,'base64');
 if(bytes.toString('base64')!==text||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WEBP'||createHash('sha256').update(bytes).digest('hex')!==BRAND_SHA256)throw Error('Brand integrity check failed');
 return 'const V2_LOGO_REV='+JSON.stringify(BRAND_SHA256.slice(0,12))+';\nconst V2_LOGO_DATA='+JSON.stringify(text)+';';
}
export async function loadBrand(){
 return compileBrand(await readFile(new URL('./content/brand.webp.base64',import.meta.url),'utf8'));
}
