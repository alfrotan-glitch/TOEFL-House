/**
 * Production CMS authorization regression. Read-only or intentionally invalid,
 * unauthenticated requests ONLY; no session, token, key, or real content.
 *
 * This test must NEVER submit a valid publish/restore/upload payload.
 */
import assert from "node:assert/strict";
const base="https://the-toefl-house.pages.dev";
const checked=[],failures=[];
function expectUnauth(r,name,allowed=[401,403]){
  checked.push({name,status:r.status,contentType:r.headers.get("content-type")?.split(";")[0]||"",cache:r.headers.get("cache-control")||""});
  if(!allowed.includes(r.status))failures.push(name+" unauthenticated request returned HTTP "+r.status);
}
function safeUrl(path){const u=new URL(path,base);if(u.origin!==base)throw Error("Refusing off-site request");return u.href;}
const options=(method,origin)=>({
  method,redirect:"manual",signal:AbortSignal.timeout(14000),
  headers:{"Accept":"application/json",...(origin?{"Origin":origin}:{}),
    ...(["POST","PUT","PATCH"].includes(method)?{"Content-Type":"application/json"}:{})},
  ...(["POST","PUT","PATCH"].includes(method)?{body:"{}"}:{})
});
const writePaths=["/api/admin/save-draft","/api/admin/publish","/api/admin/restore"];
for(const path of writePaths){
  const res=await fetch(safeUrl(path),options("POST"));
  expectUnauth(res,path+" POST");
  const invalidCrossSite=await fetch(safeUrl(path),options("POST","https://cms-qa-external.invalid"));
  expectUnauth(invalidCrossSite,path+" cross-site POST",[400,401,403,405]);
  if((invalidCrossSite.headers.get("access-control-allow-origin")||"").includes("cms-qa-external.invalid"))
    failures.push(path+" unexpectedly allows untrusted cross-origin requests");
}
const revisions=await fetch(safeUrl("/api/admin/revisions"),options("GET"));
expectUnauth(revisions,"/api/admin/revisions GET");
if((revisions.headers.get("cache-control")||"").match(/\bpublic\b|max-age=/i))
  failures.push("Protected revisions response is publicly cacheable");
for(const path of ["/api/admin/upload?slot=qa-invalid","/api/admin/upload?announcementId=qa-invalid"]){
  const r=await fetch(safeUrl(path),options("GET"));
  expectUnauth(r,path+" GET",[401,403,405]);
}
const admin=await fetch(safeUrl("/admin/"),{signal:AbortSignal.timeout(14000)});
checked.push({name:"Admin HTML",status:admin.status,robots:admin.headers.get("x-robots-tag"),csp:!!admin.headers.get("content-security-policy")});
if(admin.status!==200||!admin.headers.get("x-robots-tag")?.includes("noindex"))
  failures.push("Admin HTML not protected from indexing");
if(!admin.headers.get("content-security-policy")?.includes("frame-ancestors"))
  failures.push("Admin HTML lacks frame-ancestors CSP");
const publicCMS=await fetch(safeUrl("/api/content"),{signal:AbortSignal.timeout(15000)});
checked.push({name:"Published content",status:publicCMS.status});
if(publicCMS.status!==200)failures.push("Public CMS unavailable");
else{
  const raw=await publicCMS.text();
  let parsed;
  try{parsed=JSON.parse(raw)}catch{failures.push("Published CMS is not JSON");}
  if(parsed){
    if(parsed.cmsStatus!=="connected")failures.push("Published CMS disconnected");
    // Never dump the public JSON. Verify forbidden private *key names*, not public prose.
    const forbidden=/(?:^|["'{,])\s*"(?:password_hash|password_salt|totp_secret|session_token|token_hash|onboarding_invites|staff_users|login_attempts|secret_key|private_key)"\s*:/i;
    if(forbidden.test(raw))failures.push("Sensitive authentication field present in public content");
  }
}
console.log(JSON.stringify({checked:checked.length,failures,results:checked},null,2));
assert.deepEqual(failures,[],"Protected CMS guard regression");
