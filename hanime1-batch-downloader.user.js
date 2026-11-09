// ==UserScript==
// @name         hanime1.me 批量下载工具 (Batch Downloader)
// @name:en      hanime1.me Batch Downloader
// @name:zh-CN   hanime1.me 批量下载工具
// @namespace    hanime1-batch-dl
// @version      1.4.4
// @description  视频批量下载：本页批量勾选/全选、当前作者全部下载、系列(playlist)全部下载、下载当前视频；支持 aria2 RPC（http/socks 代理）、重命名规则按 / 自动建子目录、推送限速、右侧贴边工具栏；任务队列跨页续传；批量完成后自动打包导出 Emby 元数据 zip（NFO+封面+横幅，按重命名目录结构）；实验性：推送到 MediaCenter API（直链+元数据）
// @description:en  Batch download videos from hanime1.me: batch check/select-all, download current author's full uploads, download entire series, download current video; aria2 RPC (http/socks proxy), rename rules with sub-directories, push throttling, cross-page resume, Emby NFO metadata zip export; experimental: push download links + metadata to MediaCenter API
// @author       WorkBuddy
// @license      MIT
// @match        https://hanime1.me/*
// @match        https://hanime1.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
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
    var INFO_CONCURRENCY = 5;       // 批量抓取视频信息并发数

    var DEFAULT_CONFIG = {
        mode: 'aria2',                                  // aria2 | browser
        aria2Rpc: 'http://127.0.0.1:6800/jsonrpc',
        aria2Secret: '',
        aria2Dir: '',                                   // 留空 = aria2 默认目录
        proxy: '',                                      // 例: http://127.0.0.1:7890 或 socks5://127.0.0.1:1080（传给 aria2 的 all-proxy）
        quality: 'auto',                                // auto | 1080p | 720p | 480p
        renameTpl: '',                                  // 留空 = 按下载方式取默认（aria2 带作者子目录，浏览器仅文件名）
        overwrite: true,                                // aria2 allow-overwrite
        throttle: false,                                // 推送限速开关（关闭 = 不限速）
        throttleSec: 5,                                 // 限速时每个任务的间隔秒数
        exportMeta: false,                              // 导出封面 + Emby 兼容 NFO 元数据（作者/标签/点赞百分比）
        showExperimental: false,                        // 显示实验性功能（MediaCenter API 推送）配置区块
        mediaCenter: false,                             // 实验性：配合 aria2 下载完成后自动登记到 MediaCenter（浏览器下载不可用）
        mediaCenterBase: 'http://127.0.0.1:3000/api',   // MediaCenter API 基础地址
        mediaCenterToken: ''                            // MediaCenter .env 的 API_TOKEN（静态服务令牌）
    };

    // 重命名模板默认值：
    //   aria2 支持子目录 → 默认建作者目录；
    //   浏览器下载不支持子目录 → 默认仅文件名（模板仍可自定义，子目录会平铺）。
    var RENAME_TPL_DEFAULT = {
        aria2: '{author}/{title} [{quality}]',
        browser: '{title} [{quality}]'
    };
    function defaultRenameTpl(mode) {
        return RENAME_TPL_DEFAULT[mode || 'aria2'] || RENAME_TPL_DEFAULT.aria2;
    }

    var cfg = loadCfg();

    function loadCfg() {
        try {
            var saved = GM_getValue('h1dl_cfg', null);
            var merged = Object.assign({}, DEFAULT_CONFIG, saved ? JSON.parse(saved) : {});
            // 旧版本默认模板 "{author} - {title} [{quality}]" 升级后不再作为默认，跟随下载方式取新默认
            if (merged.renameTpl === '{author} - {title} [{quality}]') merged.renameTpl = '';
            return merged;
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

    // 拼接目录：按 base 的写法选择分隔符（Windows 反斜杠 / Linux 斜杠），
    // 避免 "D:\hanime" + "/" + "作者" 这种混合写法导致 aria2 建目录失败。
    function joinPath(base, sub) {
        if (!base) return sub || '';
        if (!sub) return String(base);
        var sep = (/\\/.test(base) && !/\//.test(base)) ? '\\' : '/';
        var b = String(base).replace(/[\/\\]+$/, '');
        var s = String(sub).replace(/^[\/\\]+/, '').replace(/[\/\\]+/g, sep);
        return b + sep + s;
    }

    // 按重命名规则生成目标路径。
    // 模板中显式写的 / 或 \ 都会创建子目录（Windows/Linux 写法都认）；
    // 标题/作者等字段值里自带的 / 或 \ 会被净化为空格。
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
        // 浏览器模式默认仅文件名（子目录会平铺）；aria2 默认带作者子目录
        var tpl = cfg.renameTpl || defaultRenameTpl(cfg.mode);
        var raw = tpl
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

    // 浏览器下载（<a download>）无法创建子目录：Chrome 会把文件名里的 / 过滤掉。
    // 因此浏览器模式下把模板的子目录降级为文件名前缀："作者 / 标题" → "作者 - 标题.mp4"，
    // 元数据 zip 也用同一扁平名字，保证 NFO/封面与视频同名同层。
    function flattenTarget(target) {
        if (!target.subDir) return target;
        var base = target.subDir.replace(/[\/\\]+/g, ' - ') + ' - ' + target.filename.replace(/\.mp4$/i, '');
        var flat = cleanSegment(base).replace(/[.\s]+$/, '');
        if (!flat) flat = 'untitled';
        flat += '.mp4';
        return { subDir: '', filename: flat, display: flat };
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
     *  MediaCenter 登记（实验性，配合 aria2）
     *  MediaCenter 的 POST /media 只登记「服务器本地已存在的文件」，不下载远程 URL，
     *  因此流程：aria2 下载到服务器路径 → 完成后登记本地路径 + 元数据。
     *  契约（docs/API.md）：
     *    GET  {base}/media?filePath=… —— 按服务器路径查重（仅管理员）
     *    POST {base}/media —— 创建媒体记录（仅管理员），filePath=本地路径，
     *                           mimeType=video/mp4，sourceMeta=完整元数据 JSON
     *    PUT  {base}/media/:id —— 补全标题/简介/作者/标签/来源
     *  鉴权：Authorization: Bearer <MediaCenter 的 API_TOKEN>（静态服务令牌）
     * ================================================================ */

    // 通用 MediaCenter 请求；token 缺省用 cfg.mediaCenterToken（测试时可覆盖）
    function mcRequest(url, opts) {
        opts = opts || {};
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: opts.method || 'GET',
                url: url,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + (opts.token != null ? opts.token : cfg.mediaCenterToken)
                },
                data: opts.data ? JSON.stringify(opts.data) : undefined,
                timeout: opts.timeout || 45000,
                onload: function (res) {
                    var body = null;
                    try { body = JSON.parse(res.responseText); } catch (e) { /* 非 JSON 响应 */ }
                    if (res.status >= 200 && res.status < 300) resolve({ status: res.status, body: body });
                    else {
                        var err = new Error('MediaCenter HTTP ' + res.status + (body && body.error ? ' (' + body.error + ')' : ''));
                        err.body = body;   // 附带响应体（如 409 的 existingId）
                        reject(err);
                    }
                },
                onerror: function () { reject(new Error('无法连接 MediaCenter: ' + url)); },
                ontimeout: function () { reject(new Error('MediaCenter 请求超时: ' + url)); }
            });
        });
    }

    // 测试 MediaCenter 连接（用输入框当前值，不落盘）
    function testMediaCenter(base, token) {
        return mcRequest(base.replace(/\/+$/, '') + '/media?limit=1', { token: token });
    }

    // 构造推送载荷：完整元数据（JSON 写入 sourceMeta，同时拆字段走 PUT）
    // 注意：pageUrl 为 hanime1 网页来源链接（source 的来源）；downloadUrl 是直链，
    //       secure 令牌会过期，仅供参考，不作为来源。来源一律以 source='hanime1' + pageUrl 为准。
    function buildMcPayload(info, picked) {
        return {
            source: 'hanime1',
            hanimeId: info.id || '',
            title: info.title || '',
            author: info.author || '',
            date: info.date || '',
            quality: (picked && picked.quality) || info.quality || '',
            downloadUrl: (picked && picked.url) || '',
            pageUrl: info.url || '',
            cover: info.cover || '',
            banner: info.banner || '',
            tags: info.tags || [],
            likePct: info.likePct || 0,
            plot: info.plot || '',
            pushedAt: new Date().toISOString()
        };
    }

    // 轮询 aria2 任务直到完成/失败（默认最长等 12 小时；页面被销毁后队列跨页续传兜底）
    function waitAria2Complete(gid, timeoutMs) {
        var deadline = Date.now() + (timeoutMs || 12 * 3600 * 1000);
        return new Promise(function (resolve, reject) {
            function poll() {
                aria2Rpc('aria2.tellStatus', ['token:' + cfg.aria2Secret, gid]).then(function (st) {
                    if (st.status === 'complete') resolve(st);
                    else if (st.status === 'error' || st.status === 'removed') {
                        reject(new Error('aria2 下载失败: ' + (st.errorMessage || st.status)));
                    } else if (Date.now() > deadline) {
                        reject(new Error('等待 aria2 下载超时（12h），可稍后「继续批量任务」自动重试'));
                    } else {
                        setTimeout(poll, 3000);
                    }
                }).catch(reject);
            }
            poll();
        });
    }

    // 推送 aria2 下载任务并等待下载完成：addUri → 轮询 tellStatus 直到 complete → 返回文件字节数
    // - addUri 报「文件已存在/任务已存在」：跳过下载（返回 skipped），仍登记
    function aria2Push(picked, options) {
        return aria2Rpc('aria2.addUri', ['token:' + cfg.aria2Secret, [picked.url], options])
            .then(function (gid) {
                log('⏳ aria2 开始下载: ' + (options.out || picked.url) + '（gid=' + gid + '），完成后自动登记 MediaCenter');
                return waitAria2Complete(gid).then(function (st) {
                    return { gid: gid, fileSize: parseInt(st.totalLength, 10) || 0 };
                });
            })
            .catch(function (e) {
                if (/already exists|is being downloaded/i.test(e.message || '')) {
                    return { skipped: true, fileSize: 0 };
                }
                throw e;
            });
    }

    // 登记 MediaCenter：查重（filePath）→ POST（409 按哈希查重命中则用 existingId）→ PUT 补全元数据
    function registerToMediaCenter(base, filePath, sourceMeta, info, fileSize) {
        return mcRequest(base + '/media?filePath=' + encodeURIComponent(filePath) + '&limit=1', { timeout: 20000 })
            .then(function (res) {
                var items = (res.body && res.body.items) || [];
                if (items.length) return { id: items[0].id, exists: true };
                return mcRequest(base + '/media', {
                    method: 'POST',
                    data: {
                        filePath: filePath,
                        mimeType: 'video/mp4',
                        fileSize: fileSize || 0,
                        sourceMeta: sourceMeta
                    },
                    timeout: 180000      // 服务端 ffprobe + 自动计算大文件哈希，给足时间
                }).then(function (r2) {
                    var id = r2.body && r2.body.id;
                    if (!id) throw new Error('MediaCenter 未返回媒体 id');
                    return { id: id, exists: false };
                });
            })
            .catch(function (e) {
                // 409 media.duplicateFile：服务端按 fileHash 查重命中 → 用 existingId 继续更新
                if (e.body && e.body.existingId) return { id: e.body.existingId, exists: true };
                throw e;
            })
            .then(function (r) {
                var data = {
                    title: info.title || undefined,
                    description: info.plot || '',
                    author: info.author || undefined,
                    tags: info.tags || [],
                    source: 'hanime1',
                    sourceMeta: sourceMeta
                };
                // 发布日期同时写入 createdAt 与 updatedAt（管理员可写），如 2026-08-24 → 2026-08-24T00:00:00.000Z
                if (info.date) {
                    data.createdAt = info.date + 'T00:00:00.000Z';
                    data.updatedAt = info.date + 'T00:00:00.000Z';
                }
                return mcRequest(base + '/media/' + r.id, {
                    method: 'PUT',
                    data: data
                }).then(function () {
                    return { id: r.id, title: info.title || '', exists: r.exists };
                });
            });
    }

    // 实验性：推 aria2 下载任务并等待完成 → 文件就绪后把本地路径 + 元数据登记到 MediaCenter
    // 前提：aria2 与 MediaCenter 在同一台机器（或共享存储）；「保存目录」须为 MediaCenter 可访问的服务器路径。
    // 注意：必须等下载完成后登记——批量任务多时若文件未就绪就 POST，服务端 ffprobe/哈希会超时，
    //       导致后续任务全部登记失败；等待后 fileSize 用 aria2 totalLength 补全。
    function downloadAndPushToMediaCenter(info, picked, target) {
        var base = (cfg.mediaCenterBase || '').replace(/\/+$/, '');
        if (!base) return Promise.reject(new Error('未配置 MediaCenter API 地址'));
        var options = buildAria2Options(target);
        if (!options.dir) return Promise.reject(new Error('MediaCenter 模式需要配置「保存目录」（aria2 下载到服务器路径）'));
        var filePath = options.dir.replace(/\/+$/, '') + '/' + target.filename;
        var payload = buildMcPayload(info, picked);
        var sourceMeta = JSON.stringify(payload);

        return aria2Push(picked, options)
            .then(function (dl) {
                if (dl.skipped) {
                    log('ℹ aria2 检测到文件已存在，跳过下载，仍登记 MediaCenter: ' + target.display);
                } else {
                    log('✓ aria2 下载完成: ' + target.display + '，登记 MediaCenter');
                }
                return registerToMediaCenter(base, filePath, sourceMeta, info, dl.fileSize);
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
        var qid = q.qid;
        log('开始获取作者全部视频: ' + q.userUrl);
        toast('正在获取作者视频列表…');
        function step() {
            var cur = loadQueue();
            if (queueStopFlag || !cur || cur.qid !== qid) return Promise.resolve([]);   // 用户停止/队列被替换：立即终止
            var url = q.userUrl + (q.userUrl.indexOf('?') > -1 ? '&' : '?') + 'page=' + q.page;
            return gmFetch(url).then(function (html) {
                var cur2 = loadQueue();
                if (queueStopFlag || !cur2 || cur2.qid !== qid) return [];   // 翻页间隙被停止/替换：丢弃本页
                var doc = new DOMParser().parseFromString(html, 'text/html');
                var videos = collectPageVideos(doc);
                var fresh = 0;
                videos.forEach(function (v) {
                    if (!q.seen[v.id]) { q.seen[v.id] = 1; q.items.push(v); fresh++; }
                });
                saveQueue(q);   // 每收集一页就落盘，导航中断也不丢
                log('作者第 ' + q.page + ' 页: ' + videos.length + ' 个视频' + (fresh < videos.length ? '（无新增，停止）' : ''));
                if (queueStopFlag || !loadQueue() || loadQueue().qid !== qid) return [];
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

    /* ================================================================
     *  浏览器直接下载（GM_xmlhttpRequest 取流 + <a download> 保存）
     *  目的：不再用 GM_download（会被 Chrome 标记「由以下扩展程序下载」、
     *  文件名可能被服务端 Content-Disposition 或 URL 编码弄成乱码），
     *  改为把二进制取回后用 <a download> 交给浏览器原生下载，文件名完全可控。
     * ================================================================ */

    var progressEl = null;

    // 日志面板底部固定一行进度，原地刷新（避免每 700ms 刷一行）
    function setProgressLine(text) {
        ensureLogPanel();
        if (!progressEl) {
            progressEl = document.createElement('div');
            progressEl.className = 'h1dl-log-line h1dl-prog';
        }
        if (progressEl.parentNode !== logBody) logBody.appendChild(progressEl);
        progressEl.textContent = '[' + new Date().toTimeString().slice(0, 8) + '] ' + text;
        logBody.scrollTop = logBody.scrollHeight;
        while (logBody.children.length > 200) logBody.removeChild(logBody.firstChild);
    }
    function clearProgressLine() {
        if (progressEl && progressEl.parentNode) progressEl.parentNode.removeChild(progressEl);
        progressEl = null;
    }
    function formatBytes(n) {
        n = Number(n) || 0;
        if (n <= 0) return '0 B';
        var units = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0, v = n;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return (i === 0 ? v : v.toFixed(1)) + ' ' + units[i];
    }

    // 用 <a download> 保存 Blob：走浏览器原生下载（下载记录显示来源页面，文件名按 name 原样保存）
    function saveBlobAsFile(blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // 浏览器接管大文件需要时间，延迟释放，避免下载被中途取消
        setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
    }

    // 浏览器直接下载：GM_xmlhttpRequest 取回二进制（onprogress 显示真实进度）→ <a download> 保存。
    function browserDownload(picked, target) {
        return new Promise(function (resolve) {
            var lastTick = 0;
            setProgressLine('⬇ 浏览器下载 ' + target.filename + ' — 连接中…');
            GM_xmlhttpRequest({
                method: 'GET',
                url: picked.url,
                headers: { 'Referer': SITE + '/', 'User-Agent': UA },
                responseType: 'blob',
                timeout: 0,          // 大视频不设超时
                onprogress: function (p) {
                    var now = Date.now();
                    if (now - lastTick < 700) return;
                    lastTick = now;
                    var pct = p && p.total ? Math.round(p.loaded * 100 / p.total) : null;
                    setProgressLine('⬇ ' + target.filename + ' — ' +
                        (pct != null
                            ? pct + '%（' + formatBytes(p.loaded) + ' / ' + formatBytes(p.total) + '）'
                            : formatBytes(p && p.loaded)));
                },
                onload: function (res) {
                    clearProgressLine();
                    if (!res || res.status < 200 || res.status >= 400) {
                        resolve({ ok: false, error: 'HTTP ' + (res ? res.status : '?') });
                        return;
                    }
                    var blob = res.response;
                    if (!(blob instanceof Blob)) {
                        if (!blob) { resolve({ ok: false, error: '响应为空' }); return; }
                        blob = new Blob([blob], { type: 'video/mp4' });
                    }
                    try {
                        saveBlobAsFile(blob, target.filename);
                        resolve({ ok: true, size: blob.size });
                    } catch (e) {
                        resolve({ ok: false, error: e.message || String(e) });
                    }
                },
                onerror: function (e) {
                    clearProgressLine();
                    resolve({ ok: false, error: (e && e.error) || '网络错误' });
                },
                ontimeout: function () { clearProgressLine(); resolve({ ok: false, error: '下载超时' }); },
                onabort: function () { clearProgressLine(); resolve({ ok: false, error: '已取消' }); }
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

    // 构建 aria2 addUri 选项（普通下载与「下载后登记 MediaCenter」共用）
    function buildAria2Options(target) {
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
        // 重命名模板中的 / 或 \ 会拼入保存目录（aria2 自动创建不存在的目录）。
        // 拼接时跟随保存目录的写法：Windows 反斜杠路径用 \，Linux 用 /。
        var dir = cfg.aria2Dir ? cfg.aria2Dir.replace(/[\/\\]+$/, '') : '';
        if (dir && target.subDir) dir = joinPath(dir, target.subDir);
        else if (!dir && target.subDir) dir = target.subDir;
        if (dir) options.dir = dir;
        if (cfg.proxy) options['all-proxy'] = cfg.proxy;   // http:// 或 socks5:// 均支持
        return options;
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
        // 浏览器模式不能创建子目录：模板里的目录降级成文件名前缀（NFO/封面 zip 同步扁平）
        if (cfg.mode === 'browser') target = flattenTarget(target);

        // 元数据（NFO + 封面 + 横幅）统一收集：批量模式等队列结束一次性导出 zip，
        // 手动下载单个视频时立即导出（否则收集完永远没有下载入口）
        function afterMeta() {
            return collectMetaForZip(info, target).then(function () {
                return index == null ? exportMetaZip() : null;
            }).then(function () { return true; });
        }

        // 实验性：MediaCenter 登记模式 —— aria2 下载到服务器路径，完成后自动登记（配合 aria2 使用）
        if (cfg.mediaCenter) {
            return downloadAndPushToMediaCenter(info, picked, target).then(function (r) {
                log('✓ 已下载并登记 MediaCenter: ' + (r.title || target.display) + ' (' + picked.quality + ', id=' + r.id + (r.exists ? '，记录已存在，仅更新元数据' : '') + ')', 'ok');
                statPushed();
                return true;
            }).catch(function (e) {
                log('✗ MediaCenter 登记失败 ' + target.display + ' — ' + e.message, true);
                statFailed();
                return false;
            });
        }

        if (cfg.mode === 'aria2') {
            var options = buildAria2Options(target);

            return aria2Rpc('aria2.addUri', ['token:' + cfg.aria2Secret, [picked.url], options]).then(function () {
                log('✓ 已推送至 aria2: ' + target.display + ' (' + picked.quality + ')', 'ok');
                statPushed();
                return afterMeta();
            }).catch(function (e) {
                log('✗ 推送失败 ' + target.display + ' — ' + e.message, true);
                statFailed();
                return false;
            });
        }

        // 浏览器直接下载：取二进制后由浏览器原生下载，文件名完全可控且带进度
        return browserDownload(picked, target).then(function (r) {
            if (!r.ok) {
                log('✗ 浏览器下载失败(' + target.filename + '): ' + r.error + '，建议改用 aria2 模式', true);
                statFailed();
                return false;
            }
            log('✓ 下载完成: ' + target.filename + '（' + formatBytes(r.size) + '）', 'ok');
            statPushed();
            return afterMeta();
        });
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
    var collectRunning = '';   // 正在运行的收集链 qid（'' = 无）：防止同队列双链并发写

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
        queueStopFlag = false;
        saveQueue({
            phase: 'push',
            qid: 'q' + Date.now() + '-' + Math.floor(Math.random() * 1e6),  // 队列唯一标识：防止旧 worker 把结果写进被替换的新队列
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
        var qid = q.qid;                    // 本次运行的队列标识：识别队列是否已被新批次替换
        queueRunning = true;
        queueStopFlag = false;
        expandLogPanel();

        var remaining = q.items.length - queueDoneCount(q);
        log('==== 批量任务' + (resumed ? '（跨页恢复，剩余 ' + remaining + ' 个）' : '开始，共 ' + q.items.length + ' 个视频') +
            (cfg.throttle ? '（限速: 任务间隔 ' + cfg.throttleSec + 's）' : '') + ' ====');
        if (cfg.mode === 'browser') {
            log('ℹ 浏览器模式：保存到浏览器默认下载目录，不支持子目录' +
                (/[\/\\]/.test(cfg.renameTpl || '') ? '，模板里的目录会平铺成「目录 - 文件名」' : '') +
                '；NFO/封面 zip 与视频同名同层');
        }
        renderStats();

        // 认领第一个未完成且未被其他 worker 认领的任务，返回下标；-1 = 无
        function claim() {
            var qq = loadQueue();
            if (!qq || qq.qid !== qid) return -1;   // 队列已被新批次替换：停止认领
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
            if (!qq || qq.qid !== qid) return;
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
            if (!qq || qq.qid !== qid || queueFinished(qq)) return Promise.resolve();
            var i = claim();
            if (i < 0) return Promise.resolve();
            var item = qq.items[i];
            return processItem(item, i).then(function (ok) {
                var q2 = loadQueue();
                if (!q2 || q2.qid !== qid) return;   // 队列已被新批次替换：丢弃本次结果，避免污染新队列
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

        // 浏览器模式串行：GM_xmlhttpRequest 会把整个文件放内存，并发大文件容易爆内存；
        // 单条进度行也才有意义。
        var maxConcurrency = cfg.mode === 'browser' ? 1 : INFO_CONCURRENCY;
        var n = cfg.throttle ? 1 : Math.min(maxConcurrency, remaining);
        var workers = [];
        for (var k = 0; k < n; k++) workers.push(worker());
        Promise.all(workers).then(function () {
            queueRunning = false;
            finishIfNeeded();
            var qn = loadQueue();
            if (queueStopFlag && qn && qn.qid === qid) {
                log('==== 批量队列已停止（进度已保留，可通过菜单「继续批量任务」恢复）====', true);
            }
            // 停止/运行期间用户启动了新批次：startBatch 的 runQueue 当时因 queueRunning 被跳过，这里接力启动
            if (qn && qn.phase === 'push' && qn.qid !== qid && !qn.stopped && !queueFinished(qn)) {
                log('==== 检测到新的批量任务，自动开始 ====', true);
                runQueue(true);
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
            // 注意：不在此清 doing——在途 worker 仍在处理认领中的任务，
            // 清了会导致这些任务被二次认领；跨页恢复时 resumeQueue/autoResume 会统一清理
            saveQueue(q);
            log('停止请求已发出，正在结束当前任务…', true);
        } else {
            // collect / collectList：标记停止（不删队列，翻页循环检查标志后自然退出）
            q.stopped = true;
            saveQueue(q);
            log('停止请求已发出，正在结束当前页收集…', true);
        }
    }

    // 彻底清空队列（删除持久化进度，与「停止」保留进度不同；日志面板/菜单触发）
    function clearQueueTask() {
        var q = loadQueue();
        if (!q) { toast('当前没有待处理的批量任务'); return; }
        if (!confirm('确定清空批量队列？将删除全部收集/推送进度，且无法恢复。')) return;
        queueStopFlag = true;      // 让在途 worker/收集链收尾，不再认领新任务
        collectRunning = '';
        clearQueue();
        log('==== 批量队列已清空 ====', true);
        toast('批量队列已清空');
    }

    // 恢复（菜单/日志面板触发）
    function resumeQueue() {
        var q = loadQueue();
        if (!q) { toast('当前没有待处理的任务'); return; }
        if (q.phase === 'push') {
            q.stopped = false;
            if (!queueRunning) q.doing = {};   // 仅当无在途 worker（跨页恢复）时才清认领标记，避免在途任务被二次认领
            saveQueue(q);
            queueStopFlag = false;   // 立即解除停止标志：若旧 worker 仍在收尾，让它们继续而非停住
            runQueue(true);
        } else if (q.phase === 'collect') {
            q.stopped = false;
            queueStopFlag = false;
            q.page = q.page || 1;
            saveQueue(q);
            continueAuthorCollect();
        } else if (q.phase === 'collectList') {
            q.stopped = false;
            queueStopFlag = false;
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
            if (q.stopped) {
                log('检测到已暂停的作者列表收集（已收集 ' + (q.items || []).length + ' 个，第 ' + (q.page || 1) + ' 页），可通过菜单「继续批量任务」恢复', true);
            } else {
                log('检测到未完成的作者列表收集（已收集 ' + (q.items || []).length + ' 个，第 ' + (q.page || 1) + ' 页），自动继续…', true);
                continueAuthorCollect();
            }
        } else if (q.phase === 'collectList') {
            if (q.stopped) {
                log('检测到已暂停的系列列表收集（已收集 ' + (q.items || []).length + ' 个，第 ' + (q.page || 1) + ' 页），可通过菜单「继续批量任务」恢复', true);
            } else {
                log('检测到未完成的系列列表收集（已收集 ' + (q.items || []).length + ' 个，第 ' + (q.page || 1) + ' 页），自动继续…', true);
                continueListCollect();
            }
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
            '  <span><span class="h1dl-log-stop">停止</span> · <span class="h1dl-log-clearq">清空队列</span> · <span class="h1dl-log-zip">导出zip</span> · <span class="h1dl-log-clear">清空日志</span> · <span class="h1dl-log-toggle">收起</span></span>' +
            '</div>' +
            '<div class="h1dl-log-body"></div>';
        document.body.appendChild(logPanel);
        logBody = logPanel.querySelector('.h1dl-log-body');
        logPanel.querySelector('.h1dl-log-toggle').addEventListener('click', function () {
            var collapsed = logPanel.classList.toggle('h1dl-collapsed');
            this.textContent = collapsed ? '展开' : '收起';
        });
        logPanel.querySelector('.h1dl-log-stop').addEventListener('click', stopQueue);
        logPanel.querySelector('.h1dl-log-clearq').addEventListener('click', clearQueueTask);
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
            '      <option value="aria2">aria2 RPC（推荐，支持代理/多线程/子目录）</option>',
            '      <option value="browser">浏览器直接下载（无需 aria2，单线程）</option>',
            '    </select>',
            '  </label>',
            '  <div id="h1dl-aria2-block">',
            '    <label class="h1dl-row">aria2 RPC 地址<input id="h1dl-rpc" placeholder="http://127.0.0.1:6800/jsonrpc"></label>',
            '    <label class="h1dl-row">aria2 RPC 密钥<input type="password" id="h1dl-secret" placeholder="留空表示无密钥"></label>',
            '    <label class="h1dl-row">保存目录<input id="h1dl-dir" placeholder="留空 = aria2 默认目录，如 D:\\hanime"></label>',
            '    <label class="h1dl-row">代理（传给 aria2）<input id="h1dl-proxy" placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"></label>',
            '  </div>',
            '  <div id="h1dl-browser-hint" class="h1dl-hint" style="display:none">浏览器模式：文件保存到<b>浏览器默认下载目录</b>，不支持子目录（重命名规则里的 / 与 \\ 也只会生成单层文件名，重命名规则照常生效）；NFO/封面 zip 与视频同名同层。需要目录结构请切回 aria2 模式。</div>',
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
            '  <div id="h1dl-tpl-block">',
            '    <label class="h1dl-row">重命名规则<input id="h1dl-tpl"></label>',
            '    <div class="h1dl-hint">默认随下载方式：aria2 为 <b>{author}/{title} [{quality}]</b>（自动建作者子目录），浏览器为 <b>{title} [{quality}]</b>（仅单层文件名）。留空即用默认。<br>占位符：{title} 标题 · {author} 作者 · {id} 视频ID · {quality} 画质 · {date} 日期 · {index} 序号；用 <b>/</b> 或 <b>\\</b> 分隔可自动创建子目录（仅 aria2 模式；浏览器模式写分隔符也只生成单层文件名）</div>',
            '  </div>',
            '  <label class="h1dl-row"><span class="h1dl-chk"><input type="checkbox" id="h1dl-meta"> 导出 NFO 与封面元数据（Beta）</span></label>',
            '  <div class="h1dl-hint">每个视频生成 <b>同名 .nfo</b>（标题/作者/标签/点赞/简介/日期）与 <b>-poster.jpg 封面</b>、<b>-banner.jpg 横幅</b>，统一打包进 zip，批量完成后自动下载，解压整目录拖入下载目录即可。</div>',
            '  <label class="h1dl-row"><span class="h1dl-chk"><input type="checkbox" id="h1dl-exp-show"> 显示实验性功能</span></label>',
            '  <div id="h1dl-exp-block">',
            '    <div class="h1dl-exp">实验性：MediaCenter 登记（配合 aria2）</div>',
            '    <label class="h1dl-row"><span class="h1dl-chk"><input type="checkbox" id="h1dl-mc"> aria2 下载完成后自动登记到 MediaCenter（浏览器下载不可用）</span></label>',
            '    <label class="h1dl-row">MediaCenter API 地址<input id="h1dl-mc-base" placeholder="http://127.0.0.1:3000/api"></label>',
            '    <label class="h1dl-row">API 令牌（MediaCenter 的 API_TOKEN）<input type="password" id="h1dl-mc-token" placeholder="静态服务令牌，留空无法通过鉴权"></label>',
            '    <div class="h1dl-hint">开启后流程：直链推给 <b>aria2</b> 下载（「保存目录」须为 MediaCenter 可访问的<b>服务器路径</b>，aria2 与 MediaCenter 需同机或共享存储）→ 下载完成后自动 <b>POST /media</b> 登记本地路径 + <b>PUT /media/:id</b> 补全标题/作者/标签/简介。</div>',
            '    <div class="h1dl-btns"><button id="h1dl-test-mc" class="h1dl-btn-ghost">测试 MediaCenter 连接</button></div>',
            '  </div>',
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
        overlay.querySelector('#h1dl-tpl').value = cfg.renameTpl || defaultRenameTpl(cfg.mode);
        overlay.querySelector('#h1dl-tpl').placeholder = defaultRenameTpl(cfg.mode);
        overlay.querySelector('#h1dl-meta').checked = !!cfg.exportMeta;
        overlay.querySelector('#h1dl-exp-show').checked = !!cfg.showExperimental;
        overlay.querySelector('#h1dl-mc').checked = !!cfg.mediaCenter;
        overlay.querySelector('#h1dl-mc-base').value = cfg.mediaCenterBase || DEFAULT_CONFIG.mediaCenterBase;
        overlay.querySelector('#h1dl-mc-token').value = cfg.mediaCenterToken || '';

        // 实验性总开关：关闭 = 整块隐藏（保存时还会强制 mediaCenter=false）
        function refreshExpState() {
            var show = overlay.querySelector('#h1dl-exp-show').checked;
            var block = overlay.querySelector('#h1dl-exp-block');
            if (block) block.style.display = show ? '' : 'none';
        }
        overlay.querySelector('#h1dl-exp-show').addEventListener('change', refreshExpState);
        refreshExpState();

        // 下载方式联动：浏览器模式与 aria2 无关的参数（RPC 地址/密钥、保存目录、代理、测试按钮）整体隐藏，
        // 并显示浏览器模式的目录/命名限制说明；重命名规则保留可改，但默认值与子目录行为随模式变化。
        var lastMode = overlay.querySelector('#h1dl-mode').value;   // 用于判断模板是否还是上一模式的默认值
        function refreshModeState() {
            var mode = overlay.querySelector('#h1dl-mode').value;
            var browser = mode === 'browser';
            var aria2Block = overlay.querySelector('#h1dl-aria2-block');
            if (aria2Block) aria2Block.style.display = browser ? 'none' : '';
            var browserHint = overlay.querySelector('#h1dl-browser-hint');
            if (browserHint) browserHint.style.display = browser ? '' : 'none';
            var testBtn = overlay.querySelector('#h1dl-test');
            if (testBtn) testBtn.style.display = browser ? 'none' : '';
            // 重命名规则默认值随下载方式切换：仅在用户没自定义（空，或仍是上一模式默认）时替换
            var tpl = overlay.querySelector('#h1dl-tpl');
            if (tpl) {
                tpl.placeholder = defaultRenameTpl(mode);
                var cur = tpl.value.trim();
                if (!cur || cur === defaultRenameTpl(lastMode)) tpl.value = defaultRenameTpl(mode);
            }
            lastMode = mode;
        }
        overlay.querySelector('#h1dl-mode').addEventListener('change', refreshModeState);
        refreshModeState();

        // 实验性模式下 aria2 控件保持可用（下载要靠 aria2），测试按钮各自独立：
        // 「测试 aria2 连接」始终测 aria2，「测试 MediaCenter 连接」测 MediaCenter

        overlay.querySelector('#h1dl-cancel').addEventListener('click', function () { overlay.remove(); });

        overlay.querySelector('#h1dl-test').addEventListener('click', function () {
            // 用输入框当前值测试 aria2，不落盘
            var rpcUrl = overlay.querySelector('#h1dl-rpc').value.trim() || DEFAULT_CONFIG.aria2Rpc;
            var secret = overlay.querySelector('#h1dl-secret').value.trim();
            aria2Rpc('aria2.getVersion', ['token:' + secret], rpcUrl)
                .then(function (v) { toast('aria2 连接成功，版本: ' + v.version); })
                .catch(function (e) { toast('aria2 连接失败: ' + e.message); });
        });

        overlay.querySelector('#h1dl-test-mc').addEventListener('click', function () {
            // 用输入框当前值测试 MediaCenter，不落盘
            var mcBase = overlay.querySelector('#h1dl-mc-base').value.trim() || DEFAULT_CONFIG.mediaCenterBase;
            var mcToken = overlay.querySelector('#h1dl-mc-token').value.trim();
            testMediaCenter(mcBase, mcToken)
                .then(function () { toast('MediaCenter 连接成功'); })
                .catch(function (e) { toast('MediaCenter 连接失败: ' + e.message); });
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
            var tplVal = overlay.querySelector('#h1dl-tpl').value.trim();
            // 与当前模式默认值一致时存空：以后切换下载方式，模板仍自动跟随默认
            cfg.renameTpl = (tplVal && tplVal !== defaultRenameTpl(cfg.mode)) ? tplVal : '';
            cfg.exportMeta = overlay.querySelector('#h1dl-meta').checked;
            cfg.showExperimental = overlay.querySelector('#h1dl-exp-show').checked;
            // 隐藏实验性区块时强制关闭 MediaCenter 登记，避免「看不见却仍在生效」
            cfg.mediaCenter = overlay.querySelector('#h1dl-mc').checked && cfg.showExperimental;
            // MediaCenter 登记模式依赖 aria2 下载，强制下载方式为 aria2
            if (cfg.mediaCenter) cfg.mode = 'aria2';
            cfg.mediaCenterBase = overlay.querySelector('#h1dl-mc-base').value.trim() || DEFAULT_CONFIG.mediaCenterBase;
            cfg.mediaCenterToken = overlay.querySelector('#h1dl-mc-token').value.trim();
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
        queueStopFlag = false;
        saveQueue({
            phase: 'collect',
            qid: 'c' + Date.now() + '-' + Math.floor(Math.random() * 1e6),  // 队列唯一标识：旧收集链检测到队列被替换即中止
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
        if (q.stopped) { clearQueue(); log('已取消作者列表收集', true); return; }
        // 同队列已在收集 → 跳过；若 running 是别的 qid，说明队列已被新收集替换，
        // 旧链会在 step() 的 qid 检测处自行中止，这里照常启动新链
        if (collectRunning === q.qid) return;
        collectRunning = q.qid;
        fetchAuthorVideos().then(function (items) {
            if (collectRunning === q.qid) collectRunning = '';
            var cur = loadQueue();
            if (!cur) return;                      // 队列已被清除
            if (cur.qid !== q.qid) return;         // 队列已被新收集/新任务替换：本链失效，静默退出，不碰新队列
            if (queueStopFlag) { clearQueue(); log('已取消作者列表收集', true); return; }
            if (!items.length) { clearQueue(); toast('未找到该作者的公开视频'); return; }
            if (!confirm('该作者共 ' + items.length + ' 个视频，全部加入下载队列？')) {
                clearQueue();
                return;
            }
            startBatch(items);
        }).catch(function (e) {
            if (collectRunning === q.qid) collectRunning = '';
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
        queueStopFlag = false;
        saveQueue({ phase: 'collectList', qid: 'l' + Date.now() + '-' + Math.floor(Math.random() * 1e6), base: base, page: 1, seen: {}, items: [] });
        continueListCollect();
    }

    // 执行/续传「系列视频收集」队列（翻页收集整个 playlist）
    function continueListCollect() {
        var q = loadQueue();
        if (!q || q.phase !== 'collectList') return;
        if (q.stopped) { clearQueue(); log('已取消系列列表收集', true); return; }
        if (collectRunning === q.qid) return;   // 同队列已在收集 → 跳过（新队列会由旧链 qid 检测放行）
        var qid = q.qid;
        collectRunning = q.qid;
        log('开始获取系列全部视频: ' + q.base);
        toast('正在获取系列视频列表…');
        function step() {
            var cur = loadQueue();
            if (queueStopFlag || !cur || cur.qid !== qid) return Promise.resolve([]);   // 用户停止/队列被替换：立即终止
            var url = q.base + '&page=' + q.page;
            return gmFetch(url).then(function (html) {
                var cur2 = loadQueue();
                if (queueStopFlag || !cur2 || cur2.qid !== qid) return [];   // 翻页间隙被停止/替换：丢弃本页
                var doc = new DOMParser().parseFromString(html, 'text/html');
                var videos = collectPageVideos(doc);
                var fresh = 0;
                videos.forEach(function (v) {
                    if (!q.seen[v.id]) { q.seen[v.id] = 1; q.items.push(v); fresh++; }
                });
                saveQueue(q);
                log('系列第 ' + q.page + ' 页: ' + videos.length + ' 个视频' + (fresh < videos.length ? '（无新增，停止）' : ''));
                if (queueStopFlag || !loadQueue() || loadQueue().qid !== qid) return [];
                if (fresh === 0 || videos.length === 0 || q.page >= MAX_AUTHOR_PAGES) return q.items;
                q.page++;
                var next = step();
                return cfg.throttle ? delay(cfg.throttleSec * 1000).then(function () { return next; }) : next;
            });
        }
        step().then(function (items) {
            if (collectRunning === qid) collectRunning = '';
            var cur = loadQueue();
            if (!cur) return;                      // 队列已被清除
            if (cur.qid !== qid) return;           // 队列已被新收集/新任务替换：本链失效，静默退出，不碰新队列
            if (queueStopFlag) { clearQueue(); log('已取消系列列表收集', true); return; }
            if (!items.length) { clearQueue(); toast('该系列没有可下载的视频'); return; }
            if (!confirm('该系列共 ' + items.length + ' 个视频，全部加入下载队列？')) { clearQueue(); return; }
            startBatch(items);
        }).catch(function (e) {
            if (collectRunning === qid) collectRunning = '';
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

            '#h1dl-log{position:fixed;left:16px;bottom:16px;z-index:99998;width:480px;max-height:320px;background:rgba(15,15,22,.94);border:1px solid rgba(255,255,255,.15);border-radius:10px;overflow:hidden;font-size:12px;box-shadow:0 4px 20px rgba(0,0,0,.5);}',
            '#h1dl-log .h1dl-log-head{padding:6px 10px;color:#ff7b9c;font-weight:bold;display:flex;justify-content:space-between;align-items:center;background:rgba(255,255,255,.04);}',
            '#h1dl-log .h1dl-log-head b.h1dl-stat-ok{color:#7bffa0;}',
            '#h1dl-log .h1dl-log-head b.h1dl-stat-err{color:#ff7b7b;}',
            '#h1dl-log .h1dl-log-clear,#h1dl-log .h1dl-log-toggle{cursor:pointer;color:#888;font-weight:normal;}',
            '#h1dl-log .h1dl-log-stop{cursor:pointer;color:#ff9b7b;font-weight:normal;}',
            '#h1dl-log .h1dl-log-stop:hover{color:#ff7b5b;}',
            '#h1dl-log .h1dl-log-clearq{cursor:pointer;color:#ffb84d;font-weight:normal;}',
            '#h1dl-log .h1dl-log-clearq:hover{color:#ffd27a;}',
            '#h1dl-log .h1dl-log-zip{cursor:pointer;color:#7bffa0;font-weight:normal;}',
            '#h1dl-log .h1dl-log-zip:hover{color:#a0ffc0;}',
            '#h1dl-log .h1dl-log-clear:hover,#h1dl-log .h1dl-log-toggle:hover{color:#ccc;}',
            '#h1dl-log .h1dl-log-body{max-height:260px;overflow-y:auto;padding:6px 10px;color:#888;line-height:1.6;}',
            '#h1dl-log .h1dl-log-line{word-break:break-all;}',
            '#h1dl-log .h1dl-log-line.h1dl-prog{color:#ffd27a;}',
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
            '#h1dl-settings .h1dl-exp{margin:2px 0 10px;padding-top:12px;border-top:1px dashed #555;color:#ff9b7b;font-size:12px;font-weight:bold;}',
            '#h1dl-settings input:disabled,#h1dl-settings select:disabled{opacity:.45;cursor:not-allowed;}',
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
        GM_registerMenuCommand('清空批量队列（删除全部进度）', clearQueueTask);

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
