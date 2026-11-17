import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.mjs";

const canonical="https://the-toefl-house.pages.dev";
const preview="https://v18upgrade.the-toefl-house.pages.dev";
const pinned="https://0c14f299.the-toefl-house.pages.dev";

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
    assert.match(s,/\"whatsapp\"/);
    assert.match(s,/\"phone\"/);
    assert.match(s,/\"admissions\"/);
    assert.match(s,/location\.hostname!==\"the-toefl-house\.pages\.dev\"/);
    assert.doesNotMatch(s,/form\.elements|formData|localStorage/i);
  });
});

test("main homepage HTML is original but enhanced without losing CSP",async()=>{
  await withMocks(async called=>{
    const r=await worker.fetch(new Request(canonical+"/"),{});
    const h=await r.text();
    assert.equal(r.status,200);
    assert.equal(called[0].url,pinned+"/");
    assert.match(h,/<h1>Preserved<\/h1>/);
    assert.match(h,/engagement-v1\.js/);
    assert.match(h,/engagement-v1\.css/);
    assert.equal(r.headers.get("X-Robots-Tag"),null);
    assert.match(r.headers.get("Content-Security-Policy"),/toefl-house-conversions\.alfrotan2\.workers\.dev/);
    assert.equal(r.headers.get("Content-Length"),null);
    assert.equal(r.headers.get("ETag"),null);
  });
});

test("preview HTML is noindex and click JavaScript cannot count preview",async()=>{
  await withMocks(async()=>{
    const r=await worker.fetch(new Request(preview+"/fa/"),{});
    assert.match(r.headers.get("X-Robots-Tag"),/noindex/);
    assert.match(await r.text(),/engagement-v1\.js/);
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

test("production POST forwards original request path and full request body",async()=>{
  await withMocks(async called=>{
    const payload='{"test":true}';
    const r=await worker.fetch(new Request(canonical+"/api/private/action",{
      method:"POST",headers:{"Content-Type":"application/json"},body:payload
    }),{});
    assert.equal(r.status,200);
    assert.equal(called[0].url,pinned+"/api/private/action");
    assert.equal(called[0].method,"POST");
    assert.equal(called[0].body,payload);
  });
});

test("strict no-script CSP is never weakened for SEO pages",async()=>{
  let called=[];
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async request=>{
    called.push(request.url);
    return new Response('<html><head></head><body>Course</body></html>',{
      headers:{"Content-Type":"text/html","Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'"}
    });
  };
  try{
    const r=await worker.fetch(new Request(canonical+"/courses/toefl-preparation/"),{});
    assert.doesNotMatch(await r.text(),/engagement-v1/);
    assert.match(r.headers.get("Content-Security-Policy"),/default-src 'none'/);
    assert.equal(called.length,1);
  }finally{globalThis.fetch=oldFetch;}
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
