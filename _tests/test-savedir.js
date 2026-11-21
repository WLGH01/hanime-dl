// 保存目录（Windows 路径）端到端测试：
// 直接复用脚本里的 buildFileTarget / buildAria2Options，把生成的 aria2 选项原样发给本机 aria2 RPC，
// 再用真实下载结果验证文件落盘位置（含中文作者子目录、方括号文件名、非法字符净化、正反斜杠写法）。
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'hanime1-batch-downloader.user.js');
const SRC = fs.readFileSync(SCRIPT, 'utf8');

function cut(from, to) {
    const a = SRC.indexOf(from);
    const b = SRC.indexOf(to);
    if (a < 0 || b < 0 || b <= a) throw new Error('extract failed: ' + from);
    return SRC.slice(a, b);
}

const consts = cut('var RENAME_TPL_DEFAULT', 'var cfg = loadCfg();');
const nameFns = cut('function cleanSegment', 'function pad3(');
const optFn = cut('function buildAria2Options', 'function downloadOne(');

const cfg = {};
const SITE = 'https://hanime1.me';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const api = new Function('cfg', 'SITE', 'UA', `
${consts}
${nameFns}
${optFn}
return { cleanSegment, joinPath, buildFileTarget, flattenTarget, buildAria2Options, defaultRenameTpl };
`)(cfg, SITE, UA);

const ARIA2 = process.env.ARIA2C || 'aria2c';
const PORT = 16800;
const SECRET = 'tok';

/* ---------------- 本机 HTTP 源文件服务器 ---------------- */
const PAYLOAD = Buffer.alloc(1024 * 256, 7);
const server = http.createServer((req, res) => {
    res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': PAYLOAD.length,
        'Accept-Ranges': 'none',
    });
    res.end(PAYLOAD);
});

function rpc(method, params) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 't' + Date.now(), method, params });
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: '/jsonrpc', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
            let d = '';
            res.on('data', (c) => d += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    j.error ? reject(new Error('aria2: ' + j.error.message)) : resolve(j.result);
                } catch (e) { reject(new Error('bad rpc response: ' + d)); }
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitComplete(gid, timeout = 30000) {
    const end = Date.now() + timeout;
    for (;;) {
        const st = await rpc('aria2.tellStatus', ['token:' + SECRET, gid]);
        if (st.status === 'complete') return st;
        if (st.status === 'error' || st.status === 'removed') {
            throw new Error('aria2 失败: ' + (st.errorMessage || st.status) + ' code=' + st.errorCode);
        }
        if (Date.now() > end) throw new Error('等待超时');
        await sleep(300);
    }
}

function exists(p) { try { return fs.existsSync(p) ? fs.statSync(p) : null; } catch (e) { return null; } }

/* ---------------- 测试用例 ---------------- */
const ROOT = path.join(__dirname, 'out');
const cases = [];

function caseDef(name, { dir, tpl, title, author, quality, mode, expectRel, browser, note }) {
    cases.push({ name, dir, tpl, title, author, quality: quality || '1080p', mode: mode || 'aria2', expectRel, browser: !!browser, note });
}

const BS = ROOT;                                   // D:\...\_savedir_test\out
const FS = ROOT.replace(/\\/g, '/');

caseDef('反斜杠目录 + 默认模板(作者子目录)', {
    dir: BS, tpl: '', title: '标题', author: '作者A',
    expectRel: path.join('作者A', '标题 [1080p].mp4'),
});
caseDef('目录带尾部反斜杠', {
    dir: BS + '\\', tpl: '', title: '标题', author: '作者B',
    expectRel: path.join('作者B', '标题 [1080p].mp4'),
});
caseDef('正斜杠目录', {
    dir: FS, tpl: '', title: '标题', author: '作者C',
    expectRel: path.join('作者C', '标题 [1080p].mp4'),
});
caseDef('模板用反斜杠分层', {
    dir: BS, tpl: '{author}\\{title} [{quality}]', title: '标题', author: '作者D',
    expectRel: path.join('作者D', '标题 [1080p].mp4'),
});
caseDef('模板带空格分层 "{author} / {title}"', {
    dir: BS, tpl: '{author} / {title} [{quality}]', title: '标题', author: '作者E',
    expectRel: path.join('作者E', '标题 [1080p].mp4'),
});
caseDef('标题含 Windows 非法字符', {
    dir: BS, tpl: '', title: '第1話: 「テスト」?*<>|"', author: '作者F',
    expectRel: path.join('作者F', '第1話 「テスト」 [1080p].mp4'),
});
caseDef('多级子目录 + {date} + {index}', {
    dir: BS, tpl: '{author}/{date}/{index} - {title}', title: '标题', author: '作者G',
    expectRel: path.join('作者G', '2026-08-21', '001 - 标题.mp4'),
});
caseDef('目录不存在（含空格，多层）→ aria2 自动创建', {
    dir: path.join(ROOT, '深 层', '新建目录'), tpl: '', title: '标题', author: '作者I',
    expectRel: path.join('作者I', '标题 [1080p].mp4'),
});
caseDef('保存目录留空（相对子目录，落 aria2 默认目录）', {
    dir: '', tpl: '', title: '标题', author: '作者J',
    expectRel: path.join('作者J', '标题 [1080p].mp4'),
});
// 标题超长时整段文件名被 cleanSegment 截到 150 字符（[1080p] 会被截掉），按脚本真实行为算期望值
// 注意 buildFileTarget 对每段还做了一次 .trim()，所以末尾的残留空格会被去掉
const LONG_TITLE = 'あ'.repeat(149) + ' [1080p]';
caseDef('超长标题（150 字符）→ 测 Windows 260 路径上限', {
    dir: BS, tpl: '', title: 'あ'.repeat(149), author: '作者K',
    expectRel: path.join('作者K', api.cleanSegment(LONG_TITLE).trim() + '.mp4'),
});
caseDef('浏览器模式扁平化（只校验文件名，不产生下载）', {
    dir: BS, tpl: '', title: '标题', author: '作者H', browser: true,
    expectRel: '作者H - 标题 [1080p].mp4',
});

const defaultDir = path.join(__dirname, 'aria2-default');

(async () => {
    let aria2;
    const results = [];
    try {
        fs.rmSync(ROOT, { recursive: true, force: true });
        fs.rmSync(defaultDir, { recursive: true, force: true });
        fs.mkdirSync(ROOT, { recursive: true });

        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const srcPort = server.address().port;

        const logFile = path.join(__dirname, 'aria2.log');
        fs.mkdirSync(defaultDir, { recursive: true });
        aria2 = spawn(ARIA2, [
            '--enable-rpc', '--rpc-listen-all=false', '--rpc-listen-port=' + PORT,
            '--rpc-secret=' + SECRET, '--rpc-allow-origin-all=true',
            '--dir=' + defaultDir, '--file-allocation=none', '--log-level=warn',
            '--log=' + logFile, '--continue=true', '--quiet=true',
            '--max-concurrent-downloads=1', '--retry-wait=1', '--max-tries=1',
        ], { stdio: 'ignore', windowsHide: true, cwd: defaultDir });

        let up = false;
        for (let i = 0; i < 60 && !up; i++) {
            try { await rpc('aria2.getVersion', ['token:' + SECRET]); up = true; }
            catch (e) { await sleep(250); }
        }
        if (!up) throw new Error('aria2 RPC 未就绪');

        for (const c of cases) {
            const got = { name: c.name };
            try {
                Object.assign(cfg, {
                    mode: c.mode, renameTpl: c.tpl,
                    aria2Dir: c.dir, proxy: '', overwrite: true,
                });
                const info = { title: c.title, author: c.author, quality: c.quality, date: '2026-08-21', id: '12345' };
                let target = api.buildFileTarget(info, 0);
                if (c.browser) target = api.flattenTarget(target);
                const options = c.browser ? null : api.buildAria2Options(target);
                got.options = options;
                got.target = target;

                const subParts = target.subDir ? target.subDir.split('/') : [];
                const expectPath = c.dir
                    ? path.join(c.dir, c.expectRel)
                    : path.join(defaultDir, ...subParts, target.filename);

                if (c.browser) {
                    got.expectPath = expectPath;
                    got.ok = target.subDir === '' && target.filename === c.expectRel;
                } else {
                    const url = `http://127.0.0.1:${srcPort}/vdownload/12345-${c.quality}.mp4?secure=abc&x=1`;
                    const gid = await rpc('aria2.addUri', ['token:' + SECRET, [url], options]);
                    const st = await waitComplete(gid);
                    const rawPath = st.files && st.files[0] && st.files[0].path;
                    // aria2 对相对 dir 回报相对路径，按进程 cwd(defaultDir) 解析
                    const absPath = rawPath ? (path.isAbsolute(rawPath) ? rawPath : path.resolve(defaultDir, rawPath)) : '';
                    got.path = absPath;
                    got.reported = rawPath;
                    got.expectPath = expectPath;
                    const statGot = exists(absPath);
                    const expectNorm = path.resolve(expectPath).toLowerCase();
                    const gotNorm = absPath ? path.resolve(absPath).toLowerCase() : '';
                    got.size = statGot ? statGot.size : 0;
                    const mcPath = options.dir ? options.dir.replace(/\/+$/, '') + '/' + target.filename : '';
                    got.mcPathWritable = mcPath ? !!fs.existsSync(mcPath) : null;
                    got.ok = gotNorm === expectNorm;
                    got.ok = got.ok && got.size === PAYLOAD.length;
                }
            } catch (e) {
                got.ok = false;
                got.error = e.message;
            }
            results.push(got);
            console.log(JSON.stringify(got));
        }
    } finally {
        try { aria2 && aria2.kill(); } catch (e) {}
        server.close();
    }

    const pass = results.filter((r) => r.ok).length;
    console.log('\n==== 结果 ' + pass + '/' + results.length + ' 通过 ====');
    for (const r of results) {
        console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name +
            (r.ok ? '' : '  => ' + (r.error || ('期望 ' + r.expectPath + ' 实际 ' + r.path))));
    }
    // 清理下载产物，保持仓库干净
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(defaultDir, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(path.join(__dirname, 'aria2.log'), { force: true }); } catch (e) {}
    process.exit(pass === results.length ? 0 : 1);
})();
