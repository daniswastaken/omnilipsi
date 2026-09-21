# omnilipsi
Download anything, anytime, anywhere.

Web UI + Cloudflare Workers API for universal media downloads.
Live: `https://omnilipsi.daniswastaken.workers.dev`

## What works with zero setup

- **Direct files** (`.mp4/.mp3/.jpg/.pdf/…`) → instant metadata + proxied download.
- **YouTube** (watch / shorts / youtu.be / embed) → native Innertube extraction
  (up to 4K video + audio-only), files proxied with correct filenames.
- **Pages exposing video** → OpenGraph / twitter player / `<video>` / `<audio>` /
  JSON-LD `VideoObject` / oEmbed discovery.
- `GET /api/dl?url=…` proxies bytes (`Content-Disposition: attachment`,
  Range-aware) — fixes hotlink/CORS blocks.

## For everything else (TikTok / IG / X / JS-heavy obscure sites)

Workers can't spawn binaries, so real yt-dlp lives in `./extractor`
(Node stdlib + `yt-dlp` + `ffmpeg` Docker service):

```sh
# Render (no local Docker needed): new Web Service from this repo,
# Docker runtime, dockerfilePath ./extractor/Dockerfile
# Fly.io: fly launch --dockerfile extractor/Dockerfile
# Any VPS: docker build -t omni-ext ./extractor && docker run -p 8000:8000 -e EXTRACTOR_TOKEN=... omni-ext
```

Then wire the Worker:

```sh
# wrangler.toml: EXTRACTOR_API_URL = "https://your-extractor-host"
npx wrangler secret put EXTRACTOR_TOKEN   # if you set one
npm run deploy
```

A Cobalt API instance also works (`COBALT_API_URL` + `COBALT_API_KEY` secret).
`.github/workflows/extractor-image.yml` publishes the backend to GHCR on push.

## Run

```sh
npm install
npm run dev        # local Worker at http://localhost:8787
npm run deploy     # deploy to *.workers.dev
npm run dl -- "https://..." [--mp3]   # full-quality local yt-dlp download
```

## API

- `GET /api/health` → `{ ok, version, extractor: { enabled, custom, cobalt } }`
- `GET /api/info?url=https://…` → `{ title, author, thumbnail, source, formats: [{ id, label, ext, kind, url, download, size }] }`
  (`source`: `direct` | `youtube-innertube` | `page-meta` | `extractor` | `cobalt`)
- `GET /api/dl?url=https://…&filename=x.mp4` → attachment stream (Range-aware)
- `POST /api/extract { url }` → backend passthrough (501 if none configured)
