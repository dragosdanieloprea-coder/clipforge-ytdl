# ClipForge YouTube downloader (Hugging Face Docker Space). Rebuild the Space ("Factory rebuild") to get the newest yt-dlp.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates curl unzip fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
# yt-dlp, plus Deno: yt-dlp needs a JavaScript runtime to read YouTube's player
RUN pip3 install --break-system-packages --no-cache-dir "yt-dlp[default]" \
 && curl -fsSL -o /tmp/deno.zip https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip \
 && unzip -q /tmp/deno.zip -d /usr/local/bin && rm /tmp/deno.zip && deno --version
WORKDIR /app
COPY ytdl.mjs render.mjs server.mjs ./
RUN mkdir -p tools/fonts && ln -s "$(command -v yt-dlp)" tools/yt-dlp && ln -s /usr/bin/ffmpeg tools/ffmpeg && ln -s /usr/bin/ffprobe tools/ffprobe \
 && chown -R 1000:1000 /app
USER 1000
ENV PORT=7860 NODE_ENV=production
EXPOSE 7860
CMD ["node", "server.mjs"]
