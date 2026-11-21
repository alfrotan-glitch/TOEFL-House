import assert from "node:assert/strict";
import test from "node:test";

const base=(process.env.TH_SHORT_BASE||"https://toeflhouse.pages.dev").replace(/\/$/,"");
const origin="https://toeflhouse.pages.dev";
const isPreview=new URL(base).hostname!=="toeflhouse.pages.dev";
const header={"User-Agent":"TOEFL-House-short-link-acceptance/1.0","Accept":"text/html,application/json,*/*"};

async function check(path,options={}){
 const r=await fetch(base+path,{...options,headers:{...header,...(options.headers||{})},redirect:"manual",signal:AbortSignal.timeout(25000)});
 return {r,text:await r.text()};
}

test("official root serves Dari in-place, indexable and canonical on the short host",async()=>{
 const {r,text}=await check("/");
 assert.equal(r.status,200,"root must render directly without redirect");
 assert.match(r.headers.get("content-type")||"",/text\/html/);
 assert.equal(r.headers.get("x-robots-tag"),isPreview?"noindex, nofollow, noarchive":null);
 assert.equal(r.headers.get("x-shortlink-source"),null);
 assert.match(text,/<html lang="fa-AF" dir="rtl">/);
 assert.ok(text.includes('<link rel="canonical" href="'+origin+'/fa/">'),"canonical must use the official short host");
 assert.ok(!text.includes("the-toefl-house.pages.dev"),"legacy host must not leak into public HTML");
 assert.ok(text.includes('hreflang="en" href="/en/"'),"English language switch must function");
 assert.ok(text.includes('href="/fa/"'),"Dari language path");
 assert.ok(text.includes('href="/ps/"'),"Pashto language path");
 assert.ok(text.includes("footer-cta"),"footer must have one clear admissions action");
 assert.ok(!/صنف‌های آموزشی دارای فیس|صنف‌های آموزشی فیس دارند|رایگان‌بودن تعیین سطح به معنای رایگان‌بودن صنف‌ها نیست|course tuition free|Tuition applies to courses/.test(text),"remove obvious tuition disclaimers");
 assert.ok(text.includes("روبه‌روی مرکز جلیلی"),"normalize Dari address spelling");
 assert.ok(!text.includes("روبروی مرکز جلیلی"),"remove legacy Dari address spelling");
});

test("localized pages and admissions stay indexable on production and noindex on previews",async()=>{
 for(const [path,lang,marker] of [
  ["/fa/","fa-AF","goal-finder"],
  ["/ps/","ps-AF","goal-finder"],
  ["/en/","en","goal-finder"],
  ["/fa/admissions/","fa-AF","v2-program"],
  ["/fa/courses/special-speaking/","fa-AF","Special Speaking"],
  ["/en/admissions/","en","v2-program"]
 ]){
  const {r,text}=await check(path);
  assert.equal(r.status,200,path);
  assert.match(text,new RegExp('<html lang="'+lang+'"'),path);
  assert.ok(text.includes(marker),path+" page content");
  assert.equal(r.headers.get("x-shortlink-source"),null);
  assert.equal(r.headers.get("x-robots-tag"),isPreview?"noindex, nofollow, noarchive":null);
  assert.ok(text.includes(origin),path+" canonical origin");
 }
});

test("public CSS, JS, favicon, polish CSS and CMS remain usable",async()=>{
 for(const [path,type] of [
  ["/__th/v2/site.css",/text\/css/],
  ["/__th/v2/site.js",/javascript/],
  ["/__th/short-polish.css",/text\/css/],
  ["/assets/aistudio/favicon_afa00a26.png",/image\/png/],
  ["/api/content",/application\/json/]
 ]){
  const {r}=await check(path);
  assert.equal(r.status,200,path);
  assert.match(r.headers.get("content-type")||"",type,path);
 }
 const tracker=await check("/__th/engagement-v1.js");
 assert.ok(tracker.text.includes("toeflhouse.pages.dev"),"conversion script must recognise the official host");
 assert.ok(!tracker.text.includes("the-toefl-house.pages.dev"),"conversion script must not expose legacy host");
 const content=await check("/api/content");
 assert.ok(!content.text.includes("the-toefl-house.pages.dev"),"public CMS JSON must use the short host");
 const tools=await check("/tools/");
 assert.equal(tools.r.status,200);
 assert.match(tools.r.headers.get("x-robots-tag")||"",/noindex/);
});

test("robots allow the official public site and keep private/utility routes out of search",async()=>{
 const robots=await check("/robots.txt");
 assert.equal(robots.r.status,200);
 if(isPreview)assert.match(robots.text,/Disallow: \//);
 else {
  assert.match(robots.text,/Allow: \//);
  assert.match(robots.text,/Sitemap: https:\/\/toeflhouse\.pages\.dev\/sitemap\.xml/);
  assert.match(robots.text,/Disallow: \/admin\//);
 }
 const sitemap=await check("/sitemap.xml");
 assert.equal(sitemap.r.status,200);
 assert.ok(sitemap.text.includes(origin),"sitemap must use the short domain");
 assert.ok(!sitemap.text.includes("the-toefl-house.pages.dev"),"legacy hostname must not appear in sitemap");
 const admin=await check("/admin/");
 assert.equal(admin.r.status,404);
 assert.equal(admin.r.headers.get("location"),null);
 const post=await check("/fa/",{method:"POST"});
 assert.equal(post.r.status,405);
 assert.equal(post.r.headers.get("allow"),"GET, HEAD");
});

test("query attribution stays on short host without redirect",async()=>{
 const {r,text}=await check("/fa/admissions/?program=special-speaking&utm_source=facebook");
 assert.equal(r.status,200);
 assert.equal(r.headers.get("location"),null);
 assert.ok(text.includes("v2-program-preview"));
});
