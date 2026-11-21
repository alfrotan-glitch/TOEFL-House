/**
 * Full-name free Cloudflare Pages alias for The TOEFL House.
 * https://toeflhouse.pages.dev/ -> Afghan Dari homepage in-place.
 *
 * Read-only reverse proxy: original production Pages site remains the only
 * source of truth for public content, assets, SEO, student admissions, CMS.
 * Original admin/private endpoints are never proxied and visitor cookies
 * or credentials are never sent upstream.
 */
const UPSTREAM = "https://the-toefl-house.pages.dev";
const SHORT_HOST = "toeflhouse.pages.dev";
const HTML_TYPE = /text\/html(?:\s*;|$)/i;
const BLOCKED = /^\/(?:admin(?:\/|$)|cms(?:\/|$)|login(?:\/|$)|logout(?:\/|$)|dashboard(?:\/|$)|api\/(?!content(?:\/|$))|__th\/(?!v2\/(?:site\.(?:css|js)|font\/vazirmatn-33\.003\.woff2)$|engagement-v1\.js$))/i;

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    if (incoming.hostname !== SHORT_HOST && !incoming.hostname.endsWith("." + SHORT_HOST)) {
      return new Response("Unknown hostname", {status: 421});
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {status: 405, headers: {"Allow": "GET, HEAD"}});
    }
    if (incoming.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", {
        status: 200,
        headers: {"Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600"}
      });
    }
    const translated = incoming.pathname === "/" ? "/fa/" :
      incoming.pathname === "/en/" ? "/" :
      incoming.pathname.startsWith("/en/") ? incoming.pathname.slice(3) : incoming.pathname;
    const upstreamUrl = new URL(translated + incoming.search, UPSTREAM);
    if (BLOCKED.test(incoming.pathname)) {
      return Response.redirect(upstreamUrl.href, 307);
    }
    const accept = request.headers.get("accept");
    const headers = new Headers();
    headers.set("Accept", accept && accept.length < 256 ? accept : "*/*");
    headers.set("Accept-Language", request.headers.get("accept-language")?.slice(0,128) || "fa-AF,fa;q=0.9,en;q=0.7");
    let upstream;
    try {
      upstream = await fetch(new Request(upstreamUrl.href, {
        method: request.method,
        headers,
        redirect: "manual",
      }));
    } catch (error) {
      console.error("Short alias origin temporarily unavailable", String(error));
      return Response.redirect(upstreamUrl.href, 302);
    }

    // Preserve location on our alias for ordinary public navigation.
    if ([301,302,303,307,308].includes(upstream.status)) {
      const location = upstream.headers.get("location");
      if (location) {
        try {
          const next = new URL(location, upstreamUrl);
          if (next.hostname === new URL(UPSTREAM).hostname) {
            next.hostname = SHORT_HOST;
            return Response.redirect(next.href, upstream.status);
          }
        } catch {}
      }
    }
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("set-cookie");
    responseHeaders.delete("content-length");
    responseHeaders.delete("content-encoding");
    responseHeaders.set("X-Robots-Tag", "noindex, follow, noarchive");
    responseHeaders.set("X-Content-Type-Options", "nosniff");
    responseHeaders.set("X-Shortlink-Source", "the-toefl-house.pages.dev");
    const response = new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });

    // The short root is intentionally Dari. Ensure the English language
    // switch still reaches /en/ instead of returning to the Dari root.
    if (request.method !== "HEAD" && upstream.ok && HTML_TYPE.test(upstream.headers.get("content-type") || "")) {
      const english = incoming.pathname !== "/" &&
        !incoming.pathname.startsWith("/fa/") &&
        !incoming.pathname.startsWith("/ps/");
      return new HTMLRewriter()
        .on('a[hreflang="en"]', {
          element(el) { if (el.getAttribute("href") === "/") el.setAttribute("href", "/en/"); }
        })
        .on('a[href="/"]', {
          element(el) { if (english) el.setAttribute("href", "/en/"); }
        })
        .on('a[href^="/#"]', {
          element(el) {
            if (english) {
              const href = el.getAttribute("href");
              if (href) el.setAttribute("href", "/en/" + href.slice(1));
            }
          }
        })
        .transform(response);
    }
    return response;
  }
};
