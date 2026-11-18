// Public bundle inspection only. No requests to protected endpoints and no credentials.
const asset="https://the-toefl-house.pages.dev/assets/index-Ch3KjNPK.js";
const r=await fetch(asset,{signal:AbortSignal.timeout(25000)});
if(!r.ok)throw Error("Frontend bundle not available: HTTP "+r.status);
const raw=await r.text();
const interesting=[...new Set(
 [...raw.matchAll(/(?:['"\x60])((?:\/api\/)[a-z0-9_{}?=&./-]{2,120})(?:['"\x60])/gi)].map(x=>x[1])
)].sort();
const patterns=[...new Set(
 [...raw.matchAll(/(?:api\/)[a-z0-9_{}?=&./-]{3,90}/gi)].map(x=>x[0].replace(/[?].*/,""))
)].sort();
console.log(JSON.stringify({assetStatus:r.status,bytes:Buffer.byteLength(raw),literalRoutes:interesting,
 routeFragments:patterns.slice(0,100),routeCount:interesting.length},null,2));

const cms=await fetch("https://the-toefl-house.pages.dev/api/content",{signal:AbortSignal.timeout(15000)});
if(!cms.ok)throw Error("Public content unavailable");
const c=await cms.json();
const keys=x=>x&&typeof x==="object"?Object.keys(x):[];
const shape={topLevel:keys(c),content:keys(c.content),data:keys(c.data),locales:keys(c.locales),ps:keys(c.ps),pashto:keys(c.pashto),contentLocales:keys(c.content?.locales),cmsStatus:c.cmsStatus,revisionType:typeof c.revision};
console.log("CMS_SHAPE="+JSON.stringify(shape));
