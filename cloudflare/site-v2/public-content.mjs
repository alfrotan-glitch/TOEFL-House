/* Public, read-only CMS endpoint.
 * The historical pinned upstream's /api/content is returning HTTP 503.
 * Reconstruct only the documented published public payload from the EXISTING
 * Pages D1 binding. This route never reads drafts, sessions, staff or secrets.
 * All authenticated editor endpoints remain routed to their original service.
 */
async function v2PublicContent(request,env){
 if(!["GET","HEAD"].includes(request.method))return null;
 const headers=new Headers({"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex, nofollow, noarchive"});
 if(!env?.CMS_DB)return new Response(JSON.stringify({error:"Public content temporarily unavailable"}),{status:503,headers});
 try{
  const [main,ps]=await Promise.all([
   env.CMS_DB.prepare("SELECT body,revision,updated_at FROM content WHERE id='main'").first(),
   env.CMS_DB.prepare("SELECT body,revision,updated_at FROM pashto_content WHERE id='main'").first()
  ]);
  if(!main?.body||!ps?.body||!Number.isInteger(main.revision)||!Number.isInteger(ps.revision))throw Error("Missing published CMS revision");
  const published=JSON.parse(main.body),pashto=JSON.parse(ps.body);
  if(!Array.isArray(published?.locales?.en?.programs)||!Array.isArray(published?.locales?.fa?.programs)||!Array.isArray(pashto?.programs))throw Error("Invalid published content structure");
  const forbidden=new Set(["password","password_hash","password_salt","totp_secret","token_hash",
   "session_token","session_cookie","private_key","api_key","onboarding_invites",
   "staff_users","login_attempts","drafts","cms_draft_recovery_archive","authorization","editor"]);
  function publicOnly(value){
   if(Array.isArray(value))return value.map(publicOnly);
   if(!value||typeof value!=="object")return value;
   return Object.fromEntries(Object.entries(value).filter(([key])=>!forbidden.has(key.toLowerCase())).map(([key,item])=>[key,publicOnly(item)]));
  }
  const payload=publicOnly({locales:{en:published.locales.en,fa:published.locales.fa,ps:pashto},
   media:published.media||{},timetable:published.timetable||{},
   revision:main.revision,psRevision:ps.revision,updatedAt:main.updated_at||"",cmsStatus:"connected"});
  if(Object.values(payload.locales).some(locale=>!Array.isArray(locale?.programs)||locale.programs.length!==7))throw Error("Unapproved public program count");
  function verify(value){
   if(Array.isArray(value)){for(const item of value)verify(item);return;}
   if(!value||typeof value!=="object")return;
   for(const [key,item] of Object.entries(value)){if(forbidden.has(key.toLowerCase()))throw Error("Protected key in public content");verify(item);}
  }
  verify(payload);
  const body=JSON.stringify(payload);
  if(body.length>3_000_000)throw Error("Public content exceeds safe size");
  headers.set("Content-Language","en");
  return new Response(request.method==="HEAD"?null:body,{status:200,headers});
 }catch(error){
  console.error("Read-only published CMS response failed",String(error));
  return new Response(request.method==="HEAD"?null:JSON.stringify({error:"Public content temporarily unavailable"}),{status:503,headers});
 }
}
