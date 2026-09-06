const {
  ItemView,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} = require("obsidian");
const { shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");

const VIEW_TYPE = "youtube-listening-player";
const OUTPUT_FOLDER = "视频精听";
const DEFAULT_SETTINGS = {
  deepseekApiKey: "",
  pythonPath: "",
  audioExportFolder: "",
  transcriptMode: "auto",
};

function expandHome(input) {
  const value = String(input || "").trim();
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function startPlayerServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      const videoId = String(requestUrl.searchParams.get("video") || "");
      const seconds = Math.max(
        0,
        Number(String(requestUrl.searchParams.get("t") || "0")) || 0
      );
      if (requestUrl.pathname !== "/player" || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }

      const address = server.address();
      const origin = `http://127.0.0.1:${address.port}`;
      const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    html,body,#player,iframe{width:100%;height:100%;margin:0;border:0;background:#111;overflow:hidden}
    #error{display:none;position:fixed;inset:0;z-index:2;box-sizing:border-box;padding:28px;background:#151515;color:#eee;font:15px/1.55 system-ui,sans-serif;align-items:center;justify-content:center;text-align:center}
    #error.visible{display:flex} #error div{max-width:420px} #error a{display:inline-block;margin-top:12px;color:#fff;background:#c00;padding:8px 12px;border-radius:5px;text-decoration:none}
  </style>
</head>
<body>
  <div id="player"></div>
  <div id="error"><div><strong id="error-title">视频无法在此播放</strong><br><span id="error-detail"></span><br><a id="external-link" target="_blank" rel="noreferrer">在默认浏览器打开</a></div></div>
  <script>
    const videoId = ${JSON.stringify(videoId)};
    const startSeconds = ${seconds};
    const pageOrigin = ${JSON.stringify(origin)};
    let player = null;
    let playerReady = false;
    let lastCommand = null;
    const pendingCommands = [];

    function showError(code) {
      const details = {
        2: "YouTube 收到无效的播放器参数（错误 2）。",
        5: "YouTube 的 HTML5 播放器发生错误（错误 5）。",
        100: "此视频可能已下架、设为私密，或在当前地区不可用（错误 100）。",
        101: "发布者禁止将此视频嵌入第三方应用（错误 101）。",
        150: "发布者禁止将此视频嵌入第三方应用（错误 150）。",
        153: "YouTube 未接受此内嵌播放器的身份验证（错误 153）。",
      };
      document.getElementById("error-detail").textContent = details[code] || "YouTube 播放器错误（错误 " + code + "）。";
      document.getElementById("external-link").href = "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId) + "&t=" + Math.floor(startSeconds) + "s";
      document.getElementById("error").classList.add("visible");
      parent.postMessage({
        source: "youtube-listening-player",
        type: "error",
        videoId,
        code,
      }, "*");
    }

    function reportTime() {
      if (!playerReady || !player || typeof player.getCurrentTime !== "function") return;
      const currentTime = Number(player.getCurrentTime());
      if (!Number.isFinite(currentTime)) return;
      parent.postMessage({
        source: "youtube-listening-player",
        type: "time",
        videoId,
        seconds: currentTime,
      }, "*");
    }

    function reportSentenceNavigation(direction) {
      if (!playerReady || !player || typeof player.getCurrentTime !== "function") return;
      const currentTime = Number(player.getCurrentTime());
      if (!Number.isFinite(currentTime)) return;
      parent.postMessage({
        source: "youtube-listening-player",
        type: "sentence-navigation",
        videoId,
        direction: direction === "next"
          ? "next"
          : direction === "previous"
            ? "previous"
            : "current",
        seconds: currentTime,
      }, "*");
    }

    function reportSentenceReplay() {
      if (!playerReady || !player || typeof player.getCurrentTime !== "function") return;
      const currentTime = Number(player.getCurrentTime());
      if (!Number.isFinite(currentTime)) return;
      parent.postMessage({
        source: "youtube-listening-player",
        type: "sentence-replay",
        videoId,
        seconds: currentTime,
        requestedAt: Date.now(),
      }, "*");
    }

    function reportPlayerState(event) {
      reportTime();
      if (!playerReady || !player || typeof player.getCurrentTime !== "function") return;
      const currentTime = Number(player.getCurrentTime());
      const now = Date.now();
      const recentCommand = lastCommand && now - lastCommand.at < 1500
        ? lastCommand.func
        : "";
      parent.postMessage({
        source: "youtube-listening-player",
        type: "player-state",
        videoId,
        state: Number(event?.data),
        seconds: Number.isFinite(currentTime) ? currentTime : 0,
        recentCommand,
      }, "*");
    }

    function requestPlaybackToggle() {
      parent.postMessage({
        source: "youtube-listening-player",
        type: "playback-toggle-request",
        videoId,
      }, "*");
    }

    function runCommand(payload) {
      if (!playerReady) {
        if (payload.func !== "togglePlayback") pendingCommands.push(payload);
        return;
      }
      lastCommand = { func: payload.func, at: Date.now() };
      if (payload.func === "seekTo") {
        const target = Math.max(0, Number(payload.args?.[0]) || 0);
        player.seekTo(target, true);
        reportTime();
      } else if (payload.func === "playVideo") {
        player.playVideo();
      } else if (payload.func === "togglePlayback") {
        if (Number(player.getPlayerState()) === 1) player.pauseVideo();
        else player.playVideo();
        reportTime();
      } else if (payload.func === "sentenceNavigation") {
        reportSentenceNavigation(payload.args?.[0]);
      } else if (payload.func === "sentenceReplay") {
        reportSentenceReplay();
      }
    }

    window.onYouTubeIframeAPIReady = () => {
      player = new YT.Player("player", {
        videoId,
        playerVars: {
          autoplay: 1,
          rel: 0,
          start: startSeconds,
          origin: pageOrigin,
        },
        events: {
          onReady: () => {
            playerReady = true;
            while (pendingCommands.length) runCommand(pendingCommands.shift());
            reportTime();
            window.setInterval(reportTime, 250);
          },
          onStateChange: reportPlayerState,
          onError: (event) => showError(event.data),
        },
      });
    };

    window.addEventListener("message", (event) => {
      if (event.source !== parent) return;
      let payload = event.data;
      try { if (typeof payload === "string") payload = JSON.parse(payload); } catch (_) { return; }
      if (!payload || payload.event !== "command") return;
      runCommand(payload);
    });

    document.body.tabIndex = -1;
    document.addEventListener("keydown", (event) => {
      if (
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        ![" ", "ArrowLeft", "ArrowDown", "ArrowRight"].includes(event.key)
      ) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === " ") {
        requestPlaybackToggle();
      } else if (event.key === "ArrowDown") {
        reportSentenceReplay();
      } else {
        reportSentenceNavigation(event.key === "ArrowRight" ? "next" : "previous");
      }
    }, true);

    window.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (document.activeElement?.tagName !== "IFRAME") return;
        window.focus();
        document.body.focus({ preventScroll: true });
      }, 80);
    });
  <\/script>
  <script src="https://www.youtube.com/iframe_api"><\/script>
</body>
</html>`;
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Cache-Control": "no-store",
      });
      response.end(html);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function parseYouTubeTimestamp(rawHref) {
  if (!rawHref) return null;
  let url;
  try {
    url = new URL(rawHref);
  } catch (_) {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "");
  let videoId = null;
  if (host === "youtu.be") videoId = url.pathname.split("/").filter(Boolean)[0];
  if (host.endsWith("youtube.com")) videoId = url.searchParams.get("v");
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;

  const rawTime = url.searchParams.get("t") || url.searchParams.get("start");
  if (!rawTime) return null;
  const seconds = Number(rawTime.replace(/s$/i, ""));
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return { platform: "youtube", videoId, seconds, cid: 0, page: 1, external: false };
}

function parseListeningTimestamp(rawHref) {
  if (!rawHref) return null;
  let url;
  try {
    url = new URL(rawHref);
  } catch (_) {
    return null;
  }
  if (url.protocol !== "obsidian:" || url.hostname !== "youtube-listening") {
    return null;
  }
  const platform = String(url.searchParams.get("platform") || "youtube");
  const videoId = String(url.searchParams.get("video") || "");
  const seconds = Number(String(url.searchParams.get("t") || ""));
  const validVideo = platform === "bilibili"
    ? /^BV[0-9A-Za-z]+$/i.test(videoId)
    : /^[A-Za-z0-9_-]{11}$/.test(videoId);
  if (!validVideo || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return {
    platform,
    videoId,
    seconds,
    cid: Number.parseInt(String(url.searchParams.get("cid") || ""), 10) || 0,
    page: Number.parseInt(String(url.searchParams.get("p") || ""), 10) || 1,
    external: url.searchParams.get("external") === "1",
    sentence: url.searchParams.get("sentence") === "1",
  };
}

function parseTimestampTarget(rawHref) {
  return parseListeningTimestamp(rawHref) || parseYouTubeTimestamp(rawHref);
}

class ListeningPlayerView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.videoId = null;
    this.platform = null;
    this.cid = 0;
    this.page = 1;
    this.seconds = 0;
    this.iframe = null;
    this.webview = null;
    this.frameWrap = null;
    this.biliTimer = null;
    this.openButton = null;
    this.followButton = null;
    this.exportButton = null;
    this.keyboardSurface = null;
    this.lastPlaybackError = null;
    this.lastPlaybackToggleAt = 0;
    this.replayRequestGeneration = 0;
    this.lastReplayCancelAt = 0;
    this.playbackStatus = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "口语精听播放器";
  }

  getIcon() {
    return "headphones";
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("youtube-listening-player");
    container.setAttr("tabindex", "-1");
    this.keyboardSurface = container;

    const toolbar = container.createDiv({ cls: "youtube-listening-toolbar" });
    toolbar.createSpan({ text: "点击笔记时间戳后在这里播放" });
    this.playbackStatus = toolbar.createSpan({ text: "播放器状态：等待播放" });
    const actions = toolbar.createDiv({ cls: "youtube-listening-toolbar-actions" });
    this.followButton = actions.createEl("button");
    this.updateFollowButton();
    this.followButton.addEventListener("click", () => {
      this.plugin.setTranscriptFollow(!this.plugin.followTranscript);
    });
    this.exportButton = actions.createEl("button", { text: "导出复听音频" });
    this.exportButton.disabled = false;
    this.exportButton.addEventListener("click", () => {
      void this.plugin.exportReviewAudio(this);
    });
    this.openButton = actions.createEl("button", { text: "默认浏览器打开" });
    this.openButton.disabled = true;
    this.openButton.addEventListener("click", () => {
      if (!this.videoId) return;
      shell.openExternal(this.plugin.playerUrl(this));
    });

    this.frameWrap = container.createDiv({ cls: "youtube-listening-frame-wrap" });
  }

  updateFollowButton() {
    if (!this.followButton) return;
    const enabled = this.plugin.followTranscript;
    this.followButton.setText(`字幕跟随：${enabled ? "开" : "关"}`);
    this.followButton.toggleClass("is-active", enabled);
    this.followButton.setAttr(
      "aria-label",
      enabled ? "点击暂停左侧字幕跟随" : "点击恢复左侧字幕跟随"
    );
  }

  setAudioExportState(running) {
    if (!this.exportButton) return;
    this.exportButton.disabled = Boolean(running);
    this.exportButton.setText(running ? "正在导出…" : "导出复听音频");
  }

  updateCurrentTime(seconds) {
    if (!Number.isFinite(seconds)) return;
    this.seconds = Math.max(0, seconds);
  }

  cancelSentenceReplay() {
    this.replayRequestGeneration += 1;
    this.lastReplayCancelAt = Date.now();
  }

  beginSentenceReplay(requestedAt = Date.now()) {
    if (Number(requestedAt) <= this.lastReplayCancelAt) return -1;
    this.replayRequestGeneration += 1;
    return this.replayRequestGeneration;
  }

  isSentenceReplayCurrent(generation, requestedAt) {
    return generation >= 0 &&
      generation === this.replayRequestGeneration &&
      Number(requestedAt) > this.lastReplayCancelAt;
  }

  updatePlaybackStatus(state, recentCommand = "") {
    if (!this.playbackStatus) return;
    if (state === 1) {
      this.playbackStatus.setText("播放器状态：播放中");
      return;
    }
    if (state !== 2) return;
    const reason = recentCommand === "togglePlayback"
      ? "空格键"
      : "YouTube 播放器";
    this.playbackStatus.setText(`播放器状态：已暂停（${reason}）`);
  }

  clearFrame() {
    if (this.biliTimer) window.clearInterval(this.biliTimer);
    this.biliTimer = null;
    this.webview = null;
    this.iframe = null;
    this.frameWrap.empty();
  }

  sendYouTubeCommand(func, args = []) {
    this.iframe?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args }),
      "*"
    );
  }

  async requestSentenceNavigation(direction) {
    if (!this.videoId) return;
    this.cancelSentenceReplay();
    if (this.platform === "bilibili") {
      let seconds = this.seconds;
      try {
        const current = await this.webview?.executeJavaScript(
          "window.player?.getCurrentTime?.() ?? null"
        );
        if (Number.isFinite(current)) seconds = current;
      } catch (_) {}
      void this.plugin.navigateSentence(direction, seconds, this);
      return;
    }
    this.sendYouTubeCommand("sentenceNavigation", [direction]);
  }

  async requestSentenceReplay() {
    if (!this.videoId) return;
    const requestedAt = Date.now();
    if (this.platform === "bilibili") {
      let seconds = this.seconds;
      try {
        const current = await this.webview?.executeJavaScript(
          "window.player?.getCurrentTime?.() ?? null"
        );
        if (Number.isFinite(current)) seconds = current;
      } catch (_) {}
      void this.plugin.replayCurrentSentence(seconds, this, requestedAt);
      return;
    }
    this.sendYouTubeCommand("sentenceReplay");
  }

  restoreSentenceKeyboardFocus() {
    if (document.activeElement !== this.iframe || !this.keyboardSurface) return;
    this.keyboardSurface.focus({ preventScroll: true });
  }

  async togglePlayback() {
    if (!this.videoId) return;
    const now = Date.now();
    if (now - this.lastPlaybackToggleAt < 350) return;
    this.lastPlaybackToggleAt = now;
    this.cancelSentenceReplay();
    if (this.platform === "bilibili") {
      try {
        await this.webview?.executeJavaScript(
          "const player = window.player; if (!player) null; else if (player.isPaused?.()) player.play?.(); else player.pause?.();"
        );
      } catch (_) {}
      return;
    }
    this.sendYouTubeCommand("togglePlayback");
  }

  replayRange(startSeconds) {
    if (!this.videoId) return;
    this.seek(
      {
        platform: this.platform || "youtube",
        videoId: this.videoId,
        cid: this.cid,
        page: this.page,
      },
      startSeconds
    );
  }

  loadYouTube(videoId, seconds) {
    this.clearFrame();
    this.iframe = this.frameWrap.createEl("iframe");
    this.iframe.setAttr("title", "YouTube listening player");
    this.iframe.setAttr("allow", "autoplay; encrypted-media; picture-in-picture");
    this.iframe.setAttr("allowfullscreen", "true");
    this.iframe.src = `${this.plugin.playerBaseUrl}/player?video=${encodeURIComponent(videoId)}&t=${seconds}`;
  }

  loadBilibili(videoId, cid, page, seconds) {
    this.clearFrame();
    this.webview = this.frameWrap.createEl("webview");
    this.webview.setAttr("title", "Bilibili listening player");
    this.webview.setAttr("allowfullscreen", "true");
    this.webview.setAttr("src", `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(videoId)}&cid=${cid}&p=${page}&autoplay=1`);
    this.webview.addEventListener("dom-ready", async () => {
      if (!this.webview || typeof this.webview.executeJavaScript !== "function") {
        new Notice("当前 Obsidian 无法读取 B 站播放器进度；可播放，但字幕不会自动跟随");
        return;
      }
      await this.seekBilibili(seconds);
      this.biliTimer = window.setInterval(async () => {
        try {
          const current = await this.webview.executeJavaScript("window.player?.getCurrentTime?.() ?? null");
          if (Number.isFinite(current)) {
            this.updateCurrentTime(current);
            this.plugin.syncTranscriptAt(this.videoId, current);
          }
        } catch (_) {}
      }, 300);
    });
  }

  async seekBilibili(seconds) {
    if (!this.webview || typeof this.webview.executeJavaScript !== "function") return;
    const target = Math.max(0, Number(seconds) || 0);
    try {
      await this.webview.executeJavaScript(`window.player?.seek?.(${target}); window.player?.play?.();`);
    } catch (_) {}
  }

  seek(target, seconds) {
    const { videoId, platform = "youtube", cid = 0, page = 1 } = target;
    this.cancelSentenceReplay();
    this.seconds = seconds;
    this.openButton.disabled = false;
    this.setAudioExportState(this.plugin.audioExportRunning);
    if (platform === "bilibili") {
      if (this.platform !== platform || this.videoId !== videoId || this.cid !== cid || !this.webview) {
        this.platform = platform;
        this.videoId = videoId;
        this.cid = cid;
        this.page = page;
        this.loadBilibili(videoId, cid, page, seconds);
      } else {
        this.seekBilibili(seconds);
      }
      return;
    }
    if (this.platform !== platform || this.videoId !== videoId || !this.iframe?.src) {
      this.platform = platform;
      this.videoId = videoId;
      this.cid = 0;
      this.page = 1;
      this.loadYouTube(videoId, seconds);
      return;
    }

    this.sendYouTubeCommand("seekTo", [seconds, true]);
    this.sendYouTubeCommand("playVideo");
  }
}

class ImportVideoModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.url = "";
    this.start = "";
    this.end = "";
    this.apiKey = "";
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "导入 YouTube / B站口语精听稿" });
    contentEl.createEl("p", {
      text: "只填链接会导入整条视频；如只想精读其中一段，再填写开始和结束时间。",
    });

    new Setting(contentEl)
      .setName("视频链接")
      .addText((text) =>
        text
          .setPlaceholder("YouTube 或 bilibili.com/video/BV... 链接")
          .onChange((value) => (this.url = value.trim()))
      );

    new Setting(contentEl)
      .setName("片段开始（可选）")
      .setDesc("例如 02:30")
      .addText((text) => text.onChange((value) => (this.start = value.trim())));

    new Setting(contentEl)
      .setName("片段结束（可选）")
      .setDesc("例如 07:00")
      .addText((text) => text.onChange((value) => (this.end = value.trim())));

    if (!this.plugin.hasDeepSeekApiKey() && this.plugin.settings.transcriptMode !== "local") {
      new Setting(contentEl)
        .setName("DeepSeek API 密钥（可选）")
        .setDesc("自动模式可留空并使用本地字幕；AI 精校模式必须填写。")
        .addText((text) => {
          text.inputEl.type = "password";
          text.setPlaceholder("sk-...");
          text.onChange((value) => (this.apiKey = value.trim()));
        });
    }

    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText("导入到 Obsidian")
        .setCta()
        .onClick(async () => {
          if (!this.url) {
            new Notice("请先粘贴 YouTube 或 B 站链接");
            return;
          }
          if (
            this.plugin.settings.transcriptMode === "ai" &&
            !this.plugin.hasDeepSeekApiKey() &&
            !this.apiKey
          ) {
            new Notice("AI 精校模式需要 DeepSeek API 密钥");
            return;
          }
          button.setDisabled(true);
          button.setButtonText("正在提取字幕…");
          try {
            if (this.apiKey) await this.plugin.saveDeepSeekApiKey(this.apiKey);
            await this.plugin.importVideo(this.url, this.start, this.end);
            this.close();
          } catch (error) {
            new Notice(error.message || String(error), 12000);
            button.setDisabled(false);
            button.setButtonText("导入到 Obsidian");
          }
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

function secondsLabel(seconds) {
  const totalTenths = Math.round(Math.max(0, Number(seconds) || 0) * 10);
  const total = Math.floor(totalTenths / 10);
  const decimal = totalTenths % 10;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remain = total % 60;
  const label = [hours, minutes, remain]
    .map((value, index) => (index === 0 && hours === 0 ? null : String(value).padStart(2, "0")))
    .filter((value) => value !== null)
    .join(":");
  return decimal ? `${label}.${decimal}` : label;
}

function parseClockSeconds(value) {
  const parts = String(value || "")
    .trim()
    .split(":")
    .map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part) || part < 0)) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function normalizedWordTokens(text) {
  return (String(text || "").match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [])
    .map((token) => token.replace(/’/g, "'").toLocaleLowerCase("en-US"));
}

function splitEnglishSentences(text) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!source) return [];
  if (typeof Intl?.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
    const sentences = Array.from(segmenter.segment(source), (part) => part.segment.trim())
      .filter(Boolean);
    if (sentences.length) return sentences;
  }
  return source.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g)?.map((part) => part.trim()).filter(Boolean) || [source];
}

function lcsTokenMap(cleanTokens, sourceTokens) {
  const rows = cleanTokens.length + 1;
  const columns = sourceTokens.length + 1;
  const table = Array.from({ length: rows }, () => new Uint16Array(columns));
  for (let row = cleanTokens.length - 1; row >= 0; row -= 1) {
    for (let column = sourceTokens.length - 1; column >= 0; column -= 1) {
      table[row][column] = cleanTokens[row] === sourceTokens[column]
        ? table[row + 1][column + 1] + 1
        : Math.max(table[row + 1][column], table[row][column + 1]);
    }
  }

  const mapping = new Map();
  let row = 0;
  let column = 0;
  while (row < cleanTokens.length && column < sourceTokens.length) {
    if (cleanTokens[row] === sourceTokens[column]) {
      mapping.set(row, column);
      row += 1;
      column += 1;
    } else if (table[row + 1][column] >= table[row][column + 1]) {
      row += 1;
    } else {
      column += 1;
    }
  }
  return mapping;
}

function hrefAtSentence(baseHref, seconds) {
  const url = new URL(baseHref);
  url.searchParams.set("t", String(Math.round(Math.max(0, seconds) * 1000) / 1000));
  url.searchParams.set("sentence", "1");
  return url.toString();
}

function attachSentenceTimings(cleaned, sourceSegments, rawTimedWords) {
  let timedWords = (Array.isArray(rawTimedWords) ? rawTimedWords : [])
    .flatMap((word) => normalizedWordTokens(word?.text).map((text) => ({
      text,
      t: Number(word?.t),
    })))
    .filter((word) => Number.isFinite(word.t) && word.t >= 0);

  if (!timedWords.length) {
    timedWords = sourceSegments.flatMap((segment) =>
      normalizedWordTokens(segment.text).map((text) => ({ text, t: Number(segment.t) || 0 }))
    );
  }
  timedWords.sort((left, right) => left.t - right.t);

  const prepared = cleaned.map((paragraph) => ({
    paragraph,
    sentences: splitEnglishSentences(paragraph.text).map((text) => ({
      text,
      tokens: normalizedWordTokens(text),
      t: null,
    })),
  }));

  // Align sentences in one monotonic pass across the whole video. AI paragraph
  // boundaries may begin in the middle of a human-caption cue, so paragraph
  // timestamps must never be used to restrict the word search.
  let cursor = 0;
  let previousTime = timedWords[0]?.t ?? Number(cleaned[0]?.t) ?? 0;
  for (const group of prepared) {
    for (const sentence of group.sentences) {
      const windowLength = Math.max(80, sentence.tokens.length * 4);
      const window = timedWords.slice(cursor, cursor + windowLength);
      const mapping = lcsTokenMap(sentence.tokens, window.map((word) => word.text));
      const matches = [];
      for (let cleanIndex = 0; cleanIndex < sentence.tokens.length; cleanIndex += 1) {
        if (mapping.has(cleanIndex)) {
          matches.push({ clean: cleanIndex, source: mapping.get(cleanIndex) });
        }
      }

      const enoughMatches = matches.length >= Math.min(3, sentence.tokens.length) ||
        matches.length / Math.max(1, sentence.tokens.length) >= 0.35;
      if (matches.length && enoughMatches) {
        const first = matches[0];
        const unmatchedPrefix = first.clean;
        const sourceIndex = Math.max(cursor, cursor + first.source - unmatchedPrefix);
        const lastSourceIndex = cursor + matches[matches.length - 1].source;
        sentence.t = timedWords[sourceIndex]?.t;
        cursor = Math.max(cursor, lastSourceIndex + 1);
      }

      if (!Number.isFinite(sentence.t)) {
        const paragraphTime = Number(group.paragraph.t);
        sentence.t = Math.max(previousTime, Number.isFinite(paragraphTime) ? paragraphTime : previousTime);
      }
      sentence.t = Math.max(previousTime, sentence.t);
      previousTime = sentence.t;
    }
  }

  return prepared.map(({ paragraph, sentences }) => ({
    ...paragraph,
    sentences: sentences.map((sentence) => ({
      t: sentence.t,
      href: hrefAtSentence(paragraph.href, sentence.t),
      text: sentence.text,
    })),
  }));
}

function localTranscriptParagraphs(sourceSegments) {
  const paragraphs = [];
  let current = null;
  for (const segment of sourceSegments) {
    const t = Number(segment?.t);
    const text = String(segment?.text || "").replace(/\s+/g, " ").trim();
    if (!Number.isFinite(t) || !text) continue;
    const gap = current && t - current.lastTime > 5;
    if (!current || gap || current.count >= 4) {
      current = { t, href: segment.href, speaker: "", text, lastTime: t, count: 1 };
      paragraphs.push(current);
    } else {
      current.text += ` ${text}`;
      current.lastTime = t;
      current.count += 1;
    }
  }
  return paragraphs.map(({ lastTime, count, ...paragraph }) => paragraph);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decodeHtmlAttribute(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function uniquePath(vault, parentPath, baseName) {
  let suffix = 0;
  let candidate = `${parentPath}/${baseName}.md`;
  while (vault.getAbstractFileByPath(candidate)) {
    suffix += 1;
    candidate = `${parentPath}/${baseName} (${suffix + 1}).md`;
  }
  return candidate;
}

function postJson(url, headers, payload) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: "POST", headers, timeout: 120000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (_) {}
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(parsed?.error?.message || `DeepSeek 请求失败（HTTP ${response.statusCode}）`));
          return;
        }
        resolve(parsed);
      });
    });
    request.on("timeout", () => request.destroy(new Error("DeepSeek 请求超时，请稍后重试")));
    request.on("error", reject);
    request.write(JSON.stringify(payload));
    request.end();
  });
}

class ListeningLabSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "视频口语精听" });
    containerEl.createEl("p", {
      text: "字幕可完全在本地生成，也可选择使用 DeepSeek 进一步整理断句和说话轮次。",
    });
    new Setting(containerEl)
      .setName("字幕处理模式")
      .setDesc("自动模式在 DeepSeek 不可用时会回退到本地字幕，确保仍能创建笔记。")
      .addDropdown((dropdown) => dropdown
        .addOption("auto", "自动（推荐）")
        .addOption("local", "仅本地，不消耗 Token")
        .addOption("ai", "DeepSeek 精校")
        .setValue(this.plugin.settings.transcriptMode || "auto")
        .onChange(async (value) => {
          this.plugin.settings.transcriptMode = value;
          await this.plugin.saveData(this.plugin.settings);
          this.display();
        }));
    const saved = this.plugin.hasDeepSeekApiKey();
    new Setting(containerEl)
      .setName("DeepSeek API 密钥")
      .setDesc(saved ? this.plugin.deepSeekStorageDescription() : "未设置。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("sk-...");
        text.onChange((value) => (this.pendingKey = value.trim()));
      })
      .addButton((button) => button.setButtonText("保存密钥").onClick(async () => {
        if (!this.pendingKey) {
          new Notice("请先输入 API 密钥；留空不会修改已保存的密钥");
          return;
        }
        try {
          await this.plugin.saveDeepSeekApiKey(this.pendingKey);
          this.pendingKey = "";
          new Notice("DeepSeek API 密钥已保存到此电脑");
          this.display();
        } catch (error) {
          new Notice(error.message || String(error));
        }
      }));
    if (saved) {
      new Setting(containerEl).addButton((button) => button
        .setButtonText("删除已保存密钥")
        .setWarning()
        .onClick(async () => {
          await this.plugin.clearDeepSeekApiKey();
          new Notice("已删除本机保存的 DeepSeek API 密钥");
          this.display();
        }));
    }

    new Setting(containerEl)
      .setName("Python 可执行文件")
      .setDesc("可留空自动检测。macOS 可填写 /opt/homebrew/bin/python3，Windows 可填写 python。")
      .addText((text) => text
        .setPlaceholder("自动检测")
        .setValue(this.plugin.settings.pythonPath || "")
        .onChange(async (value) => {
          this.plugin.settings.pythonPath = value.trim();
          await this.plugin.saveData(this.plugin.settings);
        }));

    new Setting(containerEl)
      .setName("复听音频导出目录")
      .setDesc("可留空自动选择 iCloud Drive、OneDrive 或笔记库内目录；支持以 ~/ 开头的路径。")
      .addText((text) => text
        .setPlaceholder("自动选择")
        .setValue(this.plugin.settings.audioExportFolder || "")
        .onChange(async (value) => {
          this.plugin.settings.audioExportFolder = value.trim();
          await this.plugin.saveData(this.plugin.settings);
        }));
  }
}

module.exports = class YouTubeListeningPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.followTranscript = true;
    this.syncView = null;
    this.syncVideoId = null;
    this.transcriptIndex = [];
    this.transcriptEndSeconds = 0;
    this.audioExportRunning = false;
    this.currentSyncIndex = -1;
    this.highlightEls = [];
    this.currentBadge = null;
    this.refreshTranscriptTimer = null;
    this.highlightRetryTimer = null;
    this.transcriptResyncTimer = null;

    const playerServer = await startPlayerServer();
    this.playerServer = playerServer.server;
    this.playerBaseUrl = playerServer.baseUrl;
    this.registerView(VIEW_TYPE, (leaf) => new ListeningPlayerView(leaf, this));

    this.addRibbonIcon("headphones", "导入视频口语精听稿", () => {
      new ImportVideoModal(this.app, this).open();
    });
    this.addSettingTab(new ListeningLabSettingsTab(this.app, this));

    this.addCommand({
      id: "import-youtube-listening-note",
      name: "导入 YouTube / B站口语精听稿",
      callback: () => new ImportVideoModal(this.app, this).open(),
    });
    this.addCommand({
      id: "replay-current-sentence-once",
      name: "从当前句开头重播（盲听）",
      hotkeys: [{ modifiers: ["Alt"], key: "R" }],
      callback: () => this.replayCurrentSentence(),
    });
    this.addCommand({
      id: "export-current-listening-audio",
      name: "导出当前精听稿复听音频",
      callback: () => this.exportReviewAudio(this.getPlayerView()),
    });

    this.registerObsidianProtocolHandler("youtube-listening", async (params) => {
      const target = parseListeningTimestamp(`obsidian://youtube-listening?${new URLSearchParams(params).toString()}`);
      if (!target) {
        new Notice("这个时间戳链接无效");
        return;
      }
      if (target.external) {
        this.openExternalTimestamp(target.videoId, target.seconds);
        return;
      }
      await this.captureTranscriptView(target.videoId);
      await this.seekPlayer(target, target.seconds);
    });

    this.registerDomEvent(window, "message", (event) => {
      this.handlePlayerMessage(event);
    });
    this.registerDomEvent(window, "keydown", (event) => {
      this.handleSentenceArrowKey(event);
    }, true);
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file.path !== this.syncView?.file?.path) return;
        if (this.refreshTranscriptTimer) {
          window.clearTimeout(this.refreshTranscriptTimer);
        }
        this.refreshTranscriptTimer = window.setTimeout(() => {
          this.refreshTranscriptIndex();
        }, 200);
      })
    );
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      this.scheduleTranscriptResync(300);
      window.setTimeout(() => this.restoreTranscriptReadingViews(), 80);
    }));
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.scheduleTranscriptResync(300);
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        window.setTimeout(() => this.restoreTranscriptReadingViews(), 100);
      })
    );
    this.app.workspace.onLayoutReady(() => this.restoreTranscriptReadingViews());

    const interceptTimestamp = (event) => this.interceptTimestamp(event);
    this.registerDomEvent(document, "mousedown", interceptTimestamp, true);
    this.registerDomEvent(document, "click", interceptTimestamp, true);
    this.registerMarkdownPostProcessor((element) => {
      for (const anchor of element.querySelectorAll("a")) {
        const href =
          anchor.getAttribute("data-href") ||
          anchor.getAttribute("href") ||
          anchor.href;
        const target = parseTimestampTarget(href);
        if (!target) continue;
        anchor.addClass(target.sentence ? "youtube-listening-sentence-play" : "youtube-listening-timestamp");
        anchor.addEventListener("mousedown", interceptTimestamp, true);
        anchor.addEventListener("click", interceptTimestamp, true);
      }
    });
  }

  async onunload() {
    if (this.refreshTranscriptTimer) {
      window.clearTimeout(this.refreshTranscriptTimer);
    }
    if (this.highlightRetryTimer) {
      window.clearTimeout(this.highlightRetryTimer);
    }
    if (this.transcriptResyncTimer) {
      window.clearTimeout(this.transcriptResyncTimer);
    }
    this.clearTranscriptHighlight();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    if (this.playerServer) {
      await new Promise((resolve) => this.playerServer.close(resolve));
    }
  }

  async interceptTimestamp(event) {
    const anchor = event.target.closest?.("a");
    if (!anchor) return;
    const href =
      anchor.getAttribute("data-href") ||
      anchor.getAttribute("href") ||
      anchor.href;
    const target = parseTimestampTarget(href);
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "mousedown") {
      if (target.external) {
        this.openExternalTimestamp(target.videoId, target.seconds);
        return;
      }
      await this.captureTranscriptView(target.videoId);
      await this.seekPlayer(target, target.seconds);
    }
  }

  openExternalTimestamp(videoId, seconds) {
    shell.openExternal(
      `https://www.youtube.com/watch?v=${videoId}&t=${Math.max(0, seconds)}s`
    );
    new Notice("这个视频禁止嵌入，已交给默认浏览器打开");
  }

  playerUrl(player) {
    if (player.platform === "bilibili") {
      return `https://www.bilibili.com/video/${player.videoId}/?p=${player.page}&t=${Math.floor(player.seconds)}`;
    }
    return `https://www.youtube.com/watch?v=${player.videoId}&t=${player.seconds}s`;
  }

  isTranscriptFile(file) {
    if (!file?.path) return false;
    if (file.path.startsWith(`${OUTPUT_FOLDER}/`)) return true;
    return this.app.metadataCache.getFileCache(file)?.frontmatter?.type === "listening-practice";
  }

  async ensureTranscriptReadingView(view) {
    const leaf = view?.leaf || this.app.workspace
      .getLeavesOfType("markdown")
      .find((candidate) => candidate.view === view);
    if (!leaf || !(leaf.view instanceof MarkdownView)) return false;
    const state = leaf.getViewState?.();
    if (!state || state.type !== "markdown") return false;
    if (state.state?.mode === "preview" || leaf.view.getMode?.() === "preview") return true;
    await leaf.setViewState(
      { ...state, state: { ...state.state, mode: "preview" } },
      { replace: true }
    );
    return true;
  }

  async restoreTranscriptReadingViews() {
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      if (!(leaf.view instanceof MarkdownView) || !this.isTranscriptFile(leaf.view.file)) continue;
      await this.ensureTranscriptReadingView(leaf.view);
    }
    if (this.syncVideoId) await this.captureTranscriptView(this.syncVideoId);
    this.scheduleTranscriptResync(150);
  }

  async captureTranscriptView(videoId) {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const candidates = [
      activeView,
      ...this.app.workspace
        .getLeavesOfType("markdown")
        .map((leaf) => leaf.view)
        .filter((view) => view instanceof MarkdownView),
    ].filter((view, index, all) => view?.file && all.indexOf(view) === index);

    for (const view of candidates) {
      const content = await this.app.vault.cachedRead(view.file);
      const transcriptIndex = this.buildTranscriptIndex(content, videoId);
      if (transcriptIndex.length === 0) continue;

      this.clearTranscriptHighlight();
      this.syncView = view;
      this.syncVideoId = videoId;
      this.transcriptIndex = transcriptIndex;
      const segmentMatch = content.match(/^segment:\s*[^\r\n-]+-([^\r\n]+)$/m);
      this.transcriptEndSeconds = parseClockSeconds(segmentMatch?.[1]);
      this.currentSyncIndex = -1;
      return true;
    }

    this.clearTranscriptHighlight();
    this.syncView = null;
    this.syncVideoId = null;
    this.transcriptIndex = [];
    this.transcriptEndSeconds = 0;
    this.currentSyncIndex = -1;
    return false;
  }

  getPlayerView() {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
  }

  async ensureTranscriptIndex(playerView) {
    if (
      this.syncVideoId === playerView.videoId &&
      this.transcriptIndex.length > 0
    ) {
      return true;
    }
    return this.captureTranscriptView(playerView.videoId);
  }

  findCurrentSentenceIndex(seconds) {
    if (this.transcriptIndex.length === 0) return -1;

    const currentSeconds = Math.max(0, Number(seconds) || 0);
    let low = 0;
    let high = this.transcriptIndex.length - 1;
    let current = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (this.transcriptIndex[middle].seconds <= currentSeconds) {
        current = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return current < 0 ? 0 : current;
  }

  nextDistinctSentenceIndex(current) {
    const start = this.transcriptIndex[current]?.seconds;
    if (!Number.isFinite(start)) return -1;

    let next = current + 1;
    while (
      next < this.transcriptIndex.length &&
      this.transcriptIndex[next].seconds <= start + 0.15
    ) {
      next += 1;
    }
    return next < this.transcriptIndex.length ? next : -1;
  }

  previousDistinctSentenceIndex(current) {
    const start = this.transcriptIndex[current]?.seconds;
    if (!Number.isFinite(start)) return -1;

    let previous = current - 1;
    while (
      previous >= 0 &&
      this.transcriptIndex[previous].seconds >= start - 0.15
    ) {
      previous -= 1;
    }
    return previous;
  }

  async navigateSentence(direction, liveSeconds = null, requestedPlayerView = null) {
    const playerView = requestedPlayerView || this.getPlayerView();
    if (!playerView?.videoId) return;
    if (!await this.ensureTranscriptIndex(playerView)) return;

    const current = this.findCurrentSentenceIndex(
      Number.isFinite(liveSeconds) ? liveSeconds : playerView.seconds
    );
    if (current < 0) return;
    const targetIndex = direction === "next"
      ? this.nextDistinctSentenceIndex(current)
      : direction === "previous"
        ? this.previousDistinctSentenceIndex(current)
        : current;
    if (targetIndex < 0) return;

    playerView.seek(
      {
        platform: playerView.platform || "youtube",
        videoId: playerView.videoId,
        cid: playerView.cid,
        page: playerView.page,
      },
      this.transcriptIndex[targetIndex].seconds
    );
  }

  handleSentenceArrowKey(event) {
    if (
      event.isComposing ||
      event.repeat ||
      ![" ", "ArrowLeft", "ArrowDown", "ArrowRight"].includes(event.key) ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }

    const target = event.target;
    if (target?.closest?.("input, textarea, select, [contenteditable='true']")) return;

    const activeView = this.app.workspace.activeLeaf?.view;
    const transcriptIsActive =
      activeView instanceof MarkdownView && this.isTranscriptFile(activeView.file);
    const playerIsActive = activeView?.getViewType?.() === VIEW_TYPE;
    if (!transcriptIsActive && !playerIsActive) return;

    const playerView = this.getPlayerView();
    if (!playerView?.videoId) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === " ") {
      void playerView.togglePlayback();
    } else if (event.key === "ArrowDown") {
      void playerView.requestSentenceReplay();
    } else {
      void playerView.requestSentenceNavigation(
        event.key === "ArrowRight" ? "next" : "previous"
      );
    }
  }

  async replayCurrentSentence(
    liveSeconds = null,
    requestedPlayerView = null,
    requestedAt = Date.now()
  ) {
    const playerView = requestedPlayerView || this.getPlayerView();
    if (!playerView?.videoId) {
      new Notice("请先在右侧播放器中播放一段精听材料");
      return;
    }
    const replayGeneration = playerView.beginSentenceReplay(requestedAt);
    if (replayGeneration < 0) return;
    if (
      this.syncVideoId !== playerView.videoId ||
      this.transcriptIndex.length === 0
    ) {
      const found = await this.captureTranscriptView(playerView.videoId);
      if (!found) {
        new Notice("没有找到这个视频对应的精听稿");
        return;
      }
    }

    if (!playerView.isSentenceReplayCurrent(replayGeneration, requestedAt)) return;

    const current = this.findCurrentSentenceIndex(
      Number.isFinite(liveSeconds) ? liveSeconds : playerView.seconds
    );
    if (current < 0) return;

    const start = this.transcriptIndex[current].seconds;
    playerView.replayRange(start);
  }

  buildTranscriptIndex(content, videoId) {
    const paragraphIndex = [];
    const sentenceIndex = [];
    for (const [lineNumber, line] of content.split(/\r?\n/).entries()) {
      const match = line.match(/^###\s+\[[^\]]+\]\(([^)]+)\)/);
      if (match) {
        const target = parseTimestampTarget(match[1]);
        if (target && target.videoId === videoId && !target.external) {
          paragraphIndex.push({ seconds: target.seconds, line: lineNumber, kind: "paragraph" });
        }
      }
      for (const anchorMatch of line.matchAll(/href="([^"]+)"/g)) {
        const target = parseTimestampTarget(decodeHtmlAttribute(anchorMatch[1]));
        if (!target?.sentence || target.videoId !== videoId || target.external) continue;
        sentenceIndex.push({ seconds: target.seconds, line: lineNumber, kind: "sentence" });
      }
    }
    const transcriptIndex = sentenceIndex.length ? sentenceIndex : paragraphIndex;
    transcriptIndex.sort((left, right) => left.seconds - right.seconds);
    return transcriptIndex;
  }

  async refreshTranscriptIndex() {
    this.refreshTranscriptTimer = null;
    const view = this.syncView;
    const videoId = this.syncVideoId;
    if (!view?.file || !videoId) return;

    const content = await this.app.vault.cachedRead(view.file);
    if (view !== this.syncView || videoId !== this.syncVideoId) return;
    this.transcriptIndex = this.buildTranscriptIndex(content, videoId);
    this.currentSyncIndex = -1;
  }

  handlePlayerMessage(event) {
    if (event.origin !== this.playerBaseUrl) return;
    let payload = event.data;
    try {
      if (typeof payload === "string") payload = JSON.parse(payload);
    } catch (_) {
      return;
    }
    if (!payload || payload.source !== "youtube-listening-player") return;

    const playerLeaf = this.app.workspace
      .getLeavesOfType(VIEW_TYPE)
      .find((leaf) => leaf.view.iframe?.contentWindow === event.source);
    if (!playerLeaf || payload.videoId !== playerLeaf.view.videoId) return;

    if (payload.type === "error") {
      const code = Number(payload.code);
      const errorKey = `${payload.videoId}:${code}`;
      if (playerLeaf.view.lastPlaybackError === errorKey) return;
      playerLeaf.view.lastPlaybackError = errorKey;
      if (code === 101 || code === 150) {
        this.openExternalTimestamp(payload.videoId, playerLeaf.view.seconds);
      } else if (code === 100) {
        new Notice("这个视频已下架、设为私密，或在当前地区不可用（YouTube 错误 100）", 12000);
      } else {
        new Notice(`右侧播放器无法播放这个视频（YouTube 错误 ${code || "未知"}）。可点右上角“默认浏览器打开”。`, 12000);
      }
      return;
    }

    if (payload.type === "time") {
      const seconds = Number(payload.seconds);
      if (!Number.isFinite(seconds) || seconds < 0) return;
      playerLeaf.view.updateCurrentTime(seconds);
      this.syncTranscriptAt(payload.videoId, seconds);
      playerLeaf.view.restoreSentenceKeyboardFocus();
      return;
    }

    if (payload.type === "sentence-navigation") {
      const seconds = Number(payload.seconds);
      if (!Number.isFinite(seconds) || seconds < 0) return;
      playerLeaf.view.cancelSentenceReplay();
      const direction = payload.direction === "next"
        ? "next"
        : payload.direction === "previous"
          ? "previous"
          : "current";
      playerLeaf.view.updateCurrentTime(seconds);
      void this.navigateSentence(direction, seconds, playerLeaf.view);
      return;
    }

    if (payload.type === "playback-toggle-request") {
      void playerLeaf.view.togglePlayback();
      return;
    }

    if (payload.type === "player-state") {
      const seconds = Number(payload.seconds);
      const state = Number(payload.state);
      if (Number.isFinite(seconds) && seconds >= 0) {
        playerLeaf.view.updateCurrentTime(seconds);
      }
      playerLeaf.view.updatePlaybackStatus(state, String(payload.recentCommand || ""));
      return;
    }

    if (payload.type === "sentence-replay") {
      const seconds = Number(payload.seconds);
      if (!Number.isFinite(seconds) || seconds < 0) return;
      playerLeaf.view.updateCurrentTime(seconds);
      void this.replayCurrentSentence(
        seconds,
        playerLeaf.view,
        Number(payload.requestedAt) || Date.now()
      );
    }
  }

  setTranscriptFollow(enabled) {
    this.followTranscript = Boolean(enabled);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      leaf.view.updateFollowButton?.();
    }
    if (!this.followTranscript) {
      this.clearTranscriptHighlight();
      return;
    }

    this.currentSyncIndex = -1;
    const playerView = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    if (playerView?.videoId) {
      this.syncTranscriptAt(playerView.videoId, playerView.seconds);
    }
  }

  scheduleTranscriptResync(delay) {
    if (this.transcriptResyncTimer) {
      window.clearTimeout(this.transcriptResyncTimer);
    }
    this.transcriptResyncTimer = window.setTimeout(async () => {
      this.transcriptResyncTimer = null;
      if (!this.followTranscript || !this.syncVideoId) return;
      const videoId = this.syncVideoId;
      const playerView = this.app.workspace.getLeavesOfType(VIEW_TYPE)
        .map((leaf) => leaf.view)
        .find((view) => view.videoId === videoId);
      if (!playerView) return;
      const found = await this.captureTranscriptView(videoId);
      if (!found) return;
      this.currentSyncIndex = -1;
      this.syncTranscriptAt(videoId, playerView.seconds);
    }, delay);
  }

  syncTranscriptAt(videoId, seconds) {
    if (
      this.followTranscript &&
      videoId === this.syncVideoId &&
      !this.syncView?.containerEl?.isConnected
    ) {
      this.scheduleTranscriptResync(120);
      return;
    }
    if (
      !this.followTranscript ||
      videoId !== this.syncVideoId ||
      !this.syncView?.containerEl?.isConnected ||
      this.transcriptIndex.length === 0
    ) {
      return;
    }

    let low = 0;
    let high = this.transcriptIndex.length - 1;
    let current = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (this.transcriptIndex[middle].seconds <= seconds) {
        current = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (current < 0 || current === this.currentSyncIndex) return;

    this.currentSyncIndex = current;
    const segment = this.transcriptIndex[current];
    const view = this.syncView;
    if (view.getMode?.() === "source" && view.editor) {
      view.editor.scrollIntoView(
        {
          from: { line: segment.line, ch: 0 },
          to: { line: segment.line, ch: 0 },
        },
        true
      );
    }

    this.retryTranscriptHighlight(videoId, segment, view, current, 0);
  }

  retryTranscriptHighlight(videoId, segment, view, current, attempt) {
    if (
      !this.followTranscript ||
      this.syncView !== view ||
      this.currentSyncIndex !== current
    ) {
      return;
    }
    if (this.highlightTranscriptSegment(videoId, segment)) return;
    if (attempt >= 8) return;
    if (this.highlightRetryTimer) window.clearTimeout(this.highlightRetryTimer);
    this.highlightRetryTimer = window.setTimeout(() => {
      this.highlightRetryTimer = null;
      this.retryTranscriptHighlight(videoId, segment, view, current, attempt + 1);
    }, 150);
  }

  highlightTranscriptSegment(videoId, segment) {
    const view = this.syncView;
    if (!view?.containerEl?.isConnected) return false;

    const previewRoots = Array.from(
      view.containerEl.querySelectorAll(".markdown-preview-view")
    );
    const root = previewRoots.find((candidate) => candidate.getClientRects().length > 0) ||
      previewRoots[0] ||
      view.containerEl;

    if (segment.kind === "sentence") {
      const sentence = Array.from(
        root.querySelectorAll(".youtube-listening-sentence[data-start]")
      ).find((candidate) =>
        Math.abs(Number(candidate.getAttribute("data-start")) - segment.seconds) < 0.001
      );
      if (!sentence) return false;
      this.clearTranscriptHighlight();
      sentence.addClass("youtube-listening-current-sentence");
      this.highlightEls = [sentence];
      sentence.scrollIntoView({ block: "center", behavior: "smooth" });
      return true;
    }

    let matchingAnchor = null;
    for (const anchor of root.querySelectorAll("a")) {
      const href =
        anchor.getAttribute("data-href") ||
        anchor.getAttribute("href") ||
        anchor.href;
      const target = parseTimestampTarget(href);
      if (
        target?.videoId === videoId &&
        Math.abs(target.seconds - segment.seconds) < 0.001
      ) {
        matchingAnchor = anchor;
        break;
      }
    }
    if (!matchingAnchor) return false;

    this.clearTranscriptHighlight();
    const heading = matchingAnchor.closest("h3");
    const marker =
      heading ||
      matchingAnchor.closest(".cm-line") ||
      matchingAnchor;
    marker.addClass("youtube-listening-current");
    const textBlock = heading?.nextElementSibling;
    if (textBlock?.tagName === "P") {
      textBlock.addClass("youtube-listening-current-text");
    }
    if (heading) {
      const badge = document.createElement("span");
      badge.className = "youtube-listening-current-badge";
      badge.textContent = "▶ 正在播放";
      heading.appendChild(badge);
      this.currentBadge = badge;
    }
    this.highlightEls = [marker, textBlock].filter(Boolean);

    marker.scrollIntoView({ block: "center", behavior: "smooth" });
    return true;
  }

  clearTranscriptHighlight() {
    for (const element of this.highlightEls || []) {
      element.removeClass?.("youtube-listening-current");
      element.removeClass?.("youtube-listening-current-text");
      element.removeClass?.("youtube-listening-current-sentence");
    }
    this.highlightEls = [];
    this.currentBadge?.remove();
    this.currentBadge = null;
  }

  async seekPlayer(target, seconds) {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    leaf.view.seek(target, seconds);
  }

  hasDeepSeekApiKey() {
    return Boolean(this.settings?.deepseekApiKey);
  }

  deepSeekStorageDescription() {
    return "已保存到本机插件配置，方式与红点插件相同。留空不会覆盖现有密钥。";
  }

  async saveDeepSeekApiKey(value) {
    const apiKey = value.trim();
    if (!apiKey) throw new Error("API 密钥不能为空");
    this.settings.deepseekApiKey = apiKey;
    this.settings.deepseekApiKeyEncrypted = "";
    await this.saveData(this.settings);
  }

  async clearDeepSeekApiKey() {
    this.settings.deepseekApiKey = "";
    this.settings.deepseekApiKeyEncrypted = "";
    await this.saveData(this.settings);
  }

  getDeepSeekApiKey() {
    return String(this.settings?.deepseekApiKey || "").trim();
  }

  getPythonCommand() {
    const configured = expandHome(this.settings?.pythonPath);
    if (configured) return configured;
    if (process.platform === "win32") return "python";
    if (process.platform === "darwin") {
      const candidates = [
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
        "/usr/bin/python3",
      ];
      return candidates.find((candidate) => fs.existsSync(candidate)) || "python3";
    }
    return "python3";
  }

  getAudioExportFolder(vaultPath) {
    const configured = expandHome(this.settings?.audioExportFolder);
    if (configured) return configured;

    if (process.platform === "darwin") {
      const iCloudDrive = path.join(
        os.homedir(),
        "Library",
        "Mobile Documents",
        "com~apple~CloudDocs"
      );
      if (fs.existsSync(iCloudDrive)) return path.join(iCloudDrive, "口语精听复听");

      const cloudStorage = path.join(os.homedir(), "Library", "CloudStorage");
      if (fs.existsSync(cloudStorage)) {
        const oneDrive = fs.readdirSync(cloudStorage)
          .find((name) => name === "OneDrive" || name.startsWith("OneDrive-"));
        if (oneDrive) return path.join(cloudStorage, oneDrive, "口语精听复听");
      }
    }

    const oneDrive = path.join(os.homedir(), "OneDrive");
    if (fs.existsSync(oneDrive)) return path.join(oneDrive, "口语精听复听");
    return path.join(vaultPath, OUTPUT_FOLDER, "复听音频");
  }

  async cleanWithDeepSeek(segments, apiKey) {
    const system = [
      "You turn automatic English captions into a faithful, readable listening transcript.",
      "Return JSON only, exactly in this schema: {\\\"segments\\\":[{\\\"t\\\":0,\\\"speaker\\\":\\\"Speaker 1\\\",\\\"text\\\":\\\"...\\\"}]}.",
      "Keep every source proposition in chronological order. Never summarize, translate, add facts, or invent missing content.",
      "Each input caption is an atomic cue with its own true starting time. Create readable paragraphs, not complete speaker turns. Use the exact t of the first cue in each paragraph; never approximate it or use an earlier cue.",
      "Split continuous speech even when the speaker does not change: target 1 to 3 complete sentences and 20 to 70 words per paragraph, with a hard maximum of 90 words unless one source sentence is longer. Keep paragraphs in chronological order.",
      "Only use a real speaker name when it is explicitly established by the input. Otherwise use Speaker 1, Speaker 2, and so on; do not guess identities.",
      "Remove only isolated um/uh and immediate accidental stutters or restarts. Keep meaningful discourse markers such as I mean, well, you know, like, and I suppose.",
      "Correct an ASR word only when the context makes the correction certain. Keep uncertainty rather than guessing.",
      "The response must be complete valid json, with no Markdown fences or commentary.",
    ].join(" ");
    const response = await postJson(
      "https://api.deepseek.com/chat/completions",
      { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      {
        model: "deepseek-v4-flash",
        messages: [
          { role: "system", content: system },
          { role: "user", content: `Input caption segments as json:\n${JSON.stringify(segments.map(({ t, text }) => ({ t, text })))}` },
        ],
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 50000,
      }
    );
    const raw = response?.choices?.[0]?.message?.content;
    if (!raw) throw new Error("DeepSeek 没有返回可用内容，请重试");
    let data;
    try {
      data = JSON.parse(String(raw).replace(/^```json\s*|\s*```$/g, ""));
    } catch (_) {
      throw new Error("DeepSeek 返回的内容不是有效 JSON，请重试");
    }
    if (!Array.isArray(data?.segments) || !data.segments.length) {
      throw new Error("DeepSeek 返回的字幕为空，请重试");
    }
    const sourceByTime = new Map(segments.map((segment) => [segment.t, segment]));
    const cleaned = [];
    for (const segment of data.segments) {
      const t = Number(segment?.t);
      const text = String(segment?.text || "").replace(/\s+/g, " ").trim();
      if (!Number.isFinite(t) || t < 0 || !text) continue;
      const source = sourceByTime.get(t) || segments.reduce((best, candidate) =>
        Math.abs(candidate.t - t) < Math.abs(best.t - t) ? candidate : best
      );
      cleaned.push({
        t: source.t,
        href: source.href,
        speaker: String(segment?.speaker || "Speaker").replace(/[\r\n:*]/g, "").trim() || "Speaker",
        text,
      });
    }
    cleaned.sort((left, right) => left.t - right.t);
    if (!cleaned.length) throw new Error("DeepSeek 返回的字幕无法对应原始时间戳，请重试");
    return cleaned;
  }

  async createImportedCleanNote(payload, cleaned, processingMode = "ai") {
    const folder = OUTPUT_FOLDER;
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }
    const title = String(payload.title || "口语精听");
    const safeTitle = title.replace(/[\\/:*?\"<>|]/g, "-").trim().slice(0, 110) || "口语精听";
    const outputPath = uniquePath(this.app.vault, folder, safeTitle);
    const lines = [
      "---",
      "type: listening-practice",
      `source: ${String(payload.platform || "youtube")}`,
      `url: ${String(payload.url || "")}`,
      `channel: ${String(payload.channel || "")}`,
      `duration_seconds: ${Number(payload.duration) || 0}`,
      `segment: ${secondsLabel(payload.segment_start)}-${secondsLabel(payload.segment_end)}`,
      `captions: ${String(payload.source || "")}`,
      `playback: ${payload.browser_only ? "browser-only" : "embedded"}`,
      `status: ${processingMode === "ai" ? "imported-ai-cleaned" : "imported-local"}`,
      ...(processingMode === "ai" ? ["ai_model: deepseek-v4-flash"] : []),
      "---",
      "",
      `# ${title}`,
      "",
      `学习片段：${secondsLabel(payload.segment_start)}–${secondsLabel(payload.segment_end)}`,
      "",
      processingMode === "ai"
        ? "这份字幕已由 DeepSeek 整理断句、说话轮次和明显重复；点击每句前的 ▶ 可从句首回听。"
        : "这份字幕直接由视频字幕轨在本地生成，未发送给 AI；点击每句前的 ▶ 可从句首回听。",
      "",
      "## 使用方式",
      "",
      "1. 先不看稿听一遍，只标记断掉的位置。",
      "2. 精读时处理看稿也不懂，或看稿懂但声音没听出来的地方。",
      "3. 点击句首的 ▶ 精确回听；最后关稿再听一遍。",
      "",
      "## Transcript",
      "",
    ];
    let previousSpeaker = "";
    for (const segment of cleaned) {
      const speaker = String(segment.speaker || "");
      const speakerPrefix = speaker && speaker !== previousSpeaker ? `**${speaker}:** ` : "";
      const sentenceMarkup = (segment.sentences?.length ? segment.sentences : [{
        t: segment.t,
        href: hrefAtSentence(segment.href, segment.t),
        text: segment.text,
      }]).map((sentence) =>
        `<span class="youtube-listening-sentence" data-start="${sentence.t}"><a class="youtube-listening-sentence-play" href="${escapeHtml(sentence.href)}" title="从这句开始播放" aria-label="从这句开始播放">▶</a> ${escapeHtml(sentence.text)}</span>`
      ).join(" ");
      lines.push(`### [${secondsLabel(segment.t)}](${segment.href})`, "", `${speakerPrefix}${sentenceMarkup}`, "");
      previousSpeaker = speaker;
    }
    lines.push(
      "## 我的标记",
      "",
      "- 看稿也不懂：",
      "- 看稿懂，但原声没有听出来：",
      "- 关稿复听仍断掉的位置：",
      ""
    );
    const created = await this.app.vault.create(outputPath, lines.join("\n"));
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(created);
    await this.ensureTranscriptReadingView(leaf.view);
    return created;
  }

  async exportReviewAudio(playerView) {
    if (this.audioExportRunning) {
      new Notice("已有一个复听音频正在导出，请等待完成");
      return;
    }

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const transcriptView = activeView?.file && this.isTranscriptFile(activeView.file)
      ? activeView
      : (this.syncView?.file ? this.syncView : null);
    if (!transcriptView?.file) {
      new Notice("没有找到当前视频对应的精听稿");
      return;
    }

    const content = await this.app.vault.cachedRead(transcriptView.file);
    const frontmatter = this.app.metadataCache.getFileCache(transcriptView.file)?.frontmatter || {};
    const readField = (name) => {
      if (frontmatter[name] !== undefined && frontmatter[name] !== null) {
        return String(frontmatter[name]).trim();
      }
      return content.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim() || "";
    };
    const url = readField("url");
    const segment = readField("segment");
    const rangeMatch = segment.match(/^(.+?)-(.+)$/);
    const start = parseClockSeconds(rangeMatch?.[1]);
    const end = parseClockSeconds(rangeMatch?.[2]);
    if (!url || !rangeMatch || end <= start) {
      new Notice("精听稿缺少有效的视频链接或 segment 时间范围");
      return;
    }

    const vaultPath = this.app.vault.adapter.getBasePath();
    const outputFolder = this.getAudioExportFolder(vaultPath);
    await fs.promises.mkdir(outputFolder, { recursive: true });

    const safeTitle = transcriptView.file.basename
      .replace(/[\\/:*?"<>|]/g, "-")
      .trim()
      .slice(0, 100) || "口语精听复听";
    const fileTime = (seconds) => {
      const total = Math.max(0, Math.round(seconds));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const remain = total % 60;
      return hours
        ? `${hours}h${String(minutes).padStart(2, "0")}m${String(remain).padStart(2, "0")}s`
        : `${minutes}m${String(remain).padStart(2, "0")}s`;
    };
    const baseName = `${safeTitle} [${fileTime(start)}-${fileTime(end)}]`;
    let outputPath = path.join(outputFolder, `${baseName}.m4a`);
    let suffix = 2;
    while (fs.existsSync(outputPath)) {
      outputPath = path.join(outputFolder, `${baseName} (${suffix}).m4a`);
      suffix += 1;
    }

    const scriptPath = path.join(
      vaultPath,
      this.app.vault.configDir,
      "plugins",
      this.manifest.id,
      "youtube_to_obsidian.py"
    );
    const args = [
      scriptPath,
      url,
      "--export-audio",
      "--audio-output", outputPath,
      "--audio-title", transcriptView.file.basename,
      "--audio-artist", readField("channel"),
      "--start", String(Math.round(start)),
      "--end", String(Math.round(end)),
    ];

    this.audioExportRunning = true;
    playerView?.setAudioExportState(true);
    new Notice("正在下载并转换复听音频；长视频可能需要几分钟", 7000);
    try {
      const output = await new Promise((resolve, reject) => {
        const child = spawn(this.getPythonCommand(), args, { windowsHide: true });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
        child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
        child.on("error", () => reject(new Error("无法启动本地音频导出器")));
        child.on("close", (code) => {
          if (code === 0) resolve(stdout);
          else {
            const lines = `${stderr}\n${stdout}`
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            const message = lines.find((line) => line.includes("错误：")) ||
              lines.find((line) => /^ERROR[:：]/i.test(line)) ||
              lines.at(-1);
            reject(new Error(message || "复听音频导出失败"));
          }
        });
      });
      if (!output.match(/^AUDIO_FILE=.+$/m) || !fs.existsSync(outputPath)) {
        throw new Error("音频处理完成，但没有找到输出文件");
      }
      new Notice(`复听音频已导出：${outputPath}`, 12000);
    } catch (error) {
      new Notice(error?.message || "复听音频导出失败", 12000);
    } finally {
      this.audioExportRunning = false;
      playerView?.setAudioExportState(false);
    }
  }

  async importVideo(url, start, end) {
    const vaultPath = this.app.vault.adapter.getBasePath();
    const scriptPath = path.join(
      vaultPath,
      this.app.vault.configDir,
      "plugins",
      this.manifest.id,
      "youtube_to_obsidian.py"
    );
    const args = [
      scriptPath,
      url,
      "--vault",
      vaultPath,
      "--folder",
      OUTPUT_FOLDER,
      "--emit-json",
    ];
    if (start || end) {
      if (!start || !end) throw new Error("开始时间和结束时间必须同时填写");
      args.push("--start", start, "--end", end);
    }

    const output = await new Promise((resolve, reject) => {
      const child = spawn(this.getPythonCommand(), args, { windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
      child.on("error", () => reject(new Error("无法启动 Python 字幕导入器")));
      child.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else {
          const message = `${stderr}\n${stdout}`
            .split(/\r?\n/)
            .find((line) => line.includes("错误："));
          reject(new Error(message?.replace(/^.*错误：/, "") || "字幕导入失败"));
        }
      });
    });

    const match = output.match(/^TRANSCRIPT_JSON=(.+)$/m);
    if (!match) throw new Error("字幕已提取，但没有返回可供精校的数据");
    let payload;
    try {
      payload = JSON.parse(match[1]);
    } catch (_) {
      throw new Error("字幕提取结果无法读取，请重试");
    }
    if (!Array.isArray(payload?.segments) || !payload.segments.length) {
      throw new Error("没有提取到可供精校的字幕");
    }
    const mode = this.settings.transcriptMode || "auto";
    const apiKey = this.getDeepSeekApiKey();
    let processingMode = "local";
    let cleanedParagraphs;
    if (mode === "local" || (mode === "auto" && !apiKey)) {
      cleanedParagraphs = localTranscriptParagraphs(payload.segments);
    } else {
      if (!apiKey) throw new Error("AI 精校模式需要 DeepSeek API 密钥");
      new Notice("字幕已提取，正在由 DeepSeek 精校；完成前不会创建笔记", 6000);
      try {
        cleanedParagraphs = await this.cleanWithDeepSeek(payload.segments, apiKey);
        processingMode = "ai";
      } catch (error) {
        if (mode === "ai") throw error;
        new Notice(`DeepSeek 不可用，已回退到本地字幕：${error?.message || error}`, 10000);
        cleanedParagraphs = localTranscriptParagraphs(payload.segments);
      }
    }
    const cleaned = attachSentenceTimings(cleanedParagraphs, payload.segments, payload.words);
    await this.createImportedCleanNote(payload, cleaned, processingMode);
    if (payload.browser_only) {
      new Notice("字幕笔记已生成；这个视频禁止嵌入，时间戳将使用默认浏览器", 10000);
    } else {
      new Notice(
        `${processingMode === "ai" ? "DeepSeek 精校" : "本地字幕"}笔记已生成；点击时间戳会控制右侧播放器`,
        7000
      );
    }
  }
};
