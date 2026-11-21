import assert from "node:assert/strict";
const base="https://toeflhouse.pages.dev";
const cases=[
{path:"/fa/courses/toefl-preparation/",paths:["/courses/toefl-preparation/","/fa/courses/toefl-preparation/","/ps/courses/toefl-preparation/","/fa/#programs"],lang:"fa-AF"},
{path:"/ps/courses/special-speaking/",paths:["/courses/special-speaking/","/fa/courses/special-speaking/","/ps/courses/special-speaking/","/ps/#programs"],lang:"ps-AF"},
{path:"/admissions/",paths:["/admissions/","/fa/admissions/","/ps/admissions/","/#programs"],lang:"en"},
{path:"/fa/admissions/",paths:["/admissions/","/fa/admissions/","/ps/admissions/","/fa/#programs"],lang:"fa-AF"},
{path:"/ps/admissions/",paths:["/admissions/","/fa/admissions/","/ps/admissions/","/ps/#programs"],lang:"ps-AF"}
];
const results=[];
for(const item of cases){
 const r=await fetch(base+item.path,{signal:AbortSignal.timeout(20000)}); const s=await r.text();
 assert.equal(r.status,200,item.path);assert.ok(s.includes('<html lang="'+item.lang+'"'),item.path);
 for(const href of item.paths)assert.ok(s.includes('href="'+href+'"'),item.path+" missing "+href);
 assert.ok(!r.headers.get("x-robots-tag")?.includes("noindex"),"Public route noindexed");
 results.push({path:item.path,status:r.status,linksChecked:item.paths.length});
}
const sitemap=await fetch(base+"/sitemap.xml");const xml=await sitemap.text();
const count=(xml.match(/<loc>/g)||[]).length;
assert.equal(sitemap.status,200);assert.equal(count,39);
const [cms,legacy,admin]=await Promise.all([fetch(base+"/api/content"),fetch(base+"/fa/tools/"),fetch(base+"/api/admin/revisions")]);
assert.equal(cms.status,200);assert.ok((await cms.text()).includes('"cmsStatus":"connected"'));
assert.equal(legacy.status,200);assert.match(legacy.headers.get("X-Robots-Tag")||"",/noindex/);
const adminBody=await admin.text();assert.ok(!adminBody.includes('"revisions":['),"Protected admin revision list unexpectedly public");
console.log(JSON.stringify({status:"PASS",tested:results.length,links:results.reduce((n,x)=>n+x.linksChecked,0),sitemapPages:count,results,legacy:legacy.status,cms:cms.status,admin:admin.status},null,2));
