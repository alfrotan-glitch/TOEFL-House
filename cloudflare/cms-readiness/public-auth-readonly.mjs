// Scheduled production security monitoring: GET and HEAD requests ONLY.
// POST/PUT/PATCH/PUBLISH/RESTORE are intentionally absent.
import assert from "node:assert/strict";
const base=(process.env.TOEFL_QA_BASE||"https://toeflhouse.pages.dev").replace(/\/$/,"");
const checks=[],errors=[];
async function read(path){
 const url=new URL(path,base);
 if(url.origin!==base)throw Error("Unexpected offsite request");
 const r=await fetch(url,{method:"GET",redirect:"manual",signal:AbortSignal.timeout(16000),headers:{"Accept":"application/json"}});
 checks.push({path,status:r.status,type:(r.headers.get("content-type")||"").split(";")[0]});
 return r;
}
for(const path of ["/api/admin/revisions","/api/admin/upload?slot=read-only-qa",
"/api/admin/upload?announcementId=read-only-qa"]){
 const r=await read(path);
 if(![401,403].includes(r.status))errors.push("Protected endpoint "+path+" returned "+r.status);
 if(r.headers.get("cache-control")?.includes("public"))
  errors.push("Protected endpoint "+path+" cache is public");
}
const admin=await read("/admin/");
if(admin.status!==200)errors.push("Admin page unavailable");
if(!admin.headers.get("x-robots-tag")?.includes("noindex"))errors.push("Admin page indexable");
if(!admin.headers.get("content-security-policy")?.includes("frame-ancestors"))errors.push("Admin page lacks frame-ancestors");
const pub=await read("/api/content");
if(pub.status!==200)errors.push("Public CMS unavailable");
else{
 let j;
 try{j=await pub.json()}catch{errors.push("Invalid public CMS JSON")}
 if(j){
  if(j.cmsStatus!=="connected")errors.push("CMS disconnected");
  for(const lang of ["en","fa","ps"])
   if(!Array.isArray(j.locales?.[lang]?.programs)||j.locales[lang].programs.length!==7)
    errors.push(lang+" published course catalog malformed");
  const forbidden=["password_hash","password_salt","totp_secret","token_hash","staff_users","onboarding_invites","sessions","drafts"];
  const keys=[];
  (function scan(x){if(Array.isArray(x))return x.forEach(scan);if(x&&typeof x==="object")for(const [key,value]of Object.entries(x)){keys.push(key);scan(value)}})(j);
  if(keys.some(key=>forbidden.includes(key.toLowerCase())))errors.push("Public API exposes private auth-related key");
 }
}
console.log(JSON.stringify({count:checks.length,errors,checks},null,2));
assert.deepEqual(errors,[],"Read-only production CMS monitoring failed");
