# hanime1.me Batch Downloader

> [中文 README](./README.md) · A Tampermonkey userscript for batch downloading videos from [hanime1.me](https://hanime1.me/). Supports aria2 RPC (HTTP/SOCKS proxy), per-author full download, custom rename rules with auto sub-directories, push throttling, and a persistent task queue that resumes across page navigation.

Userscript: `hanime1-batch-downloader.user.js` (v1.2.0)

---

## Features

| Feature | Description |
|---|---|
| Download current video | Download panel on the video page with quality selector (480p/720p/1080p) |
| Batch check | Checkbox on every video card on any listing page (home/search/tag/playlist) |
| Select all on page | Right-edge toolbar: Select All / Deselect / Download checked (hover the red rail to reveal) |
| Download current author | Collects the author's **full** upload list via the `/user/{id}/uploaded` page with auto-pagination (not limited by the 60-item sidebar) |
| aria2 RPC support | Multi-connection download, resume support, secret auth, connection test |
| HTTP / SOCKS proxy | Proxy passed to aria2's `all-proxy`; both `http://` and `socks5://` supported |
| Custom rename rule | Placeholders `{title}` `{author}` `{id}` `{quality}` `{date}` `{index}`; a `/` in the template creates sub-directories |
| Push throttling | Optional: serial push with configurable interval to avoid rate limiting (off by default) |
| **Persistent queue / cross-page resume** | Progress saved in real time; navigating away or going back **does not stop the queue** — it auto-resumes on any hanime1 page |
| Browser fallback | Single-thread `GM_download` mode without aria2 (no sub-directories) |

---

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Tampermonkey → Dashboard → Utilities → *Import from file* and choose `hanime1-batch-downloader.user.js`; or create a new script and paste the full content.
3. Open https://hanime1.me/ — a **red vertical rail labeled 下载工具** appears at the right edge of the screen when it works; hover it to open the panel.

---

## aria2 Quick Start (Recommended)

The script only parses videos and pushes download tasks; the actual downloading is done by aria2 (multi-thread, proxy, resume).

**Start aria2 with RPC (Windows):**

```
aria2c --enable-rpc --rpc-listen-all=false --rpc-secret YOUR_SECRET --dir D:\hanime -c
```

**Script settings (⚙ 设置 at bottom-right):**

- Download mode: `aria2 RPC`
- RPC URL: `http://127.0.0.1:6800/jsonrpc`
- RPC secret: must match your `--rpc-secret` (leave empty if none)
- Save dir: leave empty to use aria2's default, or set e.g. `D:\hanime`
- Proxy: `http://127.0.0.1:7890` or `socks5://127.0.0.1:1080`
- Click **测试 aria2 连接** (Test connection) to verify.

---

## Rename Rules & Sub-directories

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

| Placeholder | Meaning |
|---|---|
| `{title}` | Video title |
| `{author}` | Author name |
| `{id}` | Video ID (the `v=` number in the URL) |
| `{quality}` | Quality, e.g. 1080p |
| `{date}` | Publish date, e.g. 2026-08-21 |
| `{index}` | Batch index, zero-padded from 001 |

- Only the `/` you **explicitly** write in the template creates directories; `/` inside titles/author names is replaced with spaces to avoid unexpected nesting.
- Illegal filename characters `\/:*?"<>|` are replaced with spaces.

---

## Push Throttling (Anti Rate-Limit)

A **推送限速** toggle in settings, **off by default**:

- When ON: batch tasks are processed **strictly one-by-one** (fetch video page → push to aria2), waiting the configured interval between tasks; the author-list pagination also waits.
- When OFF: original behavior (3 concurrent fetch+push), fastest.
- Recommended: enable it with a 5–10s interval for large batches (tens of videos).

---

## Persistent Queue & Cross-Page Resume (v1.2.0)

**Problem:** previously the batch loop ran inside the current page's JS context — clicking a link or going back destroyed the page and stopped the pushes.

**Now:**

- Every task's progress (including author-list pagination) is **written to GM storage in real time**; page destruction loses nothing.
- Opening **any** hanime1.me page auto-resumes the unfinished queue from where it stopped — an interrupted task is retried, without missing or duplicating any video.
- The log panel header shows the **global queue progress** (e.g. `队列 37/92`), still accurate across pages.
- To pause: click **停止队列** (Stop queue) in the log panel, or the Tampermonkey menu *停止批量任务（保留进度）*. It will **not** auto-resume after a manual stop.
- To resume: Tampermonkey menu *继续批量任务（恢复中断的队列）*.
- Note: resuming only runs on hanime1.me pages — if the whole tab leaves the site, the queue suspends and resumes when you return to any page on the site.

---

## Usage by Page

**Listing pages (home/search/tag/playlist)**
- A checkbox appears at the top-left of every video cover; the toolbar rail badge shows the checked count.
- **下载勾选(N)** → script visits each video page, resolves the highest-quality direct link, and pushes to aria2 (or browser download).

**Video page**
- Below the player: quality selector + **⬇ 下载当前视频** + **👤 批量下载当前作者** + **⚙ 设置**.
- 批量下载当前作者 locates the author's **upload page** (`/user/{id}/uploaded` — the full list corresponding to the right-sidebar videos) and auto-paginates to collect **all** videos (not limited by the 60-item sidebar), then queues them after confirmation.

**Author page (/user/xxx)**
- Top of page: **批量下载当前作者全部视频** / **下载本页视频**.
- The full download also uses the upload page to collect everything (the home page only shows the latest 12).

**Log panel**
- Bottom-left **下载日志**. Header shows **队列 N/M · 已推送 N · 失败 N** and a **停止队列** button.
- **Green bold line `✓ 已推送至 aria2: Author/File (1080p)`** = successfully pushed to aria2.
- Red lines = failures and reasons; grey lines = progress info.
- 清空 (Clear) resets the log and stats.

---

## Technical Notes

- The site embeds direct MP4 links on `vdownload.hembed.com` (with a `secure` token) directly in the video page. Verified: no cookie needed, CORS fully open, Range supported — aria2 can download with multiple connections; requires `Referer: https://hanime1.me/` (auto-added by the script).
- Unthrottled batch mode fetches video pages in the background via `GM_xmlhttpRequest` with concurrency 3, not occupying the current tab; throttled mode switches to serial + interval.
- Sub-directories: aria2's `dir` = save dir + template directory part (e.g. `D:\hanime/AuthorA`), `out` = the plain filename; aria2 creates missing dirs.
- Some videos may only have 720p/480p; the script auto-degrades to the highest available.
- Paywalled/member-only videos without a direct link show "未检测到视频源".

---

## FAQ

- **aria2 connection failed**: confirm aria2c is running and the RPC URL/secret are correct (default port 6800).
- **Proxy not working**: the proxy only applies to aria2 download tasks; the script's own parsing goes through the browser network.
- **Some videos fail in a batch**: check the bottom-left log for the reason (deleted/no source/timeout); failures don't affect the rest.
- **No sub-directory created**: `/` with or without spaces are equivalent (`{author}/{title}` ≡ `{author} / {title}`); browser mode doesn't support sub-directories — use aria2 mode.
- **Worried about rate limiting**: enable 推送限速 with a 5–10s interval.
- **Pushes stopped after navigating**: since v1.2.0 the queue auto-resumes across pages; if the whole tab left the site, reopen any hanime1 page to continue; if you previously hit 停止队列, resume via the Tampermonkey menu *继续批量任务*.

---

## License

[LICENSE](./LICENSE)
