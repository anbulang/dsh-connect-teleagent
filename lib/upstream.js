/**
 * 直连 TeleAgent 上游的纯 LLM 客户端。
 *
 * ## 为什么不再经过 kernel
 *
 * kernel 是完整的 agent runtime：人格 prompt、工具执行、会话管理全部硬编码，
 * 且 `# Security` 段明确禁止外部覆盖（实测 AGENTS.md / OPENCODE_DEFAULT_AGENT
 * 均无效）。通过它转发会带来三个无法修复的问题：
 *
 *  1. 用户消息被折叠成文本 —— kernel 的 message API 只有 `parts:[{text}]`，没有 role
 *  2. 多轮历史依赖 kernel session —— 进程重启或 TTL 过期即丢失
 *  3. 工具调用链被截断 —— kernel 自己执行工具，DSH 拿不到 tool_calls
 *
 * 于是改为**直连上游**。上游本身是标准 OpenAI 兼容接口，只需要正确签名。
 *
 * ## 签名算法（逆向自 kernel `einoprovider.(*GatewaySigner).Sign`）
 *
 * 用 lldb 断在 `hmacHex` 入口实测得到两次调用：
 *
 *  第 1 步（绑定 installId）：
 *     key = JWT 第三段（`token.split(".")[2]`）
 *     msg = "superagent-auth-v1/{token}/{installId}/{ts}/{nonce}"
 *     k1  = hex(HMAC-SHA256(key, msg))
 *
 *  第 2 步（请求签名）：
 *     key = k1（作为 64 字符十六进制文本）
 *     msg = "superagent-auth-v1\n{METHOD}\n{pathname}\n{ts}\n{nonce}\n{appVersion}\n{sha256hex(body)}"
 *     sig = hex(HMAC-SHA256(key, msg))
 *
 * 注意 `pathname` 必须包含 `/superCowork/sapi` 前缀（签名用完整路径）。
 * 实测错误顺序会得到 `40104 invalid signature`，说明 token 已通过、仅签名不符。
 *
 * ## 凭据来源
 *  - 用户 token：`users/<scope>/app-auth/token.json`（safeStorage 加密，走钥匙串解密）
 *  - 设备标识：`app-auth/device-meta.json`
 *  - 网关 apiKey：桌面端内置常量
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { diagnoseCredential, CredentialState } from './credential.js'
import { appPaths, currentScope } from './models.js'
import { classifyUpstreamError, recordUpstreamError, clearUpstreamError } from './health.js'
import { createGuard } from './guard.js'
import { TELEAI_API_KEY } from './secrets.js'

export const TELEAI_ORIGIN = 'https://agent.teleai.com.cn'
export const TELEAI_API_PREFIX = '/superCowork/sapi'
export const TELEAI_CHAT_PATH = '/api/v1/chat/completions'
/** 签名时使用的完整 pathname（含 /superCowork/sapi 前缀） */
export const TELEAI_SIGNED_PATH = TELEAI_API_PREFIX + TELEAI_CHAT_PATH
export const TELEAI_ROUTE_TARGET = 'ops-gateway'

const hex = (buf) => buf.toString('hex')
const sha256hex = (s) => hex(crypto.createHash('sha256').update(s).digest())
const hmacHex = (key, msg) => hex(crypto.createHmac('sha256', key).update(msg).digest())

/**
 * 凭据指纹：用于判断「登录态是否变化」。
 *
 * 只做 stat（不读内容、不碰钥匙串），因此可以在每次请求前廉价调用。
 * 重新登录会重写 token.json（mtime/size 变化），指纹随之改变，
 * 调用方即可丢弃缓存的客户端 —— 这样换账号后**无需重启 DSH**。
 */
export function authFingerprint(home) {
  try {
    const { data } = appPaths(home)
    const scope = currentScope(data)
    const tokenFile = path.join(data, 'users', scope, 'app-auth', 'token.json')
    const st = fs.statSync(tokenFile)
    return `${scope}:${st.mtimeMs}:${st.size}`
  } catch {
    return 'none'
  }
}

/**
 * 读取直连所需的全部凭据。
 * @throws 带 `.code` / `.remedy` 的错误，便于上层给出可执行提示
 */
export function readUpstreamAuth(home, desktop) {
  const diagnosis = diagnoseCredential(home, desktop)
  if (!diagnosis.ok) {
    const error = new Error(`TeleAgent 凭据不可用：${diagnosis.detail}${diagnosis.remedy ? `；${diagnosis.remedy}` : ''}`)
    error.code = diagnosis.state ?? CredentialState.NOT_SIGNED_IN
    error.diagnosis = diagnosis
    throw error
  }

  const { data: dataDir } = appPaths(home)
  const deviceFile = path.join(dataDir, 'app-auth', 'device-meta.json')
  let device = {}
  try {
    device = JSON.parse(fs.readFileSync(deviceFile, 'utf8'))
  } catch { /* 缺失时下面统一报错 */ }

  if (typeof device?.deviceId !== 'string' || device.deviceId.length === 0) {
    const error = new Error(`缺少设备标识：${deviceFile}`)
    error.code = 'device_meta_missing'
    error.remedy = '在 TeleAgent 桌面端登录一次，让它生成 app-auth/device-meta.json'
    throw error
  }

  return {
    token: diagnosis.token,
    deviceId: device.deviceId,
    installId: device.installId ?? '',
    appVersion: diagnosis.appVersion,
    accountName: diagnosis.accountName,
    scope: diagnosis.scope,
    expiresAt: diagnosis.expiresAt,
  }
}

/**
 * 纯签名函数（无时间依赖，便于单测）。
 *
 * 两步 HMAC：先用 JWT 第三段签「绑定 installId」的消息得到 k1，
 * 再用 k1 签「请求指纹」得到最终签名。
 */
export function computeSignature({ token, installId, appVersion, method, pathname, ts, nonce, body }) {
  const jwtThird = token.split('.')[2] ?? ''
  const k1 = hmacHex(jwtThird, `superagent-auth-v1/${token}/${installId}/${ts}/${nonce}`)
  const sig = hmacHex(k1, [
    'superagent-auth-v1', method, pathname, ts, nonce, appVersion, sha256hex(body),
  ].join('\n'))
  return { k1, signature: sig }
}

/**
 * 生成与官方客户端同形的会话/消息标识。
 *
 * 这些 ID 在 opencode 系协议里由**客户端生成**（kernel 也是本地生成的），
 * 不是服务端下发的，因此这里本地生成是协议正确的行为，不是伪造认证。
 */
function newSessionId() {
  return 'ses_' + crypto.randomBytes(10).toString('hex')
}
function newMessageId() {
  return 'msg_' + crypto.randomBytes(10).toString('hex')
}

/** 单次请求的签名头（每次请求都要新的 ts + nonce） */
export function buildAuthHeaders(auth, { body, method = 'POST', pathname = TELEAI_SIGNED_PATH, ts: tsIn, nonce: nonceIn, sessionId, messageId, requestId } = {}) {
  // ts/nonce 可注入：单测需要确定性，生产环境每次自动生成
  const ts = tsIn ?? String(Math.floor(Date.now() / 1000))
  const nonce = nonceIn ?? crypto.randomUUID()
  const jwtThird = auth.token.split('.')[2] ?? ''

  const bindingMsg = `superagent-auth-v1/${auth.token}/${auth.installId}/${ts}/${nonce}`
  const k1 = hmacHex(jwtThird, bindingMsg)

  const signMsg = [
    'superagent-auth-v1',
    method,
    pathname,
    ts,
    nonce,
    auth.appVersion,
    sha256hex(body),
  ].join('\n')
  const signature = hmacHex(k1, signMsg)

  // 同一次请求里会话 id 必须一致（root 与 session 指向同一个会话）
  const sid = sessionId ?? newSessionId()
  const mid = messageId ?? newMessageId()

  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${TELEAI_API_KEY}`,
    'X-Token': auth.token,
    'User-Agent': 'super-agent/1.0',
    'X-App-Version': auth.appVersion,
    'X-Route-Target': TELEAI_ROUTE_TARGET,
    'X-Superagent-Device-Id': auth.deviceId,
    'X-Superagent-Install-Id': auth.installId,
    'X-Superagent-Timestamp': ts,
    'X-Superagent-Nonce': nonce,
    'X-Superagent-Sign-Version': 'v1',
    'X-Superagent-Signature': signature,
    'X-Teleai-Run-Unit-Type': 'agent_loop',
    'X-Teleai-Upstream-Request-Id': crypto.randomUUID(),
    'X-Request-Id': requestId ?? crypto.randomUUID(),
    // 官方客户端总会带上会话上下文；缺失这些头的请求在服务端看来
    // 是「不可能由正常客户端产生」的，属于异常信号
    'X-Session-Id': sid,
    'X-Message-Id': mid,
    'X-Teleai-Root-Session-Id': sid,
    'Cache-Control': 'no-cache',
    // 官方客户端（Electron）显式声明长连接；undici 默认不发送该头
    Connection: 'keep-alive',
  }
}

/**
 * 把上游 SSE 聚合成一条非流式 OpenAI 响应。
 *
 * 为什么需要它：官方客户端**从不用** `stream: false`（实测抓包所有请求都是
 * `stream: true` + `stream_options.include_usage`）。为了不在请求形态上暴露差异，
 * 即使调用方要非流式，我们也始终向上游发流式请求，再在本地聚合。
 */
export function aggregateSse(sseText) {
  let content = ''
  let reasoning = ''
  const toolCalls = []
  let finishReason = null
  let usage = null
  let id = null
  let model = null
  let created = null
  let role = 'assistant'

  for (const line of String(sseText).split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '[DONE]' || payload === '') continue
    let chunk
    try { chunk = JSON.parse(payload) } catch { continue }
    id ??= chunk.id ?? null
    model ??= chunk.model ?? null
    created ??= chunk.created ?? null
    if (chunk.usage) usage = chunk.usage
    const choice = chunk.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}
    if (delta.role) role = delta.role
    if (typeof delta.content === 'string') content += delta.content
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : toolCalls.length
        const slot = toolCalls[idx] ?? (toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } })
        if (tc.id) slot.id = tc.id
        if (tc.type) slot.type = tc.type
        if (tc.function?.name) slot.function.name += tc.function.name
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
  }

  const message = { role, content }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length > 0) message.tool_calls = toolCalls.filter(Boolean)
  return {
    id: id ?? 'chatcmpl-aggregated',
    object: 'chat.completion',
    created: created ?? Math.floor(Date.now() / 1000),
    model: model ?? '',
    choices: [{ index: 0, message, finish_reason: finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop') }],
    ...(usage ? { usage } : {}),
  }
}

/**
 * 轻量探针：发一个 `max_tokens: 1` 的最小请求，验证「凭据 + 签名 + 账号状态」。
 *
 * 用于启动自检与 doctor：这样账号被封禁之类的状态会在卡片上立刻可见，
 * 而不是等用户发第一条消息才看到「API 密钥无效」。
 * 成本约 1 个 token。
 */
export async function probeUpstream(auth, options = {}) {
  // ---------------------------------------------------------------- 硬门禁
  //
  // 这个函数会发**真实的聊天请求**。2026-10-27 的两次封号复盘表明：
  // 这类"合成探测"（小请求、频繁、无实际语义）是最容易被风控标记的形态。
  // 因此默认**禁用**，必须由调用方显式放开：
  //   - 代码：probeUpstream(auth, { allow: true })
  //   - 环境变量：TELEAGENT_ALLOW_CHAT_PROBE=1
  // 这与"我记得不要探测"不同：忘记时它会直接拒绝发请求。
  const allowed = options.allow === true || process.env.TELEAGENT_ALLOW_CHAT_PROBE === '1'
  if (!allowed) {
    return {
      ok: false,
      skipped: true,
      status: 0,
      json: null,
      text: '',
      reason: '聊天探测默认禁用（两个账号曾因合成探测被封）。需要时显式传 allow:true 或设置 TELEAGENT_ALLOW_CHAT_PROBE=1',
    }
  }

  const body = JSON.stringify({
    model: options.model ?? 'chat-flash',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 1,
    stream: false,
  })
  const headers = buildAuthHeaders(auth, { body })
  const url = (options.baseUrl ?? TELEAI_ORIGIN) + TELEAI_SIGNED_PATH
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(options.timeoutMs ?? 20000) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 保留原文 */ }
  return { ok: res.ok, status: res.status, json, text }
}

/**
 * 把 fetch 抛出的错误摊平成可读结构。
 *
 * Node 的 `fetch failed` 只是一个外壳，真正原因在 `error.cause` 里
 * （ECONNRESET / ETIMEDOUT / UND_ERR_SOCKET / getaddrinfo ENOTFOUND…）。
 * 不展开就会只看到 "fetch failed"，无法判断是断网、超时还是上游重置。
 */
export function describeFetchError(error) {
  const chain = []
  let current = error
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
    chain.push({
      name: current.name,
      message: current.message,
      code: current.code,
      errno: current.errno,
      syscall: current.syscall,
    })
    current = current.cause
  }
  const last = chain[chain.length - 1] ?? {}
  return {
    summary: chain.map((x) => x.code ?? x.name ?? x.message).filter(Boolean).join(' ← '),
    chain,
    code: last.code ?? last.errno ?? 'unknown',
  }
}

/** 连接类失败（还没有收到任何响应），重试一次通常是安全的 */
export function isRetryableConnectionError(error) {
  const { chain } = describeFetchError(error)
  const codes = chain.map((x) => x.code).filter(Boolean)
  return codes.some((c) => [
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
    'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
  ].includes(c))
}

/**
 * 创建直连客户端。
 *
 * `chat()` 是**透明转发**：请求体原样送给上游，响应体原样返回，
 * 不做任何消息折叠或工具改写。
 */
export function createUpstream(auth, options = {}) {
  const baseUrl = (options.baseUrl ?? TELEAI_ORIGIN) + TELEAI_API_PREFIX
  const url = baseUrl + TELEAI_CHAT_PATH
  const timeoutMs = options.timeoutMs ?? 20 * 60 * 1000
  // 并发节流 + 认证失败熔断；同一账号共享一个 guard
  const guard = options.guard ?? createGuard(options.guardOptions ?? {})

  return {
    auth,
    url,
    guard,

    /** 非流式：返回上游原始 JSON */
    async chat(body) {
      guard.check()
      const payload = JSON.stringify(body)
      const headers = buildAuthHeaders(auth, { body: payload })
      const res = await guard.withSlot(() => fetch(url, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      }))
      guard.observe(res.status)
      const text = await res.text()
      let json = null
      try { json = JSON.parse(text) } catch { /* 保留原文 */ }
      if (!res.ok) recordUpstreamError(classifyUpstreamError(res.status, json, text))
      else clearUpstreamError()
      return { status: res.status, ok: res.ok, json, text, headers: res.headers }
    },

    /**
     * 流式：返回上游 SSE 的原始字节流。
     * 上游本身已经是 OpenAI 事件格式，直接转发即可。
     */
    async chatStream(body, signal) {
      const payload = JSON.stringify(body)
      const headers = { ...buildAuthHeaders(auth, { body: payload }), Accept: 'text/event-stream' }
      guard.check()
      const res = await guard.withSlot(() => fetch(url, {
        method: 'POST',
        headers,
        body: payload,
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      }))
      guard.observe(res.status)
      if (!res.ok) {
        // 流式失败时上游会返回 JSON 错误体，读出来分类后重新包一层
        const text = await res.text().catch(() => '')
        let json = null
        try { json = JSON.parse(text) } catch { /* 保留原文 */ }
        recordUpstreamError(classifyUpstreamError(res.status, json, text))
        return { ok: false, status: res.status, text: () => Promise.resolve(text), body: null, errorInfo: classifyUpstreamError(res.status, json, text) }
      }
      clearUpstreamError()
      return res
    },
  }
}
