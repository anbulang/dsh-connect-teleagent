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
      ok('status 不含 token', !/eyJ[A-Za-z0-9_-]{10,}/.test(text))
    } catch (e) {
      ok('status 是合法 JSON', false, String(e))
    }
  }
  server.close()
} else {
  ok('GET status 返回 200', false, '路由未注册，无法请求')
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

console.log(failed.length ? `  红：${failed.length} 项失败` : '  绿：全部通过')
process.exit(failed.length ? 1 : 0)
