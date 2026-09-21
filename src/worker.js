/* Omnilipsi worker — universal media downloader API + asset fallback.
 * Pure Workers (no yt-dlp binary): direct files + OG/meta scrape + proxy.
 * Set COBALT_API_URL (+ secret COBALT_API_KEY) for YouTube/TikTok/IG/etc.
 */

const VERSION = "0.2.0";
const MAX_URL_LEN = 2048;
const FETCH_TIMEOUT_MS = 15000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Omnilipsi/0.2";

const DIRECT_EXTS = new Map([
  // video
  ["mp4", "video"], ["webm", "video"], ["mov", "video"], ["m4v", "video"],
  ["mkv", "video"], ["avi", "video"], ["ogv", "video"],
  // audio
  ["mp3", "audio"], ["m4a", "audio"], ["ogg", "audio"], ["oga", "audio"],
  ["opus", "audio"], ["wav", "audio"], ["flac", "audio"], ["aac", "audio"],
  // image
  ["jpg", "image"], ["jpeg", "image"], ["png", "image"], ["webp", "image"],
  ["gif", "image"], ["avif", "image"], ["svg", "image"], ["bmp", "image"],
  // other downloadable
  ["pdf", "file"], ["zip", "file"], ["rar", "file"], ["7z", "file"],
  ["m3u8", "stream"], ["mpd", "stream"],
]);

const YOUTUBE_HOSTS = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
  "youtu.be", "www.youtu.be",
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/health") return json({ ok: true, version: VERSION, extractor: extractorStatus(env) });
      if (url.pathname === "/api/info") return await handleInfo(request, env);
      if (url.pathname === "/api/dl") return await handleDl(request);
      if (url.pathname === "/api/extract" && request.method === "POST") return await handleExtractPost(request, env);

      // Anything else: let static assets serve it (index.html etc).
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
  },
};

function extractorStatus(env) {
  const base = (env.COBALT_API_URL || "").trim().replace(/\/+$/, "");
  return { enabled: Boolean(base), base: base || null };
}

/* ---------- /api/info ---------- */

async function handleInfo(request, env) {
  const target = new URL(request.url).searchParams.get("url")?.trim() || "";
  const check = validatePublicUrl(target);
  if (!check.ok) return json({ error: check.error }, 400);

  const parsed = new URL(target);
  const ext = extOfPath(parsed.pathname);
  const directKind = DIRECT_EXTS.get(ext);

  // 1) Direct file fast-path (HEAD for size/type, no full download).
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
          label: `${ext.toUpperCase()} · direct`,
          ext,
          kind: directKind,
          url: target,
          download: dlUrl(request, target, filename),
          size: meta?.size ?? null,
          contentType: meta?.contentType ?? null,
        },
      ],
    });
  }

  // 2) Generic page: fetch HTML + scrape meta.
  let html = "";
  try {
    html = await fetchText(target);
  } catch (e) {
    // Page fetch failed — still try cobalt as fallback for app links.
    const cobalt = await tryCobalt(target, env);
    if (cobalt) return json(cobalt);
    return json({ error: "could not fetch that URL", detail: String(e?.message || e).slice(0, 200) }, 422);
  }

  const scraped = scrapePage(target, html);

  // 3) YouTube: enrich with oEmbed (title/author/thumb) — still needs extractor for files.
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const isYouTube = [...YOUTUBE_HOSTS].some((h) => parsed.hostname.toLowerCase() === h || parsed.hostname.toLowerCase().endsWith("." + h.replace(/^www\./, "")));
  void host;
  if (isYouTube) {
    const oembed = await youtubeOembed(target).catch(() => null);
    const cobalt = await tryCobalt(target, env);
    if (cobalt) {
      if (oembed && !cobalt.thumbnail) cobalt.thumbnail = oembed.thumbnail;
      if (oembed && !cobalt.title) cobalt.title = oembed.title;
      return json(cobalt);
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
      formats: scraped.formats.map((f) => ({ ...f, download: dlUrl(request, f.url, undefined) })),
      note: "Workers can't run yt-dlp, so YouTube/app links need an extractor backend. Set COBALT_API_URL to enable one-click downloads.",
    });
  }

  // 4) If page already exposes direct media (og:video / <video src>), return it.
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
      formats: scraped.formats.map((f) => ({ ...f, download: dlUrl(request, f.url, undefined) })),
    });
  }

  // 5) Nothing direct found — try cobalt if configured, else explain.
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
    note: "No direct media found in page metadata. This usually means the site loads media via JS or needs yt-dlp/cobalt. Set COBALT_API_URL to handle these links.",
  });
}

/* ---------- /api/extract (cobalt passthrough) ---------- */

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

/* ---------- /api/dl (download proxy) ---------- */

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

/* ---------- helpers ---------- */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

function dlUrl(request, target, filename) {
  const origin = new URL(request.url).origin;
  let s = `${origin}/api/dl?url=${encodeURIComponent(target)}`;
  if (filename) s += `&filename=${encodeURIComponent(filename)}`;
  return s;
}

function validatePublicUrl(s) {
  if (!s) return { ok: false, error: "missing ?url=" };
  if (s.length > MAX_URL_LEN) return { ok: false, error: "URL too long" };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "invalid URL (need https://…)" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "only http(s) URLs allowed" };
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" || host === "metadata.google.internal" ||
    host.endsWith(".internal") || host.endsWith(".local") ||
    host === "[::1]" || host === "169.254.169.254" || host === "metadata.google.com"
  ) return { ok: false, error: "blocked host" };
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return { ok: false, error: "blocked private address" };
  if (host.startsWith("[fd") || host.startsWith("[fe80")) return { ok: false, error: "blocked private address" };
  return { ok: true };
}

function extOfPath(pathname) {
  const clean = pathname.split("?")[0].split("#")[0];
  const base = clean.split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  return base.slice(dot + 1).toLowerCase().slice(0, 8);
}

function filenameOf(parsed) {
  const base = (parsed.pathname.split("/").pop() || "download").split("?")[0] || "download";
  try {
    return decodeURIComponent(base).slice(0, 120) || "download";
  } catch {
    return base.slice(0, 120) || "download";
  }
}

function sanitizeFilename(name) {
  return (name || "download").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "_").slice(0, 150) || "download";
}

async function headMeta(target) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(target, { method: "HEAD", headers: { "User-Agent": UA }, signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) return null;
    const len = res.headers.get("Content-Length");
    return { size: len ? Number(len) : null, contentType: res.headers.get("Content-Type") };
  } finally {
    clearTimeout(t);
  }
}

async function fetchText(target) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(target, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      signal: ctrl.signal, redirect: "follow",
    });
    if (!res.ok) throw new Error(`page responded ${res.status}`);
    const ct = res.headers.get("Content-Type") || "";
    if (!/html|text|xml|json/i.test(ct) && !ct.includes("text")) {
      // Non-HTML direct stream with no extension — treat as downloadable anyway.
      throw new Error(`not a page (${ct || "unknown type"}) — if it's a file, link it directly`);
    }
    const text = await res.text();
    return text.slice(0, 500_000);
  } finally {
    clearTimeout(t);
  }
}

function scrapePage(pageUrl, html) {
  const title = firstGroup(html, /<title[^>]*>([^<]{1,300})<\/title>/i) || "";
  const meta = (key) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, "i");
    const tag = html.match(re)?.[0] || "";
    return firstGroup(tag, /content=["']([^"']{1,2000})["']/i) || "";
  };
  const siteName = meta("og:site_name");
  const ogTitle = meta("og:title");
  const desc = meta("og:description") || meta("description") || meta("twitter:description");
  const image = absolutize(pageUrl, meta("og:image") || meta("twitter:image") || firstGroup(html, /<link[^>]+rel=["']image_src["'][^>]*href=["']([^"']+)["']/i) || "");
  const videos = [
    meta("og:video:secure_url"), meta("og:video:url"), meta("og:video"),
    meta("twitter:player:stream"),
    ...allGroups(html, /<video[^>]+src=["']([^"']+)["']/gi),
    ...allGroups(html, /<source[^>]+src=["']([^"']+)["']/gi).filter((s) => /\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i.test(s)),
  ].filter(Boolean);
  const audios = allGroups(html, /<audio[^>]+src=["']([^"']+)["']/gi);
  const formats = [];
  const seen = new Set();
  for (const v of dedupe(videos).slice(0, 8)) {
    const abs = absolutize(pageUrl, v);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    const ext = extOfPath(new URL(abs, pageUrl).pathname) || "mp4";
    formats.push({ id: `video-${formats.length + 1}`, label: `Video ${formats.length + 1} · ${ext.toUpperCase()}`, ext, kind: "video", url: abs });
  }
  for (const a of dedupe(audios).slice(0, 4)) {
    const abs = absolutize(pageUrl, a);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    formats.push({ id: `audio-${formats.length + 1}`, label: `Audio · ${extOfPath(new URL(abs, pageUrl).pathname).toUpperCase() || "MP3"}`, ext: "mp3", kind: "audio", url: abs });
  }
  if (image && !seen.has(image)) {
    formats.push({ id: "thumb", label: "Cover image", ext: extOfPath(new URL(image, pageUrl).pathname) || "jpg", kind: "image", url: image });
  }
  return { title: decodeEntities(ogTitle || title || siteName || pageUrl), description: decodeEntities(desc).slice(0, 500), siteName, image, formats };
}

async function youtubeOembed(pageUrl) {
  const api = `https://www.youtube.com/oembed?url=${encodeURIComponent(pageUrl)}&format=json`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(api, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!res.ok) return null;
    const j = await res.json();
    return { title: j.title || null, author: j.author_name || null, thumbnail: j.thumbnail_url || null };
  } finally {
    clearTimeout(t);
  }
}

async function tryCobalt(pageUrl, env) {
  const base = (env.COBALT_API_URL || "").trim().replace(/\/+$/, "");
  if (!base) return null;
  const key = (env.COBALT_API_KEY || "").trim();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(base, {
      method: "POST",
      headers: {
        Accept: "application/json", "Content-Type": "application/json",
        ...(key ? { Authorization: `Api-Key ${key}` } : {}),
      },
      body: JSON.stringify({ url: pageUrl, downloadMode: "auto" }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    clearTimeout(t);
    if (!res.ok || data.status === "error") return { url: pageUrl, kind: "page", source: "cobalt-error", title: pageUrl, needsExtractor: true, extractor: extractorStatus(env), formats: [], note: data?.error?.code ? `Extractor error: ${data.error.code}` : `Extractor responded ${res.status}` };
    if (data.status === "redirect" || data.status === "stream" || data.status === "tunnel") {
      const dl = String(data.url || "");
      return {
        url: pageUrl, kind: guessKind(dl), source: "cobalt", title: data.filename ? String(data.filename).replace(/\.[a-z0-9]+$/i, "") : pageUrl,
        thumbnail: null, needsExtractor: false, formats: [{ id: "cobalt", label: `${(extOfPath(dl) || "media").toUpperCase()} · via extractor`, ext: extOfPath(dl) || "mp4", kind: guessKind(dl), url: dl }],
      };
    }
    if (data.status === "picker" && Array.isArray(data.picker)) {
      const formats = data.picker.slice(0, 12).map((p, i) => ({
        id: `pick-${i}`, label: [p.type, p.url ? "" : "", p.url && /\.(mp3|m4a|opus|ogg)/i.test(p.url) ? "audio" : ""].filter(Boolean).join(" ") || `Option ${i + 1}`,
        ext: "mp4", kind: "video", url: String(p.url || ""),
      })).filter((f) => f.url);
      return { url: pageUrl, kind: "page", source: "cobalt", title: pageUrl, needsExtractor: false, formats };
    }
    return null;
  } catch (e) {
    clearTimeout(t);
    return { url: pageUrl, kind: "page", source: "cobalt-error", title: pageUrl, needsExtractor: true, extractor: extractorStatus(env), formats: [], note: `Extractor unreachable: ${String(e?.message || e).slice(0, 120)}` };
  }
}

function guessKind(u) {
  const e = extOfPath(String(u).split("?")[0]);
  return DIRECT_EXTS.get(e) || "video";
}

/* tiny html utils (no DOM in workers) */
function firstGroup(s, re) {
  const m = s.match(re);
  return m ? m[1].trim() : "";
}
function allGroups(s, re) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(s)) && out.length < 20) out.push(m[1].trim());
  return out;
}
function dedupe(arr) {
  return [...new Set(arr.map((s) => (s || "").trim()).filter(Boolean))];
}
function absolutize(base, ref) {
  if (!ref) return "";
  try {
    return new URL(ref, base).href;
  } catch {
    return "";
  }
}
function decodeEntities(s) {
  return String(s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}
