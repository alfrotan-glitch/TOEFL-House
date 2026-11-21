import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";

const base=(process.env.TH_SHORT_BASE||"https://shortlink-preview.thaf.pages.dev").replace(/\/$/,"");
const origin="https://the-toefl-house.pages.dev";
const header={"User-Agent":"TOEFL-House-short-link-acceptance/1.0","Accept":"text/html,application/json,*/*"};

async function check(path, options={}){
  const r=await fetch(base+path,{
    ...options,
    headers:{...header,...(options.headers||{})},
    redirect:"manual",
    signal:AbortSignal.timeout(25000),
  });
  return {r,text:await r.text()};
}

test("short link root serves Dari in-place and keeps original canonical",async()=>{
 const {r,text}=await check("/");
 assert.equal(r.status,200,"root should not redirect to long URL");
 assert.match(r.headers.get("content-type")||"",/text\/html/);
 assert.match(r.headers.get("x-robots-tag")||"",/noindex/);
 assert.equal(r.headers.get("x-shortlink-source"),"the-toefl-house.pages.dev");
 assert.match(text,/<html lang="fa-AF" dir="rtl">/);
 assert.ok(text.includes(origin+"/fa/"),"SEO canonical remains original production");
 assert.ok(text.includes('hreflang="en" href="/en/"'),"English language switch must function");
 assert.ok(text.includes('href="/fa/"'),"Dari language path");
 assert.ok(text.includes('href="/ps/"'),"Pashto language path");
});

test("localized pages and complete admissions function without redirect",async()=>{
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
  assert.equal(r.headers.get("x-shortlink-source"),"the-toefl-house.pages.dev");
  assert.match(r.headers.get("x-robots-tag")||"",/noindex/);
 }
});

test("public CSS, JS, favicon and CMS remain usable",async()=>{
 for(const [path,type] of [
  ["/__th/v2/site.css",/text\/css/],
  ["/__th/v2/site.js",/javascript/],
  ["/assets/aistudio/favicon_afa00a26.png",/image\/png/],
  ["/api/content",/application\/json/]
 ]){
  const {r}=await check(path);
  assert.equal(r.status,200,path);
  assert.match(r.headers.get("content-type")||"",type,path);
 }
});

test("robots exclusion, private admin isolation and method safety",async()=>{
 const robots=await check("/robots.txt");
 assert.equal(robots.r.status,200);
 assert.match(robots.text,/Disallow: \//);
 const admin=await check("/admin/");
 assert.equal(admin.r.status,307);
 assert.equal(admin.r.headers.get("location"),origin+"/admin/");
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

test("self-origin Persian font stays intact on short domain and legacy university term is absent from Dari",async()=>{
 const r=await fetch(base+"/__th/v2/font/vazirmatn-33.003.woff2",{redirect:"manual",signal:AbortSignal.timeout(25000)});
 assert.equal(r.status,200,"Font must load on alias, not redirect to another host");
 assert.equal(r.headers.get("location"),null);
 assert.match(r.headers.get("content-type")||"",/font\/woff2/);
 const bytes=Buffer.from(await r.arrayBuffer());
 assert.equal(bytes.subarray(0,4).toString(),"wOF2");
 assert.equal(createHash("sha256").update(bytes).digest("hex"),"4e3fa217d38fdafc1fea4414ceb58ca5e662cf0ab5fa735a8c8c20e8b42cad92");
 const home=await check("/");
 assert.equal(home.r.status,200);
 assert.ok(!home.text.includes("پوهنتون"),"Dari content should use دانشگاه");
 assert.ok(home.text.includes("دانشگاه"),"Dari university term should be present");
});
