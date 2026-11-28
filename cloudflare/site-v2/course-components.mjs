// Shared server-rendered course components. Callers provide data; all text is
// escaped here so localized editorial copy cannot introduce markup. The apply
// href is caller-owned, built from validated local route IDs, not CMS input.
function v2CourseFacts(facts){
 return facts.map(([number,description])=>'<div class="eap-fact"><strong>'+v2T(number)+'</strong><span>'+v2T(description)+'</span></div>').join("");
}
function v2CourseGoals(goals){
 return goals.map(([title,description],i)=>'<article class="eap-goal"><span class="eap-index">'+String(i+1).padStart(2,"0")+'</span><h3>'+v2T(title)+'</h3><p>'+v2T(description)+'</p></article>').join("");
}
function v2CourseQuestions(questions){
 return questions.map(([q,a],i)=>'<details'+(i===0?' open':'')+'><summary>'+v2T(q)+'<span class="eap-faq-plus" aria-hidden="true">+</span></summary><p>'+v2T(a)+'</p></details>').join("");
}
function v2CourseMission(label,title,text){
 return '<section class="eap-mission section"><div class="shell eap-mission-grid"><div><span class="eyebrow">'+v2T(label)+'</span><h2>'+v2T(title)+'</h2></div><p>'+v2T(text)+'</p></div></section>';
}
function v2CourseHeading(label,title,intro){
 return '<div class="eap-heading"><p class="eyebrow">'+v2T(label)+'</p><h2>'+v2T(title)+'</h2>'+(intro===undefined?'':'<p>'+v2T(intro)+'</p>')+'</div>';
}
function v2CourseOutcomes(label,title,intro,goals){
 return '<section class="eap-goals section"><div class="shell">'+v2CourseHeading(label,title,intro)+'<div class="eap-goals-grid">'+v2CourseGoals(goals)+'</div></div></section>';
}
function v2CourseFaqSection(label,title,questions){
 return '<section class="eap-faq section"><div class="shell eap-faq-grid"><div><p class="eyebrow">'+v2T(label)+'</p><h2>'+v2T(title)+'</h2></div><div class="eap-faq-list">'+v2CourseQuestions(questions)+'</div></div></section>';
}
function v2CourseFinal(label,title,text,apply,cta,secondary){
 return '<section class="eap-bottom"><div class="shell eap-bottom-inner"><div><p class="eyebrow">'+v2T(label)+'</p><h2>'+v2T(title)+'</h2><p>'+v2T(text)+'</p></div><div class="eap-bottom-actions"><a class="button button-white" href="'+apply+'">'+v2T(cta)+' <span aria-hidden="true">↗</span></a><a class="eap-bottom-link" href="https://wa.me/93794357509" rel="noopener noreferrer">'+v2T(secondary)+'</a></div></div></section>';
}
