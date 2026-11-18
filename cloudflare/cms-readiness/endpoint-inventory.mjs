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
