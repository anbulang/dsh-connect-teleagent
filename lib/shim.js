/**
 * 本地 loopback shim：对外暴露 OpenAI 兼容端点，内部**透明转发**到 TeleAgent 上游。
 *
 * ## 与旧实现的关键区别
 *
 * 旧实现经过 kernel，必须把 messages 折叠成一段文本、并依赖 kernel session 维护历史，
 * 导致三个缺陷：role 丢失、多轮脆弱、工具调用链被 kernel 截断。
 *
 * 现在直连上游（见 `upstream.js` 的签名算法），因此这里是**纯代理**：
 *   - `messages` 原样透传（system / user / assistant / tool 全部保留）
 *   - `tools` / `tool_choice` 原样透传，`tool_calls` 原样返回，由 DSH 执行
 *   - 流式 SSE 字节直接转发（上游已是 OpenAI 事件格式）
 *   - 不保存任何会话状态，历史完全由调用方（DSH）负责
 *
 * 鉴权：监听 127.0.0.1 的随机端口，要求 `Authorization: Bearer <secret>`，
 * 真实 TeleAgent 凭据只存在于本进程内，从不暴露给调用方或日志。
 */
import http from 'node:http'
import crypto from 'node:crypto'

import { MODELS } from './models.js'
import { bootlog } from './bootlog.js'
import { classifyUpstreamError } from './health.js'
import { aggregateSse, describeFetchError, isRetryableConnectionError } from './upstream.js'

/** 上游错误 → OpenAI 错误形状，便于 DSH 统一处理 */
function writeOpenAIError(res, status, message, code) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    error: { message, type: 'invalid_request_error', code: code ?? 'upstream_error' },
  }))
}

/**
 * SSE 心跳：静默期间每 `intervalMs` 写一行注释帧（`: ping`），避免下游 fetch 的
 * bodyTimeout（undici 默认 300s）在长时间无数据时把连接掐掉。
 *
 * 线上表现就是：内核只发出一个 block-start 后 5 分钟没有任何事件，
 * 宿主把连接判为 `terminated`（TRANSPORT），然后退避重试——用户看到连续延迟。
 *
 * @param {import('node:http').ServerResponse} res 流式响应
 * @param {{intervalMs?:number}} [options]
 * @returns {() => void} 停止心跳
 */
export function createHeartbeat(res, { intervalMs = 15_000 } = {}) {
  const timer = setInterval(() => {
    if (res.writableEnded === true) return
    try { res.write(': ping\n\n') } catch { /* 下游已断 */ }
  }, intervalMs)
  timer.unref?.()
  return () => { clearInterval(timer) }
}

/**
 * 熔断打开时快速失败，其余错误照旧。
 *
 * 返回 503 + `Retry-After`，让调用方知道是「暂时停用」而不是请求本身有问题。
 */
function writeGuardAwareError(res, error) {
  if (error?.circuitOpen === true) {
    const retryAfterSec = Math.max(1, Math.ceil((error.retryAfterMs ?? 0) / 1000))
    bootlog('熔断拦截请求', { reason: error.reason, retryAfterSec })
    res.writeHead(503, {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfterSec),
    })
    res.end(JSON.stringify({
      error: {
        message: `上游调用已暂停：${error.reason}。约 ${Math.ceil(retryAfterSec / 60)} 分钟后自动恢复（可运行 node lib/doctor.js 查看原因）`,
        type: 'upstream_unavailable',
        code: 'circuit_open',
      },
    }))
    return
  }
  writeOpenAIError(res, 502, `shim: upstream stream failed: ${error?.message ?? error}`, 'upstream_error')
}

/** 读取请求体（限制大小，避免内存被打爆） */
function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('request body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * @param {object} options
 * @param {() => object} options.getUpstream 返回最新的直连客户端（登录后凭据会变）
 * @param {object} [options.logger]
 */
export async function createShim({ getUpstream, logger, onTurnComplete } = {}) {
  if (typeof getUpstream !== 'function') throw new Error('createShim 需要 getUpstream 回调')

  const secret = crypto.randomBytes(32).toString('base64url')
  let closed = false

  /** 一次对话结束（成功）后通知宿主：余额需要重算 */
  function turnDone(reason) {
    try { onTurnComplete?.(reason) } catch { /* 回调失败不影响请求 */ }
  }

  const server = http.createServer(async (req, res) => {
    try {
      // ---- 模型列表 ----
      if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          object: 'list',
          data: MODELS.map((m) => ({ id: m.id, object: 'model', owned_by: 'teleagent' })),
        }))
        return
      }

      if (req.method !== 'POST' || (req.url !== '/v1/chat/completions' && req.url !== '/chat/completions')) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'shim: not found ' + req.method + ' ' + req.url } }))
        return
      }

      // ---- 鉴权 ----
      const authHeader = req.headers.authorization ?? ''
      const expected = `Bearer ${secret}`
      if (authHeader !== expected) {
        // 只记录形状，不记录密钥本身
        bootlog('shim 鉴权失败', {
          hasHeader: authHeader.length > 0,
          scheme: authHeader.slice(0, 7),
          receivedLen: authHeader.length,
          expectedLen: expected.length,
          headerNames: Object.keys(req.headers).filter((h) => /auth|key|token/i.test(h)),
        })
        writeOpenAIError(res, 401, 'shim: invalid bearer token', 'unauthorized')
        return
      }

      const raw = await readBody(req)
      let body
      try { body = JSON.parse(raw) } catch {
        writeOpenAIError(res, 400, 'shim: invalid JSON body', 'invalid_request_error')
        return
      }

      if (!body || typeof body !== 'object' || typeof body.model !== 'string') {
        writeOpenAIError(res, 400, 'shim: model is required', 'invalid_request_error')
        return
      }
      if (!MODELS.some((m) => m.id === body.model)) {
        writeOpenAIError(res, 400, `shim: unknown model ${body.model}`, 'model_not_found')
        return
      }

      // ---- 透传（只补 TeleAgent 必需字段，不改写 messages/tools）----
      const upstreamBody = { ...body }
      if (upstreamBody.max_tokens === undefined && upstreamBody.max_completion_tokens === undefined) {
        const meta = MODELS.find((m) => m.id === body.model)
        if (meta?.maxTokens) upstreamBody.max_tokens = meta.maxTokens
      }
      const wantStream = body.stream === true
      // 官方客户端**从不**发 stream:false（实测抓包里全部是 stream:true +
      // stream_options.include_usage）。为了不在请求形态上暴露差异，
      // 即使调用方要非流式，也向上游发流式请求，再在本地聚合。
      upstreamBody.stream = true
      if (upstreamBody.stream_options === undefined) upstreamBody.stream_options = { include_usage: true }
      const callStream = wantStream ? upstreamBody : { ...upstreamBody }
      bootlog('shim 受理请求', {
        model: body.model,
        stream: wantStream,
        messages: Array.isArray(body.messages) ? body.messages.length : 0,
        roles: Array.isArray(body.messages) ? [...new Set(body.messages.map((m) => m.role))] : [],
        tools: Array.isArray(body.tools) ? body.tools.length : 0,
        // 请求体字节数：体积异常时能第一时间看出来
        bytes: raw.length,
      })

      let upstream
      try { upstream = getUpstream() } catch (error) {
        writeOpenAIError(res, 503, `shim: ${error?.message ?? error}`, error?.code ?? 'upstream_unavailable')
        return
      }

      if (!wantStream) {
        // 非流式：消费上游 SSE 并在本地聚合（上游请求形态仍与官方一致）
        const abortNs = new AbortController()
        res.on('close', () => { if (!res.writableEnded) abortNs.abort() })
        let upstreamResNs
        try {
          upstreamResNs = await upstream.chatStream(callStream, abortNs.signal)
        } catch (error) {
          writeGuardAwareError(res, error)
          return
        }
        if (!upstreamResNs.ok || !upstreamResNs.body) {
          const info = upstreamResNs.errorInfo
          const detail = info ? `${info.message}${info.remedy ? '；' + info.remedy : ''}` : (await upstreamResNs.text().catch(() => '')).slice(0, 400)
          bootlog('上游拒绝（聚合）', info ?? detail)
          writeOpenAIError(res, upstreamResNs.status || 502, `upstream: ${detail}`, info?.code ?? 'upstream_error')
          return
        }
        const sseText = await new Response(upstreamResNs.body).text()
        const aggregated = aggregateSse(sseText)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(aggregated))
        turnDone('non-stream')
        return
      }

      // ---- 流式：字节级转发 ----
      const abort = new AbortController()
      res.on('close', () => {
        if (!res.writableEnded) abort.abort()
      })

      let upstreamRes
      try {
        upstreamRes = await upstream.chatStream(upstreamBody, abort.signal)
      } catch (error) {
        // 连接类失败（还没收到任何字节）重试一次：这类错误多半是瞬时抖动
        if (isRetryableConnectionError(error) && !abort.signal.aborted) {
          const info = describeFetchError(error)
          bootlog('上游连接失败，重试一次', { ...info, model: body.model, bytes: raw.length })
          try {
            upstreamRes = await upstream.chatStream(upstreamBody, abort.signal)
          } catch (retryError) {
            const retryInfo = describeFetchError(retryError)
            bootlog('上游连接失败（重试仍失败）', { ...retryInfo, model: body.model, bytes: raw.length })
            res.writeHead(502, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              error: {
                message: `上游连接中断（${retryInfo.summary}）${retryInfo.code === 'ECONNRESET' ? '，可能是请求体过大或网络抖动' : ''}。请重试。`,
                type: 'upstream_unavailable',
                code: 'upstream_connection',
              },
            }))
            return
          }
        } else {
          const info = describeFetchError(error)
          bootlog('上游连接失败（不重试）', { ...info, model: body.model, bytes: raw.length })
          writeGuardAwareError(res, error)
          return
        }
      }

      if (!upstreamRes.ok || !upstreamRes.body) {
        const info = upstreamRes.errorInfo
        const detail = info ? `${info.message}${info.remedy ? '；' + info.remedy : ''}` : (await upstreamRes.text().catch(() => '')).slice(0, 400)
        bootlog('上游拒绝（流式）', info ?? detail)
        writeOpenAIError(res, upstreamRes.status || 502, `upstream: ${detail}`, info?.code ?? 'upstream_error')
        return
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })

      const reader = upstreamRes.body.getReader()
      const decoder = new TextDecoder()
      // 内核长时间无事件时发 : ping，避免宿主 300s bodyTimeout 判成 terminated
      const stopHeartbeat = createHeartbeat(res)
      let sawFinishReason = false
      let sawDone = false
      let tail = ''
      let streamError = null
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          // 旁路解析：只为了判断上游有没有给出 finish_reason
          tail += decoder.decode(value, { stream: true })
          const lines = tail.split('\n')
          tail = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '[DONE]') { sawDone = true; continue }
            try {
              const chunk = JSON.parse(payload)
              if (chunk?.choices?.some((c) => c?.finish_reason)) sawFinishReason = true
              if (chunk?.error) streamError = chunk.error
            } catch { /* 非 JSON 行忽略 */ }
          }
          if (!res.write(Buffer.from(value))) {
            // 下游背压：等 drain，避免内存堆积
            await new Promise((resolve) => res.once('drain', resolve))
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          const info = describeFetchError(error)
          bootlog('流式转发中断', { ...info, model: body.model })
          logger?.warn?.('dsh-connect-teleagent: 流式转发中断', info.summary)
        }
      } finally {
        stopHeartbeat()
        try { void reader.cancel().catch(() => {}) } catch { /* ignore */ }
        if (!res.writableEnded) {
          // 上游没给 finish_reason 就结束了：宿主会报
          // "Stream ended without finish_reason"。这里补一个 stop，让这一轮正常收尾。
          if (!sawFinishReason && !streamError && !abort.signal.aborted) {
            bootlog('上游流结束但缺 finish_reason，已补发', { model: body.model, sawDone })
            try {
              res.write(Buffer.from('data: ' + JSON.stringify({
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              }) + '\n\n'))
            } catch { /* 下游已断 */ }
          }
          if (!sawDone) {
            try { res.write(Buffer.from('data: [DONE]\n\n')) } catch { /* 下游已断 */ }
          }
          res.end()
        }
        turnDone('stream')
      }
    } catch (error) {
      if (!res.headersSent) {
        writeOpenAIError(res, 500, `shim: ${error?.message ?? error}`, 'internal_error')
      } else if (!res.writableEnded) {
        res.end()
      }
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const port = server.address().port

  return {
    port,
    baseUrl: () => `http://127.0.0.1:${port}`,
    token: () => secret,
    close() {
      if (closed) return Promise.resolve()
      closed = true
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
