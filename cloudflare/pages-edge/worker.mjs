// The TOEFL House — non-destructive edge upgrade, 18 Nov 2026.
// Proxy the immutable approved Nov 9 deployment and add only lightweight
// anonymous aggregate CTA click tracking on permitted public HTML pages.
// Do not introduce a second CMS or change staff auth/business API semantics.
const UPSTREAM="https://0c14f299.the-toefl-house.pages.dev";
const CANONICAL="the-toefl-house.pages.dev";
const COLLECTOR="https://toefl-house-conversions.alfrotan2.workers.dev";
const JS_PATH="/__th/engagement-v1.js";
const CSS_PATH="/__th/engagement-v1.css";
const TOOLS_BRAND_PATH="/__th/tools-brand-v1.js";
const TOOLS_BRAND_JS="(function(){\n\"use strict\";\nvar p=location.pathname;\nif(![\"/tools\",\"/tools/\",\"/fa/tools\",\"/fa/tools/\",\"/ps/tools\",\"/ps/tools/\"].includes(p))return;\nvar former=\"خانه موفقیت\",current=\"تافل هوس\";\nfunction cleanText(node){\n if(!node||node.nodeType!==3||!node.nodeValue||!node.nodeValue.includes(former))return;\n var parent=node.parentElement;\n if(parent&&parent.closest(\"script,style,noscript,textarea,option,[contenteditable]\"))return;\n node.nodeValue=node.nodeValue.split(former).join(current);\n}\nfunction scan(node){\n if(!node)return;\n if(node.nodeType===3){cleanText(node);return;}\n if(node.nodeType!==1)return;\n if(node.matches(\"script,style,noscript,textarea,option,[contenteditable]\"))return;\n var walk=document.createTreeWalker(node,NodeFilter.SHOW_TEXT),item;\n while((item=walk.nextNode()))cleanText(item);\n}\nfunction fixTitle(){\n if(document.title.includes(former))document.title=document.title.split(former).join(current);\n}\nfunction start(){\n fixTitle();scan(document.body);\n var watcher=new MutationObserver(function(changes){\n  for(var change of changes){\n   if(change.type===\"characterData\")cleanText(change.target);\n   if(change.type===\"childList\")for(var node of change.addedNodes)scan(node);\n  }\n  fixTitle();\n });\n watcher.observe(document.body,{subtree:true,childList:true,characterData:true});\n}\nif(document.readyState===\"loading\")document.addEventListener(\"DOMContentLoaded\",start,{once:true});\nelse start();\n})();";
const CLIENT_JS="(function(){\n\"use strict\";\nif(location.hostname!==\"the-toefl-house.pages.dev\") return;\nvar endpoint=\"https://toefl-house-conversions.alfrotan2.workers.dev/e\";\nfunction clean(v,d,max){return /^[a-z0-9][a-z0-9_-]*$/.test(v||\"\")&&v.length<=max?v:d;}\nvar params=new URLSearchParams(location.search);\nvar refer=\"\";\ntry{refer=new URL(document.referrer).hostname;}catch(_){}\nvar fallback=/facebook\\.com$/.test(refer)?\"facebook\":/instagram\\.com$/.test(refer)?\"instagram\":/(^|\\.)google\\./.test(refer)?\"google\":\"website\";\nvar source=clean(params.get(\"utm_source\")||params.get(\"s\"),fallback,32);\nvar campaign=clean(params.get(\"utm_campaign\")||params.get(\"c\"),\"organic_site\",48);\ntry{\n  if(params.has(\"utm_source\")||params.has(\"utm_campaign\")||params.has(\"s\")||params.has(\"c\")){\n    sessionStorage.setItem(\"th_campaign\",JSON.stringify({source:source,campaign:campaign}));\n  }else{\n    var old=JSON.parse(sessionStorage.getItem(\"th_campaign\")||\"null\");\n    if(old){source=clean(old.source,fallback,32);campaign=clean(old.campaign,\"organic_site\",48);}\n  }\n}catch(_){}\nfunction course(){\n  var match=location.pathname.match(/\\/courses\\/([a-z0-9-]+)\\/?$/);\n  var selected=document.querySelector(\"#v2-program\");\n  var fromForm=selected&&selected.value;\n  var fromQuery=new URLSearchParams(location.search).get(\"program\");\n  return clean((match&&match[1])||fromForm||fromQuery,\"all\",48);\n}\nvar recent={};\nfunction record(action,identity){\n  var now=Date.now(),key=action+\":\"+identity;\n  if(now-(recent[key]||0)<1100)return;\n  recent[key]=now;\n  var body=JSON.stringify({action:action,source:source,campaign:campaign,course:course()});\n  try{\n    if(navigator.sendBeacon){\n      if(navigator.sendBeacon(endpoint,new Blob([body],{type:\"text/plain\"})))return;\n    }\n  }catch(_){}\n  try{fetch(endpoint,{method:\"POST\",mode:\"cors\",keepalive:true,headers:{\"Content-Type\":\"text/plain\"},body:body}).catch(function(){});}catch(_){}\n}\ndocument.addEventListener(\"click\",function(event){\n  var el=event.target instanceof Element?event.target.closest(\"a[href]\"):null;\n  if(!el)return;\n  var href=el.getAttribute(\"href\")||\"\";\n  if(!href)return;\n  if(/^tel:/i.test(href)){record(\"phone\",href);return;}\n  try{\n    var url=new URL(href,location.href);\n    if((/^(?:www\\.)?wa\\.me$/.test(url.hostname)||url.hostname===\"api.whatsapp.com\")&&url.protocol===\"https:\"){\n      record(\"whatsapp\",url.pathname);return;\n    }\n    if(url.origin===location.origin){\n      var p=url.pathname;\n      if(p===\"/go/whatsapp\"){record(\"whatsapp\",p);return;}\n      if(p.endsWith(\"/admissions/\")||p.endsWith(\"/admissions\")||[\"#start\",\"#advisor\"].includes(url.hash)){\n        // Switching languages inside admissions is navigation, not a fresh lead.\n        if((p.endsWith(\"/admissions/\")||p.endsWith(\"/admissions\"))&&(location.pathname.endsWith(\"/admissions/\")||location.pathname.endsWith(\"/admissions\")))return;\n        record(\"admissions\",p+url.hash);\n      }\n    }\n  }catch(_){}\n},true);\ndocument.addEventListener(\"submit\",function(event){\n  var form=event.target;\n  if(form&&form.tagName===\"FORM\"&&typeof form.checkValidity===\"function\"&&form.checkValidity()){\n    record(\"admissions\",\"form:\"+location.pathname);\n  }\n},true);\n})();";
const STYLE=":where(a,button,input,select,textarea,[role=\"button\"]):focus-visible{outline:3px solid #D51F3E;outline-offset:3px}\n:target{scroll-margin-top:6.5rem}\n@media(prefers-reduced-motion:reduce){html:focus-within{scroll-behavior:auto!important}*,*:before,*:after{scroll-behavior:auto!important;animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}\n";

const GUIDE_A11Y_STYLE='a[href="#content"][style*="-9999px"]{left:0!important;top:0!important;width:1px!important;height:1px!important;overflow:hidden!important;clip-path:inset(50%)!important}a[href="#content"][style*="-9999px"]:focus{position:fixed!important;left:16px!important;top:16px!important;width:auto!important;height:auto!important;clip-path:none!important;overflow:visible!important;z-index:9999!important;padding:12px 18px!important;background:#fff!important;color:#112c35!important}';
function noindex(host){return host!==CANONICAL;}
function staticResponse(request,content,type){
  if(!["GET","HEAD"].includes(request.method))return new Response("Method not allowed",{status:405,headers:{Allow:"GET, HEAD"}});
  return new Response(request.method==="HEAD"?null:content,{status:200,headers:{
    "Content-Type":type,
    "Cache-Control":"public, max-age=3600, immutable",
    "X-Content-Type-Options":"nosniff",
    "Cross-Origin-Resource-Policy":"same-origin",
    "X-Robots-Tag":"noindex, nofollow, noarchive"
  }});
}
function adjustCsp(csp){
  if(!csp)return csp;
  if(/(?:^|;)\s*connect-src\s+/i.test(csp)){
    return csp.replace(/(?:^|;)\s*connect-src\s+([^;]+)/i,function(all,list){
      return all.replace(list,list+" "+COLLECTOR);
    });
  }
  return csp+"; connect-src 'self' "+COLLECTOR;
}
function eligible(path,csp){
  if(path.startsWith("/admin")||path.startsWith("/api")||path.startsWith("/owner"))return false;
  if(path.startsWith("/__th/"))return false;
  if(/(?:^|;)\s*default-src\s+'none'/i.test(csp||""))return false;
  return true;
}
function rewriteLocation(value){
  if(!value)return value;
  try{
    const dest=new URL(value);
    if(dest.origin===UPSTREAM)return "https://"+CANONICAL+dest.pathname+dest.search+dest.hash;
  }catch(_){}
  return value;
}
async function passThrough(request){
  const incoming=new URL(request.url);
  const target=new URL(incoming.pathname+incoming.search,UPSTREAM);
  const headers=new Headers(request.headers);
  headers.delete("Host");
  const init={method:request.method,headers,redirect:"manual"};
  if(!["GET","HEAD"].includes(request.method)&&request.body){init.body=request.body;init.duplex="half";}
  const original=await fetch(new Request(target,init));
  const outHeaders=new Headers(original.headers);
  if(outHeaders.has("Location"))outHeaders.set("Location",rewriteLocation(outHeaders.get("Location")));
  if(noindex(incoming.hostname))outHeaders.set("X-Robots-Tag","noindex, nofollow, noarchive");
  else if(!incoming.pathname.startsWith("/admin")&&!incoming.pathname.startsWith("/owner")&&!incoming.pathname.startsWith("/api/admin")){
    // The immutable deployment is correctly noindexed for its own versioned hostname.
    // The stable canonical hostname must preserve its existing indexability.
    if(outHeaders.get("X-Robots-Tag")==="noindex, nofollow, noarchive")outHeaders.delete("X-Robots-Tag");
  }
  const type=outHeaders.get("content-type")||"";
  const csp=outHeaders.get("content-security-policy");
  const inject=request.method==="GET"&&original.status===200&&/text\/html/i.test(type)&&eligible(incoming.pathname,csp);
  if(!inject)return new Response(original.body,{status:original.status,statusText:original.statusText,headers:outHeaders});
  outHeaders.delete("Content-Length");
  outHeaders.delete("ETag");
  if(csp)outHeaders.set("Content-Security-Policy",adjustCsp(csp));
  const response=new Response(original.body,{status:original.status,statusText:original.statusText,headers:outHeaders});
  const brandToolsPage=["/tools","/tools/","/fa/tools","/fa/tools/","/ps/tools","/ps/tools/"].includes(incoming.pathname);
  const rewriter=new HTMLRewriter()
    .on("head",{element(element){element.append('<link rel="stylesheet" href="'+CSS_PATH+'">',{html:true});}})
    .on("body",{element(element){element.append('<script defer src="'+JS_PATH+'"></script>'+(brandToolsPage?'<script defer src="'+TOOLS_BRAND_PATH+'"></script>':""),{html:true});}});
  if(incoming.pathname.includes("/guides/")){
    // The historic guide navigation used the retired homepage section anchor.
    rewriter.on('a[href*="#th-pathways"]',{element(element){
      const href=element.getAttribute("href");
      if(href)element.setAttribute("href",href.replace(/#th-pathways$/,"#programs"));
    }});
    // Keep article contents; only normalize the visitor-facing school name.
    rewriter.on("body",{text(chunk){
      if(/تافل هاوس|خانه موفقیت/.test(chunk.text))
        chunk.replace(chunk.text.replace(/تافل هاوس|خانه موفقیت/g,"تافل هوس"));
    }});
  }
  return rewriter.transform(response);
}
export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(url.pathname===JS_PATH)return staticResponse(request,CLIENT_JS,"application/javascript; charset=utf-8");
    if(url.pathname===CSS_PATH)return staticResponse(request,STYLE+GUIDE_A11Y_STYLE,"text/css; charset=utf-8");
    if(url.pathname===TOOLS_BRAND_PATH)return staticResponse(request,TOOLS_BRAND_JS,"application/javascript; charset=utf-8");
    if(url.pathname==="/__th/health")return staticResponse(request,JSON.stringify({service:"toefl-house-edge-upgrade",version:1,pinned:"2026-11-09"}),"application/json; charset=utf-8");
    // Preview must never be able to submit authentic data to the original production CMS.
    if(noindex(url.hostname)&&!["GET","HEAD","OPTIONS"].includes(request.method)){
      return new Response("Preview is read-only",{status:403,headers:{"Cache-Control":"no-store","X-Robots-Tag":"noindex"}});
    }
    // Serve unchanged hashed static files locally; never proxy binary/font assets unnecessarily.
    if(["GET","HEAD"].includes(request.method)&&env&&env.ASSETS&&(
      url.pathname.startsWith("/assets/")||url.pathname==="/default-content.json"||
      /^\/(?:fa\/|ps\/)?(?:index|404)\.html$/.test(url.pathname)
    )){
      const asset=await env.ASSETS.fetch(request);
      if(asset.ok)return asset;
    }
    try{return await passThrough(request);}
    catch(error){
      console.error("Original site unavailable",String(error));
      return new Response("Website temporarily unavailable",{status:503,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
    }
  }
};
