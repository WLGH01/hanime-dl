// ==UserScript==
// @name         hanime1.me 批量下载工具 (Batch Downloader)
// @name:en      hanime1.me Batch Downloader
// @name:zh-CN   hanime1.me 批量下载工具
// @namespace    hanime1-batch-dl
// @version      1.3.1
// @description  视频批量下载：本页批量勾选/全选、当前作者全部下载、系列(playlist)全部下载、下载当前视频；支持 aria2 RPC（http/socks 代理）、重命名规则按 / 自动建子目录、推送限速、右侧贴边工具栏；任务队列跨页续传；批量完成后自动打包导出 Emby 元数据 zip（NFO+封面+横幅，按重命名目录结构）
// @description:en  Batch download videos from hanime1.me: batch check/select-all, download current author's full uploads, download entire series, download current video; aria2 RPC (http/socks proxy), rename rules with sub-directories, push throttling, cross-page resume, and Emby NFO metadata zip export
// @author       WorkBuddy
// @license      MIT
// @match        https://hanime1.me/*
// @match        https://hanime1.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_download
// @connect      hanime1.me
// @connect      hanime1.com
// @connect      vdownload.hembed.com
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// @run-at       document-end
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    /* ================================================================
     *  常量与默认配置
     * ================================================================ */
    var SITE = location.protocol + '//' + location.host;
    var UA = navigator.userAgent;
    var MAX_AUTHOR_PAGES = 30;      // 作者页兜底翻页上限
    var INFO_CONCURRENCY = 3;       // 批量抓取视频信息并发数

    var DEFAULT_CONFIG = {
        mode: 'aria2',                                  // aria2 | browser
        aria2Rpc: 'http://127.0.0.1:6800/jsonrpc',
        aria2Secret: '',
        aria2Dir: '',                                   // 留空 = aria2 默认目录
        proxy: '',                                      // 例: http://127.0.0.1:7890 或 socks5://127.0.0.1:1080（传给 aria2 的 all-proxy）
        quality: 'auto',                                // auto | 1080p | 720p | 480p
        renameTpl: '{author} - {title} [{quality}]',    // 占位符: {title} {author} {id} {quality} {date} {index}；用 / 分隔可创建子目录
        overwrite: true,                                // aria2 allow-overwrite
        throttle: false,                                // 推送限速开关（关闭 = 不限速）
        throttleSec: 5,                                 // 限速时每个任务的间隔秒数
        exportMeta: true                                // 导出封面 + Emby 兼容 NFO 元数据（作者/标签/点赞百分比）
    };

    var cfg = loadCfg();

    function loadCfg() {
        try {
            var saved = GM_getValue('h1dl_cfg', null);
            return Object.assign({}, DEFAULT_CONFIG, saved ? JSON.parse(saved) : {});
        } catch (e) {
            return Object.assign({}, DEFAULT_CONFIG);
        }
    }
    function saveCfg() {
        GM_setValue('h1dl_cfg', JSON.stringify(cfg));
    }

    /* ================================================================
     *  工具函数
     * ================================================================ */

    // HTML 实体解码
    function decodeEntities(s) {
        if (!s) return '';
        var t = document.createElement('textarea');
        t.innerHTML = s;
        return t.value;
    }

    // 路径段净化（处理模板按 / 切开后的每一段）
    function cleanSegment(s) {
        return (s || '')
            .replace(/[\\\/:*?"<>|]/g, ' ')
            .replace(/[\x00-\x1f]/g, '')
            .replace(/\s+/g, ' ')
            .replace(/^[.\s]+|[.\s]+$/g, '')
            .slice(0, 150);
    }

    // 按重命名规则生成目标路径。
    // 只有模板中显式写的 / 才创建子目录；标题/作者等字段值里自带的 / 会被净化为空格。
    // 例如 "{author} / {title} [{quality}]" → 目录"作者名"，文件"标题 [1080p].mp4"
    // 返回: { subDir: '作者名', filename: 'xx.mp4', display: '作者名/xx.mp4' }
    function buildFileTarget(info, index) {
        // 先净化各字段值（把值内的路径分隔符/非法字符替换掉，避免值"逃出"预期层级）
        var vals = {
            title: cleanSegment(info.title || '').trim(),
            author: cleanSegment(info.author || '').trim(),
            id: cleanSegment(info.id || '').trim(),
            quality: cleanSegment(info.quality || '').trim(),
            date: cleanSegment(info.date || '').trim(),
            index: index != null ? String(index + 1).padStart(3, '0') : ''
        };
        var raw = cfg.renameTpl
            .replace(/\{title\}/g, vals.title)
            .replace(/\{author\}/g, vals.author)
            .replace(/\{id\}/g, vals.id)
            .replace(/\{quality\}/g, vals.quality)
            .replace(/\{date\}/g, vals.date)
            .replace(/\{index\}/g, vals.index);
        var parts = raw.split(/[\/\\]+/)
            .map(function (p) { return cleanSegment(p).trim(); })
            .filter(function (p) { return p; });
        if (!parts.length) parts = ['untitled'];
        var filename = parts.pop();
        if (!/\.mp4$/i.test(filename)) filename += '.mp4';
        var subDir = parts.join('/');
        return { subDir: subDir, filename: filename, display: (subDir ? subDir + '/' : '') + filename };
    }

    function pad3(n) { return String(n).padStart(3, '0'); }

    function isWatchPage() {
        return /\/watch\?v=/.test(location.href);
    }

    // 当前页是否是作者主页
    function isUserPage() {
        return /\/user\/\d+/.test(location.pathname);
    }

    // 当前页是否是系列列表页（playlist）
    function isPlaylistPage() {
        return /\/playlist/.test(location.pathname);
    }

    // 统一转成「作者上传视频」专页 URL。
    // 原因：/user/{id} 主页只显示最近 12 个视频且 ?page= 翻页无效（假分页），
    // 完整作品列表在 /user/{id}/uploaded（每页 60，?page= 真实有效）
    function toUploadedUrl(url) {
        var m = (url || '').match(/\/user\/(\d+)/);
        if (!m) return url;
        return SITE + '/user/' + m[1] + '/uploaded';
    }

    /* ================================================================
     *  网络请求（GM_xmlhttpRequest 包装）
     * ================================================================ */

    function gmFetch(url) {
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                headers: {
                    'User-Agent': UA,
                    'Referer': SITE + '/'
                },
                timeout: 30000,
                onload: function (res) {
                    if (res.status >= 200 && res.status < 400) resolve(res.responseText);
                    else reject(new Error('HTTP ' + res.status + ' ' + url));
                },
                onerror: function (e) { reject(new Error('网络错误: ' + (e && e.error || url))); },
                ontimeout: function () { reject(new Error('超时: ' + url)); }
            });
        });
    }

    function aria2Rpc(method, params, rpcUrlOverride) {
        var rpcUrl = rpcUrlOverride || cfg.aria2Rpc;
        return new Promise(function (resolve, reject) {
            var body = JSON.stringify({
                jsonrpc: '2.0',
                id: 'h1dl_' + Date.now(),
                method: method,
                params: params
            });
            GM_xmlhttpRequest({
                method: 'POST',
                url: rpcUrl,
                headers: { 'Content-Type': 'application/json' },
                data: body,
                timeout: 15000,
                onload: function (res) {
                    try {
                        var json = JSON.parse(res.responseText);
                        if (json.error) reject(new Error('aria2: ' + json.error.message));
                        else resolve(json.result);
                    } catch (e) {
                        reject(new Error('aria2 响应解析失败(HTTP ' + res.status + ')，请检查 RPC 地址'));
                    }
                },
                onerror: function () { reject(new Error('无法连接 aria2 RPC: ' + rpcUrl)); },
                ontimeout: function () { reject(new Error('aria2 RPC 超时: ' + rpcUrl)); }
            });
        });
    }

    /* ================================================================
     *  页面解析
     * ================================================================ */

    // 从 watch 页 HTML 解析视频信息
    // 返回: { id, title, author, date, plot, sources, url, cover, banner, tags, likePct }
    function parseWatchPage(html, pageUrl) {
        var info = { url: pageUrl, sources: {}, tags: [], likePct: 0 };

        var idm = pageUrl.match(/[?&]v=(\d+)/);
        info.id = idm ? idm[1] : '';

        var tm = html.match(/id="shareBtn-title"[^>]*>([\s\S]*?)<\/h3>/);
        info.title = tm ? decodeEntities(tm[1]).trim() : '';

        var am = html.match(/id="video-artist-name"[^>]*>([\s\S]*?)<\/a>/);
        info.author = am ? decodeEntities(am[1]).trim() : '';

        // 发布日期：描述面板里「觀看次數：xxx  2026-08-01」的日期（比页面第一个日期更可靠）
        var dm = html.match(/觀看次數[：:][^<]{0,30}?(\d{4}-\d{2}-\d{2})/);
        if (!dm) dm = html.match(/观看次数[：:][\s\S]{0,40}?(\d{4}-\d{2}-\d{2})/);
        if (!dm) dm = html.match(/(\d{4}-\d{2}-\d{2})/);
        info.date = dm ? dm[1] : '';

        // 简介：<div class="...video-caption-text...">…</div>
        var pm = html.match(/class="[^"]*video-caption-text[^"]*"[\s\S]*?>([\s\S]*?)<\/div>/);
        if (pm) info.plot = decodeEntities(pm[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

        // 横幅（横屏 banner）：og:image 用 {id}h.jpg（1024×576 高清横版）
        // 注意：视频页的 og:image 和 main-thumb 都是横向图；真正的竖屏封面是 image/cover/{id}.jpg，
        // 仅在列表页出现，由 collectPageVideos 收集后经 processItem 传入 info.cover。
        var bm = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/);
        if (!bm) bm = html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/);
        if (bm) info.banner = bm[1].replace(/&amp;/g, '&');

        // 标签：<div class="single-video-tag"><a href="/search?..."># 标签 (N)</a></div>
        // 只取 href 指向 /search 的真实标签链接，过滤 add/remove 等 UI 按钮文本
        var tagRe = /class="single-video-tag"[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
        var tm2, tagSeen = {};
        while ((tm2 = tagRe.exec(html))) {
            if (!/\/search[?"]/.test(tm2[1]) && !/\/search$/.test(tm2[1])) continue;
            var raw = tm2[2].replace(/<[^>]*>/g, '');          // 去掉内部 span
            var t = decodeEntities(raw).replace(/^#/, '').replace(/\(\d+\)\s*$/, '').trim();
            if (!t) continue;
            if (/^(add|remove|like|dislike)$/i.test(t)) continue;   // 过滤 UI 词
            if (!tagSeen[t]) { tagSeen[t] = 1; info.tags.push(t); }
        }

        // 点赞百分比：主视频点赞按钮 .video-like-btn 内 thumb_up 图标后跟百分比
        // 形如 <i ...>thumb_up</i>100%&nbsp;<span>(2)</span>（取第一个匹配即主视频）
        var lm = html.match(/thumb_up<\/i>\s*(\d{1,3})\s*%/);
        if (lm) info.likePct = parseInt(lm[1], 10);

        // <source src="https://.../{id}-{quality}.mp4?secure=...">
        var re = /<source\s+src="(https?:\/\/[^"]+?\.mp4[^"]*)"/g;
        var m, seen = {};
        while ((m = re.exec(html))) {
            var url = m[1].replace(/&amp;/g, '&');
            var qm = url.match(/-(\d{3,4})p\.mp4/);
            if (!qm) continue;
            var q = qm[1] + 'p';
            if (!seen[q]) { seen[q] = 1; info.sources[q] = url; }
        }
        return info;
    }

    // 按用户偏好选择清晰度
    function pickSource(info) {
        var keys = Object.keys(info.sources);
        if (!keys.length) return null;
        if (cfg.quality !== 'auto' && info.sources[cfg.quality]) {
            return { quality: cfg.quality, url: info.sources[cfg.quality] };
        }
        keys.sort(function (a, b) { return parseInt(b) - parseInt(a); });
        var best = keys[0];
        return { quality: best, url: info.sources[best] };
    }

    /* ================================================================
     *  元数据导出（Emby 兼容 NFO + 封面）
     * ================================================================ */

    // XML 转义
    function xmlEsc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    // 生成 Emby/Kodi 兼容的 <movie> NFO。
    // Emby 通过「与视频同名的 .nfo」识别元数据；作者写入 <artist>/<studio>，
    // 标签写入 <tag>，点赞百分比换算为十分制 <rating>（0~10）。
    function buildNfo(info) {
        var year = info.date ? info.date.slice(0, 4) : '';
        var rating = info.likePct != null && info.likePct > 0
            ? (info.likePct / 10).toFixed(1)
            : '';
        var lines = [
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<movie>',
            '  <title>' + xmlEsc(info.title) + '</title>',
            '  <originaltitle>' + xmlEsc(info.title) + '</originaltitle>'
        ];
        if (year) lines.push('  <year>' + year + '</year>');
        if (info.date) lines.push('  <premiered>' + xmlEsc(info.date) + '</premiered>');
        if (info.plot) lines.push('  <plot>' + xmlEsc(info.plot) + '</plot>');
        if (info.author) {
            lines.push('  <artist>' + xmlEsc(info.author) + '</artist>');
            lines.push('  <studio>' + xmlEsc(info.author) + '</studio>');
        }
        // 点赞百分比 → Emby 十分制 rating（0~10）
        if (rating !== '') lines.push('  <rating>' + rating + '</rating>');
        lines.push('  <genre>Animation</genre>');
        (info.tags || []).forEach(function (t) {
            lines.push('  <tag>' + xmlEsc(t) + '</tag>');
        });
        lines.push('</movie>');
        return lines.join('\n');
    }

    // 收集当前页面上的视频卡片（兼容普通列表页、playlist 系列页、genre 搜索页）
    // 返回: [{ url, id, title }]
    function collectPageVideos(root) {
        root = root || document;
        var out = [], seen = {};

        function addLink(a) {
            var href = a.href;
            var vm = href.match(/[?&]v=(\d+)/);
            if (!vm || seen[vm[1]]) return;
            seen[vm[1]] = 1;
            var card = a.closest('.video-item-container') || a;
            var title = card.getAttribute('title') ||
                (card.querySelector('.title') ? card.querySelector('.title').textContent.trim() : '') ||
                (card.querySelector('.video-title') ? card.querySelector('.video-title').textContent.trim() : '') ||
                (card.querySelector('.home-rows-videos-title') ? card.querySelector('.home-rows-videos-title').textContent.trim() : '') ||
                (a.querySelector('.home-rows-videos-title') ? a.querySelector('.home-rows-videos-title').textContent.trim() : '') ||
                vm[1];
            // 竖屏封面：列表页卡片里的 img（image/cover/{id}.jpg）
            var cover = '';
            var img = card.querySelector('img[src*="image/cover/"]') ||
                      (a.querySelector && a.querySelector('img[src*="image/cover/"]'));
            if (img) cover = img.src;
            out.push({ url: href, id: vm[1], title: title.trim(), cover: cover });
        }

        // 1) 普通列表页：a.video-link
        var links = root.querySelectorAll('a.video-link[href*="/watch?v="]');
        for (var i = 0; i < links.length; i++) addLink(links[i]);

        // 2) genre 搜索页 / playlist 系列页：直接 a[href*="/watch?v="]（无 video-link class）
        //    genre 卡片：<a href="/watch?v=ID"><div.home-rows-videos-div><div.video-card-inner>…
        //    playlist 卡片：<div.playlist-video-card><a href="…">
        var directLinks = root.querySelectorAll('a[href*="/watch?v="]');
        for (var k = 0; k < directLinks.length; k++) {
            var a = directLinks[k];
            if (a.classList.contains('video-link')) continue;   // 已处理
            if (a.querySelector('.video-card-inner') || a.closest('.playlist-video-card')) {
                addLink(a);
            }
        }
        return out;
    }

    // 抓取作者全部视频（自动尝试翻页）。
    // 收集进度实时持久化到队列存储，页面切换/回退后可从中断的页码继续。
    function fetchAuthorVideos() {
        var q = loadQueue();
        if (!q || q.phase !== 'collect') return Promise.resolve([]);
        log('开始获取作者全部视频: ' + q.userUrl);
        toast('正在获取作者视频列表…');
        function step() {
            var url = q.userUrl + (q.userUrl.indexOf('?') > -1 ? '&' : '?') + 'page=' + q.page;
            return gmFetch(url).then(function (html) {
                var doc = new DOMParser().parseFromString(html, 'text/html');
                var videos = collectPageVideos(doc);
                var fresh = 0;
                videos.forEach(function (v) {
                    if (!q.seen[v.id]) { q.seen[v.id] = 1; q.items.push(v); fresh++; }
                });
                saveQueue(q);   // 每收集一页就落盘，导航中断也不丢
                log('作者第 ' + q.page + ' 页: ' + videos.length + ' 个视频' + (fresh < videos.length ? '（无新增，停止）' : ''));
                if (fresh === 0 || videos.length === 0 || q.page >= MAX_AUTHOR_PAGES) return q.items;
                q.page++;
                var next = step();
                // 限速模式下翻页之间也等待间隔
                return cfg.throttle ? delay(cfg.throttleSec * 1000).then(function () { return next; }) : next;
            });
        }
        return step();
    }

    /* ================================================================
     *  下载调度
     * ================================================================ */

    /* ================================================================
     *  元数据 ZIP 打包（浏览器下载后解压到 aria2/Emby 目录即可）
     *  极简 STORE 模式 zip 生成器（无压缩，NFO/JPEG 本无压缩空间）
     * ================================================================ */

    var CRC_TABLE = (function () {
        var t = new Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        return t;
    })();
    function crc32(buf) {
        var c = 0xFFFFFFFF;
        for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }
    function strToBytes(s) {
        var out = [];
        for (var i = 0; i < s.length; i++) {
            var code = s.charCodeAt(i);
            if (code < 0x80) out.push(code);
            else {
                var bytes = unescape(encodeURIComponent(s[i]));
                for (var j = 0; j < bytes.length; j++) out.push(bytes.charCodeAt(j));
            }
        }
        return out;
    }
    function u16(v) { return [v & 0xFF, (v >>> 8) & 0xFF]; }
    function u32(v) { return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; }

    // 生成 STORE 模式 zip（UTF-8 文件名）；entries: [{name, data(Uint8Array)}]
    function buildZip(entries) {
        var localChunks = [], central = [], offset = 0;
        entries.forEach(function (e) {
            var nameBytes = strToBytes(e.name);
            var data = e.data;
            var crc = crc32(data);
            // 本地文件头（30 字节 + 文件名）
            var local = []
                .concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
                    u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0));
            localChunks.push(new Uint8Array(local));
            localChunks.push(new Uint8Array(nameBytes));
            localChunks.push(data);
            // 中央目录（46 字节 + 文件名）
            central = central
                .concat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
                    u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length),
                    u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset))
                .concat(Array.prototype.slice.call(nameBytes));
            offset += local.length + nameBytes.length + data.length;
        });
        var centralSize = central.length;
        var eocd = []
            .concat(u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
                u32(centralSize), u32(offset), u16(0));
        var all = localChunks.concat([new Uint8Array(central), new Uint8Array(eocd)]);
        var total = 0;
        all.forEach(function (a) { total += a.length; });
        var out = new Uint8Array(total);
        var p = 0;
        all.forEach(function (a) { out.set(a, p); p += a.length; });
        return out;
    }

    // 元数据收集器：批量任务期间累积 NFO 文本 + 封面/横幅图，任务完成后打包下载
    var metaCollector = {
        items: {},       // key: 目录/文件名, value: {data(Uint8Array), text?}
        _order: [],
        reset: function () { this.items = {}; this._order = []; },
        putText: function (path, text) {
            this.items[path] = { data: new Uint8Array(strToBytes(text)) };
            if (this._order.indexOf(path) < 0) this._order.push(path);
        },
        putImage: function (path, bytes) {
            if (!bytes) return;
            this.items[path] = { data: bytes };
            if (this._order.indexOf(path) < 0) this._order.push(path);
        },
        count: function () { return this._order.length; }
    };

    // 抓取图片二进制（封面/横幅）
    function fetchImageBytes(url) {
        return new Promise(function (resolve) {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                headers: { 'User-Agent': UA, 'Referer': SITE + '/' },
                responseType: 'arraybuffer',
                timeout: 30000,
                onload: function (res) {
                    if (res.status >= 200 && res.status < 400 && res.response) {
                        resolve(new Uint8Array(res.response));
                    } else resolve(null);
                },
                onerror: function () { resolve(null); },
                ontimeout: function () { resolve(null); }
            });
        });
    }

    // 把单个视频的元数据（NFO + 封面 + 横幅）加入收集器；zip 路径按重命名规则的子目录
    function collectMetaForZip(info, target) {
        if (!cfg.exportMeta) return Promise.resolve();
        var base = target.filename.replace(/\.mp4$/i, '');
        var prefix = target.subDir ? target.subDir + '/' : '';
        // NFO（纯文本）
        metaCollector.putText(prefix + base + '.nfo', buildNfo(info));
        // 封面 + 横幅（抓二进制）
        var jobs = [];
        if (info.cover) {
            var ext = (info.cover.match(/\.(jpe?g|png|webp)(\?|$)/i) || [])[1] || 'jpg';
            jobs.push(fetchImageBytes(info.cover).then(function (b) {
                if (b) metaCollector.putImage(prefix + base + '-poster.' + ext, b);
            }));
        }
        if (info.banner && info.banner !== info.cover) {
            var ext2 = (info.banner.match(/\.(jpe?g|png|webp)(\?|$)/i) || [])[1] || 'jpg';
            jobs.push(fetchImageBytes(info.banner).then(function (b) {
                if (b) metaCollector.putImage(prefix + base + '-banner.' + ext2, b);
            }));
        }
        return Promise.all(jobs);
    }

    // 打包并下载元数据 zip
    function exportMetaZip() {
        var paths = metaCollector._order;
        if (!paths.length) { toast('暂无已收集的元数据'); return Promise.resolve(false); }
        var entries = paths.map(function (p) {
            return { name: p, data: metaCollector.items[p].data };
        });
        try {
            var zipBytes = buildZip(entries);
            var blob = new Blob([zipBytes], { type: 'application/zip' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'hanime1-metadata-' + new Date().toISOString().slice(0, 10) + '.zip';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
            log('✓ 已导出元数据 zip：' + entries.length + ' 个文件（解压后整目录拖入下载目录即可）', 'ok');
            toast('元数据 zip 已下载（' + entries.length + ' 个文件）');
            metaCollector.reset();
            return Promise.resolve(true);
        } catch (e) {
            log('✗ 打包 zip 失败: ' + e.message, true);
            return Promise.resolve(false);
        }
    }

    function downloadOne(info, index) {
        var picked = pickSource(info);
        if (!picked) {
            log('✗ 未找到视频源: ' + info.title, true);
            statFailed();
            return Promise.resolve(false);
        }
        info.quality = picked.quality;
        var target = buildFileTarget(info, index);

        if (cfg.mode === 'aria2') {
            var options = {
                out: target.filename,
                'max-connection-per-server': '8',
                split: '8',
                'min-split-size': '10M',
                'allow-overwrite': cfg.overwrite ? 'true' : 'false',
                'auto-file-renaming': 'false',
                'continue': 'true',
                header: [
                    'Referer: ' + SITE + '/',
                    'User-Agent: ' + UA
                ]
            };
            // 重命名模板中的 / 会拼入保存目录（aria2 自动创建不存在的目录）
            var dirParts = [];
            if (cfg.aria2Dir) dirParts.push(cfg.aria2Dir.replace(/[\/\\]+$/, ''));
            if (target.subDir) dirParts.push(target.subDir);
            if (dirParts.length) options.dir = dirParts.join('/');
            if (cfg.proxy) options['all-proxy'] = cfg.proxy;   // http:// 或 socks5:// 均支持

            return aria2Rpc('aria2.addUri', ['token:' + cfg.aria2Secret, [picked.url], options]).then(function () {
                log('✓ 已推送至 aria2: ' + target.display + ' (' + picked.quality + ')', 'ok');
                statPushed();
                // 元数据（NFO + 封面 + 横幅）统一收集进 zip，批量完成后一并导出；不再单独推 aria2
                return collectMetaForZip(info, target).then(function () { return true; });
            }).catch(function (e) {
                log('✗ 推送失败 ' + target.display + ' — ' + e.message, true);
                statFailed();
                return false;
            });
        } else {
            // 浏览器直接下载（GM_download 不支持子目录，仅用文件名）
            if (target.subDir) log('⚠ 浏览器模式不支持子目录，将直接保存到下载目录: ' + target.filename);
            return new Promise(function (resolve) {
                GM_download({
                    url: picked.url,
                    name: target.filename,
                    headers: { 'Referer': SITE + '/' },
                    onload: function () {
                        log('✓ 下载完成: ' + target.filename, 'ok');
                        statPushed();
                        // 浏览器模式：元数据统一收集进 zip（批量完成后一并导出），不逐个下载
                        collectMetaForZip(info, target).then(function () {
                            resolve(true);
                        });
                    },
                    onerror: function (e) {
                        log('✗ 浏览器下载失败(' + target.filename + '): ' + (e.error || '未知错误') + '，建议改用 aria2 模式', true);
                        statFailed();
                        resolve(false);
                    },
                    ontimeout: function () { log('✗ 下载超时: ' + target.filename, true); statFailed(); resolve(false); }
                });
            });
        }
    }

    // 抓取单个视频信息并推送下载；返回 Promise<boolean>
    function processItem(item, idx) {
        return gmFetch(item.url).then(function (html) {
            var info = parseWatchPage(html, item.url);
            if (!info.title) info.title = item.title;
            // 竖屏封面来自列表页卡片（image/cover/{id}.jpg），视频页没有
            if (item.cover && !info.cover) info.cover = item.cover;
            return downloadOne(info, idx);
        }).catch(function (e) {
            log('✗ 获取信息失败: ' + item.title + ' — ' + e.message, true);
            return false;
        });
    }

    function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    /* ================================================================
     *  持久化任务队列（跨页面续传）
     *  队列结构: {
     *    phase: 'collect' | 'push',
     *    // collect 阶段: { userUrl, page, seen: {id:1}, items: [{url,id,title}] }
     *    // push   阶段: { items, done: {id:1}, doing: {id:ts}, ok, fail, stopped }
     *  }
     *  每完成一个任务立即落盘；页面被导航销毁后，脚本在下一个页面
     *  加载时读取队列自动续传（被中断的那个任务未标记 done，会重试）。
     * ================================================================ */

    var QUEUE_KEY = 'h1dl_queue';
    var queueRunning = false;
    var queueStopFlag = false;

    function loadQueue() {
        try {
            var s = GM_getValue(QUEUE_KEY, null);
            return s ? JSON.parse(s) : null;
        } catch (e) { return null; }
    }
    function saveQueue(q) { GM_setValue(QUEUE_KEY, JSON.stringify(q)); }
    function clearQueue() {
        GM_deleteValue(QUEUE_KEY);
        queueRunning = false;
        queueStopFlag = false;
        renderStats();
    }
    function queueDoneCount(q) {
        var n = 0;
        for (var k in q.done) n++;
        return n;
    }
    function queueFinished(q) {
        return q.phase === 'push' && queueDoneCount(q) >= q.items.length;
    }

    // 启动批量推送（勾选下载 / 作者全部下载 共用入口）
    function startBatch(items) {
        if (!items.length) { toast('没有可下载的视频'); return; }
        saveQueue({
            phase: 'push',
            items: items,
            done: {},
            doing: {},
            ok: 0,
            fail: 0,
            stopped: false
        });
        expandLogPanel();
        runQueue(false);
    }

    // 队列执行引擎：认领 → 处理 → 落盘 → 下一个。
    // 认领(claim)与完成(done)都写存储，任意时刻页面被销毁都能无损恢复。
    function runQueue(resumed) {
        if (queueRunning) return;
        var q = loadQueue();
        if (!q || q.phase !== 'push' || !q.items.length) return;
        queueRunning = true;
        queueStopFlag = false;
        expandLogPanel();

        var remaining = q.items.length - queueDoneCount(q);
        log('==== 批量任务' + (resumed ? '（跨页恢复，剩余 ' + remaining + ' 个）' : '开始，共 ' + q.items.length + ' 个视频') +
            (cfg.throttle ? '（限速: 任务间隔 ' + cfg.throttleSec + 's）' : '') + ' ====');
        renderStats();

        // 认领第一个未完成且未被其他 worker 认领的任务，返回下标；-1 = 无
        function claim() {
            var qq = loadQueue();
            if (!qq) return -1;
            for (var i = 0; i < qq.items.length; i++) {
                var it = qq.items[i];
                if (!qq.done[it.id] && !qq.doing[it.id]) {
                    qq.doing[it.id] = Date.now();
                    saveQueue(qq);
                    return i;
                }
            }
            return -1;
        }

        function finishIfNeeded() {
            var qq = loadQueue();
            if (!qq) return;
            if (queueFinished(qq)) {
                log('==== 批量任务结束: 成功推送 ' + qq.ok + '/' + qq.items.length + ' ====');
                toast('批量下载完成: 已推送 ' + qq.ok + '/' + qq.items.length);
                clearQueue();
                // 批量完成后自动打包导出元数据 zip（NFO + 封面 + 横幅）
                if (cfg.exportMeta && metaCollector.count() > 0) {
                    exportMetaZip();
                }
            }
        }

        function worker() {
            if (queueStopFlag) return Promise.resolve();
            var qq = loadQueue();
            if (!qq || queueFinished(qq)) return Promise.resolve();
            var i = claim();
            if (i < 0) return Promise.resolve();
            var item = qq.items[i];
            return processItem(item, i).then(function (ok) {
                var q2 = loadQueue();
                if (!q2) return;
                delete q2.doing[item.id];
                q2.done[item.id] = 1;
                if (ok) q2.ok++; else q2.fail++;
                saveQueue(q2);
                renderStats();
                finishIfNeeded();
                if (queueStopFlag || queueFinished(loadQueue() || {})) return;
                if (cfg.throttle) return delay(cfg.throttleSec * 1000).then(worker);
                return worker();
            });
        }

        var n = cfg.throttle ? 1 : Math.min(INFO_CONCURRENCY, remaining);
        var workers = [];
        for (var k = 0; k < n; k++) workers.push(worker());
        Promise.all(workers).then(function () {
            queueRunning = false;
            finishIfNeeded();
            if (queueStopFlag) {
                log('==== 批量队列已停止（进度已保留，可通过菜单「继续批量任务」恢复）====', true);
            }
        });
    }

    // 手动停止：保留进度，但不自动恢复
    function stopQueue() {
        var q = loadQueue();
        if (!q) { toast('当前没有待处理的批量任务'); return; }
        queueStopFlag = true;
        if (q.phase === 'push') {
            q.stopped = true;
            q.doing = {};
            saveQueue(q);
            log('停止请求已发出，正在结束当前任务…', true);
        } else {
            clearQueue();
            log('已取消作者列表收集任务', true);
        }
    }

    // 恢复（菜单/日志面板触发）
    function resumeQueue() {
        var q = loadQueue();
        if (!q) { toast('当前没有待处理的任务'); return; }
        if (q.phase === 'push') {
            q.stopped = false;
            q.doing = {};   // 清掉上次页面遗留的认领标记
            saveQueue(q);
            runQueue(true);
        } else if (q.phase === 'collect') {
            q.page = q.page || 1;
            saveQueue(q);
            continueAuthorCollect();
        } else if (q.phase === 'collectList') {
            q.page = q.page || 1;
            saveQueue(q);
            continueListCollect();
        }
    }

    // 页面加载时的自动续传入口
    function autoResume() {
        var q = loadQueue();
        if (!q) return;
        expandLogPanel();
        if (q.phase === 'collect') {
            log('检测到未完成的作者列表收集（已收集 ' + (q.items || []).length + ' 个，第 ' + (q.page || 1) + ' 页），自动继续…', true);
            continueAuthorCollect();
        } else if (q.phase === 'collectList') {
            log('检测到未完成的系列列表收集（已收集 ' + (q.items || []).length + ' 个，第 ' + (q.page || 1) + ' 页），自动继续…', true);
            continueListCollect();
        } else if (q.phase === 'push') {
            if (q.stopped) {
                log('检测到已手动暂停的批量任务（已完成 ' + queueDoneCount(q) + '/' + q.items.length + '），可通过菜单「继续批量任务」恢复', true);
            } else {
                log('检测到未完成的批量任务（已完成 ' + queueDoneCount(q) + '/' + q.items.length + '），自动继续推送…', true);
                q.doing = {};
                saveQueue(q);
                runQueue(true);
            }
        }
        renderStats();
    }

    /* ================================================================
     *  UI: 日志面板 & Toast
     * ================================================================ */

    var logPanel = null, logBody = null;
    var stat = { pushed: 0, failed: 0 };

    function renderStats() {
        var el = document.getElementById('h1dl-stat');
        if (!el) return;
        var html = '';
        var q = loadQueue();
        if (q && q.phase === 'push') {
            html += '队列 <b>' + queueDoneCount(q) + '/' + q.items.length + '</b> · ';
        }
        html += '已推送 <b class="h1dl-stat-ok">' + stat.pushed + '</b> · 失败 <b class="h1dl-stat-err">' + stat.failed + '</b>';
        el.innerHTML = html;
    }

    // 展开日志面板（队列运行/恢复时让用户能看到进度）
    function expandLogPanel() {
        if (!logPanel) return;
        logPanel.classList.remove('h1dl-collapsed');
        var t = logPanel.querySelector('.h1dl-log-toggle');
        if (t) t.textContent = '收起';
    }
    function statPushed() { stat.pushed++; renderStats(); }
    function statFailed() { stat.failed++; renderStats(); }

    function ensureLogPanel() {
        if (logPanel) return;
        logPanel = document.createElement('div');
        logPanel.id = 'h1dl-log';
        logPanel.innerHTML =
            '<div class="h1dl-log-head">' +
            '  <span>下载日志 <span id="h1dl-stat"></span></span>' +
            '  <span><span class="h1dl-log-stop">停止队列</span> · <span class="h1dl-log-zip">导出zip</span> · <span class="h1dl-log-clear">清空</span> · <span class="h1dl-log-toggle">收起</span></span>' +
            '</div>' +
            '<div class="h1dl-log-body"></div>';
        document.body.appendChild(logPanel);
        logBody = logPanel.querySelector('.h1dl-log-body');
        logPanel.querySelector('.h1dl-log-toggle').addEventListener('click', function () {
            var collapsed = logPanel.classList.toggle('h1dl-collapsed');
            this.textContent = collapsed ? '展开' : '收起';
        });
        logPanel.querySelector('.h1dl-log-stop').addEventListener('click', stopQueue);
        logPanel.querySelector('.h1dl-log-zip').addEventListener('click', exportMetaZip);
        logPanel.querySelector('.h1dl-log-clear').addEventListener('click', function () {
            logBody.innerHTML = '';
            stat.pushed = 0; stat.failed = 0;
            renderStats();
        });
        renderStats();
    }

    // level: true | 'err' = 错误(红)；'ok' = 成功推送(绿色高亮)；缺省 = 普通信息
    function log(msg, level) {
        ensureLogPanel();
        var cls = 'h1dl-log-line';
        if (level === 'ok') cls += ' h1dl-ok';
        else if (level) cls += ' h1dl-err';
        var line = document.createElement('div');
        line.className = cls;
        var t = new Date();
        line.textContent = '[' + t.toTimeString().slice(0, 8) + '] ' + msg;
        logBody.appendChild(line);
        logBody.scrollTop = logBody.scrollHeight;
        while (logBody.children.length > 200) logBody.removeChild(logBody.firstChild);
        console.log('[h1dl] ' + msg);
    }

    function toast(msg) {
        var t = document.createElement('div');
        t.className = 'h1dl-toast';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(function () { t.classList.add('h1dl-toast-in'); }, 10);
        setTimeout(function () {
            t.classList.remove('h1dl-toast-in');
            setTimeout(function () { t.remove(); }, 400);
        }, 3000);
    }

    /* ================================================================
     *  UI: 设置面板
     * ================================================================ */

    function openSettings() {
        var old = document.getElementById('h1dl-settings');
        if (old) { old.remove(); return; }

        var overlay = document.createElement('div');
        overlay.id = 'h1dl-settings';
        overlay.innerHTML = [
            '<div class="h1dl-mask"></div>',
            '<div class="h1dl-dialog">',
            '  <h3>hanime1 批量下载 · 设置</h3>',
            '  <label class="h1dl-row">下载方式',
            '    <select id="h1dl-mode">',
            '      <option value="aria2">aria2 RPC（推荐，支持代理/多线程）</option>',
            '      <option value="browser">浏览器直接下载</option>',
            '    </select>',
            '  </label>',
            '  <label class="h1dl-row">aria2 RPC 地址<input id="h1dl-rpc" placeholder="http://127.0.0.1:6800/jsonrpc"></label>',
            '  <label class="h1dl-row">aria2 RPC 密钥<input id="h1dl-secret" placeholder="留空表示无密钥"></label>',
            '  <label class="h1dl-row">保存目录<input id="h1dl-dir" placeholder="留空 = aria2 默认目录，如 D:\\hanime"></label>',
            '  <label class="h1dl-row">代理（传给 aria2）<input id="h1dl-proxy" placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"></label>',
            '  <label class="h1dl-row"><span class="h1dl-chk"><input type="checkbox" id="h1dl-throttle"> 推送限速（任务逐个串行推送并等待间隔，防止请求过快被站点限制）</span></label>',
            '  <label class="h1dl-row">任务间隔（秒）<input type="number" id="h1dl-throttle-sec" min="1" step="1" placeholder="5"></label>',
            '  <label class="h1dl-row">优先画质',
            '    <select id="h1dl-quality">',
            '      <option value="auto">最高可用画质</option>',
            '      <option value="1080p">1080p</option>',
            '      <option value="720p">720p</option>',
            '      <option value="480p">480p</option>',
            '    </select>',
            '  </label>',
            '  <label class="h1dl-row">重命名规则<input id="h1dl-tpl"></label>',
            '  <div class="h1dl-hint">占位符：{title} 标题 · {author} 作者 · {id} 视频ID · {quality} 画质 · {date} 日期 · {index} 序号<br>用 <b>/</b> 分隔可自动创建子目录，如：{author} / {title} [{quality}]</div>',
            '  <label class="h1dl-row"><span class="h1dl-chk"><input type="checkbox" id="h1dl-meta"> 导出 NFO 与封面元数据（Beta）</span></label>',
            '  <div class="h1dl-hint">每个视频生成 <b>同名 .nfo</b>（标题/作者/标签/点赞/简介/日期）与 <b>-poster.jpg 封面</b>、<b>-banner.jpg 横幅</b>，统一打包进 zip，批量完成后自动下载，解压整目录拖入下载目录即可。</div>',
            '  <div class="h1dl-btns">',
            '    <button id="h1dl-test" class="h1dl-btn-ghost">测试 aria2 连接</button>',
            '    <span style="flex:1"></span>',
            '    <button id="h1dl-cancel" class="h1dl-btn-ghost">取消</button>',
            '    <button id="h1dl-save" class="h1dl-btn-main">保存</button>',
            '  </div>',
            '</div>'
        ].join('');
        document.body.appendChild(overlay);

        overlay.querySelector('#h1dl-mode').value = cfg.mode;
        overlay.querySelector('#h1dl-rpc').value = cfg.aria2Rpc;
        overlay.querySelector('#h1dl-secret').value = cfg.aria2Secret;
        overlay.querySelector('#h1dl-dir').value = cfg.aria2Dir;
        overlay.querySelector('#h1dl-proxy').value = cfg.proxy;
        overlay.querySelector('#h1dl-throttle').checked = !!cfg.throttle;
        overlay.querySelector('#h1dl-throttle-sec').value = cfg.throttleSec || 5;
        overlay.querySelector('#h1dl-quality').value = cfg.quality;
        overlay.querySelector('#h1dl-tpl').value = cfg.renameTpl;
        overlay.querySelector('#h1dl-meta').checked = !!cfg.exportMeta;

        overlay.querySelector('#h1dl-cancel').addEventListener('click', function () { overlay.remove(); });

        overlay.querySelector('#h1dl-test').addEventListener('click', function () {
            // 用输入框当前值直接测试，不落盘
            var rpcUrl = overlay.querySelector('#h1dl-rpc').value.trim() || DEFAULT_CONFIG.aria2Rpc;
            var secret = overlay.querySelector('#h1dl-secret').value.trim();
            aria2Rpc('aria2.getVersion', ['token:' + secret], rpcUrl)
                .then(function (v) { toast('aria2 连接成功，版本: ' + v.version); })
                .catch(function (e) { toast('aria2 连接失败: ' + e.message); });
        });

        overlay.querySelector('#h1dl-save').addEventListener('click', function () {
            cfg.mode = overlay.querySelector('#h1dl-mode').value;
            cfg.aria2Rpc = overlay.querySelector('#h1dl-rpc').value.trim() || DEFAULT_CONFIG.aria2Rpc;
            cfg.aria2Secret = overlay.querySelector('#h1dl-secret').value.trim();
            cfg.aria2Dir = overlay.querySelector('#h1dl-dir').value.trim();
            cfg.proxy = overlay.querySelector('#h1dl-proxy').value.trim();
            cfg.throttle = overlay.querySelector('#h1dl-throttle').checked;
            cfg.throttleSec = Math.max(1, parseInt(overlay.querySelector('#h1dl-throttle-sec').value, 10) || 5);
            cfg.quality = overlay.querySelector('#h1dl-quality').value;
            cfg.renameTpl = overlay.querySelector('#h1dl-tpl').value.trim() || DEFAULT_CONFIG.renameTpl;
            cfg.exportMeta = overlay.querySelector('#h1dl-meta').checked;
            saveCfg();
            overlay.remove();
            toast('设置已保存');
        });
    }

    /* ================================================================
     *  UI: 列表页 勾选框 + 工具栏
     * ================================================================ */

    var CHECK_ATTR = 'data-h1dl-checked';

    // 找到某视频链接对应的「卡片容器」（用于放勾选框 + 记录勾选状态）
    function findCardContainer(a) {
        return a.closest('.video-item-container') ||
               a.closest('.playlist-video-card') ||
               (a.querySelector('.video-card-inner') ? a : null) ||
               a;
    }

    // 从卡片容器里取视频链接（兼容各类结构）
    function findCardLink(card) {
        if (card.matches && card.matches('a[href*="/watch?v="]')) return card;
        return card.querySelector('a.video-link[href*="/watch?v="]') ||
               card.querySelector('.thumb-container a[href*="/watch?v="]') ||
               card.querySelector('.video-title a[href*="/watch?v="]') ||
               card.querySelector('a[href*="/watch?v="]');
    }

    function injectCheckboxes() {
        // 遍历所有 watch 链接（按 ID 去重），为其卡片容器注入勾选框
        var seen = {};
        var links = document.querySelectorAll('a[href*="/watch?v="]');
        for (var i = 0; i < links.length; i++) {
            (function (link) {
                var vm = link.href.match(/[?&]v=(\d+)/);
                if (!vm || seen[vm[1]]) return;
                var card = findCardContainer(link);
                if (card && card.querySelector && card.querySelector('.h1dl-check')) return;
                if (!card) return;
                seen[vm[1]] = 1;

                var cb = document.createElement('div');
                cb.className = 'h1dl-check';
                cb.innerHTML = '<input type="checkbox">';
                cb.title = '勾选加入批量下载';
                var input = cb.querySelector('input');
                input.addEventListener('click', function (e) { e.stopPropagation(); });
                input.addEventListener('change', function () {
                    // 用闭包捕获的 card（注入时的卡片容器），避免 closest 误匹配到勾选框自身
                    if (card && card.setAttribute) card.setAttribute(CHECK_ATTR, this.checked ? '1' : '0');
                    cb.classList.toggle('h1dl-checked', this.checked);
                    updateToolbarCount();
                });
                cb.addEventListener('click', function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    var inp = this.querySelector('input');
                    inp.checked = !inp.checked;
                    inp.dispatchEvent(new Event('change'));
                });

                // 找到放勾选框的位置（封面图/缩略图容器）
                var host = card.querySelector('.thumb-container') ||
                           card.querySelector('.video-card-inner') ||
                           card.querySelector('img') ||
                           link;
                if (host && host.style) host.style.position = 'relative';
                host.insertBefore(cb, host.firstChild);
            })(links[i]);
        }
    }

    function getCheckedItems() {
        var out = [];
        document.querySelectorAll('[' + CHECK_ATTR + '="1"]').forEach(function (card) {
            var a = findCardLink(card);
            if (!a) return;
            var vm = a.href.match(/[?&]v=(\d+)/);
            var title = (card.getAttribute('title') || '').trim() ||
                (card.querySelector('.video-title') ? card.querySelector('.video-title').textContent.trim() : '') ||
                (card.querySelector('.home-rows-videos-title') ? card.querySelector('.home-rows-videos-title').textContent.trim() : '') ||
                (a.querySelector('.home-rows-videos-title') ? a.querySelector('.home-rows-videos-title').textContent.trim() : '');
            // 竖屏封面（image/cover/{id}.jpg）
            var cover = '';
            var img = card.querySelector('img[src*="image/cover/"]') ||
                      (a.querySelector && a.querySelector('img[src*="image/cover/"]'));
            if (img) cover = img.src;
            out.push({ url: a.href, id: vm ? vm[1] : '', title: title, cover: cover });
        });
        return out;
    }

    function selectAll(checked) {
        document.querySelectorAll('.h1dl-check input').forEach(function (inp) {
            inp.checked = checked;
            inp.dispatchEvent(new Event('change'));
        });
    }

    var toolbar = null;

    function injectToolbar() {
        if (toolbar) return;
        toolbar = document.createElement('div');
        toolbar.id = 'h1dl-rail';
        toolbar.innerHTML =
            '<div class="h1dl-rail-panel">' +
            '  <div class="h1dl-rail-title">hanime 下载</div>' +
            '  <button id="h1dl-tb-all">全选本页</button>' +
            '  <button id="h1dl-tb-none">取消全选</button>' +
            '  <button id="h1dl-tb-dl" class="h1dl-tb-main">下载勾选(<b id="h1dl-tb-count">0</b>)</button>' +
            '  <button id="h1dl-tb-cfg">⚙ 设置</button>' +
            '</div>' +
            '<div class="h1dl-rail-handle">' +
            '  <span class="h1dl-rail-badge" id="h1dl-rail-badge"></span>' +
            '  <span class="h1dl-ch">下</span><span class="h1dl-ch">载</span>' +
            '  <span class="h1dl-ch">工</span><span class="h1dl-ch">具</span>' +
            '</div>';
        document.body.appendChild(toolbar);

        toolbar.querySelector('#h1dl-tb-all').addEventListener('click', function () { selectAll(true); });
        toolbar.querySelector('#h1dl-tb-none').addEventListener('click', function () { selectAll(false); });
        toolbar.querySelector('#h1dl-tb-dl').addEventListener('click', function () {
            var items = getCheckedItems();
            if (!items.length) { toast('请先勾选视频'); return; }
            startBatch(items);
        });
        toolbar.querySelector('#h1dl-tb-cfg').addEventListener('click', openSettings);
    }

    function updateToolbarCount() {
        var n = getCheckedItems().length;
        var el = document.getElementById('h1dl-tb-count');
        if (el) el.textContent = String(n);
        var badge = document.getElementById('h1dl-rail-badge');
        if (badge) badge.textContent = n ? String(n) : '';
    }

    /* ================================================================
     *  UI: 视频播放页 面板
     * ================================================================ */

    function injectWatchPanel() {
        if (document.getElementById('h1dl-watch-panel')) return;
        var titleEl = document.getElementById('shareBtn-title');
        if (!titleEl) return;

        var panel = document.createElement('div');
        panel.id = 'h1dl-watch-panel';

        // 解析本页视频信息（直接用 DOM，无需二次请求）
        var info = {
            url: location.href,
            title: titleEl.textContent.trim(),
            author: '',
            date: '',
            plot: '',
            sources: {},
            tags: [],
            likePct: 0
        };
        var artistEl = document.getElementById('video-artist-name');
        if (artistEl) info.author = artistEl.textContent.trim();
        var metaEl = document.querySelector('.video-details-wrapper.hidden-sm');
        if (metaEl) {
            var dm = metaEl.textContent.match(/(\d{4}-\d{2}-\d{2})/);
            if (dm) info.date = dm[1];
        }
        // 简介
        var plotEl = document.querySelector('.video-caption-text');
        if (plotEl) info.plot = plotEl.textContent.replace(/\s+/g, ' ').trim();
        document.querySelectorAll('video source[src*=".mp4"]').forEach(function (s) {
            var qm = s.src.match(/-(\d{3,4})p\.mp4/);
            if (qm && !info.sources[qm[1] + 'p']) info.sources[qm[1] + 'p'] = s.src;
        });
        // 横幅（横屏 banner）：og:image 用 {id}h.jpg（1024×576 高清横版）
        // 竖屏封面 image/cover/{id}.jpg 在视频页不存在，播放页单视频下载时无封面（仅横幅）
        var ogImg = document.querySelector('meta[property="og:image"]');
        if (ogImg && ogImg.content) info.banner = ogImg.content;
        // 标签（只取指向 /search 的真实标签链接，过滤 add/remove 等 UI 按钮）
        document.querySelectorAll('.single-video-tag a[href*="/search"]').forEach(function (a) {
            var t = a.textContent.replace(/^#/, '').replace(/\(\d+\)\s*$/, '').trim();
            if (t && !/^(add|remove|like|dislike)$/i.test(t) && info.tags.indexOf(t) < 0) info.tags.push(t);
        });
        // 点赞百分比：主视频点赞按钮内 thumb_up 图标后的百分比
        var likeEl = document.querySelector('.video-like-btn');
        if (likeEl) {
            var lm = likeEl.textContent.match(/thumb_up\s*(\d{1,3})\s*%/);
            if (lm) info.likePct = parseInt(lm[1], 10);
        }

        var qualities = Object.keys(info.sources).sort(function (a, b) { return parseInt(b) - parseInt(a); });
        if (!qualities.length) {
            panel.innerHTML = '<span class="h1dl-warn">未检测到视频源（可能需要登录/付费）</span>';
        } else {
            panel.innerHTML =
                '<span class="h1dl-wp-label">画质</span>' +
                '<select id="h1dl-wp-q">' +
                '<option value="auto">最高(' + qualities[0] + ')</option>' +
                qualities.map(function (q) { return '<option value="' + q + '">' + q + '</option>'; }).join('') +
                '</select>' +
                '<button id="h1dl-wp-dl" class="h1dl-btn-main">⬇ 下载当前视频</button>' +
                '<button id="h1dl-wp-author" class="h1dl-btn-ghost">👤 批量下载当前作者</button>' +
                '<button id="h1dl-wp-cfg" class="h1dl-btn-ghost">⚙ 设置</button>';
        }

        titleEl.parentNode.insertBefore(panel, titleEl.nextSibling);

        if (qualities.length) {
            panel.querySelector('#h1dl-wp-dl').addEventListener('click', function () {
                var q = panel.querySelector('#h1dl-wp-q').value;
                var backup = cfg.quality;
                cfg.quality = q;   // 临时覆盖画质（downloadOne 内同步完成取源）
                downloadOne(info, null);
                cfg.quality = backup;
            });
            panel.querySelector('#h1dl-wp-author').addEventListener('click', downloadCurrentAuthor);
        }
        var cfgBtn = panel.querySelector('#h1dl-wp-cfg');
        if (cfgBtn) cfgBtn.addEventListener('click', openSettings);
    }

    // 从当前页提取作者并批量下载其全部上传视频
    function downloadCurrentAuthor() {
        var userUrl = '';
        if (isUserPage()) {
            // 当前就在作者页（主页或 /uploaded 均可），取地址栏
            userUrl = location.href;
        } else {
            // 播放页：优先取右侧作者列表底部的「查看全部上传」链接（playlist-footer），
            // 其次取作者头像/名字链接（页面第一个 /user/ 链接即作者本人）
            var upLink = document.querySelector('a[href*="/user/"][href*="/uploaded"]');
            var userLink = upLink || document.querySelector('a[href*="/user/"]');
            if (!userLink) { toast('当前页未找到作者主页链接'); return; }
            userUrl = userLink.href;
        }
        // 统一改走 /uploaded 专页：主页只有最近 12 个且翻页无效
        userUrl = toUploadedUrl(userUrl);
        // 收集任务也持久化：翻页收集期间切页/回退，下个页面自动接着收集
        saveQueue({
            phase: 'collect',
            userUrl: userUrl,
            page: 1,
            seen: {},
            items: []
        });
        continueAuthorCollect();
    }

    // 执行/续传「作者视频收集」队列，收集完 → 确认 → 转入推送队列
    function continueAuthorCollect() {
        var q = loadQueue();
        if (!q || q.phase !== 'collect') return;
        fetchAuthorVideos().then(function (items) {
            if (!items.length) { clearQueue(); toast('未找到该作者的公开视频'); return; }
            if (!confirm('该作者共 ' + items.length + ' 个视频，全部加入下载队列？')) {
                clearQueue();
                return;
            }
            startBatch(items);
        }).catch(function (e) {
            log('✗ 获取作者视频失败: ' + e.message + '（进度已保留，刷新或打开任意页面会自动重试）', true);
            toast('获取作者视频失败，稍后自动重试');
        });
    }

    // 作者主页上显示批量下载按钮
    function injectUserPagePanel() {
        if (!isUserPage() || document.getElementById('h1dl-user-panel')) return;
        var p = document.createElement('div');
        p.id = 'h1dl-user-panel';
        p.innerHTML =
            '<button id="h1dl-up-dl" class="h1dl-btn-main">⬇ 批量下载当前作者全部视频</button>' +
            '<button id="h1dl-up-page" class="h1dl-btn-ghost">⬇ 下载本页视频</button>' +
            '<button id="h1dl-up-cfg" class="h1dl-btn-ghost">⚙ 设置</button>';
        var container = document.querySelector('.video-item-container');
        if (!container || !container.parentNode) return;
        container.parentNode.insertBefore(p, container);
        p.querySelector('#h1dl-up-dl').addEventListener('click', downloadCurrentAuthor);
        p.querySelector('#h1dl-up-page').addEventListener('click', function () {
            var items = collectPageVideos(document);
            if (!items.length) { toast('本页未找到视频'); return; }
            startBatch(items);
        });
        p.querySelector('#h1dl-up-cfg').addEventListener('click', openSettings);
    }

    // 系列列表页（playlist）显示批量下载按钮（支持翻页收集整个系列）
    function injectPlaylistPanel() {
        if (!isPlaylistPage() || document.getElementById('h1dl-playlist-panel')) return;
        var p = document.createElement('div');
        p.id = 'h1dl-playlist-panel';
        p.innerHTML =
            '<button id="h1dl-pl-all" class="h1dl-btn-main">⬇ 批量下载本系列全部</button>' +
            '<button id="h1dl-pl-page" class="h1dl-btn-ghost">⬇ 下载本页视频</button>' +
            '<button id="h1dl-pl-cfg" class="h1dl-btn-ghost">⚙ 设置</button>';
        var container = document.querySelector('.playlist-video-card, .video-item-container');
        if (!container || !container.parentNode) return;
        container.parentNode.insertBefore(p, container);
        p.querySelector('#h1dl-pl-page').addEventListener('click', function () {
            var items = collectPageVideos(document);
            if (!items.length) { toast('本页未找到视频'); return; }
            startBatch(items);
        });
        p.querySelector('#h1dl-pl-all').addEventListener('click', function () {
            downloadCurrentPlaylist();
        });
        p.querySelector('#h1dl-pl-cfg').addEventListener('click', openSettings);
    }

    // 收集当前系列（playlist）全部视频：自动翻页（?page=N），去重后入队
    function downloadCurrentPlaylist() {
        var lm = location.pathname.match(/\/playlist(?:\?|$)/) ? location.href : '';
        var listId = (location.href.match(/[?&]list=(\d+)/) || [])[1] || '';
        if (!listId) { toast('未识别到系列 ID'); return; }
        // 构造翻页基 URL（保留 list 参数，去掉 page）
        var base = SITE + '/playlist?list=' + listId + '&sort=latest';
        saveQueue({ phase: 'collectList', base: base, page: 1, seen: {}, items: [] });
        continueListCollect();
    }

    // 执行/续传「系列视频收集」队列（翻页收集整个 playlist）
    function continueListCollect() {
        var q = loadQueue();
        if (!q || q.phase !== 'collectList') return;
        log('开始获取系列全部视频: ' + q.base);
        toast('正在获取系列视频列表…');
        function step() {
            var url = q.base + '&page=' + q.page;
            return gmFetch(url).then(function (html) {
                var doc = new DOMParser().parseFromString(html, 'text/html');
                var videos = collectPageVideos(doc);
                var fresh = 0;
                videos.forEach(function (v) {
                    if (!q.seen[v.id]) { q.seen[v.id] = 1; q.items.push(v); fresh++; }
                });
                saveQueue(q);
                log('系列第 ' + q.page + ' 页: ' + videos.length + ' 个视频' + (fresh < videos.length ? '（无新增，停止）' : ''));
                if (fresh === 0 || videos.length === 0 || q.page >= MAX_AUTHOR_PAGES) return q.items;
                q.page++;
                var next = step();
                return cfg.throttle ? delay(cfg.throttleSec * 1000).then(function () { return next; }) : next;
            });
        }
        step().then(function (items) {
            if (!items.length) { clearQueue(); toast('该系列没有可下载的视频'); return; }
            if (!confirm('该系列共 ' + items.length + ' 个视频，全部加入下载队列？')) { clearQueue(); return; }
            startBatch(items);
        }).catch(function (e) {
            log('✗ 获取系列视频失败: ' + e.message + '（进度已保留，稍后自动重试）', true);
            toast('获取系列视频失败，稍后自动重试');
        });
    }

    /* ================================================================
     *  样式
     * ================================================================ */

    function injectStyle() {
        var css = [
            '#h1dl-rail{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:99999;font-family:sans-serif;}',
            '#h1dl-rail .h1dl-rail-handle{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;width:42px;min-height:160px;padding:16px 0 20px;background:linear-gradient(180deg,#e04a6f,#b83a58);color:#fff;border-radius:14px 0 0 14px;cursor:pointer;box-shadow:-3px 0 16px rgba(0,0,0,.5);user-select:none;transition:width .18s ease;}',
            '#h1dl-rail .h1dl-rail-handle:hover{width:50px;}',
            '#h1dl-rail .h1dl-rail-handle .h1dl-ch{display:block;font-size:20px;font-weight:bold;line-height:1;letter-spacing:0;text-shadow:0 1px 2px rgba(0,0,0,.35);}',
            '#h1dl-rail .h1dl-rail-badge{position:absolute;top:-11px;left:50%;transform:translateX(-50%);background:#fff;color:#e04a6f;font-size:13px;font-weight:bold;min-width:22px;height:22px;line-height:22px;text-align:center;border-radius:11px;padding:0 5px;display:none;box-shadow:0 1px 5px rgba(0,0,0,.45);}',
            '#h1dl-rail .h1dl-rail-badge:not(:empty){display:block;}',
            '#h1dl-rail .h1dl-rail-panel{position:absolute;right:42px;top:50%;transform:translateY(-50%) translateX(12px);opacity:0;visibility:hidden;transition:transform .22s ease,opacity .22s ease,visibility .22s;display:flex;flex-direction:column;gap:7px;background:rgba(20,20,28,.95);border:1px solid rgba(255,255,255,.15);border-radius:12px;padding:12px;width:180px;box-sizing:border-box;box-shadow:0 4px 22px rgba(0,0,0,.55);backdrop-filter:blur(6px);}',
            '#h1dl-rail:hover .h1dl-rail-panel{transform:translateY(-50%) translateX(0);opacity:1;visibility:visible;}',
            '#h1dl-rail .h1dl-rail-title{color:#ff7b9c;font-size:13px;font-weight:bold;text-align:center;margin-bottom:2px;}',
            '#h1dl-rail button{width:100%;background:#333;border:1px solid #555;color:#eee;border-radius:7px;padding:8px 10px;font-size:13px;cursor:pointer;white-space:nowrap;}',
            '#h1dl-rail button:hover{background:#444;}',
            '#h1dl-rail .h1dl-tb-main{background:#e04a6f;border-color:#e04a6f;color:#fff;font-weight:bold;}',
            '#h1dl-rail .h1dl-tb-main:hover{background:#f05a7f;}',

            '.h1dl-check{position:absolute;top:6px;left:6px;z-index:50;width:26px;height:26px;border-radius:6px;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;cursor:pointer;border:1px solid rgba(255,255,255,.4);}',
            '.h1dl-check input{width:16px;height:16px;cursor:pointer;margin:0;accent-color:#e04a6f;}',
            '.h1dl-check.h1dl-checked{background:rgba(224,74,111,.85);border-color:#e04a6f;}',

            '#h1dl-watch-panel,#h1dl-user-panel,#h1dl-playlist-panel{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0;padding:10px;background:rgba(30,30,40,.6);border:1px solid rgba(255,255,255,.12);border-radius:10px;}',
            '#h1dl-watch-panel select,#h1dl-user-panel select,#h1dl-playlist-panel select{background:#2a2a35;color:#eee;border:1px solid #555;border-radius:6px;padding:5px 8px;}',
            '.h1dl-wp-label{color:#ccc;font-size:13px;}',
            '.h1dl-warn{color:#ffb84d;font-size:13px;}',

            '.h1dl-btn-main{background:#e04a6f;border:none;color:#fff;border-radius:6px;padding:7px 14px;font-size:13px;font-weight:bold;cursor:pointer;}',
            '.h1dl-btn-main:hover{background:#f05a7f;}',
            '.h1dl-btn-ghost{background:transparent;border:1px solid #666;color:#ccc;border-radius:6px;padding:7px 12px;font-size:13px;cursor:pointer;}',
            '.h1dl-btn-ghost:hover{border-color:#999;color:#fff;}',

            '#h1dl-log{position:fixed;left:16px;bottom:16px;z-index:99998;width:420px;max-height:260px;background:rgba(15,15,22,.94);border:1px solid rgba(255,255,255,.15);border-radius:10px;overflow:hidden;font-size:12px;box-shadow:0 4px 20px rgba(0,0,0,.5);}',
            '#h1dl-log .h1dl-log-head{padding:6px 10px;color:#ff7b9c;font-weight:bold;display:flex;justify-content:space-between;align-items:center;background:rgba(255,255,255,.04);}',
            '#h1dl-log .h1dl-log-head b.h1dl-stat-ok{color:#7bffa0;}',
            '#h1dl-log .h1dl-log-head b.h1dl-stat-err{color:#ff7b7b;}',
            '#h1dl-log .h1dl-log-clear,#h1dl-log .h1dl-log-toggle{cursor:pointer;color:#888;font-weight:normal;}',
            '#h1dl-log .h1dl-log-stop{cursor:pointer;color:#ff9b7b;font-weight:normal;}',
            '#h1dl-log .h1dl-log-stop:hover{color:#ff7b5b;}',
            '#h1dl-log .h1dl-log-zip{cursor:pointer;color:#7bffa0;font-weight:normal;}',
            '#h1dl-log .h1dl-log-zip:hover{color:#a0ffc0;}',
            '#h1dl-log .h1dl-log-clear:hover,#h1dl-log .h1dl-log-toggle:hover{color:#ccc;}',
            '#h1dl-log .h1dl-log-body{max-height:200px;overflow-y:auto;padding:6px 10px;color:#888;line-height:1.6;}',
            '#h1dl-log .h1dl-log-line.h1dl-ok{color:#7bffa0;font-weight:bold;}',
            '#h1dl-log .h1dl-log-line.h1dl-err{color:#ff7b7b;}',
            '#h1dl-log.h1dl-collapsed .h1dl-log-body{display:none;}',

            '.h1dl-toast{position:fixed;top:20px;left:50%;transform:translateX(-50%) translateY(-60px);background:#e04a6f;color:#fff;padding:10px 22px;border-radius:8px;z-index:100000;font-size:14px;opacity:0;transition:all .3s;box-shadow:0 4px 16px rgba(0,0,0,.4);}',
            '.h1dl-toast.h1dl-toast-in{opacity:1;transform:translateX(-50%) translateY(0);}',

            '#h1dl-settings{position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;}',
            '#h1dl-settings .h1dl-mask{position:absolute;inset:0;background:rgba(0,0,0,.6);}',
            '#h1dl-settings .h1dl-dialog{position:relative;width:460px;max-width:92vw;max-height:86vh;overflow-y:auto;background:#1c1c26;border:1px solid #444;border-radius:12px;padding:20px;color:#eee;}',
            '#h1dl-settings h3{margin:0 0 14px;color:#ff7b9c;}',
            '#h1dl-settings .h1dl-row{display:flex;flex-direction:column;gap:4px;margin-bottom:12px;font-size:13px;color:#ccc;}',
            '#h1dl-settings input,#h1dl-settings select{background:#12121a;border:1px solid #555;color:#eee;border-radius:6px;padding:7px 9px;font-size:13px;outline:none;}',
            '#h1dl-settings input:focus,#h1dl-settings select:focus{border-color:#e04a6f;}',
            '#h1dl-settings .h1dl-chk{display:flex;align-items:flex-start;gap:8px;font-size:13px;color:#ccc;line-height:1.5;cursor:pointer;}',
            '#h1dl-settings .h1dl-chk input{margin-top:2px;accent-color:#e04a6f;width:15px;height:15px;padding:0;flex:none;}',
            '#h1dl-settings .h1dl-hint{font-size:11px;color:#888;margin-bottom:14px;line-height:1.6;}',
            '#h1dl-settings .h1dl-btns{display:flex;gap:8px;}'
        ].join('\n');
        var style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }

    /* ================================================================
     *  启动
     * ================================================================ */

    function init() {
        injectStyle();
        ensureLogPanel();
        logPanel.classList.add('h1dl-collapsed');
        logPanel.querySelector('.h1dl-log-toggle').textContent = '展开';

        GM_registerMenuCommand('打开设置', openSettings);
        GM_registerMenuCommand('下载当前作者全部视频', function () {
            if (isWatchPage() || isUserPage()) downloadCurrentAuthor();
            else toast('请在视频页或作者主页使用');
        });
        GM_registerMenuCommand('继续批量任务（恢复中断的队列）', resumeQueue);
        GM_registerMenuCommand('停止批量任务（保留进度）', stopQueue);

        // 跨页续传：页面加载时检测未完成的队列并自动恢复
        setTimeout(autoResume, 600);

        function injectAll() {
            if (!isWatchPage()) {
                injectCheckboxes();
                injectToolbar();
            }
            injectWatchPanel();
            injectUserPagePanel();
            injectPlaylistPanel();
        }
        injectAll();

        // SPA / 懒加载兜底
        var mo = new MutationObserver(function () {
            clearTimeout(init._t);
            init._t = setTimeout(injectAll, 300);
        });
        mo.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
