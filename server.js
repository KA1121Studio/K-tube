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
      // 2026年現在の推奨オプション（ドキュメントに基づく）
      // retrieve_player: true,  ← 最新版ではデフォルトで扱われることが多く、明示不要の場合あり。ストリーミングが必要なら有効
      // cache: new UniversalCache(false),  ← キャッシュはオプション。Node.jsサーバーではメモリキャッシュ有効がおすすめだが、UniversalCacheは最新版で非推奨/削除の可能性あり（READMEに記載なし）
      // generate_session_locally: true,  ← セッションをローカル生成（推奨）
      // client_type: 'WEB' など（デフォルトでOK）
    });
    console.log('Innertube ready!');
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
    const trending = await innertube.getTrending(); // 日本向けトレンド動画
    const videos = trending.videos.slice(0, 12); // 最大12件

    res.json({
      items: videos.map(v => ({
        id: v.id,
        snippet: {
          title: v.title.text,
          channelTitle: v.author?.name || "Unknown",
          channelId: v.author?.id || "",
          thumbnails: { medium: { url: v.thumbnails[0]?.url || "" } },
          publishedAt: v.published?.text || new Date().toISOString()
        },
        statistics: {
          viewCount: v.view_count?.text?.replace(/\D/g, '') || "0"
        }
      })),
      nextPageToken: trending.continuations?.next_continuation_token || null
    });
  } catch (err) {
    console.error("Popular error:", err);
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

// 動画詳細 + 関連 + チャンネル情報
app.get('/api/video/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const info = await innertube.getInfo(id);
    res.json({
      title: info.title?.text || '',
      description: info.description || '',
      viewCount: info.view_count?.text?.replace(/[^0-9]/g, '') || '0',
      published: info.published?.text || '',
      likeCount: info.like_count?.text?.replace(/[^0-9]/g, '') || '0',
      channel: {
        id: info.author?.id || '',
        name: info.author?.name || '',
        thumbnails: info.author?.thumbnails || [],
        subscriberCount: info.author?.subscriber_count?.text?.replace(/[^0-9]/g, '') || '0'
      },
      related: (info.related_videos || []).map(v => ({
        id: v.id,
        title: v.title?.text || '',
        author: v.author?.name || '',
        thumbnails: v.thumbnails || [],
        viewCount: v.view_count?.text?.replace(/[^0-9]/g, '') || '0'
      }))
    });
  } catch (err) {
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
