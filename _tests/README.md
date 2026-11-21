# 测试

本地回归测试，不依赖 hanime1 账号，不会真的下载视频（savedir 测试用本机临时 HTTP 源 + 本机 aria2）。

## 1. 保存目录（Windows 路径）端到端

用脚本里真实的 `buildFileTarget` / `buildAria2Options` 生成选项，推给本机 aria2 RPC，再校验落盘路径。

```powershell
$env:ARIA2C = "C:\path\to\aria2c.exe"
node .\_tests\test-savedir.js
```

覆盖：反斜杠/正斜杠目录、尾部 `\`、模板用 `/` 或 `\` 分层、中文作者子目录、`[1080p]` 后缀、
非法字符净化、多级子目录、目录不存在自动创建、保存目录留空、超长标题（260 路径上限）、浏览器模式扁平化。

## 2. 元数据导出回归（「暂无已收集的元数据」）

```powershell
node .\_tests\test-meta-export.js
```

把脚本里的 `downloadOne()` 抽出来用桩函数驱动，断言：关闭「导出元数据」时，单视频下载不再调用
`exportMetaZip()`（旧版会误报），批量项不在此处导出。可用 `$env:SRC_FILE` 指向旧版本验证测试能抓到 bug。

## 3. 手机视口 UI（Playwright）

```powershell
node .\_tests\server.js     # http://127.0.0.1:8123/
```

- `/`：列表页（勾选框、右侧工具栏点击展开/收起）
- `/watch?v=1001`：播放页（「下载当前视频」走 aria2 推送；`window.__toasts` 记录 toast 文本）

页面内已有 `GM_*` 桩；Playwright 用 390×844 视口即可模拟手机。
