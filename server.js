import express from "express";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import path from "path";
import { Innertube } from 'youtubei.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let innertube;
(async () => {
  try {
    innertube = await Innertube.create({
      client_options: {
        clientName: 'WEB',
        clientVersion: '2.20260128.05.00',
        hl: 'ja',
        gl: 'JP',
        utcOffsetMinutes: 540,
        userInterfaceTheme: 'USER_INTERFACE_THEME_LIGHT'
      },
      generate_session_locally: true,
      retrieve_player: false
    });
    console.log('Innertube ready!');
  } catch (err) {
    console.error('Innertube init failed:', err);
  }
})();

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/watch.html", (req, res) => {
  res.sendFile(path.join(__dirname, "watch.html"));
});

// yt-dlpでストリーミングURL取得（オリジナルプレイヤー）
app.get("/video", async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).json({ error: "video id required" });
  try {
    const output = await execPromise(
      `yt-dlp --cookies youtube-cookies.txt --js-runtimes node --remote-components ejs:github --sleep-requests 1 --user-agent "Mozilla/5.0" --get-url -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]" https://youtu.be/${videoId}`
    );
    const lines = output.stdout.trim().split("\n");
    const videoUrl = lines[0] || "";
    const audioUrl = lines[1] || "";
    if (!videoUrl || !audioUrl) throw new Error("Failed to extract URLs");
    res.json({ video: videoUrl, audio: audioUrl, source: "yt-dlp" });
  } catch (e) {
    console.error("yt-dlp stream error:", e);
    res.status(500).json({ error: "failed_to_fetch_video", message: e.message });
  }
});

// プロキシとHLSはそのまま

// おすすめ（browseでFEwhat_to_watch）
app.get("/api/popular", async (req, res) => {
  if (!innertube) return res.status(503).json({ error: "Innertube not ready" });
  try {
    const response = await innertube.actions.browse({
      browseId: 'FEwhat_to_watch',
      params: ''
    });
    const grid = response.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.richGridRenderer?.contents || [];
    const videos = grid.filter(item => item.richItemRenderer?.content?.videoRenderer)
                      .map(item => item.richItemRenderer.content.videoRenderer);
    res.json({
      items: videos.slice(0, 12).map(v => ({
        id: v.videoId,
        snippet: {
          title: v.title?.runs?.[0]?.text || v.title?.simpleText || '不明',
          channelId: v.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || '',
          channelTitle: v.ownerText?.runs?.[0]?.text || v.ownerText?.simpleText || '不明',
          thumbnails: { medium: { url: v.thumbnail?.thumbnails?.slice(-1)[0]?.url || '' } },
          publishedAt: v.publishedTimeText?.simpleText || v.publishedTimeText?.runs?.[0]?.text || new Date().toISOString()
        },
        statistics: {
          viewCount: v.viewCountText?.simpleText?.replace(/[^0-9KMB]/g, '') ||
                     v.viewCountText?.runs?.[0]?.text?.replace(/[^0-9KMB]/g, '') || '0'
        }
      })),
      nextPageToken: response.onResponseReceivedCommands?.[0]?.appendContinuationItemsAction?.continuationItem?.continuationEndpoint?.continuationCommand?.token || null
    });
  } catch (err) {
    console.error("Popular error:", err.message, err.stack || err);
    res.status(500).json({ error: err.message });
  }
});

// 検索はそのまま（動いているのでOK）

// 動画詳細（yt-dlp版）
app.get("/api/video/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const { stdout } = await execPromise(
      `yt-dlp -j --no-playlist --cookies youtube-cookies.txt --user-agent "Mozilla/5.0" https://youtu.be/${id}`
    );
    const meta = JSON.parse(stdout.trim());
    res.json({
      title: meta.title || '不明',
      description: meta.description || '',
      viewCount: meta.view_count?.toString() || '0',
      published: meta.upload_date || new Date().toISOString(),
      likeCount: meta.like_count?.toString() || '0',
      channel: {
        id: meta.channel_id || '',
        name: meta.uploader || meta.channel || '不明',
        thumbnails: [{ url: meta.thumbnail || '' }],
        subscriberCount: meta.channel_follower_count?.toString() || '0'
      }
    });
  } catch (err) {
    console.error("yt-dlp video error:", err.message, err.stderr);
    res.status(500).json({ error: err.message });
  }
});

// コメントは一時的に無効化（Parserバグ回避）
// app.get("/api/comments/:videoId", ... ) をコメントアウト or 削除

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
