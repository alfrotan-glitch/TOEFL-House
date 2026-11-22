import {readFile,mkdir,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";
import {createHash} from "node:crypto";
const here=dirname(fileURLToPath(import.meta.url));
let main=await readFile(join(here,"../pages-edge/worker.mjs"),"utf8");
const landingSource=await readFile(join(here,"landing.mjs"),"utf8");
// Compact authored static locale copy without changing the runtime markup.
function compactStatic(source,name){
 const pattern=name==="V2_COPY"?/const V2_COPY=(\{[\s\S]*?\n\});/:
  name==="V2_SEMESTER"?/const V2_SEMESTER=(\{[\s\S]*?\n\});/:
  /const V2_GENERAL_ENGLISH=(\{[\s\S]*?\n\});/;
 if(!pattern.test(source))throw Error("Static source shape moved: "+name);
 return source.replace(pattern,(_,json)=>{
  const normalized=name==="V2_COPY"?json.replace(/([\{\[,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g,'$1"$2"$3'):json;
  return "const "+name+"="+JSON.stringify(JSON.parse(normalized))+";";
 });
}
const landing=compactStatic(compactStatic(landingSource,"V2_SEMESTER"),"V2_COPY");
const detail=await readFile(join(here,"detail.mjs"),"utf8");
const generalEnglish=compactStatic(await readFile(join(here,"general-english.mjs"),"utf8"),"V2_GENERAL_ENGLISH");
const guides=await readFile(join(here,"guides.mjs"),"utf8");
const publicContent=await readFile(join(here,"public-content.mjs"),"utf8");
const academicEnglishSource=await readFile(join(here,"academic-english.mjs"),"utf8");
// Keep the three-language editorial source readable in Git, but compact its
// static JSON data in the deployed Worker to stay below the safe Pages budget.
const eapDataPattern=/const V2_EAP=(\{[\s\S]*?\});/;
if(!eapDataPattern.test(academicEnglishSource))throw Error("EAP data shape changed; refusing unsafe build");
const academicEnglish=academicEnglishSource.replace(eapDataPattern,(_,json)=>"const V2_EAP="+JSON.stringify(JSON.parse(json))+";");
const specialPrograms=await readFile(join(here,"special-programs.mjs"),"utf8");
// Remove CSS comments and layout-only whitespace in the published asset, while
// retaining readable, separately version-controlled CSS source for editors.
const cssSource=await readFile(join(here,"site.css"),"utf8");
const css=cssSource.replace(/\/\*[\s\S]*?\*\//g,"").split("\n").map(line=>line.trim()).join("");
const js=await readFile(join(here,"site.js"),"utf8");
const assetRevision=createHash("sha256").update(css).update(js).digest("hex").slice(0,12);
const entry="export default {\n  async fetch(request,env,ctx){";
const matching="    const url=new URL(request.url);";
const render=[
'    if(noindex(url.hostname)&&!["GET","HEAD","OPTIONS"].includes(request.method))return new Response("Preview is read-only",{status:403,headers:{"Cache-Control":"no-store","X-Robots-Tag":"noindex"}});',
'    if(url.pathname==="/api/content"&&["GET","HEAD"].includes(request.method)){',
'      return v2PublicContent(request,env);',
'    }',
'    const homeLocale=url.pathname==="/"?"en":url.pathname==="/fa/"?"fa":url.pathname==="/ps/"?"ps":null;',
'    if(homeLocale){',
'      const page=await v2Home(request,env,homeLocale);',
'      if(page)return page;',
'    }',
'    const parts=url.pathname.split("/").filter(Boolean);',
'    const routeLocale=["fa","ps"].includes(parts[0])?parts.shift():"en";',
'    if(parts[0]==="courses"&&parts.length===2&&(V2_COURSE_IDS.includes(parts[1])||parts[1]==="online-individual-zoom")){',
'      const page=await v2Detail(request,env,routeLocale,"course",parts[1]);',
'      if(page)return page;',
'    }',
'    if(parts[0]==="guides"&&(parts.length===1||(parts.length===2&&V2_GUIDE_SLUGS.includes(parts[1])))){',
'      const page=await v2Guides(request,env,routeLocale,parts[1]||null);',
'      if(page)return page;',
'    }',
'    if(parts[0]==="admissions"&&parts.length===1){',
'      const page=await v2Detail(request,env,routeLocale,"admissions",null);',
'      if(page)return page;',
'    }',
'    if(url.pathname==="/__th/v2/site.css") return staticResponse(request,V2_CSS,"text/css; charset=utf-8");',
'    if(url.pathname==="/__th/v2/site.js") return staticResponse(request,V2_JS,"application/javascript; charset=utf-8");',
'    if(["/tools","/tools/","/fa/tools","/fa/tools/","/ps/tools","/ps/tools/"].includes(url.pathname)&&!["GET","HEAD"].includes(request.method))',
'      return new Response("Method not allowed",{status:405,headers:{"Allow":"GET, HEAD"}});',
].join("\n")+"\n";
if(!main.includes(entry)||!main.includes(matching))throw Error("Original Worker changed: abort unsafe build");
main=main.replace(entry,landing+"\n"+generalEnglish+"\n"+academicEnglish+"\n"+specialPrograms+"\n"+detail+"\n"+guides+"\n"+publicContent+"\nconst V2_REV="+JSON.stringify(assetRevision)+";\nconst V2_CSS="+JSON.stringify(css)+";\nconst V2_JS="+JSON.stringify(js)+";\n"+entry);
const at=main.lastIndexOf(matching);
if(at<0)throw Error("fetch entry missing");
main=main.slice(0,at+matching.length)+"\n"+render+main.slice(at+matching.length);
if(!main.includes("function v2GeneralEnglish")||!main.includes("function v2AcademicEnglishPage")||!main.includes("function v2SpecialProgramPage")||!main.includes("async function v2Home")||!main.includes("const homeLocale=")||!main.includes("function v2Guides")||!main.includes("function v2PublicContent")||!main.includes("function v2PublicSitemap")||!main.includes("async function v2ServeLegacyTools")||!main.includes("env.LEGACY_CMS.fetch")||!main.includes("Never proxy to the retired Pages origin"))throw Error("Build missing new routes");
await mkdir(join(here,"dist"),{recursive:true});
await writeFile(join(here,"dist/_worker.js"),main);
console.log(JSON.stringify({output:"dist/_worker.js",bytes:Buffer.byteLength(main),assetRevision,cssBytes:Buffer.byteLength(css),clientBytes:Buffer.byteLength(js),retiredOriginProxy:false}));
