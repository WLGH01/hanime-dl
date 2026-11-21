// 回归测试：单视频下载（「下载当前视频」，index == null）不应在关闭「导出元数据」时
// 调用 exportMetaZip（旧版会误报「暂无已收集的元数据」）；批量模式（index != null）不在此处导出。
// 做法：把脚本里真实的 downloadOne() 抽出来，用桩函数驱动，断言导出/收集调用次数。
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(process.env.SRC_FILE || path.join(__dirname, '..', 'hanime1-batch-downloader.user.js'), 'utf8');
const start = SRC.indexOf('function downloadOne(info, index) {');
const end = SRC.indexOf('// 抓取单个视频信息并推送下载');
if (start < 0 || end < 0) throw new Error('downloadOne 抽取失败');
const fnCode = SRC.slice(start, end);

function makeRunner(opts) {
    const calls = { export: 0, collect: 0, log: [], toast: [] };
    const cfg = { mode: 'aria2', exportMeta: !!opts.exportMeta, mediaCenter: false, aria2Secret: '' };
    const metaCollector = { count: () => opts.collected || 0 };

    const factory = new Function(
        'cfg', 'log', 'statPushed', 'statFailed', 'toast', 'pickSource', 'buildFileTarget',
        'flattenTarget', 'buildAria2Options', 'aria2Rpc', 'collectMetaForZip', 'exportMetaZip',
        'downloadAndPushToMediaCenter', 'browserDownload', 'metaCollector',
        fnCode + '\nreturn downloadOne;'
    );
    const downloadOne = factory(
        cfg,
        (m) => calls.log.push(m),
        () => {},
        () => {},
        (m) => calls.toast.push(m),
        () => ({ quality: '1080p', url: 'https://vdownload.hembed.com/x-1080p.mp4?secure=1' }),
        () => ({ subDir: '', filename: 't.mp4', display: 't.mp4' }),
        (t) => t,
        () => ({}),
        () => Promise.resolve('gid'),
        () => { calls.collect++; return Promise.resolve(); },
        () => { calls.export++; return Promise.resolve(true); },
        () => Promise.resolve({ id: 1 }),
        () => Promise.resolve({ ok: true, size: 1 }),
        metaCollector
    );
    return { downloadOne, calls };
}

const info = { title: 't', author: 'a', sources: { '1080p': 'u' } };
const cases = [
    { name: '单视频 + 关闭导出元数据 → 不打包、不提示', exportMeta: false, index: null, collected: 0, expectExport: 0, expectCollect: 0 },
    { name: '批量项 + 关闭导出元数据 → 不打包', exportMeta: false, index: 3, collected: 0, expectExport: 0, expectCollect: 0 },
    { name: '单视频 + 开启导出但无数据 → 不打包（防御）', exportMeta: true, index: null, collected: 0, expectExport: 0, expectCollect: 1 },
    { name: '单视频 + 开启导出且有数据 → 立即打包', exportMeta: true, index: null, collected: 2, expectExport: 1, expectCollect: 1 },
    { name: '批量项 + 开启导出 → 不在此处打包（等队列结束）', exportMeta: true, index: 3, collected: 2, expectExport: 0, expectCollect: 1 },
];

(async () => {
    let pass = 0;
    for (const c of cases) {
        const { downloadOne, calls } = makeRunner(c);
        const ok = await downloadOne(info, c.index);
        const good = ok === true && calls.export === c.expectExport && calls.collect === c.expectCollect && calls.toast.length === 0;
        if (good) pass++;
        console.log((good ? 'PASS  ' : 'FAIL  ') + c.name +
            `  export=${calls.export}/${c.expectExport} collect=${calls.collect}/${c.expectCollect} toast=${JSON.stringify(calls.toast)}`);
    }
    console.log('\n==== 结果 ' + pass + '/' + cases.length + ' 通过 ====');
    process.exit(pass === cases.length ? 0 : 1);
})();
