/**
 * kernel 传输层测试。
 *
 * 不启动真内核、不发任何上游请求：用假的 kernel 对象 + 假的 fetch 验证
 * 协议映射是否正确（这是我们最容易写错、又最难在真机上复现的部分）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPermission, KERNEL_TOOLS, sealAuthState, resolveKernelBinary,
  SessionStore, conversationKey, planTurn, contentToText, usageOf,
  createKernelTransport, kernelErrorResult, materializeImages, normalizeUpstreamFailure,
} from '../lib/kernel.js'

// ---------------------------------------------------------------- 纯函数

test('buildPermission: 默认全部 deny（kernel 不替 DSH 执行工具）', () => {
  const p = buildPermission()
  for (const tool of KERNEL_TOOLS) assert.equal(p[tool], 'deny', `${tool} 应被拒绝`)
  assert.equal(p.websearch, 'deny')
  assert.equal(p.image_read, 'deny')
})

test('buildPermission: 白名单内的才 allow', () => {
  const p = buildPermission(['bash', 'read'])
  assert.equal(p.bash, 'allow')
  assert.equal(p.read, 'allow')
  assert.equal(p.write, 'deny')
})

test('sealAuthState: 产出 v1 信封，字段齐全且可带 key 解回', async () => {
  const key = 'test-session-key'
  const sealed = sealAuthState({ token: 'abc', deviceId: 'd1' }, key)
  assert.equal(sealed.version, 'v1')
  for (const field of ['iv', 'tag', 'ciphertext']) {
    assert.equal(typeof sealed[field], 'string')
    assert.ok(sealed[field].length > 0)
  }

  const crypto = await import('node:crypto')
  const k = crypto.createHash('sha256').update(key).digest()
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(sealed.iv, 'base64url'))
  d.setAuthTag(Buffer.from(sealed.tag, 'base64url'))
  const plain = Buffer.concat([d.update(Buffer.from(sealed.ciphertext, 'base64url')), d.final()]).toString('utf8')
  assert.deepEqual(JSON.parse(plain), { token: 'abc', deviceId: 'd1' })
})

test('resolveKernelBinary: 指向 desktop 的 super-agent-code', () => {
  const bin = resolveKernelBinary('/Users/x')
  // Windows 版内核是 TeleAgent.exe，macOS 版没有扩展名
  const expected = process.platform === 'win32'
    ? /runtimes[\\/]super-agent-code[\\/]bin[\\/]TeleAgent\.exe$/
    : /runtimes\/super-agent-code\/bin\/TeleAgent$/
  assert.match(bin, expected)
})

test('contentToText: 兼容 string 与数组内容', () => {
  assert.equal(contentToText('hi'), 'hi')
  assert.equal(contentToText([{ type: 'text', text: 'a' }, { type: 'image_url' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(contentToText(null), '')
})

test('conversationKey: 显式标识优先，否则用首条用户消息', () => {
  assert.equal(conversationKey({ user: 'u1' }, []), 'u1')
  const a = conversationKey({}, [{ role: 'user', content: 'hello' }])
  const b = conversationKey({}, [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'x' }])
  assert.equal(a, b, '同一会话的多轮应得到同一个 key')
  const c = conversationKey({}, [{ role: 'user', content: 'different' }])
  assert.notEqual(a, c)
})

test('planTurn: 首轮折叠完整历史（system 作为前缀）', () => {
  const { text, seenUserCount } = planTurn(null, [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'A1' },
  ])
  assert.match(text, /^SYS/)
  assert.match(text, /用户：U1/)
  assert.match(text, /助手：A1/)
  assert.equal(seenUserCount, 1, 'seenUserCount 只数用户消息')
})

test('planTurn: 后续只发新增消息（kernel 自己保存历史）', () => {
  const messages = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'U2' },
  ]
  const { text, seenUserCount } = planTurn({ seenUserCount: 1 }, messages)
  assert.equal(text, 'U2', '助手消息不应被重发')
  assert.equal(seenUserCount, 2)
})

test('planTurn: 没有新消息时退化为重发最后一条用户输入', () => {
  const { text } = planTurn({ seenUserCount: 2 }, [
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'U2' },
  ])
  assert.equal(text, 'U2')
})

test('usageOf: 映射 kernel tokens 到 OpenAI usage', () => {
  assert.deepEqual(usageOf({ input: 10, output: 5, total: 15, cache: { read: 3 } }), {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 3 },
  })
  assert.equal(usageOf(undefined).total_tokens, 0)
})

test('SessionStore: TTL 过期后取不到，sweep 会清理', () => {
  const store = new SessionStore({ ttlMs: 10 })
  store.set('k', { sessionID: 's1', seenCount: 1 })
  assert.equal(store.get('k')?.sessionID, 's1')
  const realNow = Date.now
  try {
    // 1) TTL 过期后 get 取不到
    Date.now = () => realNow() + 100
    assert.equal(store.get('k'), undefined)

    // 2) 刚 set 的条目不该被 sweep 清掉
    store.set('k2', { sessionID: 's2' })
    store.sweep()
    assert.equal(store.get('k2')?.sessionID, 's2')

    // 3) 再过一段时间，sweep 才清掉它
    Date.now = () => realNow() + 1000
    store.sweep()
    assert.equal(store.get('k2'), undefined)
  } finally {
    Date.now = realNow
  }
})

test('kernelErrorResult: 上游错误码透出，状态码保留', () => {
  const error = Object.assign(new Error('boom'), {
    status: 401,
    upstream: { data: { code: 40109, message: 'current user is banned' } },
  })
  const r = kernelErrorResult(error, 'chat-pro')
  assert.equal(r.status, 401)
  assert.equal(r.json.error.code, 40109)
  assert.match(r.json.error.message, /banned/)
})

test('normalizeUpstreamFailure: 402/5005 用户额度不足 → insufficient quota', () => {
  const payload = {
    name: 'APIError',
    data: {
      message: 'Payment Required',
      statusCode: 402,
      responseBody: '{"code":5005,"resultMsg":"用户额度不足","resultData":null}',
      responseCode: 5005,
    },
  }
  const f = normalizeUpstreamFailure(payload)
  assert.equal(f.quota, true)
  assert.equal(f.code, 5005)
  assert.match(f.message, /insufficient quota/)
  assert.match(f.message, /用户额度不足/)
  assert.match(f.message, /HTTP 402\/5005/)
})

test('kernelErrorResult: 额度不足映射成 402 且文案可被 isQuotaExceededError 识别', () => {
  const payload = {
    name: 'APIError',
    data: { message: 'Payment Required', statusCode: 402, responseBody: '{"code":5005,"resultMsg":"用户额度不足"}', responseCode: 5005 },
  }
  const r = kernelErrorResult(Object.assign(new Error('x'), { upstream: payload }), 'chat-pro')
  assert.equal(r.json.error.code, 402)
  assert.match(r.json.error.message, /insufficient quota/)
})

test('normalizeUpstreamFailure: 普通错误保留上游 detail', () => {
  const f = normalizeUpstreamFailure({ data: { message: 'Bad Gateway', responseBody: '{"resultMsg":"上游泛化错误"}' } })
  assert.equal(f.quota, false)
  assert.match(f.message, /上游泛化错误/)
})

// ---------------------------------------------------------------- 传输映射

/** 假 kernel：按脚本回放 /event 帧 */
function fakeKernel({ frames, healthStatus = 200 }) {
  const calls = []
  return {
    base: 'http://127.0.0.1:1',
    scope: 'v1_public_test',
    calls,
    authHeaders: () => ({}),
    request: async (method, path, body) => {
      calls.push({ method, path, body })
      if (path === '/global/health') return { status: healthStatus, json: {}, text: '' }
      if (path === '/session') return { status: 200, json: { id: 'sess-1' }, text: '' }
      if (path.endsWith('/prompt_async')) return { status: 204, json: null, text: '' }
      return { status: 404, json: null, text: 'nope' }
    },
    _frames: frames,
  }
}

function installFakeFetch(frames) {
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  return () => { globalThis.fetch = original }
}

const FRAMES = [
  { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant', sessionID: 'sess-1' } } },
  { type: 'message.part.updated', properties: { part: { messageID: 'm1', type: 'text', text: '你' } } },
  { type: 'message.part.updated', properties: { part: { messageID: 'm1', type: 'text', text: '你好' } } },
  { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant', sessionID: 'sess-1', tokens: { input: 7, output: 2, total: 9 } } } },
  { type: 'session.status', properties: { sessionID: 'sess-1', status: { type: 'idle' } } },
]

test('transport.chat: 聚合内核累积文本，返回 OpenAI 结构', async () => {
  const restore = installFakeFetch(FRAMES)
  try {
    const kernel = fakeKernel({ frames: FRAMES })
    const t = createKernelTransport({ kernel })
    const r = await t.chat({ model: 'chat-pro', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(r.status, 200)
    assert.equal(r.json.choices[0].message.content, '你好', '累积文本应被正确聚合，且不重复')
    assert.equal(r.json.usage.total_tokens, 9)
    // 会话只建一次
    assert.equal(kernel.calls.filter((c) => c.path === '/session').length, 1)
    t.close()
  } finally {
    restore()
  }
})

test('transport.chatStream: 产出 OpenAI chunk 流（含 [DONE]）', async () => {
  const restore = installFakeFetch(FRAMES)
  try {
    const kernel = fakeKernel({ frames: FRAMES })
    const t = createKernelTransport({ kernel })
    const res = await t.chatStream({ model: 'chat-pro', messages: [{ role: 'user', content: 'hi' }] })
    const text = await res.text()
    assert.match(res.headers.get('content-type') ?? '', /event-stream/)
    assert.ok(text.includes('"content":"你"'), '应逐字产出增量')
    assert.ok(text.includes('"content":"好"'), '第二个增量应是差量而不是全文')
    assert.ok(text.includes('"finish_reason":"stop"'))
    assert.ok(text.includes('[DONE]'))
    t.close()
  } finally {
    restore()
  }
})

test('transport: 同一会话第二轮只发新增内容（多轮不复述历史）', async () => {
  const restore = installFakeFetch(FRAMES)
  try {
    const kernel = fakeKernel({ frames: FRAMES })
    const t = createKernelTransport({ kernel })
    const msgs1 = [{ role: 'system', content: 'S' }, { role: 'user', content: 'U1' }]
    await t.chat({ model: 'chat-pro', messages: msgs1, user: 'conv-1' })
    await t.chat({
      model: 'chat-pro',
      user: 'conv-1',
      messages: [...msgs1, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'U2' }],
    })
    const prompts = kernel.calls.filter((c) => c.path.endsWith('/prompt_async'))
    assert.equal(prompts.length, 2)
    assert.match(prompts[0].body.parts[0].text, /U1/)
    assert.equal(prompts[1].body.parts[0].text, 'U2', '第二轮不应重发历史')
    assert.equal(kernel.calls.filter((c) => c.path === '/session').length, 1, '同一会话复用 kernel session')
    t.close()
  } finally {
    restore()
  }
})

test('transport: prompt_async 失败时返回可分类的错误而不是抛到 shim', async () => {
  const restore = installFakeFetch([])
  try {
    const kernel = fakeKernel({ frames: [] })
    kernel.request = async (method, path, body) => {
      if (path === '/session') return { status: 200, json: { id: 's1' }, text: '' }
      if (path.endsWith('/prompt_async')) {
        return { status: 401, json: { data: { code: 40109, message: 'current user is banned' } }, text: '' }
      }
      return { status: 200, json: {}, text: '' }
    }
    const t = createKernelTransport({ kernel })
    const r = await t.chat({ model: 'chat-pro', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(r.status, 401)
    assert.equal(r.json.error.code, 40109)
    t.close()
  } finally {
    restore()
  }
})

test('materializeImages: data URL 落盘为可读文件', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-img-'))
  const files = materializeImages([{
    role: 'user',
    content: [
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ],
  }], dir)
  assert.equal(files.length, 1)
  assert.ok(fs.existsSync(files[0].file))
  assert.equal(files[0].mime, 'image/png')
})

test('materializeImages: 非 data URL 与坏数据被忽略', () => {
  const files = materializeImages([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,!!!' } }] },
  ], '/tmp/ta-img-test')
  assert.equal(files.length, 0)
})

// ---------------------------------------------------------------- 内核失联自愈

test('transport: 内核失联时调用 revive 并重试一次（之后正常返回）', async () => {
  const restore = installFakeFetch(FRAMES)
  try {
    let revived = 0
    let calls = 0
    const kernel = {
      base: 'http://127.0.0.1:1',
      scope: 'v1_public_test',
      authHeaders: () => ({}),
      request: async (method, p) => {
        calls++
        // 第一次连内核失败，模拟 "ECONNREFUSED"
        if (revived === 0) {
          const error = new Error('fetch failed')
          error.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
          throw error
        }
        if (p === '/session') return { status: 200, json: { id: 'sess-1' }, text: '' }
        if (p.endsWith('/prompt_async')) return { status: 204, json: null, text: '' }
        return { status: 200, json: {}, text: '' }
      },
    }
    const t = createKernelTransport({
      kernel,
      revive: async () => { revived++; return kernel },
    })
    const r = await t.chat({ model: 'chat-pro', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(revived, 1, '应调用一次 revive')
    assert.equal(r.status, 200, '重试后应成功')
    assert.ok(calls >= 2)
    t.close()
  } finally {
    restore()
  }
})

test('transport: 非连接类错误不触发 revive', async () => {
  const restore = installFakeFetch(FRAMES)
  try {
    let revived = 0
    const kernel = {
      base: 'http://127.0.0.1:1', scope: 'x', authHeaders: () => ({}),
      request: async (method, p) => {
        if (p === '/session') throw new Error('boom: 参数错误')
        return { status: 200, json: {}, text: '' }
      },
    }
    const t = createKernelTransport({ kernel, revive: async () => { revived++; return kernel } })
    const r = await t.chat({ model: 'chat-pro', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(revived, 0, '普通错误不应重启内核')
    assert.equal(r.status, 502)
    t.close()
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------- MCP 工具桥
import { mcpToolId, stripMcpPrefix, callsToOpenAiToolCalls, createMcpBridge } from '../lib/mcp-bridge.js'
import { toMcpTools } from '../lib/mcp-server.js'

test('工具命名：内核加 <server>_ 前缀，能被还原', () => {
  assert.equal(mcpToolId('dsh', 'bash'), 'dsh_bash')
  assert.equal(stripMcpPrefix('dsh_bash', 'dsh'), 'bash')
  assert.equal(stripMcpPrefix('bash', 'dsh'), 'bash', '没有前缀时原样返回')
  // 工具名本身带下划线也要能还原
  assert.equal(stripMcpPrefix('dsh_dsh_echo', 'dsh'), 'dsh_echo')
})

test('toMcpTools: OpenAI function 定义 → MCP 工具定义', () => {
  const tools = toMcpTools([
    { type: 'function', function: { name: 'bash', description: '执行命令', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
  ])
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'bash')
  assert.equal(tools[0].description, '执行命令')
  assert.equal(tools[0].inputSchema.properties.command.type, 'string')
})

test('toMcpTools: 缺 name 的条目被跳过，缺 parameters 用空 schema', () => {
  const tools = toMcpTools([{ function: { description: '无名字' } }, { function: { name: 'x' } }])
  assert.equal(tools.length, 1)
  assert.deepEqual(tools[0].inputSchema, { type: 'object', properties: {} })
})

test('callsToOpenAiToolCalls: 生成合法 tool_calls（参数被 JSON 序列化）', () => {
  const calls = callsToOpenAiToolCalls([{ tool: 'bash', args: { command: 'ls -la' } }])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].type, 'function')
  assert.equal(calls[0].function.name, 'bash')
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { command: 'ls -la' })
  assert.ok(calls[0].id.startsWith('call'))
})

test('bridge: 工具集变化会被识别（用于重新挂载）', async () => {
  const bridge = await createMcpBridge()
  try {
    assert.equal(bridge.setTools([{ function: { name: 'a' } }]), true, '首次设置算变化')
    assert.equal(bridge.setTools([{ function: { name: 'a' } }]), false, '相同集合不算变化')
    assert.equal(bridge.setTools([{ function: { name: 'b' } }]), true, '换了工具算变化')
  } finally {
    await bridge.close()
  }
})

test('bridge: 工具调用被记录且不执行（takeCalls 取完即清空）', async () => {
  const bridge = await createMcpBridge()
  try {
    bridge.setTools([{ function: { name: 'bash', parameters: { type: 'object', properties: {} } } }])
    // 直接打 MCP 协议，模拟内核调用
    const post = (body) => fetch(bridge.url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then((r) => r.json())
    await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
    // 调用会挂起（等 DSH 结果），这里不 await 完成
    const pending = post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_bash', arguments: { command: 'echo hi' } } })
    await new Promise((r) => setTimeout(r, 200))

    assert.equal(bridge.hasCalls(), true)
    const calls = bridge.takeCalls()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].tool, 'bash', '前缀应被剥掉')
    assert.deepEqual(calls[0].args, { command: 'echo hi' })
    assert.equal(bridge.hasCalls(), false, '取完即清空')
    bridge.cancelSuspended('test done')
    await pending
  } finally {
    await bridge.close()
  }
})

// ---------------------------------------------------------------- 工具桥：tool_calls 翻译

/** 假 bridge：可控地返回"被拦截的调用" */
function makeFakeBridge(calls) {
  let pending = calls.slice()
  return {
    setTools: () => false,
    mount: async () => ({ ok: true }),
    waitForRegistration: async (_k, { expected } = {}) => ({ ok: true, tools: Array(expected).fill('dsh_x') }),
    builtinFlags: async () => ({ bash: false }),
    hasCalls: () => pending.length > 0,
    takeCalls: () => { const c = pending; pending = []; return c },
    inspect: async () => [],
  }
}

const TOOL_FRAMES = [
  { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant', sessionID: 'sess-1' } } },
  { type: 'message.part.updated', properties: { part: { messageID: 'm1', type: 'text', text: '我来执行' } } },
  { type: 'session.status', properties: { sessionID: 'sess-1', status: { type: 'idle' } } },
]

test('非流式：桥拦截到调用时返回 tool_calls（finish_reason=tool_calls）', async () => {
  const restore = installFakeFetch(TOOL_FRAMES)
  try {
    const kernel = fakeKernel({ frames: TOOL_FRAMES })
    const bridge = makeFakeBridge([{ tool: 'bash', args: { command: 'ls' } }])
    const t = createKernelTransport({ kernel, bridge })
    const r = await t.chat({
      model: 'chat-pro',
      messages: [{ role: 'user', content: '列目录' }],
      tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: {} } } }],
    })
    assert.equal(r.status, 200)
    const choice = r.json.choices[0]
    assert.equal(choice.finish_reason, 'tool_calls')
    assert.equal(choice.message.content, null)
    assert.equal(choice.message.tool_calls.length, 1)
    assert.equal(choice.message.tool_calls[0].function.name, 'bash')
    assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), { command: 'ls' })
    assert.match(choice.message.tool_calls[0].id, /^call_/)
    t.close()
  } finally {
    restore()
  }
})

test('流式：桥拦截到调用时产出 tool_calls chunk 且以 tool_calls 收尾', async () => {
  const restore = installFakeFetch(TOOL_FRAMES)
  try {
    const kernel = fakeKernel({ frames: TOOL_FRAMES })
    const bridge = makeFakeBridge([{ tool: 'read', args: { path: '/tmp/a' } }])
    const t = createKernelTransport({ kernel, bridge })
    const res = await t.chatStream({
      model: 'chat-pro',
      messages: [{ role: 'user', content: '读文件' }],
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }],
    })
    const text = await res.text()
    assert.ok(text.includes('"tool_calls"'), '应产出 tool_calls')
    assert.ok(text.includes('"finish_reason":"tool_calls"'), 'finish_reason 应为 tool_calls')
    assert.ok(text.includes('[DONE]'))
    assert.ok(text.includes('dsh_') || text.includes('read'), '应含工具名')
    t.close()
  } finally {
    restore()
  }
})

test('无工具请求：不触发工具桥（纯文本路径不受影响）', async () => {
  const restore = installFakeFetch(TOOL_FRAMES)
  try {
    const kernel = fakeKernel({ frames: TOOL_FRAMES })
    let touched = 0
    const bridge = makeFakeBridge([])
    bridge.setTools = () => { touched++; return false }
    const t = createKernelTransport({ kernel, bridge })
    const r = await t.chat({ model: 'chat-pro', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(r.json.choices[0].finish_reason, 'stop')
    assert.equal(r.json.choices[0].message.content, '我来执行')
    assert.equal(touched, 0, '没有 tools 时不应碰桥')
    t.close()
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------- 工具调用闭环

test('bridge: 工具调用被挂起（不立即返回），resolve 后以结果放行', async () => {
  const bridge = await createMcpBridge()
  try {
    bridge.setTools([{ function: { name: 'bash', parameters: { type: 'object', properties: {} } } }])
    const post = (body) => fetch(bridge.url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })

    // 调用会挂起：请求不该立刻结束
    let answered = null
    const pending = post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_bash', arguments: { command: 'echo hi' } } })
      .then((r) => r.json()).then((j) => { answered = j })
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(bridge.hasSuspended(), true, '应该有挂起的调用')
    assert.equal(answered, null, '挂起期间不应返回')

    const resolved = bridge.resolveSuspended('hi')
    assert.equal(resolved, 1)
    await pending
    assert.equal(bridge.hasSuspended(), false)
    assert.ok(answered?.result?.content?.[0]?.text?.includes('hi'), '应把工具结果回给内核')
  } finally {
    await bridge.close()
  }
})

test('bridge: cancelSuspended 会带着错误放行（避免内核永远卡住）', async () => {
  const bridge = await createMcpBridge()
  try {
    bridge.setTools([{ function: { name: 'bash', parameters: { type: 'object', properties: {} } } }])
    const post = (body) => fetch(bridge.url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
    const pending = post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_bash', arguments: {} } })
      .then((r) => r.json())
    await new Promise((r) => setTimeout(r, 200))
    bridge.cancelSuspended('user cancelled')
    const answer = await pending
    assert.ok(answer?.result?.content?.[0]?.text?.includes('cancelled'))
  } finally {
    await bridge.close()
  }
})

test('consumeEvents: 多条消息时取最后一条的文本（续跑的关键）', async () => {
  const frames = [
    { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant', sessionID: 'sess-1' } } },
    { type: 'message.part.updated', properties: { part: { sessionID: 'sess-1', messageID: 'm1', type: 'text', text: '先调工具' } } },
    { type: 'message.updated', properties: { info: { id: 'm2', role: 'assistant', sessionID: 'sess-1' } } },
    { type: 'message.part.updated', properties: { part: { sessionID: 'sess-1', messageID: 'm2', type: 'text', text: '最终' } } },
    { type: 'message.part.updated', properties: { part: { sessionID: 'sess-1', messageID: 'm2', type: 'text', text: '最终答案' } } },
    { type: 'session.status', properties: { sessionID: 'sess-1', status: { type: 'idle' } } },
  ]
  const restore = installFakeFetch(frames)
  try {
    const kernel = { base: 'http://127.0.0.1:1', authHeaders: () => ({}), request: async () => ({ status: 200, json: {}, text: '' }) }
    const { consumeEvents } = await import('../lib/kernel.js')
    const deltas = []
    const result = await consumeEvents({ kernel, sessionID: 'sess-1', onDelta: (d) => deltas.push(d) })
    assert.equal(result.text, '最终答案', '应取最后一条消息的全文')
    assert.deepEqual(deltas, ['先调工具', '最终', '答案'])
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------- 提示词回显（线上事故回归）

/** 内核会把本轮用户消息也作为 message.part.updated 发回来；不能当助手输出 */
const PROMPT_TEXT = 'You are an AI agent powered by DeepSeek Harness.\n\n## 工作区规则\n...\n\n用户：hi'
const ECHO_FRAMES = [
  { type: 'message.updated', properties: { info: { id: 'u1', role: 'user', sessionID: 'sess-1' } } },
  { type: 'message.part.updated', properties: { part: { sessionID: 'sess-1', messageID: 'u1', type: 'text', text: PROMPT_TEXT } } },
  { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant', sessionID: 'sess-1' } } },
  { type: 'message.part.updated', properties: { part: { sessionID: 'sess-1', messageID: 'm1', type: 'text', text: '你好' } } },
  { type: 'message.part.updated', properties: { part: { sessionID: 'sess-1', messageID: 'm1', type: 'text', text: '你好！' } } },
  { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant', sessionID: 'sess-1', tokens: { input: 9, output: 2, total: 11 } } } },
  { type: 'session.status', properties: { sessionID: 'sess-1', status: { type: 'idle' } } },
]

test('consumeEvents: 用户消息的 part 不回显（提示词泄漏回归）', async () => {
  const restore = installFakeFetch(ECHO_FRAMES)
  try {
    const kernel = { base: 'http://127.0.0.1:1', authHeaders: () => ({}), request: async () => ({ status: 200, json: {}, text: '' }) }
    const { consumeEvents } = await import('../lib/kernel.js')
    const deltas = []
    const result = await consumeEvents({ kernel, sessionID: 'sess-1', onDelta: (d) => deltas.push(d) })
    assert.equal(result.text, '你好！')
    assert.deepEqual(deltas, ['你好', '！'])
    assert.ok(!deltas.join('').includes('You are an AI agent'), '不能把提示词当助手输出')
  } finally {
    restore()
  }
})

test('transport.chatStream: 用户消息 part 不会混进回答', async () => {
  const restore = installFakeFetch(ECHO_FRAMES)
  try {
    const kernel = fakeKernel({ frames: ECHO_FRAMES })
    const t = createKernelTransport({ kernel })
    const res = await t.chatStream({ model: 'chat-flagship', messages: [{ role: 'user', content: 'hi' }] })
    const text = await res.text()
    assert.ok(!text.includes('You are an AI agent'), 'SSE 里不能出现提示词')
    assert.ok(text.includes('"content":"你好"'))
    assert.ok(text.includes('"finish_reason":"stop"'))
    t.close()
  } finally {
    restore()
  }
})

test('consumeEvents: 忽略其它会话的 part（/event 是全局流）', async () => {
  const frames = [
    // 另一个会话（比如并发的标题生成）也在发事件
    { type: 'message.updated', properties: { info: { id: 'o1', role: 'assistant', sessionID: 'sess-2' } } },
    { type: 'message.part.updated', properties: { part: { sessionID: 'sess-2', messageID: 'o1', type: 'text', text: '别人会话的答案' } } },
    { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant', sessionID: 'sess-1' } } },
    { type: 'message.part.updated', properties: { part: { sessionID: 'sess-1', messageID: 'm1', type: 'text', text: '我的答案' } } },
    { type: 'session.status', properties: { sessionID: 'sess-2', status: { type: 'idle' } } },
    { type: 'session.status', properties: { sessionID: 'sess-1', status: { type: 'idle' } } },
  ]
  const restore = installFakeFetch(frames)
  try {
    const kernel = { base: 'http://127.0.0.1:1', authHeaders: () => ({}), request: async () => ({ status: 200, json: {}, text: '' }) }
    const { consumeEvents } = await import('../lib/kernel.js')
    const deltas = []
    const result = await consumeEvents({ kernel, sessionID: 'sess-1', onDelta: (d) => deltas.push(d) })
    assert.equal(result.text, '我的答案')
    assert.deepEqual(deltas, ['我的答案'], '不能把别的会话的输出串进来')
  } finally {
    restore()
  }
})

test('consumeEvents: part 先于 message.updated 到达时暂存、角色判明后补发', async () => {
  const frames = [
    { type: 'message.part.updated', properties: { part: { sessionID: 'sess-1', messageID: 'm1', type: 'text', text: '你' } } },
    { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant', sessionID: 'sess-1' } } },
    { type: 'message.part.updated', properties: { part: { sessionID: 'sess-1', messageID: 'm1', type: 'text', text: '你好' } } },
    { type: 'session.status', properties: { sessionID: 'sess-1', status: { type: 'idle' } } },
  ]
  const restore = installFakeFetch(frames)
  try {
    const kernel = { base: 'http://127.0.0.1:1', authHeaders: () => ({}), request: async () => ({ status: 200, json: {}, text: '' }) }
    const { consumeEvents } = await import('../lib/kernel.js')
    const deltas = []
    const result = await consumeEvents({ kernel, sessionID: 'sess-1', onDelta: (d) => deltas.push(d) })
    assert.equal(result.text, '你好')
    assert.deepEqual(deltas, ['你', '好'])
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------- 孤儿内核清理（生命周期）

test('reapStaleKernels: 只清理 ppid=1 的自家内核，并清掉 pidfile', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { reapStaleKernels, kernelPidFile } = await import('../lib/kernel.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-reap-'))
  try {
    fs.writeFileSync(kernelPidFile(dir), JSON.stringify({ pid: 555, port: 1, base: 'http://x' }))
    const killedSignals = []
    const result = await reapStaleKernels({
      home: os.tmpdir(),
      runtimeDir: dir,
      binary: '/apps/super-agent-code/bin/TeleAgent',
      wait: async () => {},
      isAlive: (pid) => [111, 444, 555].includes(pid),
      listProcesses: () => [
        { pid: 111, ppid: 1, command: '/apps/super-agent-code/bin/TeleAgent' }, // 孤儿 → 清
        { pid: 222, ppid: 999, command: '/apps/super-agent-code/bin/TeleAgent' }, // 有爹 → 不动
        { pid: 333, ppid: 1, command: '/apps/other/bin/TeleAgent' }, // 不是自家内核 → 不动
        { pid: 444, ppid: 1, command: '/apps/super-agent-code/bin/TeleAgent --x' }, // 孤儿 → 清
        { pid: 555, ppid: 999, command: '/apps/super-agent-code/bin/TeleAgent' }, // pidfile → 清
      ],
      killProcess: (pid, signal) => killedSignals.push([pid, signal]),
    })
    assert.deepEqual(result.killed.sort((a, b) => a - b), [111, 444, 555])
    assert.ok(killedSignals.some(([pid, sig]) => pid === 111 && sig === 'SIGTERM'))
    assert.ok(!killedSignals.some(([pid]) => pid === 222 || pid === 333), '不能误杀')
    assert.equal(fs.existsSync(kernelPidFile(dir)), false, 'pidfile 应被清掉')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 思维链（reasoning）透传

const REASONING_FRAMES = [
  { type: 'message.updated', properties: { info: { id: 'u1', role: 'user', sessionID: 'sess-1' } } },
  { type: 'message.part.updated', properties: { part: { sessionID: 'sess-1', messageID: 'u1', type: 'text', text: 'PROMPT' } } },
  { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant', sessionID: 'sess-1' } } },
  { type: 'message.part.updated', properties: { part: { id: 'r1', sessionID: 'sess-1', messageID: 'm1', type: 'reasoning', text: '先想' } } },
  { type: 'message.part.updated', properties: { part: { id: 'r1', sessionID: 'sess-1', messageID: 'm1', type: 'reasoning', text: '先想一下' } } },
  { type: 'message.part.updated', properties: { part: { id: 't1', sessionID: 'sess-1', messageID: 'm1', type: 'text', text: '答案是' } } },
  { type: 'message.part.updated', properties: { part: { id: 't1', sessionID: 'sess-1', messageID: 'm1', type: 'text', text: '答案是 42' } } },
  { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant', sessionID: 'sess-1', tokens: { input: 3, output: 4, total: 7 } } } },
  { type: 'session.status', properties: { sessionID: 'sess-1', status: { type: 'idle' } } },
]

test('consumeEvents: reasoning part 转成思维链增量（不再丢弃）', async () => {
  const restore = installFakeFetch(REASONING_FRAMES)
  try {
    const kernel = { base: 'http://127.0.0.1:1', authHeaders: () => ({}), request: async () => ({ status: 200, json: {}, text: '' }) }
    const { consumeEvents } = await import('../lib/kernel.js')
    const reasoning = []
    const text = []
    const result = await consumeEvents({
      kernel, sessionID: 'sess-1',
      onDelta: (d) => text.push(d),
      onReasoningDelta: (d) => reasoning.push(d),
    })
    assert.deepEqual(reasoning, ['先想', '一下'], '思维链应按累积全文转增量')
    assert.deepEqual(text, ['答案是', ' 42'], '正文不受影响')
    assert.equal(result.reasoning, '先想一下')
    assert.equal(result.text, '答案是 42')
  } finally {
    restore()
  }
})

test('transport.chatStream: 思维链以 reasoning_content 下发', async () => {
  const restore = installFakeFetch(REASONING_FRAMES)
  try {
    const kernel = fakeKernel({ frames: REASONING_FRAMES })
    const t = createKernelTransport({ kernel })
    const res = await t.chatStream({ model: 'chat-flagship', messages: [{ role: 'user', content: 'q' }] })
    const body = await res.text()
    assert.ok(body.includes('"reasoning_content":"先想"'), 'SSE 应包含思维链增量')
    assert.ok(body.includes('"reasoning_content":"一下"'), 'SSE 应包含思维链增量')
    assert.ok(body.includes('"content":"答案是"'))
    t.close()
  } finally {
    restore()
  }
})

test('transport.chat: 非流式响应带 reasoning_content', async () => {
  const restore = installFakeFetch(REASONING_FRAMES)
  try {
    const kernel = fakeKernel({ frames: REASONING_FRAMES })
    const t = createKernelTransport({ kernel })
    const r = await t.chat({ model: 'chat-flagship', messages: [{ role: 'user', content: 'q' }] })
    assert.equal(r.json.choices[0].message.reasoning_content, '先想一下')
    assert.equal(r.json.choices[0].message.content, '答案是 42')
    t.close()
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------- 工具调用挂起 / 会话卡死（线上回归）

/** 收完既定 frames 后**不关闭**流：模拟内核在等 MCP 工具结果、不再发事件 */
function installFakeFetchOpen(frames) {
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(f)}\n\n`))
      },
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  return () => { globalThis.fetch = original }
}

test('consumeEvents: 没有新事件时也会轮询工具桥（工具交接不会挂起）', async () => {
  const frames = [
    { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant', sessionID: 'sess-1' } } },
    { type: 'message.part.updated', properties: { part: { sessionID: 'sess-1', messageID: 'm1', type: 'tool', text: '' } } },
  ]
  const restore = installFakeFetchOpen(frames)
  try {
    let hasCall = false
    const flip = setTimeout(() => { hasCall = true }, 120)
    const kernel = { base: 'http://127.0.0.1:1', authHeaders: () => ({}), request: async () => ({ status: 200, json: {}, text: '' }) }
    const { consumeEvents } = await import('../lib/kernel.js')
    const started = Date.now()
    const result = await Promise.race([
      consumeEvents({ kernel, sessionID: 'sess-1', callWatcher: () => hasCall }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('consumeEvents 挂起超过 2 秒')), 2000)),
    ])
    clearTimeout(flip)
    assert.equal(result.interrupted, true, '应该把调用交给 DSH')
    assert.ok(Date.now() - started < 1500, `应该在轮询周期内返回（实际 ${Date.now() - started}ms）`)
  } finally {
    restore()
  }
})

test('consumeEvents: session.error 立刻收尾并抛出内核错误（不再干等 idle）', async () => {
  const frames = [
    { type: 'message.updated', properties: { info: { id: 'u1', role: 'user', sessionID: 'sess-1' } } },
    { type: 'session.error', properties: { sessionID: 'sess-1', error: { name: 'UnknownError', data: { message: 'session is busy' } } } },
  ]
  const restore = installFakeFetch(frames)
  try {
    const kernel = { base: 'http://127.0.0.1:1', authHeaders: () => ({}), request: async () => ({ status: 200, json: {}, text: '' }) }
    const { consumeEvents } = await import('../lib/kernel.js')
    await assert.rejects(
      () => consumeEvents({ kernel, sessionID: 'sess-1' }),
      /session is busy/,
    )
  } finally {
    restore()
  }
})

/** 可复位的假工具桥：控制 hasCalls / hasSuspended，并记录 cancel/resolve */
function makeLoopBridge({ startWithCall = true } = {}) {
  let pending = startWithCall ? [{ tool: 'bash', args: { command: 'ls' } }] : []
  let suspended = true
  const stats = { cancelled: 0, resolved: [] }
  return {
    stats,
    setTools: () => false,
    mount: async () => ({ ok: true }),
    waitForRegistration: async () => ({ ok: true, tools: [] }),
    builtinFlags: async () => ({}),
    hasCalls: () => pending.length > 0,
    takeCalls: () => { const p = pending; pending = []; return p },
    hasSuspended: () => suspended,
    resolveSuspended: (text) => { suspended = false; stats.resolved.push(text); return 1 },
    cancelSuspended: () => { suspended = false; stats.cancelled += 1; return 1 },
  }
}

test('transport: 续跑请求里没有工具结果时，放弃旧会话并重开（避免 session is busy）', async () => {
  const restore = installFakeFetch(FRAMES)
  try {
    const kernel = fakeKernel({ frames: FRAMES })
    const bridge = makeLoopBridge()
    const t = createKernelTransport({ kernel, bridge })
    const msgs1 = [{ role: 'system', content: 'S' }, { role: 'user', content: 'U1' }]
    const r1 = await t.chat({ model: 'chat-pro', messages: msgs1, user: 'conv-loop' })
    assert.equal(r1.json.choices[0].finish_reason, 'tool_calls')
    // 模拟"工具结果没送到"：同一个会话又来了一条普通用户消息
    const r2 = await t.chat({
      model: 'chat-pro',
      user: 'conv-loop',
      messages: [...msgs1, { role: 'user', content: 'U2' }],
    })
    assert.equal(r2.status, 200)
    assert.ok(bridge.stats.cancelled >= 1, '应该取消挂起的工具调用')
    const prompts = kernel.calls.filter((c) => c.path.endsWith('/prompt_async'))
    assert.equal(prompts.length, 2, '应该真的发了新一轮 prompt')
    assert.match(prompts[1].body.parts[0].text, /U1/, '新会话应折叠完整历史，而不是只发 U2')
    assert.match(prompts[1].body.parts[0].text, /U2/)
    assert.ok(kernel.calls.some((c) => c.path.endsWith('/abort')), '应该 abort 旧内核会话')
    assert.equal(kernel.calls.filter((c) => c.path === '/session').length, 2, '应该新开一个内核会话')
    t.close()
  } finally {
    restore()
  }
})

test('transport: 流式失败时取消挂起的工具调用并 abort 内核会话', async () => {
  const frames = [
    { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant', sessionID: 'sess-1' } } },
    { type: 'message.part.updated', properties: { part: { sessionID: 'sess-1', messageID: 'm1', type: 'tool', text: '' } } },
    { type: 'session.error', properties: { sessionID: 'sess-1', error: { name: 'UnknownError', data: { message: 'boom' } } } },
  ]
  const restore = installFakeFetch(frames)
  try {
    const kernel = fakeKernel({ frames })
    const bridge = makeLoopBridge({ startWithCall: false })
    const t = createKernelTransport({ kernel, bridge })
    const res = await t.chatStream({ model: 'chat-pro', messages: [{ role: 'user', content: 'hi' }] })
    const text = await res.text()
    assert.ok(text.includes('"error"'), 'SSE 里应该有错误块')
    assert.ok(bridge.stats.cancelled >= 1, '应该取消挂起的工具调用')
    assert.ok(kernel.calls.some((c) => c.path.endsWith('/abort')), '应该 abort 内核会话')
    t.close()
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------- 工具桥缺失时的降级

test('transport: bridge 为 null 时不崩，正常走纯文本（回归）', async () => {
  const restore = installFakeFetch(FRAMES)
  try {
    const kernel = fakeKernel({ frames: FRAMES })
    // 宿主在工具桥创建失败时会传 null
    const t = createKernelTransport({ kernel, bridge: null })
    const r = await t.chat({
      model: 'chat-pro',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: {} } } }],
    })
    assert.equal(r.status, 200, 'bridge 为 null 也必须能正常回答')
    assert.equal(r.json.choices[0].message.content, '你好')
    t.close()
  } finally {
    restore()
  }
})

test('transport: bridge 为 null 且流式时同样正常', async () => {
  const restore = installFakeFetch(FRAMES)
  try {
    const kernel = fakeKernel({ frames: FRAMES })
    const t = createKernelTransport({ kernel, bridge: null })
    const res = await t.chatStream({
      model: 'chat-pro',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: {} } } }],
    })
    const text = await res.text()
    assert.ok(text.includes('"content":"你"'))
    assert.ok(text.includes('[DONE]'))
    t.close()
  } finally {
    restore()
  }
})

test('transport: bridge 抛错时降级为纯文本而不是整条失败', async () => {
  const restore = installFakeFetch(FRAMES)
  try {
    const broken = {
      setTools() { throw new Error('bridge exploded') },
      mount: async () => ({ ok: false }),
      hasCalls: () => false,
      takeCalls: () => [],
    }
    const kernel = fakeKernel({ frames: FRAMES })
    const t = createKernelTransport({ kernel, bridge: broken })
    const r = await t.chat({
      model: 'chat-pro',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: {} } } }],
    })
    assert.equal(r.status, 200, '桥坏了也要能回答')
    assert.equal(r.json.choices[0].message.content, '你好')
    t.close()
  } finally {
    restore()
  }
})

test('transport: getBridge 延迟取桥（创建时桥还不存在）', async () => {
  const restore = installFakeFetch(FRAMES)
  try {
    let bridge = null // 创建 transport 时桥还没建出来
    const kernel = fakeKernel({ frames: FRAMES })
    const t = createKernelTransport({ kernel, getBridge: () => bridge })

    // 第一次请求：桥为空 → 走纯文本，不崩
    const r1 = await t.chat({
      model: 'chat-pro',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
    })
    assert.equal(r1.status, 200, '桥还没建好时不应崩')

    // 稍后桥建好 → 同一 transport 应该能用上
    let mounted = 0
    bridge = {
      setTools: () => true,
      mount: async () => { mounted++; return { ok: true } },
      waitForRegistration: async () => ({ ok: true, tools: [] }),
      builtinFlags: async () => ({ bash: false }),
      hasCalls: () => false,
      takeCalls: () => [],
      hasSuspended: () => false,
    }
    const r2 = await t.chat({
      model: 'chat-pro',
      messages: [{ role: 'user', content: 'hello2' }],
      tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
    })
    assert.equal(r2.status, 200)
    assert.equal(mounted, 1, '桥建好后应被挂载（说明 getter 生效）')
    t.close()
  } finally {
    restore()
  }
})
