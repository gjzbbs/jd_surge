/* 第四轮：找 32-40 位十六进制的候选 uuid */
const fs = require('fs');
const HAR = 'C:\\Users\\Administrator\\.dsh\\attachments\\v1\\files\\4d\\4d255a4ddb9f19965c1a6277cd8bf4588b05ad892e4f8c7171ed0a4b30625cd6\\quantumult-x-2026-11-05-232532.har';
const lines = [];
const log = s => lines.push(s);

const har = JSON.parse(fs.readFileSync(HAR, 'utf8'));
const entries = har.log.entries || [];
const found = new Map();

const consider = (key, value, where) => {
    const v = String(value || '').trim();
    if (/^[0-9a-fA-F]{32,40}$/.test(v)) {
        const k = key + '=' + v;
        if (!found.has(k)) found.set(k, where);
    }
};

for (const e of entries) {
    const cv = ((e.request.headers || []).find(h => h.name.toLowerCase() === 'cookie') || {}).value || '';
    for (const part of cv.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        consider(part.slice(0, i).trim(), part.slice(i + 1), 'cookie');
    }
    const body = (e.request.postData && e.request.postData.text) || '';
    for (const part of body.split('&')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        let v = part.slice(i + 1);
        try { v = decodeURIComponent(v); } catch (x) { /* keep */ }
        consider(part.slice(0, i), v, 'body');
    }
    // 响应体里也扫一遍（京东回包会带 device 信息）
    const rt = (e.response && e.response.content && e.response.content.text) || '';
    if (rt && /"uuid"\s*:\s*"/.test(rt)) {
        for (const m of rt.matchAll(/"uuid"\s*:\s*"([^"]+)"/g)) consider('resp.uuid', m[1], 'response');
    }
}

log('=== 32-40 位 hex 候选 ===');
if (!found.size) log('(没有)');
[...found.entries()].forEach(([k, w]) => log(`  [${w}] ${k.slice(0, 120)}`));

// 单独看几个 cookie 的完整值格式
log('');
log('=== 设备类 cookie 完整长度 ===');
const seen = new Set();
for (const e of entries) {
    const cv = ((e.request.headers || []).find(h => h.name.toLowerCase() === 'cookie') || {}).value || '';
    for (const part of cv.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (/^(shshshfpa|shshshfpb|shshshfpx|mba_muid|_gia_d|3AB9D23F7A4B3C9B|3AB9D23F7A4B3CSS)$/i.test(k) && !seen.has(k)) {
            seen.add(k);
            log(`  ${k} len=${v.length} head=${v.slice(0, 40)}`);
        }
    }
}

fs.writeFileSync('D:\\脚本\\jd_surge\\har-report4.txt', lines.join('\n'), 'utf8');
console.log('OK');
