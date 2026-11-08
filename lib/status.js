/**
 * Host 侧状态路由：给浏览器卡片提供登录态、上游可达性与模型清单。
 *
 * 安全：仅应答回环来源；从不返回 token/JWT 原文。
 */
import fs from 'node:fs'
import { MODELS } from './models.js'
import { isAppInstalled, isAppRunningNow, loginThenQuit } from './lifecycle.js'
import { diagnoseCredential, probeDetails, CredentialState } from './credential.js'
import { runAddAccountFlow, DEFAULT_ADD_ACCOUNT_TIMEOUT_MS } from './add-account.js'
import { bootlog } from './bootlog.js'

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

/** 只接受本机回环请求 */
export function loopbackOrigin(req) {
  const host = String(req.headers.host ?? '')
  return host.startsWith('127.0.0.1') || host.startsWith('localhost') || host.startsWith('[::1]')
}

/**
 * 写操作的同源校验（CSRF 防护）。
 *
 * `loopbackOrigin()` 只看 `Host`，也就是「请求打到哪」；它**不能**证明请求是
 * 从我们自己的界面发出的。浏览器里任何页面都能对本机地址发一个「简单请求」：
 * `fetch(url, { method:'POST', mode:'no-cors', body:'{"toolsAllowlist":null}' })`
 * 或一个 `<form>` 提交 —— 这类请求不触发预检，`Host` 是目标地址（通过校验），
 * 而 `Origin` 才是攻击者页面。只校验 `Host` 就等于没有 CSRF 防护。
 *
 * 规则：
 *  - 没有 `Origin`：非浏览器客户端（curl / CLI / 宿主内部调用）——放行。
 *    CSRF 是浏览器行为，浏览器对跨源请求**一定会**带 `Origin`。
 *  - `Origin: null`（沙箱 iframe / file:// 页面）：一律拒绝。
 *  - 有 `Origin`：必须与请求的 `Host` 同源，否则 403。
 *
 * 同源 fetch 会带 `Origin`（POST 即使同源也带），所以正常界面调用不受影响。
 */
export function sameOriginRequest(req) {
  const raw = req?.headers?.origin
  if (raw === undefined || raw === null || raw === '') return true
  const origin = String(raw).trim()
  // 沙箱 iframe / data: / file: 页面发出的是字面量 "null"，不能当成"没有 Origin"
  if (origin === 'null') return false

  let target
  try {
    target = new URL(origin)
  } catch {
    return false
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false

  // 逐段比较主机名与端口（`http://127.0.0.1` 与 `127.0.0.1:80` 视为同源）
  const hostHeader = String(req?.headers?.host ?? '')
  let hostName = ''
  let hostPort = ''
  try {
    const parsed = new URL(`http://${hostHeader}`)
    hostName = parsed.hostname.toLowerCase()
    hostPort = parsed.port
  } catch {
    return false
  }
  const defaultPort = target.protocol === 'https:' ? '443' : '80'
  const originPort = target.port === '' ? defaultPort : target.port
  const requestPort = hostPort === '' ? defaultPort : hostPort
  return target.hostname.toLowerCase() === hostName && originPort === requestPort
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * 变更类（POST）请求的统一入口校验：同源 + JSON content-type。
 *
 * 两道检查互补，缺一不可：
 *  1. `sameOriginRequest` —— 挡住跨源页面。浏览器发跨源请求必带 `Origin`，
 *     且与请求 `Host` 不同源。
 *  2. content-type 必须是 `application/json` —— 跨源「简单请求」只允许
 *     `text/plain` / `application/x-www-form-urlencoded` / `multipart/form-data`，
 *     要求 JSON 就把这类请求挡在预检（CORS preflight）上；预检我们不应答，
 *     浏览器于是根本不会发出真正的请求。
 *
 * 已经检查过 `Host` 的调用方可以再调它做第二道闸。返回 false 时响应已写好。
 */
export function mutationGuard(req, res) {
  if (!sameOriginRequest(req)) {
    json(res, 403, { error: 'forbidden', reason: '跨源请求被拒绝' })
    return false
  }
  if (hasBody(req)) {
    const type = String(req?.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    // 没有 content-type 也按「不是 JSON」处理：浏览器发带 body 的请求一定会带它
    if (type !== 'application/json') {
      json(res, 415, { error: 'unsupported media type', reason: '只接受 application/json' })
      return false
    }
  }
  return true
}

/** 请求是否带 body（没有 body 的空 POST 仍要放行，例如「去登录」） */
function hasBody(req) {
  const length = Number(req?.headers?.['content-length'] ?? 0)
  if (Number.isFinite(length) && length > 0) return true
  // chunked 编码没有 content-length
  return req?.headers?.['transfer-encoding'] !== undefined
}

/**
 * 登录态摘要 —— 供卡片显示。
 *
 * 只暴露「是否可用、昵称、过期时间、失败原因与建议」，**从不返回 token**。
 */
export function readAuthState(home = process.env.HOME) {
  const d = diagnoseCredential(home)
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

/** 组装完整状态文档 */
export function buildStatus({ upstream, enabledModelIds, guard, account, welfare, provider, credentialProbe, allowChatProbe, transport, capabilities, toolsAllowlist }) {
  const toolsAllow = typeof toolsAllowlist === 'function' ? toolsAllowlist() : toolsAllowlist
  const auth = readAuthState()
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
  const credentialsBroken = hasCredential && auth.signedIn === false
  const abnormal = banned || credentialsBroken
  const accountInfo = {
    abnormal,
    banned,
    scope: accountSource?.scope ?? null,
    canClear: hasCredential,
    scopes,
    // 「添加账号」入口是否可用：桌面端没装就没什么可唤起的
    canAddAccount: isAppInstalled(),
    // 清除后该看到什么
    nextStep: abnormal
      ? (banned ? '该账号已被上游封禁：清除登录态后换账号登录' : '登录态异常：清除后重新登录')
      : null,
  }

  const welfareInfo = typeof welfare === 'function' ? welfare() : (welfare ?? null)
  const providerInfo = typeof provider === 'function' ? provider() : (provider ?? { disabled: false })

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
    toolsAllowlist: Array.isArray(toolsAllow) ? toolsAllow : null,
    models: MODELS.map((m) => ({
      vision: m.vision === true,
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      creditMultiplier: m.creditMultiplier,
      enabled: enabledModelIds === undefined || enabledModelIds.length === 0
        ? true
        : enabledModelIds.includes(m.id),
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
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'forbidden' })
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

  // 工具白名单：设置卡片保存用（GET 走 /status，POST 写 ~/.dsh/teleagent-plugin.json）
  try {
    disposers.push(registerRoute(webServer, {
      label: 'tools',
      warn,
      path: TOOLS_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'forbidden' })
        if (!mutationGuard(req, res)) return
        try {
          const d = typeof deps === 'function' ? deps() : (deps ?? {})
          const save = d.setToolsAllowlist
          if (typeof save !== 'function') return json(res, 503, { error: '设置不可用' })
          const body = await readJson(req)
          const raw = body.toolsAllowlist
          if (raw !== null && !Array.isArray(raw)) return json(res, 400, { error: 'toolsAllowlist 必须是数组或 null' })
          const list = raw === null
            ? null
            : raw.filter((x) => typeof x === 'string').map((x) => x.trim()).filter((x) => x.length > 0)
          if (list !== null && list.length > 500) return json(res, 400, { error: '条目过多（上限 500）' })
          save(list)
          json(res, 200, { ok: true, toolsAllowlist: list })
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
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'forbidden' })
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
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'forbidden' })
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
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'forbidden' })
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
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'forbidden' })
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
            depsValue.setAutoClaimDaily(body.enabled === true)
            return json(res, 200, { ok: true, welfare: depsValue.welfareSnapshot?.() ?? null })
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

  try {
    disposers.push(registerRoute(webServer, {
      label: 'models',
      warn,
      path: MODELS_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'forbidden' })
        if (!mutationGuard(req, res)) return
        try {
          const body = await readJson(req)
          const ids = Array.isArray(body.enabledModelIds) ? body.enabledModelIds.filter((x) => typeof x === 'string') : []
          // 同一路由兼任"整体开关"：带 providerDisabled 字段就只切开关
          if (typeof body.providerDisabled === 'boolean') {
            const setDisabled = deps().setProviderDisabled
            if (typeof setDisabled !== 'function') return json(res, 503, { error: '设置不可用' })
            setDisabled(body.providerDisabled)
            return json(res, 200, { ok: true, provider: deps().provider?.() ?? { disabled: body.providerDisabled } })
          }
          const save = deps().saveEnabledModelIds
          if (typeof save !== 'function') return json(res, 503, { error: 'settings 服务不可用' })
          await save(ids)
          json(res, 200, { ok: true, enabledModelIds: ids })
        } catch (error) {
          json(res, 500, { error: String(error?.message ?? error) })
        }
      },
    }))
  } catch (error) {
    warn?.('dsh-connect-teleagent: models 路由注册失败', error)
  }
  try {
    disposers.push(registerRoute(webServer, {
      label: 'status',
      warn,
      path: STATUS_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'forbidden' })
        try {
          json(res, 200, buildStatus(deps()))
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
  if (!isAppInstalled()) {
    return { ok: false, error: '未安装 TeleAgent 桌面端', remedy: '先从 https://www.teleai.com.cn 安装' }
  }

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
  if (!isAppInstalled()) return { ok: false, error: '未安装 TeleAgent 桌面端' }
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
  if (!isAppInstalled()) {
    return { ok: false, error: '未安装 TeleAgent 桌面端', remedy: '先从 https://www.teleai.com.cn 安装' }
  }

  const controller = new AbortController()
  const entry = { controller, startedAt: Date.now(), promise: null }
  activeAddAccount = entry
  lastAddAccountResult = null

  const options = {
    signal: controller.signal,
    timeoutMs: timeoutMs ?? DEFAULT_ADD_ACCOUNT_TIMEOUT_MS,
    isInstalled: () => isAppInstalled(),
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
