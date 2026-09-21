/* Omnilipsi extractor — tiny yt-dlp HTTP service (Node stdlib only).
 * Endpoints:
 *   GET /health
 *   GET /api/info?url=...        -> { title, author, thumbnail, kind, formats[] }
 *   GET /api/stream?url=...&id=  -> proxied bytes (same-IP, handles cipher/HLS)
 * Auth: if EXTRACTOR_TOKEN set, requires Authorization: Bearer <token>.
 */
import http from "node:http";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 8000);
const TOKEN = (process.env.EXTRACTOR_TOKEN || "").trim();
const EXTRA_ARGS = (process.env.YTDLP_ARGS || "").trim().split(/\s+/).filter(Boolean);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || "/", "http://x");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.writeHead(204).end();
    return;
  }
  try {
    if (u.pathname === "/health") return send(res, 200, { ok: true, service: "omnilipsi-extractor" });
    if (u.pathname === "/api/info") {
      guard(req, res); // throws on 401
      const target = (u.searchParams.get("url") || "").trim();
      const v = validateUrl(target);
      if (!v.ok) return send(res, 400, { error: v.error });
      const info = await dumpJson(target);
      return send(res, 200, normalize(info, target));
    }
    if (u.pathname === "/api/stream") {
      guard(req, res);
      const target = (u.searchParams.get("url") || "").trim();
      const id = (u.searchParams.get("id") || "best").trim().slice(0, 60);
      const v = validateUrl(target);
      if (!v.ok) return send(res, 400, { error: v.error });
      await pipeStream(req, res, target, id);
      return;
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    if (!res.headersSent) return send(res, e.status || 500, { error: e.message || "error" });
    res.destroy();
  }
});

server.listen(PORT, () => console.log(`extractor listening on :${PORT}`));

function guard(req, res) {
  if (!TOKEN) return;
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    const e = new Error("unauthorized");
    e.status = 401;
    throw e;
  }
}

function validateUrl(s) {
  if (!s || s.length > 2048) return { ok: false, error: "bad url" };
  let p;
  try { p = new URL(s); } catch { return { ok: false, error: "invalid URL" }; }
  if (p.protocol !== "http:" && p.protocol !== "https:") return { ok: false, error: "only http(s)" };
  const h = p.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".internal") || h.endsWith(".local") ||
      /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) ||
      h === "169.254.169.254") return { ok: false, error: "blocked host" };
  return { ok: true };
}

function runYtDlp(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", [...EXTRA_ARGS, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("yt-dlp timed out")); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; if (out.length > 8_000_000) child.kill("SIGKILL"); });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(t); reject(e); });
    child.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve({ out, err });
      else reject(Object.assign(new Error("yt-dlp failed: " + err.slice(-400)), { status: 422 }));
    });
  });
}

async function dumpJson(target) {
  const { out } = await runYtDlp([
    "--dump-json", "--no-playlist", "--no-warnings",
    "--socket-timeout", "15", "--retries", "1",
    "--no-check-certificates", target,
  ]);
  return JSON.parse(out.split("\n").find((l) => l.trim().startsWith("{")) || "{}");
}

function normalize(info, target) {
  const formats = (Array.isArray(info.formats) ? info.formats : [])
    .filter((f) => f.url)
    .map((f) => {
      const proto = String(f.protocol || "");
      const v = f.vcodec && f.vcodec !== "none";
      const a = f.acodec && f.acodec !== "none";
      const kind = v ? "video" : "audio";
      const tag = f.format_note || (f.height ? `${f.height}p` : "") || (f.abr ? `${Math.round(f.abr)}kbps` : "") || "";
      return {
        id: String(f.format_id || ""),
        label: `${v && a ? "Video+audio" : v ? "Video" : "Audio"}${tag ? " · " + tag : ""} · ${(f.ext || "").toUpperCase()}`,
        ext: f.ext || (v ? "mp4" : "m4a"),
        kind,
        url: f.url,
        size: f.filesize || f.filesize_approx || null,
        needsProxy: /m3u8|m3u8_native|m3u8/.test(proto) || !/^https?:/.test(f.url),
      };
    })
    .slice(0, 20);
  // Direct-file shortcut: yt-dlp returns single "generic" format for raw files.
  const thumbs = info.thumbnail || (Array.isArray(info.thumbnails) && info.thumbnails.length
    ? info.thumbnails[info.thumbnails.length - 1].url : null);
  return {
    title: info.title || target,
    author: info.uploader || info.channel || null,
    thumbnail: thumbs || null,
    description: String(info.description || "").slice(0, 300),
    kind: formats.some((f) => f.kind === "video") ? "video" : "audio",
    formats,
  };
}

function pipeStream(req, res, target, id) {
  return new Promise((resolve) => {
    const child = spawn("yt-dlp", [...EXTRA_ARGS, "-o", "-", "-f", id, "--no-playlist", "--socket-timeout", "15", target],
      { stdio: ["ignore", "pipe", "pipe"] });
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="download-${Date.now()}.media"`,
      "Cache-Control": "no-store",
    });
    child.stdout.pipe(res);
    child.stderr.resume();
    const done = () => { try { child.kill("SIGKILL"); } catch {} resolve(); };
    req.on("close", done);
    child.on("close", () => { res.end(); resolve(); });
    child.on("error", done);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json;charset=utf-8" });
  res.end(JSON.stringify(obj));
}
