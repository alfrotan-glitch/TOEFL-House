import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.mjs";

const canonical="https://toeflhouse.pages.dev";
const preview="https://f3d23a88.toeflhouse.pages.dev";

const nativeFetch=globalThis.fetch;
const nativeRewriter=globalThis.HTMLRewriter;
class FakeRewriter {
  constructor(){this.hooks=[];}
  on(selector,handler){this.hooks.push({selector,handler});return this;}
  transform(response){
    const hooks=this.hooks;
    const stream=new ReadableStream({async start(controller){
      let html=await response.text();
      for(const {selector,handler} of hooks){
        const injected=[];
        handler.element({append(str){injected.push(str);}});
        html=html.replace("</"+selector+">",injected.join("")+"</"+selector+">");
      }
      controller.enqueue(new TextEncoder().encode(html));
      controller.close();
    }});
    return new Response(stream,{status:200,headers:response.headers});
  }
}
async function withMocks(fn){
  let called=[];
  globalThis.fetch=async request=>{
    called.push({url:request.url,method:request.method,body:!["GET","HEAD"].includes(request.method)?await request.text():null});
    const h={"Content-Type":"text/html; charset=utf-8",
      "Content-Security-Policy":"default-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      "X-Robots-Tag":"noindex, nofollow, noarchive",
      "Content-Length":"97","ETag":'"old-version"'};
    return new Response('<html><head><title>Original</title></head><body><h1>Preserved</h1></body></html>',{headers:h});
  };
  globalThis.HTMLRewriter=FakeRewriter;
  try{return await fn(called);}
  finally{globalThis.fetch=nativeFetch;globalThis.HTMLRewriter=nativeRewriter;}
}

test("health endpoint is public but does not touch upstream",async()=>{
  await withMocks(async called=>{
    const resp=await worker.fetch(new Request(canonical+"/__th/health"),{});
    assert.equal(resp.status,200);
    assert.equal((await resp.json()).pinned,"2026-11-09");
    assert.equal(called.length,0);
  });
});

test("the same-origin event script avoids PII and supports click types",async()=>{
  await withMocks(async()=>{
    const r=await worker.fetch(new Request(canonical+"/__th/engagement-v1.js"),{});
    const s=await r.text();
    assert.equal(r.status,200);
    assert.match(s,/sendBeacon/);
    assert.match(s,/querySelector\(\"#v2-program\"\)/);
    assert.match(s,/fromForm=selected&&selected.value/);
    assert.match(s,/fromQuery=new URLSearchParams/);
    assert.match(s,/\"whatsapp\"/);
    assert.match(s,/\"phone\"/);
    assert.match(s,/\"admissions\"/);
    assert.match(s,/location\.hostname!==\"toeflhouse\.pages\.dev\"/);
    assert.doesNotMatch(s,/form\.elements|formData|localStorage/i);
  });
});

test("unhandled homepage path returns a local 404 without contacting the retired origin",async()=>{
  await withMocks(async called=>{
    const r=await worker.fetch(new Request(canonical+"/"),{});
    assert.equal(r.status,404);
    assert.equal(called.length,0);
    assert.match(r.headers.get("X-Robots-Tag"),/noindex/);
    assert.match(await r.text(),/Not found/);
  });
});

test("preview health response is noindex",async()=>{
  await withMocks(async()=>{
    const r=await worker.fetch(new Request(preview+"/__th/health"),{});
    assert.equal(r.status,200);
    assert.match(r.headers.get("X-Robots-Tag"),/noindex/);
    assert.match(await r.text(),/toefl-house-edge-upgrade/);
  });
});

test("preview is read-only: no production CMS mutation",async()=>{
  await withMocks(async called=>{
    const r=await worker.fetch(new Request(preview+"/api/admin/content",{
      method:"POST",headers:{"Content-Type":"application/json"},body:'{"name":"should-never-be-written"}'
    }),{});
    assert.equal(r.status,403);
    assert.equal(called.length,0);
  });
});

test("unknown production API paths fail locally instead of proxying to a deleted origin",async()=>{
  await withMocks(async called=>{
    const payload='{"test":true}';
    const r=await worker.fetch(new Request(canonical+"/api/private/action",{
      method:"POST",headers:{"Content-Type":"application/json"},body:payload
    }),{});
    assert.equal(r.status,404);
    assert.equal(called.length,0);
    assert.match(r.headers.get("X-Robots-Tag"),/noindex/);
  });
});

test("unknown legacy paths return a local 404 without weakening or fetching CSP",async()=>{
  await withMocks(async called=>{
    const r=await worker.fetch(new Request(canonical+"/legacy-retired-page/"),{});
    assert.equal(r.status,404);
    assert.equal(called.length,0);
    assert.match(r.headers.get("X-Robots-Tag"),/noindex/);
    assert.equal(r.headers.get("Content-Security-Policy"),null);
  });
});

test("preserved static assets use local ASSETS storage",async()=>{
  await withMocks(async called=>{
    const assets=[];
    const env={ASSETS:{fetch:async r=>{assets.push(r.url);return new Response("original font",{status:200})}}};
    const r=await worker.fetch(new Request(canonical+"/assets/fonts/NotoSansArabic-400.woff2"),env);
    assert.equal(await r.text(),"original font");
    assert.equal(assets.length,1);
    assert.equal(called.length,0);
  });
});

test("preview robots always noindex even for JSON",async()=>{
  await withMocks(async()=>{
    const r=await worker.fetch(new Request(preview+"/api/content"),{});
    assert.match(r.headers.get("X-Robots-Tag"),/noindex/);
  });
});


test("Legacy tools brand correction is scoped and does not touch data entry",async()=>{
 await withMocks(async()=>{
  const r=await worker.fetch(new Request(canonical+"/__th/tools-brand-v1.js"),{});
  assert.equal(r.status,200);
  const script=await r.text();
  assert.ok(script.includes("خانه موفقیت"));
  assert.ok(script.includes("document.createTreeWalker"));
  assert.ok(script.includes("MutationObserver"));
  assert.ok(script.includes("script,style,noscript,textarea,option"));
  for(const forbidden of ["fetch(","XMLHttpRequest","sendBeacon","localStorage","sessionStorage"])assert.ok(!script.includes(forbidden));
  const tools=await worker.fetch(new Request(canonical+"/fa/tools/"),{
   ASSETS:{fetch:async request=>new Response('<html><head><title>Student tools</title></head><body><main>Tools app</main></body></html>',{headers:{"Content-Type":"text/html; charset=utf-8"}})}
  });
  assert.equal(tools.status,200);
  assert.ok((await tools.text()).includes("tools-brand-v1.js"));
  const home=await worker.fetch(new Request(canonical+"/fa/"),{});
  assert.ok(!(await home.text()).includes("tools-brand-v1.js"));
 });
});

test("HTML asset routing distinguishes public responses from deployment manifest",async()=>{
 for(const path of ['/index.html','/404.html','/fa/index.html','/fa/404.html','/ps/index.html','/ps/404.html']){
  for(const status of [200,301,404]){
   const requested=[];
   const env={ASSETS:{fetch:async req=>{requested.push(new URL(req.url).pathname);return new Response(status===200?'static asset':null,{status});}}};
   const r=await worker.fetch(new Request(canonical+path),env);
   assert.deepEqual(requested,[path]);
   assert.equal(r.status,status===200?200:404,`${path} ASSETS returned ${status}`);
   if(status===200)assert.equal(await r.text(),'static asset');
  }
 }
 for(const [path,asset] of [['/tools/','/index.html'],['/fa/tools/','/fa/index.html'],['/ps/tools/','/ps/index.html']]){
  const requested=[];
  const env={ASSETS:{fetch:async req=>{requested.push(new URL(req.url).pathname);return new Response(null,{status:301});}}};
  const r=await worker.fetch(new Request(canonical+path),env);
  assert.deepEqual(requested,[asset]);assert.equal(r.status,503,`${path} rejects a non-OK internal asset response`);
 }
});
