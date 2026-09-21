# Omnilipsi extractor — real yt-dlp backend for "download from anywhere".
#
# Deploy anywhere that builds Dockerfiles (no local Docker needed on your machine):
#   Render:  new Web Service from this repo, Docker runtime, dockerfilePath ./extractor/Dockerfile
#   Fly.io:  fly launch --dockerfile extractor/Dockerfile (then fly deploy)
#   Any VPS: docker build -t omni-ext ./extractor && docker run -p 8000:8000 [...]
#
# Env:
#   PORT=8000  EXTRACTOR_TOKEN=<secret>  YTDLP_ARGS="--proxy http://..."

FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir -U "yt-dlp[default]"

WORKDIR /app
COPY package.json server.js ./

ENV PORT=8000
EXPOSE 8000

CMD ["node", "server.js"]
