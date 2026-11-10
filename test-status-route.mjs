/**
 * 反馈回路：复现「状态路由 404」。
 *
 * 真实加载插件 lib/index.js（只把 DSH 运行时的 pi-ai 依赖换成桩），
 * 用一个「`ctx.get('webServer')` 返回 undefined、只有 `ctx.inject(['webServer'], cb)` 能给到服务」
 * 的 mock ctx —— 这正是 bootlog 里记录的真实情况。
 *
 * 断言：apply() 之后，状态路由必须已注册到 webServer 上，且能响应 HTTP 200。
 *
 * 用法：node test-status-route.mjs
 *   退出码 0 = 绿（修好）；1 = 红（仍有 bug）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib')
const ROOT = path.join(os.tmpdir(), 'te-harness')

// ---------------------------------------------------------------- 隔离 HOME
//
// **必须在 import lib/index.js 之前设置。**
//
// 本测试真的调用 `apply()`，而 `apply()` 会 `reapStaleKernels()` + `startKernel()`，
// 两者都按用户主目录 定位 `~/.dsh-teleagent-kernel/`。不隔离的话：
//   1. 会把用户真正在用的 DSH 内核当成"遗留内核"杀掉 →
//      正在进行的对话当场 `terminated`（TRANSPORT），重试 5 次后失败；
//   2. 会用测试内核覆盖真实的 kernel.pid，并污染 ~/.dsh 下的设置与日志。
//
// 用一个临时 HOME，让整条装配链路都跑在沙箱里，绝不碰真实运行状态。
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'te-status-home-'))
process.env.HOME = ISOLATED_HOME
process.env.USERPROFILE = ISOLATED_HOME
delete process.env.TELEAI_TA_DEVICE_DATA_DIR
delete process.env.TELEAGENT_CONFIG_DIR
process.env.DSH_HOME = path.join(ISOLATED_HOME, '.dsh')

// ---------------------------------------------------------------- 准备桩依赖
fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(path.join(ROOT, 'lib'), { recursive: true })
// 真实 DSH 的临时 harness 有 package.json；没有它的话，Node 18 会把 .js 当 CJS
// 解析，测试会因为 "Cannot use import statement outside a module" 挂掉。
fs.writeFileSync(path.join(ROOT, 'package.json'), JSON.stringify({ name: 'te-harness', private: true, type: 'module' }))
for (const f of fs.readdirSync(SRC)) {
  if (f.endsWith('.js')) fs.copyFileSync(path.join(SRC, f), path.join(ROOT, 'lib', f))
}

const stub = (name, body) => {
  const dir = path.join(ROOT, 'node_modules', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', type: 'module', main: 'index.js' }))
  fs.writeFileSync(path.join(dir, 'index.js'), body)
}
stub('@earendil-works/pi-ai', 'export function createProvider(o) { return o }\n')
stub('@earendil-works/pi-ai/api/openai-completions.lazy', 'export function openAICompletionsApi() { return { kind: "openai-completions" } }\n')
stub('@deepseek-ai/dsh-llm-pi-ai', 'export class PiAiAdapter { constructor(o) { this.options = o } }\n')
stub('@deepseek-ai/dsh-llm', 'export function resolveRetryPolicy() { return {} }\n')

// ---------------------------------------------------------------- mock webServer
const routes = []
const webServer = {
  register(shape) {
    routes.push(shape)
    return () => {
      const i = routes.indexOf(shape)
      if (i >= 0) routes.splice(i, 1)
    }
  },
}

// ---------------------------------------------------------------- mock ctx
const logs = []
const logger = {
  info: (...a) => logs.push(['info', a.join(' ')]),
  warn: (...a) => logs.push(['warn', a.join(' ')]),
  error: (...a) => logs.push(['error', a.join(' ')]),
  debug: () => {},
}

let injectedDeps = []
const ctx = {
  logger,
  // 关键：模拟「服务尚未就绪」——ctx.get 拿不到
  get: () => undefined,
  // 但 ctx.inject 在服务就绪后会回调
  inject(deps, cb) {
    injectedDeps = deps
    const child = { ...ctx, webServer, effect: (fn) => { const d = fn(); return () => d?.() } }
    cb(child)
    return () => {}
  },
  effect: (fn) => { const d = fn(); return () => d?.() },
  on: () => {},
  llm: { registerAdapter: () => () => {} },
}

// ---------------------------------------------------------------- 跑 apply
const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
// apply 返回 disposer：必须调用，否则它拉起的 kernel 会变成孤儿进程
const dispose = mod.apply(ctx, { probeTimeoutMs: 1 })
await new Promise((r) => setTimeout(r, 1500))

const report = []
const ok = (n, c, d = '') => report.push({ n, c, d })

ok('apply 使用了 ctx.inject([webServer])', injectedDeps.includes('webServer'), JSON.stringify(injectedDeps))

const status = routes.find((r) => String(r.path ?? '').endsWith('/status'))
const models = routes.find((r) => String(r.path ?? '').endsWith('/models'))
const login = routes.find((r) => String(r.path ?? '').endsWith('/login'))
ok('已注册 status 路由', status !== undefined, `已注册 ${routes.length} 条: ${routes.map((r) => r.path).join(', ')}`)
ok('已注册 models 路由', models !== undefined)
ok('已注册 login 路由', login !== undefined)
const logout = routes.find((r) => String(r.path ?? '').endsWith('/logout'))
ok('已注册 logout 路由', logout !== undefined)
const toolsRoute = routes.find((r) => String(r.path ?? '').endsWith('/tools'))
ok('已注册 tools（工具白名单）路由', toolsRoute !== undefined)

// 真跑一次 HTTP 请求，断言 200 且形状正确
if (status?.handler) {
  const server = http.createServer((req, res) => {
    // 伪造 loopback origin 通过校验
    req.headers.host = `127.0.0.1:${server.address().port}`
    req.headers.origin = `http://127.0.0.1:${server.address().port}`
    Promise.resolve(status.handler(req, res)).catch((e) => {
      res.writeHead(500); res.end(String(e))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const res = await fetch(`http://127.0.0.1:${port}/plugins/dsh-connect-teleagent/status`, {
    headers: { origin: `http://127.0.0.1:${port}` },
  })
  const text = await res.text()
  ok('GET status 返回 200', res.status === 200, `HTTP ${res.status} ${text.slice(0, 100)}`)
  if (res.status === 200) {
    try {
      const j = JSON.parse(text)
      ok('status 含 upstream 字段', j.upstream !== undefined, JSON.stringify(j.upstream).slice(0, 80))
      ok('status 含 guard 字段', j.guard !== undefined, JSON.stringify(j.guard).slice(0, 60))
      ok('status 含 account 字段', j.account !== undefined, JSON.stringify(j.account).slice(0, 90))
      ok('未登录时提示下一步', j.account?.abnormal !== true || typeof j.account?.nextStep === 'string')
      ok('status 声明添加账号能力', j.capabilities?.addAccount === true, JSON.stringify(j.capabilities ?? {}))
      ok('status 带 canAddAccount 标记', typeof j.account?.canAddAccount === 'boolean', String(j.account?.canAddAccount))
      ok('status 不含 token', !/eyJ[A-Za-z0-9_-]{10,}/.test(text))
    } catch (e) {
      ok('status 是合法 JSON', false, String(e))
    }
  }
  server.close()
} else {
  ok('GET status 返回 200', false, '路由未注册，无法请求')
}

// 「添加账号」进度接口：GET 只读，不应启动任何流程
if (login?.handler) {
  const server2 = http.createServer((req, res) => {
    req.headers.host = `127.0.0.1:${server2.address().port}`
    Promise.resolve(login.handler(req, res)).catch((e) => { res.writeHead(500); res.end(String(e)) })
  })
  await new Promise((r) => server2.listen(0, '127.0.0.1', r))
  const port2 = server2.address().port
  const res2 = await fetch(`http://127.0.0.1:${port2}/plugins/dsh-connect-teleagent/login?mode=add`)
  const j2 = await res2.json().catch(() => null)
  ok('GET login?mode=add 返回进度', res2.status === 200 && j2?.running === false, `HTTP ${res2.status} ${JSON.stringify(j2 ?? {}).slice(0, 80)}`)
  ok('未启动流程时结果为空', j2?.result === null || j2?.result === undefined, JSON.stringify(j2?.result ?? null).slice(0, 60))
  server2.close()
}

// ---------------------------------------------------------------- CSRF 端到端
//
// 回归：写接口只校验 Host 时，任意网页都能对本机地址发一个「简单请求」
// （text/plain POST，不触发预检）静默清空白名单。这里真跑 HTTP 验证：
// 跨源被拒、同源正常。

if (toolsRoute?.handler) {
  const srv = http.createServer((req, res) => {
    // Host 是真实的回环地址（攻击者无法伪造——它由浏览器/网络栈填入）
    req.headers.host = `127.0.0.1:${srv.address().port}`
    Promise.resolve(toolsRoute.handler(req, res)).catch((e) => { res.writeHead(500); res.end(String(e)) })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port3 = srv.address().port
  const url = `http://127.0.0.1:${port3}/plugins/dsh-connect-teleagent/tools`

  // 攻击者页面：跨源 + text/plain（浏览器 simple request，无预检）
  const evil = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
    body: JSON.stringify({ toolsAllowlist: null }),
  })
  ok('跨源 text/plain POST 被拒绝', evil.status === 403, `HTTP ${evil.status} ${(await evil.text()).slice(0, 80)}`)

  // 跨源 + application/json（真实恶意站会走预检，这里直接断言兜底 403）
  const evilJson = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ toolsAllowlist: null }),
  })
  ok('跨源 application/json POST 被拒绝', evilJson.status === 403, `HTTP ${evilJson.status}`)

  // 同源但非 JSON content-type：挡住「靠 content-type 绕过同源判断」的路径
  const wrongType = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `http://127.0.0.1:${port3}` },
    body: 'toolsAllowlist=null',
  })
  ok('同源非 JSON content-type 返回 415', wrongType.status === 415, `HTTP ${wrongType.status}`)

  // 同源正常调用必须继续可用（真界面就是这么发的）
  const good = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port3}` },
    body: JSON.stringify({ toolsAllowlist: ['bash'] }),
  })
  const goodBody = await good.json().catch(() => null)
  ok('同源 JSON POST 仍然成功', good.status === 200 && goodBody?.ok === true, `HTTP ${good.status} ${JSON.stringify(goodBody ?? {}).slice(0, 80)}`)

  srv.close()
}

// ---------------------------------------------------------------- 同源 / content-type 单元断言
//
// 这些是不起 HTTP 的纯函数断言，专门覆盖 `sameOriginRequest` / `mutationGuard`
// 的边界：Origin 缺失、"null"、端口归一、content-type 变体。
// 上面的端到端用例只覆盖主路径，边界靠这里兜住。

const { sameOriginRequest, mutationGuard } = await import(pathToFileURL(path.join(ROOT, 'lib', 'status.js')).href)

function fakeReqV({ host = '127.0.0.1:52200', origin, contentType, body } = {}) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  if (contentType !== undefined) headers['content-type'] = contentType
  const raw = body === undefined ? '' : body
  headers['content-length'] = String(Buffer.byteLength(raw))
  return { headers }
}

function fakeRes() {
  const out = { status: null, headers: null, body: null }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(body) { out.body = body === undefined ? null : String(body) },
  }
}

ok('无 Origin（curl/CLI）放行', sameOriginRequest(fakeReqV()) === true)
ok('同源 Origin 放行', sameOriginRequest(fakeReqV({ origin: 'http://127.0.0.1:52200' })) === true)
ok('localhost 同源放行', sameOriginRequest(fakeReqV({ host: 'localhost:52200', origin: 'http://localhost:52200' })) === true)
ok('都省略端口时按默认端口归一', sameOriginRequest(fakeReqV({ host: '127.0.0.1', origin: 'http://127.0.0.1' })) === true)
ok('端口不同不算同源', sameOriginRequest(fakeReqV({ host: '127.0.0.1:52200', origin: 'http://127.0.0.1' })) === false)
ok('跨源 Origin 被拒', sameOriginRequest(fakeReqV({ origin: 'https://evil.example' })) === false)
ok('Origin: null（沙箱 iframe）被拒', sameOriginRequest(fakeReqV({ origin: 'null' })) === false)
ok('file:// Origin 被拒', sameOriginRequest(fakeReqV({ origin: 'file://' })) === false)
ok('畸形 Origin 被拒', sameOriginRequest(fakeReqV({ origin: 'not a url' })) === false)

{
  const res = fakeRes()
  const pass = mutationGuard(fakeReqV({ origin: 'https://evil.example', contentType: 'text/plain', body: '{}' }), res)
  ok('mutationGuard: 跨源 403', pass === false && res.out.status === 403, String(res.out.status))
}
{
  let allRejected = true
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', undefined]) {
    const res = fakeRes()
    const pass = mutationGuard(fakeReqV({ origin: 'http://127.0.0.1:52200', contentType: ct, body: '{}' }), res)
    if (pass !== false || res.out.status !== 415) allRejected = false
  }
  ok('mutationGuard: 同源非 JSON → 415', allRejected)
}
{
  let allPassed = true
  for (const ct of ['application/json', 'application/json; charset=utf-8', 'Application/JSON']) {
    const res = fakeRes()
    if (mutationGuard(fakeReqV({ origin: 'http://127.0.0.1:52200', contentType: ct, body: '{}' }), res) !== true) allPassed = false
    if (res.out.status !== null) allPassed = false
  }
  ok('mutationGuard: 同源 JSON 放行（含 charset/大小写）', allPassed)
}
{
  const res = fakeRes()
  const pass = mutationGuard(fakeReqV({ origin: 'http://127.0.0.1:52200' }), res)
  ok('mutationGuard: 无 body 空 POST 放行', pass === true && res.out.status === null)
}

// ---------------------------------------------------------------- settings 优先 / via 标注
//
// 契约（.temp/settings-contract.md §5）：写路由的 setter 返回
//   { ok: boolean, via: 'settings'|'store', value?, reason? }
// 响应体新增 via，已有字段一个都不删。
//
// 这里**不重跑 apply()**（那会拉起第二个内核），而是直接用 registerStatusRoutes
// 起一套独立路由，逐个注入不同形状的 deps —— 这正是「deps 契约」的边界。
//
// 覆盖四条：
//   1. settings 可用 → via='settings'
//   2. settings 不可用 → via='store'，且写入仍然成功（降级不失败）
//   3. setter 返回裸 true（旧实现）→ 向后兼容，视为成功、via='store'
//   4. setter 返回 { ok:false, reason } → 如实反映失败，不再"假成功"
//   5. toolsAllowlist 的 []（settings）与 null（store）对外归一成同一个表示

const statusMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'status.js')).href)

/** 用一组自定义 deps 起路由，返回 { base, close } */
async function serveWithDeps(depsFactory) {
  const map = new Map()
  const ws = {
    register({ path: p, handler }) { map.set(p, handler); return () => map.delete(p) },
  }
  const disposeRoutes = statusMod.registerStatusRoutes({ webServer: ws, deps: depsFactory, warn: () => {} })
  const srv = http.createServer((req, res) => {
    req.headers.host = `127.0.0.1:${srv.address().port}`
    const h = map.get(String(req.url ?? '').split('?')[0])
    if (!h) { res.writeHead(404); return res.end('no route') }
    Promise.resolve(h(req, res)).catch(() => { res.writeHead(500); res.end('boom') })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  return {
    base: `http://127.0.0.1:${port}/plugins/dsh-connect-teleagent`,
    origin: `http://127.0.0.1:${port}`,
    async post(path, body) {
      const r = await fetch(this.base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: this.origin },
        body: JSON.stringify(body),
      })
      return { status: r.status, json: await r.json().catch(() => null) }
    },
    async get(path) {
      const r = await fetch(this.base + path, { headers: { origin: this.origin } })
      return { status: r.status, json: await r.json().catch(() => null) }
    },
    close() { try { disposeRoutes?.() } catch { /* ignore */ } srv.close() },
  }
}

// ---- 1) settings 可用：写读都标 via='settings'
{
  const state = { tools: null, disabled: false, ids: [], auto: true }
  const s = await serveWithDeps(() => ({
    settingsSource: () => 'settings',
    upstream: { ready: true },
    toolsAllowlist: () => state.tools,
    setToolsAllowlist: (v) => {
      state.tools = v
      return { ok: true, via: 'settings', value: v }
    },
    provider: () => ({ disabled: state.disabled }),
    setProviderDisabled: (d) => {
      state.disabled = d
      return { ok: true, via: 'settings', value: { disabled: d } }
    },
    enabledModelIds: () => ({ value: state.ids, via: 'settings' }),
    saveEnabledModelIds: async (ids) => {
      state.ids = ids
      return { ok: true, via: 'settings', value: ids }
    },
    setAutoClaimDaily: (e) => {
      state.auto = e
      return { ok: true, via: 'settings' }
    },
    autoClaimDaily: () => ({ value: state.auto, via: 'settings' }),
  }))

  const t = await s.post('/tools', { toolsAllowlist: ['bash'] })
  ok('settings 可用：tools 写 via=settings', t.status === 200 && t.json?.via === 'settings', JSON.stringify(t.json))
  ok('settings 可用：tools 写仍返回原字段', Array.isArray(t.json?.toolsAllowlist) && t.json.toolsAllowlist[0] === 'bash', JSON.stringify(t.json?.toolsAllowlist))

  const st = await s.get('/status')
  ok('settings 可用：status 读 via=settings', st.status === 200 && st.json?.via === 'settings', String(st.json?.via))
  ok('settings 可用：status 逐字段标注来源', st.json?.configSource?.toolsAllowlist === 'settings' && st.json?.configSource?.enabledModelIds === 'settings', JSON.stringify(st.json?.configSource))

  const m = await s.post('/models', { providerDisabled: true })
  ok('settings 可用：provider 开关 via=settings', m.status === 200 && m.json?.via === 'settings' && m.json?.provider?.disabled === true, JSON.stringify(m.json))

  const e = await s.post('/models', { enabledModelIds: ['chat-pro'] })
  ok('settings 可用：模型勾选 via=settings', e.status === 200 && e.json?.via === 'settings', JSON.stringify(e.json))

  const w = await s.post('/welfare', { action: 'auto', enabled: false })
  ok('settings 可用：自动领取开关 via=settings', w.status === 200 && w.json?.via === 'settings', JSON.stringify(w.json))

  // toolsAllowlist 归一：settings 侧 `[]` 与 store 侧 `null` 必须对外同形
  await s.post('/tools', { toolsAllowlist: [] })
  const emptyArr = await s.get('/status')
  ok('空数组归一为 null（全发）', emptyArr.json?.toolsAllowlist === null, JSON.stringify(emptyArr.json?.toolsAllowlist))
  await s.post('/tools', { toolsAllowlist: null })
  const nullVal = await s.get('/status')
  ok('null 与空数组同形', nullVal.json?.toolsAllowlist === null, JSON.stringify(nullVal.json?.toolsAllowlist))

  s.close()
}

// ---- 2) settings 不可用：降级到 store，写入仍成功且 via='store'
{
  const state = { tools: null, disabled: false, ids: [] }
  const s = await serveWithDeps(() => ({
    // 明确声明只有 store 一层
    settingsSource: () => 'store',
    upstream: { ready: true },
    toolsAllowlist: () => state.tools,
    setToolsAllowlist: (v) => {
      state.tools = v
      return { ok: true, via: 'store', value: v }
    },
    provider: () => ({ disabled: state.disabled }),
    setProviderDisabled: (d) => {
      state.disabled = d
      return { ok: true, via: 'store' }
    },
    enabledModelIds: () => state.ids,
    saveEnabledModelIds: async (ids) => {
      state.ids = ids
      return { ok: true, via: 'store' }
    },
    autoClaimDaily: () => false,
  }))

  const t = await s.post('/tools', { toolsAllowlist: ['read'] })
  ok('settings 不可用：tools 写 via=store 且成功', t.status === 200 && t.json?.ok === true && t.json?.via === 'store', JSON.stringify(t.json))
  ok('settings 不可用：白名单真的写进去了', JSON.stringify(state.tools) === '["read"]', JSON.stringify(state.tools))

  const st = await s.get('/status')
  ok('settings 不可用：status 读 via=store', st.status === 200 && st.json?.via === 'store', String(st.json?.via))
  ok('settings 不可用：autoClaimDaily 来自 deps getter', st.json?.welfare?.autoClaimDaily === false, JSON.stringify(st.json?.welfare?.autoClaimDaily))

  s.close()
}

// ---- 3) 向后兼容：setter 返回裸 true / undefined（旧实现）
{
  const state = { tools: null, disabled: false, ids: [] }
  const s = await serveWithDeps(() => ({
    upstream: { ready: true },
    toolsAllowlist: () => state.tools,
    // 旧实现：只返回裸 true
    setToolsAllowlist: (v) => { state.tools = v; return true },
    provider: () => ({ disabled: state.disabled }),
    // 旧实现：写完不返回值（但确实写进去了）
    setProviderDisabled: (d) => { state.disabled = d },
    enabledModelIds: () => state.ids,
    // 旧实现：async 且不返回值（但确实写进去了）
    saveEnabledModelIds: async (ids) => { state.ids = ids },
  }))

  const t = await s.post('/tools', { toolsAllowlist: ['bash', 'read'] })
  ok('裸 true 视为成功且 via=store', t.status === 200 && t.json?.ok === true && t.json?.via === 'store', JSON.stringify(t.json))

  const p = await s.post('/models', { providerDisabled: true })
  ok('undefined 返回值：回读确认写入成功', p.status === 200 && p.json?.ok === true && p.json?.provider?.disabled === true, JSON.stringify(p.json))

  const e = await s.post('/models', { enabledModelIds: ['chat-pro', 'chat-flash'] })
  ok('async setter 不返回值：回读确认成功', e.status === 200 && e.json?.ok === true, JSON.stringify(e.json))

  // 旧 deps 没有任何来源声明 → 只有 store 一层
  const st = await s.get('/status')
  ok('无来源声明时 via 回落到 store', st.json?.via === 'store', String(st.json?.via))

  s.close()
}

// ---- 3b) 旧 setter 静默没写进去：回读校验必须判失败（不能假成功）
{
  const s = await serveWithDeps(() => ({
    upstream: { ready: true },
    toolsAllowlist: () => null,      // getter 永远读到 null
    setToolsAllowlist: (v) => {},    // 旧实现：不返回值，且实际没写
    provider: () => ({ disabled: false }),
    setProviderDisabled: () => {},   // 同样没写
    enabledModelIds: [],
  }))

  const t = await s.post('/tools', { toolsAllowlist: ['bash'] })
  ok('静默未写入：回读判失败', t.status === 503 && t.json?.ok === false, `HTTP ${t.status} ${JSON.stringify(t.json)}`)
  ok('静默未写入：reason 可读', t.json?.reason === 'write-unconfirmed', String(t.json?.reason))

  const p = await s.post('/models', { providerDisabled: true })
  ok('provider 静默未写入：回读判失败', p.status === 503 && p.json?.ok === false, `HTTP ${p.status}`)

  s.close()
}

// ---- 4) setter 明确失败：必须如实反映，不能假成功
{
  const s = await serveWithDeps(() => ({
    settingsSource: () => 'settings',
    upstream: { ready: true },
    toolsAllowlist: () => null,
    // settings 服务声明可用，但写入被拒
    setToolsAllowlist: () => ({ ok: false, via: 'settings', reason: 'settings-unavailable' }),
    provider: () => ({ disabled: false }),
    setProviderDisabled: () => ({ ok: false, via: 'settings', reason: 'settings-unavailable' }),
    enabledModelIds: [],
    saveEnabledModelIds: async () => ({ ok: false, via: 'settings', reason: 'settings-unavailable' }),
  }))

  const t = await s.post('/tools', { toolsAllowlist: ['bash'] })
  ok('写失败：返回非 2xx', t.status === 503, `HTTP ${t.status}`)
  ok('写失败：ok=false 且 reason 透出', t.json?.ok === false && t.json?.reason === 'settings-unavailable', JSON.stringify(t.json))
  ok('写失败：仍带 via 供前端区分', t.json?.via === 'settings', String(t.json?.via))

  const p = await s.post('/models', { providerDisabled: true })
  ok('写失败：provider 开关同样如实反映', p.status === 503 && p.json?.ok === false, JSON.stringify(p.json))

  const e = await s.post('/models', { enabledModelIds: ['chat-pro'] })
  ok('写失败：模型勾选同样如实反映', e.status === 503 && e.json?.ok === false, JSON.stringify(e.json))

  s.close()
}

// ---- 5) 纯函数契约（不起 HTTP，直接测归一化边界）
{
  ok('normalizeToolsAllowlist: [] → null', statusMod.normalizeToolsAllowlist([]) === null)
  ok('normalizeToolsAllowlist: null → null', statusMod.normalizeToolsAllowlist(null) === null)
  ok('normalizeToolsAllowlist: 去空/trim', JSON.stringify(statusMod.normalizeToolsAllowlist([' a ', '', 1, 'b'])) === '["a","b"]', JSON.stringify(statusMod.normalizeToolsAllowlist([' a ', '', 1, 'b'])))

  ok('normalizeSetterResult: 裸 true → ok+store', statusMod.normalizeSetterResult(true).ok === true && statusMod.normalizeSetterResult(true).via === 'store')
  ok('normalizeSetterResult: false → 失败', statusMod.normalizeSetterResult(false).ok === false)
  ok('normalizeSetterResult: 信封保留 via/reason', (() => {
    const r = statusMod.normalizeSetterResult({ ok: false, via: 'settings', reason: 'nope' })
    return r.ok === false && r.via === 'settings' && r.reason === 'nope'
  })())

  // via 判定顺序：settingsSource > settingsAvailable > settingsNamespace > store
  ok('settingsViaOf: settingsSource 优先', statusMod.settingsViaOf({ settingsSource: () => 'settings', settingsAvailable: () => false }) === 'settings')
  ok('settingsViaOf: settingsAvailable 兜底', statusMod.settingsViaOf({ settingsAvailable: () => true }) === 'settings')
  ok('settingsViaOf: namespace 弱信号', statusMod.settingsViaOf({ settingsNamespace: () => 'dsh-connect-teleagent' }) === 'settings')
  ok('settingsViaOf: namespace 为 null 不算 settings', statusMod.settingsViaOf({ settingsNamespace: () => null }) === 'store')
  ok('settingsViaOf: 都没声明 → store', statusMod.settingsViaOf({}) === 'store')
  ok('settingsViaOf: 抛错不崩、回落 store', statusMod.settingsViaOf({ settingsSource: () => { throw new Error('x') } }) === 'store')

  // getter 三种形状都接受
  const env = statusMod.settleSetting({ value: ['x'], via: 'settings' })
  ok('settleSetting: 信封取 value/via', JSON.stringify(env.value) === '["x"]' && env.via === 'settings')
  const fn = statusMod.settleSetting(() => ['y'], 'store')
  ok('settleSetting: 函数惰性求值', JSON.stringify(fn.value) === '["y"]' && fn.via === 'store')
  const bare = statusMod.settleSetting(null, 'settings')
  ok('settleSetting: 裸值 + 显式 via', bare.value === null && bare.via === 'settings')
}

console.log('\n状态路由反馈回路')
console.log('─'.repeat(56))
for (const x of report) console.log(`  ${x.c ? '✓' : '✗'} ${x.n.padEnd(28)} ${x.d}`)
const failed = report.filter((x) => !x.c)
console.log('─'.repeat(56))
// 收尾：停掉 plugin 拉起的 kernel / shim，避免留下孤儿进程
try {
  await dispose?.()
} catch { /* ignore */ }
await new Promise((r) => setTimeout(r, 300))

// 删掉本次隔离的临时 HOME（内核进程已停，剩下的只是配置/日志/pidfile）
try { fs.rmSync(ISOLATED_HOME, { recursive: true, force: true }) } catch { /* ignore */ }

console.log(failed.length ? `  红：${failed.length} 项失败` : '  绿：全部通过')
process.exit(failed.length ? 1 : 0)
