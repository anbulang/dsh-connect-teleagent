/**
 * 最小 MCP 服务端（Streamable HTTP）。
 *
 * 用途：把 **DSH 的工具** 暴露给 TeleAgent 内核。
 *
 * 为什么走 MCP 而不是改提示词：用户的明确要求是**不要动 TeleAgent 的系统提示词**
 * （改了会让请求看起来不像客户端，有封号风险）。MCP 是内核原生能力，
 * 客户端自己也在用，所以这条路不改变请求的"身份特征"。
 *
 * 实现范围（够用即可）：
 *   POST /mcp   JSON-RPC：initialize / notifications/initialized / tools/list / tools/call / ping
 *   GET  /mcp   SSE 通道（服务端通知用，这里保持空连接）
 *   DELETE /mcp 会话终止（返回 200）
 *
 * tools/call 的语义由调用方决定：默认返回 "deferred"，
 * 真实执行留给上层（见 lib/tool-bridge.js 的设计说明）。
 */
import http from 'node:http'
import crypto from 'node:crypto'

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'dsh-connect-teleagent', version: '1.0.0' }

/** 把 DSH 的 OpenAI 工具定义转成 MCP 工具定义 */
export function toMcpTools(openaiTools = []) {
  const tools = []
  for (const item of openaiTools) {
    const fn = item?.function ?? item
    const name = typeof fn?.name === 'string' ? fn.name : null
    if (name === null) continue
    tools.push({
      name,
      description: typeof fn.description === 'string' ? fn.description : '',
      inputSchema: fn.parameters && typeof fn.parameters === 'object'
        ? fn.parameters
        : { type: 'object', properties: {} },
    })
  }
  return tools
}

/**
 * 启动 MCP 服务。
 *
 * @param {object} options
 * @param {() => Array} [options.getTools] 当前要暴露的工具（每次 tools/list 都重新取，支持按请求变化）
 * @param {(name:string, args:object) => Promise<any>} [options.onCall] 工具调用处理
 * @returns {Promise<{url:string, port:number, close:()=>Promise<void>, stats:object}>}
 */
export async function startMcpServer({ getTools = () => [], onCall } = {}) {
  const stats = { initialized: 0, listed: 0, called: 0, errors: 0, calls: [] }
  const sessions = new Set()
  const sseClients = new Set()

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    // ---- SSE 通道（部分客户端会先 GET 建流）
    if (req.method === 'GET' && url.pathname.startsWith('/mcp')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      sseClients.add(res)
      req.on('close', () => { sseClients.delete(res) })
      return
    }

    // ---- 会话终止
    if (req.method === 'DELETE' && url.pathname.startsWith('/mcp')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
      return
    }

    if (req.method !== 'POST' || !url.pathname.startsWith('/mcp')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }

    let payload
    try {
      payload = JSON.parse(await readBody(req))
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
      return
    }

    // 支持批量
    const batch = Array.isArray(payload) ? payload : [payload]
    const responses = []
    for (const message of batch) {
      const answer = await handle(message)
      if (answer !== undefined) responses.push(answer)
    }

    if (responses.length === 0) {
      res.writeHead(202)
      res.end()
      return
    }

    const sessionId = req.headers['mcp-session-id']
    const headers = { 'Content-Type': 'application/json', 'MCP-Protocol-Version': PROTOCOL_VERSION }
    if (typeof sessionId === 'string' && sessionId !== '') headers['Mcp-Session-Id'] = sessionId

    res.writeHead(200, headers)
    res.end(JSON.stringify(Array.isArray(payload) ? responses : responses[0]))
  })

  async function handle(message) {
    const id = message?.id
    const method = message?.method
    const params = message?.params ?? {}

    // 通知类：不返回响应
    if (typeof method === 'string' && method.startsWith('notifications/')) {
      if (method === 'notifications/initialized') stats.initialized++
      return undefined
    }

    try {
      switch (method) {
        case 'initialize': {
          const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION
          const sessionId = crypto.randomUUID()
          sessions.add(sessionId)
          return reply(id, {
            protocolVersion: requested,
            capabilities: { tools: { listChanged: true } },
            serverInfo: SERVER_INFO,
          }, sessionId)
        }
        case 'ping':
          return reply(id, {})
        case 'tools/list': {
          stats.listed++
          const tools = toMcpTools(getTools())
          return reply(id, { tools })
        }
        case 'tools/call': {
          stats.called++
          const name = params.name
          const args = params.arguments ?? {}
          stats.calls.push({ name, at: Date.now() })
          if (stats.calls.length > 50) stats.calls.shift()
          if (typeof onCall !== 'function') {
            return reply(id, mcpText('工具执行未接入', true))
          }
          const result = await onCall(name, args)
          return reply(id, mcpText(result))
        }
        default:
          return reply(id, null, undefined, { code: -32601, message: `Method not found: ${method}` })
      }
    } catch (error) {
      stats.errors++
      return reply(id, null, undefined, { code: -32603, message: String(error?.message ?? error) })
    }
  }

  function reply(id, result, _sessionId, error) {
    return error
      ? { jsonrpc: '2.0', id: id ?? null, error }
      : { jsonrpc: '2.0', id: id ?? null, result }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const { port } = server.address()
  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    stats,
    /** 通知客户端工具清单变了（走 SSE 通道） */
    notifyToolsChanged() {
      for (const client of sseClients) {
        try {
          client.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`)
        } catch { /* 已断开 */ }
      }
    },
    close: () => new Promise((resolve) => {
      for (const client of sseClients) {
        try { client.end() } catch { /* ignore */ }
      }
      sseClients.clear()
      server.close(resolve)
    }),
  }
}

/** MCP 的文本结果 */
export function mcpText(text, isError = false) {
  return {
    content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text) }],
    isError: isError === true,
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8') || '{}'))
    req.on('error', reject)
  })
}
