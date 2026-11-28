/* Public CMS API is deliberately unavailable on this candidate.
 * The records and their nested fields have not yet been classified by the
 * owner, and the historical client contract (including media) is unknown.
 * A key denylist or a renderer-derived projection cannot establish that the
 * values in a field are public. Return before reading the database, and never
 * delegate to the legacy service. This is a compatibility-breaking safety
 * gate, not an approved schema or a release-ready endpoint. The separately
 * tested projection proposal is offline-only until the required review.
 */
async function v2PublicContent(request,env){
 const headers=new Headers({"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex, nofollow, noarchive"});
 if(!["GET","HEAD"].includes(request.method)){
  headers.set("Allow","GET, HEAD");
  return new Response(JSON.stringify({error:"Method not allowed"}),{status:405,headers});
 }
 return new Response(request.method==="HEAD"?null:JSON.stringify({error:"Public content temporarily unavailable"}),{status:503,headers});
}
