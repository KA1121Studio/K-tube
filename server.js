// server.js （統合版）
import express from "express";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import path from "path";
import { Innertube } from "youtubei.js";
import { execSync } from "child_process";

const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 静的ファイル配信（index.html, watch.html などを直接配信）
app.use(express.static(__dirname));  // ← これで /index.html, /watch.html が自動で配信される

// YouTubeクライアント（使ってないなら削除可）
let youtube;
(async () => {
  try {
    youtube = await Innertube.create();
    console.log("YouTube InnerTube client ready");
  } catch (e) {
    console.warn("InnerTube init failed", e);
  }
})();

// ルートで index.html を返す（任意だがわかりやすい）
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// watch.html を明示的に（なくてもOK）
app.get("/watch.html", (req, res) => {
  res.sendFile(path.join(__dirname, "watch.html"));
});

// ★ yt-dlp で署名付きURLを取得（オリジナルプレイヤー用）
app.get("/video", async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).json({ error: "video id required" });

  try {
    // yt-dlpコマンド（あなたの元コードをほぼそのまま）
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

// プロキシ（動画チャンク配信用） ← 重要！これがないと403エラー多発
app.get("/proxy", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("URL required");

  const range = req.headers.range || "bytes=0-";

  try {
    const response = await fetch(url, {
      headers: { Range: range }
    });

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

// HLS用プロキシ（必要なら拡張）
app.get("/proxy-hls", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("URL required");

  try {
    const r = await fetch(url);
    let text = await r.text();

    // m3u8内のURLを /proxy にリライト
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
