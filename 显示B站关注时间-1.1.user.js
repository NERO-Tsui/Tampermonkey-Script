// ==UserScript==
// @name         显示B站关注时间
// @namespace    https://github.com/IOMisaka/bilibilifollowtime
// @version      1.1
// @description  在空间页面显示关注时间
// @author       Codex 5.3
// @match        https://space.bilibili.com/*
// @grant        none
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=bilibili.com
// ==/UserScript==

/* jshint esversion: 6 */

(function () {
    'use strict';
    const REQUEST_TIMEOUT = 12000;
    const RETRY_TIMES = 2;

    const PANEL_ID = 'bili-follow-time-panel';
    const oldPanel = document.getElementById(PANEL_ID);
    if (oldPanel) oldPanel.remove();

    const div = document.createElement('div');
    div.id = PANEL_ID;
    div.title = '点击关闭';
    div.style.border = '2px solid grey';
    div.style.backgroundColor = 'rgba(83, 6, 90, 0.99)';
    div.style.color = 'white';
    div.style.borderRadius = '2px';
    div.style.right = '0';
    div.style.bottom = '0';
    div.style.position = 'fixed';
    div.style.zIndex = '1111';
    div.style.padding = '2px 6px';

    const actionBar = document.createElement('div');
    actionBar.style.display = 'block';
    actionBar.style.textAlign = 'right';
    actionBar.style.marginBottom = '4px';

    const retry = document.createElement('span');
    retry.textContent = '重试';
    retry.style.cursor = 'pointer';
    retry.style.marginRight = '8px';
    retry.style.fontSize = '12px';
    actionBar.appendChild(retry);

    const close = document.createElement('span');
    close.textContent = '关闭';
    close.onclick = () => div.style.setProperty('display', 'none');
    close.style.cursor = 'pointer';
    close.style.fontSize = '12px';
    actionBar.appendChild(close);
    div.appendChild(actionBar);

    const txt = document.createElement('div');
    txt.textContent = 'Loading...';
    txt.style.display = 'block';
    div.appendChild(txt);

    document.body.appendChild(div);

    const getUid = () => {
        const m = location.pathname.match(/^\/(\d+)(?:\/|$)/);
        return m ? m[1] : '';
    };

    const fetchJson = async (url, timeoutMs = REQUEST_TIMEOUT) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { credentials: 'include', signal: controller.signal });
            if (!res.ok) {
                const httpErr = new Error('HTTP ' + res.status);
                httpErr.httpStatus = res.status;
                throw httpErr;
            }
            const data = await res.json();
            if (typeof data?.code === 'number' && data.code !== 0) {
                const apiErr = new Error(data.message || ('API code ' + data.code));
                apiErr.apiCode = data.code;
                throw apiErr;
            }
            return data;
        } finally {
            clearTimeout(timer);
        }
    };

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    const fetchJsonWithRetry = async (url, timeoutMs = REQUEST_TIMEOUT, retryTimes = RETRY_TIMES) => {
        let lastErr;
        for (let i = 0; i <= retryTimes; i += 1) {
            try {
                return await fetchJson(url, timeoutMs);
            } catch (err) {
                lastErr = err;
                if (err?.apiCode === -101 || err?.apiCode === -400 || i === retryTimes) {
                    throw err;
                }
                await sleep(400 * (i + 1));
            }
        }
        throw lastErr;
    };

    const getNameFromPage = () => {
        const candidates = [
            '.h-name',
            '.up-name',
            '[class*="name"]'
        ];
        for (const selector of candidates) {
            const node = document.querySelector(selector);
            const name = node?.textContent?.trim();
            if (name) return name;
        }
        const titleName = (document.title || '').split('的个人空间')[0].trim();
        return titleName || '';
    };

    let loading = false;
    const loadFollowTime = async () => {
        if (loading) return;
        loading = true;
        retry.style.pointerEvents = 'none';
        retry.style.opacity = '0.6';
        txt.textContent = 'Loading...';

        const uid = getUid();
        if (!uid) {
            div.style.setProperty('display', 'none');
            loading = false;
            return;
        }

        try {
            const follow = await fetchJsonWithRetry('https://api.bilibili.com/x/space/acc/relation?mid=' + uid);
            const relation = follow?.data?.relation;
            if (!relation || !relation.mid) {
                div.style.setProperty('display', 'none');
                loading = false;
                return;
            }

            let name = getNameFromPage() || ('UID ' + uid);
            try {
                const user = await fetchJsonWithRetry('https://api.bilibili.com/x/space/acc/info?mid=' + uid);
                name = user?.data?.name || name;
            } catch (infoErr) {
                console.warn('[Bilibili Follow Time] info fallback', infoErr);
            }
            const mtime = Number(relation.mtime) || 0;
            txt.textContent = '关注 ' + name + ' 的时间：' + new Date(mtime * 1000).toLocaleString();
        } catch (err) {
            if (err?.apiCode === -101) {
                txt.textContent = '请先登录B站，再查看关注时间。';
            } else {
                txt.textContent = '加载失败，请点击重试。';
            }
            console.warn('[Bilibili Follow Time]', err);
        } finally {
            loading = false;
            retry.style.pointerEvents = 'auto';
            retry.style.opacity = '1';
        }
    };

    retry.onclick = () => {
        loadFollowTime();
    };

    loadFollowTime();
})();
