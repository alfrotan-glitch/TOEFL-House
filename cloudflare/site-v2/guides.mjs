/* Preserve the existing publisher-reviewed learning guides and their URLs,
 * but present them within the same trilingual, accessible V2 design system.
 * Only requests to the pinned public guide source are permitted.
 */
const V2_GUIDE_SLUGS=["english-courses-kabul","toefl-ibt-2026","speaking-practice"];
const V2_GUIDE_UI={
 en:{section:"LEARNING RESOURCES",back:"Learning resources",read:"Explore our programs",start:"Request a free placement assessment"},
 fa:{section:"رهنماهای آموزشی",back:"رهنماهای درسی",read:"دیدن برنامه‌های آموزشی",start:"درخواست تعیین سطح رایگان"},
 ps:{section:"د زده‌کړې لارښودونه",back:"زده‌کړیز لارښودونه",read:"زموږ ښوونیز پروګرامونه",start:"د سویې د وړیا ارزونې غوښتنه"}
};
function v2GuideText(text){
 return String(text||"").replace(/<[^>]*>/g,"").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim();
}
async function v2Guides(request,env,locale,slug){
 if(slug&&!V2_GUIDE_SLUGS.includes(slug))return null;
 if(!["GET","HEAD"].includes(request.method))return new Response("Method not allowed",{status:405,headers:{Allow:"GET, HEAD"}});
 const p=v2Prefix(locale),route=p+"guides/"+(slug?slug+"/":"");
 let original,html,cms;
 try{
  const url=new URL(route,UPSTREAM);
  original=await fetch(new Request(url,{method:"GET",headers:{"Accept":"text/html"}}));
  if(!original.ok||!(original.headers.get("Content-Type")||"").includes("text/html"))return null;
  html=await original.text();
  cms=await v2Cms(env);
 }catch(_){return null;}
 const header=html.match(/<header class="growth-hero">([\s\S]*?)<\/header>/i);
 const main=html.match(/<main id="content">([\s\S]*?)<\/main>/i);
 if(!header||!main)return null;
 const h1=header[1].match(/<h1>([\s\S]*?)<\/h1>/i);
 const paragraph=header[1].match(/<h1>[\s\S]*?<\/h1>\s*<p>([\s\S]*?)<\/p>/i);
 if(!h1||!paragraph)return null;
 const title=v2GuideText(h1[1]),description=v2GuideText(paragraph[1]);
 if(!title||!description||title.length>180||description.length>450)return null;
 const ui=V2_GUIDE_UI[locale],site=V2_COPY[locale],canon=V2_ORIGIN+route;
 const isArticle=Boolean(slug);
 const record={"@context":"https://schema.org","@type":isArticle?"Article":"CollectionPage","name":title,"description":description,"inLanguage":site.lang,"url":canon,"publisher":{"@type":"EducationalOrganization","name":"The TOEFL House","url":V2_ORIGIN+"/"}};
 if(isArticle)record.headline=title;
 const breadcrumbs={"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":site.name,"item":V2_ORIGIN+p},{"@type":"ListItem","position":2,"name":ui.back,"item":V2_ORIGIN+p+"guides/"}]};
 if(isArticle)breadcrumbs.itemListElement.push({"@type":"ListItem","position":3,"name":title,"item":canon});
 let body=main[1];
 // The original article has a retired home-page #start link. Take visitors
 // directly to the active admission page while keeping the article unchanged.
 body=body.replace(/href="https:\/\/the-toefl-house\.pages\.dev\/(fa\/|ps\/)?#start"/g,(_,loc)=>'href="'+V2_ORIGIN+'/'+(loc||"")+'admissions/"');
 // Guide cards must expose actual headings, not only bold text.
 if(!isArticle)body=body.replace(/<strong>([^<]+)<\/strong>/g,'<h2>$1</h2>');
 const top=v2SubpageHead(locale,route,title+" | The TOEFL House",description,[record,breadcrumbs]);
 const crumb='<nav class="breadcrumbs" aria-label="'+v2T(v2BreadcrumbLabel(locale))+'"><a href="'+p+'">'+v2T(site.name)+'</a><span aria-hidden="true">/</span>'+(isArticle?'<a href="'+p+'guides/">'+v2T(ui.back)+'</a><span aria-hidden="true">/</span><span aria-current="page">'+v2T(title)+'</span>':'<span aria-current="page">'+v2T(ui.back)+'</span>')+'</nav>';
 const page=top+'<main id="main" class="editorial-guides"><section class="guide-hero"><div class="shell">'+crumb+'<p class="eyebrow">'+v2T(ui.section)+'</p><h1>'+v2T(title)+'</h1><p>'+v2T(description)+'</p></div></section><section class="guide-body"><div class="shell">'+body+'</div></section></main>'+v2Footer(site,locale,cms);
 return v2SubpageResponse(request,page,locale);
}
