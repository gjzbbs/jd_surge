/* 第三轮：枚举 client.action POST body 里的所有参数名 + 样本值 */
const fs = require('fs');

const HAR = 'C:\\Users\\Administrator\\.dsh\\attachments\\v1\\files\\4d\\4d255a4ddb9f19965c1a6277cd8bf4588b05ad892e4f8c7171ed0a4b30625cd6\\quantumult-x-2026-11-05-232532.har';
const OUT = 'D:\\脚本\\jd_surge\\har-report3.txt';
const lines = [];
const log = s => lines.push(s);

const har = JSON.parse(fs.readFileSync(HAR, 'utf8'));
const entries = (har.log.entries || []).filter(e => /client\.action/.test(e.request.url) && e.request.method === 'POST');

const params = new Map(); // name -> {count, samples:Set, plain, cipher}
let bodyCount = 0;

for (const e of entries) {
    const t = (e.request.postData && e.request.postData.text) || '';
    if (!t) continue;
    bodyCount++;
    // query string 形式
    if (!t.includes('=')) continue;
    for (const part of t.split('&')) {
        const idx = part.indexOf('=');
        if (idx < 0) continue;
        const k = part.slice(0, idx);
        const v = part.slice(idx + 1);
        if (!params.has(k)) params.set(k, { count: 0, samples: [] });
        const rec = params.get(k);
        rec.count++;
        if (rec.samples.length < 2) rec.samples.push(v);
    }
}

log(`带 body 的 client.action 请求: ${bodyCount} / ${entries.length}`);
log('');
log('=== body 参数一览（参数名 | 出现次数 | 样本）===');
const names = [...params.keys()].sort();
for (const k of names) {
    const rec = params.get(k);
    const s = rec.samples.map(v => {
        const dec = decodeURIComponent(v);
        const cipher = /^R4i[SK]/.test(dec);
        const brief = dec.length > 60 ? dec.slice(0, 60) + `...(len=${dec.length})` : dec;
        return (cipher ? '[密文] ' : '') + brief;
    }).join(' || ');
    log(`${k} | ${rec.count} | ${s}`);
}

// 专门看 eid / wg / token 类
log('');
log('=== 含 eid/wg/token 的参数字面 ===');
for (const k of names) {
    if (/eid|wg|token|uuid|finger/i.test(k)) {
        const rec = params.get(k);
        const dec = decodeURIComponent(rec.samples[0] || '');
        log(`  ${k}: count=${rec.count} len=${dec.length} prefix=${dec.slice(0, 8)}`);
    }
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('WROTE ' + OUT);
