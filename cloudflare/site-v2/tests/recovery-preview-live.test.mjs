import assert from "node:assert/strict";
const base=process.env.TOEFL_PREVIEW_URL||"https://recovery-final-preview-20261.toeflhouse.pages.dev";
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
  results.push({path,status:r.status,title:title.slice(0,90)});
  if(r.status!==200)failures.push(path+" HTTP "+r.status);
  if(!type.includes("text/html"))failures.push(path+" not HTML");
  if(!title)failures.push(path+" missing title");
  if(!r.headers.get("x-robots-tag")?.includes("noindex"))failures.push(path+" preview is indexable");
  if(/href=["'][^"']*\/tools\/?["']/i.test(body))failures.push(path+" exposes retired tools link");
  if(path==="/"&&!body.includes('href="data:image/'))failures.push("homepage favicon is not self-contained");
 }catch(e){failures.push(path+" "+String(e))}
}
const [api,css,js,admin,adminApi,campus,poster,tools,sitemap,robots]=await Promise.all([
 fetch(base+"/api/content",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/__th/v2/site.css",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/__th/v2/site.js",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/admin/",{redirect:"manual",signal:AbortSignal.timeout(20000)}),
 fetch(base+"/api/admin/content",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/assets/aistudio/FB_IMG_1793645643808_dad823ce.jpg",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/assets/aistudio/teacher-training-poster.webp",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/fa/tools/",{redirect:"manual",signal:AbortSignal.timeout(20000)}),
 fetch(base+"/sitemap.xml",{signal:AbortSignal.timeout(20000)}),
 fetch(base+"/robots.txt",{signal:AbortSignal.timeout(20000)})
]);
const apiText=await api.text(),adminText=await admin.text(),adminApiText=await adminApi.text(),sitemapText=await sitemap.text(),robotsText=await robots.text(),toolsText=await tools.text();
const cssText=await css.text(),jsText=await js.text();
if(api.status!==200||!apiText.includes('"cmsStatus":"connected"'))failures.push("published CMS unavailable");
if(css.status!==200||js.status!==200||!cssText.includes(".site-header")||!jsText.includes("mobile-menu")||cssText.startsWith("H4sIA")||jsText.startsWith("H4sIA"))failures.push("V2 CSS/JS unavailable or gzip payload was not decoded: "+JSON.stringify({cssStatus:css.status,jsStatus:js.status,cssLength:cssText.length,jsLength:jsText.length,cssStart:cssText.slice(0,80),jsStart:jsText.slice(0,80),hasCss:cssText.includes(".site-header"),hasJs:jsText.includes("mobile-menu")}));
if(admin.status!==200||!adminText.includes("TOEFL"))failures.push("CMS admin UI unavailable");
if(![401,403].includes(adminApi.status))failures.push("CMS API is not rejecting anonymous admin access");
if(campus.status!==200||!(campus.headers.get("content-type")||"").includes("image/jpeg"))failures.push("campus photo unavailable");
if(poster.status!==200||!(poster.headers.get("content-type")||"").includes("image/webp"))failures.push("teacher-training image unavailable");
if(tools.status!==503||!tools.headers.get("x-robots-tag")?.includes("noindex")||!toolsText.includes("temporarily unavailable"))failures.push("retired tools endpoint is not safely disabled");
if(sitemap.status!==200||!sitemapText.includes("toeflhouse.pages.dev")||sitemapText.split("<loc>").length-1!==39)failures.push("sitemap incomplete");
if(robots.status!==200||!robotsText.includes("Disallow: /"))failures.push("preview robots policy missing");
console.log(JSON.stringify({base,routeCount:results.length,failures,api:api.status,css:css.status,js:js.status,cssBytes:cssText.length,jsBytes:jsText.length,admin:admin.status,adminApi:adminApi.status,campus:campus.status,poster:poster.status,tools:tools.status,sitemap:sitemap.status,robots:robots.status,knownLimitations:["Student tools remain safely disabled; the public admissions assessment link remains available."],results},null,2));
assert.deepEqual(failures,[]);
