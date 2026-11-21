import assert from "node:assert/strict";
const base="https://toeflhouse.pages.dev";
const sitemap=await fetch(base+"/sitemap.xml",{signal:AbortSignal.timeout(20000)});
assert.equal(sitemap.status,200);
const xml=await sitemap.text();
const urls=[...xml.matchAll(/<loc>(https:\/\/toeflhouse\.pages\.dev[^<]+)<\/loc>/g)].map(x=>x[1]);
const paths=[...new Set(urls.map(s=>new URL(s).pathname))];
const ids=["general-english","academic-english","toefl-preparation","special-speaking","professional-writing","teacher-training","online-individual-zoom"];
const guideIds=["english-courses-kabul","toefl-ibt-2026","speaking-practice"];
for(const lang of ["","fa/","ps/"]){expectedPaths.push("/"+lang+"guides/");for(const id of guideIds)expectedPaths.push("/"+lang+"guides/"+id+"/");}
const expectedPaths=["/","/fa/","/ps/","/admissions/","/fa/admissions/","/ps/admissions/"];
for(const lang of ["","fa/","ps/"]){for(const id of ids)expectedPaths.push("/"+lang+"courses/"+id+"/");}
const check=new Set(paths), failures=[],rows=[];
for(const path of expectedPaths){if(!check.has(path))failures.push("missing sitemap entry "+path);}
for(const path of paths){
 try{
  const response=await fetch(base+path,{signal:AbortSignal.timeout(20000),redirect:"manual"});
  const body=await response.text();
  const contentType=response.headers.get("content-type")||"";
  const title=body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||"";
  const canonical=body.match(/<link rel="canonical" href="([^"]+)"/i)?.[1]||null;
  const lang=body.match(/<html[^>]*lang="([^"]+)"/i)?.[1]||"";
  const isV2=(path==="/"||path==="/fa/"||path==="/ps/"||path.includes("/courses/")||path.includes("/admissions/"));
  const row={path,status:response.status,lang,title:title.slice(0,100),canonical,robots:response.headers.get("X-Robots-Tag"),v2:isV2,h1:(body.match(/<h1(?:\s|>)/gi)||[]).length};
  rows.push(row);
  if(response.status!==200)failures.push("HTTP "+response.status+" "+path);
  if(!/text\/html/i.test(contentType))failures.push("Not HTML "+path);
  if(response.headers.get("X-Robots-Tag")?.includes("noindex"))failures.push("NOINDEX PUBLIC "+path);
  if(!title)failures.push("No title "+path);
  if(isV2){
   if(!body.includes("/__th/v2/site.css"))failures.push("V2 style not loaded "+path);
   if(row.h1!==1)failures.push("H1 count "+row.h1+" "+path);
   if(!canonical?.endsWith(path))failures.push("Wrong canonical "+path+" "+canonical);
  }
  if(path.endsWith("/courses/toefl-preparation/")&&!/4 months|۴ ماه|څلور میاشتې/.test(body))failures.push("TOEFL 4 months missing "+path);
 }catch(e){failures.push(path+" "+String(e))}
}
const [api,admin,tools,css,js,tracker]=await Promise.all([
 fetch(base+"/api/content",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/admin/",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/fa/tools/",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/__th/v2/site.css",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/__th/v2/site.js",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/__th/engagement-v1.js",{signal:AbortSignal.timeout(20000)})
]);
const cms=await api.text(),toolsHTML=await tools.text();
if(!cms.includes('"cmsStatus":"connected"'))failures.push("CMS disconnected");
if(!admin.headers.get("x-robots-tag")?.includes("noindex"))failures.push("Admin route indexable");
if(!tools.headers.get("x-robots-tag")?.includes("noindex")||!toolsHTML.includes("index-Ch3KjNPK"))failures.push("Original tools route broken");
if(css.status!==200||js.status!==200||tracker.status!==200)failures.push("CSS, JS or tracker missing");
const run={date:new Date().toISOString(),sitemapUrls:urls.length,checked:rows.length,routeErrors:failures,versions:{cmsAPI:api.status,admin:admin.status,tools:tools.status,css:css.status,js:js.status,tracker:tracker.status},rows};
console.log(JSON.stringify(run,null,2));
assert.deepEqual(failures,[]);
assert.ok(paths.length>=39,"Public SEO sitemap shrunk");
