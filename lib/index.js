/**
 * dsh-connect-teleagent — 把本机登录的 TeleAgent 模型接入 DeepSeek Harness。
 *
 * 装配顺序：
 *   1. 读取凭据（token.json + device-meta.json），构造直连上游的客户端
 *   2. 起 loopback shim（OpenAI 兼容，随机端口 + 进程内 secret），**透明转发**
 *   3. 构造 pi-ai provider（openAICompletionsApi 指向 shim）
 *   4. 注册 provider 路由 `teleagent`
 *
 * 不再启动 TeleAgent kernel：kernel 是完整 agent runtime（人格 prompt、工具执行、
 * 会话管理全部硬编码），经它转发会丢掉 role 结构、多轮历史和工具调用链。
 * 直连上游后这三者都由 DSH 正常掌控，详见 `upstream.js` 的签名算法注释。
 *
 * @module dsh-connect-teleagent
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { MODELS, currentScope } from './models.js'
import { createShim } from './shim.js'
import { readUpstreamAuth, createUpstream, probeUpstream, authFingerprint } from './upstream.js'
import { startKernel, waitReady, createKernelTransport, probeKernelHealth, resolveKernelBinary, reapStaleKernels } from './kernel.js'
import { classifyUpstreamError, recordUpstreamError, clearUpstreamError } from './health.js'
import { createGuard } from './guard.js'
import { registerStatusRoutes, setAuthRefresher, setAccountAddedHook } from './status.js'
import { restorePendingBackup } from './add-account.js'
import { readStore, writeStore, saveEnabledModels, readLegacyStore, migrateLegacyToSettings, markLegacyMigrated, isLegacyMigrated } from './store.js'
import { listScopesWithCredential } from './account.js'
import { probeDetails } from './credential.js'
import { listAccounts, fetchAllAccountPoints, switchAccount as switchAccountFile, deleteAccount as deleteAccountFile } from './accounts.js'
import { isAppRunningNow } from './lifecycle.js'
import { createWelfare } from './welfare.js'
import { mountPointsTool } from './tools.js'
import { loadOpenAICompletionsApi } from './pi-ai-loader.js'
import { createAttachmentDeps } from './attachments.js'
import { IMAGE_REQUEST_BUDGET } from './image-budget.js'
import { createMcpBridge } from './mcp-bridge.js'
import { readPortalAuth } from './portal.js'
import { bootlog, resetBootlog } from './bootlog.js'

export { loadOpenAICompletionsApi } from './pi-ai-loader.js'

/**
 * 可热替换内部实现的 adapter 门面。
 *
 * ## 为什么必须存在（2026-11-09 事故）
 *
 * `ctx.llm.registerAdapter()` 通过 `ctx.effect` 把路由绑到**当前 fiber**：fiber
 * 卸载时宿主会从 `LlmRuntime.adapters` 里删掉 `teleagent`。宿主因 HMR /
 * profile patch 写入 / 配置重算重挂插件时，会先 dispose 旧 fiber（杀内核 →
 * 在途流 `terminated`），再跑新 `apply()`，并在 ~460ms 后按 `dsh-llm-retry`
 * 首次退避发起重试。
 *
 * 而真正干活的 `PiAiAdapter` 只能在**异步 `boot()` 末尾**构造（依赖动态 import、
 * kernel 就绪、shim 端口）—— bootlog 实测 `apply 进入 → provider 已注册`
 * 要 2.7–3.6 秒。若把注册也放在 boot 里，这 2.7–3.6 秒窗口内 `teleagent`
 * 没有 adapter，460ms 的重试必然撞上
 * `no adapter registered for provider "teleagent"`（NO_ADAPTER，且不在默认
 * retryableCodes 里 → 直接 `本轮运行失败`）。
 *
 * 解法：`apply()` **同步**注册一个门面，宿主 `registration()` 永远拿得到它；
 * `boot()` 完成后把内部实现换进去（同一个对象，宿主缓存的引用不变）。
 * 门面未就绪时给出明确的 `TRANSPORT` 错误（可重试），而不是 NO_ADAPTER。
 * 这样重试会排队等 boot 完成，而不是把整轮判死。
 *
 * 宿主对 adapter 调用的全部方法（见 dsh-llm `adapterStream`/`prepareCall`/
 * `LlmAdapter` 基类）：providerInfo / providerRetryPolicy / imageRequestTarget /
 * imageRequestPricing / listModels / resolveModel / prepareCall，以及
 * `prepareCall` 返回值里的 `stream`。全部一一转发。
 */
const ADAPTER_METHODS = Object.freeze([
  'providerInfo', 'providerRetryPolicy', 'imageRequestTarget',
  'imageRequestPricing', 'listModels', 'resolveModel', 'prepareCall',
])

export function createForwardingAdapter({ provider, notReadyMessage = 'TeleAgent 仍在启动中，请稍后重试' } = {}) {
  let inner = null
  let readyError = null
  const modelInfoShape = (id, model) => {
    const m = MODELS.find((row) => row.id === model)
    return {
      provider: id,
      id: model,
      name: m ? `${m.name} · x${m.creditMultiplier}` : model,
      input: m?.vision === true ? ['text', 'image'] : ['text'],
      context: { contextWindow: m?.contextWindow ?? 400000 },
      ...(m?.maxTokens !== undefined ? { defaultMaxTokens: m.maxTokens } : {}),
    }
  }
  const fallbackModels = () => MODELS.map((m) => ({
    provider,
    id: m.id,
    name: `${m.name} · x${m.creditMultiplier}`,
    input: m.vision === true ? ['text', 'image'] : ['text'],
  }))

  /** 未就绪时抛可重试的 TRANSPORT 错误（宿主 llm-retry 默认会重试它） */
  const notReadyError = () => {
    const error = new Error(readyError ? `${readyError}` : notReadyMessage)
    // 宿主 normalizeLlmFailure 读 own data 属性 code；TRANSPORT 在默认
    // retryableCodes 里，重试会排队等 boot 完成，而不是整轮失败。
    Object.defineProperty(error, 'code', { value: 'TRANSPORT' })
    return error
  }

  const facade = {
    setInner(next) { inner = next; readyError = null },
    setReadyError(message) { inner = null; readyError = message },
    get ready() { return inner !== null },
    // ---- 元数据方法：未就绪时给合理兜底，别让模型选择器/目录在启动窗口里报错
    providerInfo(id) {
      if (inner !== null) return inner.providerInfo(id)
      return { id, name: 'TeleAgent' }
    },
    providerRetryPolicy(id) {
      return inner !== null ? inner.providerRetryPolicy?.(id) : undefined
    },
    imageRequestPricing(id, model) {
      return inner !== null ? inner.imageRequestPricing?.(id, model) : undefined
    },
    imageRequestTarget(id, model, image) {
      if (inner !== null) return inner.imageRequestTarget(id, model, image)
      return { width: image?.width, height: image?.height, maxBytes: image?.bytes }
    },
    listModels(id) {
      if (inner !== null) return inner.listModels(id)
      return Promise.resolve(fallbackModels())
    },
    resolveModel(id, model) {
      if (inner !== null) return inner.resolveModel(id, model)
      return Promise.resolve(modelInfoShape(id, model))
    },
    prepareCall(id, model, signal) {
      if (inner !== null) return inner.prepareCall(id, model, signal)
      // 未就绪也要给出一个「可流」的入口：宿主 prepareCall 之后会立刻
      // 调 stream(options)，此时可能仍未就绪，由 stream 再抛可重试错误。
      return Promise.resolve({
        model: modelInfoShape(id, model),
        stream: (options) => facade.stream(options),
      })
    },
    stream(options) {
      if (inner !== null) return inner.stream(options)
      throw notReadyError()
    },
  }
  // 兜底：若宿主未来新增了未列出的方法，未就绪时给清晰的可重试错误，
  // 就绪后原样转发；绝不因为门面缺方法而伪装成 NO_ADAPTER。
  for (const method of ADAPTER_METHODS) {
    if (method in facade) continue
    facade[method] = (...args) => {
      if (inner === null) throw notReadyError()
      return inner[method]?.(...args)
    }
  }
  return facade
}

export const name = 'dsh-connect-teleagent'
/**
 * 依赖声明。
 *
 * 只列 `llm`（真正缺了就完全没法工作）。`settings` **故意不写进 inject**：
 * cordis 的 inject 是"必需服务"，缺一个就把 fiber 卡在 inactive
 * （`Fiber._refresh` 里 `epoch = INACTIVE`），apply 根本不会跑 —— 模型路由
 * 也就永远不会注册。宿主没 provide settings 的 profile 上，插件会彻底消失，
 * 而不是"少了个设置表单"。
 *
 * 取而代之：`ctx.get('settings')` 软探测（见 softGet），可用就走原生设置、
 * 不可用退回 lib/store.js 自持久化；`settings.configure()` 通过
 * `ctx.inject(['settings'], …)` 在服务就绪后补上（那只是回调，不门控启动）。
 */
export const inject = ['llm']

/**
 * 软取可选服务。
 * `ctx.x` 对未声明的服务会 THROW，`?.` 挡不住；`ctx.get(name)` 才是安全的。
 */
function softGet(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

export const TELEAGENT_PROVIDER = 'teleagent'
export const STREAM_IDLE_TIMEOUT_MS = 20 * 60 * 1000
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/* ------------------------------------------------------------------ *
 * 设置层：DSH 原生 settings（主） / 插件自持久化 JSON（兜底）
 * ------------------------------------------------------------------ *
 *
 * 契约见 `.temp/settings-contract.md`。四个可配置字段是**唯一权威列表**：
 * `providerDisabled` / `enabledModelIds` / `toolsAllowlist` / `autoClaimDaily`。
 *
 * ## 为什么 schema 要容错加载（不能顶层 `import z from '…'`）
 *
 * 插件在 profile 里是**符号链接**：Node 解析时用 realpath（`preserveSymlinks`
 * 默认 false），于是从本仓库向上找 node_modules，看不到 profile 的
 * node_modules —— 实测 `import('@deepseek-ai/schemastery')` 直接
 * `ERR_MODULE_NOT_FOUND`。而本机 `npm install` 会因 `~/.npm` 有 root 属主
 * 文件 EPERM，装不了依赖。
 *
 * 所以：`createRequire` 按「本仓库 → 各 profile 的 node_modules」顺序同步解析
 * （模块必须同步解析，因为 `export const Config` 要在 import 期就位，cordis
 * 靠 `plugin.Config` 取 schema）；全部失败时退到**内置最小 schema shim**。
 * shim 不追求完整语义，只求 `toJSON()` 与真正 schemastery **同构**（refs 间接
 * 引用）——宿主 settings 服务拿 `schema.toJSON()` 去重建表单，形状不对就渲染
 * 不出来。写入路径（`settings.update`）不依赖 schema，因此无论真假 schema，
 * 落盘都正确。
 */

/** 我们**声明**的 settings namespace（仅当宿主没暴露 Loader 条目 id 时作为兜底） */
export const TELEAGENT_SETTINGS_NS = 'dsh-connect-teleagent'

/** 可配置字段（顺序固定，便于状态文档/迁移/测试比对） */
export const SETTINGS_FIELDS = Object.freeze([
  'providerDisabled',
  'enabledModelIds',
  'toolsAllowlist',
  'autoClaimDaily',
])

/** 四个字段的默认值（与 lib/store.js 的 DEFAULTS 一致） */
export const SETTINGS_DEFAULTS = Object.freeze({
  providerDisabled: false,
  enabledModelIds: Object.freeze([]),
  // settings schema 只能表达 `[]`；插件的语义里 null 与 [] 都是「全发」
  toolsAllowlist: Object.freeze([]),
  autoClaimDaily: true,
})

/**
 * 把 schema 字段标记为 volatile（宿主支持时）。
 *
 * `volatile()` 从 schemastery 3.18.3 起才有（DSH 0.1.7 线的 settings 写入门控
 * 会读这个标记）。老版本没有该方法，此时退化成恒等 no-op —— 手写
 * `meta.volatile = true` 会绕过 schemastery 自己的校验，产出一个老消费者看不懂
 * 的 schema。内置 shim 一定实现 `volatile()`。
 *
 * 导出是为了让**两支**都能在任何机器上被测到：用哪个 schemastery 由依赖树
 * 决定，没有这个接缝的话，no-op 分支会在版本上移后悄悄失去覆盖。
 */
export function asVolatile(schema) {
  // 注意：schemastery 的 schema 是**函数对象**（`typeof === 'function'`），
  // 不能只用 `typeof === 'object'` 判断，否则真 schema 会被当成不支持而跳过
  // volatile 标记，宿主表单会把字段判成"需重启才生效"。
  if (schema !== null && (typeof schema === 'object' || typeof schema === 'function') && typeof schema.volatile === 'function') {
    try { return schema.volatile() } catch { return schema }
  }
  return schema
}

/**
 * 剥掉**一层** volatile 引用（`{ get(): T }` → `T`）。
 *
 * cordis 把 volatile 字段解析成活引用；读值时必须 `.get()`，否则拿到的是
 * 一个对象而不是值（例如 `config.toolsAllowlist` 变成 `{get}`，`Array.isArray`
 * 为 false，白名单静默失效）。
 */
export function unwrapVolatile(value) {
  if (value !== null && typeof value === 'object' && 'get' in value && typeof value.get === 'function') return value.get()
  return value
}

/**
 * 深拷贝一个配置值，把**任意深度**的 `{ get(): T }` 活引用替换成它解析出的值。
 *
 * `unwrapVolatile` 只剥调用方读的那一层，够普通读路径用。但把整个配置对象交给
 * settings 服务（或不认识活引用的代码）时不行：那边会 `structuredClone`/校验
 * 整棵对象，残留的引用会让校验报错只点名字段、不点原因
 * （`$.toolsAllowlist expected array but got [object Object]`）。
 *
 * 非引用值递归下去，嵌套的 volatile 字段也能被剥掉；数组和对象都**重建**而不是
 * 就地改，调用方的值不受影响。
 */
export function unwrapVolatileDeep(value) {
  if (value === null || typeof value !== 'object') return value
  if (typeof value.get === 'function') return unwrapVolatileDeep(value.get())
  if (Array.isArray(value)) return value.map((entry) => unwrapVolatileDeep(entry))
  const out = {}
  for (const key of Object.keys(value)) out[key] = unwrapVolatileDeep(value[key])
  return out
}

/**
 * 内置最小 schemastery 替身。
 *
 * 只在真 schemastery 完全解析不到时使用（宿主没有 settings 服务、或 profile
 * 布局里找不到依赖树）。它对外的关键契约只有三条：
 *  1. `toJSON()` 与真 schemastery **同构**（`{uid, refs:{id:{type,meta,dict,inner}}}`，
 *     dict/inner 里是 ref id 而不是内联节点）；
 *  2. `~standard.validate()` 返回 `{ value }`，volatile 字段返回 `{get()}` 活引用；
 *  3. `.default()/.description()/.volatile()/.simplify()` 可链式调用。
 *
 * 校验策略**故意宽松**（脏值退回默认值而不是抛错）：替身只在没有 settings 服务
 * 的宿主上出现，那里没人会写 schema 校验，而抛错会让整个插件起不来。
 */
export function createBuiltinSchemastery() {
  let nextUid = 0

  class Schema {
    constructor(type, { shape = null, inner = null, list = null } = {}) {
      this.type = type
      this.meta = {}
      this.shape = shape
      this.inner = inner
      this.list = list
      this.uid = ++nextUid
      /**
       * ⚠️ 必须是 `.dict`（不是只有内部的 `.shape`）。
       *
       * 宿主 `dsh-settings` 的 `volatileForm(schema)` 读的是**活对象**的
       * `schema.meta.volatile` / `schema.type` / `schema.dict`：
       *
       *   if (schema.type === "object") { ...Object.entries(schema.dict ?? {})... }
       *
       * dict 缺失时它是 `{}`，于是「一个 volatile 字段都没有」→ 返回 undefined
       * → 宿主的原生设置页**静默不渲染**（不报错、不留占位）。真实 schemastery
       * 的对象 schema 同时暴露 `.dict`（活子节点）和 toJSON 里的 refs 间接引用，
       * 替身必须给同名的属性，否则只在替身路径上丢表单。
       */
      this.dict = shape
      // 记录 volatile 引用工厂：校验时每个字段返回**新**引用，与真实现一致
      this.standard = {
        vendor: 'schemastery',
        version: 1,
        validate: (value) => ({ value: this.validatePlain(value) }),
      }
      this['~standard'] = this.standard
    }

    default(value) { this.meta.default = value; return this }
    description(text) { this.meta.description = text; return this }
    volatile() { this.meta.volatile = true; return this }

    /** 校验/归一化：脏值退默认值，未知键原样保留（与真实现一致） */
    validatePlain(value) {
      const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
      if (this.type === 'object') {
        const out = {}
        for (const [key, child] of Object.entries(this.shape ?? {})) {
          const field = child.validatePlain(Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined)
          if (child.meta.volatile === true) {
            // volatile 字段以活引用暴露：读值必须 `.get()`，与 cordis 的真实行为一致
            let current = field
            Object.defineProperty(out, key, {
              enumerable: true,
              configurable: true,
              value: {
                get: () => current,
                [Symbol.for('cosmokit.volatile.write')]: (next) => { current = next },
              },
            })
          } else {
            Object.defineProperty(out, key, { enumerable: true, configurable: true, writable: true, value: field })
          }
        }
        // 未知键（transport/guard/welfare 等）原样透传，不能被 schema 吃掉
        for (const [key, raw] of Object.entries(source)) {
          if (!Object.prototype.hasOwnProperty.call(this.shape ?? {}, key)) out[key] = raw
        }
        return out
      }
      if (this.type === 'array') {
        if (!Array.isArray(value)) return this.copyDefault()
        return value.filter((entry) => typeof entry === 'string')
      }
      if (this.type === 'boolean') return typeof value === 'boolean' ? value : this.copyDefault()
      if (this.type === 'string') return typeof value === 'string' ? value : this.copyDefault()
      return value === undefined ? this.copyDefault() : value
    }

    copyDefault() {
      const fallback = this.meta.default
      if (Array.isArray(fallback)) return [...fallback]
      if (fallback !== null && typeof fallback === 'object') return { ...fallback }
      return fallback
    }

    simplify(value) {
      const plain = unwrapVolatileDeep(value)
      if (plain === undefined) return null
      if (plain !== null && typeof plain === 'object' && !Array.isArray(plain)) {
        const out = {}
        for (const [key, child] of Object.entries(plain)) {
          const field = this.shape?.[key]
          const simplified = field ? field.simplify(child) : child
          const defaultOfField = field?.meta?.default
          if (field && defaultOfField !== undefined && JSON.stringify(simplified) === JSON.stringify(defaultOfField)) continue
          if (simplified !== null && simplified !== undefined) out[key] = simplified
        }
        return Object.keys(out).length === 0 ? null : out
      }
      return plain
    }

    toJSON() {
      const refs = {}
      const flatten = (node) => {
        const json = { type: node.type, meta: { ...node.meta } }
        if (node.type === 'object' && node.shape !== null) {
          json.dict = {}
          for (const [key, child] of Object.entries(node.shape)) json.dict[key] = flatten(child)
        }
        if (node.inner !== null) json.inner = flatten(node.inner)
        refs[node.uid] = json
        return node.uid
      }
      const uid = flatten(this)
      return { uid, refs }
    }
  }

  const z = {
    object: (shape = {}) => new Schema('object', { shape }),
    array: (inner) => new Schema('array', { inner: inner ?? z.any() }),
    boolean: () => new Schema('boolean'),
    string: () => new Schema('string'),
    any: () => new Schema('any'),
  }
  return z
}

/** profile 目录下的 node_modules 锚点（`createRequire` 只借路径，不需要文件存在） */
function profiledRequireAnchors() {
  const anchors = []
  try {
    const home = process.env.DSH_HOME ?? path.join(process.env.HOME ?? '', '.dsh')
    const profiles = path.join(home, 'profiles')
    for (const name of fs.readdirSync(profiles)) {
      anchors.push(path.join(profiles, name, 'node_modules', '.dsh-connect-teleagent-anchor.cjs'))
    }
  } catch { /* 没有 profile 目录：只用本地解析 */ }
  return anchors
}

/**
 * 同步解析 schemastery（真包优先，失败退内置 shim）。永不抛错。
 *
 * @param {{anchors?: string[], specifier?: string}} [options]
 * @returns {{ z: any, source: 'schemastery'|'builtin-fallback', specifier: string|null, anchor: string|null, failures: string[] }}
 */
export function loadSchemastery({ anchors, specifier = '@deepseek-ai/schemastery' } = {}) {
  const failures = []
  const candidates = [fileURLToPath(import.meta.url), ...(anchors ?? profiledRequireAnchors())]
  for (const anchor of candidates) {
    try {
      const mod = createRequire(anchor)(specifier)
      const z = mod?.default ?? mod
      if (typeof z?.object === 'function') {
        return { z, source: 'schemastery', specifier, anchor, failures }
      }
      failures.push(`${anchor}: 没有导出 object()`)
    } catch (error) {
      failures.push(`${anchor}: ${error?.code ?? error?.message ?? error}`)
    }
  }
  return { z: createBuiltinSchemastery(), source: 'builtin-fallback', specifier: null, anchor: null, failures }
}

const SCHEMA_RUNTIME = loadSchemastery()

/** schema 来源（`schemastery` / `builtin-fallback`）与解析失败原因，供排查与测试 */
export const SCHEMA_RUNTIME_INFO = Object.freeze({
  source: SCHEMA_RUNTIME.source,
  failures: Object.freeze([...SCHEMA_RUNTIME.failures]),
})

/**
 * 构造插件的 `Config` schema（导出是为了让测试能分别用**真** schemastery 与
 * 内置 shim 各跑一遍）。
 *
 * 只声明卡片能改的四个字段；`transport` / `guard` / `welfare` / `timeoutMs` 等
 * 属于 profile 级调优，不进表单（由 cords.patch.yml 手写）。未声明的键会被
 * schemastery 原样透传，所以两者互不影响。
 *
 * 每个字段都标 `volatile()`：宿主据此允许「保存后不重启、下一条请求立即生效」。
 *
 * @param {any} z schemastery（或内置 shim）
 */
export function buildConfigSchema(z) {
  return z.object({
    providerDisabled: asVolatile(
      z.boolean().default(false)
        .description('整体停用 TeleAgent：模型选择器里彻底看不到本插件的模型，但插件本身仍在运行（Disable the whole provider without unmounting the plugin）'),
    ),
    enabledModelIds: asVolatile(
      z.array(z.string()).default([])
        .description('启用的模型 id 列表；空数组 = 全部启用（Empty means every model is enabled）'),
    ),
    toolsAllowlist: asVolatile(
      z.array(z.string()).default([])
        .description('允许挂给模型的工具白名单，支持 bash* 后缀通配；空数组 = 全部发送（null 与 [] 在本插件语义中等价，写入一律落成 []）'),
    ),
    autoClaimDaily: asVolatile(
      z.boolean().default(true)
        .description('每日自动领取积分；关闭后只能手动领取（Turn off the daily credit claim; manual claim still works）'),
    ),
  })
}

/**
 * 宿主**实际**服务本插件所用的 settings namespace。
 *
 * `ctx.fiber.entry` 是 Loader 加的（不是 Cordis 本身的公开类型），在没有 Loader
 * 条目的宿主上不存在（测试桩、直接 `ctx.plugin()`）。所以要先探测、再回落到
 * 声明值。
 *
 * ⚠️ 这个区分不是装饰性的：宿主按**精确匹配**查表
 * （`entries().find(row => row.options.id === ns)`），declare 一个宿主并不服务的
 * 名字会得到 `No configurable plugin entry "…"`，表单与写入双双静默失效。
 */
export function settingsNamespaceOf(ctx) {
  const id = ctx?.fiber?.entry?.options?.id
  return typeof id === 'string' && id !== '' ? id : TELEAGENT_SETTINGS_NS
}

/**
 * 插件设置 schema（cordis 通过 `plugin.Config` 取它，宿主表单靠 `toJSON()` 渲染）。
 *
 * schema 来源见 {@link SCHEMA_RUNTIME_INFO}：真 schemastery 可用就用真的；
 * 本机解析不到时用内置同构 shim（写入路径不依赖 schema，所以落盘仍然正确）。
 */
export const Config = buildConfigSchema(SCHEMA_RUNTIME.z)

/**
 * 解析当前生效的工具白名单（纯函数，便于单测）。
 *
 * 优先级：**settings > store > 显式 config**。
 *
 * 为什么 settings 在最前：DSH 原生 settings 是本次统一后的主存储（卡片写它），
 * 它给出的值就是"用户最后一次在界面上做的选择"，必须直接生效。
 *
 * 为什么 store 曾经压过 config：设置卡片能改白名单，卡片写的曾是 store；
 * 若 config 仍然压过它，用户在界面上"保存/恢复全量"会显示成功但完全不生效
 * （卡片显示 store 值、请求却用 config 值，两边对不上）。这个道理现在原样
 * 转移到 settings 上：**谁被 UI 写过，谁优先**。store 保留在中间，是为了
 * 兼容"settings 服务不可用（或迁移尚未发生）"的宿主，此时旧卡片写下的值
 * 仍然要能生效。
 *
 * `config` 排最后：cordis 交来的 config 带着 schema 默认值（`[]`），没法和
 * "用户显式选了全发"区分，只能当最后一档。
 *
 * 状态卡片与请求期 getter 都调它，保证"显示的值 = 实际生效的值"。
 *
 * @param {{settings?: string[]|null, store?: string[]|null, config?: string[]|null}} sources
 * @returns {string[]|null} `null` 与 `[]` 都表示全发（见 lib/tools-filter.js）
 */
export function pickToolsAllowlist({ settings, store, config } = {}) {
  // settings 侧的"全发"是 `[]`（schema 表达不了 null），因此只有数组才算数；
  // null/undefined 一律视为"这一层没有值"，继续往下找。
  if (Array.isArray(settings)) return settings
  if (Array.isArray(store)) return store
  if (Array.isArray(config)) return config
  return null
}

/**
 * 把工具白名单的两种"全发"表示收敛成一种。
 *
 * settings schema 只能表达 `[]`，store 的历史值是 `null`，两者在
 * `lib/tools-filter.js` 里语义相同（`names.length === 0` 即全发）。读路径统一
 * 归一到 `[]`（settings 的表达），写路径也统一写 `[]` —— 状态文档、卡片、
 * 请求期 getter 三处必须给出**同一个**答案（契约 §2）。
 *
 * @param {any} value
 * @returns {string[]} 永远是数组：`[]` 表示全发
 */
export function normalizeToolsAllowlistValue(value) {
  if (!Array.isArray(value)) return []
  return value.filter((x) => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
}

/**
 * 工具桥是否真的挂在给定内核上（判定"模式限制"告警的唯一依据）。
 *
 * 为什么不能用 `bridge !== null` 判断：`mount()` 失败时只返回 `{ ok: false }`、
 * 不抛异常，所以"建好了"和"挂上了"是两件事。把它们混为一谈的后果是：
 * 桥没挂上时代码仍然认为工具可用 → 告警被抑制、卡片不显示任何限制，
 * 而模型实际一个 DSH 工具都调不到。
 *
 * @param {any} bridge 工具桥（可能为 null）
 * @param {any} kernel 当前内核句柄（可能为 null）
 * @returns {boolean}
 */
export function isBridgeMounted(bridge, kernel) {
  if (bridge === null || bridge === undefined || kernel === null || kernel === undefined) return false
  try {
    const mounted = bridge.mountedKernel?.() ?? null
    return mounted !== null && mounted === kernel
  } catch { return false }
}

const INERT_AUTH = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() { throw new Error('dsh-connect-teleagent: 该路由没有 pi-ai 凭据生命周期') },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

export function apply(ctx, config = {}) {
  resetBootlog()
  bootlog('apply 进入', { hasCtx: !!ctx, inject, schema: SCHEMA_RUNTIME_INFO.source })

  // ------------------------------------------------------------------ 设置层
  //
  // 读：settings 优先（DSH 原生），store 兜底（自持久化 JSON）。
  // 写：settings 优先，写不进去才写 store。
  //
  // ⚠️ 所有 settings 访问都必须 try/catch：`settings` 可能压根不存在
  // （宿主没 provide），也可能存在但形状不对（版本差异）。任何一次抛错都
  // 不能让插件起不来 —— 那会把"设置读不到"升级成"模型全部不可用"。
  //
  // namespace 是**实际生效值**（Loader 条目 id），不是我们声明的常量；
  // 见 settingsNamespaceOf 的注释。
  const settingsNamespace = settingsNamespaceOf(ctx)

  /** 软探 settings 服务（永不抛错） */
  const settingsHost = () => softGet(ctx, 'settings')

  /** settings 服务此刻是否真的可写（有 update 方法） */
  const settingsAvailable = () => {
    try {
      const host = settingsHost()
      return typeof host?.update === 'function'
    } catch { return false }
  }

  /**
   * 从 settings 读一个字段的**原始**值。
   *
   * cordis 把 volatile 字段解析成活引用，所以这里必须 `unwrapVolatile`；
   * 拿不到（服务缺失 / describe 失败 / 字段未配置）一律返回 `undefined`，
   * 让调用方继续走 store 兜底。
   *
   * 读取顺序：`get(ns)` → 没有就 `describe()` 里找同 ns 的 descriptor。
   * 前者是更直接的 API，后者是本机实测存在的形状。
   */
  const readSettingsField = (key) => {
    try {
      const host = settingsHost()
      if (host === undefined || host === null) return undefined
      const ns = settingsNamespace
      // 形状一：get(ns) → { [key]: value }
      if (typeof host.get === 'function') {
        try {
          const values = host.get(ns)
          if (values !== undefined && values !== null) {
            const raw = unwrapVolatile(unwrapVolatileDeep(values)[key])
            if (raw !== undefined) return raw
          }
        } catch { /* 该形状不支持，继续试 describe */ }
      }
      // 形状二：describe() → [{ ns, value }]
      if (typeof host.describe === 'function') {
        const rows = host.describe()
        const row = Array.isArray(rows) ? rows.find((entry) => entry?.ns === ns) : undefined
        if (row !== undefined && row !== null) {
          const values = unwrapVolatileDeep(row.value ?? row.user ?? {})
          const raw = values?.[key]
          if (raw !== undefined) return raw
        }
      }
      return undefined
    } catch { return undefined }
  }

  /**
   * 当前生效的配置快照（四个字段），settings 优先、store 兜底。
   *
   * 这是**唯一**的读入口：状态文档、卡片、请求期 getter 全部经过它，三处
   * 同源同答（契约 §2）。每次调用都重读，所以设置保存后下一条请求立即生效。
   */
  const readCurrent = () => {
    const stored = (() => {
      try { return readStore() } catch { return null }
    })()
    const read = (key, fallback) => {
      const fromSettings = readSettingsField(key)
      if (fromSettings !== undefined) return fromSettings
      const fromStore = stored?.[key]
      if (fromStore !== undefined) return fromStore
      return fallback
    }
    const providerDisabledSettings = readSettingsField('providerDisabled')
    const providerDisabledStored = stored?.providerDisabled
    const modelIdsSettings = readSettingsField('enabledModelIds')
    const modelIdsStored = stored?.enabledModelIds
    const allowSettings = readSettingsField('toolsAllowlist')
    const allowStored = stored?.toolsAllowlist
    const autoClaimStored = stored?.welfare?.autoClaimDaily
    const autoClaimSettings = readSettingsField('autoClaimDaily')
    return {
      providerDisabled: (providerDisabledSettings ?? providerDisabledStored ?? config?.providerDisabled === true) === true,
      enabledModelIds: (() => {
        const chosen = modelIdsSettings !== undefined
          ? modelIdsSettings
          : (modelIdsStored !== undefined ? modelIdsStored : config?.enabledModelIds)
        return Array.isArray(chosen) ? chosen.filter((x) => typeof x === 'string') : []
      })(),
      // 白名单走 pickToolsAllowlist：settings > store > config，优先级只在这一处定义。
      // 对外只保留一种"全发"表示（`[]`），schema 的 null 不可能出现，store 的 null 归一成 []
      toolsAllowlist: normalizeToolsAllowlistValue(
        pickToolsAllowlist({ settings: allowSettings, store: allowStored, config: config?.toolsAllowlist }),
      ),
      // settings 侧是顶层字段；store 的历史位置在 welfare 下
      autoClaimDaily: typeof autoClaimSettings === 'boolean'
        ? autoClaimSettings
        : (autoClaimStored === undefined ? true : autoClaimStored !== false),
    }
  }

  /**
   * 最新的配置快照。设置保存后下一条请求就生效 —— 不在 apply 时采样一次。
   *
   * `loader/volatile-update` 只用来刷新派生状态（模型选择器），不走热路径。
   */
  let currentConfig = readCurrent()
  const current = () => {
    // 每次读都重算：settings 服务可能在启动之后才就绪，缓存住会永久错过。
    currentConfig = readCurrent()
    return currentConfig
  }

  /** 一个字段的读数来源（供状态路由标注 via） */
  const sourceOf = (key) => {
    if (readSettingsField(key) !== undefined) return 'settings'
    return 'store'
  }

  /**
   * 写一个字段：settings 优先，写不进去返回 `false`（**不抛错**）。
   *
   * 返回 `false` 而不是抛异常，是给调用方一个明确的"退回 store"信号：
   * 按钮在两种宿主上都长得一样，抛错只会显示成"保存失败"，而宿主其实只是
   * 没有这个能力。
   */
  const writeSetting = async (key, value) => {
    try {
      const host = settingsHost()
      if (typeof host?.update !== 'function') return false
      await host.update(settingsNamespace, { [key]: value })
      return true
    } catch (error) {
      bootlog('settings 写入失败，退回 store', { key, error: String(error?.message ?? error) })
      return false
    }
  }

  /** 批量写补丁（settings 一次原子写入；不可用时返回 false） */
  const writeSettingsPatch = async (patch) => {
    try {
      const host = settingsHost()
      if (typeof host?.update !== 'function' || patch === null || typeof patch !== 'object') return false
      await host.update(settingsNamespace, patch)
      return true
    } catch (error) {
      bootlog('settings 批量写入失败', { error: String(error?.message ?? error) })
      return false
    }
  }

  /**
   * settings 侧是否**全部为默认值**（迁移判空用）。
   *
   * ⚠️ 三个返回值的语义截然不同（契约 §迁移）：
   *  - `true`  —— 明确为空，可以迁移
   *  - `false` —— 明确非空，**绝不能**覆盖
   *  - `undefined` —— 无法判断（服务缺失/读取异常），保守不迁移
   *
   * 返回 `true` 是唯一会触发写入的答案，所以拿不准时只能返回 `undefined`。
   */
  const settingsAllDefault = () => {
    try {
      const host = settingsHost()
      if (typeof host?.update !== 'function') return undefined
      const configured = (() => {
        if (typeof host.get === 'function') {
          try {
            const values = unwrapVolatileDeep(host.get(settingsNamespace) ?? {})
            if (values !== null && typeof values === 'object') return values
          } catch { /* 试 describe */ }
        }
        if (typeof host.describe === 'function') {
          const rows = host.describe()
          const row = Array.isArray(rows) ? rows.find((entry) => entry?.ns === settingsNamespace) : undefined
          if (row !== undefined && row !== null) {
            return unwrapVolatileDeep(row.value ?? row.user ?? {})
          }
        }
        return undefined
      })()
      if (configured === undefined) return undefined
      for (const key of SETTINGS_FIELDS) {
        const value = configured[key]
        if (value === undefined) continue
        const fallback = SETTINGS_DEFAULTS[key]
        if (Array.isArray(fallback)) {
          if (normalizeToolsAllowlistValue(value).length > 0) return false
          continue
        }
        if (value !== fallback) return false
      }
      return true
    } catch { return undefined }
  }

  // 上一次「添加账号」如果崩在中间（备份清单还在、原账号 token 被应用删了），
  // 这里先把凭据写回去，避免用户看到"登录态莫名其妙没了"。
  try {
    const recovered = restorePendingBackup()
    if (recovered.restored === true) bootlog('已恢复原账号登录态备份', recovered)
  } catch (error) {
    bootlog('恢复原账号登录态备份失败', error)
  }

  // ------------------------------------------------------ settings 注册与迁移
  //
  // `configure({ auto: true })` 让宿主把本插件的表单**自动生成**在设置页里
  // （不需要我们手写 section id）。它必须放在 `ctx.inject(['settings'])` 里：
  // 服务没就绪时 `ctx.settings` 会抛（`?.` 挡不住），inject 回调保证就绪后才跑。
  //
  // `ctx.fiber` 是 owner：presentation 是**按插件实例**记的，同一个实例重复
  // configure 会抛 "already configured"，所以 disposer 交给 ctx.effect 管。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['settings'], (settingsCtx) => {
        try {
          const host = settingsCtx?.settings
          if (typeof host?.configure !== 'function') {
            bootlog('settings 服务没有 configure，跳过自动表单')
            return
          }
          ctx.effect(() => host.configure({ auto: true }, ctx.fiber))
          bootlog('settings.configure(auto) 已注册', { ns: settingsNamespace })
        } catch (error) {
          bootlog('settings.configure 失败（不影响插件启动）', error)
        }
      })
    } catch (error) {
      bootlog('ctx.inject(settings) 失败（不影响插件启动）', error)
    }
  }

  // 设置热更新：宿主把新的 volatile 值写进活引用后发这个事件。
  // 这里只需要刷新派生状态（模型选择器）；请求路径每次都重读 current()，不必等它。
  try {
    ctx.on?.('loader/volatile-update', () => {
      try {
        currentConfig = readCurrent()
        registryInvalidate?.()
        bootlog('配置已热更新', currentConfig)
      } catch (error) {
        bootlog('热更新处理失败', error)
      }
    })
  } catch (error) {
    bootlog('注册 loader/volatile-update 失败', error)
  }

  /**
   * 旧 JSON → settings 一次性迁移。
   *
   * 顺序与幂等由 lib/store.js 的纯函数负责，这里只负责接线（契约见
   * `.temp/settings-contract.md` §1）：迁移源保留，settings 非空时绝不覆盖。
   * 异步执行、不阻塞 boot：迁移失败只影响"设置是否搬过去"，不影响模型可用。
   */
  const migrateLegacySettings = async () => {
    try {
      const legacyHome = undefined
      const legacy = readLegacyStore(legacyHome)
      if (legacy === null) return
      if (isLegacyMigrated(legacyHome)) return
      const result = await migrateLegacyToSettings({
        legacy,
        // ⚠️ 拿不到 settings 时返回 undefined（"无法判断"），绝不能返回 true：
        // true 是唯一会触发写入的答案，误判会覆盖用户配置。
        isSettingsEmpty: () => settingsAllDefault(),
        writeSettings: (patch) => writeSettingsPatch(patch),
      })
      if (result.migrated === true) {
        markLegacyMigrated(legacyHome)
        bootlog('旧设置已迁移到 DSH settings', { fields: result.fields })
      } else if (result.reason !== 'no-legacy' && result.reason !== 'already-migrated') {
        bootlog('旧设置未迁移（保持原样）', { reason: result.reason })
      }
    } catch (error) {
      bootlog('迁移旧设置失败（不影响启动）', error)
    }
  }
  void migrateLegacySettings()

  let stopped = false
  let shim
  let closeAdapter
  /**
   * adapter 门面：**同步注册**，内部实现由 `boot()` 完成后注入。
   * `closeAdapter` 是它的 disposer；`adapterRegistrationDisposer` 是宿主
   * registerAdapter 返回的同一个 disposer 的幂等包装。
   *
   * ⚠️ 绝不能把注册推迟到异步 `boot()`：宿主 fiber 重挂期间会先注销旧路由，
   * 而 ~460ms 后的重试落在新 boot 的 2.7–3.6 秒窗口里 → NO_ADAPTER。
   */
  const forwardingAdapter = createForwardingAdapter({ provider: TELEAGENT_PROVIDER })
  let adapterRegistrationDisposer = null
  /**
   * 传输方式：
   *   'kernel' —— 驱动 TeleAgent 自己的 Go 内核（默认；流量是原生流量，三个账号被封后的选择）
   *   'direct' —— 插件自己签名直连上游（旧实现，保留作为回退/对比）
   */
  const transport = config?.transport === 'direct' ? 'direct' : 'kernel'
  let kernelHandle = null
  let kernelTransport = null
  let kernelError = null
  /** 工具桥：把 DSH 的工具经 MCP 挂到内核（不碰系统提示词） */
  let toolBridge = null
  /** 工具桥最近一次挂载失败的原因（null = 没失败过）；卡片告警会带上它 */
  let toolBridgeError = null
  /** 内核就绪信号：resolve 后 transport 才发请求（避免开机窗口期的假失败） */
  let kernelReadyResolve = null
  let kernelReady = null
  const resetKernelReady = () => {
    kernelReady = new Promise((resolve) => { kernelReadyResolve = resolve })
  }
  const markKernelReady = () => { try { kernelReadyResolve?.() } catch { /* ignore */ } }
  resetKernelReady()

  let closeStatusRoutes
  let closeTools
  let registryInvalidate

  /**
   * 直连客户端缓存。
   * 用凭据指纹（token.json 的 mtime+size）判断是否需要重建：
   * 重新登录或换账号后指纹变化，下一次请求就会用新凭据，无需重启。 
   */
  let upstreamCache = null
  let upstreamError = null

  /**
   * 并发节流 + 熔断。整个插件共享一个实例：
   * 换账号时复位，避免旧账号的熔断状态影响新账号。
   */
  const guard = createGuard(config?.guard ?? {})

  /**
   * 积分福利：余额缓存 + 每日自动领取。
   * 与聊天链路完全解耦——portal 走 cookie 鉴权，失败也只影响卡片显示。
   */
  const welfare = createWelfare({
    getAuth: async () => {
      try { return readPortalAuth() } catch { return null }
    },
    store: {
      read: () => readStore(),
      write: (patch) => writeStore(patch),
    },
    logger: ctx.logger,
  }, config?.welfare ?? {})

  // 新账号登录成功后，积分缓存属于旧账号，必须立刻作废
  setAccountAddedHook(() => {
    try { welfare.markStale() } catch { /* ignore */ }
  })

  /**
   * 当前生效的模型 id。
   * 优先级：settings > store > 全部启用（三者都在 current() 里合并好了）。
   */
  /** 是否整体停用（settings 优先，store 兜底） */
  const isProviderDisabled = () => current().providerDisabled === true

  const enabledIds = () => {
    const list = current().enabledModelIds
    if (list.length > 0) return list.filter((id) => MODELS.some((m) => m.id === id))
    return MODELS.map((m) => m.id)
  }

  /**
   * 当前生效的工具白名单（settings 优先，见 pickToolsAllowlist 的注释）。
   * 状态卡片与请求期 getter 共用，保证"显示的值 = 实际生效的值"。
   *
   * 返回 `string[]|null`：`null`（或空数组）表示全发。
   */
  const resolveToolsAllowlist = () => {
    try {
      const allow = current().toolsAllowlist
      // 空数组 = 全发；对外仍用 null 表达，与状态路由的归一化一致
      return allow.length === 0 ? null : allow
    } catch { return null }
  }

  /** 自动领取积分开关（settings 优先，store 兜底） */
  const resolveAutoClaimDaily = () => {
    try { return current().autoClaimDaily === true } catch { return true }
  }

  /**
   * 把工具桥挂到内核，并把"是否真的挂上"记进状态。
   *
   * `mount()` 失败只返回 `{ ok: false }` 不抛异常，所以不能靠 try/catch 判断：
   * 必须看返回值，否则桥没挂上也会被当成已就绪 —— 告警被抑制、卡片不显示限制，
   * 而模型实际上一个 DSH 工具都调不到。
   *
   * @returns {Promise<boolean>} 是否挂载成功
   */
  const mountToolBridge = async (kernel, { force = false } = {}) => {
    if (toolBridge === null) return false
    try {
      const result = await toolBridge.mount(kernel, { force })
      if (result?.ok === true) {
        toolBridgeError = null
        return true
      }
      toolBridgeError = String(result?.error ?? '未知原因')
      bootlog('工具桥挂载未成功', { error: toolBridgeError, force })
      return false
    } catch (error) {
      toolBridgeError = String(error?.message ?? error)
      bootlog('工具桥挂载抛错', { error: toolBridgeError, force })
      return false
    }
  }

  /** 工具桥是否真的挂在当前内核上（判定告警的唯一依据） */
  const isToolBridgeMounted = () => isBridgeMounted(toolBridge, kernelHandle)

  /**
   * 建桥 + 挂载（boot 与重启内核共用同一条路径）。
   *
   * 失败后把 `toolBridge` 置回 null：桥对象本身留着没意义（它没挂上，
   * transport 里 `getBridge()` 拿到的会是一个挂不上的桥），置空还能让
   * 状态卡片如实显示"工具桥未就绪"。
   */
  const setupToolBridge = async (kernel) => {
    toolBridgeError = null
    if (config?.toolBridge === false) {
      // 用户显式关掉：不建桥，也不算失败（卡片不该告警）
      return false
    }
    try {
      toolBridge = await createMcpBridge({ logger: ctx.logger })
    } catch (error) {
      toolBridge = null
      toolBridgeError = String(error?.message ?? error)
      bootlog('工具桥创建失败', { error: toolBridgeError })
      return false
    }
    const ok = await mountToolBridge(kernel)
    if (ok) {
      bootlog('工具桥已挂载', { url: toolBridge.url })
    } else {
      // 建出来但没挂上：关掉 MCP 服务端避免占端口，并置空让卡片告警
      try { void toolBridge?.close?.() } catch { /* ignore */ }
      toolBridge = null
    }
    return ok
  }

  /** 取直连客户端；凭据缺失时抛错，由 shim 转成 OpenAI 错误返回 */
  const getUpstream = () => {
    const fingerprint = authFingerprint()
    if (upstreamCache !== null && upstreamCache.fingerprint === fingerprint) {
      return upstreamCache.client
    }
    // ---- kernel 传输：由 TeleAgent 内核负责鉴权与签名
    if (transport === 'kernel') {
      if (kernelTransport !== null) {
        upstreamCache = { fingerprint, client: kernelTransport }
        return kernelTransport
      }
      if (kernelError !== null) throw kernelError
      throw new Error('kernel 尚未就绪（仍在启动中）')
    }
    try {
      const auth = readUpstreamAuth()
      const client = createUpstream(auth, {
        baseUrl: config?.baseUrl,
        timeoutMs: config?.timeoutMs,
        guard,
      })
      // 换了账号/重新登录：清掉上一个账号的错误状态，
      // 否则卡片会继续显示「账号封禁」，误导用户
      if (upstreamCache === null || upstreamCache.fingerprint !== fingerprint) {
        clearUpstreamError()
        guard.reset()
      }
      upstreamCache = { fingerprint, client }
      upstreamError = null
      return client
    } catch (error) {
      // 凭据不可用：清掉缓存，下次再试
      upstreamCache = null
      upstreamError = error
      throw error
    }
  }

  /**
   * 重启内核。
   *
   * kernel 只在启动时读一次登录态，所以换了账号/重新登录后必须重启它，
   * 否则它还在用旧 token（或根本起不来）。
   */
  /** 供 kernel 传输层调用：重启内核并返回新句柄（失败返回 null） */
  const reviveKernel = async () => {
    await restartKernel()
    return kernelHandle
  }

  /**
   * 重启内核句柄。
   *
   * **不重建 transport**：transport 通过 `getKernel()` 每次取当前句柄，
   * 所以只要把 `kernelHandle` 换掉，正在使用的 transport 就会跟到新内核
   * （shim 缓存的 client 也不必失效）。
   */
  const restartKernel = async () => {
    if (transport !== 'kernel') return
    try { kernelHandle?.stop?.() } catch { /* ignore */ }
    // 旧桥的 MCP 服务端随 close() 一起关掉，URL 随即失效 —— 必须整个丢弃重建。
    // 只 close 不重建的话，新内核会被挂上一个连不上的地址：
    // mount() 表面成功（内核接受了 POST /mcp），工具实际全不可用。
    try { void toolBridge?.close?.() } catch { /* ignore */ }
    toolBridge = null
    toolBridgeError = null
    kernelHandle = null
    kernelError = null
    try {
      resetKernelReady()
      const next = await startKernel({
        allowedTools: config?.kernelAllowedTools ?? [],
        // 默认用 permission deny 关掉内核自带工具：当前内核并不执行 prompt 里的 `tools`
        // 开关（实测带 false 仍会跑 builtin bash），会在一次 DSH 请求里自己跑完多步工具，
        // 把多段 assistant text 拼成没有分隔的“长墙”。
        denyBuiltinTools: config?.denyBuiltinTools !== false,
      })
      await waitReady(next, config?.kernelReadyTimeoutMs ?? 60_000)
      kernelHandle = next
      // 新内核要重新挂一次 MCP（旧连接随进程消失了）
      await setupToolBridge(next)
      markKernelReady()
      bootlog('kernel 已重启', { base: next.base, pid: next.child?.pid ?? null })
    } catch (error) {
      kernelError = error
      bootlog('kernel 重启失败', { error: String(error?.message ?? error) })
    }
  }

  /** 凭据变化（登录完成）后重建客户端 */
  const refreshUpstream = () => {
    if (transport === 'kernel') void restartKernel()
    upstreamCache = null
    upstreamError = null
    try { getUpstream() } catch { /* 留待下次请求时报告 */ }
    try { registryInvalidate?.() } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------- 状态路由
  //
  // 必须在 `ctx.inject(['webServer'], …)` 里注册：Desktop 的启动顺序不固定，
  // boot 阶段 `ctx.get('webServer')` 可能还是 undefined（实测踩过：路由 0 条 → 卡片 404）。
  // inject 会在服务就绪后回调，启动顺序就不会让注册消失。
  const buildStatusDeps = () => ({
    // 配置来源标注：status.js 的 settingsViaOf 会**优先**用这个。
    // 必须区分「settings 不可用」和「命名空间刚好叫 dsh-connect-teleagent」——
    // 后者是合法名字，不能当可用信号（否则降级场景会被错标成 via='settings'）。
    settingsSource: () => (settingsAvailable() ? 'settings' : 'store'),
    settingsAvailable: () => settingsAvailable(),
    // ⚠️ 无 settings 服务时必须返回 null（不是兜底 id）：status.js 拿它当弱信号
    settingsNamespace: () => (settingsAvailable() ? settingsNamespace : null),
    transport: () => ({
      mode: transport,
      ready: transport === 'kernel' ? kernelTransport !== null : true,
      kernel: kernelHandle === null ? null : { base: kernelHandle.base, pid: kernelHandle.child?.pid ?? null },
      // v0.10 起 kernel 通过 MCP 桥支持 DSH 工具；只有**确实没挂上**时才提示。
      // 注意判据不是 `toolBridge === null`：mount() 失败只返回 { ok: false } 不抛异常，
      // 桥对象照样存在，用 null 判断会把"建了但没挂上"漏成"已就绪"，告警被抑制。
      warning: transport === 'kernel' && !isToolBridgeMounted() && config?.toolBridge !== false
        ? `工具桥未就绪：本轮模型可能无法调用 DSH 工具${toolBridgeError === null ? '，请查看日志或重启 DSH' : `（${toolBridgeError}）`}`
        : null,
      toolBridge: { mounted: isToolBridgeMounted(), error: toolBridgeError },
      error: kernelError === null ? null : String(kernelError?.message ?? kernelError),
      lastRequest: kernelTransport?.lastRequest?.() ?? null,
    }),
    upstream: () => {
      try {
        const u = getUpstream()
        return { ready: true, baseUrl: u.url, accountName: u.auth?.accountName }
      } catch (error) {
        return { ready: false, error: error?.message ?? String(error), code: error?.code, remedy: error?.remedy }
      }
    },
    guard: () => guard.snapshot(),
    provider: () => ({ disabled: isProviderDisabled() }),
    allowChatProbe: config?.ui?.allowChatProbe === true,
    probeModel: async (model) => {
      // 由 /probe 路由在显式开启后调用：发一次最小请求，返回可用性与错误语义
      const started = Date.now()
      try {
        const client = getUpstream()
        const res = await client.chat({
          model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          stream: false,
        })
        const elapsed = Date.now() - started
        if (res.status === 200) return { ok: true, model, status: 200, elapsedMs: elapsed }
        const info = classifyUpstreamError(res.status, res.json, res.text)
        return { ok: false, model, status: res.status, elapsedMs: elapsed, ...info }
      } catch (error) {
        return { ok: false, model, status: 0, elapsedMs: Date.now() - started, code: 'network', message: String(error?.message ?? error) }
      }
    },
    listAccounts: () => listAccounts(),
    accountPoints: (scopes) => fetchAllAccountPoints(scopes),
    appRunning: (() => { try { return isAppRunningNow() } catch { return false } })(),
    switchAccount: ({ scope, dryRun }) => {
      const result = switchAccountFile({ scope, dryRun, appRunning: (() => { try { return isAppRunningNow() } catch { return false } })() })
      if (result.ok && result.changed) {
        // 切换后立刻重读凭据：内核是带着启动时的 token 跑起来的，
        // 不重建的话下一次请求还会用旧账号（之前只能靠重启 DSH）。
        try { welfare.markStale() } catch { /* ignore */ }
        refreshUpstream()
      }
      return result
    },
    capabilities: () => ({ deleteAccount: true }),
    deleteAccount: ({ scope, mode, dryRun }) => deleteAccountFile({
      scope,
      mode,
      dryRun,
      appRunning: (() => { try { return isAppRunningNow() } catch { return false } })(),
    }),
    credentialProbe: () => {
      try { return probeDetails() } catch { return null }
    },
    // 卡片显示的值必须就是请求期实际生效的值，否则用户改完看到"保存成功"却毫无变化。
    // 三项都带 per-field `via` 信封，status.js 会逐字段标注来源。
    toolsAllowlist: () => ({ value: resolveToolsAllowlist(), via: sourceOf('toolsAllowlist') }),
    setToolsAllowlist: async (value) => {
      // 写路径统一写 `[]`（settings schema 表达不了 null）：null 与 [] 都是"全发"
      const next = normalizeToolsAllowlistValue(value)
      if (await writeSetting('toolsAllowlist', next)) {
        return { ok: true, via: 'settings', value: next.length === 0 ? null : next }
      }
      // settings 写不进去 → 退回 store（历史形态仍用 null 表达全发）
      try { writeStore({ toolsAllowlist: next.length === 0 ? null : next }) } catch (error) {
        return { ok: false, via: 'store', reason: String(error?.message ?? error) }
      }
      return { ok: true, via: 'store', value: next.length === 0 ? null : next }
    },
    setProviderDisabled: async (disabled) => {
      const next = disabled === true
      try { registryInvalidate?.() } catch { /* ignore */ }
      if (await writeSetting('providerDisabled', next)) return { ok: true, via: 'settings', value: next }
      try { writeStore({ providerDisabled: next }) } catch (error) {
        return { ok: false, via: 'store', reason: String(error?.message ?? error) }
      }
      return { ok: true, via: 'store', value: next }
    },
    welfareSnapshot: () => welfare.snapshot(),
    welfareEnsureFresh: () => welfare.ensureFresh(),
    refreshWelfare: () => welfare.refreshAll(),
    claimWelfare: () => welfare.claim({ source: 'manual' }),
    // autoClaimDaily 是四项可配置字段之一：settings 优先，store 兜底。
    // 不能只读 welfare 快照里那份 store 缓存值 —— 那会和真实生效值分叉。
    autoClaimDaily: () => ({ value: resolveAutoClaimDaily(), via: sourceOf('autoClaimDaily') }),
    setAutoClaimDaily: async (enabled) => {
      const next = enabled === true
      if (await writeSetting('autoClaimDaily', next)) return { ok: true, via: 'settings', value: next }
      try { welfare.setAutoClaimDaily(next) } catch (error) {
        return { ok: false, via: 'store', reason: String(error?.message ?? error) }
      }
      return { ok: true, via: 'store', value: next }
    },
    account: () => {
      let scope = null
      try { scope = currentScope() } catch { /* 未登录 */ }
      return { scope, scopes: listScopesWithCredential().length }
    },
    // 清除登录态后：丢弃缓存的客户端、复位熔断、清掉上游错误，让模型选择器反映未登录
    onCredentialCleared: () => {
      upstreamCache = null
      upstreamError = null
      clearUpstreamError()
      guard.reset()
      try { registryInvalidate?.() } catch { /* ignore */ }
      bootlog('凭据已清除，客户端已复位')
    },
    // ⚠️ 必须是 getter（不是注册时求值一次的裸值）：settings 更新后
    // 模型选择器要跟着变，裸值只反映 apply 那一刻。
    enabledModelIds: () => ({ value: enabledIds(), via: sourceOf('enabledModelIds') }),
    saveEnabledModelIds: async (ids) => {
      // **settings 优先，store 兜底**（DSH 原生设置是主存储）
      const clean = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x.length > 0) : []
      const via = (await writeSetting('enabledModelIds', clean)) ? 'settings' : (() => {
        try { saveEnabledModels(clean); return 'store' } catch { return null }
      })()
      if (via === null) return { ok: false, via: 'store', reason: '写入失败' }
      // 让模型选择器立即反映新勾选
      try { registryInvalidate?.() } catch { /* ignore */ }
      return { ok: true, via, value: clean }
    },
  })

  const warn = (message, error) => ctx.logger?.warn?.(message, error)

  const registerRoutesOn = (webCtx) => {
    const webServer = webCtx?.webServer ?? webCtx
    if (typeof webServer?.register !== 'function') {
      bootlog('webServer 不可用，跳过状态路由', { type: typeof webServer, keys: webServer === undefined ? [] : Object.keys(webServer).slice(0, 10) })
      return
    }
    try {
      const dispose = registerStatusRoutes({ webServer, deps: buildStatusDeps, warn })
      closeStatusRoutes = dispose
      bootlog('状态路由注册完成', { routes: 3 })
      // 跟随子上下文生命周期清理
      if (typeof webCtx?.effect === 'function') {
        webCtx.effect(() => () => { try { dispose?.() } catch { /* ignore */ } })
      }
    } catch (error) {
      bootlog('状态路由注册失败', error)
      warn('dsh-connect-teleagent: 状态路由不可用（卡片将无法显示）', error)
    }
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (webCtx) => {
        bootlog('webServer 就绪（inject 回调）', { hasRegister: typeof webCtx?.webServer?.register === 'function' })
        registerRoutesOn(webCtx)
      })
    } catch (error) {
      bootlog('ctx.inject(webServer) 失败', error)
    }
  } else {
    // 老宿主回退：直接取服务
    const ws = softGet(ctx, 'webServer')
    bootlog('webServer 探测（回退 ctx.get）', { found: ws !== undefined })
    if (ws !== undefined) registerRoutesOn(ws)
  }

  // ------------------------------------------------------------------ adapter
  //
  // **必须在 apply() 同步阶段注册**（见 createForwardingAdapter 的注释）：
  // 宿主 fiber 重挂时旧路由被注销，460ms 后的重试必须能拿到一个 adapter。
  // 这里只注册门面；真正的 PiAiAdapter 由 boot() 末尾 `setInner()` 注入。
  //
  // 所有异常都兜住：llm 服务缺失（老宿主/mock）、重复注册（DUPLICATE_ADAPTER）
  // 都不能让插件起不来 —— 但会记进 bootlog 便于诊断。
  try {
    const register = ctx.llm?.registerAdapter
    if (typeof register === 'function') {
      const reg = register.call(ctx.llm, [TELEAGENT_PROVIDER], forwardingAdapter)
      adapterRegistrationDisposer = () => { try { reg?.() } catch { /* ignore */ } }
      closeAdapter = () => {
        try { adapterRegistrationDisposer?.() } catch { /* ignore */ }
        adapterRegistrationDisposer = null
      }
      bootlog('adapter 门面已同步注册', { id: TELEAGENT_PROVIDER })
    } else {
      bootlog('llm.registerAdapter 不可用，跳过同步注册（老宿主）')
    }
  } catch (error) {
    bootlog('adapter 门面同步注册失败', error)
  }

  const boot = async () => {
    bootlog('boot 开始')
    const [{ openAICompletionsApi }, { PiAiAdapter }, { resolveRetryPolicy, resolveImageAttachmentAccess }] = await Promise.all([
      loadOpenAICompletionsApi(),
      import('@deepseek-ai/dsh-llm-pi-ai'),
      import('@deepseek-ai/dsh-llm'),
    ])
    const { createProvider } = await import('@earendil-works/pi-ai')
    bootlog('运行时装依赖已加载')

    // 先尝试建立客户端；失败不阻塞装配，让卡片能显示原因并引导登录
    // ---- kernel 传输：先拉起内核并等待就绪（失败不阻塞装配，卡片会报告）
    if (transport === 'kernel') {
      // 收拾上一次 DSH 退出时留下的孤儿内核：它们不仅占端口，还会继续跑上一轮
      // （实测会自己调模型、执行内置 bash），属于无人值守的真实流量。
      try {
        const reap = await reapStaleKernels({ logger: ctx.logger })
        if (reap.killed.length > 0) bootlog('已清理遗留内核', { pids: reap.killed })
      } catch (error) {
        bootlog('清理遗留内核失败', error)
      }
      try {
        kernelHandle = await startKernel({
          allowedTools: config?.kernelAllowedTools ?? [],
          denyBuiltinTools: config?.denyBuiltinTools !== false,
        })
        bootlog('kernel 已拉起', { base: kernelHandle.base, pid: kernelHandle.child?.pid, bin: resolveKernelBinary() })
        await waitReady(kernelHandle, config?.kernelReadyTimeoutMs ?? 60_000)
        kernelTransport = createKernelTransport({
          kernel: kernelHandle,
          getKernel: () => kernelHandle,
          revive: reviveKernel,
          waitReady: () => kernelReady,
          // 用 getter：transport 先创建、工具桥后创建，不能在这里拷贝快照
          getBridge: () => toolBridge,
          // 工具白名单：热读取（设置卡片写 store，所以 store 优先于 config，
          // 详见 resolveToolsAllowlist 的注释）
          getToolsAllowlist: () => resolveToolsAllowlist(),
          logger: ctx.logger,
        })
        kernelError = null

        // 工具桥：内核原生 MCP，不修改系统提示词。
        // 必须看 mount() 的返回值（它失败不抛异常），见 setupToolBridge。
        await setupToolBridge(kernelHandle)

        markKernelReady()
        bootlog('kernel 就绪', { base: kernelHandle.base })
      } catch (error) {
        kernelError = error
        kernelTransport = null
        markKernelReady()   // 失败也要放行，让请求拿到真实错误而不是一直等
        bootlog('kernel 启动失败', { error: String(error?.message ?? error) })
        ctx.logger?.warn?.('dsh-connect-teleagent: kernel 启动失败（模型调用会失败，卡片会说明原因）', error?.message ?? error)
      }
    }

    try { getUpstream(); bootlog('上游客户端就绪', { transport }) } catch (error) {
      bootlog('上游客户端失败', error)
      ctx.logger?.warn?.(`dsh-connect-teleagent: ${error.message}`)
    }
    if (stopped) {
      forwardingAdapter.setReadyError('TeleAgent 已停用（插件正在卸载）')
      cleanupLateBootResources()
      return
    }

    shim = await createShim({
      getUpstream,
      logger: ctx.logger,
      // 一次对话可能消耗积分，结束即把余额缓存标记为过期，
      // 胶囊下一次轮询（3 秒内）就会去上游取新值
      onTurnComplete: () => welfare.markStale(),
    })
    bootlog('shim 已启动', { port: shim.port })
    if (stopped) {
      forwardingAdapter.setReadyError('TeleAgent 已停用（插件正在卸载）')
      cleanupLateBootResources()
      return
    }

    // 启动自检：默认只读 portal（免费、无模型流量），确认账号可读；
    // 只有显式配置 probeOnBoot=true 才发一次真实聊天请求。
    void (async () => {
      try {
        const client = getUpstream()
        if (transport === 'kernel' && kernelHandle !== null) {
          const health = await probeKernelHealth(kernelHandle)
          if (health.ok) { clearUpstreamError(); bootlog('启动自检（kernel）通过', { status: health.status }) }
          else { bootlog('启动自检（kernel）失败', { status: health.status, detail: health.detail }) }
          return
        }
        if (config?.probeOnBoot !== true) {
          const { readPortalAuth, fetchPoints } = await import('./portal.js')
          const pa = readPortalAuth()
          const points = pa ? await fetchPoints(pa) : { ok: false, error: '无 portal 凭据' }
          if (points.ok) { clearUpstreamError(); bootlog('启动自检（portal）通过', { balance: points.balance }) }
          else { bootlog('启动自检（portal）失败', { error: points.error }) }
          return
        }
        const result = await probeUpstream(client.auth, { allow: true, timeoutMs: config?.probeTimeoutMs ?? 15000 })
        if (result.ok) {
          clearUpstreamError()
          bootlog('启动自检通过')
        } else {
          const info = classifyUpstreamError(result.status, result.json, result.text)
          recordUpstreamError(info)
          bootlog('启动自检失败', info)
          ctx.logger?.warn?.(`dsh-connect-teleagent: 上游自检失败 — ${info.message}${info.remedy ? `（${info.remedy}）` : ''}`)
        }
      } catch (error) {
        bootlog('启动自检异常', error)
      }
    })()

    const baseUrl = `${shim.baseUrl()}/v1`
    const buildModels = () => (isProviderDisabled() ? [] : MODELS.filter((m) => enabledIds().includes(m.id))).map((m) => ({
      id: m.id,
      name: `${m.name} · x${m.creditMultiplier}`,
      api: 'openai-completions',
      provider: TELEAGENT_PROVIDER,
      baseUrl,
      // 只有实测支持视觉的模型才向 DSH 声明 image，否则 DSH 会发图片而模型不接受
      input: m.vision === true ? ['text', 'image'] : ['text'],
      cost: NO_COST,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      reasoning: false,
      compat: { supportsReasoningEffort: false },
    }))

    const provider = createProvider({
      id: TELEAGENT_PROVIDER,
      name: 'TeleAgent',
      auth: {
        apiKey: {
          name: 'TeleAgent loopback secret',
          async resolve({ credential }) {
            const key = credential?.key
            return key === undefined || key.length === 0
              ? undefined
              : { auth: { apiKey: key }, source: 'TeleAgent' }
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    })

    let profileMap = null
    const buildProfiles = () => new Map([[
      TELEAGENT_PROVIDER,
      {
        provider: TELEAGENT_PROVIDER,
        displayName: 'TeleAgent',
        streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-teleagent retryPolicy'),
        configuredMaxTokens: new Map(),
        modelErrors: new Map(),
        reasoning: undefined,
        // 手动构造 profile 时 schema 默认值不生效；缺这三个字段图片会直接报
        // `Image request width must be a positive integer.`
        ...IMAGE_REQUEST_BUDGET,
        piProvider: { ...provider, getModels: () => buildModels() },
      },
    ]])
    const profiles = () => (profileMap ??= buildProfiles())
    const invalidate = () => { profileMap = null }

    const adapter = new PiAiAdapter({
      profiles,
      auth: INERT_AUTH,
      resolveApiKey: async () => shim.token(),
      // 图片输入：不透传宿主的持久附件服务，pi-ai 会在发请求前直接报
      // UNSUPPORTED_CONTENT（pi-ai image input requires the durable attachment service）
      ...createAttachmentDeps(ctx, resolveImageAttachmentAccess),
    })
    bootlog('provider 与 adapter 已构造', { models: buildModels().length })

    // 登录完成后凭据变化，重建直连客户端（不需要重启任何进程）
    setAuthRefresher(() => {
      ctx.logger?.info?.('dsh-connect-teleagent: 凭据已更新，重建上游客户端')
      refreshUpstream()
    })

    if (stopped) {
      // fiber 已在 boot 中途卸载：门面保持「未就绪」（可重试的 TRANSPORT），
      // 并补关这之后才会建好的资源，绝不把内部实现挂到已死的注册上。
      forwardingAdapter.setReadyError('TeleAgent 已停用（插件正在卸载）')
      cleanupLateBootResources()
      return
    }

    welfare.start()

    registryInvalidate = invalidate
    // 只把内部实现注入**已同步注册**的门面，不再二次 registerAdapter：
    // 宿主缓存的是 apply() 里那个门面引用，二次注册会抛 DUPLICATE_ADAPTER，
    // 而且重新注册会在新旧 fiber 交替时留下注销窗口。
    forwardingAdapter.setInner(adapter)
    bootlog('adapter 内部实现已注入', { id: TELEAGENT_PROVIDER, models: buildModels().length })
    // 只读工具：让模型能自己回答"还有多少积分"
    try {
      closeTools = mountPointsTool(softGet(ctx, 'tools'), { logger: ctx.logger })
      bootlog('只读工具已挂载', { tool: 'teleagent_points' })
    } catch (error) {
      bootlog('只读工具挂载失败', error)
    }

    bootlog('provider 已注册', { id: TELEAGENT_PROVIDER, models: MODELS.length })
    ctx.logger?.info?.(`dsh-connect-teleagent: provider "${TELEAGENT_PROVIDER}" 已注册（${MODELS.length} 个模型，直连上游）`)
    // fiber 若在 boot 中途已被卸载：补关后半段才建好的资源（shim server / 内核）
    cleanupLateBootResources()
  }

  boot().catch((error) => {
    bootlog('boot 失败', error)
    // 门面仍注册着（不会 NO_ADAPTER）；把失败原因交给它，让在途/重试请求
    // 拿到可读的 TRANSPORT 错误并排队重试，而不是静默挂住。
    forwardingAdapter.setReadyError(`TeleAgent 启动失败：${error?.message ?? error}`)
    cleanupLateBootResources()
    // 凭据类失败已经带有「原因 + 用户该做什么」，不要淹没在堆栈里
    if (error?.code) {
      ctx.logger?.error?.(`dsh-connect-teleagent: ${error.message}`)
    } else {
      ctx.logger?.error?.('dsh-connect-teleagent: 启动失败', error)
    }
  })

  /**
   * 宿主退出兜底：DSH 正常退出不一定走 `dispose`（实测会留下孤儿内核，
   * 而且孤儿还会继续跑上一轮），所以在进程退出/信号上也尽量把内核带走。
   * 只在宿主没有自己的处理器时接管信号，避免和宿主抢控制权。
   */
  const killKernelOnHostExit = () => { try { kernelHandle?.stop?.() } catch { /* ignore */ } }
  const hostExitSignals = []
  process.once('exit', killKernelOnHostExit)
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    if (process.listenerCount(sig) > 0) continue
    const handler = () => {
      killKernelOnHostExit()
      process.exit(sig === 'SIGINT' ? 130 : sig === 'SIGHUP' ? 129 : 143)
    }
    process.once(sig, handler)
    hostExitSignals.push([sig, handler])
  }

  /**
   * 清理。既注册到 `ctx.on('dispose')`，也作为 `apply()` 的返回值 ——
   * 有些宿主/mock 只认其中一种；不返回的话，测试或宿主卸载时
   * 拉起的 kernel 会变成孤儿进程（实测踩过）。
   */
  let cleaned = false
  /**
   * fiber 可能在**异步 boot() 进行中**被卸载（HMR / 配置重挂）。此时 kernel、
   * toolBridge、shim 都还没建好，`cleanup()` 先跑一遍只会关掉 adapter 与工具。
   * 若不在 boot 末尾再补一次清理，boot 后半段新建的 shim HTTP server / 内核
   * 会变成永不释放的孤儿（测试里表现为进程挂住）。详见
   * `cleanupLateBootResources()`。
   */
  const closeBootResources = () => {
    try { closeTools?.() } catch { /* ignore */ }
    try { kernelTransport?.close?.() } catch { /* ignore */ }
    try { kernelHandle?.stop?.() } catch { /* ignore */ }
    try { void toolBridge?.close?.() } catch { /* ignore */ }
    try { closeStatusRoutes?.() } catch { /* ignore */ }
    try { shim?.close?.() } catch { /* ignore */ }
  }
  let lateCleanupDone = false
  const cleanupLateBootResources = () => {
    if (!cleaned || lateCleanupDone) return
    lateCleanupDone = true
    closeBootResources()
  }
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    stopped = true
    try { welfare.stop() } catch { /* ignore */ }
    closeBootResources()
    try { closeAdapter?.() } catch { /* ignore */ }
    try { process.removeListener('exit', killKernelOnHostExit) } catch { /* ignore */ }
    for (const [sig, handler] of hostExitSignals) {
      try { process.removeListener(sig, handler) } catch { /* ignore */ }
    }
  }

  ctx.on?.('dispose', cleanup)

  // 等待内核进程真正退出（最多 3 秒），否则调用方以为清理完了它还在
  return async () => {
    cleanup()
    await new Promise((resolve) => {
      const started = Date.now()
      const tick = () => {
        const alive = kernelHandle?.child !== undefined
          && kernelHandle.child.exitCode === null
          && kernelHandle.child.signalCode === null
        if (!alive || Date.now() - started > 3000) return resolve()
        setTimeout(tick, 100)
      }
      tick()
    })
  }
}
