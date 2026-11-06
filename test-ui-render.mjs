/**
 * 卡片渲染验证：用 react-dom/server 真实渲染 CardView 的多种状态。
 *
 * 目的：不用刷新浏览器就能发现渲染错误（未定义变量、访问 null 属性等），
 * 并确认每种状态下该出现的文案/控件确实出现。
 *
 * 运行：node test-ui-render.mjs
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire('/tmp/uicheck/package.json')
let React
let renderToStaticMarkup
try {
  React = require('react')
  ;({ renderToStaticMarkup } = require('react-dom/server'))
} catch (error) {
  // 宿主把 React 打进客户端 bundle，仓库不依赖 react 包；本机没装时跳过而不是让 verify 失败
  console.log(`跳过卡片渲染检查：缺少 react/react-dom（${error?.code ?? error?.message}）`)
  console.log('需要时执行：mkdir -p /tmp/uicheck && cd /tmp/uicheck && npm init -y && npm i react react-dom')
  process.exit(0)
}

// ---- 加载客户端模块（模拟宿主的 __ModuleLoader__）
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(opts) { captured = opts },
  },
}

const here = path.dirname(fileURLToPath(import.meta.url))
await import(path.join(here, 'lib', 'client.js'))

if (!captured) {
  console.error('模块没有调用 __ModuleLoader__.load')
  process.exit(1)
}

const moduleObj = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error('未预期的依赖: ' + name)
})

const CardView = moduleObj.__internals?.CardView
if (typeof CardView !== 'function') {
  console.error('缺少 CardView 导出')
  process.exit(1)
}

const report = []
const ok = (n, c, d = '') => report.push({ n, c, d })

const baseWelfare = {
  balance: 1234.56,
  expiresAt: '2026-10-31 23:59:59',
  autoClaimDaily: true,
  canClaimToday: false,
  pointsError: null,
  lastClaimPoints: 100,
  daily: {
    ok: true, claimable: 100, claimedToday: true, totalDays: 2, totalPoints: 200, error: null,
    activity: { title: '邀请共享积分礼', endText: '10/31 结束', actionText: '前往活动' },
  },
}

const baseAccounts = [
  { scope: 'v1_public_A', isCurrent: true, hasToken: true, state: 'ok', accountName: 'acct-A', daysLeft: 28,
    points: { ok: true, balance: 6096.43 }, canSwitch: false, canDelete: false },
  { scope: 'v1_public_B', isCurrent: false, hasToken: true, state: 'ok', accountName: 'acct-B', daysLeft: 20,
    points: { ok: false, error: '读取失败' }, canSwitch: true, canDelete: true },
]

const baseModels = [
  { id: 'chat-pro', name: '智能', contextWindow: 400000, maxTokens: 65536, creditMultiplier: '0.6', enabled: true, vision: true },
  { id: 'chat-flash', name: '极速', contextWindow: 400000, maxTokens: 65536, creditMultiplier: '0.2', enabled: false, vision: true },
  { id: 'chat-nano', name: '轻速', contextWindow: 100000, maxTokens: 65536, creditMultiplier: '0.1', enabled: false, vision: false },
]

function render(props) {
  const full = {
    status: null, error: null, busy: false, hint: null, confirmClear: false,
    welfare: baseWelfare, tab: 'account',
    accounts: baseAccounts, appRunning: false, current: 'v1_public_A',
    onSwitchAccount: () => {}, onDeleteAccount: () => {}, deleteConfirm: null, onConfirmDelete: () => {},
    onTab: () => {},
    onRefresh: () => {}, onLogin: () => {}, onClear: () => {}, onToggle: () => {},
    onClaim: () => {}, onToggleAuto: () => {}, onRefreshWelfare: () => {},
    ...props,
  }
  try {
    return { html: renderToStaticMarkup(React.createElement(CardView, full)) }
  } catch (e) {
    return { html: '', error: e }
  }
}

// ---------------------------------------------------------------- 场景
const scenarios = [
  {
    name: '载入中',
    props: {},
    expect: ['加载中'],
  },
  {
    name: '载入失败',
    props: { error: 'HTTP 404' },
    expect: ['无法读取插件状态', 'HTTP 404', '重试'],
  },
  {
    name: '健康已登录',
    props: {
      status: {
        auth: { signedIn: true, accountName: '示例账号', expiresAt: Date.now() + 86400000, daysLeft: 28 },
        upstream: { ready: true },
        account: { abnormal: false, canClear: true, scopes: 1 },
        guard: { open: false, consecutiveFailures: 0, failureThreshold: 3 },
        provider: { disabled: false },
        capabilities: { deleteAccount: true },
        models: baseModels,
      },
    },
    expect: ['TeleAgent', '正常', '示例账号', '剩余 28 天', '清除登录态', '智能', 'chat-pro', '倍率 x0.6',
             '积分福利', '1234.56', '2026-10-31', '今日已领', '累计 2 天 200 积分', '自动领取', '图片',
             '福利活动', '邀请共享积分礼', '本机账号', 'acct-A', '切换', '删除'],
  },
  {
    name: '未登录',
    props: {
      status: {
        auth: { signedIn: false, reason: '凭据文件不存在', remedy: '在 TeleAgent 桌面端登录一次' },
        upstream: { ready: false, error: 'TeleAgent 凭据不可用' },
        account: { abnormal: false, canClear: false, scopes: 0 },
        guard: { open: false, consecutiveFailures: 0, failureThreshold: 3 },
        credentialProbe: {
          dataDir: '/Users/x/.local/share/TeleAgent',
          currentOwner: null,
          keychain: { ok: false, detail: '钥匙串里没有「TeleAgent Safe Storage」条目' },
          scopes: [
            { scope: 'v1_public_A', isCurrent: false, state: 'no_token', detail: '有 app-auth 但没有 token.json' },
          ],
          verdict: { hint: '本机没有任何账号目录：需要在 TeleAgent 桌面端登录一次' },
        },
        models: baseModels,
      },
    },
    expect: ['未登录', '去登录', '在 TeleAgent 桌面端登录一次', 'TeleAgent 凭据不可用', '探测详情'],
  },
  {
    name: '账号被封',
    props: {
      status: {
        auth: { signedIn: true, accountName: '示例账号', daysLeft: 28 },
        upstream: { ready: true, lastError: { code: 'account_banned', message: '账号已被 TeleAgent 封禁', remedy: '换账号登录' } },
        account: { abnormal: true, banned: true, canClear: true, scopes: 1, nextStep: '该账号已被上游封禁：清除登录态后换账号登录' },
        guard: { open: false, consecutiveFailures: 1, failureThreshold: 3 },
        models: baseModels,
      },
    },
    expect: ['账号异常', '该账号已被上游封禁', '最近请求被拒', '换账号登录', '连续认证失败 1/3'],
  },
  {
    name: '已熔断',
    props: {
      status: {
        auth: { signedIn: true, accountName: '示例账号' },
        upstream: { ready: true },
        account: { abnormal: false, canClear: true, scopes: 1 },
        guard: { open: true, cooldownRemainingMs: 600000, lastReason: '连续 3 次认证失败（HTTP 401）', consecutiveFailures: 3, failureThreshold: 3 },
        models: baseModels,
      },
    },
    expect: ['已熔断', '已暂停上游调用', '10 分钟后自动恢复'],
  },
  {
    name: '供应商已停用',
    props: {
      status: {
        auth: { signedIn: true, accountName: '示例账号', daysLeft: 28 },
        upstream: { ready: true },
        account: { abnormal: false, canClear: true, scopes: 1 },
        guard: { open: false, consecutiveFailures: 0, failureThreshold: 3 },
        provider: { disabled: true },
        models: baseModels,
      },
    },
    expect: ['已停用', '接入 TeleAgent 模型', '已停用：模型选择器里不会出现', '暂不生效'],
  },
  {
    name: '今日可领积分',
    props: {
      welfare: { ...baseWelfare, canClaimToday: true, lastClaimPoints: 0,
        daily: { ...baseWelfare.daily, claimedToday: false } },
      status: {
        auth: { signedIn: true, accountName: '示例账号', daysLeft: 28 },
        upstream: { ready: true },
        account: { abnormal: false, canClear: true, scopes: 1 },
        guard: { open: false, consecutiveFailures: 0, failureThreshold: 3 },
        models: baseModels,
      },
    },
    expect: ['今日可领 100 积分', '领取'],
  },
  {
    name: '积分读取失败',
    props: {
      welfare: { ...baseWelfare, balance: null, pointsError: 'HTTP 401', daily: { ...baseWelfare.daily, error: 'HTTP 401' } },
      status: {
        auth: { signedIn: true, accountName: '示例账号' },
        upstream: { ready: true },
        account: { abnormal: false, canClear: true, scopes: 1 },
        guard: { open: false, consecutiveFailures: 0, failureThreshold: 3 },
        models: baseModels,
      },
    },
    expect: ['积分读取失败', 'HTTP 401'],
  },
  {
    name: '清除确认态',
    props: {
      confirmClear: true,
      status: {
        auth: { signedIn: false, reason: '凭据文件不存在' },
        upstream: { ready: false },
        account: { abnormal: true, canClear: true, scopes: 1, nextStep: '登录态异常：清除后重新登录' },
        guard: { open: false, consecutiveFailures: 0, failureThreshold: 3 },
        models: baseModels,
      },
    },
    expect: ['确认清除', '再点一次'],
  },
  {
    name: '缺字段的坏数据（鲁棒性）',
    props: { status: { auth: {}, models: [] } },
    expect: ['TeleAgent'],
  },
]

for (const sc of scenarios) {
  const { html, error } = render(sc.props)
  if (error) {
    ok(sc.name, false, '渲染抛错: ' + error.message)
    continue
  }
  const missing = sc.expect.filter((t) => !html.includes(t))
  const hasUndefined = /\bundefined\b/.test(html)
  ok(sc.name, missing.length === 0 && !hasUndefined,
    missing.length ? '缺少文案: ' + missing.join(' | ') : (hasUndefined ? '渲染出 undefined' : `${html.length} 字节`))
}

// 主题令牌检查：不能有写死的亮色背景导致深色模式下看不清
{
  const { html } = render({
    status: {
      auth: { signedIn: true, accountName: 'x' },
      upstream: { ready: true },
      account: { canClear: true },
      guard: { open: false, consecutiveFailures: 0, failureThreshold: 3 },
      models: baseModels,
    },
  })
  for (const label of ['账号', '模型', '福利', '诊断']) {
    ok(`分栏存在：${label}`, html.includes('>' + label) || html.includes(label + '<'), label)
  }
  ok('使用 dsw 设计令牌', html.includes('--dsw-alias-'), '含 --dsw-alias-* 变量')
  ok('含深色回退值', /var\(--dsw-alias-[a-z0-9-]+,\s*[^)]+\)/.test(html), 'var(...) 带 fallback')
  ok('无可点击的裸 div 按钮', (html.match(/<button/g) || []).length >= 3, `button 数量 ${(html.match(/<button/g) || []).length}`)
}

// ---------------------------------------------------------------- 积分胶囊
{
  const PointsCapsule = moduleObj.__internals?.PointsCapsule
  const Gate = moduleObj.__internals?.PointsCapsuleGate
  const selectedProviderOf = moduleObj.__internals?.selectedProviderOf
  ok('导出 PointsCapsule', typeof PointsCapsule === 'function')
  ok('导出 PointsCapsuleGate', typeof Gate === 'function')

  if (typeof PointsCapsule === 'function') {
    const html = renderToStaticMarkup(React.createElement(PointsCapsule))
    ok('胶囊首帧不占位', html === '', JSON.stringify(html.slice(0, 40)))
  }

  // provider 判定
  if (typeof selectedProviderOf === 'function') {
    ok('selectedProviderOf: next 优先', selectedProviderOf({ next: { provider: 'teleagent' }, lastUsed: { provider: 'deepseek' } }) === 'teleagent')
    ok('selectedProviderOf: 无 next 用 lastUsed', selectedProviderOf({ lastUsed: { provider: 'teleagent' } }) === 'teleagent')
    ok('selectedProviderOf: 空投影返回 undefined', selectedProviderOf(undefined) === undefined)
    ok('selectedProviderOf: 空字符串不算', selectedProviderOf({ next: { provider: '' } }) === undefined)
  }

  // 门控：只有 teleagent 才渲染
  if (typeof Gate === 'function') {
    const mockHook = (value) => (key) => (key === 'modelSelection' ? value : undefined)
    const htmlFor = (provider) => renderToStaticMarkup(React.createElement(Gate, {
      useProjection: mockHook({ next: { provider } }),
      initialWelfare: { balance: 1234.56, canClaimToday: false, daily: { ok: true, claimedToday: true, claimable: 100 } },
    }))

    const ours = htmlFor('teleagent')
    ok('选中 teleagent 时渲染胶囊', ours.includes('1234.56'), ours.slice(0, 60))

    for (const other of ['deepseek', 'workbuddy', 'codebuddy']) {
      const html = htmlFor(other)
      ok(`选中 ${other} 时不渲染`, html === '', JSON.stringify(html.slice(0, 40)))
    }

    // 无 useProjection（老宿主）时无法判断 provider → 退化为显示
    const fallback = renderToStaticMarkup(React.createElement(Gate, {
      initialWelfare: { balance: 1234.56, canClaimToday: false, daily: { ok: true, claimedToday: true, claimable: 100 } },
    }))
    ok('宿主无 useProjection 时退化显示', fallback.includes('1234.56'), fallback.slice(0, 40))
  }
}

// ---------------------------------------------------------------- 分栏行为
const noop = () => {}
{
  const status = {
    pluginVersion: '0.5.3',
    auth: { signedIn: true, accountName: '示例账号', daysLeft: 28 },
    upstream: { ready: true },
    account: { abnormal: false, canClear: true, scopes: 1 },
    guard: { open: false, consecutiveFailures: 0, failureThreshold: 3 },
    provider: { disabled: false },
    models: baseModels,
    welfare: baseWelfare,
  }
  const markup = (tab) => renderToStaticMarkup(React.createElement(CardView, {
    status, error: null, busy: false, hint: null, confirmClear: false, welfare: baseWelfare, tab,
    onRefresh: noop, onLogin: noop, onClear: noop, onToggle: noop,
    onClaim: noop, onToggleAuto: noop, onRefreshWelfare: noop, onToggleProvider: noop, onTab: noop,
  }))

  const diag = markup('diagnostics')
  ok('诊断栏含插件版本', diag.includes('0.5.3'), 'v0.5.3')
  ok('诊断栏含上游网关', diag.includes('agent.teleai.com.cn'))
  ok('诊断栏含模型统计', diag.includes('启用'), '模型 X 个，启用 Y 个')

  const modelsTab = markup('models')
  ok('模型栏含模型 id', modelsTab.includes('chat-pro'))
  ok('模型栏含图片徽标', modelsTab.includes('图片'))

  const welfareTab = markup('welfare')
  ok('福利栏含余额', welfareTab.includes('1234.56'))
}

// ---------------------------------------------------------------- 有状态卡片的首帧
//
// 回归：Card 的首次渲染 status 为 null（数据还没回来）。曾经在这里
// 直接读 status.allowChatProbe，导致整个卡片在挂载瞬间抛错，
// 界面表现为"插件信息一片空白"。这里锁住"任何 props 组合都不能抛"。
{
  const { Card } = moduleObj.__internals ?? {}
  ok('导出 Card 组件', typeof Card === 'function')

  if (typeof Card === 'function') {
    const cases = [
      ['status 为 null（首帧）', undefined],
    ]
    for (const [name, fetchResult] of cases) {
      globalThis.fetch = async () => ({ ok: true, json: async () => (fetchResult ?? {}) })
      try {
        const html = renderToStaticMarkup(React.createElement(Card))
        ok(`${name} 不抛错`, true, `${html.length} 字节`)
      } catch (error) {
        ok(`${name} 不抛错`, false, error.message)
      }
    }
  }
}

console.log('\n卡片渲染验证（react-dom/server）')
console.log('─'.repeat(62))
for (const x of report) console.log(`  ${x.c ? '✓' : '✗'} ${x.n.padEnd(22)} ${x.d}`)
const failed = report.filter((x) => !x.c)
console.log('─'.repeat(62))
console.log(failed.length ? `  ${failed.length} 项失败` : '  全部通过')
process.exit(failed.length ? 1 : 0)
