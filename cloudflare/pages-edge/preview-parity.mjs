import assert from "node:assert/strict";
const preview="https://d0b10017.the-toefl-house.pages.dev";
const current="https://the-toefl-house.pages.dev";
const pages=[
 "/","/fa/","/ps/",
 "/admissions/","/fa/admissions/","/ps/admissions/",
 "/courses/general-english/","/courses/toefl-preparation/",
 "/fa/courses/toefl-preparation/","/ps/courses/toefl-preparation/",
 "/guides/","/fa/guides/","/ps/guides/",
 "/api/content","/sitemap.xml","/robots.txt","/admin/",
 "/assets/index-Ch3KjNPK.js","/__th/engagement-v1.js","/__th/engagement-v1.css",
 "/__th/health"
];
let failures=[],summary=[];
for(const path of pages){
 try{
   const [a,b]=await Promise.all([
     fetch(preview+path,{redirect:"manual",signal:AbortSignal.timeout(20000)}),
     path.startsWith("/__th/")?Promise.resolve(null):fetch(current+path,{redirect:"manual",signal:AbortSignal.timeout(20000)})
   ]);
   const text=await a.text(),old=b?await b.text():"";
   const mime=a.headers.get("content-type")||"";
   const injected=text.includes("engagement-v1.js");
   const csp=a.headers.get("content-security-policy")||"";
   const item={path,status:a.status,currentStatus:b?.status||null,bytes:text.length,originalBytes:old.length,
     title:text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||null,
     language:text.match(/<html[^>]*lang=["']([^"']+)/i)?.[1]||null,
     injected,robots:a.headers.get("x-robots-tag"),
     cspPrefix:csp.slice(0,60)};
   summary.push(item);
   if(a.status!==200)failures.push(path+" status "+a.status);
   if(b&&a.status!==b.status)failures.push(path+" status changed "+b.status+"->"+a.status);
   if(!/noindex/i.test(a.headers.get("x-robots-tag")||""))failures.push(path+" preview not noindex");
   if(b&&/text\/html/i.test(mime)){
     const oldTitle=old.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
     if(oldTitle!==item.title)failures.push(path+" title changed");
     if(!text.includes("The TOEFL House")&&!text.includes("خانه موفقیت"))failures.push(path+" brand missing");
     if(csp.includes("default-src 'none'")){
       if(injected)failures.push(path+" strict CSP unexpectedly injected");
     } else if(!path.startsWith("/admin")){
       if(!injected)failures.push(path+" enhancement not injected");
     }
   }
   if(a.headers.get("location")?.includes("0c14f299"))failures.push(path+" leaked upstream redirect");
   if(path==="/api/content"&&!text.includes('"cmsStatus":"connected"'))failures.push(path+" CMS not connected");
   if(path==="/sitemap.xml"&&(text.match(/<loc>/g)||[]).length<35)failures.push(path+" incomplete sitemap");
   if(path.endsWith("/courses/toefl-preparation/")&&!/(?:4 months|۴ ماه|څلور میاشت)/.test(text))failures.push(path+" four-month TOEFL not visible");
 }catch(e){failures.push(path+" fetch failed "+String(e))}
}
for(const path of ["/api/enquiry","/api/admin/login"]){
 try{
  const r=await fetch(preview+path,{method:"POST",headers:{"Content-Type":"application/json"},body:'{"synthetic":true}',redirect:"manual",signal:AbortSignal.timeout(20000)});
  summary.push({path,method:"POST",status:r.status});
  if(r.status!==403)failures.push(path+" preview write NOT refused, status="+r.status);
 }catch(e){failures.push(path+" preview POST fetch error "+String(e))}
}
console.log(JSON.stringify({preview,checked:summary.length,failures,summary},null,2));
assert.deepEqual(failures,[],"Preview parity failures");
