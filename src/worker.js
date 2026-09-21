/* Omnilipsi worker — universal media downloader API + asset fallback.
 * Workers can't spawn yt-dlp, so:
 *  - direct files, page meta/JSON-LD, and YouTube Innertube run natively here;
 *  - everything else delegates to EXTRACTOR_API_URL (bundled yt-dlp service
 *    in ./extractor) or COBALT_API_URL when configured.
 */

const VERSION = "0.3.0";
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

const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"; // public YouTube WEB/ANDROID client key
const INNERTUBE_URL = `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`;

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
  const cobalt = (env.COBALT_API_URL || "").trim().replace(/\/+$/, "");
  const custom = (env.EXTRACTOR_API_URL || "").trim().replace(/\/+$/, "");
  const base = custom || cobalt || null;
  return { enabled: Boolean(base), base, custom: custom || null, cobalt: cobalt || null };
}

// Any configured backend (custom yt-dlp service first, cobalt second).
async function tryBackend(pageUrl, env) {
  const custom = (env.EXTRACTOR_API_URL || "").trim().replace(/\/+$/, "");
  if (custom) {
    const r = await tryCustomExtractor(pageUrl, custom, env.EXTRACTOR_TOKEN || "");
    if (r) return r;
  }
  return await tryCobalt(pageUrl, env);
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

  // 2) Backend extractor first for non-direct links (covers TikTok/IG/X/
  //    obscure JS-heavy sites via real yt-dlp when deployed).
  const backend = await tryBackend(target, env);
  if (backend && backend.formats?.length) return json(withDl(request, backend));

  // 3) YouTube: native Innertube extraction (no backend needed).
  const isYouTube = [...YOUTUBE_HOSTS].some((h) => parsed.hostname.toLowerCase() === h || parsed.hostname.toLowerCase().endsWith("." + h.replace(/^www\./, "")));
  if (isYouTube) {
    const viaTube = await tryInnertube(request, target).catch(() => null);
    if (viaTube) return json(viaTube);
    const oembed = await youtubeOembed(target).catch(() => null);
    return json({
      url: target,
      kind: "page",
      source: "youtube-meta",
      title: oembed?.title || target,
      author: oembed?.author || null,
      thumbnail: oembed?.thumbnail || null,
      description: null,
      needsExtractor: true,
      extractor: extractorStatus(env),
      formats: [],
      note: backend?.note || "YouTube stream lookup failed from this network (Google often blocks datacenter IPs). Deploy the bundled extractor service (./extractor) and set EXTRACTOR_API_URL for reliable YouTube downloads.",
    });
  }

  // 4) Generic page: fetch HTML + scrape meta/JSON-LD/oEmbed.
  let html = "";
  try {
    html = await fetchText(target);
  } catch (e) {
    if (backend) return json(withDl(request, backend));
    return json({ error: "could not fetch that URL", detail: String(e?.message || e).slice(0, 200) }, 422);
  }

  const scraped = scrapePage(target, html);
  if (scraped.formats.length === 0) {
    const disc = await fetchOembedDiscovery(target, html).catch(() => null);
    if (disc) {
      scraped.title = scraped.title && scraped.title !== target ? scraped.title : (disc.title || scraped.title);
      scraped.description = scraped.description || disc.description || "";
      scraped.image = scraped.image || disc.thumbnail || "";
      if (!scraped.author && disc.author) scraped.siteName = disc.author;
    }
  }

  // 5) If page exposes media (og:video / JSON-LD VideoObject / <video src>), return it.
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

  // 6) Nothing found — backend already tried; explain.
  if (backend) return json(withDl(request, backend));
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
    note: "No downloadable media in page metadata. JS-rendered or extractor-only site: deploy ./extractor and set EXTRACTOR_API_URL (or set COBALT_API_URL).",
  });
}

function withDl(request, result) {
  return {
    ...result,
    formats: (result.formats || []).map((f) => ({ ...f, download: f.download || dlUrl(request, f.url, f.filename) })),
  };
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
  const cobalt = await tryBackend(target, env);
  if (!cobalt) return json({ error: "extractor not configured", hint: "Deploy ./extractor and set EXTRACTOR_API_URL (or set COBALT_API_URL + COBALT_API_KEY secret)." }, 501);
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
  const pushUrl = (raw, kind, label) => {
    const abs = absolutize(pageUrl, raw);
    if (!abs || seen.has(abs)) return;
    seen.add(abs);
    let ext = "";
    try { ext = extOfPath(new URL(abs).pathname) || (kind === "audio" ? "mp3" : "mp4"); } catch { ext = kind === "audio" ? "mp3" : "mp4"; }
    formats.push({ id: `${kind}-${formats.length + 1}`, label: label || `${kind[0].toUpperCase() + kind.slice(1)} ${formats.length + 1} · ${ext.toUpperCase()}`, ext, kind, url: abs });
  };
  for (const v of dedupe(videos).slice(0, 8)) pushUrl(v, "video");
  for (const a of dedupe(audios).slice(0, 4)) pushUrl(a, "audio");
  // JSON-LD VideoObject/AudioObject — catches obscure blogs, news, course sites.
  for (const m of extractJsonLdMedia(pageUrl, html).slice(0, 8)) pushUrl(m.url, m.kind, m.label);
  if (image && !seen.has(image)) {
    formats.push({ id: "thumb", label: "Cover image", ext: extOfPath(new URL(image, pageUrl).pathname) || "jpg", kind: "image", url: image });
  }
  return { title: decodeEntities(ogTitle || title || siteName || pageUrl), description: decodeEntities(desc).slice(0, 500), siteName, image, formats };
}

// oEmbed discovery: <link rel="alternate" type="application/json+oembed" href="…">
async function fetchOembedDiscovery(pageUrl, html) {
  const tag = html.match(/<link[^>]+type=["']application\/json\+oembed["'][^>]*>/i)?.[0] || "";
  const href = firstGroup(tag, /href=["']([^"']+)["']/i);
  if (!href) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(absolutize(pageUrl, href), { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!res.ok) return null;
    const j = await res.json();
    return { title: j.title || null, author: j.author_name || null, thumbnail: j.thumbnail_url || null, description: null };
  } finally {
    clearTimeout(t);
  }
}

function extractJsonLdMedia(pageUrl, html) {
  const out = [];
  for (const block of allGroups(html, /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]{1,60000})<\/script>/gi)) {
    let data;
    try { data = JSON.parse(block); } catch { continue; }
    const nodes = Array.isArray(data) ? data : [data];
    const walk = (n) => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      const type = String(n["@type"] || "");
      const kind = /Audio/i.test(type) ? "audio" : /Video|Media/i.test(type) ? "video" : null;
      const raw = n.contentUrl || n.embedUrl || n.url;
      if (kind && typeof raw === "string" && /^https?:\/\//i.test(absolutize(pageUrl, raw))) {
        out.push({ url: absolutize(pageUrl, raw), kind, label: n.name ? `${String(n.name).slice(0, 80)} · ${kind}` : undefined });
      }
      for (const v of Object.values(n)) walk(v);
    };
    walk(nodes);
    if (out.length >= 8) break;
  }
  return out;
}

/* ---------- YouTube Innertube (native, no backend) ---------- */

function youtubeVideoId(pageUrl) {
  let u;
  try { u = new URL(pageUrl); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (host === "youtu.be") return u.pathname.split("/")[1]?.split("?")[0] || null;
  if (host.endsWith("youtube.com")) {
    if (u.pathname === "/watch") return u.searchParams.get("v");
    const m = u.pathname.match(/^\/(shorts|live|embed|v)\/([\w-]{6,})/);
    if (m) return m[2];
  }
  return null;
}

async function tryInnertube(request, pageUrl) {
  const videoId = youtubeVideoId(pageUrl);
  if (!videoId) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  let player;
  try {
    const res = await fetch(INNERTUBE_URL, {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/json", Origin: "https://www.youtube.com" },
      body: JSON.stringify({
        videoId,
        context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "en", gl: "US" } },
        playbackContext: { contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" } },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    player = await res.json();
  } finally {
    clearTimeout(t);
  }
  const status = player?.playabilityStatus?.status;
  if (status !== "OK" || !player?.streamingData) return null;
  const details = player.videoDetails || {};
  const thumbs = details.thumbnail?.thumbnails || [];
  const streams = [...(player.streamingData.formats || []), ...(player.streamingData.adaptiveFormats || [])]
    .filter((f) => typeof f.url === "string" && f.url.startsWith("http"));
  if (!streams.length) return null;

  const seen = new Set();
  const formats = [];
  // Progressive (audio+video) first — one-file downloads.
  const prog = streams.filter((f) => (f.audioQuality || "").includes("AUDIO_QUALITY") && f.width);
  const rest = streams.filter((f) => !prog.includes(f));
  for (const f of [...prog, ...rest].slice(0, 24)) {
    const mime = String(f.mimeType || "");
    const isAudio = mime.startsWith("audio/");
    const ext = (mime.match(/codecs="[^"]*"/) ? "" : "", mime.includes("webm") ? "webm" : mime.includes("mp4") ? (isAudio ? "m4a" : "mp4") : (isAudio ? "m4a" : "mp4"));
    const key = `${f.itag}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const q = f.qualityLabel || (isAudio ? `${Math.round((f.bitrate || 0) / 1000)}kbps audio` : `${f.height}p`);
    formats.push({
      id: `itag-${f.itag}`,
      label: `${isAudio ? "Audio" : "Video"} · ${q} · ${ext.toUpperCase()}${prog.includes(f) ? " · 1 file" : ""}`,
      ext, kind: isAudio ? "audio" : "video",
      url: f.url,
      size: f.contentLength ? Number(f.contentLength) : null,
      contentType: mime.split(";")[0],
    });
    if (formats.length >= 12) break;
  }
  if (!formats.length) return null;
  const safeTitle = (details.title || `YouTube ${videoId}`).slice(0, 120);
  return {
    url: pageUrl,
    kind: "video",
    source: "youtube-innertube",
    title: safeTitle,
    author: details.author || null,
    thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : null,
    description: (details.shortDescription || "").slice(0, 300),
    needsExtractor: false,
    formats: formats.map((f) => ({ ...f, filename: `${sanitizeFilename(safeTitle)}.${f.ext}`, download: dlUrl(request, f.url, `${sanitizeFilename(safeTitle)}.${f.ext}`) })),
  };
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

async function tryCustomExtractor(pageUrl, base, token) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(`${base}/api/info?url=${encodeURIComponent(pageUrl)}`, {
      headers: { "User-Agent": UA, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    clearTimeout(t);
    if (!res.ok) return { url: pageUrl, kind: "page", source: "extractor-error", title: pageUrl, needsExtractor: true, formats: [], note: data?.error ? `Extractor: ${String(data.error).slice(0, 150)}` : `Extractor responded ${res.status}` };
    if (data?.stream) {
      // Backend offers a same-IP proxied stream (for ciphered/IP-locked/HLS).
      const dl = `${base}/api/stream?url=${encodeURIComponent(pageUrl)}${data.formatId ? `&id=${encodeURIComponent(data.formatId)}` : ""}`;
      return {
        url: pageUrl, kind: data.kind || "video", source: "extractor", title: data.title || pageUrl,
        author: data.author || null, thumbnail: data.thumbnail || null, needsExtractor: false,
        formats: [{ id: "best", label: data.label || "Best · via extractor", ext: data.ext || "mp4", kind: data.kind || "video", url: dl }],
      };
    }
    if (Array.isArray(data?.formats) && data.formats.length) {
      return {
        url: pageUrl, kind: data.kind || "video", source: "extractor", title: data.title || pageUrl,
        author: data.author || null, thumbnail: data.thumbnail || null, description: data.description || null,
        needsExtractor: false,
        formats: data.formats.slice(0, 15).map((f, i) => ({
          id: String(f.id || `f-${i}`), label: String(f.label || `${(f.ext || "media").toUpperCase()} · option ${i + 1}`),
          ext: f.ext || "mp4", kind: f.kind || "video", url: String(f.url || ""),
          size: f.size ?? null, contentType: f.contentType || null,
        })).filter((f) => f.url),
      };
    }
    return null;
  } catch (e) {
    clearTimeout(t);
    return { url: pageUrl, kind: "page", source: "extractor-error", title: pageUrl, needsExtractor: true, formats: [], note: `Extractor unreachable: ${String(e?.message || e).slice(0, 120)}` };
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
