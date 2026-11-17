import assert from "node:assert/strict";

const host = "https://the-toefl-house.pages.dev";
const routes = [
  "/",
  "/fa/",
  "/ps/",
  "/admissions/",
  "/courses/toefl-preparation/"
];

const results = [];
for (const route of routes) {
  const url = host + route;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: { "User-Agent": "TOEFLHouseSiteVerification/1.0" }
  });
  const html = await response.text();
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";
  const h1s = [...html.matchAll(/<h1\b[^>]*>/gi)].length;
  const language = html.match(/<html\b[^>]*\blang=["']([^"']+)/i)?.[1] ?? "";
  const dir = html.match(/<html\b[^>]*\bdir=["']([^"']+)/i)?.[1] ?? "";
  const expectedCopy = {
    "/": "Admissions open · Free placement assessment",
    "/fa/": "پذیرش جریان دارد · تعیین سطح رایگان",
    "/ps/": "نوم‌لیکنه روانه ده • د سویې معلومول وړیا دي"
  }[route];
  const serverCopySeen = expectedCopy ? html.includes(expectedCopy) : null;
  results.push({route,status:response.status,title,language,dir,h1s,serverCopySeen});
  assert.equal(response.status,200, "Non-200 route: " + route);
  assert.match(response.headers.get("content-type") || "", /text\/html/i);
  assert.ok(title.length > 0, "Missing title on " + route);
  if (h1s !== 1) console.warn("Review heading structure",route,"h1_count",h1s);
}
console.log(JSON.stringify({verified_at:new Date().toISOString(),host,results},null,2));
