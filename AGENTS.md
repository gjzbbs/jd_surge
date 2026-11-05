# AGENTS.md

Surge / Quantumult X proxy scripts that scrape JD (京东) cookies from intercepted app traffic and push them into a Qinglong (青龙) panel as `JD_COOKIE` env vars.

## Build, test, CI

No bundler, no linter, no CI. `package.json` exists **only** to pin the test command — the shipped scripts have zero dependencies and are deployed by raw GitHub URL, never from `node_modules`.

```sh
npm test          # node --test test/*.test.js  (94 tests, ~6s, no deps)
```

Run the glob, not bare `node --test`: Node treats every `.js` under `test/` as a test file, so `test/helpers/harness.js` would run as a phantom empty test.

The suite runs the real scripts inside a `vm` sandbox with stubbed `$request` / `$persistentStore` / `$httpClient`, so it exercises actual behaviour rather than mirroring it. It covers the sync-flow invariants below, plus static checks that fail when the trigger regex, remote URLs, or timeout budgets drift apart. Every test was verified to fail when its target bug is reintroduced.

**Harness gotcha:** `Env.post()` dispatches on `$httpClient[opts.method.toLowerCase()]`, so a DELETE lands on `$httpClient.delete`, not `.post`. A stub that only defines `post` yields `$httpClient[s] is not a function` — a fake failure that looks like a code bug.

Tests cannot prove on-device behaviour. Before pushing, still verify manually:
1. Install/reload the module in Surge (or QX), open the JD app.
2. Surge → 首页 → 最近请求 → find `api.m.jd.com` → read script logs.

Logs are the only on-device debugging channel. Keep the emoji log convention (✅ ❌ ⚠️ 🔄 🧹 ⏭️ ➕) — it is how users grep the log pane.

## Deployment is live and unversioned

Consumers install by raw GitHub URL from `main`:
`https://raw.githubusercontent.com/gjzbbs/jd_surge/main/<file>`

A push to `main` reaches every user on their next module refresh. There is no staging branch and no release tag. Treat `main` as production.

## Files and how they load

| File | Role |
|---|---|
| `jd_cookie_sync.js` | Main script. Runs as Surge `type=http-request` on every matching JD API call. Reads `$request.headers` **and** `$request.body` (`requires-body=1`) — the device fingerprint lives in the POST body query string, not in headers. |
| `config_helper.js` | Panel/manual utility. Dispatches on `$argument`: `smart-check`, `clear`, `clear-cache`. |
| `jd_cookie_sync.sgmodule` | Surge module: script binding + `[MITM] hostname = %APPEND% api.m.jd.com`. |
| `jd_cookie_sync.snippet` | QX equivalent (`url script-request-body` — QX must read the body, `script-request-header` cannot see it). Must stay in sync with the sgmodule's regex. |
| `config_panel.sgmodule` | Optional Surge panel. Wires only `smart-check` and `clear-cache`. |
| `Scripts/QuantumultX/*.js` | 12-line QX loader stubs that `eval()` a remote `config_helper.js` — see gotcha below. |

Scripts are standalone: **no imports, no modules, no bundler**. Each file ends with a single-line minified vendored `Env()` adapter — always the last line, so find it with `grep -n '^function Env'` rather than trusting a line number. The two blobs are byte-identical. **Never hand-edit that line** — replace wholesale if it must change, and change both.

## Gotchas that cost time

**`Env` exposes only `$.get()` and `$.post()`.** There is no `$.delete()`/`$.put()`. Non-GET requests go through `post` with the real verb in `opts.method` — see `httpRequest()` in `jd_cookie_sync.js`. (`CLAUDE.md` claims all verbs are natively supported; that is wrong — commit `a35322c` fixed exactly this bug.)

**QX loader stubs `eval()` a remote file.** `Scripts/QuantumultX/*.js` fetch `config_helper.js` from `gjzbbs/jd_surge@main` at runtime — they carry no logic of their own beyond setting `$argument`. They previously pointed at a `W-Webber/jd_surge@feature-qx` fork, so QX panel users never received changes made here; if you see that fork URL reappear, it is a regression.

**Trigger regex lives in two files.** `jd_cookie_sync.sgmodule` and `jd_cookie_sync.snippet` each hardcode
`^https?:\/\/api\.m\.jd\.com\/client\.action`. Change one → change the other.

Do **not** put a `functionId=` allowlist back into that regex. JD moved `functionId` out of the URL query string and into the POST request body before 2026-09; the URL is now bare `/client.action?`. With a functionId allowlist the rule matched **zero** requests, and QX/Surge report no error for that — it just looks like "nothing is being captured". That silent failure is issue #6. The script now does its own filtering on `User-Agent` + `Cookie` instead. Tests `触发正则不依赖 URL 里的 functionId` and `触发正则能匹配 2026-09 抓包里的真实 URL 形态` enforce this.

**All accounts share the name `JD_COOKIE`.** There is no `JD_COOKIE_2`/`_3`. Identity is the `pt_pin` parsed out of the env `value` (`extractPtPinFromEnv`). The README's multi-numbered-variable claim is stale — do not "restore" it.

**Qinglong `DELETE /open/envs` requires an integer array**, e.g. `[28, 29]`. String IDs fail with a type error. Hence `Number(envId)` in `deleteEnv`.

**Duplicate-value rejection is success.** Adding an env whose value already exists returns `code: 400` with `errors[].type === 'unique violation'` on `path: 'value'`. Treat as synced, no user notification.

**`_respType: 'all'`** is required on Qinglong calls to get the raw `response.body` back for `JSON.parse`.

**Cache is written only after a confirmed sync** (`updateCache` runs inside the success branch). Do not hoist it — commit `1a2d203` fixed that ordering. Note this removed the original concurrency guard; that job now belongs to the sync lock below, so do not re-solve it by hoisting the cache write again.

**Sync order is add-then-delete, and must stay that way.** `handleExistingEnvs` adds the new `JD_COOKIE` *before* deleting stale ones. Reversing it reintroduces a window where a killed script leaves the account with zero cookies in Qinglong. Two follow-on rules: if `addEnv` fails, keep the old envs and return early; if it returns `isDuplicate`, the new value landed on some *other* env row, so skip the cleanup or the account ends up with nothing.

**One sync at a time per account.** `acquireSyncLock` / `releaseSyncLock` use `jd_cookie_syncing_{ptPin}` with a `SYNC_LOCK_TTL` expiry, released in a `finally`. The persistent store has no atomic compare-and-swap, so this only narrows the race from a multi-second network round-trip to a single read+write — it is not a true mutex. The TTL exists because Surge can kill the script mid-flight; without it a crashed run would wedge the account forever. The trigger regex now matches every `/client.action` call (JD app launch fires many concurrently), so this path is exercised constantly.

**Timeout budgets must nest.** `REQUEST_TIMEOUT` (6s, `jd_cookie_sync.js`) must stay well under the sgmodule's `timeout=20`, because a full sync is up to 4 serial round-trips. When the module value was `10`, the internal timeout could never fire — Surge killed the script first, landing it in exactly the interrupted-write window described above. Change one, re-check the other.

## Runtime constraints

- Persistent store cannot be enumerated. "Clear cache" therefore sets a `jd_bypass_interval_check = 'true'` flag that the next run consumes and resets, rather than deleting per-`pt_pin` keys.
- Every entrypoint must terminate with `$.done({})` / `$.done()`, including the error path (`finally` block).
- Surge supplies `$argument` from the sgmodule `argument=`; the QX stubs declare it as a `const` before `eval`.

## Skip conditions in the main script (do not remove)

1. `User-Agent` must match `^(?:JD4iPhone|jdapp;)/i` — filters out browsers and third-party clients. Both prefixes are real JD-app UAs seen in the 2026-09 capture: `JD4iPhone/16.0.0 CFNetwork/...` (native stack, replaces the old `JD4iPhone/167783 (iPhone;...)` form) and `jdapp;iPhone;16.0.0;;;M/5.0;...` (in-app H5 / `pro.m.jd.com`). Dropping the `jdapp;` branch loses roughly a third of the cookie-bearing requests.
2. Guest cookies rejected: `pt_key` starting with `fake_`, or `pt_pin` equal to `guest`.
3. Time-interval throttle, default 1800s via `ql_update_interval`; bypassed when the cookie value actually changed, or when the bypass flag is set.
4. Profile incomplete after merging the per-`pt_pin` cache — log `⏭️ 设备字段不全，跳过 [pin]: …` and stop. Never push a half-filled fingerprint; a wrong `uuid`/`eid` pair is worse than no update.

## JD_COOKIE carries a device fingerprint, not just pt_key/pt_pin

The env value pushed to Qinglong is a semicolon chain in a fixed order:

```
pt_key=…;pt_pin=…;User-Agent=jdapp;…;uuid=…;x-api-eid-token=…;wg-sdk-token=…;d_brand=…;d_model=…;osVersion=…;build=…;clientVersion=…
```

`SERIALIZE_ORDER` in `jd_cookie_sync.js` is the single source of that order; `serializeProfile()` walks it. Do not hand-build this string anywhere else.

- **Where the fields actually live.** Almost none of the fingerprint is in the request headers: on the real 2026-11 capture, 0 of 11 `client.action` requests carried `uuid` / `x-api-eid-token` / `wg-sdk-token` / `d_brand` / `d_model` / `osVersion` / `build` as headers. They are query parameters in the POST **body** (`wg-sdk-token` is nested as `ext` JSON's `sdkToken`). Hence `requires-body=1` in the sgmodule and `script-request-body` in the QX snippet; `profileFromRequest(headers, body)` reads both, `parseRequestBody()` accepts either a query string or JSON. A single call only carries a few of them, so they accumulate per field into `jd_cookie_partial_{ptPin}`.
- **Ciphertext is treated as absent.** `R4iSK…` values (`isCipherValue()`) are dropped — JD encrypts `uuid`, `osVersion`, `d_brand`, `d_model`, `screen` on many endpoints. For `osVersion` the UA's `os/17.3` segment recovers it; for `uuid` with no plaintext and no cache, `finalizeProfile()` derives a stable 32-hex value from `pt_pin` (`deriveUuid()`). Derive **after** cache lookup, never inside `normalizeProfileFields()`, or the derived value shadows a uuid that was actually captured.
- **Input** can be a HAR (`log.entries[].request` — headers **and** `postData.text`), a `curl` command (the `-d`/`--data-raw` body is parsed too), or the semicolon form itself. `parseCookieInput()` detects and dispatches; every path funnels into `profileFromRequest()`/`parseCookieChain()`, so all three shapes must stay equivalent (there is a test for exactly that).
- **The `User-Agent` value is not escaped.** JD app UAs are full of semicolons (`jdapp;iPhone;16.1.50;;;M/5.0;appBuild/171135`), so the chain is split on `;<known field>=`, never on bare `;`. `splitFieldChunks()` does this with a lookahead over `FIELD_ALIASES`.
- **Field aliases are collapsed but never rewritten silently.** `FIELD_ALIASES` maps capture names (`x-api-eid-token`, `wg-sdk-token`) and short names (`eid_token`, `wg_token`) onto one canonical key; `canonField()` is case/`-`/`_` insensitive.
- **`osVersion` is allowlisted.** `OS_ALLOWLIST` = iOS 13–19 + 26–27, Android 10–16. Anything else is dropped, which makes the profile incomplete. iOS 27 reuses the iOS 26 ClientHello (`CLIENT_HELLO_ALIAS`).
- **Plaintext models only.** `normalizeDeviceValue()` drops values that look base64-ish; `platformMatchesBrand()` drops an iOS model on an Android UA and vice versa.
- **`d_brand` is derived, not captured.** Its plaintext only shows up on requests that carry no `pt_pin` (JD encrypts it once a session exists), and this script never processes logged-out requests — so it would otherwise be the one field that can never be filled. `deriveBrand(platform, dModel)` returns `apple` for iOS and matches an Android vendor from the model prefix (`ANDROID_BRAND_HINTS`: `SM-`/`Redmi`/`HUAWEI`/`Pixel`/…); an unrecognised model yields `''` and the account is skipped rather than given a made-up brand.
- **UA beats body for `build`/`clientVersion`.** Some endpoints (`babelGetGuideTips`, `queryPagePopWindow`) send `clientVersion=1.0.0`; letting the body win would permanently record a fake app version for that account. `normalizeProfileFields()` therefore reads `uaInfo.build || normalizeBuild(source.build)` and `uaInfo.clientVersion || normalizeClientVersion(source.clientVersion)`. `parseUserAgent()` recovers all three UA shapes: `appBuild/171135`, `jdmall;iphone;version/16.1.50`, and the `os/17.3` segment.
- **`openudid` is optional and is never synthesised.** The consumer falls back to `uuid` when it is absent; writing `uuid` into `openudid` would just add a redundant segment to every sync.
- **`h5st` is never persisted** — not in the env value, not in the local cache. It is a per-request signature.
- **Incomplete profiles are skipped** unless a cached profile for the same `pt_pin` can fill the gaps (`resolveProfile(captured, cached)`). `pt_key`/`pt_pin` always come from the live capture and are never taken from cache.
- `isSameCookieValue()` compares semantically (parse both sides, ignore order/extra fields), so a Qinglong row holding only `pt_key`/`pt_pin` is **not** equal to the full value and will be rewritten.

**Manual import entry.** `$argument` matching `push` or `push:<text>` short-circuits the whole intercept path (`readImportPayload()` → `runManualImport()`), because that mode has no useful `$request`. Text can be inline after `push:` or come from the `jd_import_payload` store key when it is too long for a module argument. It reuses exactly the same `parseCookieInput` → `resolveProfile` → `serializeProfile` → `syncToQinglong` chain, so an imported account gets the same validation and the same cache write as a captured one. Adding a second code path here — do not; keep import and capture flowing through the same functions.

## Storage keys

Config: `ql_url`, `ql_client_id`, `ql_client_secret`, `ql_update_interval`, `jd_bypass_interval_check`, `jd_strip_app_open`.
Per-account cache: `jd_cookie_cache_{ptPin}`, `jd_cookie_last_update_{ptPin}`, `jd_cookie_syncing_{ptPin}` (lock), `jd_cookie_partial_{ptPin}` (fingerprint fragments accumulated across requests — never the source of `pt_key`/`pt_pin`), `jd_cookie_skipmsg_{ptPin}` (throttles the "fields incomplete" alert to once per hour).

`jd_strip_app_open` is opt-in and defaults to off. Since 2026-09 JD prefixes `pt_key` with `app_open` (`app_openAAJqskN7...`). The default keeps the captured value verbatim — it is the exact credential JD's servers just accepted; stripping it is only for users whose downstream sign-in scripts only accept the classic `AAJ...` form.

## Conventions

- Chinese for user-facing strings, log messages, and commit subjects (`fix:` / `feat:` / `refactor:` prefixes, Chinese body).
- Secrets are masked in any UI output (`maskString`); never log a raw `pt_key`, `client_secret`, or full cookie.
- API helpers return `{ success, message }` objects and log the failure themselves rather than throwing.
- User-facing alerts go through `$.msg(title, subtitle, body)`. `$.notify()` is not used anywhere in this repo despite what `CLAUDE.md` says.

## Related docs

`CLAUDE.md` has useful Qinglong API detail (auth flow, response shapes, DELETE integer-array rule, unique-violation payload) but its Architecture, Constraints, Debugging, and Pattern-Matching sections have drifted: the trigger regex, the HTTP-verb claim, the `$.notify()` reference, and the sample log strings (`✅ 成功提取 Cookie`, `⏰ 距离上次更新未满`, `🔍` debug prefix) no longer match the code. Prefer the code.
