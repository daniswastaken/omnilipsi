# omnilipsi
Download anything, anytime, anywhere.

Web UI + Cloudflare Workers API for universal media downloads.

## What it does

- Paste any link in the web UI → `GET /api/info?url=…` resolves it:
  - **Direct files** (`.mp4/.mp3/.jpg/…`) → instant download metadata via `HEAD`.
  - **Pages** → scrapes OpenGraph / twitter meta / `<video>` / `<audio>` tags.
  - **YouTube** → `oEmbed` title/author/thumbnail.
  - **Anything else (TikTok/IG/X/…)** → forwarded to your extractor if configured.
- `GET /api/dl?url=…&filename=…` proxies bytes with `Content-Disposition: attachment` (fixes hotlink + CORS blocks, correct filename).
- Local CLI keeps full yt-dlp power: `npm run dl -- "<url>" [--mp3]`.

## Honest limit

Cloudflare Workers **cannot run yt-dlp binaries** (no child processes / filesystem).
So YouTube/TikTok/IG direct files need a tiny extractor backend. This repo is
ready for it: set `COBALT_API_URL` (+ `COBALT_API_KEY` secret) and `/api/info`
auto-delegates app links to your [Cobalt API](https://cobalt.tools) instance.

## Run

```sh
npm install
npm run dev        # local Worker at http://localhost:8787
npm run deploy     # deploy to *.workers.dev
npm run dl -- "https://youtu.be/..."   # full-quality local download
```

## API

- `GET /api/health` → `{ ok, version, extractor: { enabled } }`
- `GET /api/info?url=https://…` → `{ title, thumbnail, formats: [{ label, ext, kind, url, download, size }] }`
- `GET /api/dl?url=https://…&filename=x.mp4` → attachment stream (Range-aware)
- `POST /api/extract { url }` → cobalt passthrough (501 if not configured)

## Enable full-site extraction

1. Deploy a Cobalt API instance (runs yt-dlp for you).
2. In `wrangler.toml` set `COBALT_API_URL = "https://your-cobalt-api"`.
3. `npx wrangler secret put COBALT_API_KEY` and paste its key.
4. `npm run deploy`.
