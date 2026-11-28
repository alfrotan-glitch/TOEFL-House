// Public V2 routes return a Response when handled and null to preserve legacy
// edge routing. The build composes this module at the explicit edge hook.
async function v2Route(request,env,url){
 if(noindex(url.hostname)&&!["GET","HEAD","OPTIONS"].includes(request.method))return new Response("Preview is read-only",{status:403,headers:{"Cache-Control":"no-store","X-Robots-Tag":"noindex"}});
 if(url.pathname==="/api/content"&&["GET","HEAD"].includes(request.method))return v2PublicContent(request,env);
 const homeLocale=url.pathname==="/"?"en":url.pathname==="/fa/"?"fa":url.pathname==="/ps/"?"ps":null;
 if(homeLocale){
  const page=await v2Home(request,env,homeLocale);
  if(page)return page;
 }
 const parts=url.pathname.split("/").filter(Boolean);
 const routeLocale=["fa","ps"].includes(parts[0])?parts.shift():"en";
 if(parts[0]==="courses"&&parts.length===2&&V2_PUBLIC_COURSES.includes(parts[1])){
  const page=await v2Detail(request,env,routeLocale,"course",parts[1]);
  if(page)return page;
 }
 if(parts[0]==="guides"&&(parts.length===1||(parts.length===2&&V2_GUIDE_SLUGS.includes(parts[1])))){
  const page=await v2Guides(request,env,routeLocale,parts[1]||null);
  if(page)return page;
 }
 if(parts[0]==="admissions"&&parts.length===1){
  const page=await v2Detail(request,env,routeLocale,"admissions",null);
  if(page)return page;
 }
 if(url.pathname==="/__th/v2/brand.webp"){
  const image=staticResponse(request,Uint8Array.from(atob(V2_LOGO_DATA),c=>c.charCodeAt(0)),"image/webp",V2_LOGO_REV);
  if(!noindex(url.hostname))image.headers.delete("X-Robots-Tag");
  return image;
 }
 if(url.pathname==="/__th/v2/site.css")return staticResponse(request,V2_CSS,"text/css; charset=utf-8",V2_REV);
 if(url.pathname==="/__th/v2/site.js")return staticResponse(request,V2_JS,"application/javascript; charset=utf-8",V2_REV);
 if(["/tools","/tools/","/fa/tools","/fa/tools/","/ps/tools","/ps/tools/"].includes(url.pathname)&&!["GET","HEAD"].includes(request.method))return new Response("Method not allowed",{status:405,headers:{"Allow":"GET, HEAD"}});
 return null;
}
