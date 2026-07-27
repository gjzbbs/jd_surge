/**
 * config_helper.js 面板脚本回归测试
 *
 * 该脚本按 $argument 分派，被 Surge 面板与 QX task_local 共同使用。
 * 重点：删掉死代码后三个分支仍然可达；httpRequest 出错时给出真实错误
 * 而不是 undefined 解引用；UI 输出中不泄漏明文凭证。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runInSurge, createQinglongStub, readSource, FULL_CONFIG } = require('./helpers/harness');

function config(extra = {}) {
    return { ...FULL_CONFIG, ...extra };
}

function textOf({ notifications }) {
    return notifications.map((n) => `${n.title}\n${n.subtitle}\n${n.body}`).join('\n---\n');
}

test('smart-check：未配置时显示向导且不联网', async () => {
    const qinglong = createQinglongStub();
    const result = await runInSurge('helper', { store: {}, argument: 'smart-check', qinglong });

    assert.equal(qinglong.requests.length, 0, '没配置就不该发请求');
    assert.match(textOf(result), /配置不完整/);
});

test('smart-check：配置完整时测试连接并报成功', async () => {
    const qinglong = createQinglongStub();
    const result = await runInSurge('helper', { store: config(), argument: 'smart-check', qinglong });

    assert.equal(qinglong.requests.length, 1);
    assert.match(textOf(result), /连接测试成功/);
});

test('smart-check：凭证在 URL 中被正确编码', async () => {
    const qinglong = createQinglongStub();
    await runInSurge('helper', { store: config(), argument: 'smart-check', qinglong });

    const url = qinglong.requests[0].url;
    assert.match(url, /client_id=id%26with%3Dspecials/);
    assert.match(url, /client_secret=sec%26ret%3D%2F%2Bx/);
});

test('smart-check：凭证错误时透传 API 错误信息', async () => {
    const qinglong = createQinglongStub({ tokenFails: true });
    const result = await runInSurge('helper', { store: config(), argument: 'smart-check', qinglong });

    assert.match(textOf(result), /bad credentials/);
});

test('smart-check：网络异常时给出真实错误，而非 undefined', async () => {
    // 旧实现 catch 后无 return，导致调用方对 undefined 取 .body，
    // 用户看到的是 "Cannot read properties of undefined"。
    const qinglong = {
        requests: [],
        get: (o, cb) => {
            qinglong.requests.push({ method: 'GET', url: o.url });
            cb('connection refused');
        },
        write: (o, cb) => cb('unexpected')
    };
    const result = await runInSurge('helper', { store: config(), argument: 'smart-check', qinglong });
    const text = textOf(result);

    assert.match(text, /网络错误/);
    assert.ok(!/undefined/.test(text), `不应出现 undefined 解引用: ${text}`);
});

test('UI 输出中凭证被掩码', async () => {
    const qinglong = createQinglongStub();
    const result = await runInSurge('helper', { store: config(), argument: 'smart-check', qinglong });
    const text = textOf(result);

    assert.ok(!text.includes('sec&ret=/+x'), 'client_secret 明文不得出现在界面上');
    assert.match(text, /\*\*\*\*/, '应当以掩码形式展示');
});

test('clear-cache：设置 bypass 标志，供下次同步消费', async () => {
    const store = config();
    await runInSurge('helper', { store, argument: 'clear-cache' });

    assert.equal(store.jd_bypass_interval_check, 'true');
});

test('clear-cache：不触碰青龙配置', async () => {
    const store = config();
    await runInSurge('helper', { store, argument: 'clear-cache' });

    assert.equal(store.ql_url, FULL_CONFIG.ql_url, '清缓存不应误删连接配置');
    assert.equal(store.ql_client_secret, FULL_CONFIG.ql_client_secret);
});

test('clear：清空全部青龙配置项', async () => {
    const store = config({ ql_update_interval: '600' });
    await runInSurge('helper', { store, argument: 'clear' });

    for (const key of ['ql_url', 'ql_client_id', 'ql_client_secret', 'ql_update_interval']) {
        assert.equal(store[key], '', `${key} 应被清空`);
    }
});

test('遗留别名 show/wizard/test 仍可分派', async () => {
    for (const alias of ['show', 'wizard', 'test']) {
        const qinglong = createQinglongStub();
        await runInSurge('helper', { store: config(), argument: alias, qinglong });
        assert.equal(qinglong.requests.length, 1, `别名 ${alias} 应当走到 smartConfigCheck`);
    }
});

test('未知参数给出明确提示', async () => {
    const result = await runInSurge('helper', { store: config(), argument: 'bogus' });
    assert.match(textOf(result), /不支持的操作/);
});

test('缺省 $argument 时回退到 smart-check', async () => {
    const qinglong = createQinglongStub();
    await runInSurge('helper', { store: config(), qinglong }); // 不传 argument

    assert.equal(qinglong.requests.length, 1, 'Surge 面板未传参时应有合理默认行为');
});

test('已删除的死函数不应复活', async () => {
    // showCurrentConfig / configWizard / testConfig 曾定义但无任何调用点，
    // 三个 case 已全部改派给 smartConfigCheck。
    const src = readSource('helper');
    for (const dead of ['function showCurrentConfig', 'function configWizard', 'async function testConfig']) {
        assert.ok(!src.includes(dead), `${dead} 是死代码，不应重新出现`);
    }
});

test('httpRequest 与主脚本保持同一约定（opts.method 而非 _method）', async () => {
    // Env 只暴露 get/post，非 GET 请求必须把真实动词放进 opts.method。
    // 两份实现若再次漂移，照抄这份去发 DELETE 会重演 a35322c 修过的 bug。
    const src = readSource('helper');
    assert.ok(!/_method/.test(src), 'config_helper 不应再使用已废弃的 _method 约定');
    assert.match(src, /opts\.method = method\.toUpperCase\(\)/);
});
