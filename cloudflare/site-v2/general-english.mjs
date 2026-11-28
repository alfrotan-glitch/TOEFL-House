/* Research-grounded General English program supplement.
 * Course levels, faculty count and tuition: school-owner confirmed.
 * Oxford textbook characteristics: independently researched;
 * Oxford book numbering is NOT mapped to internal school levels.
 * Never imports copyrighted Oxford textbook pages or photos.
 */

// V2_GE_STAGES and localized details are compiled from content/general.json.
// Original practice questions. Local-only, no placement inference or personal data.
// V2_GE_PRACTICE_UI is compiled from content/ui.json.
const V2_GE_PRACTICE_QUESTIONS=[{"prompt":"Where are you from?","choices":["I'm twenty years old.","I'm from Kabul.","I'm fine, thanks."],"correct":1},{"prompt":"She ___ English every day.","choices":["study","studying","studies"],"correct":2},{"prompt":"You didn't hear someone clearly. What can you say?","choices":["Could you repeat that, please?","I don't have a pen.","See you tomorrow."],"correct":0}];
function v2GePractice(locale){
 const c=V2_GE_PRACTICE_UI[locale]||V2_GE_PRACTICE_UI.en,e=v2T;
 // Isolate English examples in RTL explanations without trusting markup in copy.
 const explanation=text=>locale==='en'?e(text):text.split(/(Could you repeat that, please\?|I'm from|\b(?:studies|study|he|she|it|s)\b)/g).map((part,i)=>i%2?'<bdi lang="en" dir="ltr">'+e(part)+'</bdi>':e(part)).join('');
 const items=V2_GE_PRACTICE_QUESTIONS.map((q,i)=>'<article class="ge-panel" data-ge-question data-correct="'+q.correct+'"><h4>'+e(c.question)+' '+(i+1)+'</h4><p lang="en" dir="ltr"><strong>'+e(q.prompt)+'</strong></p><ol data-ge-fallback lang="en" dir="ltr">'+q.choices.map(x=>'<li>'+e(x)+'</li>').join("")+'</ol><div data-ge-controls hidden><fieldset><legend>'+e(c.choice)+'</legend>'+q.choices.map((x,j)=>'<p><label dir="ltr"><input type="radio" name="ge-practice-'+i+'" value="'+j+'"> <span lang="en" dir="ltr">'+e(x)+'</span></label></p>').join("")+'</fieldset><button type="button" class="button button-primary" data-ge-check disabled>'+e(c.check)+'</button><p data-ge-feedback role="status" aria-live="polite"></p></div><details data-ge-answer><summary>'+e(c.reveal)+'</summary><p><strong lang="en" dir="ltr">'+e(q.choices[q.correct])+'</strong> — '+explanation(c.explanations[i])+'</p></details></article>').join("");
 return '<section id="ge-mini-practice" class="ge-stages-block" aria-labelledby="ge-practice-title" data-ge-practice data-correct-label="'+e(c.correct)+'" data-incorrect-label="'+e(c.incorrect)+'" data-progress-label="'+e(c.progress)+'" data-score-label="'+e(c.score)+'"><div class="ge-section-intro"><h3 id="ge-practice-title">'+e(c.title)+'</h3><p>'+e(c.intro)+'</p></div><div class="growth-card-grid">'+items+'</div><div data-ge-result hidden><p role="status" aria-live="polite" data-ge-progress></p><button class="button button-quiet" type="button" data-ge-reset>'+e(c.reset)+'</button></div></section>';
}
function v2GeneralEnglish(locale){
 const c=V2_GENERAL_ENGLISH[locale]||V2_GENERAL_ENGLISH.en;
 const esc=v2T;
 const prefix=v2Prefix(locale);
 const levelItems=V2_GE_STAGES.map((stage,i)=>
  '<li class="ge-stage"><span class="ge-number" aria-hidden="true">'+String(i+1).padStart(2,"0")+'</span>'+
  '<div><h4 dir="ltr">'+esc(stage.id)+'</h4><p><strong>'+esc(c.stageData[stage.id].focus)+'</strong><br>'+esc(c.stageData[stage.id].description)+'</p>'+
  '<span class="ge-stage-meta">'+esc(c[stage.durationKey])+'</span></div></li>'
 ).join("");
 const facts=c.facts.map(pair=>
  '<div class="ge-fact"><strong>'+esc(pair[0])+'</strong><span>'+esc(pair[1])+'</span></div>'
 ).join("");
 const tableRows=V2_GE_STAGES.map(stage=>
  '<tr><th scope="row" dir="ltr">'+esc(stage.id)+'</th><td>'+esc(c[stage.durationKey])+'</td>'+
  '<td><strong>'+esc(c.stageData[stage.id].fee)+'</strong></td></tr>'
 ).join("");
 const faqs=c.faqs.map(pair=>
  '<details class="ge-faq"><summary>'+esc(pair[0])+'</summary><p>'+esc(pair[1])+'</p></details>'
 ).join("");
 const sourceLinks=[
  ['Oxford University Press — Got it! Starter, Teacher’s Book (2nd ed.)','https://books.google.com/books/about/Got_It_Starter_Teacher_Book.html?id=fr7YwQEACAAJ'],
  ['Oxford ELT catalogue — Got it! series and editions','https://fliphtml5.com/eata/byzg/OUP_Catalogue_2016/'],
  ['Oxford Learner’s Bookshelf — digital book platform','https://www.oxfordlearnersbookshelf.com/']
 ].map(entry=>'<li><a href="'+entry[1]+'" target="_blank" rel="noopener noreferrer">'+esc(entry[0])+' <span aria-hidden="true">↗</span></a></li>').join("");
 return '<section class="ge-section section" id="general-english-details" aria-labelledby="ge-headline"><div class="shell">'+
  '<header class="ge-heading"><p class="eyebrow">'+esc(c.eyebrow)+'</p><h2 id="ge-headline">'+esc(c.title)+'</h2>'+
  '<p>'+esc(c.intro)+'</p></header>'+
  '<div class="ge-facts" aria-label="'+esc(c.eyebrow)+'">'+facts+'</div>'+
  '<section class="ge-stages-block" aria-labelledby="ge-skills-title"><div class="ge-section-intro"><h3 id="ge-skills-title">'+esc(c.skillTitle)+'</h3><p>'+esc(c.skillIntro)+'</p></div>'+
  '<div class="ge-facts ge-skills">'+c.skills.map(pair=>'<article class="ge-fact"><h4>'+esc(pair[0])+'</h4><p>'+esc(pair[1])+'</p></article>').join("")+'</div></section>'+
  v2GePractice(locale)+
  '<div class="ge-stages-block" id="ge-pathway"><div class="ge-section-intro"><h3>'+esc(c.levelsTitle)+'</h3><p>'+esc(c.levelsIntro)+'</p></div>'+
  '<ol class="ge-stages">'+levelItems+'</ol></div>'+
  '<div class="ge-columns">'+
    '<article class="ge-panel ge-oxford"><span class="eyebrow">'+esc(c.oxfordLabel)+'</span>'+
    '<h3>'+esc(c.oxfordTitle)+'</h3><p>'+esc(c.oxfordIntro)+'</p>'+
    '<ul class="ge-benefits">'+c.oxfordFeatures.map(x=>'<li>'+esc(x)+'</li>').join("")+'</ul>'+
    '<div class="ge-book-levels"><strong>'+esc(c.oxfordLevelsLabel)+'</strong><span dir="ltr">'+esc(c.oxfordLevels)+'</span></div>'+
    '<p class="ge-note">'+esc(c.oxfordNote)+'</p>'+v2BookGuideLink(locale,"got-it-series")+'</article>'+
    '<div class="ge-side"><article class="ge-panel ge-speaking"><span class="eyebrow">'+esc(c.speakingLabel)+'</span>'+
    '<h3>'+esc(c.speakingTitle)+'</h3><p>'+esc(c.speakingText)+'</p></article>'+
    '<article class="ge-panel ge-teachers"><h3>'+esc(c.twoTitle)+'</h3><p>'+esc(c.twoText)+'</p></article></div></div>'+
  '<section class="ge-fees" aria-labelledby="ge-fees-title"><div class="ge-section-intro"><span class="eyebrow">'+esc(c.feeLabel)+'</span>'+
  '<h3 id="ge-fees-title">'+esc(c.feeTitle)+'</h3><p>'+esc(c.feeIntro)+'</p></div>'+
  '<div class="ge-table-wrap"><table class="ge-fee-table"><thead><tr><th scope="col">'+esc(c.colLevel)+'</th><th scope="col">'+esc(c.colDuration)+'</th><th scope="col">'+esc(c.colFee)+'</th></tr></thead>'+
  '<tbody>'+tableRows+'</tbody></table></div>'+
  '<div class="ge-fee-total"><div><strong>'+esc(c.totalTitle)+'</strong><span>'+esc(c.totalDuration)+'</span></div>'+
  '<strong class="ge-total-money">'+esc(c.totalFee)+'</strong></div>'+
  '<p class="ge-fee-note">'+esc(c.totalNote)+'</p></section>'+
  '<section class="ge-questions" aria-labelledby="ge-faq-title"><h3 id="ge-faq-title">'+esc(c.faqTitle)+'</h3>'+faqs+'</section>'+
  '<div class="ge-cta"><div><strong>'+esc(c.ctaTitle)+'</strong><span>'+esc(c.ctaSub)+'</span></div>'+
  '<a class="button button-primary" href="'+prefix+'admissions/?program=general-english">'+esc(c.cta)+' <span aria-hidden="true">↗</span></a></div>'+
 '</div></section>';
}
