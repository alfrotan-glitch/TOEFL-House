import {readFile,mkdir,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";
import {createHash} from "node:crypto";
const here=dirname(fileURLToPath(import.meta.url));
let main=await readFile(join(here,"../pages-edge/worker.mjs"),"utf8");
const landing=await readFile(join(here,"landing.mjs"),"utf8");
const detail=await readFile(join(here,"detail.mjs"),"utf8");
const css=await readFile(join(here,"site.css"),"utf8");
const js=await readFile(join(here,"site.js"),"utf8");
const assetRevision=createHash("sha256").update(css).update(js).digest("hex").slice(0,12);
const entry="export default {\n  async fetch(request,env,ctx){";
const matching="    const url=new URL(request.url);";
const target="  const target=new URL(incoming.pathname+incoming.search,UPSTREAM);";
const render=[
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
'    if(parts[0]==="admissions"&&parts.length===1){',
'      const page=await v2Detail(request,env,routeLocale,"admissions",null);',
'      if(page)return page;',
'    }',
'    if(url.pathname==="/__th/v2/site.css") return staticResponse(request,V2_CSS,"text/css; charset=utf-8");',
'    if(url.pathname==="/__th/v2/site.js") return staticResponse(request,V2_JS,"application/javascript; charset=utf-8");',
'    if(["/tools","/tools/","/fa/tools","/fa/tools/","/ps/tools","/ps/tools/"].includes(url.pathname)&&!["GET","HEAD"].includes(request.method))',
'      return new Response("Method not allowed",{status:405,headers:{"Allow":"GET, HEAD"}});',
].join("\n")+"\n";
if(!main.includes(entry)||!main.includes(matching)||!main.includes(target))throw Error("Original Worker changed: abort unsafe build");
const rewrittenTarget=[
'  const isTools=["/tools","/tools/","/fa/tools","/fa/tools/","/ps/tools","/ps/tools/"].includes(incoming.pathname);',
'  const upstreamPath=!isTools?incoming.pathname:incoming.pathname.startsWith("/fa/")?"/fa/":incoming.pathname.startsWith("/ps/")?"/ps/":"/";',
'  const target=new URL(upstreamPath+incoming.search,UPSTREAM);'
].join("\n");
main=main.replace(target,rewrittenTarget);
main=main.replace(entry,landing+"\n"+detail+"\nconst V2_REV="+JSON.stringify(assetRevision)+";\nconst V2_CSS="+JSON.stringify(css)+";\nconst V2_JS="+JSON.stringify(js)+";\n"+entry);
const at=main.lastIndexOf(matching);
if(at<0)throw Error("fetch entry missing");
main=main.slice(0,at+matching.length)+"\n"+render+main.slice(at+matching.length);
const headerFlag='if(noindex(incoming.hostname))outHeaders.set("X-Robots-Tag","noindex, nofollow, noarchive");';
if(!main.includes(headerFlag))throw Error("Preview robots guard moved");
main=main.replace(headerFlag,'if(noindex(incoming.hostname)||["/tools","/tools/","/fa/tools","/fa/tools/","/ps/tools","/ps/tools/"].includes(incoming.pathname))outHeaders.set("X-Robots-Tag","noindex, nofollow, noarchive");');
const undo='if(outHeaders.get("X-Robots-Tag")==="noindex, nofollow, noarchive")outHeaders.delete("X-Robots-Tag");';
if(!main.includes(undo))throw Error("Existing noindex behavior moved");
main=main.replace(undo,'if(!["/tools","/tools/","/fa/tools","/fa/tools/","/ps/tools","/ps/tools/"].includes(incoming.pathname) && outHeaders.get("X-Robots-Tag")==="noindex, nofollow, noarchive")outHeaders.delete("X-Robots-Tag");');
if(!main.includes("async function v2Home")||!main.includes("const homeLocale=")||!main.includes("const upstreamPath="))throw Error("Build missing new routes");
await mkdir(join(here,"dist"),{recursive:true});
await writeFile(join(here,"dist/_worker.js"),main);
console.log(JSON.stringify({output:"dist/_worker.js",bytes:Buffer.byteLength(main),cssBytes:Buffer.byteLength(css),clientBytes:Buffer.byteLength(js),legacyPreserved:true}));
