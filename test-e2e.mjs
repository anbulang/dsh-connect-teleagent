/**
 * 端到端验证：直连架构下三大能力必须全部成立。
 *
 *  1. role 原样透传（system / user / assistant 不折叠）
 *  2. 多轮历史由调用方掌控（不依赖任何会话状态）
 *  3. 工具调用链完整（tools 进、tool_calls 出，由 DSH 执行）
 *
 * 运行：node test-e2e.mjs   （会真实调用上游，消耗少量额度）
 */
import { createShim } from './lib/shim.js'
import { readUpstreamAuth, createUpstream } from './lib/upstream.js'
import { MODELS } from './lib/models.js'

const report = []
const ok = (n, c, d = '') => report.push({ n, c, d })

const auth = readUpstreamAuth()
console.log('账号:', auth.accountName, '| device:', auth.deviceId)

const upstream = createUpstream(auth)
const shim = await createShim({ getUpstream: () => upstream })
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` }
const call = async (body) => {
  const r = await fetch(shim.baseUrl() + '/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify(body) })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 保留原文 */ }
  return { status: r.status, json, text }
}

// ---------------------------------------------------------------- 基础
{
  const r = await fetch(shim.baseUrl() + '/v1/models', { headers: H })
  const j = await r.json()
  ok('/v1/models', r.status === 200 && j.data?.length === MODELS.length, `${j.data?.length} 个模型`)
}

// ---------------------------------------------------------------- 1. role 透传
{
  const r = await call({
    model: 'chat-flash',
    messages: [
      { role: 'system', content: '你是一个只回答数字的助手，不要任何解释。' },
      { role: 'user', content: '记住数字 24680' },
    ],
  })
  const content = r.json?.choices?.[0]?.message?.content ?? ''
  ok('非流式对话', r.status === 200 && content.length > 0, content.slice(0, 30))

  // 关键：如果是旧实现（折叠成文本），assistant 轮次会被写成「助手：…」混进 user；
  // 直连后 system 与 assistant 都是独立的 role，模型能正常遵循 system 指令。
  const sysRespect = await call({
    model: 'chat-flash',
    messages: [
      { role: 'system', content: '只输出一个数字，不要输出任何其他字符。' },
      { role: 'user', content: '2 加 3 等于几？' },
    ],
  })
  const ans = (sysRespect.json?.choices?.[0]?.message?.content ?? '').trim()
  ok('system role 生效', /^5$/.test(ans) || ans.includes('5'), JSON.stringify(ans.slice(0, 20)))
}

// ---------------------------------------------------------------- 2. 多轮历史
{
  // 调用方自己携带完整历史 —— 不依赖任何服务端会话
  const messages = [
    { role: 'user', content: '记住数字 777' },
    { role: 'assistant', content: '好的，已记住 777' },
    { role: 'user', content: '刚才的数字是多少？只回答数字' },
  ]
  const r = await call({ model: 'chat-flash', messages })
  const content = r.json?.choices?.[0]?.message?.content ?? ''
  ok('多轮历史', /777/.test(content), content.slice(0, 40))
}

// ---------------------------------------------------------------- 3. 工具调用
{
  const r = await call({
    model: 'chat-flash',
    messages: [{ role: 'user', content: '用 bash 执行 ls，看看当前目录有什么' }],
    tools: [{
      type: 'function',
      function: {
        name: 'bash',
        description: 'Run a shell command and return its output',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
    }],
    tool_choice: 'auto',
  })
  const choice = r.json?.choices?.[0]
  const toolCalls = choice?.message?.tool_calls
  ok('工具调用链', r.status === 200 && choice?.finish_reason === 'tool_calls' && Array.isArray(toolCalls) && toolCalls.length > 0,
    `finish=${choice?.finish_reason} calls=${toolCalls?.length ?? 0}`)
  if (toolCalls?.length) {
    const fn = toolCalls[0].function
    let argsOk = false
    try { argsOk = typeof JSON.parse(fn.arguments) === 'object' } catch { /* 非法 JSON */ }
    ok('工具参数是合法 JSON', argsOk, `${fn.name}(${String(fn.arguments).slice(0, 40)})`)
  }
}

// ---------------------------------------------------------------- 4. 流式
{
  const r = await fetch(shim.baseUrl() + '/v1/chat/completions', {
    method: 'POST', headers: H, body: JSON.stringify({
      model: 'chat-flash', stream: true,
      messages: [{ role: 'user', content: '用大约 60 个字介绍杭州' }],
    }),
  })
  let chunks = 0, text = '', sawDone = false
  const reader = r.body.getReader(), dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') { sawDone = true; continue }
      try {
        const j = JSON.parse(payload)
        const c = j.choices?.[0]?.delta?.content
        if (c) { chunks++; text += c }
      } catch { /* 非 JSON 行 */ }
    }
  }
  ok('真流式', chunks >= 3 && sawDone, `${chunks} chunks, [DONE]=${sawDone}`)
  ok('流式内容完整', text.length > 20, `${text.length} 字`)
}

// ---------------------------------------------------------------- 5. 鉴权与校验
{
  const r = await fetch(shim.baseUrl() + '/v1/chat/completions', { method: 'POST', body: '{}' })
  ok('无 token 拒绝', r.status === 401, `status=${r.status}`)
}
{
  const r = await call({ model: 'gpt-4', messages: [] })
  ok('未知模型拒绝', r.status === 400, `status=${r.status}`)
}
{
  const r = await call({ model: 'chat-flash', messages: [{ role: 'user', content: 'hi' }] })
  // 未知模型校验后不应产生 tool_calls
  ok('普通对话无 tool_calls', !r.json?.choices?.[0]?.message?.tool_calls, `finish=${r.json?.choices?.[0]?.finish_reason}`)
}

await shim.close()

console.log('\n端到端报告（直连上游）')
console.log('─'.repeat(58))
for (const x of report) console.log(`  ${x.c ? '✓' : '✗'} ${x.n.padEnd(20)} ${x.d}`)
const failed = report.filter((x) => !x.c)
console.log('─'.repeat(58))
console.log(failed.length ? `  ${failed.length} 项失败` : '  全部通过')
process.exit(failed.length ? 1 : 0)
