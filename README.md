# hanime1.me Batch Downloader / 批量下载工具

> A Tampermonkey userscript for batch downloading videos from [hanime1.me](https://hanime1.me/). Supports aria2 RPC (HTTP/SOCKS proxy), per-author full download, custom rename rules with auto sub-directories, push throttling, and a persistent task queue that resumes across page navigation.
>
> 用于 [hanime1.me](https://hanime1.me/) 视频批量下载的油猴脚本。支持 aria2 RPC（http/socks 代理）、当前作者全量下载、自定义重命名规则并自动建子目录、推送限速，以及跨页面自动续传的持久化任务队列。

Userscript: `hanime1-batch-downloader.user.js` (v1.2.0)

---

## Features / 功能总览

| Feature 功能 | Description 说明 |
|---|---|
| Download current video 下载当前视频 | Download panel on the video page with quality selector (480p/720p/1080p) 播放页出现下载面板，可选画质 |
| Batch check 视频批量勾选 | Checkbox on every video card on any listing page (home/search/tag/playlist) 列表页每个视频卡片左上角出现勾选框 |
| Select all on page 批量勾选本页 | Right-edge toolbar: Select All / Deselect / Download checked (hover the red rail to reveal) 右侧贴边工具栏 |
| Download current author 批量下载当前作者 | Collects the author's **full** upload list via the `/user/{id}/uploaded` page with auto-pagination (not limited by the 60-item sidebar) 自动翻页收集作者全部视频 |
| aria2 RPC support | Multi-connection download, resume support, secret auth, connection test 多线程、断点续传、密钥鉴权、可测试连接 |
| HTTP / SOCKS proxy | Proxy passed to aria2's `all-proxy`; both `http://` and `socks5://` supported 同时支持 http 与 socks 代理 |
| Custom rename rule 自定义重命名 | Placeholders `{title}` `{author}` `{id}` `{quality}` `{date}` `{index}`; a `/` in the template creates sub-directories 模板中写 `/` 自动创建子目录 |
| Push throttling 推送限速 | Optional: serial push with configurable interval to avoid rate limiting (off by default) 防止请求过快被站点限制 |
| **Persistent queue / cross-page resume 队列跨页续传** | Progress saved in real time; navigating away or going back **does not stop the queue** — it auto-resumes on any hanime1 page 点链接/回退不中断，自动续传 |
| Browser fallback 浏览器直接下载 | Single-thread `GM_download` mode without aria2 (no sub-directories) 备用模式 |

---

## Installation / 安装

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser. 浏览器安装 Tampermonkey（篡改猴）。
2. Tampermonkey → Dashboard → Utilities → *Import from file* and choose `hanime1-batch-downloader.user.js`; or create a new script and paste the full content. 管理面板 → 实用工具 → 导入文件，或新建脚本粘贴全部内容。
3. Open https://hanime1.me/ — a **red vertical rail labeled 下载工具** appears at the right edge of the screen when it works; hover it to open the panel. 屏幕右缘出现红色竖条即安装成功，鼠标移上去弹出工具面板。

---

## aria2 Quick Start (Recommended) / aria2 快速上手（推荐）

The script only parses videos and pushes download tasks; the actual downloading is done by aria2 (multi-thread, proxy, resume).

**Start aria2 with RPC (Windows):** 启动 aria2（带 RPC）：

```
aria2c --enable-rpc --rpc-listen-all=false --rpc-secret YOUR_SECRET --dir D:\hanime -c
```

**Script settings (右下角 ⚙ 设置):**

- Download mode 下载方式: `aria2 RPC`
- RPC URL: `http://127.0.0.1:6800/jsonrpc`
- RPC secret 密钥: must match your `--rpc-secret` (leave empty if none)
- Save dir 保存目录: leave empty to use aria2's default, or set e.g. `D:\hanime`
- Proxy 代理: `http://127.0.0.1:7890` or `socks5://127.0.0.1:1080`
- Click **测试 aria2 连接** (Test connection) to verify.

---

## Rename Rules & Sub-directories / 重命名规则与子目录

Default template: `{author} - {title} [{quality}]` (all files in one folder)

**Per-author folders:** put a `/` in the template, e.g.:

```
{author} / {title} [{quality}]
```

Result (assuming save dir `D:\hanime`):

```
D:\hanime\AuthorA\Title [1080p].mp4
D:\hanime\AuthorB\Title [1080p].mp4
```

Multi-level is supported, e.g. `{author}/{date}/{index} {title}` → `D:\hanime\AuthorA\2026-08-21\005 Title.mp4`. aria2 auto-creates missing directories.

| Placeholder 占位符 | Meaning 含义 |
|---|---|
| `{title}` | Video title 视频标题 |
| `{author}` | Author name 作者名 |
| `{id}` | Video ID (the `v=` number in the URL) 视频 ID |
| `{quality}` | Quality, e.g. 1080p 画质 |
| `{date}` | Publish date, e.g. 2026-08-21 发布日期 |
| `{index}` | Batch index, zero-padded from 001 序号 |

- Only the `/` you **explicitly** write in the template creates directories; `/` inside titles/author names is replaced with spaces to avoid unexpected nesting. 只有模板中显式写的 `/` 才会建目录；标题/作者名里的 `/` 会被替换为空格。
- Illegal filename characters `\/:*?"<>|` are replaced with spaces. 非法字符自动替换为空格。

---

## Push Throttling (Anti Rate-Limit) / 推送限速（防封锁）

A **推送限速** toggle in settings, **off by default**:

- When ON: batch tasks are processed **strictly one-by-one** (fetch video page → push to aria2), waiting the configured interval between tasks; the author-list pagination also waits. 逐个串行 + 间隔。
- When OFF: original behavior (3 concurrent fetch+push), fastest. 保持并发，速度最快。
- Recommended: enable it with a 5–10s interval for large batches (tens of videos). 大批量建议开启，间隔 5~10 秒。

---

## Persistent Queue & Cross-Page Resume / 任务队列跨页续传（v1.2.0）

**Problem 痛点:** previously the batch loop ran inside the current page's JS context — clicking a link or going back destroyed the page and stopped the pushes.

**Now 现在:**

- Every task's progress (including author-list pagination) is **written to GM storage in real time**; page destruction loses nothing. 每个任务进度实时写入油猴存储。
- Opening **any** hanime1.me page auto-resumes the unfinished queue from where it stopped — an interrupted task is retried, without missing or duplicating any video. 打开任意页面自动续传，被中断的任务会重试。
- The log panel header shows the **global queue progress** (e.g. `队列 37/92`), still accurate across pages. 日志面板显示全局队列进度。
- To pause: click **停止队列** (Stop queue) in the log panel, or the Tampermonkey menu *停止批量任务（保留进度）*. It will **not** auto-resume after a manual stop. 手动停止后不会自动恢复。
- To resume: Tampermonkey menu *继续批量任务（恢复中断的队列）*. 用菜单手动恢复。
- Note: resuming only runs on hanime1.me pages — if the whole tab leaves the site, the queue suspends and resumes when you return to any page on the site. 续传仅在 hanime1.me 页面上进行。

---

## Usage by Page / 各页面操作

**Listing pages (home/search/tag/playlist) 列表页**
- A checkbox appears at the top-left of every video cover; the toolbar rail badge shows the checked count. 每个封面左上角有勾选框。
- **下载勾选(N)** → script visits each video page, resolves the highest-quality direct link, and pushes to aria2 (or browser download). 逐个解析直链并推送。

**Video page 视频播放页**
- Below the player: quality selector + **⬇ 下载当前视频** + **👤 批量下载当前作者** + **⚙ 设置**.
- 批量下载当前作者 locates the author's **upload page** (`/user/{id}/uploaded` — the full list corresponding to the right-sidebar videos) and auto-paginates to collect **all** videos (not limited by the 60-item sidebar), then queues them after confirmation. 自动走作品专页收集全量视频。

**Author page 作者主页 (/user/xxx)**
- Top of page: **批量下载当前作者全部视频** / **下载本页视频**.
- The full download also uses the upload page to collect everything (the home page only shows the latest 12). 主页本身只显示最近 12 个，完整列表走作品专页。

**Log panel 日志面板**
- Bottom-left **下载日志**. Header shows **队列 N/M · 已推送 N · 失败 N** and a **停止队列** button.
- **Green bold line `✓ 已推送至 aria2: Author/File (1080p)`** = successfully pushed to aria2. 绿色加粗行 = 已成功推送给 aria2。
- Red lines = failures and reasons; grey lines = progress info. 红色行 = 失败；灰色行 = 过程信息。
- 清空 (Clear) resets the log and stats.

---

## Technical Notes / 技术说明

- The site embeds direct MP4 links on `vdownload.hembed.com` (with a `secure` token) directly in the video page. Verified: no cookie needed, CORS fully open, Range supported — aria2 can download with multiple connections; requires `Referer: https://hanime1.me/` (auto-added by the script). 站点内嵌 MP4 直链，无需 cookie、CORS 全开、支持 Range。
- Unthrottled batch mode fetches video pages in the background via `GM_xmlhttpRequest` with concurrency 3, not occupying the current tab; throttled mode switches to serial + interval. 不限速并发 3，不占用标签页。
- Sub-directories: aria2's `dir` = save dir + template directory part (e.g. `D:\hanime/AuthorA`), `out` = the plain filename; aria2 creates missing dirs. 子目录由 dir 参数实现。
- Some videos may only have 720p/480p; the script auto-degrades to the highest available. 按最高可用自动降级。
- Paywalled/member-only videos without a direct link show "未检测到视频源". 付费/会员视频无直链会提示。

---

## FAQ / 常见问题

- **aria2 connection failed / aria2 连接失败**: confirm aria2c is running and the RPC URL/secret are correct (default port 6800). 确认 aria2c 已启动且地址/密钥正确。
- **Proxy not working / 代理不生效**: the proxy only applies to aria2 download tasks; the script's own parsing goes through the browser network. 代理只作用于 aria2 下载任务。
- **Some videos fail in a batch / 批量任务部分失败**: check the bottom-left log for the reason (deleted/no source/timeout); failures don't affect the rest. 展开日志查看原因，失败不影响其余。
- **No sub-directory created / 没有生成子目录**: `/` with or without spaces are equivalent (`{author}/{title}` ≡ `{author} / {title}`); browser mode doesn't support sub-directories — use aria2 mode. 浏览器模式不支持子目录，请用 aria2 模式。
- **Worried about rate limiting / 担心被站点限制**: enable 推送限速 with a 5–10s interval. 开启限速并设 5~10 秒间隔。
- **Pushes stopped after navigating / 切页/回退后推送停了?**: since v1.2.0 the queue auto-resumes across pages; if the whole tab left the site, reopen any hanime1 page to continue; if you previously hit 停止队列, resume via the Tampermonkey menu *继续批量任务*. v1.2.0 起跨页自动续传；手动停止过则用菜单恢复。

---

## License / 许可

[LICENSE](./LICENSE)
