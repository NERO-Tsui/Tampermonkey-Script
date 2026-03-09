// ==UserScript==
// @name                   GitHub 显示文件和文件夹大小
// @name:zh-CN             GitHub 显示文件和文件夹大小
// @name:zh-TW             GitHub 顯示文件和文件夾大小
// @description            在 GitHub 仓库页面显示文件和文件夹大小。
// @description:zh-CN      在 GitHub 仓库页面显示文件和文件夹大小。
// @description:zh-TW      在 GitHub 倉庫頁面顯示文件和文件夾大小。
// @author                 Abhay, 人民的勤务员 <china.qinwuyuan@gmail.com>, aspen138
// @namespace              https://github.com/ChinaGodMan/UserScripts
// @supportURL             https://github.com/ChinaGodMan/UserScripts/issues
// @homepageURL            https://github.com/ChinaGodMan/UserScripts
// @homepage               https://github.com/ChinaGodMan/UserScripts
// @license                MIT
// @match                  https://github.com/*
// @icon                   https://raw.githubusercontent.com/ChinaGodMan/UserScriptsHistory/main/scriptsIcon/github-file-size-viewer.jpg
// @version                2026.3.9.1
// @grant                  GM_setValue
// @grant                  GM_getValue
// @grant                  GM_registerMenuCommand
// // @downloadURL         https://raw.githubusercontent.com/ChinaGodMan/UserScripts/main/github-file-size-viewer/github-file-size-viewer.user.js
// // @updateURL           https://raw.githubusercontent.com/ChinaGodMan/UserScripts/main/github-file-size-viewer/github-file-size-viewer.user.js
// ==/UserScript==

/**
 * Token 是可选的：
 * - 存在 GITHUB_TOKEN 时使用 Token 请求。
 * - 不存在时走匿名请求，可能触发速率限制。
 */

;(function () {
    'use strict'

    const API_ACCEPT = 'application/vnd.github+json'
    const GITHUB_TOKEN = String(GM_getValue('GITHUB_TOKEN', '') || '').trim()
    const INFO_CLASS = 'gfsv-size-info'
    const NOTICE_ID = 'gfsv-api-notice'
    const CACHE_KEY = 'GFSV_CACHE_V2'
    const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
    const HEAD_CACHE_TTL_MS = 60 * 1000
    const CACHE_MAX_ENTRIES = 3000
    const RATE_LIMIT_TEXT = 'GitHub API 速率限制已触发，请稍后重试。'
    const TOKEN_GUIDE_TEXT = [
        'GitHub 文件大小查看器 - Token 最小权限说明',
        '',
        '推荐类型：',
        '- Fine-grained Personal Access Token',
        '',
        '最小权限配置：',
        '1) Repository access：只选你需要的仓库',
        '   - 只看公开仓库时，仅勾选公开仓库',
        '2) Repository permissions：Contents -> Read-only',
        '3) Account permissions：None（无需账户权限）',
        '',
        'GitHub 路径：',
        'Settings -> Developer settings -> Personal access tokens -> Fine-grained tokens',
        '',
        '安全建议：',
        '- 过期时间尽量短',
        '- 不用就撤销或轮换',
        '',
        '本脚本只读取 commits/tree，不需要任何写权限。',
        '请勿授予写入类权限。'
    ].join('\n')

    let saveTimer = null
    const treeIndexMemory = new Map()
    const runState = { runId: 0 }
    const noticeOnce = new Set()
    const cache = loadCache()

    function loadCache() {
        const raw = GM_getValue(CACHE_KEY, null)
        if (!raw || typeof raw !== 'object') {
            return { entries: {}, heads: {} }
        }
        if (!raw.entries || typeof raw.entries !== 'object') {
            raw.entries = {}
        }
        if (!raw.heads || typeof raw.heads !== 'object') {
            raw.heads = {}
        }
        return raw
    }

    function scheduleSaveCache() {
        if (saveTimer) {
            return
        }
        saveTimer = setTimeout(() => {
            saveTimer = null
            pruneCache()
            GM_setValue(CACHE_KEY, cache)
        }, 250)
    }

    function pruneCache() {
        const now = Date.now()
        const entries = Object.entries(cache.entries)
        for (const [key, value] of entries) {
            if (!value || typeof value !== 'object' || typeof value.t !== 'number') {
                delete cache.entries[key]
                continue
            }
            if (now - value.t > CACHE_TTL_MS) {
                delete cache.entries[key]
            }
        }

        const headEntries = Object.entries(cache.heads)
        for (const [key, value] of headEntries) {
            if (!value || typeof value !== 'object' || typeof value.t !== 'number' || typeof value.sha !== 'string') {
                delete cache.heads[key]
                continue
            }
            if (now - value.t > CACHE_TTL_MS) {
                delete cache.heads[key]
            }
        }

        const size = Object.keys(cache.entries).length
        if (size <= CACHE_MAX_ENTRIES) {
            return
        }
        const sorted = Object.entries(cache.entries).sort((a, b) => a[1].t - b[1].t)
        const removeCount = size - CACHE_MAX_ENTRIES
        for (let i = 0; i < removeCount; i += 1) {
            delete cache.entries[sorted[i][0]]
        }
    }

    function cacheEntryKey(repoRefWithHead, path, isFile) {
        return `${repoRefWithHead}:${isFile ? 'f' : 'd'}:${path || '.'}`
    }

    function getCachedEntry(entryKey) {
        const item = cache.entries[entryKey]
        if (!item || typeof item.v !== 'string' || typeof item.t !== 'number') {
            return null
        }
        if (Date.now() - item.t > CACHE_TTL_MS) {
            delete cache.entries[entryKey]
            return null
        }
        item.t = Date.now()
        return item.v
    }

    function setCachedEntry(entryKey, value) {
        cache.entries[entryKey] = { v: value, t: Date.now() }
        scheduleSaveCache()
    }

    function getCachedHead(repoRef) {
        const item = cache.heads[repoRef]
        if (!item || typeof item.sha !== 'string' || typeof item.t !== 'number') {
            return null
        }
        return item
    }

    function setCachedHead(repoRef, sha) {
        cache.heads[repoRef] = { sha, t: Date.now() }
        scheduleSaveCache()
    }

    function formatSize(bytes) {
        if (bytes < 1024 * 1024) {
            return `${(bytes / 1024).toFixed(2)} KB`
        }
        if (bytes < 1024 * 1024 * 1024) {
            return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
        }
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
    }

    function buildHeaders() {
        const headers = { Accept: API_ACCEPT }
        if (GITHUB_TOKEN) {
            headers.Authorization = `token ${GITHUB_TOKEN}`
        }
        return headers
    }

    function createApiError(response, data) {
        const message = data && typeof data.message === 'string' ? data.message : response.statusText || 'GitHub API error'
        const remaining = response.headers.get('x-ratelimit-remaining')
        const resetRaw = response.headers.get('x-ratelimit-reset')
        const resetEpoch = resetRaw ? Number(resetRaw) : NaN
        const rateLimited = response.status === 403 && (remaining === '0' || /rate limit/i.test(message))
        const err = new Error(message)
        err.status = response.status
        err.rateLimited = rateLimited
        err.resetEpoch = Number.isFinite(resetEpoch) ? resetEpoch : null
        return err
    }

    async function fetchJson(url) {
        const response = await fetch(url, { headers: buildHeaders() })
        const text = await response.text()
        let data = null
        try {
            data = text ? JSON.parse(text) : null
        } catch (error) {
            data = null
        }
        if (!response.ok) {
            throw createApiError(response, data)
        }
        return data
    }

    function formatResetTime(resetEpoch) {
        if (!resetEpoch) {
            return ''
        }
        return new Date(resetEpoch * 1000).toLocaleString()
    }

    function showApiNotice(message) {
        const table = document.querySelector('table tbody')
        if (!table || !table.parentElement) {
            return
        }
        let notice = document.getElementById(NOTICE_ID)
        if (!notice) {
            notice = document.createElement('div')
            notice.id = NOTICE_ID
            notice.style.padding = '10px 12px'
            notice.style.marginBottom = '8px'
            notice.style.borderRadius = '6px'
            notice.style.border = '1px solid #d0a700'
            notice.style.background = '#fff8c5'
            notice.style.color = '#5a4a00'
            notice.style.fontSize = '12px'
            table.parentElement.insertAdjacentElement('beforebegin', notice)
        }
        notice.textContent = message
    }

    function showRateLimitNotice(resetEpoch) {
        let message = RATE_LIMIT_TEXT
        const resetText = formatResetTime(resetEpoch)
        if (resetText) {
            message += ` 重置时间：${resetText}。`
        }
        if (!GITHUB_TOKEN) {
            message += ' 可选设置 `GITHUB_TOKEN` 提高限额。可在菜单中查看“GFSV：Token 最小权限说明”。'
        }
        if (!noticeOnce.has(message)) {
            noticeOnce.add(message)
            showApiNotice(message)
        }
    }

    function registerMenuCommands() {
        if (typeof GM_registerMenuCommand !== 'function') {
            return
        }

        GM_registerMenuCommand('GFSV：设置可选 GitHub Token', () => {
            const hasToken = String(GM_getValue('GITHUB_TOKEN', '') || '').trim().length > 0
            const input = prompt(
                [
                    '请输入可选 GitHub Token：',
                    hasToken ? '当前状态：已设置（内容隐藏）。' : '当前状态：未设置。',
                    '留空并确认可清除 Token。',
                    '保存后请刷新页面。'
                ].join('\n')
            )
            if (input === null) {
                return
            }
            const token = input.trim()
            GM_setValue('GITHUB_TOKEN', token)
            if (token) {
                alert('GITHUB_TOKEN 已保存，请刷新页面生效。')
            } else {
                alert('GITHUB_TOKEN 已清除，请刷新页面生效。')
            }
        })

        GM_registerMenuCommand('GFSV：清除 GitHub Token', () => {
            if (!confirm('确认清除已保存的 GITHUB_TOKEN 吗？')) {
                return
            }
            GM_setValue('GITHUB_TOKEN', '')
            alert('GITHUB_TOKEN 已清除，请刷新页面生效。')
        })

        GM_registerMenuCommand('GFSV：Token 最小权限说明', () => {
            alert(TOKEN_GUIDE_TEXT)
        })
    }

    function showNoticeOnceWithKey(key, message) {
        if (noticeOnce.has(key)) {
            return
        }
        noticeOnce.add(key)
        showApiNotice(message)
    }

    function getCurrentBranchHint() {
        const selectors = [
            'button[data-hotkey="w"] span[data-menu-button]',
            'button[data-hotkey="w"] span',
            '[data-testid="branch-selector"] span',
            'summary[aria-label*="Switch branches or tags"] span'
        ]
        for (const selector of selectors) {
            const node = document.querySelector(selector)
            const text = node ? node.textContent : ''
            if (!text) {
                continue
            }
            const normalized = text.trim().replace(/\s+/g, '')
            if (normalized) {
                return normalized
            }
        }
        return ''
    }

    function parseItemFromLink(link, branchHint) {
        let url = null
        try {
            url = new URL(link.href, location.origin)
        } catch (error) {
            return null
        }
        if (url.origin !== location.origin) {
            return null
        }
        const parts = url.pathname.split('/').filter(Boolean)
        if (parts.length < 5) {
            return null
        }
        const owner = parts[0]
        const repo = parts[1]
        const type = parts[2]
        if (type !== 'blob' && type !== 'tree') {
            return null
        }

        let branch = parts[3]
        let path = parts.slice(4).join('/')
        if (branchHint) {
            const prefix = `/${owner}/${repo}/${type}/${branchHint}`
            if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
                branch = branchHint
                path = url.pathname.slice(prefix.length).replace(/^\/+/, '')
            }
        }

        return {
            owner,
            repo,
            branch,
            path: decodeURIComponent(path),
            isFile: type === 'blob',
            link
        }
    }

    async function resolveHeadSha(owner, repo, branch) {
        const repoRef = `${owner}/${repo}@${branch}`
        const cached = getCachedHead(repoRef)
        if (cached && Date.now() - cached.t <= HEAD_CACHE_TTL_MS) {
            return cached.sha
        }
        try {
            const data = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`)
            const sha = data && typeof data.sha === 'string' ? data.sha : ''
            if (sha) {
                setCachedHead(repoRef, sha)
                return sha
            }
        } catch (error) {
            if (error && error.rateLimited) {
                showRateLimitNotice(error.resetEpoch)
            } else if (error) {
                console.error('Failed to fetch head commit:', error.message || error)
            }
            if (cached && cached.sha) {
                return cached.sha
            }
            throw error
        }
        return ''
    }

    function buildTreeIndex(tree) {
        const fileSizeByPath = new Map()
        const folderStatsByPath = new Map()

        for (const entry of tree) {
            if (!entry || entry.type !== 'blob' || typeof entry.path !== 'string' || typeof entry.size !== 'number') {
                continue
            }
            const filePath = entry.path
            const size = entry.size
            fileSizeByPath.set(filePath, size)

            const segments = filePath.split('/')
            for (let i = 1; i < segments.length; i += 1) {
                const dirPath = segments.slice(0, i).join('/')
                const prev = folderStatsByPath.get(dirPath) || { size: 0, fileCount: 0 }
                prev.size += size
                prev.fileCount += 1
                folderStatsByPath.set(dirPath, prev)
            }
        }

        return { fileSizeByPath, folderStatsByPath }
    }

    async function fetchTreeIndex(owner, repo, branch, repoRefWithHead) {
        if (treeIndexMemory.has(repoRefWithHead)) {
            return treeIndexMemory.get(repoRefWithHead)
        }
        const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`
        const data = await fetchJson(url)
        if (!data || !Array.isArray(data.tree)) {
            throw new Error('Invalid tree response')
        }
        if (data.truncated) {
            showNoticeOnceWithKey('truncated-tree', '仓库 tree 返回被截断，部分目录大小可能不完整。')
        }
        const index = buildTreeIndex(data.tree)
        treeIndexMemory.set(repoRefWithHead, index)
        return index
    }

    function toInfoText(index, path, isFile) {
        if (isFile) {
            const size = index.fileSizeByPath.get(path)
            if (typeof size !== 'number') {
                return 'N/A'
            }
            return `${formatSize(size)} (1 file)`
        }
        const stats = index.folderStatsByPath.get(path) || { size: 0, fileCount: 0 }
        if (stats.size > 0) {
            return `${formatSize(stats.size)} (${stats.fileCount} ${stats.fileCount === 1 ? 'file' : 'files'})`
        }
        return `Folder (${stats.fileCount} ${stats.fileCount === 1 ? 'file' : 'files'})`
    }

    function upsertInfoAfterLink(link, infoText) {
        let infoNode = link.nextElementSibling
        if (!infoNode || !infoNode.classList || !infoNode.classList.contains(INFO_CLASS)) {
            infoNode = document.createElement('span')
            infoNode.className = INFO_CLASS
            infoNode.style.marginLeft = '10px'
            infoNode.style.fontSize = 'smaller'
            infoNode.style.color = '#6a737d'
            link.insertAdjacentElement('afterend', infoNode)
        }
        infoNode.textContent = `(${infoText})`
    }

    async function processGroup(items) {
        const sample = items[0]
        const repoRef = `${sample.owner}/${sample.repo}@${sample.branch}`

        let headSha = ''
        try {
            headSha = await resolveHeadSha(sample.owner, sample.repo, sample.branch)
        } catch (error) {
            if (error && error.rateLimited) {
                for (const item of items) {
                    upsertInfoAfterLink(item.link, RATE_LIMIT_TEXT)
                }
                return
            }
            console.error('Resolve head SHA failed:', error)
        }

        const repoRefWithHead = `${repoRef}#${headSha || 'nohead'}`
        const misses = []

        for (const item of items) {
            const key = cacheEntryKey(repoRefWithHead, item.path, item.isFile)
            const cached = getCachedEntry(key)
            if (cached) {
                upsertInfoAfterLink(item.link, cached)
            } else {
                misses.push(item)
            }
        }

        if (!misses.length) {
            return
        }

        let index = null
        try {
            index = await fetchTreeIndex(sample.owner, sample.repo, sample.branch, repoRefWithHead)
        } catch (error) {
            if (error && error.rateLimited) {
                showRateLimitNotice(error.resetEpoch)
                for (const item of misses) {
                    upsertInfoAfterLink(item.link, RATE_LIMIT_TEXT)
                }
                return
            }
            console.error('Fetch tree index failed:', error)
            for (const item of misses) {
                upsertInfoAfterLink(item.link, 'N/A')
            }
            return
        }

        for (const item of misses) {
            const infoText = toInfoText(index, item.path, item.isFile)
            upsertInfoAfterLink(item.link, infoText)
            if (infoText !== 'N/A') {
                const key = cacheEntryKey(repoRefWithHead, item.path, item.isFile)
                setCachedEntry(key, infoText)
            }
        }
    }

    async function displayFileSizes() {
        runState.runId += 1
        const currentRunId = runState.runId
        const table = document.querySelector('table tbody')
        if (!table) {
            return
        }

        const links = Array.from(table.querySelectorAll('a[href*="/blob/"], a[href*="/tree/"]'))
        if (!links.length) {
            return
        }

        const branchHint = getCurrentBranchHint()
        const groups = new Map()
        for (const link of links) {
            if (link.classList.contains('Link--secondary')) {
                continue
            }
            const parsed = parseItemFromLink(link, branchHint)
            if (!parsed || !parsed.path) {
                continue
            }
            const groupKey = `${parsed.owner}/${parsed.repo}@${parsed.branch}`
            if (!groups.has(groupKey)) {
                groups.set(groupKey, [])
            }
            groups.get(groupKey).push(parsed)
        }

        for (const items of groups.values()) {
            if (currentRunId !== runState.runId) {
                return
            }
            await processGroup(items)
        }
    }

    function observeUrlChanges(callback, delay = 10) {
        let lastUrl = location.href
        const observer = new MutationObserver(() => {
            const url = location.href
            if (url !== lastUrl) {
                lastUrl = url
                setTimeout(() => callback(), delay)
            }
        })
        observer.observe(document, { subtree: true, childList: true })
        return observer
    }

    window.addEventListener('load', () => {
        setTimeout(displayFileSizes, 1200)
    })
    registerMenuCommands()
    observeUrlChanges(displayFileSizes, 1200)
})()
