---
title: ClipForge YouTube downloader
emoji: 🎬
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

Backend for ClipForge AI (https://clipforge-ai.dragosdanieloprea.workers.dev): downloads YouTube videos with yt-dlp and renders
clips with ffmpeg. It only answers requests from the ClipForge site, which carry the `TUNNEL_KEY` secret. Use videos you own or
have the rights to.
