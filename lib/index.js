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
import { MODELS, currentScope } from './models.js'
import { createShim } from './shim.js'
import { readUpstreamAuth, createUpstream, probeUpstream, authFingerprint } from './upstream.js'
import { startKernel, waitReady, createKernelTransport, probeKernelHealth, resolveKernelBinary, reapStaleKernels } from './kernel.js'
import { classifyUpstreamError, recordUpstreamError, clearUpstreamError } from './health.js'
import { createGuard } from './guard.js'
import { registerStatusRoutes, setAuthRefresher } from './status.js'
import { readStore, writeStore, saveEnabledModels } from './store.js'
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

export const name = 'dsh-connect-teleagent'
// 只声明必需服务。webServer / settings 是可选的，用 ctx.get() 软探测：
// 直接写进 inject 会让插件在缺该服务的 profile 上永远卡在「等待依赖」。
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
  bootlog('apply 进入', { hasCtx: !!ctx, inject: ['llm'] })
  let stopped = false
  let shim
  let closeAdapter
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

  /**
   * 当前生效的模型 id。
   * 优先级：显式 config > 持久化 store > 全部启用。
   */
  /** 是否整体停用（store 里持久化，卡片开关写入） */
  const isProviderDisabled = () => config?.providerDisabled === true || readStore().providerDisabled === true

  const enabledIds = () => {
    const fromConfig = config?.enabledModelIds
    if (Array.isArray(fromConfig) && fromConfig.length > 0) {
      return fromConfig.filter((id) => MODELS.some((m) => m.id === id))
    }
    const stored = readStore().enabledModelIds
    if (stored.length > 0) return stored.filter((id) => MODELS.some((m) => m.id === id))
    return MODELS.map((m) => m.id)
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
    // 只放弃挂起的工具调用，**不要 close 桥**：close 会关掉 MCP HTTP server，
    // 新内核随后 mount 时连不上（实测日志：dial tcp 127.0.0.1:<port>: actively refused），
    // 桥再也无法恢复，模型下一轮就看不到任何 dsh_* 工具。
    try { toolBridge?.cancelSuspended?.('kernel restart') } catch { /* ignore */ }
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
      try { await toolBridge?.mount(next, { force: true }) } catch { /* ignore */ }
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
    transport: () => ({
      mode: transport,
      ready: transport === 'kernel' ? kernelTransport !== null : true,
      kernel: kernelHandle === null ? null : { base: kernelHandle.base, pid: kernelHandle.child?.pid ?? null },
      // v0.10 起 kernel 通过 MCP 桥支持 DSH 工具；只有桥没挂上时才提示
      warning: transport === 'kernel' && toolBridge === null && config?.toolBridge !== false
        ? '工具桥未就绪：本轮模型可能无法调用 DSH 工具，请查看日志或重启 DSH'
        : null,
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
        // 切换后重新读凭据：provider 需要在下次请求时用新账号
        try { registryInvalidate?.() } catch { /* ignore */ }
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
    setProviderDisabled: (disabled) => {
      writeStore({ providerDisabled: disabled === true })
      try { registryInvalidate?.() } catch { /* ignore */ }
    },
    welfareSnapshot: () => welfare.snapshot(),
    welfareEnsureFresh: () => welfare.ensureFresh(),
    refreshWelfare: () => welfare.refreshAll(),
    claimWelfare: () => welfare.claim({ source: 'manual' }),
    setAutoClaimDaily: (enabled) => welfare.setAutoClaimDaily(enabled),
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
    enabledModelIds: enabledIds(),
    saveEnabledModelIds: async (ids) => {
      // 自持久化到 $DSH_HOME/teleagent-plugin.json，不依赖宿主 settings API
      saveEnabledModels(ids)
      // 让模型选择器立即反映新勾选
      try { registryInvalidate?.() } catch { /* ignore */ }
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
          // 工具白名单：config 优先，其次 ~/.dsh/teleagent-plugin.json（热读取）
          getToolsAllowlist: () => {
            try {
              const fromConfig = Array.isArray(config?.toolsAllowlist) ? config.toolsAllowlist : null
              if (fromConfig !== null) return fromConfig
              return readStore()?.toolsAllowlist ?? null
            } catch { return null }
          },
          logger: ctx.logger,
        })
        kernelError = null

        // 工具桥：内核原生 MCP，不修改系统提示词
        if (config?.toolBridge !== false) {
          try {
            toolBridge = await createMcpBridge({ logger: ctx.logger })
            await toolBridge.mount(kernelHandle)
            bootlog('工具桥已挂载', { url: toolBridge.url })
          } catch (error) {
            toolBridge = null
            bootlog('工具桥挂载失败', { error: String(error?.message ?? error) })
          }
        }

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
    if (stopped) return

    shim = await createShim({
      getUpstream,
      logger: ctx.logger,
      // 一次对话可能消耗积分，结束即把余额缓存标记为过期，
      // 胶囊下一次轮询（3 秒内）就会去上游取新值
      onTurnComplete: () => welfare.markStale(),
    })
    bootlog('shim 已启动', { port: shim.port })
    if (stopped) return

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

    welfare.start()

    registryInvalidate = invalidate
    const reg = ctx.llm.registerAdapter([TELEAGENT_PROVIDER], adapter)
    closeAdapter = () => { try { reg?.() } catch { /* ignore */ } }
    // 只读工具：让模型能自己回答"还有多少积分"
    try {
      closeTools = mountPointsTool(softGet(ctx, 'tools'), { logger: ctx.logger })
      bootlog('只读工具已挂载', { tool: 'teleagent_points' })
    } catch (error) {
      bootlog('只读工具挂载失败', error)
    }

    bootlog('provider 已注册', { id: TELEAGENT_PROVIDER, models: MODELS.length })
    ctx.logger?.info?.(`dsh-connect-teleagent: provider "${TELEAGENT_PROVIDER}" 已注册（${MODELS.length} 个模型，直连上游）`)
  }

  boot().catch((error) => {
    bootlog('boot 失败', error)
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
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    stopped = true
    try { welfare.stop() } catch { /* ignore */ }
    try { closeTools?.() } catch { /* ignore */ }
    try { kernelTransport?.close?.() } catch { /* ignore */ }
    try { kernelHandle?.stop?.() } catch { /* ignore */ }
    try { void toolBridge?.close?.() } catch { /* ignore */ }
    try { closeAdapter?.() } catch { /* ignore */ }
    try { closeStatusRoutes?.() } catch { /* ignore */ }
    try { shim?.close?.() } catch { /* ignore */ }
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
