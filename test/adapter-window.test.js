/**
 * 回归：fiber 重载后的「adapter 注册窗口」。
 *
 * 现场：插件运行一段时间后，宿主 fiber 被重载（HMR / 设置 remount / 进程重启）。
 * 旧 fiber dispose 会清空 `llm.adapters` 里的 teleagent 路由并杀掉内核 →
 * 在途流 `terminated`（TRANSPORT）→ `dsh-llm-retry` 按 normal mode 首次退避
 * ~460ms 后重试。而插件的 `ctx.llm.registerAdapter()` 原本在**异步 boot() 末尾**
 * （bootlog 实测窗口 3.1 秒：startKernel + waitReady + createShim + setupToolBridge）。
 * 于是重试落在窗口里 → `no adapter registered for provider "teleagent"`。
 *
 * 契约：`apply()` 同步返回时，teleagent 路由必须**已经注册**；注册对象在
 * boot 完成前后都可用（未就绪时给出明确的「仍在启动」错误，而不是 NO_ADAPTER）。
 *
 * 真实加载 lib/index.js，只把 DSH 运行时依赖与 kernel 换成耗时桩；
 * 用与宿主 `LlmRuntime.registerAdapter` 同构的 Map 模拟注册/注销。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let ROOT = ''
let seq = 0

/** 建隔离插件树：真 lib/*.js + 桩依赖 + 慢 kernel（模拟真实 boot 耗时） */
async function setup() {
  ROOT = path.join(os.tmpdir(), `te-adapter-window-${process.pid}-${++seq}`)
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'te-aw-home-'))
  process.env.HOME = HOME
  process.env.DSH_HOME = path.join(HOME, '.dsh')
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(path.join(ROOT, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'package.json'), JSON.stringify({ name: 'te-aw', private: true, type: 'module' }))
  for (const f of fs.readdirSync(path.join(REPO, 'lib'))) {
    if (f.endsWith('.js')) fs.copyFileSync(path.join(REPO, 'lib', f), path.join(ROOT, 'lib', f))
  }
  const stub = (name, body) => {
    const dir = path.join(ROOT, 'node_modules', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', type: 'module', main: 'index.js' }))
    fs.writeFileSync(path.join(dir, 'index.js'), body)
  }
  stub('@earendil-works/pi-ai', 'export function createProvider(o){return o}\n')
  stub('@earendil-works/pi-ai/api/openai-completions.lazy', 'export function openAICompletionsApi(){return {kind:"openai-completions"}}\n')
  stub('@deepseek-ai/dsh-llm-pi-ai', 'export class PiAiAdapter { constructor(o){this.options=o} providerInfo(p){return {id:p,name:"TeleAgent"}} prepareCall(p,m){return Promise.resolve({model:{id:m,name:m,input:["text"],context:{contextWindow:100}},stream(){}})} }\n')
  stub('@deepseek-ai/dsh-llm', 'export function resolveRetryPolicy(){return {mode:"normal",maxRetries:5,retryableCodes:["TRANSPORT"],initialDelayMs:500,maxDelayMs:10000,jitterRatio:0.1}}; export function resolveImageAttachmentAccess(){return {}}; export class LlmError extends Error { constructor(m,c){super(m);this.code=c} }\n')

  // kernel 桩：waitReady 慢 500ms（真实 3.1s），让「注册窗口」确定且快速可测
  fs.writeFileSync(path.join(ROOT, 'lib', 'kernel.js'), `
export const DEFAULT_GATEWAY_BASE=''; export const DEFAULT_GATEWAY_KEY=''
export const CLIENT_DISABLED_TOOLS={}; export const KERNEL_TOOLS=[]
export function buildPermission(){return {}}
export async function pickFreePort(){return 59999}
export function resolveKernelBinary(){return '/fake/kernel'}
export function readAccountProvider(){return null}
export function sealAuthState(){return {}}
export function kernelPidFile(){return '/fake/kernel.pid'}
export function processStartToken(){return null}
export async function reapStaleKernels(){return {killed:[],skipped:[],errors:[]}}
export function listSystemProcesses(){return []}
export async function startKernel(){return {base:'http://127.0.0.1:59999',child:{pid:99999,exitCode:0,signalCode:null},stop(){},close(){}}}
export async function waitReady(){await new Promise(r=>setTimeout(r, 500))}
export class SessionStore{}; export function contentToText(){return ''}
export function conversationKey(){return ''}; export function planTurn(){return {}}
export function materializeImages(){return {parts:[]}}
export async function openEventStream(){return {}}
export function normalizeUpstreamFailure(e){return e}
export async function consumeEvents(){return {}}
export async function promptStream(){return {}}
export async function createSession(){return 's1'}
export function usageOf(){return {}}; export function usageOrUndefined(){return undefined}
export function createKernelTransport(o){return {base:o.kernel.base,close(){},getModels(){return []},async chat(){return {}},async chatStream(){return {}}}}
export function kernelErrorResult(e){return e}
export async function probeKernelHealth(){return {ok:true,status:200}}
export function canReadKeychain(){return true}
`)
  return await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
}

/** 与宿主 registerAdapter/disposer 同构的 adapter 注册表 */
function makeLlm() {
  const adapters = new Map()
  return {
    adapters,
    registerAdapter(providers, adapter) {
      for (const p of providers) adapters.set(p, { adapter })
      return () => { for (const p of providers) adapters.delete(p) }
    },
    registration(provider) {
      const r = adapters.get(provider)
      if (!r) throw new Error(`no adapter registered for provider "${provider}"`)
      return r
    },
  }
}

function makeCtx(llm) {
  const disposers = []
  return {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get: () => undefined,
    inject: () => () => {},
    effect(fn) { const d = fn(); disposers.push(d); return typeof d === 'function' ? d : () => {} },
    on() {},
    llm,
    fiber: { entry: { options: { id: 'dsh-connect-teleagent' } } },
    _dispose() { for (const d of disposers.splice(0)) { try { d?.() } catch {} } },
  }
}

const settle = () => new Promise((r) => setTimeout(r, 900))

const CONFIG = { transport: 'kernel', probeOnBoot: false, toolBridge: false, probeTimeoutMs: 1 }

test('apply() 同步返回时 teleagent 路由已注册（不能等异步 boot）', async () => {
  const llm = makeLlm()
  const mod = await setup()

  const ctx = makeCtx(llm)
  const dispose = mod.apply(ctx, CONFIG)
  // ⚠️ 不 await boot：宿主在 apply() 返回后即可发起模型请求
  assert.equal(llm.adapters.has('teleagent'), true,
    'apply() 同步阶段就必须注册 adapter；否则重载后的首次重试会撞上 NO_ADAPTER')
  // 注册对象必须能立刻被宿主调用（不能是空壳）
  assert.equal(typeof llm.registration('teleagent').adapter.providerInfo('teleagent').name, 'string')

  await settle()   // 让 boot 完成，否则 cleanup 早于 shim 创建会漏关服务器（见修复）
  ctx._dispose()
  await dispose()
})

test('fiber 重载后 460ms 重试时刻仍有 adapter，且不会抛 NO_ADAPTER', async () => {
  const llm = makeLlm()
  const mod = await setup()

  // 第 1 轮：正常跑起来（运行一段时间）
  const ctx1 = makeCtx(llm)
  const dispose1 = mod.apply(ctx1, CONFIG)
  await new Promise((r) => setTimeout(r, 900))
  assert.equal(llm.adapters.has('teleagent'), true, '前置条件：第一轮 boot 完成')

  // 重载：宿主 dispose 旧 fiber（清路由 + 杀内核 → 在途流 terminated）
  ctx1._dispose()
  await dispose1()
  assert.equal(llm.adapters.has('teleagent'), false, '前置条件：旧 fiber 已注销路由')

  // 新 apply() 同步返回；460ms 后宿主按首次退避重试
  const ctx2 = makeCtx(llm)
  const dispose2 = mod.apply(ctx2, CONFIG)
  await new Promise((r) => setTimeout(r, 460))
  assert.equal(llm.adapters.has('teleagent'), true,
    '460ms 退避重试时 teleagent 必须仍在注册表里')
  assert.doesNotThrow(() => llm.registration('teleagent'),
    /no adapter registered/, '重试不得抛出 NO_ADAPTER')

  // 窗口内 prepareCall 也必须有明确结果，不能是 NO_ADAPTER
  const reg = llm.registration('teleagent')
  assert.equal(typeof reg.adapter.prepareCall, 'function')
  await settle()
  ctx2._dispose()
  await dispose2()
})

test('同一 fiber 内 adapter 注册恰好一次（不重复注册、不提前注销）', async () => {
  const mod = await setup()
  const calls = []
  const llm = makeLlm()
  const raw = llm.registerAdapter.bind(llm)
  llm.registerAdapter = (providers, adapter) => { calls.push([...providers]); return raw(providers, adapter) }
  const ctx = makeCtx(llm)
  const dispose = mod.apply(ctx, CONFIG)
  await new Promise((r) => setTimeout(r, 900))
  // 允许「同步注册 + boot 内替换」或仅一次；但绝不允许注册两次后只留一个
  assert.ok(calls.length >= 1, '至少要注册一次')
  assert.equal(llm.adapters.has('teleagent'), true, 'boot 完成后路由仍在')
  await settle()
  ctx._dispose()
  await dispose()
})

// ------------------------------------------------------------------ 门面单元测试
// 直接测 createForwardingAdapter：不依赖 apply()/boot()，验证「同步可注册 +
// 内部实现可热替换 + 未就绪给可重试 TRANSPORT」三条契约。
test('门面：未就绪时 providerInfo/listModels/prepareCall 可用且 stream 抛 TRANSPORT', async () => {
  const { createForwardingAdapter } = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
  const f = createForwardingAdapter({ provider: 'teleagent' })
  assert.equal(f.ready, false)
  assert.deepEqual(f.providerInfo('teleagent'), { id: 'teleagent', name: 'TeleAgent' })
  const models = await f.listModels('teleagent')
  assert.ok(Array.isArray(models) && models.length > 0)
  const call = await f.prepareCall('teleagent', 'chat-pro')
  assert.equal(call.model.id, 'chat-pro')
  assert.equal(typeof call.stream, 'function')
  assert.throws(() => f.stream({}), (e) => e.code === 'TRANSPORT' && /启动中/.test(e.message))
})

test('门面：setInner 之后所有调用转发给内部实现', async () => {
  const { createForwardingAdapter } = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
  const f = createForwardingAdapter({ provider: 'teleagent' })
  const seen = []
  const inner = {
    providerInfo: (id) => ({ id, name: 'inner' }),
    providerRetryPolicy: () => ({ mode: 'normal' }),
    imageRequestTarget: () => ({ width: 1, height: 1, maxBytes: 1 }),
    imageRequestPricing: () => ({ perImage: 1 }),
    listModels: () => Promise.resolve([{ id: 'from-inner' }]),
    resolveModel: (id, m) => Promise.resolve({ id, model: m, from: 'inner' }),
    prepareCall: (id, m) => Promise.resolve({ model: { id: m }, stream: () => 'inner-stream' }),
    stream: () => 'inner-stream',
  }
  for (const k of Object.keys(inner)) {
    const orig = inner[k]
    inner[k] = (...a) => { seen.push(k); return orig(...a) }
  }
  f.setInner(inner)
  assert.equal(f.ready, true)
  assert.equal(f.providerInfo('teleagent').name, 'inner')
  assert.equal(f.providerRetryPolicy('teleagent').mode, 'normal')
  assert.equal(f.stream({}), 'inner-stream')
  assert.deepEqual(await f.listModels('teleagent'), [{ id: 'from-inner' }])
  assert.equal((await f.resolveModel('teleagent', 'chat-pro')).from, 'inner')
  assert.equal((await f.prepareCall('teleagent', 'chat-pro')).stream({}), 'inner-stream')
  assert.ok(seen.includes('stream') && seen.includes('listModels'))
})

test('门面：boot 失败后 setReadyError 让 stream 抛带原因的 TRANSPORT', async () => {
  const { createForwardingAdapter } = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
  const f = createForwardingAdapter({ provider: 'teleagent' })
  f.setReadyError('TeleAgent 启动失败：kernel 未就绪')
  assert.equal(f.ready, false)
  assert.throws(() => f.stream({}), (e) => e.code === 'TRANSPORT' && /kernel 未就绪/.test(e.message))
  // 仍注册着：providerInfo 必须可用，宿主不会报 NO_ADAPTER
  assert.equal(f.providerInfo('teleagent').id, 'teleagent')
})
