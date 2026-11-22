/**
 * Public marketing/CMS content recovery snapshot.
 *
 * WARNING: This is NOT an authenticated D1 database backup. Never store drafts,
 * account records, sessions or secrets in GitHub artifacts. We snapshot ONLY
 * the exact already-public /api/content response after an explicit allowlist
 * and secret-key validation.
 */
import {createHash} from "node:crypto";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import assert from "node:assert/strict";
const origin="https://toeflhouse.pages.dev";
const response=await fetch(origin+"/api/content",{
  headers:{Accept:"application/json"},
  signal:AbortSignal.timeout(20000)
});
assert.equal(response.status,200,"Public CMS unavailable");
const mime=response.headers.get("content-type")||"";
assert.match(mime,/application\/json/,"Unexpected CMS content type");
const raw=await response.text();
assert.ok(Buffer.byteLength(raw)<3_000_000,"Unexpected oversized public payload");
const parsed=JSON.parse(raw);
assert.equal(parsed.cmsStatus,"connected","CMS is disconnected");
assert.ok(Number.isInteger(parsed.revision)&&parsed.revision>0);
assert.ok(Number.isInteger(parsed.psRevision)&&parsed.psRevision>0);
const langs=["en","fa","ps"];
for(const lang of langs){
  const locale=parsed.locales?.[lang];
  assert.ok(locale&&typeof locale==="object",lang+" locale missing");
  const programs=locale.programs;
  assert.ok(Array.isArray(programs)&&programs.length===7,lang+" must contain seven published programs");
  const ids=programs.map(p=>p.id);
  assert.equal(new Set(ids).size,ids.length,lang+" has duplicate programs");
  assert.ok(ids.includes("toefl-preparation"),lang+" TOEFL course missing");
}
const allowed=["locales","media","timetable","revision","updatedAt","cmsStatus","psRevision"];
assert.deepEqual(Object.keys(parsed).sort(),[...allowed].sort(),"Public response added unexpected top-level fields: review required");
const suspiciousKeys=new Set(["password","password_hash","password_salt","totp_secret","token_hash",
"session_token","session_cookie","private_key","api_key","onboarding_invites","staff_users",
"login_attempts","drafts","cms_draft_recovery_archive","authorization"]);
function checkSensitive(data,path="root"){
 if(Array.isArray(data)){for(let i=0;i<data.length;i++)checkSensitive(data[i],path+"["+i+"]");return;}
 if(!data||typeof data!=="object")return;
 for(const [key,value] of Object.entries(data)){
  if(suspiciousKeys.has(key.toLowerCase()))throw Error("Unexpected sensitive key at "+path+"."+key);
  checkSensitive(value,path+"."+key);
 }
}
checkSensitive(parsed);
const payload={
 locales:parsed.locales,
 media:parsed.media,
 timetable:parsed.timetable,
 revision:parsed.revision,
 psRevision:parsed.psRevision,
 updatedAt:parsed.updatedAt
};
const canonical=JSON.stringify(payload);
const digest=createHash("sha256").update(canonical).digest("hex");
const directory="toefl-public-content-recovery";
await mkdir(directory,{recursive:true});
await writeFile(directory+"/published-cms.json",JSON.stringify(payload,null,2)+"\n");
const digestFile=await readFile(directory+"/published-cms.json","utf8");
const restored=JSON.parse(digestFile);
assert.deepEqual(restored,payload,"Snapshot roundtrip corruption");
const manifest={
 status:"PUBLIC_CONTENT_ONLY_NOT_DATABASE_BACKUP",
 origin,
 capturedAt:new Date().toISOString(),
 revision:parsed.revision,
 psRevision:parsed.psRevision,
 languages:langs,
 programCountPerLanguage:7,
 sha256Canonical:digest,
 bytes:Buffer.byteLength(digestFile),
 restorationTest:"JSON roundtrip verified, no production write, no D1 restore performed"
};
await writeFile(directory+"/manifest.json",JSON.stringify(manifest,null,2)+"\n");
console.log(JSON.stringify(manifest,null,2));
