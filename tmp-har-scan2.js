/* 第二轮：全 HAR 搜设备字段（头 + body + cookie） */
const fs = require('fs');

const HAR = 'C:\\Users\\Administrator\\.dsh\\attachments\\v1\\files\\4d\\4d255a4ddb9f19965c1a6277cd8bf4588b05ad892e4f8c7171ed0a4b30625cd6\\quantumult-x-2026-11-05-232532.har';
const OUT = 'D:\\脚本\\jd_surge\\har-report2.txt';
const lines = [];
const log = s => lines.push(s);

const har = JSON.parse(fs.readFileSync(HAR, 'utf8'));
const entries = har.log.entries || [];

const KEYS = ['x-api-eid-token', 'wg-sdk-token', 'uuid', 'd_brand', 'd_model', 'osversion', 'os_version', 'clientversion', 'client_version'];

// 1) 全局：任何域名、任何位置出现目标关键字
log('=== 全 HAR 关键字命中（任意域名 / 头 / body）===');
const hits = [];
for (const e of entries) {
    const host = (e.request.url.match(/^https?:\/\/([^/]+)/) || [])[1] || '?';
    const names = (e.request.headers || []).map(h => h.name.toLowerCase());
    const body = (e.request.postData && e.request.postData.text) || '';
    const cookieVal = ((e.request.headers || []).find(h => h.name.toLowerCase() === 'cookie') || {}).value || '';
    for (const k of KEYS) {
        const inHeader = names.includes(k);
        const inBody = body.toLowerCase().includes(k + '"') || body.toLowerCase().includes(k + '=') || body.toLowerCase().includes('"' + k + '"');
        const inCookie = cookieVal.toLowerCase().includes(k + '=');
        if (inHeader || inBody || inCookie) {
            hits.push(`${host} | ${e.request.method} | ${k} | header=${inHeader} body=${inBody} cookie=${inCookie}`);
        }
    }
}
log(hits.length ? hits.slice(0, 60).join('\n') : '(完全没有任何命中)');

// 2) 所有出现过的域名
log('');
log('=== 域名一览 ===');
const hosts = new Map();
for (const e of entries) {
    const h = (e.request.url.match(/^https?:\/\/([^/]+)/) || [])[1] || '?';
    hosts.set(h, (hosts.get(h) || 0) + 1);
}
[...hosts.entries()].sort((a, b) => b[1] - a[1]).forEach(([h, c]) => log(`  ${h}: ${c}`));

// 3) 设备指纹 cookie 的值
log('');
log('=== 关键 Cookie 值 ===');
const nameSet = new Set();
for (const e of entries) {
    const cv = ((e.request.headers || []).find(h => h.name.toLowerCase() === 'cookie') || {}).value || '';
    cv.split(';').forEach(p => {
        const idx = p.indexOf('=');
        if (idx < 0) return;
        const k = p.slice(0, idx).trim();
        const v = p.slice(idx + 1).trim();
        if (/3AB9D23F7A4B3C9B|whwswswws|unionwsws|__jda|pwdt_id|sdtoken|wskey|pt_pin/i.test(k) && !nameSet.has(k)) {
            nameSet.add(k);
            log(`  ${k} = ${v.length > 80 ? v.slice(0, 80) + `...(len=${v.length})` : v}`);
        }
    });
}

// 4) client.action 的 POST body 结构样本
log('');
log('=== client.action POST body 样本（截断 600 字符）===');
let shown = 0;
for (const e of entries) {
    if (!/client\.action/.test(e.request.url)) continue;
    if (e.request.method !== 'POST') continue;
    const b = (e.request.postData && e.request.postData.text) || '';
    if (!b) continue;
    log(`--- ${e.request.url.split('?')[0]} (len=${b.length})`);
    log('    ' + b.slice(0, 600).replace(/\n/g, ' '));
    if (++shown >= 6) break;
}

// 5) UA 里能解析出的字段
log('');
log('=== UA 关键字段提取 ===');
const uaSet = new Set();
for (const e of entries) {
    const h = (e.request.headers || []).find(x => x.name.toLowerCase() === 'user-agent');
    if (h) uaSet.add(String(h.value));
}
for (const ua of uaSet) {
    const os = /;os\/([^;]+)/.exec(ua);
    const build = /;build\/(\d+)/.exec(ua);
    const appBuild = /appBuild\/(\d+)/.exec(ua);
    const ver = /;version\/([\d.]+)/.exec(ua);
    const screen = /;screen\/([^;]+)/.exec(ua);
    log(`  UA[${ua.slice(0, 40)}...] os=${os ? os[1] : '-'} build=${build ? build[1] : '-'} appBuild=${appBuild ? appBuild[1] : '-'} version=${ver ? ver[1] : '-'} screen=${screen ? screen[1] : '-'}`);
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('WROTE ' + OUT);
