# hanime1.me Batch Downloader

## [中文](./README.md) | English

> A Tampermonkey userscript for batch downloading videos from [hanime1.me](https://hanime1.me/) (v1.3.0). Supports aria2 RPC, full author/series download, custom rename rules, cross-page resume, and Emby NFO metadata export.

---

## Features

- Download current video (quality 480p/720p/1080p)
- Batch check / select-all on listing pages (home, search, tag, hentai/short-anime genre, series)
- Download current author's full uploads (auto-paginated, not limited to 60)
- Download an entire series (hentai/short-anime playlist)
- aria2 RPC: multi-connection, resume, secret auth, http/socks proxy
- Rename rules with `/` auto-creating sub-directories
- Persistent task queue that resumes across page navigation
- Emby-compatible NFO (author/tags/likes/description/date) + vertical poster + horizontal banner
- Push throttling (anti rate-limit)

---

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/)
2. Import `hanime1-batch-downloader.user.js` (or paste the full content into a new script)
3. Open https://hanime1.me/ — a red "Download Tool" rail appears at the right edge; hover it to open the panel

---

## Rename Rules

Default: `{author} - {title} [{quality}]`. Placeholders: `{title}` `{author}` `{id}` `{quality}` `{date}` `{index}`. A `/` in the template creates sub-directories, e.g. `{author} / {title} [{quality}]` → `D:\hanime\AuthorA\Title [1080p].mp4`.

---

## NFO Metadata Export (Beta)

On by default. After a batch finishes, the script automatically downloads a **metadata zip** containing, for each video:

- `Title [1080p].nfo` — title, year, premiere date, plot, author, tags, like percentage (mapped to a 0–10 `<rating>`)
- `Title [1080p]-poster.jpg` — vertical poster
- `Title [1080p]-banner.jpg` — horizontal banner (hentai/short-anime)

The zip mirrors the **rename-rule directory structure** (e.g. `AuthorA/Title [1080p].nfo`), so you can unzip and drop the whole tree into your aria2/Emby download folder for automatic alignment and recognition. The log panel also has an "Export zip" button for manual export anytime.

> NFO, poster, and banner are **all bundled into the zip** for a single export (no longer pushed separately to aria2, avoiding duplicate downloads).

---

## FAQ

- **aria2 connection failed**: ensure aria2c is running and the URL/secret are correct (default port 6800)
- **No sub-directory**: `{author}/{title}` ≡ `{author} / {title}`; browser mode doesn't support sub-directories — use aria2
- **Pushes stopped after navigating**: the queue auto-resumes across pages; if manually stopped, resume via the Tampermonkey menu
- **Worried about rate limiting**: enable push throttling with a 5–10s interval

---

## License

[LICENSE](./LICENSE)
