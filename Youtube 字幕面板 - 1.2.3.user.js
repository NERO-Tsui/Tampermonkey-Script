// ==UserScript==
// @name         Youtube 字幕面板
// @namespace    https://kintong.site
// @version      1.2.3
// @description  嗅探字幕 + 下载按钮；在 YouTube 插入字幕面板；支持点击跳转、根据播放位置自动高亮并（可选）跟随滚动到当前行；
// @author       Modified by ChatGPT
// @match        *://youtube.com/*
// @match        *://www.youtube.com/*
// @match        *://*.youtube.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @license      MIT
// @downloadURL // https://update.greasyfork.org/scripts/553744/Youtube%20subtitle%20panel.user.js
// @updateURL // https://update.greasyfork.org/scripts/553744/Youtube%20subtitle%20panel.meta.js
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const DEFAULT_KEYWORDS = [
    "subtitle",
    "timedtext",
    "api/timedtext",
    "youtubei/v1/get_transcript",
    "get_transcript",
    "aisubtitle",
    "srt"
  ];
  let config = GM_getValue("subtitle_config", {
    keywords: DEFAULT_KEYWORDS.slice(),
    debug: true,
    lang: "zh-CN"
  });
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    config = { keywords: DEFAULT_KEYWORDS.slice(), debug: true, lang: "zh-CN" };
  }
  if (!Array.isArray(config.keywords)) config.keywords = [];
  for (const k of DEFAULT_KEYWORDS) {
    if (!config.keywords.includes(k)) config.keywords.push(k);
  }
  GM_setValue("subtitle_config", config);
  const pageWindow = (typeof unsafeWindow !== "undefined" && unsafeWindow) ? unsafeWindow : window;

  /** 数据结构 **/
  /** @type {{from:number,to:number,content:string}[]} */
  let subtitles = [];
  let subtitleFound = false;

  // 只取最新一次：请求序号
  let latestSeq = 0;     // 最新被“发起”的请求序号
  let appliedSeq = 0;    // 最新已应用到 UI 的请求序号

  // 渲染/同步相关的缓存
  let panelHost = null;
  let listEl = null;
  let liItems = [];        // <li>[]，与 subtitles 同序
  let startTimes = [];     // number[]，与 subtitles 同序
  let endTimes = [];       // number[]，与 subtitles 同序
  let activeIndex = -1;    // 当前高亮行索引
  let hookedVideo = null;
  let panelMountKey = "";

  function isVisible(el) {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 120 && rect.height >= 60;
  }

  function pickPanelAnchor() {
    const candidates = [
      "#secondary-inner",
      "#secondary",
      "#below",
      "ytd-watch-metadata",
      "body"
    ].map((s) => document.querySelector(s)).filter(Boolean);
    if (!candidates.length) return null;
    return candidates.find(isVisible) || candidates[0];
  }

  // ------------------- 菜单配置 -------------------
  GM_registerMenuCommand("配置字幕关键字", () => {
    const input = prompt("请输入URL中的关键字，逗号分隔", config.keywords.join(","));
    if (input) {
      config.keywords = input.split(",").map(s => s.trim());
      GM_setValue("subtitle_config", config);
      alert("配置已保存: " + config.keywords.join(", "));
    }
  });

  // ------------------- DOM：字幕面板 -------------------
  function ensureSubtitlePanel() {
    if (panelHost && document.body.contains(panelHost)) {
      const mountOk = panelMountKey ? !!document.querySelector(panelMountKey) : false;
      if (isVisible(panelHost) && mountOk) return;
      panelHost.remove();
      panelHost = null;
      listEl = null;
      panelMountKey = "";
    }

    const tryInsert = () => {
      const panelAnchor = pickPanelAnchor();
      if (!panelAnchor) return false;

      panelHost = document.createElement("div");
      panelHost.id = "universal-subtitle-panel";
      const header = document.createElement("div");
      header.className = "usp-header";

      const title = document.createElement("span");
      title.textContent = "📝 实时字幕";

      const actions = document.createElement("div");
      actions.className = "usp-actions";

      const followLabel = document.createElement("label");
      followLabel.style.display = "inline-flex";
      followLabel.style.alignItems = "center";
      followLabel.style.gap = "6px";
      followLabel.style.fontSize = "12px";
      followLabel.style.opacity = ".9";

      const followInput = document.createElement("input");
      followInput.id = "usp-follow";
      followInput.type = "checkbox";
      followInput.checked = true;
      followLabel.appendChild(followInput);
      followLabel.appendChild(document.createTextNode("跟随播放"));

      const clearBtn = document.createElement("button");
      clearBtn.id = "usp-clear";
      clearBtn.title = "清空列表";
      clearBtn.textContent = "清空";

      const downloadBtn = document.createElement("button");
      downloadBtn.id = "usp-download";
      downloadBtn.title = "下载当前字幕为 SRT";
      downloadBtn.textContent = "下载";

      actions.appendChild(followLabel);
      actions.appendChild(clearBtn);
      actions.appendChild(downloadBtn);

      header.appendChild(title);
      header.appendChild(actions);

      const listWrap = document.createElement("div");
      listWrap.className = "usp-list-wrap";
      const list = document.createElement("ol");
      list.className = "usp-list";
      listWrap.appendChild(list);

      panelHost.appendChild(header);
      panelHost.appendChild(listWrap);

      if (!document.getElementById("usp-style")) {
        const style = document.createElement("style");
        style.id = "usp-style";
        style.textContent = `
          #universal-subtitle-panel{
            box-sizing:border-box;width:100%;
            background: var(--yt-spec-general-background-a, #111);
            color: var(--yt-spec-text-primary, #fff);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 12px; margin: 12px 0 16px 0;
            box-shadow: 0 6px 18px rgba(0,0,0,0.25); overflow: hidden;
            font-family: system-ui,-apple-system,Segoe UI,Roboto,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif;
          }
          #universal-subtitle-panel .usp-header{
            display:flex;align-items:center;justify-content:space-between;
            padding:10px 12px;background: linear-gradient(90deg, rgba(0,123,255,.15), rgba(0,195,255,.15));
            backdrop-filter: blur(4px);font-weight:600;font-size:14px;
          }
          #universal-subtitle-panel .usp-actions button{
            margin-left:8px;font-size:12px;padding:6px 10px;border-radius:8px;
            border:1px solid rgba(255,255,255,0.2);background:transparent;color:inherit;cursor:pointer;
          }
          #universal-subtitle-panel .usp-actions button:hover{background: rgba(255,255,255,0.06);}
          #universal-subtitle-panel .usp-list-wrap{max-height: 320px; overflow:auto; scroll-behavior:smooth;}
          #universal-subtitle-panel .usp-list{list-style:none; margin:0; padding:6px 10px;}
          #universal-subtitle-panel .usp-item{
            display:flex; gap:8px; padding:8px 6px; border-bottom:1px dashed rgba(255,255,255,0.08);
            align-items:flex-start; cursor:pointer; transition: background .18s, transform .18s;
          }
          #universal-subtitle-panel .usp-item:hover{ background: rgba(0,123,255,0.08); }
          #universal-subtitle-panel .usp-item.usp-active{
            background: rgba(0,123,255,0.22);
            outline: 1px solid rgba(0,123,255,0.35);
            transform: translateZ(0);
          }
          #universal-subtitle-panel .usp-ts{
            flex:0 0 auto; font-variant-numeric: tabular-nums; opacity:.75; font-size:12px; min-width: 84px;
          }
          #universal-subtitle-panel .usp-text{ flex:1 1 auto; white-space:pre-wrap; line-height:1.35; font-size:14px; }
          #universal-subtitle-panel .usp-empty{ padding:14px; opacity:.7; font-size:13px; }
          #universal-subtitle-panel.usp-floating{
            position: fixed; right: 12px; bottom: 12px; z-index: 99999;
            width: min(420px, calc(100vw - 24px)); max-height: min(55vh, 520px);
          }
        `;
        document.documentElement.appendChild(style);
      }

      panelHost.classList.toggle("usp-floating", panelAnchor === document.body);
      if (panelAnchor.id === "secondary-inner") {
        const parent = panelAnchor.parentNode;
        if (parent) parent.insertBefore(panelHost, panelAnchor);
        else panelAnchor.prepend(panelHost);
      } else {
        panelAnchor.prepend(panelHost);
      }
      panelMountKey = panelAnchor.id ? `#${panelAnchor.id}` : panelAnchor.tagName.toLowerCase();

      listEl = panelHost.querySelector(".usp-list");
      panelHost.dataset.paused = "false";
      panelHost.dataset.follow = "true";

      panelHost.querySelector("#usp-clear").addEventListener("click", () => {
        subtitles = [];
        resetRenderState();
        renderSubtitles(true);
      });

      panelHost.querySelector("#usp-follow").addEventListener("change", (e) => {
        panelHost.dataset.follow = e.target.checked ? "true" : "false";
      });

      // 绑定下载按钮
      ensureDownloadButton();

      renderSubtitles(true);
      hookVideoTimeUpdate();
      return true;
    };

    if (!tryInsert()) {
      const mo = new MutationObserver(() => {
        if (tryInsert()) mo.disconnect();
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  function resetRenderState() {
    liItems = [];
    startTimes = [];
    endTimes = [];
    activeIndex = -1;
    if (panelHost) panelHost.dataset.lastRenderedIndex = "-1";
  }

  function timeFmt(t) {
    const h = String(Math.floor(t / 3600)).padStart(2, "0");
    const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
    const s = String(Math.floor(t % 60)).padStart(2, "0");
    const ms = String(Math.floor((t * 1000) % 1000)).padStart(3, "0");
    return `${h}:${m}:${s},${ms}`;
  }

  function appendOne(v, idx) {
    const li = document.createElement("li");
    li.className = "usp-item";
    li.dataset.index = String(idx);

    const ts = document.createElement("div");
    ts.className = "usp-ts";
    ts.textContent = `${timeFmt(v.from)} → ${timeFmt(v.to)}`;

    const text = document.createElement("div");
    text.className = "usp-text";
    text.textContent = v.content;

    li.appendChild(ts);
    li.appendChild(text);

    // 点击跳转播放
    li.addEventListener("click", () => {
      const video = document.querySelector("video");
      if (video) {
        video.currentTime = v.from + 0.01; // +0.01 避免边界条件
        video.play();
        flash(li);
      } else {
        alert("未找到视频元素！");
      }
    });

    listEl.appendChild(li);
    return li;
  }

  function flash(el) {
    el.style.transition = "background .1s";
    const old = el.style.background;
    el.style.background = "rgba(0,123,255,0.35)";
    setTimeout(() => (el.style.background = old), 160);
  }

  function renderSubtitles(fullRefresh = false) {
    if (!panelHost || !listEl) return;
    if (panelHost.dataset.paused === "true") return;

    // 统一按开始时间排序，保证时间轴正确
    subtitles.sort((a, b) => a.from - b.from);

    if (fullRefresh) {
      listEl.replaceChildren();
      resetRenderState();
      if (subtitles.length === 0) {
        const empty = document.createElement("div");
        empty.className = "usp-empty";
        empty.textContent = "暂无字幕，等待抓取中…";
        listEl.appendChild(empty);
        listEl.parentElement.scrollTop = 0;
        return;
      }
    }

    // 从 lastRenderedIndex 之后开始增量渲染
    const lastRendered = Number(panelHost.dataset.lastRenderedIndex || "-1");
    const start = Math.max(0, lastRendered + 1);

    for (let i = start; i < subtitles.length; i++) {
      const li = appendOne(subtitles[i], i);
      liItems[i] = li;
      startTimes[i] = subtitles[i].from;
      endTimes[i] = subtitles[i].to;
    }
    panelHost.dataset.lastRenderedIndex = String(subtitles.length - 1);

    // 初次加载：滚动到顶部
    if (fullRefresh) listEl.parentElement.scrollTop = 0;
  }

  // ------------------- 根据播放时间高亮 & 跟随滚动 -------------------
  function hookVideoTimeUpdate() {
    const video = document.querySelector("video");
    if (!video) return;
    if (video === hookedVideo) return;
    hookedVideo = video;

    let ticking = false;
    video.addEventListener("timeupdate", () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        syncToTime(video.currentTime || 0);
      });
    }, { passive: true });
  }

  function syncToTime(t) {
    if (!startTimes.length) return;

    // 二分查找：找到满足 from <= t < to 的索引
    let lo = 0, hi = startTimes.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t < startTimes[mid]) {
        hi = mid - 1;
      } else if (t >= endTimes[mid]) {
        lo = mid + 1;
      } else {
        found = mid;
        break;
      }
    }

    if (found !== -1 && found !== activeIndex) {
      setActiveLine(found, /*scroll*/ panelHost?.dataset.follow === "true");
    } else if (found === -1 && activeIndex !== -1) {
      // 不在任何字幕区间，取消高亮
      clearActive();
    }
  }

  function clearActive() {
    if (activeIndex !== -1 && liItems[activeIndex]) {
      liItems[activeIndex].classList.remove("usp-active");
    }
    activeIndex = -1;
  }

  function setActiveLine(idx, scroll) {
    clearActive();
    activeIndex = idx;
    const li = liItems[idx];
    if (!li) return;
    li.classList.add("usp-active");

    if (scroll && listEl) {
      const wrap = listEl.parentElement;
      const liTop = li.offsetTop;
      const liHeight = li.offsetHeight;
      const wrapHeight = wrap.clientHeight;
      const target = Math.max(0, liTop - (wrapHeight - liHeight) / 2);
      // 仅当不在可视范围再滚动，避免频繁抖动
      if (liTop < wrap.scrollTop || (liTop + liHeight) > (wrap.scrollTop + wrapHeight)) {
        wrap.scrollTo({ top: target, behavior: "smooth" });
      }
    }
  }

  function applySubtitles(subs, url, seq) {
    if (!subs.length) return;

    subtitleFound = true;
    subtitles = subs;
    appliedSeq = seq;

    if (config.debug) {
      console.log("%c字幕来源(应用)", "background:#0066cc;color:#fff;padding:2px 4px;border-radius:2px;", { url, seq });
      console.log("%c字幕条目数", "background:#0066cc;color:#fff;padding:2px 4px;border-radius:2px;", subs.length);
    }

    ensureSubtitlePanel();
    ensureDownloadButton();
    renderSubtitles(true);

    const video = document.querySelector("video");
    if (video && !video.paused) syncToTime(video.currentTime || 0);
  }

  function parseTimedtextXml(xmlText) {
    if (!xmlText || !xmlText.includes("<")) return [];
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    const nodes = Array.from(doc.querySelectorAll("text"));
    if (!nodes.length) return [];

    return nodes.map((n) => {
      const from = Number.parseFloat(n.getAttribute("start") || "0");
      const dur = Number.parseFloat(n.getAttribute("dur") || "0");
      const raw = n.textContent || "";
      return {
        from,
        to: Math.max(from, from + dur),
        content: raw.replace(/\s+/g, " ").trim()
      };
    }).filter((x) => x.content);
  }

  function tryExtractFromRawText(raw, url, seq) {
    if (!raw) return;
    const text = String(raw).trim();
    if (!text) return;

    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        const data = JSON.parse(text);
        tryExtract(data, url, seq);
      } catch (e) {}
      return;
    }

    const xmlSubs = parseTimedtextXml(text);
    if (xmlSubs.length) applySubtitles(xmlSubs, url, seq);
  }

  function getRequestUrl(input) {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    try {
      return String(input || "");
    } catch (e) {
      return "";
    }
  }

  function normalizeTrackUrl(url) {
    if (!url) return "";
    const fmtJson3 = url.includes("fmt=") ? url.replace(/fmt=[^&]+/i, "fmt=json3") : `${url}&fmt=json3`;
    return fmtJson3;
  }

  function pickCaptionTrack(captionTracks) {
    if (!Array.isArray(captionTracks) || !captionTracks.length) return null;
    const preferred = captionTracks.find((t) => t.languageCode === config.lang)
      || captionTracks.find((t) => String(t.vssId || "").includes(`.${config.lang}`))
      || captionTracks.find((t) => String(t.vssId || "").startsWith("a."))
      || captionTracks[0];
    return preferred || null;
  }

  function tryLoadFromPlayerResponse() {
    const pr = pageWindow.ytInitialPlayerResponse;
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    const track = pickCaptionTrack(tracks);
    const baseUrl = track?.baseUrl;
    if (!baseUrl) return;

    const seq = ++latestSeq;
    const url = normalizeTrackUrl(baseUrl);
    pageWindow.fetch(url).then((r) => r.text()).then((raw) => {
      tryExtractFromRawText(raw, url, seq);
    }).catch(() => {});
  }

  // ------------------- 解析逻辑（仅应用最新 seq 的结果） -------------------
  function tryExtract(data, url, seq) {
    // 不是最新请求，丢弃
    if (seq < appliedSeq) {
      if (config.debug) {
        console.log("%c跳过过期字幕", "background:#999;color:#fff;padding:2px 4px;border-radius:2px;", { url, seq, appliedSeq });
      }
      return;
    }

    let subs = [];

    // YouTube json3 格式
    if (data && Array.isArray(data.events)) {
      subs = data.events.flatMap(e =>
        (e.segs || []).map(s => ({
          from: e.tStartMs / 1000,
          to: (e.tStartMs + e.dDurationMs) / 1000,
          content: s.utf8
        }))
      );
    }
    // B站 body 数组
    else if (data && Array.isArray(data.body)) {
      subs = data.body.map(x => ({
        from: x.from,
        to: x.to,
        content: x.content
      }));
    }
    // 通用数组
    else if (Array.isArray(data)) {
      data.forEach(x => {
        if (x && (x.content || x.text)) subs.push({
          from: x.from || 0,
          to: x.to || 0,
          content: x.content || x.text
        });
      });
    }

    if (subs.length > 0) applySubtitles(subs, url, seq);
  }

  // ------------------- fetch/XHR 拦截（分配 seq） -------------------
  const origFetch = pageWindow.fetch;
  pageWindow.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    const url = getRequestUrl(args[0]);
    if (config.keywords.some(k => url.includes(k))) {
      const seq = ++latestSeq; // 分配最新请求序号
      res.clone().text().then((raw) => {
        tryExtractFromRawText(raw, url, seq);
      }).catch(() => {});
    }
    return res;
  };

  const origOpen = pageWindow.XMLHttpRequest.prototype.open;
  pageWindow.XMLHttpRequest.prototype.open = function (...args) {
    this._url = args[1];
    return origOpen.apply(this, args);
  };
  const origSend = pageWindow.XMLHttpRequest.prototype.send;
  pageWindow.XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      const url = this._url || "";
      if (config.keywords.some(k => url.includes(k))) {
        const seq = ++latestSeq; // 分配最新请求序号
        tryExtractFromRawText(this.responseText || "", url, seq);
      }
    });
    return origSend.apply(this, args);
  };

  // ------------------- 下载按钮（放在清空旁） -------------------
  function ensureDownloadButton() {
    const btn = document.getElementById("usp-download");
    if (!btn) return; // 面板尚未创建
    if (btn.dataset.bound === "1") return; // 已绑定过
    btn.dataset.bound = "1";

    btn.addEventListener("click", () => {
      if (subtitles.length === 0) {
        alert("暂无可下载字幕！");
        return;
      }
      const srt = subtitles
        .map((v, i) => {
          const f = t => {
            const h = String(Math.floor(t / 3600)).padStart(2, "0");
            const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
            const s = String(Math.floor(t % 60)).padStart(2, "0");
            const ms = String(Math.floor((t * 1000) % 1000)).padStart(3, "0");
            return `${h}:${m}:${s},${ms}`;
          };
          return `${i + 1}\n${f(v.from)} --> ${f(v.to)}\n${v.content}\n`;
        })
        .join("\n");

      const blob = new Blob([srt], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "subtitles.srt";
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  function resetForNavigation() {
    subtitles = [];
    latestSeq = 0;
    appliedSeq = 0;
    resetRenderState();
    ensureSubtitlePanel();
    renderSubtitles(true);
    hookVideoTimeUpdate();
    setTimeout(tryLoadFromPlayerResponse, 200);
    setTimeout(tryLoadFromPlayerResponse, 1200);
  }

  pageWindow.addEventListener("yt-navigate-finish", resetForNavigation, true);
  pageWindow.addEventListener("popstate", () => {
    setTimeout(resetForNavigation, 0);
  }, true);

  // 初始执行
  ensureSubtitlePanel();
  hookVideoTimeUpdate();
  setTimeout(tryLoadFromPlayerResponse, 200);
  setTimeout(tryLoadFromPlayerResponse, 1200);
  const ensureTimer = setInterval(() => {
    ensureSubtitlePanel();
    hookVideoTimeUpdate();
    if (panelHost && document.body && document.body.contains(panelHost)) {
      clearInterval(ensureTimer);
    }
  }, 1000);
  setTimeout(() => clearInterval(ensureTimer), 15000);
})();
