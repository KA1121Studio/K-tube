// server.js （統合版 + Innertubeメイン対応）
import express from "express";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import path from "path";
import { Innertube } from 'youtubei.js';
import { execSync } from "child_process";

const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Innertube グローバル初期化（アプリ起動時に1回だけ）
let innertube;
(async () => {
  try {
    innertube = await Innertube.create({
      client_options: {
        clientName: 'WEB',
        clientVersion: '2.20260128.05.00',  // ← これをセット！
        hl: 'ja',
        gl: 'JP',
        utcOffsetMinutes: 540,  // 日本時間 +9時間
        userInterfaceTheme: 'USER_INTERFACE_THEME_LIGHT'
      },
      generate_session_locally: true,
      retrieve_player: false
    });
    console.log('Innertube ready with clientVersion 2.20260128.05.00!');
  } catch (err) {
    console.error('Innertube init failed:', err);
  }
})();

// 静的ファイル配信（index.html / watch.html など）
app.use(express.static(__dirname));

// ルート → YouTube風UI
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// watch.html（オリジナルプレイヤー）
app.get("/watch.html", (req, res) => {
  res.sendFile(path.join(__dirname, "watch.html"));
});

// yt-dlp エンドポイント（オリジナルプレイヤー用署名URL取得）
app.get("/video", async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).json({ error: "video id required" });

  try {
    const output = execSync(
      `yt-dlp --cookies youtube-cookies.txt --js-runtimes node --remote-components ejs:github --sleep-requests 1 --user-agent "Mozilla/5.0" --get-url -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]" https://youtu.be/${videoId}`
    ).toString().trim().split("\n");

    const videoUrl = output[0] || "";
    const audioUrl = output[1] || "";

    if (!videoUrl || !audioUrl) {
      throw new Error("Failed to extract URLs");
    }

    res.json({
      video: videoUrl,
      audio: audioUrl,
      source: "yt-dlp"
    });
  } catch (e) {
    console.error("yt-dlp error:", e);
    res.status(500).json({
      error: "failed_to_fetch_video",
      message: e.message || String(e)
    });
  }
});

// プロキシ（googlevideo.comのチャンク回避用）
app.get("/proxy", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("URL required");

  const range = req.headers.range || "bytes=0-";

  try {
    const response = await fetch(url, { headers: { Range: range } });
    const headers = {
      "Content-Type": response.headers.get("content-type") || "video/mp4",
      "Accept-Ranges": "bytes",
      "Content-Range": response.headers.get("content-range") || range,
      "Content-Length": response.headers.get("content-length")
    };

    res.writeHead(response.status, headers);
    response.body.pipe(res);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).send("Proxy failed");
  }
});

// HLSプロキシ（必要に応じて）
app.get("/proxy-hls", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("URL required");

  try {
    const r = await fetch(url);
    let text = await r.text();

    text = text.replace(
      /(https?:\/\/[^\s]+)/g,
      (m) => m.includes("googlevideo.com") ? `/proxy?url=${encodeURIComponent(m)}` : m
    );

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch (err) {
    res.status(500).send("HLS proxy failed");
  }
});

// Innertubeを使った新しいAPIエンドポイント（公式APIの置き換え）

// ホーム画面の人気動画（Trending）
app.get("/api/popular", async (req, res) => {
  if (!innertube) return res.status(503).json({ error: "Innertube not ready" });
  try {
    // getTrending() を諦めて、browse() で「おすすめ」フィードを取得
    const response = await innertube.actions.browse({
      browseId: 'FEwhat_to_watch',  // ← これ！（YouTubeホームのおすすめ動画フィード）
      params: ''  // 空でシンプルに（400回避）
    });

    // レスポンス構造を2026年現在のrichGridRendererに合わせる
    const grid = response.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.richGridRenderer?.contents || [];
    const videos = grid
      .filter(item => item.richItemRenderer?.content?.videoRenderer)
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
    console.error("Popular error details:", err.message, err.stack || err);
    res.status(500).json({ error: err.message });
  }
});

// 検索機能
app.get("/api/search", async (req, res) => {
  const q = req.query.q;
  const pageToken = req.query.pageToken;
  if (!q) return res.status(400).json({ error: "query required" });

  if (!innertube) return res.status(503).json({ error: "Innertube not ready" });

  try {
    const search = await innertube.search(q, {
      type: 'video',
      continuation: pageToken || undefined
    });

    res.json({
      items: search.videos.map(v => ({
        id: { videoId: v.id },
        snippet: {
          title: v.title.text,
          channelTitle: v.author?.name || "",
          channelId: v.author?.id || "",
          thumbnails: { medium: { url: v.thumbnails[0]?.url || "" } }
        }
      })),
      nextPageToken: search.continuations?.next_continuation_token || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 関連動画
app.get("/api/related", async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).json({ error: "video id required" });

  if (!innertube) return res.status(503).json({ error: "Innertube not ready" });

  try {
    const info = await innertube.getInfo(videoId);
    const related = info.related_videos || [];

    res.json({
      items: related.map(v => ({
        id: { videoId: v.id },
        snippet: {
          title: v.title.text,
          channelTitle: v.author?.name || "",
          thumbnails: { medium: { url: v.thumbnails[0]?.url || "" } }
        }
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Innertube API エンドポイント ──

// ホーム: トレンド動画
app.get('/api/trending', async (req, res) => {
  if (!innertube) return res.status(503).json({ error: 'Innertube not ready' });
  try {
    const trending = await innertube.getTrending();
    const videos = trending.videos || [];
    res.json({
      items: videos.map(v => ({
        id: v.id,
        snippet: {
          title: v.title?.text || '',
          channelId: v.author?.id || '',
          channelTitle: v.author?.name || '',
          thumbnails: { medium: { url: v.thumbnails?.[v.thumbnails.length - 1]?.url || '' } },
          publishedAt: v.published?.text || ''
        },
        statistics: { viewCount: v.view_count?.text?.replace(/[^0-9]/g, '') || '0' }
      })),
      nextPageToken: trending.continuations?.next_continuation_token || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 検索
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  const continuation = req.query.continuation;
  if (!q) return res.status(400).json({ error: 'query required' });

  try {
    const search = await innertube.search(q, { type: 'video', continuation });
    res.json({
      items: (search.videos || []).map(v => ({
        id: { videoId: v.id },
        snippet: {
          title: v.title?.text || '',
          channelId: v.author?.id || '',
          channelTitle: v.author?.name || '',
          thumbnails: { medium: { url: v.thumbnails?.[v.thumbnails.length - 1]?.url || '' } }
        }
      })),
      nextPageToken: search.continuations?.next_continuation_token || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 動画詳細エンドポイント（再生回数・高評価・チャンネルアイコンを確実取得）
app.get("/api/video/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const info = await innertube.getInfo(id);
    res.json({
      title: info.title?.text || info.title || '不明',
      description: info.description || '',
      viewCount: info.view_count?.text?.replace(/[^0-9]/g, '') || info.view_count?.short_text || '0',
      published: info.published?.text || info.published?.date || new Date().toISOString(),
      likeCount: info.like_count?.text?.replace(/[^0-9]/g, '') || info.like_count?.short_text || '0',
      channel: {
        id: info.author?.id || '',
        name: info.author?.name || '不明',
        thumbnails: info.author?.thumbnails || info.author?.avatar || [],  // アイコン複数候補から取る
        subscriberCount: info.author?.subscriber_count?.text?.replace(/[^0-9]/g, '') || info.author?.subscribers || '0'
      }
    });
  } catch (err) {
    console.error("Video info error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// コメントエンドポイント（読み込み失敗対策）
app.get("/api/comments/:videoId", async (req, res) => {
  const videoId = req.params.videoId;
  const continuation = req.query.continuation;
  try {
    const commentsData = await innertube.getComments(videoId, { continuation });
    res.json({
      comments: (commentsData.comments || []).map(c => ({
        author: {
          name: c.author?.name || '匿名',
          thumbnails: c.author?.thumbnails || []
        },
        content: c.content?.text || c.content || '',
        published: c.published?.text || ''
      })),
      nextContinuation: commentsData.continuations?.next_continuation_token || null
    });
  } catch (err) {
    console.error("Comments error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// コメント
app.get('/api/comments/:videoId', async (req, res) => {
  const videoId = req.params.videoId;
  const continuation = req.query.continuation;
  try {
    const comments = await innertube.getComments(videoId, { continuation });
    res.json({
      comments: (comments.comments || []).map(c => ({
        author: {
          name: c.author?.name || '匿名',
          thumbnails: c.author?.thumbnails || []
        },
        content: c.content?.text || '',
        published: c.published?.text || ''
      })),
      nextContinuation: comments.continuations?.next_continuation_token || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// チャンネル情報 + 動画一覧（簡易）
app.get('/api/channel/:channelId', async (req, res) => {
  const channelId = req.params.channelId;
  const continuation = req.query.continuation;
  try {
    const channel = await innertube.getChannel(channelId);
    const videos = await channel.getVideos({ continuation });
    res.json({
      title: channel.header?.title?.text || channel.metadata?.title || '',
      description: channel.metadata?.description || '',
      avatar: channel.avatar?.thumbnails?.[channel.avatar.thumbnails.length - 1]?.url || '',
      subscribers: channel.metadata?.subscribers?.text?.replace(/[^0-9]/g, '') || '0',
      videos: (videos.videos || []).map(v => ({
        id: v.id,
        title: v.title?.text || '',
        thumbnails: { medium: { url: v.thumbnails?.[v.thumbnails.length - 1]?.url || '' } },
        publishedAt: v.published?.text || '',
        viewCount: v.view_count?.text?.replace(/[^0-9]/g, '') || '0'
      })),
      nextContinuation: videos.continuations?.next_continuation_token || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
