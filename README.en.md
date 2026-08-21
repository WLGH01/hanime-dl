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

## FAQ

- **aria2 connection failed**: ensure aria2c is running and the URL/secret are correct (default port 6800)
- **No sub-directory**: `{author}/{title}` ≡ `{author} / {title}`; browser mode doesn't support sub-directories — use aria2
- **Pushes stopped after navigating**: the queue auto-resumes across pages; if manually stopped, resume via the Tampermonkey menu
- **Worried about rate limiting**: enable push throttling with a 5–10s interval

---

## License

[LICENSE](./LICENSE)
