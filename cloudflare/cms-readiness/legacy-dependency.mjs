import assert from "node:assert/strict";
/**
 * The public V2 shell still proxies some pre-existing CMS/auth features to
 * immutable Pages deployments. Their removal would silently break admin,
 * timetable and student toolkit even if the modern homepage stays visible.
 * Strictly read-only. Never alters deployment routing.
 */
const deployments=[
 {name:"legacy-cms-auth-nov05",url:"https://68381d7a.the-toefl-house.pages.dev"},
 {name:"marketing-overlay-nov09",url:"https://0c14f299.the-toefl-house.pages.dev"}
];
const primary="https://the-toefl-house.pages.dev";
const events=[],errors=[];
async function request(url,label){
 const response=await fetch(url,{method:"GET",redirect:"manual",signal:AbortSignal.timeout(20000)});
 const body=await response.text();
 events.push({label,status:response.status,bytes:Buffer.byteLength(body),
  type:(response.headers.get("content-type")||"").split(";")[0],
  destination:response.headers.get("location")?"redirect present":null});
 return {response,body};
}
for(const deployment of deployments){
 try{
  const home=await request(deployment.url+"/",deployment.name+" homepage");
  if(home.response.status!==200||!/<html/i.test(home.body))
   errors.push(deployment.name+" HTML unavailable");
  const api=await request(deployment.url+"/api/content",deployment.name+" published CMS");
  if(api.response.status!==200||!api.body.includes('"cmsStatus":"connected"'))
   errors.push(deployment.name+" CMS unavailable");
  else{
   let json;try{json=JSON.parse(api.body)}catch{errors.push(deployment.name+" CMS invalid JSON")}
   if(json&&(!json.locales?.en?.programs?.length||!json.locales?.ps?.programs?.length))
    errors.push(deployment.name+" CMS missing translated programs");
  }
 }catch(e){errors.push(deployment.name+" "+String(e))}
}
for(const [path,expected] of [
 ["/fa/tools/","index-Ch3KjNPK"],
 ["/ps/tools/","index-Ch3KjNPK"],
 ["/api/content",'"cmsStatus":"connected"']
]){
 try{
  const r=await request(primary+path,"canonical "+path);
  if(r.response.status!==200||!r.body.includes(expected))
   errors.push("Canonical preserved route failed "+path);
 }catch(e){errors.push("Canonical "+path+" "+String(e))}
}
console.log(JSON.stringify({tested:events.length,dependencyWarnings:errors,results:events},null,2));
assert.deepEqual(errors,[],"Legacy deployment dependency broken");
