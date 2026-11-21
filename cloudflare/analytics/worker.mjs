const ORIGIN = "https://toeflhouse.pages.dev";
const REDIRECTS = {
  "/wa": { event: "whatsapp", destination: "https://wa.me/93794357509" },
  "/call": { event: "phone", destination: "tel:+93745651844" },
  "/apply": { event: "admissions", destination: ORIGIN + "/admissions/" }
};
const baseHeaders = {
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff"
};
function safeLabel(value, fallback, max=48) {
  return typeof value === "string" && value.length <= max && /^[a-z0-9][a-z0-9_-]*$/.test(value)
    ? value : fallback;
}
function pageResponse(message, status=200) {
  return new Response(message, {status,headers:{...baseHeaders,"Content-Type":"text/plain; charset=utf-8"}});
}
async function record(env, action, source, campaign, course) {
  const today = new Date().toISOString().slice(0,10);
  await env.EVENTS.prepare(
    "INSERT INTO conversion_clicks(day_utc,action,source,campaign,course,clicks) VALUES(?,?,?,?,?,1) " +
    "ON CONFLICT(day_utc,action,source,campaign,course) DO UPDATE SET clicks=clicks+1"
  ).bind(today,action,source,campaign,course).run();
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/,"") || "/";
    if (path === "/health") {
      return new Response(JSON.stringify({ok:true,service:"toefl-house-conversion-links",v:1}),{
        status:200,headers:{...baseHeaders,"Content-Type":"application/json; charset=utf-8"}
      });
    }
    if (path === "/robots.txt") return pageResponse("User-agent: *\nDisallow: /\n");
    const route = REDIRECTS[path];
    if (route && (request.method === "GET" || request.method === "HEAD")) {
      if (request.method === "GET" &&
          !/prefetch/i.test((request.headers.get("Purpose")||"")+" "+(request.headers.get("Sec-Purpose")||""))) {
        const source = safeLabel(url.searchParams.get("s"),"website",32);
        const campaign = safeLabel(url.searchParams.get("c"),"site_cta",48);
        const course = safeLabel(url.searchParams.get("p"),"all",48);
        ctx.waitUntil(record(env,route.event,source,campaign,course)
          .catch(error=>console.error("Conversion storage failed:",String(error))));
      }
      return new Response(null,{status:302,headers:{...baseHeaders,"Location":route.destination}});
    }
    if (path === "/e" && request.method === "OPTIONS") {
      const origin = request.headers.get("Origin");
      if (origin !== ORIGIN) return pageResponse("Forbidden",403);
      return new Response(null,{status:204,headers:{
        ...baseHeaders,"Access-Control-Allow-Origin":ORIGIN,
        "Access-Control-Allow-Methods":"POST, OPTIONS",
        "Access-Control-Allow-Headers":"Content-Type",
        "Access-Control-Max-Age":"600","Vary":"Origin"
      }});
    }
    if (path === "/e" && request.method === "POST") {
      const origin = request.headers.get("Origin");
      if (origin !== ORIGIN) return pageResponse("Forbidden",403);
      const contentType = request.headers.get("Content-Type")||"";
      if (!/^(application\/json|text\/plain)/i.test(contentType)) return pageResponse("Unsupported Media Type",415);
      if (Number(request.headers.get("Content-Length")||0)>1024) return pageResponse("Too large",413);
      let data;
      try {
        const raw = await request.text();
        if(raw.length>1024) return pageResponse("Too large",413);
        data = JSON.parse(raw);
      } catch (_) { return pageResponse("Bad JSON",400); }
      if (!data || !["whatsapp","phone","admissions"].includes(data.action)) return pageResponse("Bad action",400);
      try {
        await record(env,data.action,
          safeLabel(data.source,"website",32),
          safeLabel(data.campaign,"site_cta",48),
          safeLabel(data.course,"all",48));
      } catch (error) {
        console.error("Conversion storage failed:",String(error));
        return pageResponse("Unavailable",503);
      }
      return new Response(null,{status:204,headers:{...baseHeaders,"Access-Control-Allow-Origin":ORIGIN,"Vary":"Origin"}});
    }
    return pageResponse("Not found",404);
  }
};
