/**
 * 设备指纹层（JD_COOKIE 完整格式）单元测试
 *
 * 主脚本是立即执行的 IIFE，没有导出。这里利用 vm 的特性：顶层 function 声明
 * 会挂到 sandbox 全局，所以跑一遍（用一个非京东 UA 让它立刻结束），
 * 就能拿到 parseCookieInput / normalizeProfileFields / serializeProfile 等纯函数。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    runInSurge,
    createQinglongStub,
    envRow,
    DEVICE_HEADERS,
    FULL_COOKIE,
    JD_UA,
    JD_UA_H5,
    VALID_COOKIE,
    FULL_CONFIG
} = require('./helpers/harness');

const EID = DEVICE_HEADERS['x-api-eid-token'];
const WG = DEVICE_HEADERS['wg-sdk-token'];
const UUID = DEVICE_HEADERS.uuid;

let cached = null;

async function globals() {
    if (cached) return cached;
    const { sandbox } = await runInSurge('sync', {
        headers: { 'User-Agent': 'Mozilla/5.0 Safari' },
        store: {},
        qinglong: createQinglongStub()
    });
    cached = sandbox;
    return sandbox;
}

function baseFields(extra = {}) {
    return {
        ptKey: 'AAJoNEWKEY1234567890',
        ptPin: 'testuser',
        userAgent: JD_UA_H5,
        uuid: UUID,
        eidToken: EID,
        wgToken: WG,
        dBrand: 'iPhone',
        dModel: 'iPhone17,2',
        osVersion: '18.5',
        build: '170980',
        clientVersion: '16.0.0',
        ...extra
    };
}

test('完整字段序列化成 README 约定的顺序与写法', async () => {
    const $ = await globals();
    const profile = $.normalizeProfileFields(baseFields());
    const value = $.serializeProfile(profile);

    assert.equal(value, FULL_COOKIE);
    assert.ok(value.startsWith('pt_key='), 'JD_COOKIE 必须以 pt_key 开头');
    assert.ok(!value.endsWith(';'), '末尾不带多余分号');
});

test('h5st 不参与序列化（每次请求现签）', async () => {
    const $ = await globals();
    const profile = $.normalizeProfileFields(baseFields({ h5st: 'abc123def456' }));
    const value = $.serializeProfile(profile);

    assert.ok(!value.includes('h5st'), 'h5st 是一次性签名，不能进 JD_COOKIE');
});

test('分号串解析：UA 内部分号不转义，靠「字段名=」切分', async () => {
    const $ = await globals();
    const raw = `pt_key=k123456789012;pt_pin=testuser;User-Agent=${JD_UA_H5};uuid=${UUID};osVersion=18.5`;
    const accounts = $.parseCookieInput(raw);

    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].userAgent, JD_UA_H5, 'UA 里的 ;;; 必须原样保留');
    assert.equal(accounts[0].uuid, UUID);
    assert.equal(accounts[0].osVersion, '18.5');
});

test('多账号：& 、换行、直接接 ;pt_key= 三种分隔都要拆开', async () => {
    const $ = await globals();
    const one = 'pt_key=AAAAAAAAAAAA;pt_pin=user1';
    const two = 'pt_key=BBBBBBBBBBBB;pt_pin=user2';

    const byAmp = $.parseCookieInput(`${one}&${two}`);
    const byNewline = $.parseCookieInput(`${one}\n${two}`);
    const bySemicolon = $.parseCookieInput(`${one};${two}`);

    for (const [name, list] of [['&', byAmp], ['换行', byNewline], [';pt_key=', bySemicolon]]) {
        assert.equal(list.length, 2, `${name} 分隔应得到 2 个账号`);
        assert.equal(list[0].ptPin, 'user1');
        assert.equal(list[1].ptPin, 'user2');
    }
});

test('HAR 输入：从 entries[].request.headers 提取账号', async () => {
    const $ = await globals();
    const har = JSON.stringify({
        log: {
            entries: [{
                request: {
                    headers: [
                        { name: 'Cookie', value: VALID_COOKIE },
                        ...Object.entries(DEVICE_HEADERS).map(([name, value]) => ({ name, value }))
                    ]
                }
            }]
        }
    });

    const accounts = $.parseCookieInput(har);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].ptPin, 'testuser');
    assert.equal(accounts[0].uuid, UUID);
    assert.equal(accounts[0].osVersion, '18.5');
});

test('curl 输入：解析 -H 头', async () => {
    const $ = await globals();
    const curl = `curl 'https://api.m.jd.com/client.action' -H 'Cookie: ${VALID_COOKIE}' ` +
        `-H 'User-Agent: ${JD_UA_H5}' -H 'uuid: ${UUID}' -H 'osVersion: 18.5'`;

    const accounts = $.parseCookieInput(curl);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].ptPin, 'testuser');
    assert.equal(accounts[0].osVersion, '18.5');
    assert.equal(accounts[0].uuid, UUID);
});

test('只有 pt_key/pt_pin 时用缓存补齐设备字段', async () => {
    const $ = await globals();
    const cache = $.normalizeProfileFields($.parseCookieInput(FULL_COOKIE)[0]);
    const resolved = $.resolveProfile(
        $.normalizeProfileFields({ ptKey: 'BBBBBBBBBBBB', ptPin: 'testuser' }),
        cache
    );

    assert.equal(resolved.complete, true, '缓存里的设备字段应当补齐');
    assert.equal(resolved.profile.uuid, UUID);
    assert.equal(resolved.profile.ptKey, 'BBBBBBBBBBBB', 'pt_key 必须用本次抓到的，不能被缓存覆盖');
});

test('没有缓存且字段不全时不完整，调用方据此跳过', async () => {
    const $ = await globals();
    const resolved = $.resolveProfile(
        $.normalizeProfileFields({ ptKey: 'BBBBBBBBBBBB', ptPin: 'testuser', userAgent: JD_UA_H5 }),
        null
    );

    assert.equal(resolved.complete, false);
    assert.ok(resolved.missing.includes('uuid'));
    assert.ok(resolved.missing.includes('eidToken'));
});

test('JD4iPhone 原生 UA 归一成 jdapp; 形态', async () => {
    const $ = await globals();
    const resolved = $.finalizeProfile($.normalizeProfileFields(baseFields({
        userAgent: 'JD4iPhone/16.0.0 CFNetwork/1492.0.1 Darwin/23.3.0'
    })));

    assert.equal(resolved.complete, true);
    assert.ok(resolved.profile.userAgent.startsWith('jdapp;'), '必须产出 jdapp 前缀');
    assert.ok(resolved.profile.userAgent.includes('16.0.0'), 'App 版本要能从 UA 看出来');
    assert.ok(resolved.profile.userAgent.includes('appBuild/170980'), 'build 要能从 UA 看出来');
});

test('系统版本白名单：iOS 只认 13/14-19/26-27', async () => {
    const $ = await globals();
    const ok = ['13.0', '14.2', '15.1', '16.6', '17.4', '18.5', '19.0', '26.0', '27.0'];
    const bad = ['12.5', '20.1', '21.0', '25.3', '28.0'];

    for (const version of ok) {
        const result = $.finalizeProfile($.normalizeProfileFields(baseFields({ osVersion: version })));
        assert.equal(result.complete, true, `iOS ${version} 应当被接受`);
    }
    for (const version of bad) {
        const result = $.finalizeProfile($.normalizeProfileFields(baseFields({ osVersion: version })));
        assert.equal(result.complete, false, `iOS ${version} 不在白名单内`);
        assert.ok(result.missing.includes('osVersion'));
    }
});

test('iOS 27 先复用 iOS 26 的 ClientHello', async () => {
    const $ = await globals();
    const result = $.finalizeProfile($.normalizeProfileFields(baseFields({ osVersion: '27.0' })));

    assert.equal(result.profile.clientHello, 26, 'iOS 27 的 TLS 指纹还没被识别，先按 26 走');
});

test('系统版本白名单：Android 只认 10-16', async () => {
    const $ = await globals();
    const android = {
        userAgent: 'jdapp;android;13.6.0;;;M/5.0;appBuild/120000',
        osVersion: '13',
        dBrand: 'HUAWEI',
        dModel: 'ALN-AL00',
        build: '120000',
        clientVersion: '13.6.0'
    };

    assert.equal($.finalizeProfile($.normalizeProfileFields(baseFields(android))).complete, true);
    assert.equal($.finalizeProfile($.normalizeProfileFields(baseFields({ ...android, osVersion: '9' }))).complete, false);
    assert.equal($.finalizeProfile($.normalizeProfileFields(baseFields({ ...android, osVersion: '17' }))).complete, false);
});

test('字段格式校验：uuid / eid / wg / build', async () => {
    const $ = await globals();
    const cases = [
        ['uuid', '0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef'],
        ['uuid', '0123-4567-89ab-cdef-0123-4567-89ab-cdef', '0123456789abcdef0123456789abcdef'],
        ['uuid', 'xyz', ''],
        ['uuid', '0123456789abcdef0123456789abcdef0123456789', ''],
        ['eidToken', 'jdd' + 'a'.repeat(40), ''],
        ['eidToken', 'jdd' + 'a'.repeat(500), ''],
        ['wgToken', 'jdd01' + 'b'.repeat(40), ''],
        ['wgToken', 'jdd' + 'b'.repeat(200), '']
    ];

    for (const [field, input, expected] of cases) {
        const normalized = $.normalizeProfileFields(baseFields({ [field]: input }));
        assert.equal(normalized[field], expected, `${field}=${input} 归一化错误`);
    }
});

test('build 只认 5-8 位数字，缺失时从 UA 的 appBuild 取', async () => {
    const $ = await globals();
    const noBuildUa = { userAgent: 'jdapp;iPhone;16.0.0;;;M/5.0' };

    assert.equal($.normalizeProfileFields(baseFields({ ...noBuildUa, build: '170980' })).build, '170980');
    assert.equal($.normalizeProfileFields(baseFields({ ...noBuildUa, build: '1234' })).build, '');
    assert.equal($.normalizeProfileFields(baseFields({ ...noBuildUa, build: '123456789' })).build, '');
    assert.equal(
        $.normalizeProfileFields(baseFields({ build: '' })).build,
        '170980',
        'build 头缺失时应回落 UA 的 appBuild'
    );
});

test('d_brand / d_model 只留明文，密文丢掉', async () => {
    const $ = await globals();

    assert.equal($.normalizeProfileFields(baseFields({ dModel: 'iPhone17,2' })).dModel, 'iPhone17,2');
    assert.equal($.normalizeProfileFields(baseFields({ dModel: '23013RK75C' })).dModel, '23013RK75C');
    assert.equal($.normalizeProfileFields(baseFields({ dModel: 'QzEyMzQ1Njc4OTA3NjU0MzIx' })).dModel, '');
    assert.equal($.normalizeProfileFields(baseFields({ dBrand: 'aGVsbG8gd29ybGQ=' })).dBrand, '');
});

test('安卓机型不会配到 iOS 的 UA 上', async () => {
    const $ = await globals();
    const result = $.finalizeProfile($.normalizeProfileFields(baseFields({
        osVersion: '18.5',
        dBrand: 'HUAWEI',
        dModel: 'ALN-AL00'
    })));

    assert.equal(result.profile.dBrand, '');
    assert.equal(result.profile.dModel, '');
    assert.equal(result.complete, false);
});

test('HAR、curl、分号串三种输入判为同一份身份', async () => {
    const $ = await globals();
    const har = JSON.stringify({
        log: {
            entries: [{
                request: {
                    headers: [
                        { name: 'Cookie', value: VALID_COOKIE },
                        ...Object.entries(DEVICE_HEADERS).map(([name, value]) => ({ name, value }))
                    ]
                }
            }]
        }
    });

    assert.equal($.isSameCookieValue(har, FULL_COOKIE), true);
    assert.equal($.isSameCookieValue('pt_key=AAJoNEWKEY1234567890;pt_pin=testuser;', FULL_COOKIE), false,
        '只有 pt_key/pt_pin 的旧值不能算等价');
});

test('端到端：设备字段齐全时写入完整 JD_COOKIE', async () => {
    const qinglong = createQinglongStub({ envs: [envRow(7, 'pt_key=OLDKEY0000000;pt_pin=testuser;')] });
    const { requests } = await runInSurge('sync', {
        store: { ...FULL_CONFIG },
        qinglong
    });

    const add = requests.find(r => r.method === 'POST');
    assert.ok(add, '应当发出新增请求');
    assert.ok(add.body.includes('"value":"pt_key=AAJoNEWKEY1234567890;pt_pin=testuser;User-Agent=jdapp;'));
    assert.ok(add.body.includes('x-api-eid-token='));
    assert.ok(add.body.includes('wg-sdk-token='));
    assert.ok(add.body.includes('d_model=iPhone17,2'));
    assert.ok(add.body.includes('osVersion=18.5'));
});

test('端到端：设备字段缺失且无缓存时跳过，不发同步请求', async () => {
    const qinglong = createQinglongStub({ envs: [envRow(7, 'pt_key=OLDKEY0000000;pt_pin=testuser;')] });
    const { requests, logs } = await runInSurge('sync', {
        store: { ...FULL_CONFIG },
        qinglong,
        headers: { uuid: '', 'x-api-eid-token': '' }
    });

    assert.equal(requests.length, 0, '半截设备身份不能写进青龙');
    assert.ok(logs.some(line => line.includes('设备字段不全')), '跳过原因要写进日志');
});

test('端到端：设备字段缺失但有缓存时用缓存补齐', async () => {
    const qinglong = createQinglongStub({ envs: [envRow(7, 'pt_key=OLDKEY0000000;pt_pin=testuser;')] });
    const { requests } = await runInSurge('sync', {
        store: { ...FULL_CONFIG, jd_cookie_cache_testuser: FULL_COOKIE },
        qinglong,
        headers: { uuid: '', 'x-api-eid-token': '' }
    });

    const add = requests.find(r => r.method === 'POST');
    assert.ok(add, '缓存能补齐时应当正常同步');
    assert.ok(add.body.includes('uuid=' + UUID));
});

test('端到端：osVersion 不在白名单时跳过', async () => {
    const qinglong = createQinglongStub({ envs: [envRow(7, 'pt_key=OLDKEY0000000;pt_pin=testuser;')] });
    const { requests, logs } = await runInSurge('sync', {
        store: { ...FULL_CONFIG },
        qinglong,
        headers: { osVersion: '20.1' }
    });

    assert.equal(requests.length, 0);
    assert.ok(logs.some(line => line.includes('osVersion')));
});

test('端到端：JD4iPhone 原生 UA 也能同步（UA 归一为 jdapp）', async () => {
    const qinglong = createQinglongStub({ envs: [envRow(7, 'pt_key=OLDKEY0000000;pt_pin=testuser;')] });
    const { requests } = await runInSurge('sync', {
        store: { ...FULL_CONFIG },
        qinglong,
        headers: { 'User-Agent': JD_UA }
    });

    const add = requests.find(r => r.method === 'POST');
    assert.ok(add, '原生栈 UA 不应导致跳过');
    assert.ok(add.body.includes('User-Agent=jdapp;'), '同步值里的 UA 必须是 jdapp 形态');
});

test('端到端：缓存里存的是完整值，不含 h5st', async () => {
    const store = { ...FULL_CONFIG };
    await runInSurge('sync', {
        store,
        qinglong: createQinglongStub({ envs: [envRow(7, 'pt_key=OLDKEY0000000;pt_pin=testuser;')] }),
        headers: { h5st: 'deadbeef012345' }
    });

    assert.equal(store.jd_cookie_cache_testuser, FULL_COOKIE);
    assert.ok(!store.jd_cookie_cache_testuser.includes('h5st'));
});

// ---------- 手动导入入口：$argument = push[:<HAR|curl|分号串>] ----------

test('手动导入：push 分号串直接同步，不依赖抓包', async () => {
    const qinglong = createQinglongStub({ envs: [] });
    const { requests } = await runInSurge('sync', {
        store: { ...FULL_CONFIG },
        qinglong,
        argument: `push:${FULL_COOKIE}`
    });

    const add = requests.find(r => r.method === 'POST');
    assert.ok(add, '导入应当直接写入青龙');
    assert.ok(add.body.includes('"value":"pt_key=AAJoNEWKEY1234567890;pt_pin=testuser;User-Agent=jdapp;'));
    assert.ok(add.body.includes('uuid=' + UUID));
});

test('手动导入：HAR 文本走同一条路径', async () => {
    const qinglong = createQinglongStub({ envs: [] });
    const har = JSON.stringify({
        log: {
            entries: [{
                request: {
                    headers: [
                        { name: 'Cookie', value: VALID_COOKIE },
                        ...Object.entries(DEVICE_HEADERS).map(([name, value]) => ({ name, value }))
                    ]
                }
            }]
        }
    });

    const { requests } = await runInSurge('sync', {
        store: { ...FULL_CONFIG },
        qinglong,
        argument: `push:${har}`
    });

    const add = requests.find(r => r.method === 'POST');
    assert.ok(add, 'HAR 导入应当成功');
    assert.ok(add.body.includes('osVersion=18.5'));
});

test('手动导入：多账号一次写入两条', async () => {
    const qinglong = createQinglongStub({ envs: [] });
    const second = FULL_COOKIE.replace('testuser', 'otheruser').replace('AAJoNEWKEY1234567890', 'BBJoNEWKEY1234567890');
    const { requests } = await runInSurge('sync', {
        store: { ...FULL_CONFIG },
        qinglong,
        argument: `push:${FULL_COOKIE}&${second}`
    });

    const added = requests.filter(r => r.method === 'POST');
    assert.equal(added.length, 2, '两个账号各写一条');
    assert.ok(added[0].body.includes('pt_pin=testuser'));
    assert.ok(added[1].body.includes('pt_pin=otheruser'));
});

test('手动导入：只填 pt_key/pt_pin 时用缓存补齐', async () => {
    const qinglong = createQinglongStub({ envs: [] });
    const { requests } = await runInSurge('sync', {
        store: { ...FULL_CONFIG, jd_cookie_cache_testuser: FULL_COOKIE },
        qinglong,
        argument: 'push:pt_key=CCJoNEWKEY1234567890;pt_pin=testuser'
    });

    const add = requests.find(r => r.method === 'POST');
    assert.ok(add, '缓存能补齐时应当同步');
    assert.ok(add.body.includes('uuid=' + UUID));
    assert.ok(add.body.includes('CCJoNEWKEY1234567890'), 'pt_key 必须用本次输入的值');
});

test('手动导入：缓存也没有且字段不全时跳过并提示', async () => {
    const qinglong = createQinglongStub({ envs: [] });
    const { requests, notifications } = await runInSurge('sync', {
        store: { ...FULL_CONFIG },
        qinglong,
        argument: 'push:pt_key=AAJoNEWKEY1234567890;pt_pin=testuser'
    });

    assert.equal(requests.length, 0, '半截身份不写进青龙');
    assert.ok(JSON.stringify(notifications).includes('testuser'), '要告知用户哪个账号被跳过');
});
