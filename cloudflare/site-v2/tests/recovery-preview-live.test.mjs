import assert from "node:assert/strict";
const base="https://faf39634.toeflhouse.pages.dev";
const expected=["/","/fa/","/ps/","/admissions/","/fa/admissions/","/ps/admissions/"];
const courses=["general-english","academic-english","toefl-preparation","special-speaking","professional-writing","teacher-training","online-individual-zoom"];
const guides=["english-courses-kabul","toefl-ibt-2026","speaking-practice"];
for(const locale of ["","fa/","ps/"]){
 for(const id of courses)expected.push("/"+locale+"courses/"+id+"/");
 expected.push("/"+locale+"guides/");
 for(const id of guides)expected.push("/"+locale+"guides/"+id+"/");
}
const failures=[];
const results=[];
for(const path of expected){
 try{
  const r=await fetch(base+path,{redirect:"manual",signal:AbortSignal.timeout(20000)});
  const body=await r.text();
  const title=body.match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i)?.[1]||"";
  const row={path,status:r.status,type:r.headers.get("content-type"),robots:r.headers.get("x-robots-tag"),title:title.slice(0,90)};
  results.push(row);
  if(r.status!==200)failures.push(path+" HTTP "+r.status);
  if(!/text\\/html/i.test(row.type||""))failures.push(path+" not HTML");
  if(!title)failures.push(path+" missing title");
  if(r.headers.get("x-robots-tag")?.includes("noindex"))failures.push(path+" public route noindex");
 }catch(e){failures.push(path+" "+String(e))}
}
const [api,css,js,tools,admin,sitemap]=await Promise.all([
 fetch(base+"/api/content",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/__th/v2/site.css",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/__th/v2/site.js",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/fa/tools/",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/admin/",{redirect:"manual",signal:AbortSignal.timeout(20000)}),
 fetch(base+"/sitemap.xml",{signal:AbortSignal.timeout(20000)})
]);
const apiText=await api.text(),toolsText=await tools.text(),sitemapText=await sitemap.text();
if(api.status!==200||!apiText.includes('"cmsStatus":"connected"'))failures.push("published CMS unavailable");
if(css.status!==200||js.status!==200)failures.push("V2 CSS/JS unavailable");
if(tools.status!==200||!toolsText.includes("index-Ch3KjNPK")||!tools.headers.get("x-robots-tag")?.includes("noindex"))failures.push("legacy student tools unavailable or indexable");
if(![200,301,302,303,307,308].includes(admin.status)||!admin.headers.get("x-robots-tag")?.includes("noindex"))failures.push("admin route unavailable or not protected");
if(sitemap.status!==200||!sitemapText.includes("toeflhouse.pages.dev")||(sitemapText.match(/<loc>/g)||[]).length<39)failures.push("sitemap incomplete");
console.log(JSON.stringify({base,routeCount:results.length,failures,api:api.status,css:css.status,js:js.status,tools:tools.status,admin:admin.status,sitemap:sitemap.status,results},null,2));
assert.deepEqual(failures,[]);
