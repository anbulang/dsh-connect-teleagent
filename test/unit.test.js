/**
 * 核心纯函数单元测试。
 *
 * 运行：npm test
 * 覆盖：模型清单、状态文档、签名算法。
 * 不依赖 TeleAgent 运行、不联网。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { MODELS, VISION_MODEL_IDS, appPaths, currentScope } from '../lib/models.js'
import { buildStatus } from '../lib/status.js'
import * as upstreamModule from '../lib/upstream.js'
import { computeSignature, buildAuthHeaders, TELEAI_SIGNED_PATH } from '../lib/upstream.js'
import { TELEAI_API_KEY } from '../lib/secrets.js'

// ------------------------------------------------------------ MODELS
test('MODELS: 五个模型定义完整且 id 唯一', () => {
  assert.equal(MODELS.length, 5)
  const ids = MODELS.map((m) => m.id)
  assert.equal(new Set(ids).size, 5)
  for (const m of MODELS) {
    assert.ok(m.name && m.id)
    assert.ok(m.contextWindow > 0 && m.maxTokens > 0)
    assert.match(m.creditMultiplier, /^\d+\.\d+$/)
  }
})

test('MODELS: 包含预期模型 id', () => {
  const ids = MODELS.map((m) => m.id)
  for (const want of ['chat-pro', 'chat-flagship', 'chat-flash', 'chat-lite', 'chat-nano']) {
    assert.ok(ids.includes(want), `缺少 ${want}`)
  }
})

// ------------------------------------------------------------ 路径
test('appPaths: 指向 TeleAgent 默认 XDG 目录', () => {
  const home = path.join('home', 'u')
  const p = appPaths(home, { env: {} })
  assert.equal(p.data, path.join(home, '.local', 'share', 'TeleAgent'))
  assert.equal(p.config, path.join(home, '.config', 'TeleAgent'))
})

test('currentScope: 无登录信息时抛错', () => {
  assert.throws(() => currentScope('/nonexistent/definitely/not/here'))
})

// ------------------------------------------------------------ buildStatus
test('buildStatus: 未提供勾选时默认全部启用', () => {
  const s = buildStatus({ upstream: { ready: true }, enabledModelIds: undefined })
  assert.equal(s.models.length, MODELS.length)
  assert.ok(s.models.every((m) => m.enabled === true))
})

test('buildStatus: 勾选列表决定 enabled 标记', () => {
  const s = buildStatus({ upstream: { ready: true }, enabledModelIds: ['chat-pro'] })
  const enabled = s.models.filter((m) => m.enabled).map((m) => m.id)
  assert.deepEqual(enabled, ['chat-pro'])
})

test('buildStatus: 模型条目携带上下文与倍率', () => {
  const s = buildStatus({ upstream: { ready: true }, enabledModelIds: undefined })
  const pro = s.models.find((m) => m.id === 'chat-pro')
  assert.equal(pro.contextWindow, 400000)
  assert.equal(pro.maxTokens, 65536)
  assert.equal(pro.creditMultiplier, '0.6')
})

test('buildStatus: 透传 upstream 诊断', () => {
  const ok = buildStatus({ upstream: { ready: true, baseUrl: 'http://x' } })
  assert.equal(ok.upstream.ready, true)
  const bad = buildStatus({ upstream: { ready: false, error: 'boom', remedy: 'do x' } })
  assert.equal(bad.upstream.ready, false)
  assert.equal(bad.upstream.remedy, 'do x')
})

test('buildStatus: 支持 upstream 为函数（惰性求值）', () => {
  let calls = 0
  const s = buildStatus({ upstream: () => { calls++; return { ready: true } } })
  assert.equal(calls, 1)
  assert.equal(s.upstream.ready, true)
})

test('buildStatus: 状态文档绝不包含 token 原文', () => {
  const s = buildStatus({ upstream: { ready: true }, enabledModelIds: undefined })
  const dump = JSON.stringify(s)
  assert.doesNotMatch(dump, /eyJ[A-Za-z0-9_-]{10,}/, '不应出现 JWT')
  assert.doesNotMatch(dump, /\bv10[A-Za-z0-9+/=]{20,}/, '不应出现 safeStorage 密文')
})

// ------------------------------------------------------------ 签名算法
const FIXED = {
  token: 'I7Kp2X:aaa.bbb.ccc',
  installId: 'inst-1234',
  appVersion: '2.7.1',
  method: 'POST',
  pathname: '/superCowork/sapi/api/v1/chat/completions',
  ts: '1700000000',
  nonce: 'nonce-abc',
  body: '{"model":"chat-flash"}',
}

test('computeSignature: 确定性（相同输入相同输出）', () => {
  const a = computeSignature(FIXED)
  const b = computeSignature(FIXED)
  assert.equal(a.signature, b.signature)
  assert.equal(a.k1, b.k1)
})

test('computeSignature: 输出为 64 位十六进制', () => {
  const { signature, k1 } = computeSignature(FIXED)
  assert.match(signature, /^[0-9a-f]{64}$/)
  assert.match(k1, /^[0-9a-f]{64}$/)
})

test('computeSignature: body 变化导致签名变化', () => {
  const a = computeSignature(FIXED)
  const b = computeSignature({ ...FIXED, body: '{"model":"chat-pro"}' })
  assert.notEqual(a.signature, b.signature)
})

test('computeSignature: nonce 变化导致签名变化', () => {
  const a = computeSignature(FIXED)
  const b = computeSignature({ ...FIXED, nonce: 'other' })
  assert.notEqual(a.signature, b.signature)
})

test('computeSignature: timestamp 变化导致签名变化', () => {
  const a = computeSignature(FIXED)
  const b = computeSignature({ ...FIXED, ts: '1700000001' })
  assert.notEqual(a.signature, b.signature)
})

test('computeSignature: pathname 变化导致签名变化（路径参与签名）', () => {
  const a = computeSignature(FIXED)
  const b = computeSignature({ ...FIXED, pathname: '/superCowork/sapi/api/v1/other' })
  assert.notEqual(a.signature, b.signature)
})

test('computeSignature: 第一层 key 来自 JWT 第三段', () => {
  const base = computeSignature(FIXED)
  const changed = computeSignature({ ...FIXED, token: 'I7Kp2X:aaa.bbb.zzz' })
  assert.notEqual(base.k1, changed.k1)
})

// ------------------------------------------------------------ 请求头
// buildAuthHeaders(auth, opts) 分两段：auth 是凭据，opts 是本次请求参数
const AUTH = { token: FIXED.token, installId: FIXED.installId, appVersion: FIXED.appVersion,
  deviceId: 'dev-1', accountName: 'tester' }
const OPTS = { body: FIXED.body, method: FIXED.method, pathname: FIXED.pathname, ts: FIXED.ts, nonce: FIXED.nonce }

test('buildAuthHeaders: 生成完整的 TeleAgent 签名头', () => {
  const h = buildAuthHeaders(AUTH, OPTS)
  for (const key of [
    'Authorization', 'X-Token', 'X-App-Version', 'X-Route-Target',
    'X-Superagent-Device-Id', 'X-Superagent-Install-Id',
    'X-Superagent-Timestamp', 'X-Superagent-Nonce',
    'X-Superagent-Sign-Version', 'X-Superagent-Signature',
  ]) {
    assert.ok(h[key] !== undefined, `缺少头 ${key}`)
  }
  assert.equal(h['X-Superagent-Sign-Version'], 'v1')
  assert.match(h['X-Superagent-Signature'], /^[0-9a-f]{64}$/)
  assert.equal(h.Authorization, `Bearer ${TELEAI_API_KEY}`)
  assert.match(h.Authorization, /^Bearer /)
  assert.equal(h['X-Token'], FIXED.token)
})

test('buildAuthHeaders: 注入的 ts/nonce 被采用', () => {
  const h = buildAuthHeaders(AUTH, OPTS)
  assert.equal(h['X-Superagent-Timestamp'], FIXED.ts)
  assert.equal(h['X-Superagent-Nonce'], FIXED.nonce)
})

test('buildAuthHeaders: 自动生成 ts/nonce 时仍是合法签名', () => {
  const h = buildAuthHeaders(AUTH, { body: FIXED.body })
  assert.match(h['X-Superagent-Timestamp'], /^\d{10}$/)
  assert.match(h['X-Superagent-Nonce'], /^[0-9a-f-]{36}$/)
  assert.match(h['X-Superagent-Signature'], /^[0-9a-f]{64}$/)
})

test('buildAuthHeaders: 签名路径常量包含 /superCowork/sapi 前缀', () => {
  assert.equal(TELEAI_SIGNED_PATH, '/superCowork/sapi/api/v1/chat/completions')
})

// ------------------------------------------------------------ 凭据指纹
test('authFingerprint: 无凭据时返回 none', () => {
  const { authFingerprint } = upstreamModule
  // 使用不存在的 HOME 模拟未登录
  assert.equal(authFingerprint('/nonexistent/definitely/not/here'), 'none')
})

test('authFingerprint: 凭据存在时随文件变化而改变', async () => {
  const { authFingerprint } = upstreamModule
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-fp-'))
  const authDir = path.join(home, '.local', 'share', 'TeleAgent', 'users', 'v1_public_1', 'app-auth')
  fs.mkdirSync(authDir, { recursive: true })
  fs.writeFileSync(path.join(home, '.local', 'share', 'TeleAgent', 'current-owner.json'),
    JSON.stringify({ ownerDir: 'v1_public_1' }))
  const tokenFile = path.join(authDir, 'token.json')
  fs.writeFileSync(tokenFile, JSON.stringify({ encryptedToken: 'AAAAAAAA' }))

  const first = authFingerprint(home)
  assert.match(first, /^v1_public_1:/)

  // 重写文件（模拟重新登录）后指纹必须变化
  await new Promise((r) => setTimeout(r, 10))
  fs.writeFileSync(tokenFile, JSON.stringify({ encryptedToken: 'BBBBBBBBBB' }))
  const second = authFingerprint(home)
  assert.notEqual(first, second, '凭据变化必须反映在指纹上')
})

// ------------------------------------------------------------ 多账号切换
test('currentScope: 多个账号时选 token.json 最新的', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-scope-'))
  const users = path.join(data, 'users')
  const mk = (name, content) => {
    const dir = path.join(users, name, 'app-auth')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'token.json'), content)
  }
  mk('old_account', '{"encryptedToken":"AAAA"}')
  await new Promise((r) => setTimeout(r, 20))
  mk('new_account', '{"encryptedToken":"BBBBBBBB"}')

  // 没有 current-owner.json 时，应挑最新的那个
  assert.equal(currentScope(data), 'new_account')
})

test('currentScope: current-owner.json 优先于目录扫描', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-scope2-'))
  const users = path.join(data, 'users')
  const mk = (name) => {
    const dir = path.join(users, name, 'app-auth')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'token.json'), '{"encryptedToken":"XX"}')
  }
  mk('explicit_account')
  await new Promise((r) => setTimeout(r, 20))
  mk('newer_account')
  fs.writeFileSync(path.join(data, 'current-owner.json'), JSON.stringify({ ownerDir: 'explicit_account' }))

  assert.equal(currentScope(data), 'explicit_account')
})

// ------------------------------------------------------------ SSE 聚合
test('aggregateSse: 拼接正文与推理', () => {
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"你","reasoning_content":"想"}}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"好","reasoning_content":"一下"}}]}',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]',
  ].join('\n')
  const out = upstreamModule.aggregateSse(sse)
  assert.equal(out.choices[0].message.content, '你好')
  assert.equal(out.choices[0].message.reasoning_content, '想一下')
  assert.equal(out.choices[0].finish_reason, 'stop')
})

test('aggregateSse: 跨块拼接 tool_calls 参数', () => {
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"bash","arguments":"{\\"cmd\\":"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]},"finish_reason":"tool_calls"}]}',
  ].join('\n')
  const out = upstreamModule.aggregateSse(sse)
  const tc = out.choices[0].message.tool_calls[0]
  assert.equal(tc.id, 'c1')
  assert.equal(tc.function.name, 'bash')
  assert.equal(tc.function.arguments, '{"cmd":"ls"}')
  assert.equal(out.choices[0].finish_reason, 'tool_calls')
})

test('aggregateSse: 保留 usage，忽略 [DONE] 与坏行', () => {
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"content":"x"}}]}',
    'data: not-json',
    'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":1}}',
    'data: [DONE]',
  ].join('\n')
  const out = upstreamModule.aggregateSse(sse)
  assert.equal(out.usage.prompt_tokens, 7)
  assert.equal(out.choices[0].message.content, 'x')
})

test('aggregateSse: 空输入不抛错', () => {
  assert.doesNotThrow(() => upstreamModule.aggregateSse(''))
  const out = upstreamModule.aggregateSse('')
  assert.equal(out.choices[0].message.content, '')
})

test('buildAuthHeaders: 与官方客户端一样发送 Connection/Cache-Control', () => {
  const h = buildAuthHeaders({ token: 'T:a.b.c', installId: 'i', appVersion: '2.7.1', deviceId: 'd' }, { body: '{}' })
  assert.equal(h.Connection, 'keep-alive')
  assert.equal(h['Cache-Control'], 'no-cache')
  assert.equal(h['X-Session-Id'], h['X-Teleai-Root-Session-Id'])
})

// ------------------------------------------------------------ 视觉能力（实测结论）
test('VISION_MODEL_IDS: 只有实测通过的 chat-pro / chat-flash', () => {
  assert.deepEqual([...VISION_MODEL_IDS].sort(), ['chat-flash', 'chat-pro'])
})

test('MODELS: 每个模型都有明确的 vision 布尔值（不允许 undefined）', () => {
  for (const m of MODELS) {
    assert.equal(typeof m.vision, 'boolean', `${m.id} 缺少 vision 声明`)
  }
})

test('MODELS: 不支持视觉的模型明确为 false', () => {
  for (const id of ['chat-flagship', 'chat-lite', 'chat-nano']) {
    const m = MODELS.find((x) => x.id === id)
    assert.equal(m.vision, false, `${id} 不应声明视觉能力`)
  }
})

// ------------------------------------------------------------ 探针门禁（防再次封号）
test('probeUpstream: 默认拒绝发聊天请求（两个账号曾因探测被封）', async () => {
  const fakeAuth = { token: 'T:a.b.c', installId: 'i', appVersion: '2.7.1', deviceId: 'd' }
  const r = await upstreamModule.probeUpstream(fakeAuth)
  assert.equal(r.ok, false)
  assert.equal(r.skipped, true, '默认应跳过而不是发请求')
  assert.equal(r.status, 0, '不应产生任何 HTTP 状态')
  assert.match(r.reason, /默认禁用|合成探测/)
})

test('probeUpstream: 门禁不受凭据内容影响（假凭据也直接跳过）', async () => {
  const r = await upstreamModule.probeUpstream({ token: 'x', installId: 'y', appVersion: 'z', deviceId: 'w' })
  assert.equal(r.skipped, true)
})

// ------------------------------------------------------------ 只读工具
test('teleagent_points: 注册契约正确（名称/参数/输出 schema）', async () => {
  const tools = await import('../lib/tools.js')
  let captured = null
  const dispose = tools.mountPointsTool({ register: (def) => { captured = def; return () => {} } })
  assert.equal(captured.name, 'teleagent_points')
  assert.equal(captured.parameters.type, 'object')
  assert.equal(captured.output.schema.type, 'object')
  assert.equal(typeof captured.execute, 'function')
  assert.equal(typeof dispose, 'function')
})

test('teleagent_points: 描述里写明只读（不消耗积分/不触发领取）', async () => {
  const tools = await import('../lib/tools.js')
  let captured = null
  tools.mountPointsTool({ register: (def) => { captured = def; return () => {} } })
  assert.match(captured.description, /只读/)
  assert.match(captured.description, /不消耗积分/)
})

test('teleagent_points: 无 tools 服务时安全降级', async () => {
  const tools = await import('../lib/tools.js')
  assert.doesNotThrow(() => tools.mountPointsTool(undefined))
  assert.doesNotThrow(() => tools.mountPointsTool({}))
})

test('teleagent_points: 未登录返回可读错误而不是抛错', async () => {
  const tools = await import('../lib/tools.js')
  const snap = await tools.readPointsSnapshot({
    readPortalAuth: () => null,
  })
  assert.equal(snap.ok, false)
  assert.match(snap.error, /未登录/)
})

test('teleagent_points: 注入假 portal 时返回结构化数据', async () => {
  const tools = await import('../lib/tools.js')
  const snap = await tools.readPointsSnapshot({
    readPortalAuth: () => ({ userId: 'u' }),
    fetchPoints: async () => ({ ok: true, balance: 123.45, expiresAt: '2026-10-31 23:59:59' }),
    fetchDailyStatus: async () => ({ ok: true, claimedToday: false, claimable: 100, totalDays: 2, totalPoints: 200 }),
    fetchUserCenter: async () => ({ ok: true, planName: '免费版' }),
  })
  assert.equal(snap.ok, true)
  assert.equal(snap.balance, 123.45)
  assert.equal(snap.claimedToday, false)
  assert.equal(snap.planName, '免费版')
  const text = tools.renderPoints(snap)[0].text
  assert.match(text, /123\.45/)
  assert.match(text, /今日可领/)
})

// ------------------------------------------------------------ 工具白名单优先级（PR12-r1）

test('pickToolsAllowlist: store 有值压过 config（设置卡片保存的值必须生效）', async () => {
  const { pickToolsAllowlist } = await import('../lib/index.js')
  // 设置卡片写的是 store；config 是 profile 里写死的。卡片保存后必须听 store。
  assert.deepEqual(pickToolsAllowlist({ store: ['web_*'], config: ['bash', 'read'] }), ['web_*'])
  // 卡片"恢复全量"写 null → 也必须生效，回落到 config
  assert.deepEqual(pickToolsAllowlist({ store: null, config: ['bash', 'read'] }), ['bash', 'read'])
  // 两边都没写 → 全发
  assert.equal(pickToolsAllowlist({ store: null, config: null }), null)
  assert.equal(pickToolsAllowlist({}), null)
  // 非数组（例如手写坏了）当作没配置
  assert.deepEqual(pickToolsAllowlist({ store: 'oops', config: ['bash'] }), ['bash'])
})

test('pickToolsAllowlist: 空数组是有效值（= 全发），不会被当成"没配置"', async () => {
  const { pickToolsAllowlist } = await import('../lib/index.js')
  assert.deepEqual(pickToolsAllowlist({ store: [], config: ['bash'] }), [], '空数组即用户显式选择全发')
})

// ------------------------------------------------------------ 工具桥挂载状态（PR7-r3）
//
// 背景：mcp-bridge 的 mount() 失败时只 return { ok: false } 而不抛异常。
// 旧代码用 `try { await mount() } catch {}` 判断"桥就绪"，挂载失败时桥对象照样存在
// → 状态卡片不再告警，而模型实际上一个 DSH 工具都调不到。

const silentLogger = { info() {}, warn() {} }

/** 只会拒绝 POST /mcp 的假内核 */
function brokenKernel(message = 'POST /mcp 500') {
  return { base: 'http://127.0.0.1:1', async request() { throw new Error(message) } }
}

/** 接受任意请求的假内核 */
function healthyKernel() {
  return {
    base: 'http://127.0.0.1:2',
    calls: [],
    async request(method, path, body) {
      this.calls.push({ method, path, body })
      return { status: 200, text: '{}' }
    },
  }
}

test('bridge.mount: 成功时 mountedKernel 指向该内核', async () => {
  const { createMcpBridge } = await import('../lib/mcp-bridge.js')
  const bridge = await createMcpBridge({ logger: silentLogger })
  try {
    const kernel = healthyKernel()
    assert.equal(bridge.mountedKernel(), null, '创建后还没挂载')
    const result = await bridge.mount(kernel)
    assert.equal(result.ok, true)
    assert.equal(bridge.mountedKernel(), kernel)
  } finally {
    await bridge.close()
  }
})

test('bridge.mount: 失败时返回 ok:false 且 mountedKernel 为 null（不抛异常）', async () => {
  const { createMcpBridge } = await import('../lib/mcp-bridge.js')
  const bridge = await createMcpBridge({ logger: silentLogger })
  try {
    // 不抛错是刻意的契约：transport 据此把本轮降级为纯文本
    const result = await bridge.mount(brokenKernel())
    assert.equal(result.ok, false)
    assert.match(result.error, /POST \/mcp 500/)
    assert.equal(bridge.mountedKernel(), null, '挂载失败不能声称已挂载')
  } finally {
    await bridge.close()
  }
})

test('bridge.mount: 重挂失败后状态回到 null（旧挂载不再可信）', async () => {
  const { createMcpBridge } = await import('../lib/mcp-bridge.js')
  const bridge = await createMcpBridge({ logger: silentLogger })
  try {
    const good = healthyKernel()
    assert.equal((await bridge.mount(good)).ok, true)
    assert.equal(bridge.mountedKernel(), good)
    const result = await bridge.mount(brokenKernel('socket hang up'), { force: true })
    assert.equal(result.ok, false)
    assert.equal(bridge.mountedKernel(), null, '重挂失败后不能继续声称已挂载')
  } finally {
    await bridge.close()
  }
})

test('bridge.close: 关闭后 mountedKernel 归零（重启窗口不能误判为就绪）', async () => {
  const { createMcpBridge } = await import('../lib/mcp-bridge.js')
  const bridge = await createMcpBridge({ logger: silentLogger })
  const kernel = healthyKernel()
  await bridge.mount(kernel)
  assert.equal(bridge.mountedKernel(), kernel)
  await bridge.close()
  assert.equal(bridge.mountedKernel(), null)
})

test('bridge.mount: 同一内核重复挂载走 alreadyMounted 快路径', async () => {
  const { createMcpBridge } = await import('../lib/mcp-bridge.js')
  const bridge = await createMcpBridge({ logger: silentLogger })
  try {
    const kernel = healthyKernel()
    await bridge.mount(kernel)
    const again = await bridge.mount(kernel)
    assert.equal(again.ok, true)
    assert.equal(again.alreadyMounted, true)
    assert.equal(kernel.calls.length, 1, '第二次不应该再发 POST /mcp')
  } finally {
    await bridge.close()
  }
})

// ------------------------------------------------------------ 告警判据（PR7-r3）

test('isBridgeMounted: 只有挂到当前内核才算就绪（建好≠挂上）', async () => {
  const { isBridgeMounted } = await import('../lib/index.js')
  const kernelA = { base: 'a' }
  const kernelB = { base: 'b' }
  // 建好了但没挂上（mount 返回 ok:false 时正是这个状态）
  assert.equal(isBridgeMounted({ mountedKernel: () => null }, kernelA), false)
  // 挂在别的内核上（重启前后换了句柄）
  assert.equal(isBridgeMounted({ mountedKernel: () => kernelB }, kernelA), false)
  // 正常就绪
  assert.equal(isBridgeMounted({ mountedKernel: () => kernelA }, kernelA), true)
  // 空值/异常一律当"未就绪"，绝不能误报就绪（误报会抑制告警）
  assert.equal(isBridgeMounted(null, kernelA), false)
  assert.equal(isBridgeMounted({ mountedKernel: () => kernelA }, null), false)
  assert.equal(isBridgeMounted({}, kernelA), false)
  assert.equal(isBridgeMounted({ mountedKernel() { throw new Error('boom') } }, kernelA), false)
})
