/**
 * MCP 工具桥的本地端到端校验。
 *
 * **不起模型请求**：只做本地握手 —— 拉内核、挂 MCP、查注册表、模拟一次 tools/call。
 * 这样"工具到底有没有进内核"这件事可以反复验证，而不是靠一次性的手工确认。
 *
 * 用法：node test-kernel-mcp.mjs
 *   退出码 0 = 绿；1 = 红
 */
import { startKernel, waitReady, createKernelTransport } from './lib/kernel.js'
import { createMcpBridge, callsToOpenAiToolCalls } from './lib/mcp-bridge.js'

const report = []
const ok = (name, pass, detail = '') => report.push({ name, pass, detail })

// 两个最小可用的 OpenAI 工具定义（形状取自 DSH 真实请求）
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: '执行 shell 命令',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: '要执行的命令' }, timeout: { type: 'number' } },
        required: ['command'],
      },
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

let kernel = null
let bridge = null
try {
  kernel = await startKernel({ port: Number(process.env.TELEAGENT_KERNEL_PORT ?? 47911) })
  await waitReady(kernel, 45_000)
  ok('内核拉起并 health 通过', true, kernel.base)

  bridge = await createMcpBridge({})
  ok('本地 MCP 服务启动', typeof bridge.url === 'string', bridge.url)

  bridge.setTools(TOOLS)
  const mounted = await bridge.mount(kernel, { force: true })
  ok('MCP 挂载到内核', mounted.ok === true, JSON.stringify(mounted))

  // 内核会通过 MCP 的 tools/list 拉取工具；注册是**异步**的，要等
  const waited = await bridge.waitForRegistration(kernel, { expected: 2, timeoutMs: 6000 })
  const registered = waited.tools
  ok('DSH 工具进入内核注册表（等待异步注册）', registered.includes('dsh_bash') && registered.includes('dsh_read'), registered.join(','))
  ok('工具数量正确（2 个）', registered.length === 2, `实际 ${registered.length} 个`)

  const flags = await bridge.builtinFlags(kernel)
  const disabled = Object.entries(flags).filter(([, v]) => v === false).map(([k]) => k)
  ok('内核内置工具被关闭', disabled.length > 0 && !disabled.some((k) => k.startsWith('dsh_')), `关闭 ${disabled.length} 个`)
  ok('内置工具里不含我们的工具', !disabled.includes('dsh_bash'))

  // 模拟一次 MCP tools/call：应当被拦截、不执行，并出现在待取列表里
  const callRes = await fetch(bridge.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'dsh_bash', arguments: { command: 'echo hi' } },
    }),
  })
  const callBody = await callRes.text()
  ok('tools/call 有响应', callRes.status === 200, `HTTP ${callRes.status}`)
  ok('tools/call 返回"已延迟"而不是执行结果', /deferred/.test(callBody), callBody.slice(0, 120))

  const calls = bridge.takeCalls()
  ok('调用被记录', calls.length === 1 && calls[0].tool === 'bash', JSON.stringify(calls))
  ok('参数原样保留', calls[0]?.args?.command === 'echo hi', JSON.stringify(calls[0]?.args))

  const toolCalls = callsToOpenAiToolCalls(calls)
  ok('可翻译成 OpenAI tool_calls', toolCalls[0]?.function?.name === 'bash' && /echo hi/.test(toolCalls[0].function.arguments), JSON.stringify(toolCalls[0]).slice(0, 120))
  ok('takeCalls 后清空', bridge.takeCalls().length === 0)

  // transport 也应能拿到桥（工具开关走 tools 参数传给内核）
  const transport = createKernelTransport({ kernel, bridge })
  ok('transport 接受 bridge', transport?.transport === 'kernel')
  transport.close?.()
} catch (error) {
  ok('整体执行', false, String(error?.message ?? error))
} finally {
  try { await bridge?.close?.() } catch { /* ignore */ }
  try { kernel?.stop?.() } catch { /* ignore */ }
}

console.log('\nMCP 工具桥 · 本地校验（无模型请求）')
console.log('─'.repeat(60))
for (const r of report) console.log(`  ${r.pass ? '✓' : '✗'} ${r.name.padEnd(30)} ${r.detail}`)
const failed = report.filter((r) => !r.pass)
console.log('─'.repeat(60))
console.log(failed.length ? `  红：${failed.length} 项失败` : '  绿：全部通过')
process.exit(failed.length ? 1 : 0)
