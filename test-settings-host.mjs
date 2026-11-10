/**
 * 集成反馈回路：真实 `apply()` + **可用的** DSH settings 服务。
 *
 * `test-status-route.mjs` 覆盖的是「服务不可用 → 降级 store」那一支（它的
 * `ctx.get` 恒返回 undefined）。本文件覆盖**另一支**：宿主确实 provide 了
 * settings 服务时，插件必须
 *
 *   1. 调 `settings.configure({ auto: true }, ctx.fiber)` 注册原生表单；
 *   2. 用 **Loader 条目 id** 作为 namespace（不是声明常量）；
 *   3. 读值走 settings 优先 —— `/status` 反映 settings 里的值而不是 store；
 *   4. 写值走 `settings.update(ns, patch)` —— 三条写路由都要落到 settings；
 *   5. 首次启动把旧 `teleagent-plugin.json` 一次性迁移进 settings 并打标记；
 *   6. settings 非空时**绝不**覆盖用户已有配置。
 *
 * 这两支合起来才是完整的「设置统一到 DSH 设置」。
 *
 * 用法：node test-settings-host.mjs   退出码 0 = 绿
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib')
const ROOT = path.join(os.tmpdir(), 'te-settings-harness')

// ---------------------------------------------------------------- 隔离 HOME
//
// apply() 会 reapStaleKernels() + startKernel()，都按 HOME 定位。不隔离就会
// 把用户正在用的内核当成遗留进程杀掉。必须在 import 之前设置。
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'te-settings-home-'))
process.env.HOME = ISOLATED_HOME
process.env.DSH_HOME = path.join(ISOLATED_HOME, '.dsh')

// ---------------------------------------------------------------- 准备桩依赖
fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(path.join(ROOT, 'lib'), { recursive: true })
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

// -------------------------------------------------- mock 可写的 settings 服务
/**
 * 行为对齐 dsh-settings@0.2.x：
 *  - `configure(presentation, owner)` 注册表单策略
 *  - `get(ns)` 返回该 ns 的 section（可能没有 → undefined）
 *  - `update(ns, patch)` 合并并持久化
 *  - `describe()` 返回 [{ ns, value, ... }]
 */
const SETTINGS_NS_UNDER_TEST = 'include:dsh-connect-teleagent'

function createSettingsService({ initial = undefined, failUpdate = false } = {}) {
  const state = { configured: [], sections: new Map(), updates: [], failUpdate }
  if (initial !== undefined) state.sections.set(SETTINGS_NS_UNDER_TEST, { ...initial })
  return {
    state,
    configure(presentation, owner) {
      if (state.configured.length > 0) throw new Error('Settings presentation is already configured for this plugin instance')
      state.configured.push({ presentation, owner })
      return () => { state.sections.delete(SETTINGS_NS_UNDER_TEST) }
    },
    get(ns) {
      const row = state.sections.get(ns)
      return row === undefined ? undefined : { ...row }
    },
    async update(ns, patch) {
      if (state.failUpdate) throw new Error('update refused')
      state.updates.push({ ns, patch })
      const prev = state.sections.get(ns) ?? {}
      state.sections.set(ns, { ...prev, ...patch })
      return true
    },
    describe() {
      return [...state.sections.entries()].map(([ns, value]) => ({ ns, value: { ...value } }))
    },
  }
}

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

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

const report = []
const ok = (n, c, d = '') => report.push({ n, c, d })

// ---------------------------------------------------------------- 工具
async function callRoute(route, { method = 'GET', body = undefined, headers = {} } = {}) {
  const server = http.createServer((req, res) => route.handler(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  try {
    const res = await fetch(`http://127.0.0.1:${port}${route.path}`, {
      method,
      headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { json = undefined }
    return { status: res.status, json, text }
  } finally {
    await new Promise((r) => server.close(r))
  }
}

/**
 * 跑一次 apply()，返回它注册的路由与 settings 服务句柄。
 *
 * 每次 apply 都用一个全新的 settings 服务实例 —— apply 里的 configure 是
 * 「每个插件实例一次」，复用同一个实例会抛 already configured。
 */
async function boot({ legacy = undefined, settingsInitial = undefined, failUpdate = false } = {}) {
  // 旧 JSON：由调用方决定是否预置（迁移场景）
  const storeDir = path.join(ISOLATED_HOME, '.dsh')
  fs.mkdirSync(storeDir, { recursive: true })
  const storeFile = path.join(storeDir, 'teleagent-plugin.json')
  fs.rmSync(storeFile, { force: true })
  if (legacy !== undefined) fs.writeFileSync(storeFile, JSON.stringify(legacy, null, 2))

  const settings = createSettingsService({ initial: settingsInitial, failUpdate })
  const ctx = {
    logger,
    // 关键区别：这里 **能** 拿到 settings 服务
    get: (name) => (name === 'settings' ? settings : undefined),
    inject(deps, cb) {
      const child = { ...ctx, webServer, settings, effect: (fn) => { const d = fn(); return () => d?.() } }
      cb(child)
      return () => {}
    },
    effect: (fn) => { const d = fn(); return () => d?.() },
    on: () => {},
    llm: { registerAdapter: () => () => {} },
    // Loader 条目 id —— 宿主按它精确查表
    fiber: { entry: { options: { id: SETTINGS_NS_UNDER_TEST } } },
  }

  const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
  routes.length = 0
  const dispose = mod.apply(ctx, { probeTimeoutMs: 1 })
  // 等异步装配（迁移是 void 的）落定
  await new Promise((r) => setTimeout(r, 800))
  const find = (suffix) => routes.find((r) => String(r.path ?? '').endsWith(suffix))
  return { mod, settings, dispose, find, storeFile }
}

const results = []

// ================================================================ 场景 1
// 全新安装（无旧 JSON、settings 为空）：configure 被调用 + 读走默认值
{
  const { settings, dispose, find } = await boot()
  ok('configure({auto:true}) 已调用', settings.state.configured.length === 1)
  ok('configure 传了 auto:true', settings.state.configured[0]?.presentation?.auto === true)
  ok('configure 的 owner 是 ctx.fiber', settings.state.configured[0]?.owner !== undefined)

  const status = find('/status')
  ok('已注册 /status 路由', status !== undefined)
  const r = await callRoute(status)
  ok('/status 返回 200', r.status === 200, `status=${r.status}`)
  // `via` 的语义是「当前展示的值来自哪一层」（值溯源），不是「服务是否可用」。
  // 全新安装时 settings 里还没有任何值，展示的是默认值 → 'store' 是诚实答案；
  // 一旦用户存过（场景 2）就会变成 'settings'。逐字段真相在 configSource 里。
  ok('/status 标注 via（值溯源）', r.json?.via === 'store', `via=${r.json?.via}`)
  ok('/status 的 configSource 逐字段标注', typeof r.json?.configSource === 'object')
  // settings 为空 → 用默认值
  ok('/status provider.disabled 默认 false', r.json?.provider?.disabled === false)
  // 「全发」对外只有一种表示：null（settings 侧存 []，响应归一成 null）
  ok('/status toolsAllowlist 默认全发（null）', r.json?.toolsAllowlist === null, JSON.stringify(r.json?.toolsAllowlist))
  // 选择状态不在顶层数组里，而是逐模型 enabled
  ok('/status models 逐模型 enabled（默认全开）', Array.isArray(r.json?.models) && r.json.models.every((m) => m.enabled === true))
  try { await dispose?.() } catch { /* ignore */ }
  results.push('场景1 全新安装')
}

// ================================================================ 场景 2
// settings 里已有值 → 读值必须反映 settings（而不是 store/config 默认值）
{
  const { settings, dispose, find } = await boot({
    settingsInitial: { providerDisabled: true, enabledModelIds: ['chat-flash'], toolsAllowlist: ['bash'] },
  })
  const r = await callRoute(find('/status'))
  ok('settings 的 providerDisabled 生效', r.json?.provider?.disabled === true)
  // 选择状态是逐模型 enabled（顶层没有 enabledModelIds 数组）
  const enabledIds = (r.json?.models ?? []).filter((m) => m.enabled === true).map((m) => m.id)
  ok('settings 的 enabledModelIds 生效', JSON.stringify(enabledIds) === '["chat-flash"]', JSON.stringify(enabledIds))
  ok('settings 的 toolsAllowlist 生效', JSON.stringify(r.json?.toolsAllowlist) === '["bash"]')
  ok('via=settings（值确实来自 settings）', r.json?.via === 'settings')
  try { await dispose?.() } catch { /* ignore */ }
  results.push('场景2 settings 优先')
}

// ================================================================ 场景 3
// 写路径：/tools POST 必须落到 settings.update，而不是只改本地 JSON
{
  const { settings, dispose, find } = await boot()
  const r = await callRoute(find('/tools'), { method: 'POST', body: { toolsAllowlist: ['read', 'bash*'] } })
  ok('/tools POST 返回 200', r.status === 200, `status=${r.status}`)
  ok('/tools POST 标注 via=settings', r.json?.via === 'settings', `via=${r.json?.via}`)
  const wrote = settings.state.updates.some((u) => Array.isArray(u.patch.toolsAllowlist))
  ok('tools 写入调用了 settings.update', wrote, JSON.stringify(settings.state.updates))
  const landed = settings.state.sections.get(SETTINGS_NS_UNDER_TEST)?.toolsAllowlist
  ok('tools 值真的进了 settings section', JSON.stringify(landed) === '["read","bash*"]', JSON.stringify(landed))
  ok('写入用 Loader 条目 id 作 ns', settings.state.updates.every((u) => u.ns === SETTINGS_NS_UNDER_TEST))
  try { await dispose?.() } catch { /* ignore */ }
  results.push('场景3 tools 写 settings')
}

// ================================================================ 场景 4
// 写路径：/models POST（两条分支）
{
  const { settings, dispose, find } = await boot()
  const models = find('/models')
  const r1 = await callRoute(models, { method: 'POST', body: { enabledModelIds: ['chat-pro', 'chat-nano'] } })
  ok('/models POST(enabledModelIds) 返回 200', r1.status === 200, `status=${r1.status}`)
  ok('enabledModelIds 进了 settings', JSON.stringify(settings.state.sections.get(SETTINGS_NS_UNDER_TEST)?.enabledModelIds) === '["chat-pro","chat-nano"]')

  const r2 = await callRoute(models, { method: 'POST', body: { providerDisabled: true } })
  ok('/models POST(providerDisabled) 返回 200', r2.status === 200, `status=${r2.status}`)
  ok('providerDisabled 进了 settings', settings.state.sections.get(SETTINGS_NS_UNDER_TEST)?.providerDisabled === true)

  // 回读确认：/status 必须反映刚写入的值
  const after = await callRoute(find('/status'))
  ok('写入后 /status 立即反映（无需重启）', after.json?.provider?.disabled === true)
  try { await dispose?.() } catch { /* ignore */ }
  results.push('场景4 models 写 settings')
}

// ================================================================ 场景 5
// 首次启动迁移：旧 JSON 有值、settings 为空 → 搬进 settings 并打标记
{
  const legacy = {
    providerDisabled: true,
    enabledModelIds: ['chat-lite'],
    toolsAllowlist: null,           // 历史值 null = 全发，归一成 []
    welfare: { autoClaimDaily: false },
  }
  const { settings, dispose, storeFile } = await boot({ legacy })
  const section = settings.state.sections.get(SETTINGS_NS_UNDER_TEST) ?? {}
  ok('迁移：providerDisabled 进了 settings', section.providerDisabled === true, JSON.stringify(section))
  ok('迁移：enabledModelIds 进了 settings', JSON.stringify(section.enabledModelIds) === '["chat-lite"]')
  ok('迁移：toolsAllowlist 归一成 []（null 与 [] 等价）', Array.isArray(section.toolsAllowlist) && section.toolsAllowlist.length === 0, JSON.stringify(section.toolsAllowlist))
  ok('迁移：autoClaimDaily 进顶层并保留 false', section.autoClaimDaily === false)

  // 旧文件必须保留（用户要求：自动迁移但保留），且打上标记
  ok('迁移后旧 JSON 仍在', fs.existsSync(storeFile))
  const after = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  ok('旧 JSON 打了 migratedToSettings 标记', after.migratedToSettings === true, JSON.stringify(after).slice(0, 200))
  ok('旧 JSON 的原有字段没被清掉', after.enabledModelIds?.[0] === 'chat-lite')
  try { await dispose?.() } catch { /* ignore */ }
  results.push('场景5 旧配置迁移')
}

// ================================================================ 场景 6
// 迁移幂等：settings 非空时绝不覆盖用户已有配置
{
  const legacy = { providerDisabled: true, enabledModelIds: ['chat-lite'] }
  const { settings, dispose } = await boot({
    legacy,
    settingsInitial: { providerDisabled: false, enabledModelIds: ['chat-pro'] },
  })
  const section = settings.state.sections.get(SETTINGS_NS_UNDER_TEST) ?? {}
  ok('settings 非空时不被旧 JSON 覆盖（providerDisabled）', section.providerDisabled === false, JSON.stringify(section))
  ok('settings 非空时不被旧 JSON 覆盖（enabledModelIds）', JSON.stringify(section.enabledModelIds) === '["chat-pro"]')
  ok('未发生任何迁移写入', settings.state.updates.length === 0, JSON.stringify(settings.state.updates))
  try { await dispose?.() } catch { /* ignore */ }
  results.push('场景6 迁移幂等')
}

// ================================================================ 场景 7
// settings 写入失败 → 不崩，退回 store 且如实标注 via
{
  const { settings, dispose, find } = await boot({ failUpdate: true })
  const r = await callRoute(find('/tools'), { method: 'POST', body: { toolsAllowlist: ['bash'] } })
  ok('settings.update 失败时仍返回 200（退回 store）', r.status === 200, `status=${r.status}`)
  ok('settings.update 失败时 via=store', r.json?.via === 'store', `via=${r.json?.via}`)
  ok('失败已尝试过 update', settings.state.failUpdate === true)
  try { await dispose?.() } catch { /* ignore */ }
  results.push('场景7 写入失败降级')
}

// ================================================================ 输出
console.log('\n设置统一到 DSH settings（Host 集成）')
console.log('─'.repeat(64))
for (const x of report) console.log(`  ${x.c ? '✓' : '✗'} ${x.n.padEnd(40)} ${x.d}`)
const failed = report.filter((x) => !x.c)
console.log('─'.repeat(64))
console.log(`  场景：${results.join(' / ')}`)
console.log(`  断言：${report.length - failed.length}/${report.length} 通过`)

// 收尾：停掉 plugin 拉起的 kernel/shim，避免孤儿进程
await new Promise((r) => setTimeout(r, 300))
try { fs.rmSync(ISOLATED_HOME, { recursive: true, force: true }) } catch { /* ignore */ }

console.log(failed.length ? `  红：${failed.length} 项失败` : '  绿：全部通过')
process.exit(failed.length ? 1 : 0)
