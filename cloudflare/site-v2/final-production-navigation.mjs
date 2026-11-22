import assert from "node:assert/strict";
const base=(process.env.TOEFL_QA_BASE||"https://toeflhouse.pages.dev").replace(/\/$/,"");
const production=base==="https://toeflhouse.pages.dev";
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
 const noindex=r.headers.get("x-robots-tag")?.includes("noindex")||false;
 if(production)assert.ok(!noindex,"Public route noindexed");else assert.ok(noindex,"Preview route indexable");
 results.push({path:item.path,status:r.status,linksChecked:item.paths.length});
}
const sitemap=await fetch(base+"/sitemap.xml");const xml=await sitemap.text();
const count=(xml.match(/<loc>/g)||[]).length;
assert.equal(sitemap.status,200);assert.equal(count,39);
const [cms,legacy,admin,adminPage]=await Promise.all([fetch(base+"/api/content"),fetch(base+"/fa/tools/"),fetch(base+"/api/admin/revisions"),fetch(base+"/admin/")]);
assert.equal(cms.status,200);assert.ok((await cms.text()).includes('"cmsStatus":"connected"'));
assert.equal(legacy.status,503);assert.match(legacy.headers.get("X-Robots-Tag")||"",/noindex/);assert.match(await legacy.text(),/temporarily unavailable/i);
assert.ok([401,403].includes(admin.status),"Anonymous admin API must be protected");
assert.ok(!(await admin.text()).includes('"revisions":['),"Protected admin revision list unexpectedly public");
assert.equal(adminPage.status,200);assert.match(adminPage.headers.get("X-Robots-Tag")||"",/noindex/);
console.log(JSON.stringify({status:"PASS",tested:results.length,links:results.reduce((n,x)=>n+x.linksChecked,0),sitemapPages:count,results,legacy:legacy.status,cms:cms.status,admin:admin.status,adminPage:adminPage.status},null,2));
