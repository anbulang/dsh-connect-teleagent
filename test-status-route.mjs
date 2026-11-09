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
