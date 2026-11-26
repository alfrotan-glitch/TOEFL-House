import test from "node:test";
import assert from "node:assert/strict";
import worker from "../dist/_worker.js";
const env={CMS_DB:{prepare(sql){assert.match(sql,/SELECT body,revision/);return{async first(){return {body:"{}",revision:40}}}}}};
test("EAP editorial identity exposes full English name in each locale and retains real facts",async()=>{
 for(const [root,books] of [["/","3 textbook series"],["/fa/","۳ مجموعهٔ درسی"],["/ps/","۳ درسي لړۍ"]]){
  const r=await worker.fetch(new Request("https://toeflhouse.pages.dev"+root+"courses/academic-english/"),env);
  assert.equal(r.status,200);
  const h=await r.text();
  assert.match(h,/<p class="eyebrow eap-program-name" lang="en" dir="ltr">English for Academic Purposes \(EAP\)<\/p>/);
  assert.match(h,/<main id="main" class="eap-page eap-editorial">/);
  assert.match(h,/<div class="eap-hero-visual" aria-hidden="true" dir="ltr">/);
  assert.equal((h.match(/class="eap-fact"/g)||[]).length,4);
  assert.ok(h.includes(books));
  assert.ok(h.includes(root+"admissions/?program=academic-english"));
 }
});
test("Academic fact grid is shared and editorial motion is preference-gated",async()=>{
 const r=await worker.fetch(new Request("https://toeflhouse.pages.dev/__th/v2/site.css"),env);
 assert.equal(r.status,200);
 const css=await r.text();
 assert.match(css,/\.eap-facts\{[^}]*gap:1px/);
 assert.match(css,/@media\(prefers-reduced-motion:no-preference\)\{\.eap-editorial \.eap-faq-plus\{transition:transform/);
});

test("Narrow EAP layouts align actions and preserve readable introduction spacing",async()=>{
 const r=await worker.fetch(new Request("https://toeflhouse.pages.dev/__th/v2/site.css"),env);
 assert.equal(r.status,200);
 const css=await r.text();
 assert.match(css,/@media\(max-width:460px\)\{\.eap-editorial \.eap-hero \.breadcrumbs\{margin-bottom:20px\}[^}]*\}[^}]*\.eap-actions\{display:grid;grid-template-columns:1fr\}/);
 assert.match(css,/\.eap-editorial \.eap-lead\{margin-bottom:20px;line-height:1\.8\}/);
});
