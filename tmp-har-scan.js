/* 临时分析：看 QX 导出的 HAR 里 api.m.jd.com/client.action 到底带了哪些头 */
const fs = require('fs');

const HAR = 'C:\\Users\\Administrator\\.dsh\\attachments\\v1\\files\\4d\\4d255a4ddb9f19965c1a6277cd8bf4588b05ad892e4f8c7171ed0a4b30625cd6\\quantumult-x-2026-11-05-232532.har';
const OUT = 'D:\\脚本\\jd_surge\\har-report.txt';

const TARGET = ['x-api-eid-token', 'wg-sdk-token', 'uuid', 'd_brand', 'd_model', 'osversion', 'os_version', 'build', 'clientversion', 'client_version', 'user-agent'];

const lines = [];
const log = s => lines.push(s);

const har = JSON.parse(fs.readFileSync(HAR, 'utf8'));
const entries = har.log.entries || [];
log(`总请求数: ${entries.length}`);

const jdEntries = entries.filter(e => /api\.m\.jd\.com/.test(e.request.url));
log(`api.m.jd.com 请求数: ${jdEntries.length}`);

const clientAction = jdEntries.filter(e => /client\.action/.test(e.request.url));
log(`client.action 请求数: ${clientAction.length}`);

// 所有出现过的请求头名（仅 api.m.jd.com）
const headerCount = new Map();
const cookieNames = new Set();
for (const e of jdEntries) {
    for (const h of (e.request.headers || [])) {
        const n = h.name.toLowerCase();
        headerCount.set(n, (headerCount.get(n) || 0) + 1);
        if (n === 'cookie') {
            String(h.value || '').split(';').forEach(part => {
                const k = part.split('=')[0].trim();
                if (k) cookieNames.add(k);
            });
        }
    }
}
log('');
log('=== api.m.jd.com 出现过的请求头（次数）===');
[...headerCount.entries()].sort((a, b) => b[1] - a[1]).forEach(([n, c]) => log(`  ${n}: ${c}`));
log('');
log('=== Cookie 里出现过的键 ===');
log('  ' + [...cookieNames].sort().join(', '));

// 每个 client.action 请求带没带关键头
log('');
log('=== client.action 请求明细（前 40 条）===');
const withEid = [];
clientAction.slice(0, 40).forEach((e, i) => {
    const names = (e.request.headers || []).map(h => h.name.toLowerCase());
    const has = f => (names.includes(f) ? 'Y' : '-');
    const url = e.request.url;
    const q = url.split('?')[1] || '';
    const fn = /functionId=([^&]+)/.exec(q);
    log(`[${i}] ${e.request.method} functionId=${fn ? fn[1] : '?'} | eid:${has('x-api-eid-token')} wg:${has('wg-sdk-token')} uuid:${has('uuid')} brand:${has('d_brand')} model:${has('d_model')} osV:${has('osversion')} build:${has('build')} cv:${has('clientversion')}`);
    log(`     头: ${names.join(',')}`);
});

// 全量统计：有多少 client.action 带 eid / wg
let nEid = 0, nWg = 0, nUuid = 0;
for (const e of clientAction) {
    const names = (e.request.headers || []).map(h => h.name.toLowerCase());
    if (names.includes('x-api-eid-token')) nEid++;
    if (names.includes('wg-sdk-token')) nWg++;
    if (names.includes('uuid')) nUuid++;
}
log('');
log(`=== 汇总：client.action 中 带eid=${nEid} 带wg=${nWg} 带uuid=${nUuid} / 共 ${clientAction.length} ===`);

// 找一个带 eid 的完整样本，打印所有头名 + 值长度（不打印值本身，除 UUID 类短值）
const sample = clientAction.find(e => (e.request.headers || []).some(h => h.name.toLowerCase() === 'x-api-eid-token'));
if (sample) {
    log('');
    log('=== 带 eid 的样本完整头（值只显示长度/前12字符）===');
    for (const h of sample.request.headers) {
        const v = String(h.value || '');
        const brief = ['uuid', 'd_brand', 'd_model', 'osversion', 'build', 'clientversion', 'user-agent'].includes(h.name.toLowerCase())
            ? v.slice(0, 160)
            : `len=${v.length} head=${v.slice(0, 12)}`;
        log(`  ${h.name}: ${brief}`);
    }
} else {
    log('');
    log('!!! 没有任何 client.action 请求带 x-api-eid-token');
}

// UA 样本
const uaSet = new Set();
for (const e of jdEntries) {
    const h = (e.request.headers || []).find(x => x.name.toLowerCase() === 'user-agent');
    if (h) uaSet.add(String(h.value));
}
log('');
log('=== 不同 User-Agent ===');
[...uaSet].forEach(u => log('  ' + u));

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('WROTE ' + OUT + ' lines=' + lines.length);
