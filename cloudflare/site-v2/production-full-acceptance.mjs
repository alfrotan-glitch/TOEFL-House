import assert from "node:assert/strict";
const base=(process.env.TOEFL_QA_BASE||"https://toeflhouse.pages.dev").replace(/\/$/,"");
const production=base==="https://toeflhouse.pages.dev";
const sitemap=await fetch(base+"/sitemap.xml",{signal:AbortSignal.timeout(20000)});
assert.equal(sitemap.status,200);
const xml=await sitemap.text();
const urls=[...xml.matchAll(/<loc>(https:\/\/toeflhouse\.pages\.dev[^<]+)<\/loc>/g)].map(x=>x[1]);
const paths=[...new Set(urls.map(s=>new URL(s).pathname))];
const ids=["general-english","academic-english","toefl-preparation","special-speaking","professional-writing","teacher-training","online-individual-zoom"];
const guideIds=["english-courses-kabul","toefl-ibt-2026","speaking-practice"];
const expectedPaths=["/","/fa/","/ps/","/admissions/","/fa/admissions/","/ps/admissions/"];
for(const lang of ["","fa/","ps/"]){for(const id of ids)expectedPaths.push("/"+lang+"courses/"+id+"/");}
for(const lang of ["","fa/","ps/"]){expectedPaths.push("/"+lang+"guides/");for(const id of guideIds)expectedPaths.push("/"+lang+"guides/"+id+"/");}
const check=new Set(paths),failures=[],rows=[];
for(const path of expectedPaths)if(!check.has(path))failures.push("missing sitemap entry "+path);
for(const path of paths){
 try{
  const response=await fetch(base+path,{signal:AbortSignal.timeout(20000),redirect:"manual"});
  const body=await response.text(),contentType=response.headers.get("content-type")||"";
  const title=body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||"";
  const canonical=body.match(/<link rel="canonical" href="([^"]+)"/i)?.[1]||null;
  const lang=body.match(/<html[^>]*lang="([^"]+)"/i)?.[1]||"";
  const isV2=(path==="/"||path==="/fa/"||path==="/ps/"||path.includes("/courses/")||path.includes("/admissions/")||path.includes("/guides/"));
  const noindex=response.headers.get("X-Robots-Tag")?.includes("noindex")||false;
  rows.push({path,status:response.status,lang,title:title.slice(0,100),canonical,robots:response.headers.get("X-Robots-Tag"),h1:(body.match(/<h1(?:\s|>)/gi)||[]).length});
  if(response.status!==200)failures.push("HTTP "+response.status+" "+path);
  if(!/text\/html/i.test(contentType))failures.push("Not HTML "+path);
  if(production&&noindex)failures.push("NOINDEX PUBLIC "+path);
  if(!production&&!noindex)failures.push("Preview route indexable "+path);
  if(!title)failures.push("No title "+path);
  if(isV2){
   if(!body.includes("/__th/v2/site.css"))failures.push("V2 style not loaded "+path);
   if((body.match(/<h1(?:\s|>)/gi)||[]).length!==1)failures.push("H1 count "+path);
   if(!canonical?.startsWith("https://toeflhouse.pages.dev")||!canonical.endsWith(path))failures.push("Wrong canonical "+path+" "+canonical);
   if(/href=["'][^"']*\/(?:fa\/|ps\/)?tools\/?["']/i.test(body))failures.push("Retired tools link exposed "+path);
   if(body.includes("the-toefl-house.pages.dev"))failures.push("Retired Pages origin leaked into "+path);
  }
  if(path.endsWith("/courses/toefl-preparation/")&&!/4 months|۴ ماه|څلور میاشتې/.test(body))failures.push("TOEFL 4 months missing "+path);
 }catch(e){failures.push(path+" "+String(e))}
}
const [api,admin,adminApi,tools,css,js,tracker,campus,poster,robots]=await Promise.all([
 fetch(base+"/api/content",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/admin/",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/api/admin/content",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/fa/tools/",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/__th/v2/site.css",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/__th/v2/site.js",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/__th/engagement-v1.js",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/assets/aistudio/FB_IMG_1793645643808_dad823ce.jpg",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/assets/aistudio/teacher-training-poster.webp",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/robots.txt",{signal:AbortSignal.timeout(20000)})
]);
const cms=await api.text(),toolsText=await tools.text(),robotsText=await robots.text();
if(api.status!==200||!cms.includes('"cmsStatus":"connected"'))failures.push("CMS disconnected");
if(admin.status!==200||!admin.headers.get("x-robots-tag")?.includes("noindex"))failures.push("CMS admin unavailable or indexable");
if(![401,403].includes(adminApi.status))failures.push("Anonymous admin API is not protected");
if(tools.status!==503||!tools.headers.get("x-robots-tag")?.includes("noindex")||!toolsText.includes("temporarily unavailable"))failures.push("Retired tools route is not safely disabled");
if(css.status!==200||js.status!==200||tracker.status!==200)failures.push("CSS, JS or engagement script missing");
if(campus.status!==200||!(campus.headers.get("content-type")||"").includes("image/jpeg"))failures.push("Embedded campus photo missing");
if(poster.status!==200||!(poster.headers.get("content-type")||"").includes("image/webp"))failures.push("Embedded teacher-training image missing");
if(robots.status!==200)failures.push("robots.txt unavailable");
else if(production){if(!robotsText.includes("Disallow: /admin/")||/^Disallow: \/$/m.test(robotsText))failures.push("Production robots policy incorrect");}
else if(!/^Disallow: \/$/m.test(robotsText))failures.push("Preview must disallow indexing");
const result={date:new Date().toISOString(),base,sitemapUrls:urls.length,checked:rows.length,failures,versions:{cmsAPI:api.status,admin:admin.status,adminAPI:adminApi.status,tools:tools.status,css:css.status,js:js.status,tracker:tracker.status,campus:campus.status,poster:poster.status,robots:robots.status},rows};
console.log(JSON.stringify(result,null,2));
assert.deepEqual(failures,[]);
assert.ok(paths.length>=39,"Public SEO sitemap shrunk");
