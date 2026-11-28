
function v2SpecialProgramPage(locale,cms,id){
 const page=V2_SPECIAL_COURSES[locale]?.[id==="special-speaking"?"special":"toefl"];
 if(!page)return null;
 const u=V2_SPECIAL_UI[locale],site=V2_COPY[locale],prefix=v2Prefix(locale),route=prefix+"courses/"+id+"/";
 const isSpeaking=id==="special-speaking",apply=prefix+"admissions/?program="+id,detailAnchor="#program-detail";
 const safe=v2T;
 const schema=[
 {"@context":"https://schema.org","@type":"Course","name":isSpeaking?"Special Speaking":"TOEFL iBT Preparation","description":page.description,"provider":{"@type":"EducationalOrganization","name":"The TOEFL House","url":V2_ORIGIN+"/"},"url":V2_ORIGIN+route,"timeRequired":isSpeaking?"P2M":"P4M","inLanguage":[site.lang,"en"],"offers":isSpeaking?{"@type":"Offer","price":"2000","priceCurrency":"AFN","description":"Full two-month semester; tuition only"}:undefined},
 {"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":site.name,"item":V2_ORIGIN+prefix},{"@type":"ListItem","position":2,"name":page.title,"item":V2_ORIGIN+route}]}
 ];
 const heading=v2SubpageHead(locale,route,page.meta,page.description,schema);
 const facts=v2CourseFacts(page.facts);
 const syllabus=page.path.map((item,i)=>'<li class="eap-level"><span class="eap-level-number">'+String(i+1).padStart(2,"0")+'</span><div><div class="eap-level-top"><h3>'+safe(item.title)+'</h3></div><p>'+safe(item.desc)+'</p><ul>'+item.items.map(x=>'<li>'+safe(x)+'</li>').join("")+'</ul></div></li>').join("");
 const books=page.resources.map((b,i)=>'<article class="eap-book"><div class="eap-book-top"><span class="eap-book-index">0'+(i+1)+'</span></div><h3 dir="ltr" lang="en">'+safe(b.title)+'</h3><p class="eap-publisher">'+safe(b.by)+'</p><p>'+safe(b.desc)+'</p><ul>'+b.points.map(x=>'<li>'+safe(x)+'</li>').join("")+'</ul></article>').join("");
 const steps=page.method.map(([no,h,d])=>'<article class="eap-goal"><span class="eap-index">'+safe(no)+'</span><h3>'+safe(h)+'</h3><p>'+safe(d)+'</p></article>').join("");
 const origin=V2_ORIGIN,sourceLink='https://www.ets.org/toefl/test-takers/ibt/about/content.html?version=after-jan-2026';
 return heading+
 '<main id="main" class="eap-page sp-page">'+
 '<section class="eap-hero"><div class="shell"><nav class="breadcrumbs" aria-label="'+safe(v2BreadcrumbLabel(locale))+'"><a href="'+prefix+'">'+safe(site.name)+'</a><span aria-hidden="true">/</span><a href="'+prefix+'#programs">'+safe(u.breadcrumb)+'</a><span aria-hidden="true">/</span><span aria-current="page">'+safe(page.title)+'</span></nav>'+
 '<div class="eap-hero-grid"><div class="eap-hero-copy"><p class="eyebrow">'+safe(u.overview)+'</p>'+(isSpeaking&&locale!=="en"?'<span class="sp-latin-title" lang="en" dir="ltr">SPECIAL SPEAKING</span>':"")+'<h1>'+safe(page.title)+' <em>'+safe(page.accent)+'</em></h1><p class="eap-lead">'+safe(page.intro)+'</p><div class="eap-actions"><a class="button button-primary button-xl" href="'+apply+'">'+safe(u.cta)+' <span aria-hidden="true">↗</span></a><a class="button button-quiet button-xl" href="'+detailAnchor+'">'+safe(u.details)+'</a></div><p class="eap-hero-note"><span aria-hidden="true">✦</span> '+safe(page.lead)+'</p></div>'+
 '<div class="eap-hero-visual sp-hero-visual" aria-hidden="true"><span class="eap-visual-kicker">THE TOEFL HOUSE</span><strong dir="ltr">'+(isSpeaking?'SPEAK':'TOEFL')+'</strong><span class="eap-visual-small" dir="ltr">'+(isSpeaking?'LISTEN · THINK · SPEAK':'READ · LISTEN · WRITE · SPEAK')+'</span><span class="eap-visual-number" dir="ltr">'+(isSpeaking?'02 MONTHS':'04 MONTHS')+'</span></div></div>'+
 '<div class="eap-facts">'+facts+'</div></div></section>'+
 v2CourseMission(u.overview,page.whoTitle,page.whoText)+
 v2CourseOutcomes(u.outcomes,page.outcomesTitle,page.outcomesIntro,page.outcomes)+
 '<section class="eap-path section" id="program-detail"><div class="shell">'+v2CourseHeading(u.curriculum,page.pathTitle,page.pathIntro)+'<ol class="eap-levels">'+syllabus+'</ol></div></section>'+
 '<section class="eap-books-section section" id="program-books"><div class="shell">'+v2CourseHeading(u.resources,page.resourcesTitle,page.resourcesIntro)+'<div class="eap-books-grid sp-resources">'+books+'</div>'+
 (!isSpeaking?'<p class="sp-external"><a href="'+sourceLink+'" target="_blank" rel="noopener noreferrer">'+safe(u.source)+' <span aria-hidden="true">↗</span></a></p>':"")+'</div></section>'+
 '<section class="eap-goals section sp-method"><div class="shell">'+v2CourseHeading(u.method,page.methodTitle,page.methodIntro)+'<div class="eap-goals-grid">'+steps+'</div></div></section>'+
 '<section class="eap-fees section" id="program-fee"><div class="shell">'+v2CourseHeading(u.price,page.feeTitle)+'<div class="eap-fee-grid"><div class="eap-fee-card eap-fee-featured"><small>'+safe(u.duration)+'</small><strong>'+safe(page.durationDisplay)+'</strong></div><div class="eap-fee-card"><small>'+safe(u.price)+'</small><strong>'+safe(page.feeMain)+'</strong></div></div><p class="eap-fee-note">'+safe(page.feeSub)+' · '+safe(u.feeNote)+'</p></div></section>'+
 v2CourseFaqSection(u.questions,page.faqTitle,page.faq)+
 v2CourseFinal(u.last,page.ctaTitle,page.ctaText,apply,u.cta,u.admissions)+'</main>'+
 v2Footer(site,locale,cms);
}
