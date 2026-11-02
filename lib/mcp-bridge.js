/**
 * DSH 工具 ↔ TeleAgent 内核 的桥。
 *
 * ## 为什么是 MCP
 *
 * 用户要求**不要改 TeleAgent 的系统提示词**（怕请求特征变化被封）。而 MCP 是内核
 * 原生能力（客户端自己也在用），工具通过 `mcp` 配置进入内核的工具注册表，
 * 再由内核原生传给模型 —— 提示词、人格串都保持原样。
 *
 * ## 实测确认的契约（本机验证，未调用模型）
 *
 * - 运行时挂载：`POST /mcp { name, config: { type:'remote', url } }`
 * - 内核随即连接并调用 `initialize` / `tools/list`（已验证 initialize=1, tools/list=1）
 * - 工具命名：`<服务器名>_<工具名>`，例如服务器叫 `dsh`、工具叫 `dsh_echo`
 *   → 注册表里是 `dsh_dsh_echo`（实测）
 * - 注册表可查：`GET /experimental/tool`、`GET /experimental/tool/ids`
 *
 * ## 拦截语义
 *
 * 模型调用 MCP 工具时，内核会真的发起 `tools/call`。我们**不执行**：
 * 记录这次调用、立刻返回一个占位结果，然后由传输层中断本轮，
 * 把调用翻译成 OpenAI 的 `tool_calls` 交给 DSH 执行。
 * 工具结果会在下一次请求里以文本 part 回灌给内核。
 */
import { startMcpServer } from './mcp-server.js'

/** 内核给 MCP 工具加的前缀形式：`<server>_<tool>` */
export function mcpToolId(serverName, toolName) {
  return `${serverName}_${toolName}`
}

/** 从内核的工具 id 还原成 DSH 的工具名 */
export function stripMcpPrefix(id, serverName = 'dsh') {
  const prefix = `${serverName}_`
  return typeof id === 'string' && id.startsWith(prefix) ? id.slice(prefix.length) : id
}

/**
 * 启动桥接。
 *
 * @param {object} options
 * @param {string} [options.serverName]
 * @param {object} [options.logger]
 */
export async function createMcpBridge({ serverName = 'dsh', logger } = {}) {
  /** 当前要暴露给内核的 DSH 工具（每次请求前更新） */
  let currentTools = []
  /** 本轮被拦截的调用（供 DSH 执行） */
  let pending = []
  /** 挂起的工具调用：内核在等我们的 MCP 响应，收到 DSH 结果后再放行 */
  let suspended = []
  let server = null
  let mountedOn = null
  let builtinCache = null
  let builtinCacheKernel = null

  // 工具定义按 OpenAI 格式保存；MCP 那边由 mcp-server 转换
  server = await startMcpServer({
    getTools: () => currentTools,
    onCall: async (name, args) => {
      const tool = stripMcpPrefix(name, serverName)
      pending.push({ tool, args, at: Date.now() })
      if (pending.length > 40) pending.shift()

      // **挂起**而不是立即返回占位：
      // DSH 执行完工具、下一轮请求把结果送回来之后，我们再从这里放行，
      // 内核这一轮就能带着真实结果继续生成（会话不会进入 busy 状态）。
      return new Promise((resolve) => {
        suspended.push({ tool, args, resolve, at: Date.now() })
      })
    },
  })

  /** 读内核注册表里属于本桥的工具 */
  async function inspectImpl(kernel) {
    try {
      const res = await kernel.request('GET', '/experimental/tool/ids', undefined, { timeoutMs: 5000 })
      const ids = JSON.parse(res.text)
      return Array.isArray(ids) ? ids.filter((id) => String(id).startsWith(`${serverName}_`)) : []
    } catch {
      return []
    }
  }

  const inspect = (kernel) => inspectImpl(kernel)

  /**
   * 等内核把我们的工具真正注册进注册表。
   *
   * 实测注册是**异步**的：POST /mcp 返回 200 后，注册表要再过一会儿才出现 `dsh_*`。
   * 不等就会出现"第一轮模型看不到任何工具"的问题（工具定义了但没生效）。
   */
  async function waitForRegistrationImpl(kernel, { expected = 0, timeoutMs = 4000 } = {}) {
    const started = Date.now()
    let tools = []
    while (Date.now() - started < timeoutMs) {
      tools = await inspectImpl(kernel)
      if (tools.length >= expected) return { ok: true, tools }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    return { ok: false, tools }
  }

  const waitForRegistration = (kernel, options) => waitForRegistrationImpl(kernel, options)

  return {
    serverName,
    url: server.url,
    port: server.port,

    /**
     * 内核就绪后把 MCP 服务器挂上去。
     *
     * 内核会缓存 tools/list（实测 list_changed 通知不生效），
     * 所以工具集变化时用 `force` 重新挂载一次让内核重新拉取。
     */
    async mount(kernel, { force = false } = {}) {
      if (mountedOn === kernel && force !== true) return { ok: true, alreadyMounted: true }
      try {
        await kernel.request('POST', '/mcp', {
          name: serverName,
          config: { type: 'remote', url: server.url, enabled: true },
        })
        mountedOn = kernel
        logger?.info?.('dsh-connect-teleagent: MCP 桥已挂载到内核', { url: server.url })
        return { ok: true }
      } catch (error) {
        logger?.warn?.('dsh-connect-teleagent: MCP 挂载失败', error?.message ?? error)
        return { ok: false, error: String(error?.message ?? error) }
      }
    },

    /**
     * 更新要暴露的工具集。
     * 返回是否发生了变化（变化时内核需要重新 tools/list）。
     */
    setTools(tools) {
      const next = Array.isArray(tools) ? tools : []
      const signature = next.map((t) => (t?.function ?? t)?.name).filter(Boolean).join(',')
      const prevSignature = currentTools.map((t) => (t?.function ?? t)?.name).filter(Boolean).join(',')
      currentTools = next
      if (signature !== prevSignature) {
        server.notifyToolsChanged?.()
        return true
      }
      return false
    },

    /** 是否有挂起的工具调用（内核在等结果） */
    hasSuspended() {
      return suspended.length > 0
    },

    /**
     * 用 DSH 返回的工具结果放行挂起的调用。
     * @returns {number} 放行了几个
     */
    resolveSuspended(text) {
      const list = suspended
      suspended = []
      for (const item of list) {
        try {
          item.resolve(JSON.stringify({ content: String(text ?? ''), ok: true }))
        } catch { /* 已关闭 */ }
      }
      return list.length
    },

    /** 放弃挂起的调用（DSH 取消/超时） */
    cancelSuspended(reason = 'aborted') {
      const list = suspended
      suspended = []
      for (const item of list) {
        try { item.resolve(JSON.stringify({ content: '', ok: false, error: reason })) } catch { /* ignore */ }
      }
      return list.length
    },

    /** 取走本轮被拦截的调用（取完即清空） */
    takeCalls() {
      const calls = pending
      pending = []
      return calls
    },

    /** 是否有被拦截的调用 */
    hasCalls() {
      return pending.length > 0
    },

    /**
     * 生成 `tools` 开关：内核自带的工具全部关掉，只留 MCP 桥过去的。
     *
     * 依据是内核注册表（`GET /experimental/tool/ids`）里那些**不带我们前缀**的 id。
     * 这样模型不会去调 bash/read/memory_get 这些内核工具（它们会在内核沙箱里执行）。
     */
    async builtinFlags(kernel) {
      if (builtinCache !== null && builtinCacheKernel === kernel) return builtinCache
      try {
        const res = await kernel.request('GET', '/experimental/tool/ids', undefined, { timeoutMs: 5000 })
        const ids = JSON.parse(res.text)
        const flags = {}
        for (const id of ids) {
          if (typeof id !== 'string') continue
          if (id.startsWith(`${serverName}_`)) continue
          flags[id] = false
        }
        builtinCache = flags
        builtinCacheKernel = kernel
        return flags
      } catch {
        return {}
      }
    },

    inspect,

    /** 等内核完成注册（异步生效，见上） */
    waitForRegistration,

    inspect,
    waitForRegistration: waitForRegistrationImpl,

    stats: server.stats,
    /** 关闭：先放行挂起的调用，否则内核/测试会一直等 */
    async close() {
      try {
        for (const item of suspended) {
          try { item.resolve(JSON.stringify({ content: '', ok: false, error: 'bridge closed' })) } catch { /* ignore */ }
        }
        suspended = []
      } catch { /* ignore */ }
      return server.close()
    },
  }
}

/** 把拦截到的 MCP 调用转成 OpenAI tool_calls */
export function callsToOpenAiToolCalls(calls, { idPrefix = 'call' } = {}) {
  return calls.map((call, index) => ({
    id: `${idPrefix}_${Date.now().toString(36)}_${index}`,
    type: 'function',
    function: {
      name: call.tool,
      arguments: JSON.stringify(call.args ?? {}),
    },
  }))
}
