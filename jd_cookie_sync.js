/**
 * JD Cookie Sync to Qinglong
 * 自动抓取京东 Cookie 并同步到青龙面板
 */

const $ = new Env('JD Cookie Sync');

// ============= 常量定义 =============

const CONFIG_KEYS = {
    URL: 'ql_url',
    CLIENT_ID: 'ql_client_id',
    CLIENT_SECRET: 'ql_client_secret',
    UPDATE_INTERVAL: 'ql_update_interval',
    BYPASS_CHECK: 'jd_bypass_interval_check',
    STRIP_APP_OPEN: 'jd_strip_app_open'
};

// 京东 App 有两种 User-Agent 前缀：
//   JD4iPhone —— 原生网络栈（老形态 JD4iPhone/167783 (iPhone;...)，新形态 JD4iPhone/16.0.0 CFNetwork/...）
//   jdapp;    —— App 内 H5 / pro.m.jd.com 网页容器，2026-09 抓包里大量出现
const JD_APP_UA_RE = /^(?:JD4iPhone|jdapp;)/i;

// 京东 2026-09 起给 pt_key 加了 app_open 渠道前缀（app_openAAJqskN7...）
const APP_OPEN_PREFIX = 'app_open';

const DEFAULT_UPDATE_INTERVAL = 1800; // 默认30分钟

// 手动导入：粘贴内容过长时先写进这个存储键，$argument 只传 push
const IMPORT_PAYLOAD_KEY = 'jd_import_payload';
const REQUEST_TIMEOUT = 6000;       // 单次请求超时，必须显著小于 sgmodule 的 timeout=20
const SYNC_LOCK_TTL = 30000;        // 同步锁自动过期时间，需大于脚本最长存活时间

// 字段补不齐的通知节流：每账号每小时最多提醒一次
const SKIP_NOTIFY_PREFIX = 'jd_cookie_skipmsg_';
const SKIP_NOTIFY_TTL = 3600 * 1000;

// ============= 配置管理 =============

/**
 * 从持久化存储读取配置
 */
function getConfig() {
    return {
        qlUrl: $.getval(CONFIG_KEYS.URL),
        clientId: $.getval(CONFIG_KEYS.CLIENT_ID),
        clientSecret: $.getval(CONFIG_KEYS.CLIENT_SECRET),
        updateInterval: parseInt($.getval(CONFIG_KEYS.UPDATE_INTERVAL) || String(DEFAULT_UPDATE_INTERVAL))
    };
}

/**
 * 检查配置是否完整
 */
function validateConfig(config) {
    if (!config.qlUrl || !config.clientId || !config.clientSecret) {
        return {
            valid: false,
            message: '⚠️ 配置不完整\n\n请设置以下持久化数据：\n- ql_url: 青龙面板地址\n- ql_client_id: Client ID\n- ql_client_secret: Client Secret'
        };
    }

    if (!config.qlUrl.startsWith('http://') && !config.qlUrl.startsWith('https://')) {
        return {
            valid: false,
            message: '⚠️ 青龙面板地址格式错误\n\n需要以 http:// 或 https:// 开头'
        };
    }

    // 移除 URL 末尾的斜杠
    if (config.qlUrl.endsWith('/')) {
        config.qlUrl = config.qlUrl.slice(0, -1);
    }

    return { valid: true };
}

// ============= 设备指纹（完整 JD_COOKIE） =============
//
// 青龙里的 JD_COOKIE 不只是一对 pt_key/pt_pin。下游脚本要用「同一台设备」的
// UA、uuid、eid token、wg token、机型、系统版本、build、App 版本去请求，
// 少一个字段就会被京东认成异机登录。这里把抓包请求头归一化成固定字段、
// 做格式校验、按账号缓存，并在字段缺失时回落到该账号上次抓到的完整值。
//
// 两条硬规则：
//   1. h5st 每次请求现签，不解析、不序列化、不进缓存
//   2. 字段补不齐就不写青龙——半截设备身份比没有更危险

// 系统版本白名单：只认这些大版本
const OS_ALLOWLIST = {
    ios: [13, 14, 15, 16, 17, 18, 19, 26, 27],
    android: [10, 11, 12, 13, 14, 15, 16]
};

// iOS 27 的 TLS 指纹还没被京东识别，先复用 iOS 26 的 ClientHello
const CLIENT_HELLO_ALIAS = { ios: { 27: 26 } };

// 字段别名：抓包头、分号串、HAR、curl 里的各种写法都归一到同一组键
const FIELD_ALIASES = {
    pt_key: 'ptKey',
    ptpin: 'ptPin',
    pt_pin: 'ptPin',
    'user-agent': 'userAgent',
    useragent: 'userAgent',
    ua: 'userAgent',
    user_agent: 'userAgent',
    uuid: 'uuid',
    'x-api-eid-token': 'eidToken',
    xapieidtoken: 'eidToken',
    eidtoken: 'eidToken',
    eid_token: 'eidToken',
    'wg-sdk-token': 'wgToken',
    wgsdktoken: 'wgToken',
    wgtoken: 'wgToken',
    wg_token: 'wgToken',
    d_brand: 'dBrand',
    dbrand: 'dBrand',
    d_model: 'dModel',
    dmodel: 'dModel',
    osversion: 'osVersion',
    os_version: 'osVersion',
    build: 'build',
    appbuild: 'build',
    clientversion: 'clientVersion',
    client_version: 'clientVersion',
    openudid: 'openudid',
    screen: 'screen'
};

const FIELD_LABELS = {
    userAgent: 'User-Agent',
    uuid: 'uuid',
    eidToken: 'x-api-eid-token',
    wgToken: 'wg-sdk-token',
    dBrand: 'd_brand',
    dModel: 'd_model',
    osVersion: 'osVersion',
    build: 'build',
    clientVersion: 'clientVersion'
};

const REQUIRED_PROFILE_FIELDS = Object.keys(FIELD_LABELS);

// 序列化顺序与 README 的字段表一致
const SERIALIZE_ORDER = [
    ['ptKey', 'pt_key'],
    ['ptPin', 'pt_pin'],
    ['userAgent', 'User-Agent'],
    ['uuid', 'uuid'],
    ['eidToken', 'x-api-eid-token'],
    ['wgToken', 'wg-sdk-token'],
    ['dBrand', 'd_brand'],
    ['dModel', 'd_model'],
    ['osVersion', 'osVersion'],
    ['build', 'build'],
    ['clientVersion', 'clientVersion'],
    ['openudid', 'openudid'],
    ['screen', 'screen']
];

/**
 * 大小写不敏感地取请求头
 */
function headerValue(headers, name) {
    if (!headers) return '';
    const wanted = String(name).toLowerCase();
    const key = Object.keys(headers).find(k => k.toLowerCase() === wanted);
    if (!key) return '';
    const value = headers[key];
    return value == null ? '' : String(value).trim();
}

/**
 * 诊断用：只列请求头的名字，不含任何值。
 * 用来一眼看出 QX / Surge 到底把哪些字段透传给了脚本。
 */
function describeHeaderNames(headers) {
    if (!headers) return '(无请求头)';
    return Object.keys(headers).map(key => String(key).toLowerCase()).sort().join(', ');
}

/**
 * 字段补不齐时每小时只推一次通知。
 * 跳过是静默的，日志又埋在 QX 里，不给主动提示用户只会看到「没反应」。
 */
function notifySkipOnce(ptPin, reason, headerNames) {
    try {
        const key = SKIP_NOTIFY_PREFIX + ptPin;
        const last = Number($.getval(key) || 0);
        const now = Date.now();
        if (last && now - last < SKIP_NOTIFY_TTL) return;
        $.setval(key, String(now));
        $.msg(
            'JD Cookie Sync',
            `设备字段不全，已跳过 ${ptPin}`,
            `缺: ${reason}\n本次请求头: ${headerNames}\n\n若一直补不齐，可在 module 里用 argument=push:<HAR 或 curl> 手动导入。`
        );
    } catch (error) {
        // 通知失败不影响主流程
    }
}

function canonField(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    return FIELD_ALIASES[key] || FIELD_ALIASES[key.replace(/[-_]/g, '')] || null;
}

function normalizeUuid(raw) {
    const value = String(raw || '').trim().replace(/^[{}]+|[{}]+$/g, '').replace(/-/g, '').toLowerCase();
    return /^[0-9a-f]{32,40}$/.test(value) ? value : '';
}

function normalizeEidToken(raw) {
    const value = String(raw || '').trim();
    if (!/^jdd/i.test(value)) return '';
    return value.length >= 100 && value.length <= 400 ? value : '';
}

function normalizeWgToken(raw) {
    const value = String(raw || '').trim();
    if (!/^jdd01/i.test(value)) return '';
    return value.length >= 100 ? value : '';
}

function normalizeBuild(raw) {
    const value = String(raw || '').trim();
    return /^\d{5,8}$/.test(value) ? value : '';
}

function normalizeClientVersion(raw) {
    const value = String(raw || '').trim();
    return /^\d+\.\d+(?:\.\d+){0,2}$/.test(value) ? value : '';
}

/**
 * 明文机型：iPhone17,2 / SM-S9180 / 23013RK75C / HUAWEI Mate 60
 * 密文（base64 或长无分隔串）直接丢掉
 */
function normalizeDeviceValue(raw, maxLength) {
    const value = String(raw || '').trim();
    if (!value || value.length > maxLength) return '';
    if (/[=+/]/.test(value)) return '';
    if (/^[A-Za-z0-9]{20,}$/.test(value)) return '';
    if (!/^[A-Za-z0-9][A-Za-z0-9 ,._()\-]*$/.test(value)) return '';
    return value;
}

function makeOs(platform, major, minor) {
    return {
        platform,
        major: Number(major),
        text: minor == null ? String(Number(major)) : `${Number(major)}.${Number(minor)}`
    };
}

/**
 * 解析系统版本：osVersion 头里的 18.5 / iOS 17.0 / Android 13，
 * 或者 UA 里的 (iPhone; iOS 17.0; ...)
 */
function parseOsVersion(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;

    let match = text.match(/(?:ios|iphone\s*os)[\s/_-]*(\d{1,2})(?:[._](\d{1,2}))?/i);
    if (match) return makeOs('ios', match[1], match[2]);

    match = text.match(/android[\s/_-]*(\d{1,2})(?:[._](\d{1,2}))?/i);
    if (match) return makeOs('android', match[1], match[2]);

    match = text.match(/^(\d{1,2})(?:[._](\d{1,2}))?$/);
    if (match) return makeOs('', match[1], match[2]);

    return null;
}

/**
 * 从 UA 里挖平台、App 版本、appBuild
 *   jdapp;iPhone;16.1.50;;;M/5.0;appBuild/171135     → ios / 16.1.50 / 171135
 *   JD4iPhone/167783 (iPhone; iOS 17.0; Scale/3.00)   → ios / - / 167783
 *   JD4iPhone/16.0.0 CFNetwork/1492.0.1               → ios / 16.0.0 / -
 */
function parseUserAgent(raw) {
    const ua = String(raw || '');
    const info = { platform: '', clientVersion: '', build: '', osVersion: '' };
    if (!ua) return info;

    if (/android/i.test(ua)) info.platform = 'android';
    else if (/iphone|ipad|ipod|ios/i.test(ua)) info.platform = 'ios';

    const appBuild = ua.match(/appBuild\/(\d{5,8})/i);
    if (appBuild) info.build = appBuild[1];

    // JD4iPhone 的 UA 会把系统版本和 build 明文带在参数里：;os/17.3;build/171135
    const osTag = ua.match(/[;,]os\/(\d{1,2}(?:[._]\d{1,2})?)/i);
    if (osTag) info.osVersion = osTag[1].replace(/_/g, '.');

    const buildTag = ua.match(/[;,]build\/(\d{5,8})/i);
    if (buildTag) info.build = info.build || buildTag[1];

    // jdmall;iphone;version/16.1.50;build/171135;os/17.3 这种中间形态
    const versionTag = ua.match(/[;,]version\/(\d+\.\d+(?:\.\d+){0,2})/i);
    if (versionTag && !info.clientVersion) info.clientVersion = versionTag[1];

    const jdapp = ua.match(/^jdapp;([^;]*);([^;]+)/i);
    if (jdapp) {
        if (!info.platform) info.platform = /android/i.test(jdapp[1]) ? 'android' : 'ios';
        if (/^\d+\.\d+(?:\.\d+){0,2}$/.test(jdapp[2])) info.clientVersion = jdapp[2];
    }

    const native = ua.match(/^JD4iPhone\/([^ ;]+)/i);
    if (native) {
        const token = native[1];
        if (/^\d{5,8}$/.test(token)) info.build = info.build || token;
        else if (/^\d+\.\d+(?:\.\d+){0,2}$/.test(token)) info.clientVersion = token;
    }

    return info;
}

/**
 * uuid 在 body 里经常是密文（R4i…），密文按「没有」处理。
 * 一个账号的 uuid 必须稳定，否则每次同步都算一台新设备——所以按 ptPin 派生。
 * 京东只把它当设备标识用，32 位十六进制就够。
 */
function deriveUuid(seed) {
    const text = 'jdsurge:' + String(seed || '');
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    let h3 = 0x9e3779b9;
    let h4 = 0x85ebca6b;
    for (let i = 0; i < text.length; i += 1) {
        const c = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
        h3 = Math.imul(h3 ^ (c << 3), 0xc2b2ae35) >>> 0;
        h4 = Math.imul(h4 + c * 31, 0x27d4eb2f) >>> 0;
    }
    return [h1, h2, h3, h4].map(n => (n >>> 0).toString(16).padStart(8, '0')).join('');
}

/**
 * 把字段字典归一成一个 profile。
 * 所有校验都在这里做——不合格式的字段直接置空，交给缓存回落或跳过。
 */
function normalizeProfileFields(fields) {
    const source = fields || {};
    const userAgent = String(source.userAgent || '').trim();
    const uaInfo = parseUserAgent(userAgent);
    const os = parseOsVersion(source.osVersion) || parseOsVersion(uaInfo.osVersion);

    return {
        ptKey: String(source.ptKey || '').trim(),
        ptPin: String(source.ptPin || '').trim(),
        userAgent,
        uuid: normalizeUuid(source.uuid),
        eidToken: normalizeEidToken(source.eidToken),
        wgToken: normalizeWgToken(source.wgToken),
        dBrand: normalizeDeviceValue(source.dBrand, 24),
        dModel: normalizeDeviceValue(source.dModel, 32),
        osVersion: os ? os.text : '',
        platform: (os && os.platform) || uaInfo.platform,
        // UA 里的 version/ 与 appBuild/ 是 App 自报的权威值。
        // 有些接口（babelGetGuideTips）会把 clientVersion 写成 1.0.0，
        // 一旦让它覆盖真值，这个账号的版本号就永久错了。
        build: uaInfo.build || normalizeBuild(source.build),
        clientVersion: uaInfo.clientVersion || normalizeClientVersion(source.clientVersion),
        openudid: String(source.openudid || '').trim(),
        screen: String(source.screen || '').trim()
    };
}

/**
 * 从一次抓包的请求头构建 profile
 */
function profileFromHeaders(headers) {
    const cookieHeader = headerValue(headers, 'Cookie');
    const ptKey = (cookieHeader.match(/pt_key=([^;]+)/) || [])[1] || '';
    const ptPinRaw = (cookieHeader.match(/pt_pin=([^;]+)/) || [])[1] || '';

    let ptPin = ptPinRaw;
    try {
        ptPin = decodeURIComponent(ptPinRaw);
    } catch (e) {
        ptPin = ptPinRaw;
    }

    return normalizeProfileFields({
        ptKey: ptKey,
        ptPin: ptPin,
        userAgent: headerValue(headers, 'User-Agent'),
        uuid: headerValue(headers, 'uuid'),
        eidToken: headerValue(headers, 'x-api-eid-token'),
        wgToken: headerValue(headers, 'wg-sdk-token'),
        dBrand: headerValue(headers, 'd_brand'),
        dModel: headerValue(headers, 'd_model'),
        osVersion: headerValue(headers, 'osVersion'),
        build: headerValue(headers, 'build'),
        clientVersion: headerValue(headers, 'clientVersion'),
        openudid: headerValue(headers, 'openudid'),
        screen: headerValue(headers, 'screen')
    });
}

/**
 * 京东 App 把设备字段放在 client.action 的 POST body 里（query string 形式），
 * 请求头里根本没有——只读 headers 永远是缺的。
 *   uuid=...&d_brand=apple&d_model=iPhone16,2&osVersion=...&build=171135&x-api-eid-token=jdd013...
 */
function parseRequestBody(body) {
    const text = String(body || '').trim();
    const params = {};
    if (!text) return params;

    if (text.charAt(0) === '{') {
        try {
            const json = JSON.parse(text);
            if (json && typeof json === 'object') {
                Object.keys(json).forEach(key => {
                    const value = json[key];
                    if (value === null || value === undefined) return;
                    params[key] = typeof value === 'string' ? value : JSON.stringify(value);
                });
            }
        } catch (e) {
            // body 是 JSON 但解析失败就当没有
        }
        return params;
    }

    text.split('&').forEach(part => {
        const index = part.indexOf('=');
        if (index <= 0) return;
        params[safeDecode(part.slice(0, index))] = safeDecode(part.slice(index + 1));
    });
    return params;
}

function safeDecode(value) {
    const text = String(value || '').replace(/\+/g, ' ');
    try {
        return decodeURIComponent(text);
    } catch (e) {
        return text;
    }
}

/**
 * 京东会把部分字段加密成 R4iSK... 传过来，加密值不能当明文用
 */
function isCipherValue(value) {
    return /^R4i[SK]/.test(String(value || '').trim());
}

function pickParam(params, names) {
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (!Object.prototype.hasOwnProperty.call(params, name)) continue;
        const value = String(params[name] || '').trim();
        if (!value || isCipherValue(value)) continue;
        return value;
    }
    return '';
}

/**
 * wg-sdk-token 不单独成参，藏在 ext 的 sdkToken 里：
 *   ext={"prstate":"0","sdkToken":"jdd013..."}
 */
function pickExtToken(params) {
    const raw = params && params.ext;
    if (!raw) return '';
    try {
        const ext = JSON.parse(raw);
        if (ext && typeof ext === 'object') return String(ext.sdkToken || '').trim();
    } catch (e) {
        return '';
    }
    return '';
}

/**
 * 从「请求头 + 请求体」构建 profile：body 里的明文优先，header 兜底
 */
function profileFromRequest(headers, body) {
    const base = profileFromHeaders(headers);
    const params = parseRequestBody(body);
    if (!Object.keys(params).length) return base;

    return normalizeProfileFields({
        ptKey: base.ptKey,
        ptPin: base.ptPin,
        userAgent: base.userAgent,
        uuid: pickParam(params, ['uuid', 'openudid']) || base.uuid,
        eidToken: pickParam(params, ['x-api-eid-token']) || base.eidToken,
        wgToken: pickParam(params, ['wg-sdk-token']) || pickExtToken(params) || base.wgToken,
        dBrand: pickParam(params, ['d_brand']) || base.dBrand,
        dModel: pickParam(params, ['d_model']) || base.dModel,
        osVersion: pickParam(params, ['osVersion']) || base.osVersion,
        build: pickParam(params, ['build']) || base.build,
        clientVersion: pickParam(params, ['clientVersion']) || base.clientVersion,
        openudid: pickParam(params, ['openudid']) || base.openudid,
        screen: pickParam(params, ['screen']) || base.screen
    });
}

/**
 * 系统版本必须落在白名单里；返回解析后的平台与 ClientHello 家族
 */
function checkOsVersion(profile) {
    const parsed = parseOsVersion(profile.osVersion);
    if (!parsed) return { ok: false, reason: 'osVersion 缺失或无法识别' };

    const platform = parsed.platform || profile.platform;
    if (!platform) return { ok: false, reason: '无法判定系统平台' };

    const allowed = OS_ALLOWLIST[platform] || [];
    if (!allowed.includes(parsed.major)) {
        return { ok: false, reason: `不支持的 ${platform} 版本 ${parsed.text}` };
    }

    const hello = (CLIENT_HELLO_ALIAS[platform] || {})[parsed.major];
    return { ok: true, platform, osVersion: parsed.text, clientHello: hello || parsed.major };
}

/**
 * iOS 机型不能配 Android 品牌，反之亦然
 */
function platformMatchesBrand(platform, dBrand) {
    if (!platform || !dBrand) return true;
    const iosBrand = /iphone|ipad|ipod|apple/i.test(dBrand);
    return platform === 'ios' ? iosBrand : !iosBrand;
}

// 安卓机型前缀 → 厂商。京东的 d_brand 要的是厂商名，不是型号。
// 认不出来就留空（宁可跳过，也不要编一个和机型对不上的品牌）。
const ANDROID_BRAND_HINTS = [
    [/^(?:SM-|Galaxy|GT-)/i, 'samsung'],
    [/^(?:Redmi|Mi |MI |POCO|M20|M21)/i, 'xiaomi'],
    [/^(?:HUAWEI|ELS-|ALN-|LIO-|NOH-|JAD-|BAL-)/i, 'HUAWEI'],
    [/^(?:HONOR|ANY-|BVL-|FCP-)/i, 'honor'],
    [/^(?:OPPO|P[A-Z]{2}\d|CPH\d)/i, 'oppo'],
    [/^(?:vivo|V\d{4}|PD\d)/i, 'vivo'],
    [/^(?:OnePlus|LE\d{4}|NE\d{4})/i, 'OnePlus'],
    [/^(?:Pixel)/i, 'Google'],
    [/^(?:realme|RMX\d)/i, 'realme']
];

/**
 * d_brand 在多数请求里是密文，只有极少数请求（且常常不带 pt_pin）才有明文。
 * 品牌可以由平台和机型确定推出：iPhone 一定是 apple，安卓按型号前缀认厂商。
 * 这样 d_brand 不会成为永远补不齐的那个字段。
 */
function deriveBrand(platform, dModel) {
    if (platform === 'ios') return 'apple';
    if (platform !== 'android') return '';
    const model = String(dModel || '');
    for (const [pattern, brand] of ANDROID_BRAND_HINTS) {
        if (pattern.test(model)) return brand;
    }
    return '';
}

/**
 * UA 归一成 jdapp; 形态：平台 + App 版本 + appBuild 都在串里。
 * 已经是 jdapp; 的原样保留，不改造真实 UA。
 */
function normalizeUserAgent(profile) {
    const raw = String(profile.userAgent || '').trim();
    if (/^jdapp;/i.test(raw)) return raw;

    const uaInfo = parseUserAgent(raw);
    const platform = profile.platform || uaInfo.platform;
    const clientVersion = profile.clientVersion || uaInfo.clientVersion;
    const build = profile.build || uaInfo.build;
    if (!platform || !clientVersion) return '';

    const device = platform === 'android' ? 'android' : 'iPhone';
    const parts = ['jdapp', device, clientVersion, '', '', 'M/5.0'];
    if (build) parts.push(`appBuild/${build}`);
    return parts.join(';');
}

/**
 * 收尾校验：系统版本、机型一致性、UA 形态、必填字段
 */
function finalizeProfile(input) {
    const profile = { ...(input || {}) };
    const osCheck = checkOsVersion(profile);
    const platform = osCheck.ok ? osCheck.platform : (profile.platform || '');

    profile.platform = platform;

    // d_brand 在 body 里几乎永远是密文；能从平台和机型推出来的话就别让它成为缺口
    if (!profile.dBrand) profile.dBrand = deriveBrand(platform, profile.dModel);

    if (!platformMatchesBrand(platform, profile.dBrand)) {
        profile.dBrand = '';
        profile.dModel = '';
    }

    profile.osVersion = osCheck.ok ? osCheck.osVersion : '';
    if (osCheck.ok) profile.clientHello = osCheck.clientHello;

    profile.userAgent = normalizeUserAgent(profile);
    if (!/^jdapp;/i.test(profile.userAgent)) profile.userAgent = '';

    // 抓包里的 uuid 十有八九是密文，密文按没有处理；缓存也没有就按 ptPin 派生一个
    // 稳定值——否则这台设备永远是"缺 uuid"，一条都同步不出去
    if (!profile.uuid && profile.ptPin) profile.uuid = deriveUuid(profile.ptPin);

    // openudid 是可选项：抓到就写，抓不到不写。消费方按「没有 openudid 就用 uuid」处理，
    // 所以这里不拿 uuid 顶替，避免每次同步都多出一段没必要的字段。

    const missing = REQUIRED_PROFILE_FIELDS.filter(field => !profile[field]);
    return {
        complete: missing.length === 0,
        profile,
        missing,
        reason: osCheck.ok ? '' : osCheck.reason
    };
}

function mergeProfiles(base, incoming) {
    const merged = { ...(base || {}) };
    for (const key of Object.keys(incoming || {})) {
        const value = incoming[key];
        if (value !== '' && value != null) merged[key] = value;
    }
    return merged;
}

/**
 * 输入字段 + 该账号缓存 → 完整 profile。
 * 只填了 pt_key/pt_pin 的输入靠这里补齐；补不齐就不写青龙。
 */
function resolveProfile(input, cacheProfile) {
    const merged = mergeProfiles(cacheProfile || {}, input || {});
    return finalizeProfile(normalizeProfileFields(merged));
}

function serializeProfile(profile) {
    const parts = [];
    for (const [key, label] of SERIALIZE_ORDER) {
        const value = profile[key];
        if (!value) continue;
        parts.push(`${label}=${value}`);
    }
    return parts.join(';');
}

/**
 * 设备摘要，只用于日志与通知（不含任何 token）
 */
function describeProfile(profile) {
    if (!profile) return '未知设备';
    const system = profile.platform === 'android' ? `Android ${profile.osVersion}` : `iOS ${profile.osVersion}`;
    const model = profile.dModel || profile.dBrand || '未知机型';
    const app = profile.build ? `${profile.clientVersion}(${profile.build})` : profile.clientVersion;
    return `${model} · ${system} · ${app}`;
}

/**
 * 按「下一段以 字段名= 开头」切分。
 * UA 里的 M/5.0、appBuild/171135 不含等号，所以 UA 内部分号不会被误切。
 */
function splitFieldChunks(raw) {
    const chunks = [];
    for (const part of String(raw).split(';')) {
        const head = part.match(/^\s*([A-Za-z][A-Za-z0-9_.\-]{0,40})\s*=/);
        if (head) {
            chunks.push({ name: head[1], value: part.slice(head[0].length) });
        } else if (chunks.length) {
            chunks[chunks.length - 1].value += ';' + part;
        }
    }
    return chunks;
}

/**
 * 分号串解析，支持三种多账号分隔：&、换行、直接接 ;pt_key=
 */
function parseCookieChain(raw) {
    const accounts = [];
    let current = {};
    let currentKey = '';

    const flush = () => {
        if (Object.keys(current).length) accounts.push(current);
        current = {};
        currentKey = '';
    };

    for (const segment of String(raw).split(/[\r\n&]+/)) {
        if (!segment.trim()) continue;
        flush();

        for (const chunk of splitFieldChunks(segment)) {
            const field = canonField(chunk.name);
            if (!field) continue;
            const value = chunk.value.trim();

            if (field === 'ptKey' && currentKey && currentKey !== value) flush();
            if (field === 'ptKey') currentKey = value;
            current[field] = value;
        }
    }

    flush();
    return accounts;
}

function headersFromHarRequest(request) {
    const headers = {};
    for (const header of request.headers || []) {
        if (header && header.name) headers[header.name] = header.value;
    }
    if (!headerValue(headers, 'Cookie') && Array.isArray(request.cookies) && request.cookies.length) {
        headers.Cookie = request.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }
    return headers;
}

function parseHarCookie(raw) {
    let json;
    try {
        json = JSON.parse(raw);
    } catch (e) {
        return [];
    }

    const entries = json && json.log && json.log.entries;
    if (!Array.isArray(entries)) return [];

    const accounts = [];
    for (const entry of entries) {
        if (!entry || !entry.request) continue;
        // HAR 里 request.postData.text 就是 client.action 的 query 串，设备字段在里面
        const postData = entry.request.postData;
        const body = postData && typeof postData.text === 'string' ? postData.text : '';
        const profile = profileFromRequest(headersFromHarRequest(entry.request), body);
        if (profile.ptKey && profile.ptPin) accounts.push(profile);
    }
    return accounts;
}

function parseCurlCookie(raw) {
    const headers = {};
    const headerRe = /(?:-H|--header)\s+(['"])([\s\S]*?)\1/g;
    let match;

    while ((match = headerRe.exec(raw))) {
        const line = match[2];
        const separator = line.indexOf(':');
        if (separator <= 0) continue;
        headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }

    const cookieArg = raw.match(/(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/);
    if (cookieArg && !headerValue(headers, 'Cookie')) headers.Cookie = cookieArg[2];

    // curl -d / --data / --data-raw 里的 query 串同样带设备字段
    const dataArg = raw.match(/(?:--data-raw|--data-binary|--data|-d)\s+(['"])([\s\S]*?)\1/);
    const profile = profileFromRequest(headers, dataArg ? dataArg[2] : '');
    return profile.ptKey && profile.ptPin ? [profile] : [];
}

/**
 * 统一入口：HAR / curl / 分号串
 */
function parseCookieInput(raw) {
    const text = String(raw || '').trim();
    if (!text) return [];
    if (text.charAt(0) === '{') return parseHarCookie(text);
    if (/^curl\b/i.test(text) || /\bcurl\s+-/i.test(text)) return parseCurlCookie(text);
    return parseCookieChain(text);
}

/**
 * 读取该账号缓存的完整设备身份
 */
function readCachedProfile(ptPin) {
    const cached = $.getval(getCacheKeys(ptPin).cookie);
    if (!cached) return null;

    const accounts = parseCookieInput(cached);
    const matched = accounts.find(account => account.ptPin === ptPin);
    return normalizeProfileFields(matched || accounts[0] || null);
}

/**
 * 部分字段缓存：单次 client.action 只带一部分设备字段（uuid 在 startup、
 * eid 在 MessageCenter、wg 藏在 ext 里），需要一个"攒字段"的地方。
 * 独立键存放，不碰 jd_cookie_cache_（那个键只在同步成功后写）。
 */
function partialKeys(ptPin) {
    return { cookie: 'jd_cookie_partial_' + ptPin };
}

function readPartialProfile(ptPin) {
    const raw = $.getval(partialKeys(ptPin).cookie);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return normalizeProfileFields(parsed);
    } catch (e) {
        return null;
    }
}

/**
 * 本次抓包是否带到了设备字段（只有 pt_key/pt_pin 的请求很常见，不能拿它覆盖缓存）
 */
function hasDeviceFields(profile) {    if (!profile) return false;
    return !!(profile.userAgent || profile.uuid || profile.eidToken || profile.wgToken
        || profile.dBrand || profile.dModel || profile.osVersion
        || profile.build || profile.clientVersion);
}

/**
 * 单次 client.action 只带一部分字段：uuid 在 startup、eid 在 MessageCenter、
 * wg 藏在 ext 里……所以每次抓到什么就往缓存里合并什么，只覆盖非空字段，
 * 绝不把已有的好字段抹成空。攒齐 10 个字段后才会真正写青龙。
 */
function mergeIntoCache(ptPin, captured) {
    if (!ptPin || !captured || !hasDeviceFields(captured)) return readPartialProfile(ptPin);

    const keys = partialKeys(ptPin);
    const partialCached = readPartialProfile(ptPin);
    const syncCached = readCachedProfile(ptPin);
    // 优先级：本次抓到的 > 攒了一半的部分缓存 > 上次同步成功的完整值
    const pick = (field) => captured[field]
        || (partialCached && partialCached[field])
        || (syncCached && syncCached[field])
        || '';

    const merged = normalizeProfileFields({
        ptKey: captured.ptKey || (partialCached && partialCached.ptKey) || (syncCached && syncCached.ptKey) || '',
        ptPin: ptPin,
        userAgent: pick('userAgent'),
        uuid: pick('uuid'),
        eidToken: pick('eidToken'),
        wgToken: pick('wgToken'),
        dBrand: pick('dBrand'),
        dModel: pick('dModel'),
        osVersion: pick('osVersion'),
        build: pick('build'),
        clientVersion: pick('clientVersion'),
        openudid: pick('openudid'),
        screen: pick('screen')
    });

    const serialized = JSON.stringify(merged);
    if (serialized !== $.getval(keys.cookie)) {
        $.setval(serialized, keys.cookie);
        $.log(`📥 设备字段缓存已更新 [${ptPin}]`);
    }
    return merged;
}

/**
 * 两个 JD_COOKIE 值是否等价（忽略 h5st、字段顺序、HAR/curl 包装）
 */
function isSameCookieValue(left, right) {
    const a = parseCookieInput(left);
    const b = parseCookieInput(right);
    if (!a.length || !b.length) return false;

    const normalizedA = serializeProfile(normalizeProfileFields(a[0]));
    const normalizedB = serializeProfile(normalizeProfileFields(b[0]));
    return normalizedA === normalizedB && normalizedA !== '';
}

/**
 * 抓包 Cookie 的合法性校验（游客、长度、前缀）
 */
function validateCapturedProfile(profile) {
    if (!profile.ptKey || !profile.ptPin || profile.ptKey.length < 10) {
        return { valid: false, message: 'Invalid cookie format' };
    }
    if (profile.ptKey.startsWith('fake_') || profile.ptPin.toLowerCase() === 'guest') {
        return { valid: false, message: 'Guest cookie detected, skipping sync' };
    }
    return { valid: true };
}

/**
 * 获取缓存键名
 */
function getCacheKeys(ptPin) {
    return {
        cookie: `jd_cookie_cache_${ptPin}`,
        lastUpdate: `jd_cookie_last_update_${ptPin}`,
        lock: `jd_cookie_syncing_${ptPin}`
    };
}

/**
 * 检查是否需要更新（基于缓存和时间间隔）
 */
function shouldUpdate(ptPin, currentCookie, config) {
    const keys = getCacheKeys(ptPin);
    const cachedCookie = $.getval(keys.cookie);
    const lastUpdate = parseInt($.getval(keys.lastUpdate) || '0');
    const bypassFlag = $.getval(CONFIG_KEYS.BYPASS_CHECK);
    const now = Date.now();

    if (bypassFlag === 'true') {
        return { should: true, reason: 'bypass' };
    }

    // Cookie 值变化时立即更新
    if (cachedCookie && cachedCookie !== currentCookie) {
        return { should: true, reason: 'cookie_changed' };
    }

    // 检查更新间隔
    const intervalMs = config.updateInterval * 1000;
    if (now - lastUpdate < intervalMs) {
        return { should: false, reason: 'interval' };
    }

    return { should: true, reason: 'interval_expired' };
}

/**
 * 更新缓存
 */
function updateCache(ptPin, cookie) {
    const keys = getCacheKeys(ptPin);
    $.setval(cookie, keys.cookie);
    $.setval(String(Date.now()), keys.lastUpdate);
}

/**
 * 抢占同步锁，防止京东 App 启动时多个请求并发写入同一账号
 *
 * 持久化存储没有原子的 compare-and-swap，这里只能把竞态窗口从
 * 「整个网络往返（数秒）」压缩到「一次读 + 一次写（微秒级）」。
 * 锁自带 TTL，脚本被 Surge 强杀时不会永久卡死。
 */
function acquireSyncLock(ptPin) {
    const key = getCacheKeys(ptPin).lock;
    const heldAt = parseInt($.getval(key) || '0');

    if (heldAt && Date.now() - heldAt < SYNC_LOCK_TTL) {
        return false;
    }

    $.setval(String(Date.now()), key);
    return true;
}

/**
 * 释放同步锁
 */
function releaseSyncLock(ptPin) {
    $.setval('0', getCacheKeys(ptPin).lock);
}

// ============= HTTP 请求封装 =============

/**
 * 发送 HTTP 请求
 */
function httpRequest(options) {
    const opts = typeof options === 'string' ? { url: options } : options;
    const method = (opts.method || ('body' in opts ? 'post' : 'get')).toLowerCase();
    const timeout = opts._timeout || REQUEST_TIMEOUT;

    if (method !== 'get') {
        opts.method = method.toUpperCase();
    }

    return Promise.race([
        createTimeoutPromise(timeout, opts.url),
        createRequestPromise(opts, method)
    ]);
}

function createTimeoutPromise(timeout, url) {
    return new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`请求超时: ${url}`)), timeout);
    });
}

function createRequestPromise(opts, method) {
    return new Promise((resolve, reject) => {
        const methodFn = method === 'get' ? 'get' : 'post';
        $[methodFn](opts, (error, response, data) => {
            if (error) {
                reject(new Error(typeof error === 'string' ? error : JSON.stringify(error)));
                return;
            }
            if (!response) {
                reject(new Error('无响应'));
                return;
            }
            resolve(response);
        });
    });
}

// ============= 青龙 API 调用 =============

/**
 * 调用青龙 API 并处理响应
 */
async function callQinglongApi(config, token, endpoint, options = {}) {
    const url = `${config.qlUrl}${endpoint}`;
    const headers = {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    };

    const requestOptions = {
        url,
        headers,
        _respType: 'all',
        ...options
    };

    if (options.body) {
        requestOptions.body = JSON.stringify(options.body);
    }

    const response = await httpRequest(requestOptions);
    return JSON.parse(response.body);
}

/**
 * 获取青龙 Token
 */
async function getQinglongToken(config) {
    // 凭证可能包含 & 或 = 等字符，必须编码后再拼进 query string
    const clientId = encodeURIComponent(config.clientId);
    const clientSecret = encodeURIComponent(config.clientSecret);
    const endpoint = `/open/auth/token?client_id=${clientId}&client_secret=${clientSecret}`;

    try {
        const body = await callQinglongApi(config, null, endpoint);

        if (body.code === 200 && body.data?.token) {
            return { success: true, token: body.data.token };
        }

        $.log(`❌ 获取 Token 失败 [${body.code}]: ${body.message || 'Unknown error'}`);
        return { success: false, message: body.message || 'Failed to get token' };
    } catch (error) {
        $.log(`❌ 获取 Token 异常: ${error.message || error}`);
        return { success: false, message: error.message || String(error) };
    }
}

/**
 * 查询青龙环境变量列表
 */
async function getEnvList(config, token) {
    try {
        const body = await callQinglongApi(config, token, '/open/envs?searchValue=JD_COOKIE');

        if (body.code === 200 && body.data) {
            return { success: true, data: body.data };
        }

        $.log(`❌ 查询环境变量失败 [${body.code}]: ${body.message || 'Unknown error'}`);
        return { success: false, message: body.message || 'Failed to get env list' };
    } catch (error) {
        $.log(`❌ 查询环境变量异常: ${error.message || error}`);
        return { success: false, message: error.message || String(error) };
    }
}

/**
 * 删除青龙环境变量
 */
async function deleteEnv(config, token, envId) {
    try {
        const body = await callQinglongApi(config, token, '/open/envs', {
            method: 'DELETE',
            body: [Number(envId)]
        });

        if (body.code === 200) {
            return { success: true };
        }

        $.log(`⚠️ 删除环境变量失败 [${body.code}] (ID=${envId}): ${body.message || 'Unknown error'}`);
        return { success: false, message: body.message || 'Failed to delete env' };
    } catch (error) {
        $.log(`⚠️ 删除环境变量异常 (ID=${envId}): ${error.message || error}`);
        return { success: false, message: error.message || String(error) };
    }
}

/**
 * 新增青龙环境变量
 */
async function addEnv(config, token, name, value, remarks) {
    const data = [{
        name,
        value,
        remarks: remarks || `Added by ${$.getEnv()} at ${new Date().toLocaleString()}`
    }];

    try {
        const body = await callQinglongApi(config, token, '/open/envs', { body: data });

        if (body.code === 200) {
            return { success: true };
        }

        // 检查重复值错误
        const isDuplicate = body.errors?.some(
            err => err.type === 'unique violation' && err.path === 'value'
        );

        if (isDuplicate) {
            return { success: true, isDuplicate: true };
        }

        $.log(`❌ 新增环境变量失败 [${body.code}]: ${body.message || 'Unknown error'}`);
        return { success: false, message: body.message || 'Failed to add env' };
    } catch (error) {
        $.log(`❌ 新增环境变量异常: ${error.message || error}`);
        return { success: false, message: error.message || String(error) };
    }
}

// ============= 环境变量同步逻辑 =============

/**
 * 从环境变量中提取 pt_pin
 */
function extractPtPinFromEnv(env) {
    if (env.name !== 'JD_COOKIE' || !env.value) {
        return null;
    }

    // 环境变量值可能是分号串、HAR 或 curl，pt_pin 在 JSON 字符串里也能被这条正则命中，
    // 所以这里不解析整份输入，避免对几十条 env 做无谓的 JSON 解析
    const match = env.value.match(/pt_pin=([^;&"'\\\s]+)/);
    if (!match) return null;

    try {
        return decodeURIComponent(match[1]);
    } catch (e) {
        return match[1];
    }
}

/**
 * 查找匹配指定 ptPin 的环境变量
 */
function findMatchingEnvs(envList, ptPin) {
    return envList.filter(env => extractPtPinFromEnv(env) === ptPin);
}

/**
 * 获取环境变量 ID
 */
function getEnvId(env) {
    return env._id || env.id;
}

/**
 * 删除多个环境变量（排除指定 ID）
 */
async function deleteEnvsExcept(config, token, envs, excludeId) {
    const targets = envs.filter(env => getEnvId(env) !== excludeId);
    const results = await Promise.all(
        targets.map(env => deleteEnv(config, token, getEnvId(env)))
    );
    const failed = targets.filter((_, i) => !results[i].success);
    if (failed.length > 0) {
        $.log(`⚠️ 清理重复失败 (${failed.length}): ID=${failed.map(e => getEnvId(e)).join(',')}`);
    }
}

/**
 * 删除所有环境变量
 */
async function deleteAllEnvs(config, token, envs) {
    const results = await Promise.all(
        envs.map(env => deleteEnv(config, token, getEnvId(env)))
    );
    const failed = envs.filter((_, i) => !results[i].success);
    if (failed.length > 0) {
        $.log(`⚠️ 删除失败 (${failed.length}/${envs.length}): ID=${failed.map(e => getEnvId(e)).join(',')}`);
    }
    return failed.length === 0;
}

/**
 * 处理已存在的环境变量
 */
async function handleExistingEnvs(config, token, existingEnvs, cookie, ptPin) {
    // 按字段等价比较，而不是按字符串相等：
    // 手工粘贴的 HAR / curl / 少了设备字段的旧值都要能与目标值判为同一份身份
    const exactMatch = existingEnvs.find(env => isSameCookieValue(env.value, cookie));

    // 只有一个且值相同，无需操作
    if (exactMatch && existingEnvs.length === 1) {
        return { success: true, noChange: true };
    }

    // 有值相同的但存在重复，清理多余的
    if (exactMatch) {
        $.log(`🧹 清理 ${existingEnvs.length - 1} 个重复环境变量 [${ptPin}]`);
        await deleteEnvsExcept(config, token, existingEnvs, getEnvId(exactMatch));
        return { success: true, noChange: true };
    }

    // 没有值匹配：先新增再删除旧的
    // 顺序不可颠倒——先删后加时，脚本若在两步之间被终止会导致 JD_COOKIE 彻底丢失
    $.log(`🔄 Cookie 已变化，更新中 [${ptPin}]`);
    const addResult = await addEnv(config, token, 'JD_COOKIE', cookie, `Account: ${ptPin}`);

    if (!addResult.success) {
        $.log(`⚠️ 新增失败，保留旧环境变量等待重试 [${ptPin}]`);
        return addResult;
    }

    // isDuplicate 表示新值已被别处占用，本次并未真正写入 JD_COOKIE，删除旧的会导致该账号无变量可用
    if (addResult.isDuplicate) {
        $.log(`⚠️ 新值已存在于其他环境变量，跳过清理 [${ptPin}]`);
        return addResult;
    }

    await deleteAllEnvs(config, token, existingEnvs);
    return addResult;
}

/**
 * 清除绕过检查标志
 */
function clearBypassFlag() {
    if ($.getval(CONFIG_KEYS.BYPASS_CHECK) === 'true') {
        $.setval('false', CONFIG_KEYS.BYPASS_CHECK);
    }
}

/**
 * 同步 Cookie 到青龙
 */
async function syncToQinglong(cookie, ptPin, profile) {
    const config = getConfig();

    // 检查是否需要更新
    const updateCheck = shouldUpdate(ptPin, cookie, config);
    if (!updateCheck.should) {
        return;
    }

    // 检查配置
    const configCheck = validateConfig(config);
    if (!configCheck.valid) {
        $.msg('JD Cookie Sync', '配置错误', configCheck.message);
        return;
    }

    // 抢占同步锁，避免并发触发时互相覆盖/删除对方刚写入的变量
    if (!acquireSyncLock(ptPin)) {
        $.log(`⏭️ 同步进行中，跳过 [${ptPin}]`);
        return;
    }

    try {
        // 获取 Token
        const tokenResult = await getQinglongToken(config);
        if (!tokenResult.success) {
            $.msg('JD Cookie Sync', '获取 Token 失败', tokenResult.message);
            return;
        }

        // 查询现有环境变量
        const envListResult = await getEnvList(config, tokenResult.token);
        if (!envListResult.success) {
            $.msg('JD Cookie Sync', '查询环境变量失败', envListResult.message);
            return;
        }

        // 处理环境变量同步
        const existingEnvs = findMatchingEnvs(envListResult.data, ptPin);
        let result;

        if (existingEnvs.length > 0) {
            result = await handleExistingEnvs(config, tokenResult.token, existingEnvs, cookie, ptPin);
        } else {
            $.log(`➕ 新增账号 [${ptPin}]`);
            result = await addEnv(config, tokenResult.token, 'JD_COOKIE', cookie, `Account: ${ptPin}`);
        }

        if (result.success) {
            updateCache(ptPin, cookie);
            clearBypassFlag();
            if (result.noChange) {
                $.log(`⏭️ 无需更新 [${ptPin}]`);
            } else if (result.isDuplicate) {
                $.log(`⏭️ 值已存在 [${ptPin}]`);
            } else {
                $.log(`✅ 同步成功 [${ptPin}]`);
                $.log(`📱 ${describeProfile(profile)}`);
                $.msg('JD Cookie Sync', '✅ 同步成功', `账号: ${ptPin}\n设备: ${describeProfile(profile)}\n已同步到青龙面板`);
            }
        } else {
            $.log(`❌ 同步失败 [${ptPin}]: ${result.message}`);
            $.msg('JD Cookie Sync', '❌ 同步失败', result.message);
        }
    } finally {
        releaseSyncLock(ptPin);
    }
}

// ============= 手动导入（HAR / curl / 分号串） =============

/**
 * $argument 形如 push 或 push:<粘贴内容>。
 * 内容太长不适合塞进模块参数时，也可以先把文本写进 jd_import_payload 再传 push。
 */
function readImportPayload() {
    if (typeof $argument !== 'string') return '';
    const match = /^\s*push(?:\s*[:=]\s*([\s\S]*))?$/i.exec($argument);
    if (!match) return '';
    const inline = (match[1] || '').trim();
    return inline || String($.getval(IMPORT_PAYLOAD_KEY) || '').trim();
}

async function runManualImport(payload) {
    const accounts = parseCookieInput(payload);

    if (!accounts.length) {
        $.log('❌ 导入失败：没有解析出 pt_key / pt_pin');
        $.msg('JD Cookie Sync', '导入失败', '确认粘贴的是 HAR、curl 命令或分号串，且包含 pt_key 与 pt_pin');
        return;
    }

    let synced = 0;
    const skipped = [];

    for (const account of accounts) {
        const captured = normalizeProfileFields(account);
        const check = validateCapturedProfile(captured);
        if (!check.valid) {
            skipped.push(`${captured.ptPin || '未知账号'}（${check.message}）`);
            continue;
        }

        const resolved = resolveProfile(captured, readCachedProfile(captured.ptPin));
        if (!resolved.complete) {
            const labels = resolved.missing.map(field => FIELD_LABELS[field]).join(',');
            $.log(`⏭️ 设备字段不全，跳过 [${captured.ptPin}]: ${labels || resolved.reason}`);
            skipped.push(`${captured.ptPin}（缺 ${labels || resolved.reason}）`);
            continue;
        }

        await syncToQinglong(serializeProfile(resolved.profile), resolved.profile.ptPin, resolved.profile);
        synced += 1;
    }

    $.log(`➕ 手动导入：成功 ${synced} 个，跳过 ${skipped.length} 个`);
    if (skipped.length) {
        $.log(`⏭️ 跳过清单: ${skipped.join('; ')}`);
        $.msg('JD Cookie Sync', `导入完成（${synced} 成功 / ${skipped.length} 跳过）`, skipped.join('\n'));
    }
}

// ============= 主函数 =============

(async () => {
    try {
        // 手动导入模式：不依赖抓包，直接解析 HAR / curl / 分号串
        const importPayload = readImportPayload();
        if (importPayload) {
            await runManualImport(importPayload);
            return;
        }

        const headers = $request.headers;

        // 只处理京东主 App 的请求（原生网络栈 JD4iPhone / App 内 H5 jdapp;），
        // 过滤浏览器与第三方客户端
        const userAgent = headerValue(headers, 'User-Agent');
        if (!JD_APP_UA_RE.test(userAgent)) {
            $.done({});
            return;
        }

        // 设备字段在 client.action 的 POST body 里，请求头里没有：
        // 只读 headers 会永远缺 uuid / eid / wg / 机型 / 系统版本
        const captured = profileFromRequest(headers, typeof $request.body === 'string' ? $request.body : '');
        const capturedCheck = validateCapturedProfile(captured);
        if (!capturedCheck.valid) {
            $.done({});
            return;
        }

        // 默认保留抓到的原值——那是京东服务器刚刚接受过的完整凭证。
        // 老签到脚本若只认 AAJ 开头的经典格式，置 jd_strip_app_open=true 去掉前缀。
        if (captured.ptKey.startsWith(APP_OPEN_PREFIX) && $.getval(CONFIG_KEYS.STRIP_APP_OPEN) === 'true') {
            captured.ptKey = captured.ptKey.slice(APP_OPEN_PREFIX.length);
            if (captured.ptKey.length < 10) {
                $.done({});
                return;
            }
            $.log(`🧹 已去除 pt_key 的 ${APP_OPEN_PREFIX} 前缀`);
        }

        // 单次请求只带一部分设备字段（uuid 在 startup、eid 在 MessageCenter），
        // 先按字段合并进缓存，攒齐了再同步；补不齐就跳过——半截设备身份比没有更危险
        const mergedCache = mergeIntoCache(captured.ptPin, captured);
        const resolved = resolveProfile(captured, mergedCache);

        if (!resolved.complete) {
            const labels = resolved.missing.map(field => FIELD_LABELS[field]).join(',');
            $.log(`⏭️ 设备字段不全，跳过 [${captured.ptPin}]: ${labels || resolved.reason}`);
            // 只打头名不打值：这是判断「抓包环境到底给了什么」的唯一线索，
            // 没有它就只能猜是规则没命中还是字段被丢弃。
            $.log(`🔍 本次请求头字段: ${describeHeaderNames(headers)}`);
            notifySkipOnce(captured.ptPin, labels || resolved.reason, describeHeaderNames(headers));
            $.done({});
            return;
        }

        // 同步到青龙
        await syncToQinglong(serializeProfile(resolved.profile), resolved.profile.ptPin, resolved.profile);

    } catch (error) {
        $.log(`❌ 脚本执行异常: ${error.message || error}`);
        $.msg('JD Cookie Sync', '脚本执行异常', String(error));
    } finally {
        $.done({});
    }
})();

// ============= 环境适配器 =============

function Env(t, e) { class s { constructor(t) { this.env = t } send(t, e = "GET") { t = "string" == typeof t ? { url: t } : t; let s = this.get; "POST" === e && (s = this.post); const i = new Promise(((e, i) => { s.call(this, t, ((t, s, o) => { t ? i(t) : e(s) })) })); return t.timeout ? ((t, e = 1e3) => Promise.race([t, new Promise(((t, s) => { setTimeout((() => { s(new Error("请求超时")) }), e) }))]))(i, t.timeout) : i } get(t) { return this.send.call(this.env, t) } post(t) { return this.send.call(this.env, t, "POST") } } return new class { constructor(t, e) { this.logLevels = { debug: 0, info: 1, warn: 2, error: 3 }, this.logLevelPrefixs = { debug: "[DEBUG] ", info: "[INFO] ", warn: "[WARN] ", error: "[ERROR] " }, this.logLevel = "info", this.name = t, this.http = new s(this), this.data = null, this.dataFile = "box.dat", this.logs = [], this.isMute = !1, this.isNeedRewrite = !1, this.logSeparator = "\n", this.encoding = "utf-8", this.startTime = (new Date).getTime(), Object.assign(this, e), this.log("", `🔔${this.name}, 开始!`) } getEnv() { return "undefined" != typeof $environment && $environment["surge-version"] ? "Surge" : "undefined" != typeof $environment && $environment["stash-version"] ? "Stash" : "undefined" != typeof module && module.exports ? "Node.js" : "undefined" != typeof $task ? "Quantumult X" : "undefined" != typeof $loon ? "Loon" : "undefined" != typeof $rocket ? "Shadowrocket" : void 0 } isNode() { return "Node.js" === this.getEnv() } isQuanX() { return "Quantumult X" === this.getEnv() } isSurge() { return "Surge" === this.getEnv() } isLoon() { return "Loon" === this.getEnv() } isShadowrocket() { return "Shadowrocket" === this.getEnv() } isStash() { return "Stash" === this.getEnv() } toObj(t, e = null) { try { return JSON.parse(t) } catch { return e } } toStr(t, e = null, ...s) { try { return JSON.stringify(t, ...s) } catch { return e } } getjson(t, e) { let s = e; if (this.getdata(t)) try { s = JSON.parse(this.getdata(t)) } catch { } return s } setjson(t, e) { try { return this.setdata(JSON.stringify(t), e) } catch { return !1 } } getScript(t) { return new Promise((e => { this.get({ url: t }, ((t, s, i) => e(i))) })) } runScript(t, e) { return new Promise((s => { let i = this.getdata("@chavy_boxjs_userCfgs.httpapi"); i = i ? i.replace(/\n/g, "").trim() : i; let o = this.getdata("@chavy_boxjs_userCfgs.httpapi_timeout"); o = o ? 1 * o : 20, o = e && e.timeout ? e.timeout : o; const [r, a] = i.split("@"), n = { url: `http://${a}/v1/scripting/evaluate`, body: { script_text: t, mock_type: "cron", timeout: o }, headers: { "X-Key": r, Accept: "*/*" }, policy: "DIRECT", timeout: o }; this.post(n, ((t, e, i) => s(i))) })).catch((t => this.logErr(t))) } loaddata() { if (!this.isNode()) return {}; { this.fs = this.fs ? this.fs : require("fs"), this.path = this.path ? this.path : require("path"); const t = this.path.resolve(this.dataFile), e = this.path.resolve(process.cwd(), this.dataFile), s = this.fs.existsSync(t), i = !s && this.fs.existsSync(e); if (!s && !i) return {}; { const i = s ? t : e; try { return JSON.parse(this.fs.readFileSync(i)) } catch (t) { return {} } } } } writedata() { if (this.isNode()) { this.fs = this.fs ? this.fs : require("fs"), this.path = this.path ? this.path : require("path"); const t = this.path.resolve(this.dataFile), e = this.path.resolve(process.cwd(), this.dataFile), s = this.fs.existsSync(t), i = !s && this.fs.existsSync(e), o = JSON.stringify(this.data); s ? this.fs.writeFileSync(t, o) : i ? this.fs.writeFileSync(e, o) : this.fs.writeFileSync(t, o) } } lodash_get(t, e, s) { const i = e.replace(/\[(\d+)\]/g, ".$1").split("."); let o = t; for (const t of i) if (o = Object(o)[t], void 0 === o) return s; return o } lodash_set(t, e, s) { return Object(t) !== t || (Array.isArray(e) || (e = e.toString().match(/[^.[\]]+/g) || []), e.slice(0, -1).reduce(((t, s, i) => Object(t[s]) === t[s] ? t[s] : t[s] = Math.abs(e[i + 1]) >> 0 == +e[i + 1] ? [] : {}), t)[e[e.length - 1]] = s), t } getdata(t) { let e = this.getval(t); if (/^@/.test(t)) { const [, s, i] = /^@(.*?)\.(.*?)$/.exec(t), o = s ? this.getval(s) : ""; if (o) try { const t = JSON.parse(o); e = t ? this.lodash_get(t, i, "") : e } catch (t) { e = "" } } return e } setdata(t, e) { let s = !1; if (/^@/.test(e)) { const [, i, o] = /^@(.*?)\.(.*?)$/.exec(e), r = this.getval(i), a = i ? "null" === r ? null : r || "{}" : "{}"; try { const e = JSON.parse(a); this.lodash_set(e, o, t), s = this.setval(JSON.stringify(e), i) } catch (e) { const r = {}; this.lodash_set(r, o, t), s = this.setval(JSON.stringify(r), i) } } else s = this.setval(t, e); return s } getval(t) { switch (this.getEnv()) { case "Surge": case "Loon": case "Stash": case "Shadowrocket": return $persistentStore.read(t); case "Quantumult X": return $prefs.valueForKey(t); case "Node.js": return this.data = this.loaddata(), this.data[t]; default: return this.data && this.data[t] || null } } setval(t, e) { switch (this.getEnv()) { case "Surge": case "Loon": case "Stash": case "Shadowrocket": return $persistentStore.write(t, e); case "Quantumult X": return $prefs.setValueForKey(t, e); case "Node.js": return this.data = this.loaddata(), this.data[e] = t, this.writedata(), !0; default: return this.data && this.data[e] || null } } initGotEnv(t) { this.got = this.got ? this.got : require("got"), this.cktough = this.cktough ? this.cktough : require("tough-cookie"), this.ckjar = this.ckjar ? this.ckjar : new this.cktough.CookieJar, t && (t.headers = t.headers ? t.headers : {}, t && (t.headers = t.headers ? t.headers : {}, void 0 === t.headers.cookie && void 0 === t.headers.Cookie && void 0 === t.cookieJar && (t.cookieJar = this.ckjar))) } get(t, e = (() => { })) { switch (t.headers && (delete t.headers["Content-Type"], delete t.headers["Content-Length"], delete t.headers["content-type"], delete t.headers["content-length"]), t.params && (t.url += "?" + this.queryStr(t.params)), void 0 === t.followRedirect || t.followRedirect || ((this.isSurge() || this.isLoon()) && (t["auto-redirect"] = !1), this.isQuanX() && (t.opts ? t.opts.redirection = !1 : t.opts = { redirection: !1 })), this.getEnv()) { case "Surge": case "Loon": case "Stash": case "Shadowrocket": default: this.isSurge() && this.isNeedRewrite && (t.headers = t.headers || {}, Object.assign(t.headers, { "X-Surge-Skip-Scripting": !1 })), $httpClient.get(t, ((t, s, i) => { !t && s && (s.body = i, s.statusCode = s.status ? s.status : s.statusCode, s.status = s.statusCode), e(t, s, i) })); break; case "Quantumult X": this.isNeedRewrite && (t.opts = t.opts || {}, Object.assign(t.opts, { hints: !1 })), $task.fetch(t).then((t => { const { statusCode: s, statusCode: i, headers: o, body: r, bodyBytes: a } = t; e(null, { status: s, statusCode: i, headers: o, body: r, bodyBytes: a }, r, a) }), (t => e(t && t.error || "UndefinedError"))); break; case "Node.js": let s = require("iconv-lite"); this.initGotEnv(t), this.got(t).on("redirect", ((t, e) => { try { if (t.headers["set-cookie"]) { const s = t.headers["set-cookie"].map(this.cktough.Cookie.parse).toString(); s && this.ckjar.setCookieSync(s, null), e.cookieJar = this.ckjar } } catch (t) { this.logErr(t) } })).then((t => { const { statusCode: i, statusCode: o, headers: r, rawBody: a } = t, n = s.decode(a, this.encoding); e(null, { status: i, statusCode: o, headers: r, rawBody: a, body: n }, n) }), (t => { const { message: i, response: o } = t; e(i, o, o && s.decode(o.rawBody, this.encoding)) })); break } } post(t, e = (() => { })) { const s = t.method ? t.method.toLocaleLowerCase() : "post"; switch (t.body && t.headers && !t.headers["Content-Type"] && !t.headers["content-type"] && (t.headers["content-type"] = "application/x-www-form-urlencoded"), t.headers && (delete t.headers["Content-Length"], delete t.headers["content-length"]), void 0 === t.followRedirect || t.followRedirect || ((this.isSurge() || this.isLoon()) && (t["auto-redirect"] = !1), this.isQuanX() && (t.opts ? t.opts.redirection = !1 : t.opts = { redirection: !1 })), this.getEnv()) { case "Surge": case "Loon": case "Stash": case "Shadowrocket": default: this.isSurge() && this.isNeedRewrite && (t.headers = t.headers || {}, Object.assign(t.headers, { "X-Surge-Skip-Scripting": !1 })), $httpClient[s](t, ((t, s, i) => { !t && s && (s.body = i, s.statusCode = s.status ? s.status : s.statusCode, s.status = s.statusCode), e(t, s, i) })); break; case "Quantumult X": t.method = s, this.isNeedRewrite && (t.opts = t.opts || {}, Object.assign(t.opts, { hints: !1 })), $task.fetch(t).then((t => { const { statusCode: s, statusCode: i, headers: o, body: r, bodyBytes: a } = t; e(null, { status: s, statusCode: i, headers: o, body: r, bodyBytes: a }, r, a) }), (t => e(t && t.error || "UndefinedError"))); break; case "Node.js": let i = require("iconv-lite"); this.initGotEnv(t); const { url: o, ...r } = t; this.got[s](o, r).then((t => { const { statusCode: s, statusCode: o, headers: r, rawBody: a } = t, n = i.decode(a, this.encoding); e(null, { status: s, statusCode: o, headers: r, rawBody: a, body: n }, n) }), (t => { const { message: s, response: o } = t; e(s, o, o && i.decode(o.rawBody, this.encoding)) })); break } } time(t, e = null) { const s = e ? new Date(e) : new Date; let i = { "M+": s.getMonth() + 1, "d+": s.getDate(), "H+": s.getHours(), "m+": s.getMinutes(), "s+": s.getSeconds(), "q+": Math.floor((s.getMonth() + 3) / 3), S: s.getMilliseconds() }; /(y+)/.test(t) && (t = t.replace(RegExp.$1, (s.getFullYear() + "").substr(4 - RegExp.$1.length))); for (let e in i) new RegExp("(" + e + ")").test(t) && (t = t.replace(RegExp.$1, 1 == RegExp.$1.length ? i[e] : ("00" + i[e]).substr(("" + i[e]).length))); return t } queryStr(t) { let e = ""; for (const s in t) { let i = t[s]; null != i && "" !== i && ("object" == typeof i && (i = JSON.stringify(i)), e += `${s}=${i}&`) } return e = e.substring(0, e.length - 1), e } msg(e = t, s = "", i = "", o = {}) { const r = t => { const { $open: e, $copy: s, $media: i, $mediaMime: o } = t; switch (typeof t) { case void 0: return t; case "string": switch (this.getEnv()) { case "Surge": case "Stash": default: return { url: t }; case "Loon": case "Shadowrocket": return t; case "Quantumult X": return { "open-url": t }; case "Node.js": return }case "object": switch (this.getEnv()) { case "Surge": case "Stash": case "Shadowrocket": default: { const r = {}; let a = t.openUrl || t.url || t["open-url"] || e; a && Object.assign(r, { action: "open-url", url: a }); let n = t["update-pasteboard"] || t.updatePasteboard || s; if (n && Object.assign(r, { action: "clipboard", text: n }), i) { let t, e, s; if (i.startsWith("http")) t = i; else if (i.startsWith("data:")) { const [t] = i.split(";"), [, o] = i.split(","); e = o, s = t.replace("data:", "") } else { e = i, s = (t => { const e = { JVBERi0: "application/pdf", R0lGODdh: "image/gif", R0lGODlh: "image/gif", iVBORw0KGgo: "image/png", "/9j/": "image/jpg" }; for (var s in e) if (0 === t.indexOf(s)) return e[s]; return null })(i) } Object.assign(r, { "media-url": t, "media-base64": e, "media-base64-mime": o ?? s }) } return Object.assign(r, { "auto-dismiss": t["auto-dismiss"], sound: t.sound }), r } case "Loon": { const s = {}; let o = t.openUrl || t.url || t["open-url"] || e; o && Object.assign(s, { openUrl: o }); let r = t.mediaUrl || t["media-url"]; return i?.startsWith("http") && (r = i), r && Object.assign(s, { mediaUrl: r }), console.log(JSON.stringify(s)), s } case "Quantumult X": { const o = {}; let r = t["open-url"] || t.url || t.openUrl || e; r && Object.assign(o, { "open-url": r }); let a = t["media-url"] || t.mediaUrl; i?.startsWith("http") && (a = i), a && Object.assign(o, { "media-url": a }); let n = t["update-pasteboard"] || t.updatePasteboard || s; return n && Object.assign(o, { "update-pasteboard": n }), console.log(JSON.stringify(o)), o } case "Node.js": return }default: return } }; if (!this.isMute) switch (this.getEnv()) { case "Surge": case "Loon": case "Stash": case "Shadowrocket": default: $notification.post(e, s, i, r(o)); break; case "Quantumult X": $notify(e, s, i, r(o)); break; case "Node.js": break }if (!this.isMuteLog) { let t = ["", "==============📣系统通知📣=============="]; t.push(e), s && t.push(s), i && t.push(i), console.log(t.join("\n")), this.logs = this.logs.concat(t) } } debug(...t) { this.logLevels[this.logLevel] <= this.logLevels.debug && (t.length > 0 && (this.logs = [...this.logs, ...t]), console.log(`${this.logLevelPrefixs.debug}${t.map((t => t ?? String(t))).join(this.logSeparator)}`)) } info(...t) { this.logLevels[this.logLevel] <= this.logLevels.info && (t.length > 0 && (this.logs = [...this.logs, ...t]), console.log(`${this.logLevelPrefixs.info}${t.map((t => t ?? String(t))).join(this.logSeparator)}`)) } warn(...t) { this.logLevels[this.logLevel] <= this.logLevels.warn && (t.length > 0 && (this.logs = [...this.logs, ...t]), console.log(`${this.logLevelPrefixs.warn}${t.map((t => t ?? String(t))).join(this.logSeparator)}`)) } error(...t) { this.logLevels[this.logLevel] <= this.logLevels.error && (t.length > 0 && (this.logs = [...this.logs, ...t]), console.log(`${this.logLevelPrefixs.error}${t.map((t => t ?? String(t))).join(this.logSeparator)}`)) } log(...t) { t.length > 0 && (this.logs = [...this.logs, ...t]), console.log(`[${this.name}] ${t.map((t => t ?? String(t))).join(this.logSeparator)}`) } logErr(t, e) { switch (this.getEnv()) { case "Surge": case "Loon": case "Stash": case "Shadowrocket": case "Quantumult X": default: this.log("", `❗️${this.name}, 错误!`, e, t); break; case "Node.js": this.log("", `❗️${this.name}, 错误!`, e, void 0 !== t.message ? t.message : t, t.stack); break } } wait(t) { return new Promise((e => setTimeout(e, t))) } done(t = {}) { const e = ((new Date).getTime() - this.startTime) / 1e3; switch (this.log("", `🔔${this.name}, 结束! 🕛 ${e} 秒`), this.log(), this.getEnv()) { case "Surge": case "Loon": case "Stash": case "Shadowrocket": case "Quantumult X": default: $done(t); break; case "Node.js": process.exit(1) } } }(t, e) }
