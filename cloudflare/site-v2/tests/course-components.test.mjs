import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

test('shared course components escape text and preserve optional heading and FAQ behavior',async()=>{
 const source=await readFile(new URL('../course-components.mjs',import.meta.url),'utf8');
 const v2T=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const components=runInNewContext(source+'\n({v2CourseMission,v2CourseHeading,v2CourseOutcomes,v2CourseFaqSection,v2CourseFinal})',{v2T});
 const bad='<img src=x onerror=alert(1)>';
 for(const html of [
  components.v2CourseMission(bad,bad,bad),
  components.v2CourseHeading(bad,bad,bad),
  components.v2CourseOutcomes(bad,bad,bad,[[bad,bad]]),
  components.v2CourseFaqSection(bad,bad,[[bad,bad],[bad,bad]]),
  components.v2CourseFinal(bad,bad,bad,'/admissions/?program=academic-english',bad,bad)
 ]){
  assert.ok(html.includes('&lt;img'));assert.ok(!html.includes(bad));
 }
 assert.doesNotMatch(components.v2CourseHeading('label','title'),/<p><\/p>/);
 assert.match(components.v2CourseHeading('label','title',''),/<p><\/p>/);
 const faq=components.v2CourseFaqSection('label','title',[['q','a'],['q2','a2']]);
 assert.match(faq,/<details open><summary>q/);assert.match(faq,/<details><summary>q2/);
 assert.match(components.v2CourseFinal('label','title','text','/admissions/?program=academic-english','apply','whatsapp'),/href="\/admissions\/\?program=academic-english"/);
});
