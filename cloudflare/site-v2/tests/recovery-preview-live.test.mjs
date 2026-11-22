import assert from "node:assert/strict";
const base="https://7b9bac5b.toeflhouse.pages.dev";
const expected=["/","/fa/","/ps/","/admissions/","/fa/admissions/","/ps/admissions/"];
const courses=["general-english","academic-english","toefl-preparation","special-speaking","professional-writing","teacher-training","online-individual-zoom"];
const guides=["english-courses-kabul","toefl-ibt-2026","speaking-practice"];
for(const locale of ["","fa/","ps/"]){
 for(const id of courses)expected.push("/"+locale+"courses/"+id+"/");
 expected.push("/"+locale+"guides/");
 for(const id of guides)expected.push("/"+locale+"guides/"+id+"/");
}
const failures=[],results=[];
for(const path of expected){
 try{
  const r=await fetch(base+path,{redirect:"manual",signal:AbortSignal.timeout(20000)});
  const body=await r.text();
  const title=body.includes("<title")?body.split("<title")[1].split("</title>")[0].replace(/^>/,"").trim():"";
  const type=r.headers.get("content-type")||"";
  results.push({path,status:r.status,type,robots:r.headers.get("x-robots-tag"),title:title.slice(0,90)});
  if(r.status!==200)failures.push(path+" HTTP "+r.status);
  if(!type.includes("text/html"))failures.push(path+" not HTML");
  if(!title)failures.push(path+" missing title");
  if(!r.headers.get("x-robots-tag")?.includes("noindex"))failures.push(path+" preview must be noindex");
 }catch(e){failures.push(path+" "+String(e))}
}
const [api,css,js,tools,admin,sitemap,robots,rootIndex,faIndex,bundle]=await Promise.all([
 fetch(base+"/api/content",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/__th/v2/site.css",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/__th/v2/site.js",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/fa/tools/",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/admin/",{redirect:"manual",signal:AbortSignal.timeout(20000)}),
 fetch(base+"/sitemap.xml",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/robots.txt",{signal:AbortSignal.timeout(20000)})
]);
const apiText=await api.text(),toolsText=await tools.text(),sitemapText=await sitemap.text(),robotsText=await robots.text();
if(api.status!==200||!apiText.includes('"cmsStatus":"connected"'))failures.push("published CMS unavailable");
if(css.status!==200||js.status!==200)failures.push("V2 CSS/JS unavailable");
if(tools.status!==200||!toolsText.includes("index-Ch3KjNPK")||!tools.headers.get("x-robots-tag")?.includes("noindex"))failures.push("legacy tools shell unavailable or indexable");
if(admin.status!==503||!admin.headers.get("x-robots-tag")?.includes("noindex"))failures.push("admin route is not safely blocked");
if(sitemap.status!==200||!sitemapText.includes("toeflhouse.pages.dev")||sitemapText.split("<loc>").length-1!==39)failures.push("sitemap must expose exactly 39 public URLs");
if(robots.status!==200||!robotsText.includes("Disallow: /"))failures.push("preview robots policy must block indexing");
console.log(JSON.stringify({base,routeCount:results.length,failures,api:api.status,css:css.status,js:js.status,tools:tools.status,toolsBody:toolsText.slice(0,160),toolsRobots:tools.headers.get("x-robots-tag"),rootIndex:rootIndex.status,faIndex:faIndex.status,bundle:bundle.status,admin:admin.status,sitemap:sitemap.status,robots:robots.status,results},null,2));
assert.deepEqual(failures,[]);
