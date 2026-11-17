import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.mjs";

function testContext() {
  const written = [];
  const pending = [];
  const env = {
    EVENTS: {
      prepare(sql) {
        assert.match(sql, /INSERT INTO conversion_clicks/);
        return {
          bind(...args) {
            return {
              async run() { written.push(args); return { success: true }; }
            };
          }
        };
      }
    }
  };
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  return { env, ctx, written, pending };
}
const base = "https://toefl-house-conversions.alfrotan2.workers.dev";

test("health check responds without storing a conversion", async () => {
  const x = testContext();
  const r = await worker.fetch(new Request(base + "/health"), x.env, x.ctx);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  assert.deepEqual(x.written, []);
});

test("admissions link redirects and records date, campaign, source and course", async () => {
  const x = testContext();
  const r = await worker.fetch(new Request(base + "/apply?s=facebook&c=launch2026&p=toefl-preparation"), x.env, x.ctx);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("Location"), "https://the-toefl-house.pages.dev/admissions/");
  await Promise.all(x.pending);
  assert.equal(x.written.length, 1);
  assert.equal(x.written[0][1], "admissions");
  assert.equal(x.written[0][2], "facebook");
  assert.equal(x.written[0][3], "launch2026");
  assert.equal(x.written[0][4], "toefl-preparation");
});

test("HEAD redirects without inflating click counts", async () => {
  const x = testContext();
  const r = await worker.fetch(new Request(base + "/wa", {method:"HEAD"}), x.env, x.ctx);
  assert.equal(r.status, 302);
  assert.equal(x.pending.length, 0);
  assert.deepEqual(x.written, []);
});

test("telephone link retains official destination", async () => {
  const x = testContext();
  const r = await worker.fetch(new Request(base + "/call"), x.env, x.ctx);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("Location"), "tel:+93745651844");
  await Promise.all(x.pending);
  assert.equal(x.written[0][1], "phone");
});

test("invalid campaign labels fail closed to defaults", async () => {
  const x = testContext();
  await worker.fetch(new Request(base + "/wa?s=x%20y&c=bad%3Bdrop&p=ok"), x.env, x.ctx);
  await Promise.all(x.pending);
  assert.equal(x.written[0][2], "website");
  assert.equal(x.written[0][3], "site_cta");
});

test("in-page event endpoint blocks other origins", async () => {
  const x = testContext();
  const r = await worker.fetch(new Request(base + "/e", {
    method:"POST",headers:{"Origin":"https://evil.example","Content-Type":"application/json"},
    body:JSON.stringify({action:"whatsapp"})
  }), x.env, x.ctx);
  assert.equal(r.status,403);
  assert.equal(x.written.length,0);
});

test("in-page event from website may count a click", async () => {
  const x = testContext();
  const r = await worker.fetch(new Request(base + "/e", {
    method:"POST",headers:{"Origin":"https://the-toefl-house.pages.dev","Content-Type":"application/json"},
    body:JSON.stringify({action:"whatsapp",source:"website",campaign:"homepage",course:"all"})
  }), x.env, x.ctx);
  assert.equal(r.status,204);
  assert.equal(x.written[0][1],"whatsapp");
});
