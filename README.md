# hanime1.me 批量下载工具

## 中文 | [English](./README.en.md)

> 用于 [hanime1.me](https://hanime1.me/) 视频批量下载的油猴脚本（v1.3.0）。支持 aria2 RPC、作者/系列全量下载、自定义重命名、跨页续传、Emby NFO 元数据导出。

---

## 功能

- 下载当前视频（可选画质 480p/720p/1080p）
- 列表页批量勾选 / 全选本页下载（含首页、搜索、标签、里番/泡面番 genre 页、系列列表页）
- 批量下载当前作者（自动翻页，不受 60 上限限制）
- 系列列表页（里番/泡面番 playlist）批量下载整个系列
- aria2 RPC：多线程、断点续传、密钥鉴权、http/socks 代理
- 重命名规则按 `/` 自动建子目录
- 任务队列持久化，切页/回退后自动续传
- 导出 Emby 兼容 NFO（作者/标签/点赞/简介/日期）+ 竖屏封面 + 横屏横幅
- 推送限速（防站点封锁）

---

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 导入 `hanime1-batch-downloader.user.js`（或新建脚本粘贴全部内容）
3. 打开 https://hanime1.me/ ，屏幕右缘出现红色「下载工具」竖条即成功，鼠标移上去弹出面板

---

## aria2 快速上手

```bash
aria2c --enable-rpc --rpc-listen-all=false --rpc-secret 你的密钥 --dir D:\hanime -c
```

脚本设置（⚙）：下载方式选 `aria2 RPC`，填 RPC 地址 `http://127.0.0.1:6800/jsonrpc`、密钥（与 `--rpc-secret` 一致）、保存目录、代理（可选），点「测试连接」验证。

---

## 重命名规则

默认 `{author} - {title} [{quality}]`。占位符：`{title}` `{author}` `{id}` `{quality}` `{date}` `{index}`。模板中写 `/` 即自动创建子目录，如 `{author} / {title} [{quality}]` → `D:\hanime\作者A\标题 [1080p].mp4`。

---

## 导出 NFO 元数据（Beta）

默认开启。批量任务完成后，脚本会自动打包一个**元数据 zip** 下载，内含每个视频的：

- `标题 [1080p].nfo` — 标题、年份、发布时间、简介、作者、标签、点赞百分比（换算十分制 `<rating>`）
- `标题 [1080p]-poster.jpg` — 竖屏封面
- `标题 [1080p]-banner.jpg` — 横屏横幅（里番/泡面番）

zip 内部**按重命名规则建目录**（如 `作者A/标题 [1080p].nfo`），解压后整个目录拖进 aria2/Emby 下载目录即可自动对齐、被 Emby 识别。日志面板也有「导出zip」按钮可随时手动导出。

> NFO、封面、横幅**全部打包进 zip** 统一导出（不再单独推 aria2，避免重复下载）。

---

## 常见问题

- **aria2 连接失败**：确认 aria2c 已启动、地址/密钥正确（端口默认 6800）
- **没有子目录**：`{author}/{title}` 与 `{author} / {title}` 等效；浏览器模式不支持子目录，请用 aria2
- **切页后推送停了**：队列会跨页自动续传；手动停止过则用油猴菜单「继续批量任务」恢复
- **担心被限制**：开启「推送限速」并设 5~10 秒间隔

---

## 许可

[LICENSE](./LICENSE)
