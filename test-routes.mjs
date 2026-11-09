/**
 * 路由层测试：不依赖 DSH，用真实 http server 模拟 webServer 注册，
 * 验证 status / models 两个接口的鉴权、读写、错误处理。
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerStatusRoutes } from './lib/status.js'
import { readStore, saveEnabledModels, writeStore } from './lib/store.js'

const report = []
const ok = (n, c, d='') => report.push({ n, c, d })

// 隔离的 HOME，避免污染真实设置
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-routes-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = path.join(home, '.dsh')
delete process.env.TELEAI_TA_DEVICE_DATA_DIR
delete process.env.TELEAGENT_CONFIG_DIR

const routes = new Map()
const webServer = {
  register({ path: p, handler }) {
    routes.set(p, handler)
    return () => routes.delete(p)
  },
}

let disposed = false
const state = {
  ensureFreshCalls: 0,
  accounts: [
    { scope: 'v1_public_A', isCurrent: true, hasToken: true, state: 'ok', accountName: 'A' },
    { scope: 'v1_public_B', isCurrent: false, hasToken: true, state: 'ok', accountName: 'B' },
  ],
  appRunning: false,
  welfare: { configured: true, balance: 1234.56, canClaimToday: true, autoClaimDaily: true, daily: { ok: true, claimable: 100, claimedToday: false, totalDays: 1, totalPoints: 100, error: null } }, enabledModelIds: [], upstream: { ready: true, baseUrl: 'https://agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions', accountName: 'tester' } }
disposed = registerStatusRoutes({
  webServer,
  deps: () => ({
    upstream: () => state.upstream,
    welfareSnapshot: () => state.welfare,
    welfareEnsureFresh: async () => { state.ensureFreshCalls++; return state.welfare },
    refreshWelfare: async () => state.welfare,
    claimWelfare: async () => ({ ok: true, claimed: true, points: 100 }),
    setAutoClaimDaily: (enabled) => { state.welfare = { ...state.welfare, autoClaimDaily: enabled } },
    enabledModelIds: state.enabledModelIds,
    provider: () => ({ disabled: state.providerDisabled === true }),
    capabilities: () => ({ deleteAccount: true }),
    transport: () => ({
      mode: state.transportMode ?? 'kernel',
      ready: true,
      kernel: { base: 'http://127.0.0.1:47823', pid: 123 },
      error: null,
      warning: (state.transportMode ?? 'kernel') === 'kernel' ? 'kernel 模式不支持 DSH 工具调用' : null,
    }),
    allowChatProbe: state.allowChatProbe === true,
    // 注入登录流程：真实实现会 open -a TeleAgent，测试不能弹用户的应用
    startLoginFlow: () => { state.loginStarts = (state.loginStarts ?? 0) + 1; return { ok: true, running: true, message: 'test stub' } },
    toolsAllowlist: () => state.toolsAllowlist ?? null,
    setToolsAllowlist: (value) => { state.toolsAllowlist = Array.isArray(value) ? value : null; writeStore({ toolsAllowlist: state.toolsAllowlist }, home); return true },
    runLoginFlow: async () => ({ ok: true, test: true }),
    // 添加账号流程：同样全部 stub，不唤起真实应用
    startAddAccountFlow: (options) => {
      state.addStarts = (state.addStarts ?? 0) + 1
      state.addTimeout = options?.timeoutMs ?? null
      state.addAccount = { running: true, startedAt: Date.now(), result: null }
      return { ok: true, running: true, message: '已唤起 TeleAgent：请在应用里「设置 → 账号 → 退出登录」，再用另一个账号登录', hint: 'test hint' }
    },
    runAddAccountFlow: async () => ({ ok: true, code: 'added', added: { scope: 'v1_public_C' } }),
    cancelAddAccountFlow: () => {
      state.addCancels = (state.addCancels ?? 0) + 1
      return { ok: true, running: true, message: 'test cancel' }
    },
    getAddAccountState: () => state.addAccount ?? { running: false, startedAt: null, result: null },
    listAccounts: () => state.accounts,
    accountPoints: async (scopes) => scopes.map((scope) => ({ ok: true, scope, balance: 100 })),
    appRunning: state.appRunning === true,
    deleteAccount: ({ scope, mode, dryRun }) => {
      if (state.appRunning === true) return { ok: false, deleted: false, reason: 'TeleAgent 桌面端正在运行' }
      if (dryRun) return { ok: true, dryRun: true, deleted: false, plan: { mode, scope, willRemove: ['x'] } }
      state.accounts = state.accounts.filter((a) => a.scope !== scope)
      return { ok: true, deleted: true, plan: { mode, scope } }
    },
    switchAccount: ({ scope, dryRun }) => (state.appRunning === true
      ? { ok: false, changed: false, reason: 'TeleAgent 桌面端正在运行' }
      : { ok: true, changed: dryRun !== true, dryRun: dryRun === true, account: { scope } }),
    probeModel: async (model) => ({ ok: true, model, status: 200, elapsedMs: 12 }),
    setProviderDisabled: (disabled) => { state.providerDisabled = disabled === true },
    saveEnabledModelIds: async (ids) => { state.enabledModelIds = saveEnabledModels(ids, home).enabledModelIds },
  }),
  warn: () => {},
})

const server = http.createServer((req, res) => {
  // 真实宿主按路径匹配，query 不参与路由；这里保持一致
  const pathOnly = String(req.url ?? '').split('?')[0]
  const h = routes.get(pathOnly) ?? routes.get(req.url)
  if (!h) { res.writeHead(404); return res.end('no route') }
  h(req, res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

// 1. status
const s1 = await fetch(base + '/plugins/dsh-connect-teleagent/status')
const j1 = await s1.json()
ok('status 返回 200', s1.status === 200, 'status=' + s1.status)
ok('status 含 upstream 信息', j1.upstream?.ready === true, JSON.stringify(j1.upstream).slice(0,80))
ok('status 含 5 个模型', j1.models?.length === 5)
ok('status 含传输方式', j1.transport?.mode === 'kernel', JSON.stringify(j1.transport ?? {}).slice(0, 80))
ok('kernel 模式带能力警示', /工具调用/.test(j1.transport?.warning ?? ''), String(j1.transport?.warning ?? '').slice(0, 40))
ok('status 含能力集', j1.capabilities?.deleteAccount === true, JSON.stringify(j1.capabilities ?? {}))
ok('status 声明多账号登录能力', j1.capabilities?.addAccount === true, JSON.stringify(j1.capabilities ?? {}))
ok('status 带 canAddAccount 标记', typeof j1.account?.canAddAccount === 'boolean', String(j1.account?.canAddAccount))
ok('status 不含 token', !/eyJ[A-Za-z0-9_-]{10,}/.test(JSON.stringify(j1)))

// 2. 方法限制
const s2 = await fetch(base + '/plugins/dsh-connect-teleagent/status', { method: 'POST' })
ok('status 拒绝 POST', s2.status === 405, 'status=' + s2.status)

// 3. models 保存
const s3 = await fetch(base + '/plugins/dsh-connect-teleagent/models', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ enabledModelIds: ['chat-pro', 'chat-flash'] }),
})
const j3 = await s3.json()
ok('models 保存成功', s3.status === 200 && j3.ok === true, JSON.stringify(j3))
ok('models 落盘', JSON.stringify(readStore(home).enabledModelIds) === '["chat-pro","chat-flash"]', JSON.stringify(readStore(home).enabledModelIds))

// 4. 保存后 status 反映新勾选
const s4 = await fetch(base + '/plugins/dsh-connect-teleagent/status')
const j4 = await s4.json()
const enabledIds = j4.models.filter((m) => m.enabled).map((m) => m.id)
ok('status 反映勾选', JSON.stringify(enabledIds) === '["chat-pro","chat-flash"]', JSON.stringify(enabledIds))

// 5. 非法输入被过滤
await fetch(base + '/plugins/dsh-connect-teleagent/models', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ enabledModelIds: ['chat-pro', 123, '', null] }),
})
ok('非法输入过滤', JSON.stringify(readStore(home).enabledModelIds) === '["chat-pro"]', JSON.stringify(readStore(home).enabledModelIds))

// 6.0 工具白名单
const t0 = await fetch(base + '/plugins/dsh-connect-teleagent/status')
const jt0 = await t0.json()
ok('status 含 toolsAllowlist 字段', Object.prototype.hasOwnProperty.call(jt0, 'toolsAllowlist'), JSON.stringify(jt0.toolsAllowlist))

const t1 = await fetch(base + '/plugins/dsh-connect-teleagent/tools', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ toolsAllowlist: ['bash', 'read', ' web_* ', 123, ''] }),
})
const jt1 = await t1.json()
ok('tools 保存成功', t1.status === 200 && jt1.ok === true, JSON.stringify(jt1))
ok('tools 过滤非法项并落盘', JSON.stringify(readStore(home).toolsAllowlist) === '["bash","read","web_*"]', JSON.stringify(readStore(home).toolsAllowlist))

const t2 = await fetch(base + '/plugins/dsh-connect-teleagent/status')
const jt2 = await t2.json()
ok('status 反映白名单', JSON.stringify(jt2.toolsAllowlist) === '["bash","read","web_*"]', JSON.stringify(jt2.toolsAllowlist))

const t3 = await fetch(base + '/plugins/dsh-connect-teleagent/tools', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toolsAllowlist: null }),
})
const jt3 = await t3.json()
ok('tools 可恢复全量', t3.status === 200 && jt3.toolsAllowlist === null && readStore(home).toolsAllowlist === null, JSON.stringify(jt3))

const t4 = await fetch(base + '/plugins/dsh-connect-teleagent/tools', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toolsAllowlist: 'bash' }),
})
ok('tools 拒绝非数组', t4.status === 400, 'status=' + t4.status)
const t5 = await fetch(base + '/plugins/dsh-connect-teleagent/tools')
ok('tools 拒绝 GET', t5.status === 405, 'status=' + t5.status)

// 6. 登录路由
const s6 = await fetch(base + '/plugins/dsh-connect-teleagent/login', { method: 'POST' })
const j6 = await s6.json()
ok('login 路由可达', s6.status === 200 && j6.ok === true, JSON.stringify(j6).slice(0, 90))
ok('login 使用注入流程（不会真的唤起 TeleAgent）', state.loginStarts === 1, 'starts=' + state.loginStarts)

const s7 = await fetch(base + '/plugins/dsh-connect-teleagent/login')
ok('login 拒绝 GET', s7.status === 405, 'status=' + s7.status)

// 6.1 多账号登录入口（添加账号）
const add0 = await fetch(base + '/plugins/dsh-connect-teleagent/login?mode=add')
const jadd0 = await add0.json()
ok('add-account 进度可读', add0.status === 200 && jadd0.running === false, JSON.stringify(jadd0).slice(0, 80))

const add1 = await fetch(base + '/plugins/dsh-connect-teleagent/login', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'add' }),
})
const jadd1 = await add1.json()
ok('add-account 启动', add1.status === 200 && jadd1.ok === true && state.addStarts === 1, JSON.stringify(jadd1).slice(0, 90))
ok('add-account 启动提示换号步骤', /退出登录/.test(jadd1.message ?? ''), String(jadd1.message ?? '').slice(0, 60))

const add2 = await fetch(base + '/plugins/dsh-connect-teleagent/login?mode=add')
const jadd2 = await add2.json()
ok('add-account 进度反映 running', jadd2.running === true, JSON.stringify(jadd2).slice(0, 60))

const add3 = await fetch(base + '/plugins/dsh-connect-teleagent/login', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'add', action: 'cancel' }),
})
const jadd3 = await add3.json()
ok('add-account 取消', add3.status === 200 && jadd3.ok === true && state.addCancels === 1, JSON.stringify(jadd3).slice(0, 80))

state.addAccount = { running: false, startedAt: Date.now(), result: null }
const add4 = await fetch(base + '/plugins/dsh-connect-teleagent/login', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'add', wait: true }),
})
const jadd4 = await add4.json()
ok('add-account wait=true 同步返回结果', add4.status === 200 && jadd4.code === 'added', JSON.stringify(jadd4).slice(0, 90))
state.addAccount = { running: false, startedAt: null, result: null }
// 注意：不能真调 POST /logout —— 它会退出桌面端并删除真实凭据。
// 这里只验证路由存在且拒绝非 POST。
// 福利接口（GET 快照 / POST 领取 / POST 开关）
// 多账号
const a1 = await fetch(base + '/plugins/dsh-connect-teleagent/accounts?points=1')
const ja1 = await a1.json()
ok('accounts 列表', a1.status === 200 && ja1.accounts.length === 2, `count=${ja1.accounts?.length}`)
ok('accounts 带逐账号积分', ja1.accounts.every((a) => a.points?.ok === true), '每行都应有积分')
ok('accounts 标记当前账号', ja1.current === 'v1_public_A', ja1.current)

const a2 = await fetch(base + '/plugins/dsh-connect-teleagent/accounts', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ scope: 'v1_public_B', dryRun: true }),
})
const ja2 = await a2.json()
ok('accounts dry-run', a2.status === 200 && ja2.dryRun === true && ja2.changed === false, JSON.stringify(ja2).slice(0, 80))

state.appRunning = true
const a3 = await fetch(base + '/plugins/dsh-connect-teleagent/accounts', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ scope: 'v1_public_B' }),
})
const ja3 = await a3.json()
ok('accounts 运行中拒绝切换', a3.status === 409 && /桌面端正在运行/.test(ja3.reason ?? ''), `status=${a3.status}`)
state.appRunning = false

// 未知 action 必须明确报错（不能静默当成"切换账号"，那会给出误导性的 token 错误）
const ua = await fetch(base + '/plugins/dsh-connect-teleagent/accounts', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'bogus', scope: 'v1_public_B' }),
})
const jua = await ua.json()
ok('accounts 拒绝未知 action', ua.status === 400 && /未知操作/.test(jua.error ?? ''), `status=${ua.status} ${jua.error ?? ''}`)

// 删除账号：dry-run 不改数据 / 真删后列表变短 / 运行中拒绝
const d1 = await fetch(base + '/plugins/dsh-connect-teleagent/accounts', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'delete', scope: 'v1_public_B', mode: 'purge', dryRun: true }),
})
const jd1 = await d1.json()
ok('accounts 删除 dry-run', d1.status === 200 && jd1.dryRun === true && jd1.deleted === false, JSON.stringify(jd1).slice(0, 80))

const d2 = await fetch(base + '/plugins/dsh-connect-teleagent/accounts', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'delete', scope: 'v1_public_B', mode: 'purge' }),
})
const jd2 = await d2.json()
ok('accounts 删除账号', d2.status === 200 && jd2.deleted === true && state.accounts.length === 1, `count=${state.accounts.length}`)

const d3 = await fetch(base + '/plugins/dsh-connect-teleagent/accounts')
const jd3 = await d3.json()
ok('accounts 删除后列表变短', jd3.accounts.length === 1, `count=${jd3.accounts.length}`)
ok('accounts 列表带 canDelete 标记', typeof jd3.accounts[0].canDelete === 'boolean', String(jd3.accounts[0].canDelete))

state.appRunning = true
const d4 = await fetch(base + '/plugins/dsh-connect-teleagent/accounts', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'delete', scope: 'v1_public_A' }),
})
ok('accounts 运行中拒绝删除', d4.status === 409, `status=${d4.status}`)
state.appRunning = false

// 聊天探测门禁：默认必须拒绝
const pr1 = await fetch(base + '/plugins/dsh-connect-teleagent/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
const jpr1 = await pr1.json()
ok('probe 默认拒绝', pr1.status === 403 && jpr1.code === 'probe_disabled', `status=${pr1.status} code=${jpr1.code}`)

// 开启后才允许
state.allowChatProbe = true
const pr2 = await fetch(base + '/plugins/dsh-connect-teleagent/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'chat-pro' }) })
const jpr2 = await pr2.json()
ok('probe 开启后可用', pr2.status === 200 && jpr2.model === 'chat-pro', JSON.stringify(jpr2).slice(0, 80))
state.allowChatProbe = false

// 供应商总开关
const p1 = await fetch(base + '/plugins/dsh-connect-teleagent/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerDisabled: true }) })
const jp1 = await p1.json()
ok('provider 停用开关', p1.status === 200 && state.providerDisabled === true && jp1.provider?.disabled === true, JSON.stringify(jp1).slice(0, 90))

const p2 = await fetch(base + '/plugins/dsh-connect-teleagent/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerDisabled: false }) })
ok('provider 恢复开关', p2.status === 200 && state.providerDisabled === false, `disabled=${state.providerDisabled}`)

// 回归：GET 不带 refresh 也必须走"确保新鲜"路径，否则余额永远停在旧值
const callBefore = state.ensureFreshCalls
const w0 = await fetch(base + '/plugins/dsh-connect-teleagent/welfare')
ok('welfare GET 走 ensureFresh', w0.status === 200 && state.ensureFreshCalls === callBefore + 1, `calls=${state.ensureFreshCalls}`)

const w1 = await fetch(base + '/plugins/dsh-connect-teleagent/welfare')
const jw1 = await w1.json()
ok('welfare 快照可读', w1.status === 200 && jw1.balance === 1234.56, JSON.stringify(jw1).slice(0, 90))

const w2 = await fetch(base + '/plugins/dsh-connect-teleagent/welfare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'claim' }) })
const jw2 = await w2.json()
ok('welfare 手动领取', w2.status === 200 && jw2.claimed === true, JSON.stringify(jw2).slice(0, 90))

const w3 = await fetch(base + '/plugins/dsh-connect-teleagent/welfare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'auto', enabled: false }) })
const jw3 = await w3.json()
ok('welfare 自动领取开关', w3.status === 200 && state.welfare?.autoClaimDaily === false, JSON.stringify(jw3).slice(0, 90))

const s8 = await fetch(base + '/plugins/dsh-connect-teleagent/logout')
ok('logout 路由存在且拒绝 GET', s8.status === 405, 'status=' + s8.status)


// 7. 清理
disposed()
ok('路由可注销', routes.size === 0, '剩余路由=' + routes.size)

server.close()

console.log('\n路由测试')
console.log('─'.repeat(56))
for (const x of report) console.log(`  ${x.c?'✓':'✗'} ${x.n.padEnd(20)} ${x.d}`)
const failed = report.filter(x=>!x.c)
console.log('─'.repeat(56))
console.log(failed.length ? `  ${failed.length} 项失败` : '  全部通过')
process.exit(failed.length?1:0)
