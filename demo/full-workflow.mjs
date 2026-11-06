/**
 * 完整工作流 · 本地 demo（零模型流量）
 *
 * 串起来的是插件真正跑的那条链路：
 *
 *   假内核（HTTP + SSE）
 *     → createKernelTransport（真实的 prompt / 事件消费 / 续跑）
 *     → MCP 工具桥（真实的 tools/call 拦截与挂起）
 *     → 假 DSH 执行两个并行工具
 *     → 两条工具结果按 tool_call_id 分别回填
 *     → 内核续跑并给出最终回答
 *
 * 不会碰 TeleAgent：没有账号、没有模型请求、没有内核二进制。
 *
 * 用法：node demo/full-workflow.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createKernelTransport } from '../lib/kernel.js'
import { createMcpBridge } from '../lib/mcp-bridge.js'

const execFileAsync = promisify(execFile)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let sessionSeq = 0

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: '执行命令',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: '读取文件',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
]

/** 演示用的“文件”，由 read 工具真实读取 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-demo-'))
const demoFile = path.join(tmpDir, 'note.txt')
fs.writeFileSync(demoFile, 'DEMO-READ-OK')

let bridge = null
let transport = null
let rpcId = 0
const clients = new Set()

function emit(event) {
  const frame = `data: ${JSON.stringify(event)}\n\n`
  for (const res of clients) {
    try { res.write(frame) } catch { /* 客户端已断开 */ }
  }
}

function mcpCall(name, args) {
  return fetch(bridge.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  }).then((res) => res.json())
}

/** MCP 结果文本是 {"content":"...","ok":true} 信封，拆出真实输出 */
function toolContent(response) {
  const raw = response?.result?.content?.[0]?.text ?? ''
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed?.content === 'string' ? parsed.content : raw
  } catch {
    return raw
  }
}

/**
 * 假内核的“模型”：
 * 先要两个工具，等 DSH 把结果送回来，再续写成最终回答。
 */
async function runKernelScenario(sessionID) {
  await sleep(30)
  emit({ type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant', sessionID } } })
  emit({
    type: 'message.part.updated',
    properties: { part: { id: 'p1', sessionID, messageID: 'm1', type: 'text', text: '我并行跑两个工具。' } },
  })

  // 关键：两个 MCP 调用都挂起之后再发 tool part。
  // consumeEvents 看到本会话 tool part + 桥里有调用就收尾；先等到 2 个，
  // 保证演示能稳定覆盖并行工具调用（真实内核也是一次把一批 tools/call 打过来）。
  const bashPending = mcpCall('dsh_bash', { command: 'DEMO-BASH-OK' })
  const readPending = mcpCall('dsh_read', { path: demoFile })
  const started = Date.now()
  while (bridge.stats.called < 2 && Date.now() - started < 2000) await sleep(10)
  assert.equal(bridge.stats.called, 2, '假内核的两个 tools/call 都应到达桥')
  // 留出窗口让并发的标题请求读到「桥里有调用」——旧实现会在这里把它抢走。
  // 真实内核在 tool part 与 tools/call 之间也有安全审查延迟（实测 ~250ms）。
  await sleep(300)
  emit({
    type: 'message.part.updated',
    properties: { part: { id: 't1', sessionID, messageID: 'm1', type: 'tool', text: '' } },
  })

  // 这里会一直等到 DSH 的续跑请求把两条结果按 id 放行
  const [bashResponse, readResponse] = await Promise.all([bashPending, readPending])
  const bashOut = toolContent(bashResponse)
  const readOut = toolContent(readResponse)

  const finalText = `两个工具都执行完了：\n- bash: ${bashOut}\n- read: ${readOut}`
  const head = '两个工具都执行完了：\n'
  emit({ type: 'message.updated', properties: { info: { id: 'm2', role: 'assistant', sessionID } } })
  // 用 delta 演示真流式：先一段，再一段
  emit({
    type: 'message.part.delta',
    properties: { sessionID, messageID: 'm2', partID: 'p2', field: 'text', delta: head },
  })
  emit({
    type: 'message.part.delta',
    properties: { sessionID, messageID: 'm2', partID: 'p2', field: 'text', delta: finalText.slice(head.length) },
  })
  emit({
    type: 'message.part.updated',
    properties: { part: { id: 'p2', sessionID, messageID: 'm2', type: 'text', text: finalText } },
  })
  emit({
    type: 'message.updated',
    properties: { info: { id: 'm2', role: 'assistant', sessionID, tokens: { input: 20, output: 10, total: 30 } } },
  })
  emit({ type: 'session.status', properties: { sessionID, status: { type: 'idle' } } })
}

/**
 * 并发的标题生成请求：没有工具，但和主会话读同一条全局 /event。
 * 它必须只等自己的 idle，绝不能把主会话挂起的 MCP 调用抢走。
 */
async function runTitleScenario(sessionID) {
  const started = Date.now()
  while (bridge.stats.called < 2 && Date.now() - started < 3000) await sleep(10)
  const title = '标题：并发测试'
  emit({ type: 'message.updated', properties: { info: { id: 'title-m1', role: 'assistant', sessionID } } })
  emit({
    type: 'message.part.updated',
    properties: { part: { id: 'title-p1', sessionID, messageID: 'title-m1', type: 'text', text: title } },
  })
  emit({ type: 'session.status', properties: { sessionID, status: { type: 'idle' } } })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8') || '{}'))
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')

  if (req.method === 'GET' && url.pathname === '/event') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.write(': connected\n\n')
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }

  if (req.method === 'POST' && url.pathname === '/session') {
    const id = `sess-demo-${++sessionSeq}`
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id }))
    return
  }

  if (req.method === 'POST' && /^\/session\/[^/]+\/prompt_async$/.test(url.pathname)) {
    const sessionID = url.pathname.split('/')[2]
    let payload = {}
    try { payload = JSON.parse(await readBody(req)) } catch { /* 非 JSON */ }
    const promptText = String(payload?.parts?.[0]?.text ?? '')
    res.writeHead(204)
    res.end()
    const scenario = promptText.includes('生成标题') ? runTitleScenario : runKernelScenario
    scenario(sessionID).catch((error) => {
      emit({
        type: 'session.error',
        properties: { sessionID, error: { name: 'DemoError', data: { message: String(error?.message ?? error) } } },
      })
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/mcp') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
    return
  }

  if (req.method === 'GET' && url.pathname === '/experimental/tool/ids') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(['bash', 'read', 'dsh_bash', 'dsh_read']))
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('not found')
})

/** 先把 MCP 握手做掉（真实内核挂载后也会 initialize） */
async function initializeBridge() {
  await fetch(bridge.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }),
  })
}

/** 假 DSH：执行工具调用，返回 OpenAI 的 role:"tool" 消息 */
async function runDshTools(toolCalls) {
  const results = []
  for (const call of toolCalls) {
    const name = call.function.name
    const args = JSON.parse(call.function.arguments || '{}')
    let content
    if (name === 'bash') {
      // 不经过 shell，避免任何注入面
      const script = `process.stdout.write(${JSON.stringify(String(args.command ?? ''))})`
      const { stdout } = await execFileAsync(process.execPath, ['-e', script], { timeout: 5000 })
      content = stdout
    } else if (name === 'read') {
      content = fs.readFileSync(args.path, 'utf8')
    } else {
      throw new Error(`未知工具：${name}`)
    }
    results.push({ role: 'tool', tool_call_id: call.id, name, content })
  }
  return results
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`

  const kernel = {
    base,
    scope: 'demo',
    authHeaders: () => ({}),
    request: async (method, apiPath, body) => {
      const res = await fetch(base + apiPath, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      let json = null
      try { json = text === '' ? null : JSON.parse(text) } catch { /* 非 JSON */ }
      return { status: res.status, json, text }
    },
  }

  bridge = await createMcpBridge()
  await initializeBridge()
  transport = createKernelTransport({ kernel, bridge })

  const messages = [{ role: 'user', content: '并行执行两个工具' }]
  const mainPromise = transport.chat({ model: 'demo-model', user: 'demo-conv', messages, tools: TOOLS })
  // 主会话挂起工具调用期间，标题生成也在读同一条全局 /event。
  // 旧实现里它会抢走主会话的调用；这里把它作为并发回归一起跑。
  await sleep(20)
  const titlePromise = transport.chat({
    model: 'demo-model',
    user: 'demo-title',
    messages: [{ role: 'user', content: '生成标题' }],
  })

  const first = await mainPromise
  assert.equal(first.status, 200)
  assert.equal(first.json.choices[0].finish_reason, 'tool_calls', '第一轮应该把工具调用交给 DSH')
  const toolCalls = first.json.choices[0].message.tool_calls
  assert.equal(toolCalls.length, 2, '应该拿到两个并行工具调用')
  console.log(`① 内核要工具：${toolCalls.map((c) => c.function.name).join(' + ')}`)

  const titleResult = await titlePromise
  assert.equal(titleResult.status, 200)
  assert.equal(titleResult.json.choices[0].finish_reason, 'stop', '标题请求不应拿到工具调用')
  assert.equal(titleResult.json.choices[0].message.content, '标题：并发测试')
  assert.equal(titleResult.json.choices[0].message.tool_calls, undefined, '标题请求不能抢走主会话的调用')
  console.log('①.5 并发标题完成：没有抢走主会话的调用')

  const toolMessages = await runDshTools(toolCalls)
  console.log(`② DSH 执行完：${toolMessages.map((m) => `${m.name}=${m.content.trim()}`).join(' / ')}`)

  const second = await transport.chat({
    model: 'demo-model',
    user: 'demo-conv',
    messages: [
      ...messages,
      { role: 'assistant', content: null, tool_calls: toolCalls },
      ...toolMessages,
    ],
  })

  assert.equal(second.status, 200)
  const answer = second.json.choices[0].message.content
  assert.match(answer, /DEMO-BASH-OK/, '最终回答应包含 bash 输出')
  assert.match(answer, /DEMO-READ-OK/, '最终回答应包含 read 输出')
  // 回归：以前两条结果会被拼在一起广播，bash 里会看到 read 的内容
  const bashLine = answer.split('\n').find((line) => line.includes('bash')) ?? ''
  const readLine = answer.split('\n').find((line) => line.includes('read')) ?? ''
  assert.ok(!bashLine.includes('DEMO-READ-OK'), 'bash 结果不应串入 read 的输出')
  assert.ok(!readLine.includes('DEMO-BASH-OK'), 'read 结果不应串入 bash 的输出')

  console.log(`③ 内核续跑完成：${JSON.stringify(answer)}`)
  console.log('④ 闭环校验：tool_call_id 逐条回填，无串味')
  console.log('\n完整工作流 · 绿')
}

const watchdog = setTimeout(() => {
  console.error('完整工作流 · 红：30 秒内没有跑完（可能又被并发请求抢走了调用）')
  process.exit(1)
}, 30_000)
try {
  await main()
} catch (error) {
  console.error('完整工作流 · 红：', error?.message ?? error)
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  try { transport?.close?.() } catch { /* ignore */ }
  try { await bridge?.close?.() } catch { /* ignore */ }
  for (const res of clients) {
    try { res.end() } catch { /* ignore */ }
  }
  clients.clear()
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
