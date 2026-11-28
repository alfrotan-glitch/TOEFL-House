/* EAP school structure: 4 two-month levels, 3 instructors and 3 textbook series per level, AFN 1,000 monthly. Publisher checks, Nov 2026: ACTIVE Skills for Reading 3e (Cengage), Contemporary Topics 4e books 1–3 only (Pearson), Longman Academic Writing refreshed digital-resource release (Pearson). Never invent Contemporary Topics Book 4; ask academic department for EAP 4 assigned ISBN. */

function v2AcademicEnglishPage(locale,cms){
 const c=V2_EAP[locale],site=V2_COPY[locale],p=v2Prefix(locale),route=p+"courses/academic-english/";
 const title=c.seoTitle,desc=c.seoDescription;
 const schema=[{"@context":"https://schema.org","@type":"Course","name":"English for Academic Purposes (EAP)","description":desc,"courseCode":"EAP","educationalLevel":"EAP 1–EAP 4","provider":{"@type":"EducationalOrganization","name":"The TOEFL House","url":V2_ORIGIN+"/"},"url":V2_ORIGIN+route},{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"The TOEFL House","item":V2_ORIGIN+p},{"@type":"ListItem","position":2,"name":"English for Academic Purposes","item":V2_ORIGIN+route}]}];
 const heading=v2SubpageHead(locale,route,title,desc,schema),apply=p+"admissions/?program=academic-english";
 const feeMonth=c.feeMonthDisplay,feeLevel=c.feeLevelDisplay;
 const facts=v2CourseFacts(c.facts);
 const steps=c.levels.map((v,i)=>'<li class="eap-level"><span class="eap-level-number">'+String(i+1).padStart(2,"0")+'</span><div><div class="eap-level-top"><h3>'+v2T(v.title)+'</h3><span>'+v2T(c.levelDuration)+'</span></div><strong class="eap-level-subtitle">'+v2T(v.subtitle)+'</strong><p>'+v2T(v.desc)+'</p><div class="eap-assigned-books"><span>'+v2T(c.levelBookLabel)+'</span><ul>'+v.textbooks.map(book=>'<li dir="ltr" lang="en">'+v2T(book)+'</li>').join("")+'</ul>'+(i===3?'<p class="eap-fourth-note">'+v2T(c.fourthNote)+'</p>':"")+'</div><ul>'+v.skills.map(t=>'<li>'+v2T(t)+'</li>').join("")+'</ul></div></li>').join("");
 const books=c.books.map((b,i)=>'<article class="eap-book"><div class="eap-book-top"><span class="eap-book-index">0'+(i+1)+'</span><span class="eap-book-skill">'+v2T(b.role)+'</span></div><h3 dir="ltr" lang="en">'+v2T(b.title)+'</h3><p class="eap-publisher" dir="ltr">'+v2T(b.publisher)+'</p><p>'+v2T(b.intro)+'</p><ul>'+b.points.map(x=>'<li>'+v2T(x)+'</li>').join("")+'</ul>'+v2BookGuideLink(locale,b.guide)+'</article>').join("");
 return heading+
 '<main id="main" class="eap-page eap-editorial">'+
 '<section class="eap-hero"><div class="shell"><nav class="breadcrumbs" aria-label="'+v2T(v2BreadcrumbLabel(locale))+'"><a href="'+p+'">'+v2T(site.name)+'</a><span aria-hidden="true">/</span><a href="'+p+'#programs">'+v2T(c.other)+'</a><span aria-hidden="true">/</span><span aria-current="page">EAP</span></nav>'+
 '<div class="eap-hero-grid"><div class="eap-hero-copy"><p class="eyebrow eap-program-name" lang="en" dir="ltr">English for Academic Purposes (EAP)</p><h1>'+v2T(c.title)+' <em>'+v2T(c.accent)+'</em></h1><p class="eap-lead">'+v2T(c.intro)+'</p><div class="eap-actions"><a class="button button-primary button-xl" href="'+apply+'">'+v2T(c.cta)+' <span aria-hidden="true">↗</span></a><a class="button button-quiet button-xl" href="#eap-books">'+v2T(c.booksLabel)+'</a></div><p class="eap-hero-note"><span aria-hidden="true">✦</span> '+v2T(c.heroNote)+'</p></div><div class="eap-hero-visual" aria-hidden="true" dir="ltr"><div class="eap-visual-orbit"></div><strong>EAP</strong><span class="eap-visual-kicker">English for<br>Academic Purposes</span><span class="eap-visual-small">READING <b>·</b> LISTENING <b>·</b> WRITING</span><span class="eap-visual-number" dir="ltr">01 — 04</span></div></div>'+
 '<div class="eap-facts">'+facts+'</div></div></section>'+
 v2CourseMission(c.badge,c.whoTitle,c.whoText)+
 v2CourseOutcomes(c.outcomesLabel,c.outcomesTitle,c.outcomesIntro,c.outcomes)+
 '<section class="eap-path section" id="eap-levels"><div class="shell">'+v2CourseHeading(c.pathLabel,c.pathTitle,c.pathIntro)+'<ol class="eap-levels">'+steps+'</ol></div></section>'+
 '<section class="eap-books-section section" id="eap-books"><div class="shell">'+v2CourseHeading(c.booksLabel,c.booksTitle,c.booksIntro)+'<div class="eap-books-grid">'+books+'</div></div></section>'+
 '<section class="eap-teachers section"><div class="shell eap-teachers-grid"><div><p class="eyebrow">'+v2T(c.staffLabel)+'</p><h2>'+v2T(c.staffTitle)+'</h2><p>'+v2T(c.staffText)+'</p></div><div class="eap-teacher-badge" aria-hidden="true"><strong>03</strong><span>INSTRUCTORS / LEVEL</span></div></div></section>'+
 '<section class="eap-fees section" id="eap-fees"><div class="shell">'+v2CourseHeading(c.feeLabel,c.feeTitle)+'<div class="eap-fee-grid"><div class="eap-fee-card"><small>'+v2T(c.feeMonth)+'</small><strong>'+v2T(feeMonth)+'</strong></div><div class="eap-fee-card eap-fee-featured"><small>'+v2T(c.feeTerm)+'</small><strong>'+v2T(feeLevel)+'</strong></div></div><p class="eap-fee-note">'+v2T(c.feeNote)+'</p></div></section>'+
 v2CourseFaqSection(c.faqLabel,c.faqTitle,c.faq)+
 v2CourseFinal(c.ctaLabel,c.ctaTitle,c.ctaText,apply,c.cta,c.secondary)+'</main>'+
 v2Footer(site,locale,cms);
}
