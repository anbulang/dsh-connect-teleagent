/**
 * Host 侧状态路由：给浏览器卡片提供登录态、上游可达性与模型清单。
 *
 * 安全：仅应答回环来源；从不返回 token/JWT 原文。
 *
 * 配置来源：本文件**不直接读任何存储**。四项可配置字段（providerDisabled /
 * enabledModelIds / toolsAllowlist / autoClaimDaily）的读取一律通过 `deps` 注入的
 * **settings 优先 getter**，写入一律通过 `deps` 注入的 setter（settings 优先、
 * 不可用时回落 `~/.dsh/teleagent-plugin.json`）。这样「卡片显示的值」与
 * 「请求期实际生效的值」永远同源（见 index.js 的 buildStatusDeps）。
 *
 * 每个写路由的响应都带 `via: 'settings' | 'store'`，如实标注这次写入落在哪；
 * 读路由（/status）也带 `via`，标注当前生效值的来源。
 */
import fs from 'node:fs'
import { MODELS } from './models.js'
import { isAppRunningNow, loginThenQuit } from './lifecycle.js'
import { checkDesktopApp } from './desktop.js'
import { diagnoseCredential, probeDetails, CredentialState } from './credential.js'
import { runAddAccountFlow, DEFAULT_ADD_ACCOUNT_TIMEOUT_MS } from './add-account.js'
import { bootlog } from './bootlog.js'
import { localRequestGuard, mutationGuard } from './local-request.js'
export { loopbackOrigin, sameOriginRequest, mutationGuard } from './local-request.js'

/** 版本号：诊断栏要展示，读一次缓存住 */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return null
  }
})()
import { clearCredential, listScopesWithCredential } from './account.js'
import { readUpstreamError } from './health.js'

export const STATUS_PATH = '/plugins/dsh-connect-teleagent/status'
export const MODELS_PATH = '/plugins/dsh-connect-teleagent/models'
export const LOGIN_PATH = '/plugins/dsh-connect-teleagent/login'
export const LOGOUT_PATH = '/plugins/dsh-connect-teleagent/logout'
export const WELFARE_PATH = '/plugins/dsh-connect-teleagent/welfare'
export const TOOLS_PATH = '/plugins/dsh-connect-teleagent/tools'

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

// ------------------------------------------------------------------ 配置来源
//
// 四项可配置字段的真相源有且只有一个：**DSH settings 优先，store 兜底**。
// 本文件不判断该走哪层，也不自己读写任何存储 —— 那是 index.js 的 deps 的职责。
// 这里只做两件事：
//   1. 把 deps 的 getter/setter 结果归一到统一形状（含旧形状的向后兼容）
//   2. 在响应里用 `via` 如实标注这次读/写落在哪一层

/** 配置值实际来源：`settings`（DSH 原生设置）/ `store`（~/.dsh/teleagent-plugin.json 兜底） */
export const CONFIG_VIA = Object.freeze({ SETTINGS: 'settings', STORE: 'store' })

/** 只认 `settings`，其余一律记 `store`（契约里只有这两个值） */
export function normalizeVia(value) {
  return value === CONFIG_VIA.SETTINGS ? CONFIG_VIA.SETTINGS : CONFIG_VIA.STORE
}

/**
 * 判断 deps 当前的配置读数来自哪一层。
 *
 * 依次尝试（任一给出明确答案即返回）：
 *  1. `deps.settingsSource()` / `deps.settingsSource` → `'settings'` | `'store'`（**最可靠，推荐**）
 *  2. `deps.settingsAvailable()` / `deps.settingsAvailable` → boolean
 *  3. `deps.settingsNamespace()` → 非空字符串
 *     ⚠️ 弱信号：settings 服务没接上时**必须**返回 null/undefined，否则会被误判成 settings
 *  4. 都没有 → `store`（旧宿主，只有自持久化一层）
 *
 * @param {object} deps
 * @returns {'settings'|'store'}
 */
export function settingsViaOf(deps) {
  const read = (candidate) => {
    try { return typeof candidate === 'function' ? candidate() : candidate } catch { return undefined }
  }
  const explicit = read(deps?.settingsSource)
  if (typeof explicit === 'string' && explicit !== '') return normalizeVia(explicit)
  if (explicit !== null && typeof explicit === 'object' && explicit.via !== undefined) return normalizeVia(explicit.via)

  const flag = read(deps?.settingsAvailable)
  if (typeof flag === 'boolean') return flag ? CONFIG_VIA.SETTINGS : CONFIG_VIA.STORE

  const namespace = read(deps?.settingsNamespace)
  if (typeof namespace === 'string' && namespace.trim() !== '') return CONFIG_VIA.SETTINGS

  return CONFIG_VIA.STORE
}

/**
 * 归一化 getter 的结果，支持三种形状：
 *  - 裸值：`['bash']` / `null` / `true`
 *  - 函数：惰性求值
 *  - 信封：`{ value, via }` —— deps 可以逐字段标注来源
 *
 * @returns {{value:any, via:'settings'|'store'}}
 */
export function settleSetting(raw, fallbackVia = CONFIG_VIA.STORE) {
  let value = raw
  try {
    if (typeof value === 'function') value = value()
  } catch { value = undefined }

  if (value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, 'value')
    && Object.prototype.hasOwnProperty.call(value, 'via')) {
    return { value: value.value, via: normalizeVia(value.via) }
  }
  return { value, via: normalizeVia(fallbackVia) }
}

/**
 * 工具白名单对外只有一种表示：`null` = 全发。
 *
 * settings schema 只能表达 `[]`（空数组），store 历史值是 `null`，两者语义相同
 * （`lib/tools-filter.js`：names.length === 0 即全发）。这里统一收敛到 `null`，
 * 前端永远只看到一种"全发"表示。
 *
 * @param {any} value
 * @returns {string[]|null}
 */
export function normalizeToolsAllowlist(value) {
  if (!Array.isArray(value)) return null
  const list = value
    .filter((x) => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
  return list.length === 0 ? null : list
}

/**
 * 归一化写 setter 的返回值。
 *
 * 契约：`{ ok: boolean, via: 'settings'|'store', value?: any, reason?: string }`
 *
 * 向后兼容（deps 可能还是旧实现）：
 *  - 裸 `true`            → `{ ok: true, via: 'store' }`（旧实现只可能写 store）
 *  - 裸 `false`           → 失败
 *  - `{ ok, via, reason }` → 按值处理，`reason` 原样透出
 *  - `undefined` / 其它   → `legacy: true` + `ok: true`（**未确认**，交由调用方回读校验）
 *
 * 关于 `undefined`：契约要求"未确认即失败"，但现有 index.js 的三个 setter
 * （`setProviderDisabled` / `saveEnabledModelIds` / `setAutoClaimDaily`）都是
 * 写完不返回值的旧写法。直接判失败会把「保存成功」显示成「写入失败」，
 * 是明显的功能回归。所以这里不猜，而是标 `legacy: true` 交给调用方
 * **回读校验**（`confirmWritten`）—— 以 settings 优先 getter 的实际读数为准，
 * 这才是"卡片显示的值 == 真实生效的值"的判据。
 *
 * @param {any} raw
 * @param {{via?: 'settings'|'store'}} [options]
 * @returns {{ok:boolean, via:'settings'|'store', value?:any, reason?:string, legacy?:boolean}}
 */
export function normalizeSetterResult(raw, { via = CONFIG_VIA.STORE } = {}) {
  if (raw === true) return { ok: true, via: CONFIG_VIA.STORE }
  if (raw === false) return { ok: false, via: normalizeVia(via), reason: 'rejected' }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const result = { ok: raw.ok === true, via: normalizeVia(raw.via === undefined ? via : raw.via) }
    if (raw.value !== undefined) result.value = raw.value
    if (raw.reason !== undefined && raw.reason !== null && raw.reason !== '') result.reason = String(raw.reason)
    else if (raw.error !== undefined && raw.error !== null && raw.error !== '') result.reason = String(raw.error)
    return result
  }
  return { ok: true, via: normalizeVia(via), legacy: true }
}

/** 两个白名单/模型 id 列表是否等价（`null` 与 `[]` 等价、顺序无关） */
function sameStringList(a, b) {
  const norm = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice().sort() : [])
  const left = norm(a)
  const right = norm(b)
  return left.length === right.length && left.every((x, i) => x === right[i])
}

/**
 * 回读校验：setter 没给明确结果（`legacy`）时，用 settings 优先 getter 的实际读数
 * 判断这次写入到底生效没有。
 *
 * 这是 `undefined` 语义的正确落地 —— 不猜"成功"，也不因为旧 setter 不返回值就
 * 把所有保存打成失败，而是问一次真相源。
 *
 * ⚠️ 判据本身必须可用：`hasSource === false`（deps 根本没提供这个字段的 getter）
 * 时无法确认，按"成功"处理 —— 缺 getter 是宿主侧能力缺口，不是写入失败，
 * 拿它当失败会让旧宿主上所有保存都变红。
 *
 * @param {{ok:boolean, via:string, legacy?:boolean, reason?:string}} result
 * @param {any} actual  写入后 getter 回读到的实际值
 * @param {(actual:any)=>boolean} matches 实际值是否已经是目标值
 * @param {{hasSource?:boolean}} [options]
 * @returns {{ok:boolean, via:string, reason?:string, verified?:boolean}}
 */
export function confirmWritten(result, actual, matches, { hasSource = true } = {}) {
  if (result.legacy !== true) return result
  if (hasSource !== true || actual === undefined) return { ok: true, via: result.via, verified: false }
  let ok = false
  try { ok = matches(actual) === true } catch { ok = false }
  if (ok) return { ok: true, via: result.via, verified: true }
  return { ok: false, via: result.via, reason: result.reason ?? 'write-unconfirmed', verified: false }
}

/** 读一次 deps 的 getter（每次重新取 deps，避免拿到写入前的旧快照） */
function readDepsSetting(deps, key, via) {
  try {
    const d = typeof deps === 'function' ? deps() : (deps ?? {})
    return settleSetting(d?.[key], via).value
  } catch { return undefined }
}

/** deps 是否真的提供了某个字段的 getter（用于决定能否做回读校验） */
function hasDepsSetting(deps, key) {
  try {
    const d = typeof deps === 'function' ? deps() : (deps ?? {})
    return d?.[key] !== undefined && d?.[key] !== null
  } catch { return false }
}

/**
 * 把归一化后的 setter 结果转成响应体：成功/失败都带 `via`，失败带 `reason`。
 *
 * @param {{ok:boolean, via:string, reason?:string}} result
 * @param {object} [extra] 该路由原有的响应字段（一个都不删）
 */
function setterBody(result, extra = {}) {
  const body = { ok: result.ok === true, via: normalizeVia(result.via), ...extra }
  if (result.reason !== undefined) body.reason = result.reason
  return body
}

/**
 * 写路由的统一收尾：成功 200、失败 503（前端据此提示"未能写入"）。
 *
 * 失败的 503 里同时给 `error`（人类可读）与 `reason`（机器可读），
 * 保持旧客户端 `!res.ok` 判断语义不变。
 *
 * @param {object} res
 * @param {{ok:boolean, via:string, reason?:string}} result
 * @param {object} extra
 * @param {string} errorMessage
 */
function respondSetter(res, result, extra, errorMessage) {
  if (result.ok === true) return json(res, 200, setterBody(result, extra))
  return json(res, 503, setterBody(result, { ...extra, error: errorMessage }))
}

/**
 * 登录态摘要 —— 供卡片显示。
 *
 * 只暴露「是否可用、昵称、过期时间、失败原因与建议」，**从不返回 token**。
 */
export function readAuthState(home, desktop) {
  const d = diagnoseCredential(home, desktop)
  if (d.ok) {
    return {
      signedIn: true,
      expired: false,
      scope: d.scope,
      accountName: d.accountName,
      accountId: d.accountId,
      tenant: d.tenant,
      expiresAt: d.expiresAt,
      daysLeft: d.daysLeft,
      state: CredentialState.OK,
    }
  }
  return {
    signedIn: false,
    expired: d.state === CredentialState.EXPIRED,
    state: d.state,
    reason: d.detail,
    remedy: d.remedy,
    // 过期时仍返回身份信息，卡片才能说清「是谁的登录过期了」
    accountName: d.accountName,
    accountId: d.accountId,
    expiresAt: d.expiresAt,
  }
}

/**
 * 组装完整状态文档。
 *
 * 响应契约（**只新增字段，不删除任何已有字段**）：
 *  - 新增 `via` / `configSource`：四项可配置字段当前读数的来源（settings / store）。
 *    前端据此告知用户"改的值落在哪一层"；旧客户端忽略它，行为不变。
 *  - `toolsAllowlist` 对外只有两种形态：`null`（= 全发）或非空字符串数组。
 *    settings 侧的表达是 `[]`、store 历史值是 `null`，语义相同
 *    （见 lib/tools-filter.js：names.length === 0 即全发），这里统一收敛到 `null`，
 *    前端永远看不到两种"全发"表示。
 *  - getter 三种形状都接受：裸值 / 函数 / `{ value, via }` 信封。
 *  - `desktop`：桌面端检测结果（跨平台）。没装/版本过低时不能把「读不到凭据」
 *    报成账号异常，卡片要按 `desktop.ok` 区分「去装/升级」和「去登录」。
 */
export function buildStatus({
  upstream, enabledModelIds, guard, account, welfare, provider, credentialProbe,
  allowChatProbe, transport, capabilities, toolsAllowlist, autoClaimDaily,
  // 配置来源：deps 可以逐字段标注，也可以只给一个全局 via
  via, toolsAllowlistVia, providerVia, enabledModelIdsVia, autoClaimDailyVia,
}) {
  const allowRaw = settleSetting(toolsAllowlist, via)
  const toolsAllow = normalizeToolsAllowlist(allowRaw.value)
  const desktop = checkDesktopApp()
  const auth = readAuthState(undefined, desktop)
  const upstreamInfo = typeof upstream === 'function'
    ? upstream()
    : (upstream ?? { ready: false, error: '未初始化' })
  // 最近一次上游拒绝（如账号封禁）对本机凭据检查是不可见的，必须显式暴露
  // 熔断状态：打开时模型会快速失败，卡片必须说明原因与恢复时间
  const guardInfo = typeof guard === 'function' ? guard() : (guard ?? null)

  const upstreamError = readUpstreamError()
  if (upstreamError && upstreamInfo.lastError === undefined) {
    upstreamInfo.lastError = {
      code: upstreamError.code,
      message: upstreamError.message,
      remedy: upstreamError.remedy,
      at: upstreamError.at,
    }
  }

  // 「异常账号」：凭据坏了，或换过 token 仍被上游拒绝（账号级问题）。
  // 这类账号清掉凭据、换号登录是唯一出路，卡片要直接给出这个动作。
  const lastErr = readUpstreamError()
  const banned = lastErr?.code === 'account_banned'
  const accountSource = typeof account === 'function' ? account() : (account ?? null)
  const scopes = accountSource?.scopes ?? 0
  // 区分两件事：
  //  - 本机根本没有登录态 → 正常状态，提示「去登录」即可
  //  - 有凭据但坏了 / 被上游封禁 → 异常状态，需要清除后换号
  const hasCredential = scopes > 0
  const credentialsBroken = desktop.ok && hasCredential && auth.signedIn === false
  const abnormal = banned || credentialsBroken
  const accountInfo = {
    abnormal,
    banned,
    scope: accountSource?.scope ?? null,
    canClear: hasCredential,
    scopes,
    // 「添加账号」入口是否可用：桌面端没装就没什么可唤起的
    canAddAccount: desktop.ok,
    // 清除后该看到什么
    nextStep: abnormal
      ? (banned ? '该账号已被上游封禁：清除登录态后换账号登录' : '登录态异常：清除后重新登录')
      : null,
  }

  const welfareSource = typeof welfare === 'function' ? welfare() : (welfare ?? null)
  // autoClaimDaily 是四项可配置字段之一：**必须**以 deps 的 settings 优先 getter 为准，
  // 不能被 welfare 快照里那份 store 缓存值覆盖（否则卡片显示的开关与真实生效值分叉）。
  const autoRaw = settleSetting(autoClaimDaily, via)
  let welfareInfo = welfareSource
  if (autoClaimDaily !== undefined || welfareSource?.autoClaimDaily !== undefined) {
    const resolved = typeof autoRaw.value === 'boolean'
      ? autoRaw.value
      : welfareSource?.autoClaimDaily !== false
    welfareInfo = { ...(welfareSource ?? {}), autoClaimDaily: resolved }
  }
  // provider 三种形状都要能解析：函数 / 裸对象 / `{ value, via }` 信封
  const providerRaw = settleSetting(provider, via)
  const providerInfo = providerRaw.value === null || providerRaw.value === undefined
    ? { disabled: false }
    : providerRaw.value
  const enabledList = (() => {
    const inferred = settleSetting(enabledModelIds, via)
    return Array.isArray(inferred.value) ? inferred.value : []
  })()

  // 只在未登录时探测：已登录时展示"探过哪些路径"只是噪音，
  // 而且 probeDetails 会读钥匙串，不该每 15 秒来一次。
  let probeInfo = null
  if (auth.signedIn !== true && credentialProbe !== undefined && credentialProbe !== null) {
    try {
      probeInfo = typeof credentialProbe === 'function' ? credentialProbe() : credentialProbe
    } catch {
      probeInfo = null
    }
  }

  return {
    pluginVersion: PLUGIN_VERSION,
    desktop,
    auth,
    account: accountInfo,
    welfare: welfareInfo,
    provider: providerInfo,
    // 宿主能力集：客户端用它判断"这个按钮在当前宿主上是否真的可用"，
    // 避免插件更新后宿主未重启时，界面能点但后端没实现（会报莫名其妙的错）。
    capabilities: {
      switchAccount: true,
      claimAccount: true,
      addAccount: true,
      ...(typeof capabilities === 'function' ? capabilities() : (capabilities ?? {})),
    },
    transport: typeof transport === 'function' ? transport() : (transport ?? { mode: 'direct', ready: true }),
    // 是否允许"发真实请求测试模型"（默认 false，见 AGENTS.md）
    allowChatProbe: allowChatProbe === true,
    credentialProbe: probeInfo,
    upstream: upstreamInfo,
    guard: guardInfo,
    // 配置来源标注：整体 (via) + 逐字段 (configSource)，逐字段缺省沿用整体值
    via: allowRaw.via,
    configSource: {
      via: allowRaw.via,
      toolsAllowlist: normalizeVia(toolsAllowlistVia === undefined ? allowRaw.via : toolsAllowlistVia),
      providerDisabled: normalizeVia(providerVia === undefined ? providerRaw.via : providerVia),
      enabledModelIds: normalizeVia(enabledModelIdsVia === undefined ? via : enabledModelIdsVia),
      autoClaimDaily: normalizeVia(autoClaimDailyVia === undefined ? autoRaw.via : autoClaimDailyVia),
    },
    // 归一化后只有 null（= 全发）/ 非空数组两种形态
    toolsAllowlist: toolsAllow,
    models: MODELS.map((m) => ({
      vision: m.vision === true,
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      creditMultiplier: m.creditMultiplier,
      enabled: enabledList.length === 0 ? true : enabledList.includes(m.id),
    })),
  }
}

/**
 * 注册 host 路由。
 * @param {object} options
 * @param {object} options.webServer  宿主 webServer 服务（必需）
 * @param {object} options.deps       状态提供者
 * @param {(msg:string, err?:unknown)=>void} [options.warn] 日志
 */
/**
 * 注册一条路由，兼容 webServer 的几种历史形状。
 *
 * DSH 的 `webServer.register` 在不同版本里接受：
 *   { kind:'exact', path, handler }
 *   { path, handler }
 *   { method, path, handler }
 * 逐个尝试并记录哪个生效，避免因形状不符而静默 404。
 */
function registerRoute(webServer, { path, handler, warn, label }) {
  const handle = handler
  handler = (req, res) => {
    if (!localRequestGuard(req, res)) return
    return handle(req, res)
  }
  const shapes = [
    { kind: 'exact', path, handler },
    { path, handler },
    { method: 'GET', path, handler },
  ]
  const errors = []
  for (const shape of shapes) {
    try {
      const dispose = webServer.register(shape)
      bootlog('路由注册成功', { label, path, shape: Object.keys(shape).join(',') })
      return dispose
    } catch (error) {
      errors.push(`${Object.keys(shape).join(',')}: ${error?.message ?? error}`)
    }
  }
  bootlog('路由注册全部形状失败', { label, path, errors })
  warn?.(`dsh-connect-teleagent: 路由 ${path} 注册失败`, errors.join(' | '))
  return undefined
}

export function registerStatusRoutes({ webServer, deps, warn } = {}) {
  bootlog('registerStatusRoutes 进入', { hasWebServer: !!webServer, hasDeps: typeof deps === 'function' })
  const disposers = []
  // 唤起 TeleAgent 应用完成登录。
  // 说明：登录窗是主进程 IPC（login:open）独占的，外部无法直接打开；
  // 这里只能激活应用，让用户在里面登录，插件随后自动感知凭据文件变化。
  try {
    disposers.push(registerRoute(webServer, {
      label: 'login',
      warn,
      path: LOGIN_PATH,
      handler: async (req, res) => {
        // 允许测试注入登录流程：默认实现会 `open -a TeleAgent`，
        // 路由测试如果真调用会弹出用户的应用
        const injected = typeof deps === 'function' ? deps() : (deps ?? {})

        // 添加账号：GET 查询进度（卡片轮询用），POST 启动 / 取消
        if (req.method === 'GET') {
          if (queryParam(req, 'mode') !== 'add') return json(res, 405, { error: 'method not allowed' })
          const getState = injected.getAddAccountState ?? getAddAccountState
          return json(res, 200, getState())
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!mutationGuard(req, res)) return

        try {
          const body = await readJson(req)
          if (body.mode === 'add') {
            if (body.action === 'cancel') {
              const cancel = injected.cancelAddAccountFlow ?? cancelAddAccountFlow
              return json(res, 200, cancel())
            }
            const start = injected.startAddAccountFlow ?? startAddAccountFlow
            const run = injected.runAddAccountFlow ?? runAddAccountFlowAndWait
            const timeoutMs = Number.isFinite(body.timeoutMs) ? body.timeoutMs : undefined
            if (body.wait === true) {
              const result = await run({ timeoutMs })
              return json(res, result.ok ? 200 : (result.code === 'timeout' ? 504 : 409), result)
            }
            const result = start({ timeoutMs })
            return json(res, result.ok ? 200 : 500, result)
          }

          const startLogin = injected.startLoginFlow ?? startLoginFlow
          const runLogin = injected.runLoginFlow ?? runLoginFlow
          // 默认非阻塞：只唤起，登录完成后由后台任务负责退出
          const wait = body.wait === true
          if (wait) {
            const result = await runLogin({ timeoutMs: body.timeoutMs })
            return json(res, result.ok ? 200 : 504, result)
          }
          const result = startLogin()
          json(res, result.ok ? 200 : 500, result)
        } catch (error) {
          json(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))
  } catch (error) {
    bootlog('login 路由块异常', error)
    warn?.('dsh-connect-teleagent: login 路由注册失败', error)
  }

  // 工具白名单：设置卡片保存用。
  // GET 读值走 /status（deps 的 settings 优先 getter）；POST 写入走 deps 的
  // setter —— **settings 优先，store 兜底**，本文件不直接碰任何存储文件。
  // 响应带 via 标注这次写入实际落在哪一层。
  try {
    disposers.push(registerRoute(webServer, {
      label: 'tools',
      warn,
      path: TOOLS_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!mutationGuard(req, res)) return
        try {
          const d = typeof deps === 'function' ? deps() : (deps ?? {})
          const save = d.setToolsAllowlist
          if (typeof save !== 'function') return json(res, 503, { error: '设置不可用' })
          const body = await readJson(req)
          const raw = body.toolsAllowlist
          if (raw !== null && !Array.isArray(raw)) return json(res, 400, { error: 'toolsAllowlist 必须是数组或 null' })
          // 入参先归一（去空/去非字符串/trim）；空数组与 null 语义相同 = 全发
          const list = normalizeToolsAllowlist(raw)
          if (list !== null && list.length > 500) return json(res, 400, { error: '条目过多（上限 500）' })
          const via = settingsViaOf(d)
          const result = normalizeSetterResult(await save(list), { via })
          // 旧 setter 不返回值时回读校验：以 settings 优先 getter 的实际读数为准
          const confirmed = confirmWritten(result, readDepsSetting(deps, 'toolsAllowlist', via), (actual) => sameStringList(normalizeToolsAllowlist(actual), list), { hasSource: hasDepsSetting(deps, 'toolsAllowlist') })
          // 响应字段向后兼容：ok / toolsAllowlist 保持原语义，新增 via
          return respondSetter(
            res,
            confirmed,
            { toolsAllowlist: result.value === undefined ? list : normalizeToolsAllowlist(result.value) },
            '未能写入工具白名单',
          )
        } catch (error) {
          json(res, 500, { error: String(error?.message ?? error) })
        }
      },
    }))
  } catch (error) {
    warn?.('dsh-connect-teleagent: tools 路由注册失败', error)
  }

  // 清除异常账号的登录态（只删凭据，保留技能/记忆等用户数据）
  try {
    disposers.push(registerRoute(webServer, {
      label: 'logout',
      warn,
      path: LOGOUT_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!mutationGuard(req, res)) return
        try {
          const body = await readJson(req)
          const scopeMode = body.all === true ? 'all' : 'current'
          const result = await clearCredential({ scope: scopeMode })
          bootlog('清除登录态', result)
          // 通知宿主：凭据没了，重建客户端并复位熔断
          try { deps()?.onCredentialCleared?.() } catch { /* ignore */ }
          const auth = readAuthState()
          json(res, result.ok ? 200 : 500, {
            ...result,
            auth,
            message: result.cleared.length > 0
              ? '已清除登录态，请点「去登录」重新登录'
              : '没有可清除的登录态（当前未登录）',
          })
        } catch (error) {
          json(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))
  } catch (error) {
    bootlog('logout 路由块异常', error)
    warn?.('dsh-connect-teleagent: logout 路由注册失败', error)
  }

  // 多账号：列举 / 逐账号积分 / 切换
  try {
    disposers.push(registerRoute(webServer, {
      label: 'accounts',
      warn,
      path: '/plugins/dsh-connect-teleagent/accounts',
      handler: async (req, res) => {
        const depsValue = deps()
        try {
          if (req.method === 'GET') {
            const withPoints = String(req.url ?? '').includes('points=1')
            const list = typeof depsValue.listAccounts === 'function' ? depsValue.listAccounts() : []
            let balances = []
            if (withPoints && typeof depsValue.accountPoints === 'function') {
              balances = await depsValue.accountPoints(list.map((a) => a.scope))
            }
            const byScope = new Map(balances.map((b) => [b.scope, b]))
            return json(res, 200, {
              appRunning: depsValue.appRunning === true,
              current: list.find((a) => a.isCurrent)?.scope ?? null,
              accounts: list.map((a) => ({
                ...a,
                points: byScope.get(a.scope) ?? null,
                canSwitch: a.isCurrent !== true && a.hasToken === true && depsValue.appRunning !== true,
                canDelete: a.isCurrent !== true && depsValue.appRunning !== true,
              })),
            })
          }
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!mutationGuard(req, res)) return
          const body = await readJson(req)

          // 删除账号（默认只摘登录态；mode='purge' 移入回收站，从列表消失）
          if (body.action === 'delete') {
            if (typeof depsValue.deleteAccount !== 'function') return json(res, 503, { error: '删除不可用' })
            const result = depsValue.deleteAccount({
              scope: body.scope,
              mode: body.mode === 'purge' ? 'purge' : 'logout',
              dryRun: body.dryRun === true,
            })
            bootlog('删除账号', { scope: body.scope, mode: body.mode ?? 'logout', dryRun: body.dryRun === true, ok: result.ok, reason: result.reason })
            return json(res, result.ok ? 200 : 409, result)
          }

          if (typeof body.action === 'string' && body.action !== '' && body.action !== 'switch') {
            return json(res, 400, { error: `未知操作：${body.action}` })
          }
          if (typeof depsValue.switchAccount !== 'function') return json(res, 503, { error: '多账号不可用' })
          const result = depsValue.switchAccount({
            scope: body.scope,
            dryRun: body.dryRun === true,
          })
          bootlog('切换账号', { scope: body.scope, dryRun: body.dryRun === true, ok: result.ok, reason: result.reason })
          return json(res, result.ok ? 200 : 409, result)
        } catch (error) {
          return json(res, 500, { error: String(error?.message ?? error) })
        }
      },
    }))
  } catch (error) {
    bootlog('accounts 路由块异常', error)
    warn?.('dsh-connect-teleagent: accounts 路由注册失败', error)
  }

  // 模型可用性自检（**默认拒绝**：会产生真实聊天流量，见 AGENTS.md）
  try {
    disposers.push(registerRoute(webServer, {
      label: 'probe',
      warn,
      path: '/plugins/dsh-connect-teleagent/probe',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!mutationGuard(req, res)) return
        const depsValue = deps()
        if (depsValue.allowChatProbe !== true) {
          return json(res, 403, {
            error: '聊天探测已禁用（两次封号复盘表明合成探测是主要诱因）。如需开启，把配置 ui.allowChatProbe 设为 true。',
            code: 'probe_disabled',
          })
        }
        try {
          const body = await readJson(req)
          const model = typeof body?.model === 'string' ? body.model : 'chat-flash'
          const probe = depsValue.probeModel
          if (typeof probe !== 'function') return json(res, 503, { error: '探测不可用' })
          const result = await probe(model)
          bootlog('模型自检结果', result)
          return json(res, result.ok ? 200 : 502, result)
        } catch (error) {
          return json(res, 500, { error: String(error?.message ?? error) })
        }
      },
    }))
  } catch (error) {
    bootlog('probe 路由块异常', error)
    warn?.('dsh-connect-teleagent: probe 路由注册失败', error)
  }

  // 积分福利：读取快照 / 手动领取 / 开关自动领取
  try {
    disposers.push(registerRoute(webServer, {
      label: 'welfare',
      warn,
      path: WELFARE_PATH,
      handler: async (req, res) => {
        const depsValue = deps()
        try {
          if (req.method === 'GET') {
            const refresh = String(req.url ?? '').includes('refresh=1')
            if (refresh && typeof depsValue.refreshWelfare === 'function') {
              return json(res, 200, await depsValue.refreshWelfare())
            }
            // 关键：读取路径也要能刷新。只返回缓存会导致"余额永远不更新"，
            // 因为 stale 标记没有任何人消费。
            if (typeof depsValue.welfareEnsureFresh === 'function') {
              return json(res, 200, await depsValue.welfareEnsureFresh())
            }
            return json(res, 200, typeof depsValue.welfareSnapshot === 'function' ? depsValue.welfareSnapshot() : {})
          }
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!mutationGuard(req, res)) return
          const body = await readJson(req)
          const action = body.action ?? 'claim'

          if (action === 'auto') {
            if (typeof depsValue.setAutoClaimDaily !== 'function') return json(res, 503, { error: '福利模块不可用' })
            // autoClaimDaily 是四项可配置字段之一：settings 优先、store 兜底
            const via = settingsViaOf(depsValue)
            const enabled = body.enabled === true
            const result = normalizeSetterResult(await depsValue.setAutoClaimDaily(enabled), { via })
            const confirmed = confirmWritten(result, readDepsSetting(deps, 'autoClaimDaily', via), (v) => v === enabled, { hasSource: hasDepsSetting(deps, 'autoClaimDaily') })
            return respondSetter(
              res,
              confirmed,
              { welfare: depsValue.welfareSnapshot?.() ?? null },
              '未能写入自动领取开关',
            )
          }
          if (action === 'refresh') {
            if (typeof depsValue.refreshWelfare !== 'function') return json(res, 503, { error: '福利模块不可用' })
            return json(res, 200, { ok: true, welfare: await depsValue.refreshWelfare() })
          }
          if (action === 'claim') {
            if (typeof depsValue.claimWelfare !== 'function') return json(res, 503, { error: '福利模块不可用' })
            const result = await depsValue.claimWelfare()
            bootlog('手动领取结果', result)
            return json(res, result.ok ? 200 : 502, { ...result, welfare: depsValue.welfareSnapshot?.() ?? null })
          }
          return json(res, 400, { error: 'unknown action: ' + action })
        } catch (error) {
          return json(res, 500, { error: String(error?.message ?? error) })
        }
      },
    }))
  } catch (error) {
    bootlog('welfare 路由块异常', error)
    warn?.('dsh-connect-teleagent: welfare 路由注册失败', error)
  }

  // 模型勾选 / 供应商总开关：写入走 deps 的 setter（**settings 优先，store 兜底**）。
  // 响应带 via 标注这次写入实际落在哪一层，前端才能区分"存到了 DSH 设置"还是
  // "只落到兜底 JSON 文件"。
  try {
    disposers.push(registerRoute(webServer, {
      label: 'models',
      warn,
      path: MODELS_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!mutationGuard(req, res)) return
        try {
          const body = await readJson(req)
          const d = typeof deps === 'function' ? deps() : (deps ?? {})
          const ids = Array.isArray(body.enabledModelIds) ? body.enabledModelIds.filter((x) => typeof x === 'string') : []
          const via = settingsViaOf(d)
          // 同一路由兼任"整体开关"：带 providerDisabled 字段就只切开关
          if (typeof body.providerDisabled === 'boolean') {
            const setDisabled = d.setProviderDisabled
            if (typeof setDisabled !== 'function') return json(res, 503, { error: '设置不可用' })
            const result = normalizeSetterResult(await setDisabled(body.providerDisabled), { via })
            // 回读生效值：必须是 settings 优先 getter 给出的值，而不是我们刚写进去的入参
            const actual = readDepsSetting(deps, 'provider', via)
            const confirmed = confirmWritten(result, actual, (v) => v?.disabled === body.providerDisabled, { hasSource: hasDepsSetting(deps, 'provider') })
            return respondSetter(
              res,
              confirmed,
              { provider: actual ?? { disabled: body.providerDisabled } },
              '未能写入供应商开关',
            )
          }
          const save = d.saveEnabledModelIds
          if (typeof save !== 'function') return json(res, 503, { error: 'settings 服务不可用' })
          const result = normalizeSetterResult(await save(ids), { via })
          // 回读生效值：settings 可能做了归一（例如剔除未知模型 id）。
          // 空列表无法与"全部启用"区分，不做回读判负（避免误报写入失败）。
          const actual = readDepsSetting(deps, 'enabledModelIds', via)
          const confirmed = confirmWritten(result, actual, (v) =>
            ids.length === 0 || sameStringList(Array.isArray(v) ? v : [], ids),
          { hasSource: hasDepsSetting(deps, 'enabledModelIds') })
          return respondSetter(
            res,
            confirmed,
            { enabledModelIds: Array.isArray(actual) ? actual : ids },
            '未能写入模型勾选',
          )
        } catch (error) {
          json(res, 500, { error: String(error?.message ?? error) })
        }
      },
    }))
  } catch (error) {
    warn?.('dsh-connect-teleagent: models 路由注册失败', error)
  }
  // 状态快照：GET 只读。四项可配置字段（toolsAllowlist / provider.disabled /
  // enabledModelIds / welfare.autoClaimDaily）全部由 deps 的 **settings 优先 getter**
  // 提供，本文件不直接读任何存储文件；响应里的 `via` 标注这些值的实际来源。
  try {
    disposers.push(registerRoute(webServer, {
      label: 'status',
      warn,
      path: STATUS_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        try {
          const d = typeof deps === 'function' ? deps() : (deps ?? {})
          // settings 优先：via 由 deps 声明；deps 没声明时按 store（旧宿主只有这一层）
          const via = settingsViaOf(d)
          json(res, 200, buildStatus({ ...d, via }))
        } catch (error) {
          json(res, 500, { error: String(error?.message ?? error) })
        }
      },
    }))
  } catch (error) {
    warn?.('dsh-connect-teleagent: status 路由注册失败', error)
  }
  return () => { for (const d of disposers) { try { d?.() } catch { /* ignore */ } } }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

/** 当前进行中的登录流程（进程内单例，避免重复唤起） */
let activeLogin = null

/**
 * 启动登录流程：唤起应用 → 轮询凭据 → 登录成功后退出应用。
 *
 * 不阻塞调用方，返回后流程在后台继续；重复调用复用同一个流程。
 */
export function startLoginFlow({ timeoutMs } = {}) {
  if (activeLogin !== null) {
    return { ok: true, running: true, message: '登录流程已在进行中' }
  }
  // 两个流程都会唤起/退出同一个桌面端，不能同时跑
  if (activeAddAccount !== null) {
    return { ok: false, error: '「添加账号」流程正在进行中，请先等它结束或取消' }
  }
  const desktop = checkDesktopApp()
  if (!desktop.ok) return { ok: false, error: desktop.detail, remedy: desktop.remedy }

  activeLogin = loginThenQuit({
    diagnose: () => diagnoseCredential(),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
    .then((result) => {
      if (result.ok) {
        // 登录成功：通知 index 重建直连客户端（无需重启进程）
        authRefresher?.()
      }
      return result
    })
    .catch((error) => ({ ok: false, reason: String(error?.message ?? error) }))
    .finally(() => { activeLogin = null })

  return {
    ok: true,
    running: true,
    message: '已唤起 TeleAgent，请在应用内完成登录；完成后会自动退出应用',
    hint: '登录成功后模型自动可用，无需再点刷新',
  }
}

/** 同步等待登录流程结束（供需要结果调用方的用） */
export async function runLoginFlow({ timeoutMs } = {}) {
  if (activeAddAccount !== null) {
    return { ok: false, error: '「添加账号」流程正在进行中，请先等它结束或取消' }
  }
  return loginThenQuit({
    diagnose: () => diagnoseCredential(),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
}

/** 从请求 URL 里取查询参数（解析失败返回 null） */
function queryParam(req, name) {
  try {
    return new URL(String(req.url ?? '/'), 'http://127.0.0.1').searchParams.get(name)
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ 添加账号

/** 进行中的添加账号流程（进程内单例） */
let activeAddAccount = null
/** 最近一次添加账号的结果（卡片轮询用） */
let lastAddAccountResult = null

/** 由 index.js 注入：新账号登录成功后刷新积分等依赖当前账号的缓存 */
let accountAddedHook = null
export function setAccountAddedHook(fn) {
  accountAddedHook = typeof fn === 'function' ? fn : null
}

/** 查询添加账号流程的进度（给卡片轮询） */
export function getAddAccountState() {
  return {
    running: activeAddAccount !== null,
    startedAt: activeAddAccount?.startedAt ?? null,
    result: lastAddAccountResult,
  }
}

/**
 * 启动「添加账号」流程（非阻塞）。
 *
 * 流程本身在 add-account.js：备份当前 token → 唤起应用等用户换号登录 →
 * 检测到新账号后写回原账号 token → 退出应用。
 */
export function startAddAccountFlow({ timeoutMs } = {}) {
  if (activeAddAccount !== null) {
    return { ok: true, running: true, message: '添加账号流程已在进行中' }
  }
  // 普通「去登录」流程也在操作同一个桌面端；同时跑会让两边互相退出应用
  if (activeLogin !== null) {
    return { ok: false, error: '登录流程正在进行中，请稍后再试' }
  }
  const desktop = checkDesktopApp()
  if (!desktop.ok) return { ok: false, error: desktop.detail, remedy: desktop.remedy }

  const controller = new AbortController()
  const entry = { controller, startedAt: Date.now(), promise: null }
  activeAddAccount = entry
  lastAddAccountResult = null

  const options = {
    signal: controller.signal,
    timeoutMs: timeoutMs ?? DEFAULT_ADD_ACCOUNT_TIMEOUT_MS,
    isRunning: () => {
      try { return isAppRunningNow() } catch { return false }
    },
  }

  entry.promise = runAddAccountFlow(options)
    .then((result) => {
      // 新账号成为当前 owner，或原账号重新登录换了新凭据：
      // 两种情况下 kernel 里还是旧 token，必须重建；积分缓存也要作废。
      if (result?.ok === true || result?.code === 'same_account') {
        try { authRefresher?.() } catch { /* ignore */ }
        try { accountAddedHook?.() } catch { /* ignore */ }
      }
      lastAddAccountResult = { ...result, finishedAt: Date.now() }
      return result
    })
    .catch((error) => {
      lastAddAccountResult = { ok: false, code: 'internal', reason: String(error?.message ?? error), finishedAt: Date.now() }
      return lastAddAccountResult
    })
    .finally(() => {
      if (activeAddAccount === entry) activeAddAccount = null
    })

  return {
    ok: true,
    running: true,
    message: '已唤起 TeleAgent：请在应用里「设置 → 账号 → 退出登录」，再用另一个账号登录',
    hint: '插件会自动检测新账号；原账号的登录态会保留，可在账号列表里切换',
    timeoutMs: options.timeoutMs,
  }
}

/** 取消进行中的添加账号流程（会恢复原账号凭据） */
export function cancelAddAccountFlow() {
  if (activeAddAccount === null) {
    return { ok: false, running: false, reason: '当前没有进行中的添加账号流程' }
  }
  try { activeAddAccount.controller.abort() } catch { /* ignore */ }
  return { ok: true, running: true, message: '正在取消…' }
}

/** 同步等待添加账号流程结束（CLI / 测试 / `wait:true` 用） */
export async function runAddAccountFlowAndWait({ timeoutMs } = {}) {
  const started = startAddAccountFlow({ timeoutMs })
  if (started.ok !== true) return started
  const promise = activeAddAccount?.promise
  return promise === undefined || promise === null ? started : promise
}

/** 由 index.js 注入：登录成功后重建上游客户端 */
let authRefresher = null
export function setAuthRefresher(fn) {
  authRefresher = typeof fn === 'function' ? fn : null
}
