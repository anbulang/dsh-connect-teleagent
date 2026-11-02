/**
 * 用「假上游」验证 shim 的两种输出形态，不需要真实网络、不受封禁影响。
 *
 * 覆盖：
 *   - 非流式请求 → 上游收到 stream:true + stream_options，本地聚合结果正确
 *   - 流式请求   → 字节透传，[DONE] 保留
 */
import { createShim } from './lib/shim.js'

const report = []
const ok = (n, c, d = '') => report.push({ n, c, d })

function sseOf(chunks) {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
}

const SSE_TEXT = sseOf([
  { id: 'chatcmpl-x', model: 'chat-flash', created: 1, choices: [{ index: 0, delta: { role: 'assistant', content: '你' } }] },
  { choices: [{ index: 0, delta: { content: '好' } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
])

const SSE_TOOL = sseOf([
  { id: 'c', model: 'chat-flash', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, finish_reason: 'tool_calls' }] },
])

let lastUpstreamBody = null
let nextSse = SSE_TEXT

const fakeUpstream = {
  async chat() { throw new Error('不该走 chat()：上游应恒为流式') },
  async chatStream(body) {
    lastUpstreamBody = body
    return new Response(nextSse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  },
}

const shim = await createShim({ getUpstream: () => fakeUpstream })
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` }
const post = (body) => fetch(shim.baseUrl() + '/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify(body) })

// ---------- 非流式 ----------
{
  nextSse = SSE_TEXT
  const r = await post({ model: 'chat-flash', stream: false, messages: [{ role: 'user', content: 'hi' }] })
  const j = await r.json()
  ok('非流式返回 200', r.status === 200, `status=${r.status}`)
  ok('内容聚合正确', j.choices?.[0]?.message?.content === '你好', JSON.stringify(j.choices?.[0]?.message?.content))
  ok('finish_reason 正确', j.choices?.[0]?.finish_reason === 'stop', j.choices?.[0]?.finish_reason)
  ok('usage 保留', j.usage?.completion_tokens === 2, JSON.stringify(j.usage))
  ok('上游收到 stream:true', lastUpstreamBody?.stream === true, `stream=${lastUpstreamBody?.stream}`)
  ok('上游收到 stream_options', lastUpstreamBody?.stream_options?.include_usage === true, JSON.stringify(lastUpstreamBody?.stream_options))
}

// ---------- 工具调用聚合 ----------
{
  nextSse = SSE_TOOL
  const r = await post({ model: 'chat-flash', stream: false, messages: [{ role: 'user', content: 'ls' }] })
  const j = await r.json()
  const tc = j.choices?.[0]?.message?.tool_calls?.[0]
  ok('工具参数拼接正确', tc?.function?.arguments === '{"command":"ls"}', tc?.function?.arguments)
  ok('工具 finish_reason', j.choices?.[0]?.finish_reason === 'tool_calls', j.choices?.[0]?.finish_reason)
}

// ---------- 图片内容块透传 ----------
{
  nextSse = SSE_TEXT
  const imageBody = {
    model: 'chat-pro', stream: false,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这张图是什么？' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      ],
    }],
  }
  const r = await post(imageBody)
  ok('图片请求返回 200', r.status === 200, `status=${r.status}`)
  const sent = lastUpstreamBody?.messages?.[0]?.content
  const hasImage = Array.isArray(sent) && sent.some((p) => p.type === 'image_url' && p.image_url?.url?.startsWith('data:image/png'))
  ok('图片内容块原样透传', hasImage === true, hasImage ? 'image_url 保留' : JSON.stringify(sent)?.slice(0, 100))
  ok('文本块与图片块并存', Array.isArray(sent) && sent.length === 2 && sent[0].type === 'text', `parts=${Array.isArray(sent) ? sent.length : 'n/a'}`)
}

// ---------- 连接失败重试 ----------
{
  // 第一次抛 ECONNRESET，第二次成功
  let attempts = 0
  const flaky = {
    auth: {}, url: 'x',
    async chat() { throw new Error('不该走 chat()') },
    async chatStream() {
      attempts++
      if (attempts === 1) {
        const inner = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
        throw Object.assign(new TypeError('fetch failed'), { cause: inner })
      }
      return new Response(SSE_TEXT, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    },
  }
  const shim2 = await createShim({ getUpstream: () => flaky })
  const r = await fetch(shim2.baseUrl() + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + shim2.token() },
    body: JSON.stringify({ model: 'chat-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const text = await r.text()
  ok('连接失败后重试成功', r.status === 200 && attempts === 2, `status=${r.status} attempts=${attempts}`)
  ok('重试后流式内容正常', text.includes('"你"') && text.includes('"好"'), `${text.length} 字节`)
  await shim2.close()
}

// ---------- 连接失败且重试也失败 ----------
{
  const dead = {
    auth: {}, url: 'x',
    async chat() { throw new Error('不该走') },
    async chatStream() {
      const inner = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
      throw Object.assign(new TypeError('fetch failed'), { cause: inner })
    },
  }
  const shim3 = await createShim({ getUpstream: () => dead })
  const r = await fetch(shim3.baseUrl() + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + shim3.token() },
    body: JSON.stringify({ model: 'chat-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const j = await r.json()
  ok('重试仍失败返回 502', r.status === 502, `status=${r.status}`)
  ok('错误码可识别', j?.error?.code === 'upstream_connection', JSON.stringify(j?.error?.code))
  ok('错误含底层原因', /ECONNREFUSED/.test(j?.error?.message ?? ''), j?.error?.message?.slice(0, 60))
  await shim3.close()
}

// ---------- 缺失 finish_reason 时补发 ----------
{
  const noFinish = 'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"片段"}}]}\n\n'
  const truncated = {
    auth: {}, url: 'x',
    async chat() { throw new Error('不该走') },
    async chatStream() { return new Response(noFinish, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }) },
  }
  const shim4 = await createShim({ getUpstream: () => truncated })
  const r = await fetch(shim4.baseUrl() + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + shim4.token() },
    body: JSON.stringify({ model: 'chat-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const text = await r.text()
  ok('缺失 finish_reason 时补发 stop', text.includes('"finish_reason":"stop"'), text.slice(-120))
  ok('缺失 [DONE] 时补发', text.includes('[DONE]'))
  await shim4.close()
}

// ---------- 流式透传 ----------
{
  nextSse = SSE_TEXT
  const r = await post({ model: 'chat-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  const text = await r.text()
  ok('流式返回 SSE', (r.headers.get('content-type') ?? '').includes('text/event-stream'), r.headers.get('content-type'))
  ok('流式含 [DONE]', text.includes('[DONE]'))
  ok('流式内容完整', text.includes('你') && text.includes('好'))
}

await shim.close()

console.log('\nshim 形态测试（假上游）')
console.log('─'.repeat(52))
for (const x of report) console.log(`  ${x.c ? '✓' : '✗'} ${x.n.padEnd(18)} ${x.d}`)
const failed = report.filter((x) => !x.c)
console.log('─'.repeat(52))
console.log(failed.length ? `  ${failed.length} 项失败` : '  全部通过')
process.exit(failed.length ? 1 : 0)
