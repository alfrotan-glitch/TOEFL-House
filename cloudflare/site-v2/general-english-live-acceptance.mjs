import assert from "node:assert/strict";
const base="https://the-toefl-house.pages.dev";
const cases=[
 {path:"/courses/general-english/",lang:"en",two:"2 instructors",month:"500 AFN",semester:"1,000 AFN",total:"4,500 AFN"},
 {path:"/fa/courses/general-english/",lang:"fa-AF",two:"۲ استاد",month:"۵۰۰ افغانی",semester:"۱٬۰۰۰ افغانی",total:"۴٬۵۰۰ افغانی"},
 {path:"/ps/courses/general-english/",lang:"ps-AF",two:"۲ استادان",month:"۵۰۰ افغانۍ",semester:"۱٬۰۰۰ افغانۍ",total:"۴٬۵۰۰ افغانۍ"}
];
const results=[];
for(const c of cases){
 const res=await fetch(base+c.path,{signal:AbortSignal.timeout(20000)});
 assert.equal(res.status,200,"General English public route "+c.path);
 assert.ok(!(res.headers.get("x-robots-tag")||"").includes("noindex"),"Public course should be indexable");
 const html=await res.text();
 assert.ok(html.includes('<html lang="'+c.lang+'"'),"wrong language on "+c.path);
 assert.equal((html.match(/id="general-english-details"/g)||[]).length,1,"Missing unique editorial section");
 assert.equal((html.match(/class="ge-stage"/g)||[]).length,5,"Wrong internal school level count");
 assert.equal((html.match(/class="ge-fee-table"/g)||[]).length,1,"Missing tuition table");
 assert.equal((html.match(/class="ge-faq"/g)||[]).length,3,"Missing practical questions");
 for(const level of ["Pre-Starter","Starter","Prep One","Prep Two","Prep Three"])
  assert.ok(html.includes(">"+level+"</h4>"),"Missing "+level+" on "+c.path);
 for(const field of [c.two,c.month,c.semester,c.total,"Oxford University Press","Got it! Level 1","Got it! Level 2","Got it! Level 3","Speaking"])
  assert.ok(html.includes(field),"Published content missing "+field+" on "+c.path);
 assert.match(html,/href="\/(?:fa\/|ps\/)?admissions\/\?program=general-english"/,"Placement/registration link");
 assert.match(html,/rel="canonical"/,"Canonical link missing");
 assert.match(html,/\?v=[a-f0-9]{12}/,"Versioned styles missing");
 assert.doesNotMatch(html,/class="ge-references"/,"Internal research bibliography must not appear in the student-facing course page");
 assert.match(html,/Oxford University Press/,"Publisher identity and textbook facts must remain accurate");
 assert.doesNotMatch(html,/\bPDF download\b|free Oxford books/i,"Don't market pirated textbook copies");
 const head=await fetch(base+c.path,{method:"HEAD",signal:AbortSignal.timeout(15000)});
 assert.equal(head.status,200);
 assert.equal((await head.text()).length,0);
 results.push({route:c.path,status:200,internalStages:5,tuition:"matched",resources:"Oxford verified",head:true});
}
for(const route of ["/courses/academic-english/","/fa/courses/toefl-preparation/","/ps/admissions/"]){
 const res=await fetch(base+route,{signal:AbortSignal.timeout(20000)});
 assert.equal(res.status,200,"Regression of another page "+route);
 const html=await res.text();
 assert.ok(!html.includes('id="general-english-details"'),"GE page content leaked onto "+route);
}
const cms=await fetch(base+"/api/content",{signal:AbortSignal.timeout(18000)});
assert.equal(cms.status,200);
assert.match(await cms.text(),/"cmsStatus":"connected"/);
console.log(JSON.stringify({result:"PASS",courses:results,cms:"connected",otherRoutesChecked:3},null,2));
