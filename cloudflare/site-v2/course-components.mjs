// Shared server-rendered course components. Callers provide data; all text is
// escaped here so localized editorial copy cannot introduce markup.
function v2CourseFacts(facts){
 return facts.map(([number,description])=>'<div class="eap-fact"><strong>'+v2T(number)+'</strong><span>'+v2T(description)+'</span></div>').join("");
}
function v2CourseGoals(goals){
 return goals.map(([title,description],i)=>'<article class="eap-goal"><span class="eap-index">'+String(i+1).padStart(2,"0")+'</span><h3>'+v2T(title)+'</h3><p>'+v2T(description)+'</p></article>').join("");
}
function v2CourseQuestions(questions){
 return questions.map(([q,a],i)=>'<details'+(i===0?' open':'')+'><summary>'+v2T(q)+'<span class="eap-faq-plus" aria-hidden="true">+</span></summary><p>'+v2T(a)+'</p></details>').join("");
}
