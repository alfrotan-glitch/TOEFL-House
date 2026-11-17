import assert from "node:assert/strict";
const base="https://badeebaf.the-toefl-house.pages.dev";
const cases=[
{route:"/fa/courses/toefl-preparation/",hrefs:["/courses/toefl-preparation/","/fa/courses/toefl-preparation/","/ps/courses/toefl-preparation/","/fa/#programs","/fa/#faq"],lang:"fa-AF"},
{route:"/ps/courses/special-speaking/",hrefs:["/courses/special-speaking/","/fa/courses/special-speaking/","/ps/courses/special-speaking/","/ps/#programs"],lang:"ps-AF"},
{route:"/admissions/",hrefs:["/admissions/","/fa/admissions/","/ps/admissions/","/#programs"],lang:"en"},
{route:"/fa/admissions/",hrefs:["/admissions/","/fa/admissions/","/ps/admissions/","/fa/#programs"],lang:"fa-AF"},
{route:"/ps/admissions/",hrefs:["/admissions/","/fa/admissions/","/ps/admissions/","/ps/#programs"],lang:"ps-AF"}
];
const result=[];
for (const entry of cases) {
 const r=await fetch(base+entry.route,{signal:AbortSignal.timeout(20000)});
 const html=await r.text();
 assert.equal(r.status,200,entry.route);
 for(const href of entry.hrefs)assert.ok(html.includes('href="'+href+'"'),entry.route+" missing "+href);
 assert.ok(html.includes('<html lang="'+entry.lang+'"'),entry.route+" lang");
 assert.match(r.headers.get("X-Robots-Tag")||"",/noindex/,entry.route+" preview must not index");
 result.push({path:entry.route,status:r.status,linksChecked:entry.hrefs.length,robots:r.headers.get("x-robots-tag")});
}
const [tools,api]=await Promise.all([fetch(base+"/fa/tools/"),fetch(base+"/api/content")]);
assert.equal(tools.status,200);assert.match(tools.headers.get("X-Robots-Tag")||"",/noindex/);
assert.equal(api.status,200);
const body=await api.text();assert.ok(body.includes('"cmsStatus":"connected"'));
console.log(JSON.stringify({passed:result.length,results:result,tools:tools.status,cms:api.status},null,2));
