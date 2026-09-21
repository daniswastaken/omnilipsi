var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker.js
var VERSION = "0.2.0";
var MAX_URL_LEN = 2048;
var FETCH_TIMEOUT_MS = 15e3;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Omnilipsi/0.2";
var DIRECT_EXTS = /* @__PURE__ */ new Map([
  // video
  ["mp4", "video"],
  ["webm", "video"],
  ["mov", "video"],
  ["m4v", "video"],
  ["mkv", "video"],
  ["avi", "video"],
  ["ogv", "video"],
  // audio
  ["mp3", "audio"],
  ["m4a", "audio"],
  ["ogg", "audio"],
  ["oga", "audio"],
  ["opus", "audio"],
  ["wav", "audio"],
  ["flac", "audio"],
  ["aac", "audio"],
  // image
  ["jpg", "image"],
  ["jpeg", "image"],
  ["png", "image"],
  ["webp", "image"],
  ["gif", "image"],
  ["avif", "image"],
  ["svg", "image"],
  ["bmp", "image"],
  // other downloadable
  ["pdf", "file"],
  ["zip", "file"],
  ["rar", "file"],
  ["7z", "file"],
  ["m3u8", "stream"],
  ["mpd", "stream"]
]);
var YOUTUBE_HOSTS = /* @__PURE__ */ new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be"
]);
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/health") return json({ ok: true, version: VERSION, extractor: extractorStatus(env) });
      if (url.pathname === "/api/info") return await handleInfo(request, env);
      if (url.pathname === "/api/dl") return await handleDl(request);
      if (url.pathname === "/api/extract" && request.method === "POST") return await handleExtractPost(request, env);
      if (env.ASSETS) {
        try {
          return await env.ASSETS.fetch(request);
        } catch {
          return json({ error: "asset error" }, 500);
        }
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: "internal error", detail: String(err?.message || err).slice(0, 300) }, 500);
    }
  }
};
function extractorStatus(env) {
  const base = (env.COBALT_API_URL || "").trim().replace(/\/+$/, "");
  return { enabled: Boolean(base), base: base || null };
}
__name(extractorStatus, "extractorStatus");
async function handleInfo(request, env) {
  const target = new URL(request.url).searchParams.get("url")?.trim() || "";
  const check = validatePublicUrl(target);
  if (!check.ok) return json({ error: check.error }, 400);
  const parsed = new URL(target);
  const ext = extOfPath(parsed.pathname);
  const directKind = DIRECT_EXTS.get(ext);
  if (directKind) {
    const meta = await headMeta(target).catch(() => null);
    const filename = filenameOf(parsed);
    return json({
      url: target,
      kind: directKind,
      source: "direct",
      title: decodeURIComponent(filename),
      thumbnail: directKind === "image" ? target : null,
      needsExtractor: false,
      formats: [
        {
          id: "direct",
          label: `${ext.toUpperCase()} \xB7 direct`,
          ext,
          kind: directKind,
          url: target,
          download: dlUrl(request, target, filename),
          size: meta?.size ?? null,
          contentType: meta?.contentType ?? null
        }
      ]
    });
  }
  let html = "";
  try {
    html = await fetchText(target);
  } catch (e) {
    const cobalt2 = await tryCobalt(target, env);
    if (cobalt2) return json(cobalt2);
    return json({ error: "could not fetch that URL", detail: String(e?.message || e).slice(0, 200) }, 422);
  }
  const scraped = scrapePage(target, html);
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const isYouTube = [...YOUTUBE_HOSTS].some((h) => parsed.hostname.toLowerCase() === h || parsed.hostname.toLowerCase().endsWith("." + h.replace(/^www\./, "")));
  void host;
  if (isYouTube) {
    const oembed = await youtubeOembed(target).catch(() => null);
    const cobalt2 = await tryCobalt(target, env);
    if (cobalt2) {
      if (oembed && !cobalt2.thumbnail) cobalt2.thumbnail = oembed.thumbnail;
      if (oembed && !cobalt2.title) cobalt2.title = oembed.title;
      return json(cobalt2);
    }
    return json({
      url: target,
      kind: "page",
      source: isYouTube ? "youtube-meta" : "page-meta",
      title: oembed?.title || scraped.title,
      author: oembed?.author || scraped.siteName,
      thumbnail: oembed?.thumbnail || scraped.image,
      description: scraped.description,
      needsExtractor: true,
      extractor: extractorStatus(env),
      formats: scraped.formats.map((f) => ({ ...f, download: dlUrl(request, f.url, void 0) })),
      note: "Workers can't run yt-dlp, so YouTube/app links need an extractor backend. Set COBALT_API_URL to enable one-click downloads."
    });
  }
  if (scraped.formats.length > 0) {
    return json({
      url: target,
      kind: "page",
      source: "page-meta",
      title: scraped.title,
      thumbnail: scraped.image,
      description: scraped.description,
      siteName: scraped.siteName,
      needsExtractor: false,
      formats: scraped.formats.map((f) => ({ ...f, download: dlUrl(request, f.url, void 0) }))
    });
  }
  const cobalt = await tryCobalt(target, env);
  if (cobalt) return json(cobalt);
  return json({
    url: target,
    kind: "page",
    source: "page-meta",
    title: scraped.title,
    thumbnail: scraped.image,
    description: scraped.description,
    siteName: scraped.siteName,
    needsExtractor: true,
    extractor: extractorStatus(env),
    formats: [],
    note: "No direct media found in page metadata. This usually means the site loads media via JS or needs yt-dlp/cobalt. Set COBALT_API_URL to handle these links."
  });
}
__name(handleInfo, "handleInfo");
async function handleExtractPost(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: "expected JSON body {url}" }, 400);
  }
  const target = String(body.url || "").trim();
  const check = validatePublicUrl(target);
  if (!check.ok) return json({ error: check.error }, 400);
  const cobalt = await tryCobalt(target, env);
  if (!cobalt) return json({ error: "extractor not configured", hint: "Set COBALT_API_URL (+ COBALT_API_KEY secret) on the Worker." }, 501);
  return json(cobalt);
}
__name(handleExtractPost, "handleExtractPost");
async function handleDl(request) {
  const params = new URL(request.url).searchParams;
  const target = (params.get("url") || "").trim();
  const wantName = (params.get("filename") || "").trim().slice(0, 180);
  const check = validatePublicUrl(target);
  if (!check.ok) return json({ error: check.error }, 400);
  let upstream;
  try {
    const headers = { "User-Agent": UA };
    const range = request.headers.get("Range");
    if (range && /^bytes=/.test(range)) headers["Range"] = range;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS * 4);
    upstream = await fetch(target, { headers, signal: ctrl.signal, redirect: "follow" });
    clearTimeout(t);
  } catch (e) {
    return json({ error: "upstream fetch failed", detail: String(e?.message || e).slice(0, 200) }, 502);
  }
  if (!upstream.ok && upstream.status !== 206) {
    return json({ error: `upstream responded ${upstream.status}` }, 502);
  }
  const parsed = new URL(target);
  const fallback = filenameOf(parsed);
  const filename = sanitizeFilename(wantName || fallback);
  const ct = upstream.headers.get("Content-Type") || "application/octet-stream";
  const out = new Headers();
  out.set("Content-Type", ct);
  out.set("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  out.set("Accept-Ranges", upstream.headers.get("Accept-Ranges") || "bytes");
  out.set("Cache-Control", "no-store");
  out.set("Access-Control-Allow-Origin", "*");
  const len = upstream.headers.get("Content-Length");
  if (len) out.set("Content-Length", len);
  const cr = upstream.headers.get("Content-Range");
  if (cr) out.set("Content-Range", cr);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
__name(handleDl, "handleDl");
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store"
    }
  });
}
__name(json, "json");
function dlUrl(request, target, filename) {
  const origin = new URL(request.url).origin;
  let s = `${origin}/api/dl?url=${encodeURIComponent(target)}`;
  if (filename) s += `&filename=${encodeURIComponent(filename)}`;
  return s;
}
__name(dlUrl, "dlUrl");
function validatePublicUrl(s) {
  if (!s) return { ok: false, error: "missing ?url=" };
  if (s.length > MAX_URL_LEN) return { ok: false, error: "URL too long" };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "invalid URL (need https://\u2026)" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "only http(s) URLs allowed" };
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host === "metadata.google.internal" || host.endsWith(".internal") || host.endsWith(".local") || host === "[::1]" || host === "169.254.169.254" || host === "metadata.google.com") return { ok: false, error: "blocked host" };
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return { ok: false, error: "blocked private address" };
  if (host.startsWith("[fd") || host.startsWith("[fe80")) return { ok: false, error: "blocked private address" };
  return { ok: true };
}
__name(validatePublicUrl, "validatePublicUrl");
function extOfPath(pathname) {
  const clean = pathname.split("?")[0].split("#")[0];
  const base = clean.split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  return base.slice(dot + 1).toLowerCase().slice(0, 8);
}
__name(extOfPath, "extOfPath");
function filenameOf(parsed) {
  const base = (parsed.pathname.split("/").pop() || "download").split("?")[0] || "download";
  try {
    return decodeURIComponent(base).slice(0, 120) || "download";
  } catch {
    return base.slice(0, 120) || "download";
  }
}
__name(filenameOf, "filenameOf");
function sanitizeFilename(name) {
  return (name || "download").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "_").slice(0, 150) || "download";
}
__name(sanitizeFilename, "sanitizeFilename");
async function headMeta(target) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8e3);
  try {
    const res = await fetch(target, { method: "HEAD", headers: { "User-Agent": UA }, signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) return null;
    const len = res.headers.get("Content-Length");
    return { size: len ? Number(len) : null, contentType: res.headers.get("Content-Type") };
  } finally {
    clearTimeout(t);
  }
}
__name(headMeta, "headMeta");
async function fetchText(target) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(target, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      signal: ctrl.signal,
      redirect: "follow"
    });
    if (!res.ok) throw new Error(`page responded ${res.status}`);
    const ct = res.headers.get("Content-Type") || "";
    if (!/html|text|xml|json/i.test(ct) && !ct.includes("text")) {
      throw new Error(`not a page (${ct || "unknown type"}) \u2014 if it's a file, link it directly`);
    }
    const text = await res.text();
    return text.slice(0, 5e5);
  } finally {
    clearTimeout(t);
  }
}
__name(fetchText, "fetchText");
function scrapePage(pageUrl, html) {
  const title = firstGroup(html, /<title[^>]*>([^<]{1,300})<\/title>/i) || "";
  const meta = /* @__PURE__ */ __name((key) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, "i");
    const tag = html.match(re)?.[0] || "";
    return firstGroup(tag, /content=["']([^"']{1,2000})["']/i) || "";
  }, "meta");
  const siteName = meta("og:site_name");
  const ogTitle = meta("og:title");
  const desc = meta("og:description") || meta("description") || meta("twitter:description");
  const image = absolutize(pageUrl, meta("og:image") || meta("twitter:image") || firstGroup(html, /<link[^>]+rel=["']image_src["'][^>]*href=["']([^"']+)["']/i) || "");
  const videos = [
    meta("og:video:secure_url"),
    meta("og:video:url"),
    meta("og:video"),
    meta("twitter:player:stream"),
    ...allGroups(html, /<video[^>]+src=["']([^"']+)["']/gi),
    ...allGroups(html, /<source[^>]+src=["']([^"']+)["']/gi).filter((s) => /\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i.test(s))
  ].filter(Boolean);
  const audios = allGroups(html, /<audio[^>]+src=["']([^"']+)["']/gi);
  const formats = [];
  const seen = /* @__PURE__ */ new Set();
  for (const v of dedupe(videos).slice(0, 8)) {
    const abs = absolutize(pageUrl, v);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    const ext = extOfPath(new URL(abs, pageUrl).pathname) || "mp4";
    formats.push({ id: `video-${formats.length + 1}`, label: `Video ${formats.length + 1} \xB7 ${ext.toUpperCase()}`, ext, kind: "video", url: abs });
  }
  for (const a of dedupe(audios).slice(0, 4)) {
    const abs = absolutize(pageUrl, a);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    formats.push({ id: `audio-${formats.length + 1}`, label: `Audio \xB7 ${extOfPath(new URL(abs, pageUrl).pathname).toUpperCase() || "MP3"}`, ext: "mp3", kind: "audio", url: abs });
  }
  if (image && !seen.has(image)) {
    formats.push({ id: "thumb", label: "Cover image", ext: extOfPath(new URL(image, pageUrl).pathname) || "jpg", kind: "image", url: image });
  }
  return { title: decodeEntities(ogTitle || title || siteName || pageUrl), description: decodeEntities(desc).slice(0, 500), siteName, image, formats };
}
__name(scrapePage, "scrapePage");
async function youtubeOembed(pageUrl) {
  const api = `https://www.youtube.com/oembed?url=${encodeURIComponent(pageUrl)}&format=json`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8e3);
  try {
    const res = await fetch(api, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!res.ok) return null;
    const j = await res.json();
    return { title: j.title || null, author: j.author_name || null, thumbnail: j.thumbnail_url || null };
  } finally {
    clearTimeout(t);
  }
}
__name(youtubeOembed, "youtubeOembed");
async function tryCobalt(pageUrl, env) {
  const base = (env.COBALT_API_URL || "").trim().replace(/\/+$/, "");
  if (!base) return null;
  const key = (env.COBALT_API_KEY || "").trim();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2e4);
  try {
    const res = await fetch(base, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...key ? { Authorization: `Api-Key ${key}` } : {}
      },
      body: JSON.stringify({ url: pageUrl, downloadMode: "auto" }),
      signal: ctrl.signal
    });
    const data = await res.json().catch(() => ({}));
    clearTimeout(t);
    if (!res.ok || data.status === "error") return { url: pageUrl, kind: "page", source: "cobalt-error", title: pageUrl, needsExtractor: true, extractor: extractorStatus(env), formats: [], note: data?.error?.code ? `Extractor error: ${data.error.code}` : `Extractor responded ${res.status}` };
    if (data.status === "redirect" || data.status === "stream" || data.status === "tunnel") {
      const dl = String(data.url || "");
      return {
        url: pageUrl,
        kind: guessKind(dl),
        source: "cobalt",
        title: data.filename ? String(data.filename).replace(/\.[a-z0-9]+$/i, "") : pageUrl,
        thumbnail: null,
        needsExtractor: false,
        formats: [{ id: "cobalt", label: `${(extOfPath(dl) || "media").toUpperCase()} \xB7 via extractor`, ext: extOfPath(dl) || "mp4", kind: guessKind(dl), url: dl }]
      };
    }
    if (data.status === "picker" && Array.isArray(data.picker)) {
      const formats = data.picker.slice(0, 12).map((p, i) => ({
        id: `pick-${i}`,
        label: [p.type, p.url ? "" : "", p.url && /\.(mp3|m4a|opus|ogg)/i.test(p.url) ? "audio" : ""].filter(Boolean).join(" ") || `Option ${i + 1}`,
        ext: "mp4",
        kind: "video",
        url: String(p.url || "")
      })).filter((f) => f.url);
      return { url: pageUrl, kind: "page", source: "cobalt", title: pageUrl, needsExtractor: false, formats };
    }
    return null;
  } catch (e) {
    clearTimeout(t);
    return { url: pageUrl, kind: "page", source: "cobalt-error", title: pageUrl, needsExtractor: true, extractor: extractorStatus(env), formats: [], note: `Extractor unreachable: ${String(e?.message || e).slice(0, 120)}` };
  }
}
__name(tryCobalt, "tryCobalt");
function guessKind(u) {
  const e = extOfPath(String(u).split("?")[0]);
  return DIRECT_EXTS.get(e) || "video";
}
__name(guessKind, "guessKind");
function firstGroup(s, re) {
  const m = s.match(re);
  return m ? m[1].trim() : "";
}
__name(firstGroup, "firstGroup");
function allGroups(s, re) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(s)) && out.length < 20) out.push(m[1].trim());
  return out;
}
__name(allGroups, "allGroups");
function dedupe(arr) {
  return [...new Set(arr.map((s) => (s || "").trim()).filter(Boolean))];
}
__name(dedupe, "dedupe");
function absolutize(base, ref) {
  if (!ref) return "";
  try {
    return new URL(ref, base).href;
  } catch {
    return "";
  }
}
__name(absolutize, "absolutize");
function decodeEntities(s) {
  return String(s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}
__name(decodeEntities, "decodeEntities");

// C:/Users/daniswastaken/AppData/Local/npm-cache/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// C:/Users/daniswastaken/AppData/Local/npm-cache/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-8O5TL8/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// C:/Users/daniswastaken/AppData/Local/npm-cache/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-8O5TL8/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
