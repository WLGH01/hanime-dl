# hanime1.me Batch Downloader

## [中文](./README.md) | English

> A Tampermonkey userscript for batch downloading videos from [hanime1.me](https://hanime1.me/) (v1.3.0). Supports aria2 RPC, full author/series download, custom rename rules, cross-page resume, and Kodi/Emby/Jellyfin/Plex-compatible NFO metadata export.

---

## Features

| Feature | Description |
|---|---|
| Download current video | Quality selector (480p/720p/1080p) on the video page |
| Batch check | Checkbox on every card across home / search / tag / hentai·short-anime genre / series pages |
| Select all / deselect | Right-edge toolbar buttons (hover the red rail to reveal) |
| Download current author | Auto-paginates the author's full uploads (not limited to the 60-item sidebar) |
| Series download | Download an entire series from hentai/short-anime playlist pages |
| aria2 RPC | Multi-connection, resume, secret auth, http/socks proxy, connection test |
| Rename rules | Placeholders + `/` auto-creating sub-directories |
| Cross-page resume | Progress persisted in real time; navigation doesn't interrupt |
| Metadata export | Kodi-compatible NFO + vertical poster + horizontal banner, bundled as zip |
| Push throttling | Serial push with interval to avoid rate limiting |

---

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/)
2. Import `hanime1-batch-downloader.user.js` (Dashboard → Utilities → Import from file; or paste into a new script)
3. Open https://hanime1.me/ — a red "Download Tool" rail appears at the right edge; hover it to open the panel

---

## Interface Overview

The script injects the following UI elements on different pages:

| # | Element | Location | Appearance & interaction |
|---|---|---|---|
| ① | **Right-edge toolbar** | All listing pages, middle of right edge | A red rail (vertical "Download Tool"), flush against the edge; hover to reveal a panel with "Select All / Deselect / Download checked (N) / ⚙ Settings"; a small badge on top shows the checked count |
| ② | **Checkbox** | Top-left of each video cover | Semi-transparent rounded square; click to check, highlights pink when checked |
| ③ | **Video page panel** | Video page, below the player | Horizontal row: quality dropdown + "⬇ Download current video" + "👤 Download current author" + "⚙ Settings" |
| ④ | **Batch buttons** | Top of author / series pages | Primary "⬇ Download all / entire series" + secondary "Download this page" + "⚙ Settings" |
| ⑤ | **Log panel** | Bottom-left (during batch tasks) | Header shows `queue N/M · pushed N · failed N`; green = success, red = failure, grey = progress; includes "Stop queue / Export zip / Clear / Collapse" |
| ⑥ | **Settings dialog** | Opened by any "⚙ Settings" | Centered modal with download mode, aria2 RPC URL/secret, save dir, proxy, quality, rename rule, push throttling, metadata export (see below) |

> Color scheme: primary buttons/highlights are pink (`#e04a6f`), success logs are green, failure logs are red — coordinated with the site's dark theme.

---

## Usage by Page

**Listing pages (home / search / tag / genre / series)**
- A checkbox appears at the top-left of each card; the rail badge shows the checked count
- "Select all" checks the whole page; "Download checked (N)" visits each video page and pushes downloads

**Video page**
- Below the player: quality selector + "Download current video" + "Download current author" + "Settings"
- "Download current author" locates the author's upload page, paginates to collect all videos, then queues them after confirmation

**Author page (/user/xxx)**
- Top buttons: "Download all videos by the current author" / "Download this page's videos"

**Log panel** (bottom-left)
- Header shows `queue N/M · pushed N · failed N`; green lines = pushed successfully
- "Stop queue" pauses (keeps progress), "Export zip" manually exports metadata, "Clear" resets

---

## Settings (⚙)

| Setting | Description |
|---|---|
| Download mode | `aria2 RPC` (recommended) or `browser` (single-thread, no sub-directories) |
| aria2 RPC URL | Default `http://127.0.0.1:6800/jsonrpc` |
| RPC secret | Must match aria2's `--rpc-secret` (leave empty if none) |
| Save dir | aria2 download root (empty = aria2 default) |
| Proxy | Passed to aria2's `all-proxy`; supports `http://` and `socks5://` |
| Preferred quality | auto / 1080p / 720p / 480p |
| Rename rule | See below |
| Push throttling | Serial push with interval to avoid rate limiting (off by default) |
| Task interval | Seconds between tasks when throttling |
| Export metadata | Generate NFO + poster + banner (Beta) |

---

## Rename Rules

Default template: `{author} - {title} [{quality}]`

**Placeholders:**

| Placeholder | Meaning |
|---|---|
| `{title}` | Video title |
| `{author}` | Author name |
| `{id}` | Video ID |
| `{quality}` | Quality, e.g. 1080p |
| `{date}` | Publish date, e.g. 2026-08-21 |
| `{index}` | Batch index (from 001) |

A `/` in the template creates sub-directories, e.g.:

```
{author} / {title} [{quality}]
```

→ produces `D:\hanime\AuthorA\Title [1080p].mp4`

- Only the `/` you **explicitly** write creates directories; `/` inside titles/author names is replaced with spaces
- Illegal filename characters `\/:*?"<>|` are replaced with spaces
- Multi-level is supported, e.g. `{author}/{date}/{index} {title}`

---

## Metadata Export (Beta)

On by default. After a batch finishes, a **metadata zip** is downloaded automatically, containing for each video:

| File | Content |
|---|---|
| `Title [1080p].nfo` | Kodi/XBMC `<movie>`: title, year, premiere date, plot, author, tags, like percentage (mapped to a 0–10 `<rating>`) |
| `Title [1080p]-poster.jpg` | Vertical poster (`image/cover/{id}.jpg`) |
| `Title [1080p]-banner.jpg` | Horizontal banner (`image/thumbnail/{id}h.jpg`) |

The zip mirrors the **rename-rule directory structure** (e.g. `AuthorA/Title [1080p].nfo`), so unzip and drop the whole tree into your media library folder for automatic alignment. The log panel also has an "Export zip" button for manual export.

> NFO, poster, and banner are **all bundled into the zip** — not pushed separately to aria2 (avoiding duplicate downloads).

**NFO format compatibility**: the generated `.nfo` uses the Kodi/XBMC standard format, natively recognized by:

- **Kodi** (native format)
- **Emby** (native support)
- **Jellyfin** (native support)
- **Plex** (requires the "Plex NFO Agent", Plex 1.43.1+; select the agent manually when creating the library)

The following media managers can also read/write this format for further editing:

- **TinyMediaManager (tmm)**
- **MediaElch**
- **Media Center Master**

> Tip: Plex's default scraper does not read NFO — select *Plex NFO Movie* under Settings → Manage → Libraries → Advanced → Agent.

---

## Security

The script has been reviewed and has **no high-risk vulnerabilities**. Key safety features and points to be aware of:

**✅ Safe by design**

| Aspect | Description |
|---|---|
| No remote code execution | No `eval` / `new Function` / dynamically loaded external scripts; site data cannot inject code |
| No credential leakage | Cross-origin requests use `GM_xmlhttpRequest` (no cookies), so your hanime1 session is never sent to third parties |
| Local-only config | Secret/proxy settings are stored via `GM_setValue` **in your own browser**; the source has no hardcoded secrets or personal paths (default secret is empty) |
| Filename sanitization | `\ / : * ? " < > |` and control characters in titles/author names are replaced, preventing path traversal |
| Controlled download sources | Video/image URLs only come from hanime1 or `vdownload.hembed.com` |

**⚠️ Points to be aware of**

| Item | Description |
|---|---|
| `@connect *` is broad | The metadata declares a wildcard `@connect`, though it only actually accesses hanime1, `vdownload.hembed.com`, and local aria2 (`127.0.0.1`). Kept for custom aria2 addresses; risk is minimal, but you can narrow it manually if concerned |
| aria2 secret stored in plaintext | The secret is stored in plaintext in browser local storage, readable only locally. If your machine is shared, consider using no secret or a dedicated token |
| Self-hosted aria2 | The script only parses and pushes tasks; downloading is done by your own aria2 — nothing passes through a third-party server |

> Conclusion: normal risk level for a user-initiated download tool — safe to use.

---

## FAQ

- **aria2 connection failed**: ensure aria2c is running and the URL/secret are correct (default port 6800)
- **No sub-directory**: `{author}/{title}` ≡ `{author} / {title}`; browser mode doesn't support sub-directories — use aria2
- **Pushes stopped after navigating**: the queue auto-resumes across pages; if manually stopped, resume via the Tampermonkey menu
- **Worried about rate limiting**: enable push throttling with a 5–10s interval

---

## License

[LICENSE](./LICENSE)
