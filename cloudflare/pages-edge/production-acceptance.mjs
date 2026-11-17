import assert from "node:assert/strict";
const base="https://the-toefl-house.pages.dev";
const pinned="https://0c14f299.the-toefl-house.pages.dev";
const expected=[
 "/","/fa/","/ps/",
 "/admissions/","/fa/admissions/","/ps/admissions/",
 "/courses/general-english/","/courses/toefl-preparation/",
 "/fa/courses/toefl-preparation/","/ps/courses/toefl-preparation/",
 "/guides/","/fa/guides/","/ps/guides/",
 "/api/content","/sitemap.xml","/robots.txt","/admin/",
 "/__th/health","/__th/engagement-v1.js","/__th/engagement-v1.css"
];
let failures=[];
const results=[];
for(const path of expected){
  try{
    const response=await fetch(base+path,{redirect:"manual",signal:AbortSignal.timeout(20000)});
    const body=await response.text();
    const isPrivate=path==="/admin/";
    const isAsset=path.startsWith("/__th/");
    const seo=path.endsWith("/courses/toefl-preparation/");
    const html=/text\/html/.test(response.headers.get("content-type")||"");
    const robots=response.headers.get("x-robots-tag")||"";
    const injected=body.includes("engagement-v1.js");
    const secureCsp=response.headers.get("content-security-policy")||"";
    results.push({path,status:response.status,bytes:body.length,injected,robots,
      title:body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]||null,
      cmsConnected:body.includes('"cmsStatus":"connected"')});
    if(response.status!==200)failures.push(path+" HTTP "+response.status);
    if(!isPrivate&&!isAsset&&robots.includes("noindex"))failures.push(path+" public incorrectly noindexed");
    if(isPrivate&&!robots.includes("noindex"))failures.push(path+" private indexable");
    if((path==="/"||path==="/fa/"||path==="/ps/"||path.includes("/admissions/"))&&!injected)failures.push(path+" missing tracking bootstrap");
    if((path==="/"||path==="/fa/"||path==="/ps/")&&!secureCsp.includes("toefl-house-conversions.alfrotan2.workers.dev"))failures.push(path+" collector omitted in CSP");
    if(path.startsWith("/courses/")||path.includes("/courses/")){
      if(injected)failures.push(path+" strict course CSP was weakened");
      if(seo&&!/(4 months|۴ ماه|څلور میاشت)/.test(body))failures.push(path+" incorrect TOEFL length");
    }
    if(path==="/api/content"&&!body.includes('"cmsStatus":"connected"'))failures.push("CMS is disconnected");
    if(path==="/sitemap.xml"&&(body.match(/<loc>/g)||[]).length<35)failures.push("sitemap shrunk");
    if(isAsset&&!robots.includes("noindex"))failures.push(path+" internal tracking asset indexable");
    if(response.headers.get("location")?.includes("0c14f299"))failures.push(path+" leaked pinned domain");
    if(html&&path!=="/admin/"){
      const original=await fetch(pinned+path,{signal:AbortSignal.timeout(20000)});
      const previous=await original.text();
      if(original.status!==response.status)failures.push(path+" original status mismatch");
      const oldTitle=previous.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]||null;
      const nowTitle=body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]||null;
      if(oldTitle!==nowTitle)failures.push(path+" changed original title");
    }
  }catch(e){failures.push(path+" "+String(e))}
}
console.log(JSON.stringify({checked:results.length,failed:failures.length,failures,results},null,2));
assert.deepEqual(failures,[]);
