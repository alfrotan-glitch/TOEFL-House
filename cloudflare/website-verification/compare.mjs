const hosts=["https://the-toefl-house.pages.dev","https://0c14f299.the-toefl-house.pages.dev"];
const routes=["/","/fa/","/ps/","/api/content","/admissions/","/courses/toefl-preparation/","/admin/"];
for(const base of hosts){
  for(const route of routes){
    try{
      const r=await fetch(base+route,{redirect:"manual",signal:AbortSignal.timeout(18000)});
      const text=await r.text();
      console.log(JSON.stringify({host:base,route,status:r.status,location:r.headers.get("location"),mime:r.headers.get("content-type"),robots:r.headers.get("x-robots-tag"),csp:(r.headers.get("content-security-policy")||"").slice(0,240),len:text.length,title:text.match(/<title>([^<]*)<\/title>/i)?.[1]||null,metaRobots:[...text.matchAll(/<meta[^>]+name=["']robots["'][^>]*>/gi)].slice(0,2).map(x=>x[0]),cmsConnected:text.includes('"cmsStatus":"connected"')}));
    }catch(e){console.log(JSON.stringify({host:base,route,error:String(e)}))}
  }
}