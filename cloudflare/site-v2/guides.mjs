/* Standalone, trilingual learning guides.
 * These pages are intentionally self-contained: public guides must not depend
 * on the retired Pages origin or on private CMS/auth services.
 */
// These route lists are declared once in the edge layer and reused at build time.
const V2_BOOK_SLUGS=V2_PUBLIC_BOOK_GUIDES;
const V2_GUIDE_SLUGS=V2_PUBLIC_GUIDES;
// V2_GUIDE_UI is compiled from content/guides.json.
// V2_GUIDE_DATA is compiled from content/guides.json.
// V2_BOOK_UI is compiled from content/guides.json.
// V2_BOOK_DATA is compiled from content/guides.json.
for(const lang of ["en","fa","ps"])Object.assign(V2_GUIDE_DATA[lang],V2_BOOK_DATA[lang]);
// Concise display names; localized descriptive titles remain in SEO metadata.
const V2_BOOK_NAMES={"got-it-series":"Got it! Series","active-skills-for-reading":"ACTIVE Skills for Reading","longman-academic-writing":"Longman Academic Writing Series","contemporary-topics":"Contemporary Topics"};
// Original, low-stakes feedback for the exercises above; no publisher text is reproduced.
// V2_BOOK_FEEDBACK is compiled from content/guides.json.
const V2_WRITING_EXAMPLE="Daily English practice helps me communicate. I learn useful words and use them in short conversations. Regular practice also helps me remember what I learn. For these reasons, I practise a little every day.";
function v2BookFeedback(locale,slug){
 const feedback=V2_BOOK_FEEDBACK[locale],hint=feedback.hints[slug];if(!hint)return '';
 return '<details class="book-feedback"><summary>'+v2T(feedback.label)+'</summary><p>'+v2T(hint,500)+'</p>'+(slug==='longman-academic-writing'?'<p><strong>'+v2T(feedback.example)+'</strong></p><p lang="en" dir="ltr">'+v2T(V2_WRITING_EXAMPLE)+'</p>':'')+'</details>';
}
function v2BookGuideLink(locale,slug){
 const ui=V2_BOOK_UI[locale],book=V2_BOOK_DATA[locale]?.[slug];
 if(!ui||!book)throw Error("Unknown localized book guide: "+locale+"/"+slug);
 return '<a class="button button-quiet" href="'+v2Prefix(locale)+'guides/'+slug+'/" aria-label="'+v2T(ui.read+' — '+book.title,250)+'">'+v2T(ui.read)+'</a>';
}
// Keep mixed-script names and original English exercise text readable in RTL.
// Escape each segment before inserting our own fixed markup.
function v2GuideText(text,locale,max=1000){
 const value=String(text??'').slice(0,max);
 if(locale==='en')return v2T(value,max);
 return value.split(/(A student reviews new vocabulary for ten minutes each evening and uses three words in a short paragraph\.|Longman Academic Writing Series|Longman Academic Writing|ACTIVE Skills for Reading|Contemporary Topics|Got it! Series|Got it!|Neil J\. Anderson|TOEFL iBT|Longman|Pearson|Starter|EAP)/g).map((part,i)=>i%2?'<bdi'+(part==='TOEFL iBT'?' class="guide-mark"':'')+' lang="en" dir="ltr">'+v2T(part,max)+'</bdi>':v2T(part,max)).join('');
}
// One curated learning pathway per guide. These are navigation, not a claim
// that a book is required or a substitute for institutional advice.
const V2_RELATED_GUIDES={
 'english-courses-kabul':['toefl-ibt-2026','speaking-practice'],
 'toefl-ibt-2026':['english-courses-kabul','speaking-practice'],
 'speaking-practice':['english-courses-kabul','got-it-series'],
 'got-it-series':['speaking-practice','active-skills-for-reading'],
 'active-skills-for-reading':['longman-academic-writing','contemporary-topics'],
 'longman-academic-writing':['active-skills-for-reading','contemporary-topics'],
 'contemporary-topics':['active-skills-for-reading','longman-academic-writing']
};
// V2_GUIDE_NAV is compiled from content/guides.json.
function v2GuideSections(item,locale){
 return item.sections.map((section,index)=>{
  const exercise=item.publisher&&index===item.sections.length-1;
  const notes=exercise?'<label for="book-notes">'+v2T(V2_BOOK_FEEDBACK[locale].notes)+'</label><textarea id="book-notes" rows="4" dir="auto" autocomplete="off"></textarea>':'';
  return '<section id="guide-section-'+(index+1)+'"'+(exercise?' class="book-exercise"':'')+'><h2>'+v2GuideText(section.heading,locale,180)+'</h2>'+section.paragraphs.map(p=>'<p>'+v2GuideText(p,locale,900)+'</p>').join('')+(section.bullets?.length?'<ul>'+section.bullets.map(x=>'<li>'+v2GuideText(x,locale,360)+'</li>').join('')+'</ul>':'')+notes+'</section>';
 }).join('');
}
function v2GuideCards(ids,locale,p,heading='h2'){
 const ui=V2_GUIDE_UI[locale];
 return '<div class="growth-card-grid">'+ids.map((id,index)=>{const card=V2_GUIDE_DATA[locale][id],label=V2_BOOK_NAMES[id]?(heading==='h2'?'<bdi dir="ltr" aria-hidden="true">'+String(index+1).padStart(2,'0')+' / '+String(ids.length).padStart(2,'0')+'</bdi>':v2T(V2_BOOK_UI[locale].heading)):v2T(ui.section);return '<a class="growth-card" href="'+p+'guides/'+id+'/"><small>'+label+'</small><'+heading+'>'+v2GuideText(V2_BOOK_NAMES[id]||card.title,locale)+'</'+heading+'><p>'+v2GuideText(card.description,locale)+'</p><span class="growth-arrow">'+v2T(ui.open)+' ↗</span></a>';}).join('')+'</div>';
}
async function v2Guides(request,env,locale,slug){
 if(slug&&!V2_GUIDE_SLUGS.includes(slug))return null;
 if(!["GET","HEAD"].includes(request.method))return new Response("Method not allowed",{status:405,headers:{Allow:"GET, HEAD"}});
 const p=v2Prefix(locale),route=p+"guides/"+(slug?slug+"/":"");
 const ui=V2_GUIDE_UI[locale],site=V2_COPY[locale],item=slug?V2_GUIDE_DATA[locale][slug]:null;
 const title=item?.title||ui.indexTitle,displayTitle=V2_BOOK_NAMES[slug]||title,description=item?.description||ui.indexDescription;
 const cms=await v2Cms(env).catch(()=>null);
 const isArticle=Boolean(slug),canon=V2_ORIGIN+route;
 const record={"@context":"https://schema.org","@type":isArticle?"Article":"CollectionPage","name":title,"description":description,"inLanguage":site.lang,"url":canon,"publisher":{"@type":"EducationalOrganization","name":"The TOEFL House","url":V2_ORIGIN+"/"}};
 if(isArticle)record.headline=title;
 const breadcrumbs={"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":site.name,"item":V2_ORIGIN+p},{"@type":"ListItem","position":2,"name":ui.back,"item":V2_ORIGIN+p+"guides/"}]};
 if(isArticle)breadcrumbs.itemListElement.push({"@type":"ListItem","position":3,"name":title,"item":canon});
 const top=v2SubpageHead(locale,route,title+" | The TOEFL House",description,[record,breadcrumbs]);
 const crumb='<nav class="breadcrumbs" aria-label="'+v2T(v2BreadcrumbLabel(locale))+'"><a href="'+p+'">'+v2T(site.name)+'</a><span aria-hidden="true">/</span>'+(isArticle?'<a href="'+p+'guides/">'+v2T(ui.back)+'</a><span aria-hidden="true">/</span><span aria-current="page">'+v2GuideText(displayTitle,locale)+'</span>':'<span aria-current="page">'+v2T(ui.back)+'</span>')+'</nav>';
 let body;
 if(isArticle){
  const target=p+"admissions/"+(item.program?"?program="+item.program:"");
  const refs=item.publisher?'<section><h2>'+v2T(V2_BOOK_UI[locale].source)+'</h2><p><a href="'+v2T(item.source)+'" rel="noopener noreferrer" lang="en" dir="ltr">'+v2T(item.publisher)+'</a></p><p><a href="'+p+'courses/'+item.program+'/">'+v2T(V2_BOOK_UI[locale].course)+'</a></p></section>':"";
  const nav=V2_GUIDE_NAV[locale];
  const contents='<nav class="guide-contents" aria-label="'+v2T(nav.contents)+'"><p>'+v2T(nav.contents)+'</p><ol>'+item.sections.map((section,index)=>'<li><a href="#guide-section-'+(index+1)+'">'+v2GuideText(section.heading,locale,180)+'</a></li>').join('')+'</ol><a class="guide-back" href="'+p+'guides/">'+v2T(nav.all)+' <span aria-hidden="true">↗</span></a></nav>';
  const course=item.program&&!item.publisher?'<a class="guide-course" href="'+p+'courses/'+item.program+'/">'+v2T(nav.course)+' <span aria-hidden="true">↗</span></a>':'';
  const official=slug==='toefl-ibt-2026'?'<p><a href="https://www.ets.org/toefl/test-takers/ibt/about/content.html?version=after-jan-2026" rel="noopener noreferrer">'+v2T(nav.ets)+' <span aria-hidden="true">↗</span></a></p>':'';
  const related=V2_RELATED_GUIDES[slug];
  if(!related||related.some(id=>!V2_GUIDE_SLUGS.includes(id)||id===slug))throw Error('Invalid related guides: '+slug);
  body='<div class="guide-layout">'+contents+'<article class="growth-article"><p>'+v2GuideText(item.intro,locale,900)+'</p>'+v2GuideSections(item,locale)+v2BookFeedback(locale,slug)+refs+official+course+'<div class="growth-cta"><div><strong>'+v2T(ui.ctaTitle)+'</strong><p>'+v2T(ui.ctaText)+'</p></div><a class="growth-action" href="'+target+'">'+v2T(ui.start)+'</a></div></article></div><section class="guide-related" aria-labelledby="guide-related-title"><div class="guide-related-head"><div><h2 id="guide-related-title">'+v2T(nav.related)+'</h2><p>'+v2T(nav.relatedIntro)+'</p></div><a href="'+p+'guides/">'+v2T(nav.all)+' <span aria-hidden="true">↗</span></a></div>'+v2GuideCards(related,locale,p,'h3')+'</section>';
 }else{
  body='<section class="book-library" aria-labelledby="book-library-title"><h2 id="book-library-title">'+v2T(V2_BOOK_UI[locale].heading)+'</h2>'+v2GuideCards(V2_BOOK_SLUGS,locale,p)+'</section><section aria-labelledby="practical-guides-title"><h2 id="practical-guides-title">'+v2T(V2_BOOK_UI[locale].other)+'</h2>'+v2GuideCards(V2_GUIDE_SLUGS.filter(id=>!V2_BOOK_SLUGS.includes(id)),locale,p)+'</section>';
 }
 const page=top+'<main id="main" class="editorial-guides"><section class="guide-hero"><div class="shell">'+crumb+'<p class="eyebrow">'+v2T(ui.section)+'</p><h1>'+v2GuideText(displayTitle,locale)+'</h1><p>'+v2GuideText(description,locale)+'</p></div></section><section class="guide-body"><div class="shell">'+body+'</div></section></main>'+v2Footer(site,locale,cms);
 return v2SubpageResponse(request,page,locale);
}
