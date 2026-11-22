import assert from "node:assert/strict";
/**
 * Read-only proof that the canonical site no longer depends on the deleted
 * Pages origin. The CMS service is a first-party Worker bound to the existing
 * production D1 database; private routes remain authenticated.
 */
const base=(process.env.TOEFL_QA_BASE||"https://toeflhouse.pages.dev").replace(/\/$/,"");
const production=base==="https://toeflhouse.pages.dev";
const results=[],errors=[];
async function read(path){
 const response=await fetch(base+path,{method:"GET",redirect:"manual",signal:AbortSignal.timeout(20000)});
 const body=await response.text();
 results.push({path,status:response.status,bytes:Buffer.byteLength(body),type:(response.headers.get("content-type")||"").split(";")[0],location:response.headers.get("location")||null});
 return {response,body};
}
const home=await read("/");
if(home.response.status!==200||!home.body.includes("The TOEFL House"))errors.push("Canonical homepage unavailable");
if(home.body.includes("the-toefl-house.pages.dev"))errors.push("Retired Pages origin leaked into homepage");
if(/href=["'][^"']*\/(?:fa\/|ps\/)?tools\/?["']/i.test(home.body))errors.push("Public homepage links to the disabled tools route");
const [fa,ps,admin,pub,privateApi,campus,poster,tools,missing,robots,sitemap]=await Promise.all([
 read("/fa/"),read("/ps/"),read("/admin/"),read("/api/content"),read("/api/admin/revisions"),
 read("/assets/aistudio/FB_IMG_1793645643808_dad823ce.jpg"),read("/assets/aistudio/teacher-training-poster.webp"),
 read("/fa/tools/"),read("/retired-origin-check/"),read("/robots.txt"),read("/sitemap.xml")
]);
if(fa.response.status!==200||ps.response.status!==200)errors.push("A localized homepage is unavailable");
if(admin.response.status!==200||!admin.response.headers.get("x-robots-tag")?.includes("noindex"))errors.push("Authenticated CMS sign-in page unavailable or indexable");
if(!admin.response.headers.get("content-security-policy")?.includes("frame-ancestors"))errors.push("CMS sign-in page lacks frame protection");
if(pub.response.status!==200||!pub.body.includes('"cmsStatus":"connected"'))errors.push("Production public CMS disconnected");
if(![401,403].includes(privateApi.response.status)||privateApi.body.includes('"revisions":['))errors.push("Anonymous access to protected revisions is not blocked");
if(campus.response.status!==200||!(campus.response.headers.get("content-type")||"").includes("image/jpeg"))errors.push("Embedded campus photo unavailable");
if(poster.response.status!==200||!(poster.response.headers.get("content-type")||"").includes("image/webp"))errors.push("Embedded teacher-training poster unavailable");
if(tools.response.status!==503||!tools.response.headers.get("x-robots-tag")?.includes("noindex")||!tools.body.includes("temporarily unavailable"))errors.push("Disabled tools endpoint is not safely isolated");
if(missing.response.status!==404||missing.response.headers.get("location"))errors.push("Unknown route is still redirected/proxied");
if(robots.response.status!==200)errors.push("robots.txt unavailable");
else if(production){if(!robots.body.includes("Disallow: /admin/")||/^Disallow: \/$/m.test(robots.body))errors.push("Production robots policy incorrect");}
else if(!/^Disallow: \/$/m.test(robots.body))errors.push("Preview robots policy incorrect");
if(sitemap.response.status!==200||(sitemap.body.match(/<loc>/g)||[]).length!==39)errors.push("Canonical sitemap is incomplete");
console.log(JSON.stringify({base,mode:production?"production":"preview",tested:results.length,errors,results},null,2));
assert.deepEqual(errors,[],"Standalone canonical routing or CMS security check failed");
