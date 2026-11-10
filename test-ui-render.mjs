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
    onAddAccount: () => {}, onCancelAddAccount: () => {},
    addAccountRunning: false, addAccountResult: null,
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
    // 多账号登录入口：新宿主声明 addAccount 能力后，卡片必须给出入口
    name: '多账号登录入口',
    props: {
      status: {
        auth: { signedIn: true, accountName: '示例账号', expiresAt: Date.now() + 86400000, daysLeft: 28 },
        upstream: { ready: true },
        account: { abnormal: false, canClear: true, scopes: 1, canAddAccount: true },
        guard: { open: false, consecutiveFailures: 0, failureThreshold: 3 },
        provider: { disabled: false },
        capabilities: { deleteAccount: true, addAccount: true },
        models: baseModels,
      },
    },
    expect: ['添加账号', '登录另一个 TeleAgent 账号', 'acct-A'],
  },
  {
    // 等待登录态：按钮变「取消」，并给出换号操作步骤
    name: '添加账号等待中',
    props: {
      addAccountRunning: true,
      status: {
        auth: { signedIn: true, accountName: '示例账号' },
        upstream: { ready: true },
        account: { abnormal: false, canClear: true, scopes: 1, canAddAccount: true },
        guard: { open: false, consecutiveFailures: 0, failureThreshold: 3 },
        capabilities: { deleteAccount: true, addAccount: true },
        models: baseModels,
      },
    },
    expect: ['添加账号（等待登录）', '取消', '等待登录中', '退出登录'],
  },
  {
    name: '添加账号成功',
    props: {
      addAccountResult: { ok: true, code: 'added', message: '已添加账号「acct-B」；原账号「acct-A」的登录态已保留' },
      status: {
        auth: { signedIn: true, accountName: '示例账号' },
        upstream: { ready: true },
        account: { abnormal: false, canClear: true, scopes: 1, canAddAccount: true },
        guard: { open: false, consecutiveFailures: 0, failureThreshold: 3 },
        capabilities: { deleteAccount: true, addAccount: true },
        models: baseModels,
      },
    },
    expect: ['已添加账号「acct-B」', '登录态已保留'],
  },
  {
    name: '添加账号超时',
    props: {
      addAccountResult: {
        ok: false, code: 'timeout', timedOut: true,
        reason: '等待超时（5 分钟内未检测到新账号登录）',
        hint: '在 TeleAgent 里「设置 → 账号 → 退出登录」后，用另一个账号完成登录',
      },
      status: {
        auth: { signedIn: true, accountName: '示例账号' },
        upstream: { ready: true },
        account: { abnormal: false, canClear: true, scopes: 1, canAddAccount: true },
        guard: { open: false, consecutiveFailures: 0, failureThreshold: 3 },
        capabilities: { deleteAccount: true, addAccount: true },
        models: baseModels,
      },
    },
    expect: ['等待超时', '退出登录'],
  },
  {
    // 宿主还是旧版本：按钮要保留但禁用，并说明"重启 DSH 后可用"
    name: '旧宿主无添加账号能力',
    props: {
      status: {
        auth: { signedIn: true, accountName: '示例账号' },
        upstream: { ready: true },
        account: { abnormal: false, canClear: true, scopes: 1 },
        guard: { open: false, consecutiveFailures: 0, failureThreshold: 3 },
        capabilities: { deleteAccount: true },
        models: baseModels,
      },
    },
    expect: ['添加账号', '当前宿主仍是旧版本'],
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

// ---------------------------------------------------------------- 设置页原生入口
//
// task-3：配置入口迁到 DSH 原生 `settings.section` + `configForms` scope 读写，
// 富卡片保留做运维视图。这里锁住四件事：
//   1. slot 注册清单正确（新增 settings.section，删除 plugins.bundle.config/row.config）
//   2. configForms 不存在时 apply 不崩（老宿主）
//   3. 四项写入走 scope 优先
//   4. 没有 scope 时回退 HTTP
console.log('\n设置页原生入口（settings.section + configForms）')
console.log('─'.repeat(62))
{
  // apply 会打一行挂载点摘要；断言期间静音，别让日志淹掉结果
  const realInfo = console.info
  console.info = () => {}
  const internals = moduleObj.__internals ?? {}
  const SectionView = internals.SettingsSectionView
  ok('导出 SettingsSectionView', typeof SectionView === 'function')
  ok('settings.section id 是插件自有稳定值',
    internals.SETTINGS_SECTION_ID === 'dsh-connect-teleagent',
    String(internals.SETTINGS_SECTION_ID))
  ok('namespace 候选含裸名与 include 形式',
    Array.isArray(internals.SETTINGS_NAMESPACE_CANDIDATES) &&
      internals.SETTINGS_NAMESPACE_CANDIDATES.includes('dsh-connect-teleagent') &&
      internals.SETTINGS_NAMESPACE_CANDIDATES.includes('include:dsh-connect-teleagent'),
    JSON.stringify(internals.SETTINGS_NAMESPACE_CANDIDATES))
  ok('四个字段清单正确',
    JSON.stringify(internals.SETTINGS_FIELDS) ===
      JSON.stringify(['providerDisabled', 'enabledModelIds', 'toolsAllowlist', 'autoClaimDaily']),
    JSON.stringify(internals.SETTINGS_FIELDS))

  // ---- mock 宿主 ctx：记录 inject / register / effect 三类调用
  function makeCtx({ forms } = {}) {
    const registered = []
    const injected = []
    const effects = []
    const slots = {
      inject(name, cb) {
        injected.push(name)
        const dispose = cb()
        return () => { if (typeof dispose === 'function') dispose() }
      },
      register(meta, component) {
        registered.push({ ...meta, component })
        return () => {}
      },
    }
    const ctx = { slots, effect(fn, label) { effects.push(label); const out = fn(); return typeof out === 'function' ? out : () => {} } }
    // ctx.get 是软取可选服务的唯一安全姿势（ctx.x 对未声明服务会 THROW）
    ctx.get = (name) => (name === 'configForms' ? forms : undefined)
    return { ctx, registered, injected, effects }
  }

  // ---- 1. slot 注册清单（老宿主：没有 configForms）
  {
    const { ctx, registered, injected } = makeCtx()
    let threw = null
    try { moduleObj.apply(ctx, {}) } catch (error) { threw = error }
    ok('无 configForms 时 apply 不崩', threw === null, threw ? threw.message : 'ok')

    const names = registered.map((r) => r.name)
    ok('注册 settings.section', names.includes('settings.section'), JSON.stringify(names))
    ok('注册 settings.section.icon', names.includes('settings.section.icon'))
    ok('保留 settings.plugins.tab', names.includes('settings.plugins.tab'))
    ok('删除 plugins.bundle.config', !names.includes('plugins.bundle.config'))
    ok('删除 plugins.row.config', !names.includes('plugins.row.config'))

    const section = registered.find((r) => r.name === 'settings.section')
    ok('settings.section 用插件自有 id', section?.id === 'dsh-connect-teleagent', String(section?.id))
    ok('settings.section 有 order', typeof section?.order === 'number', String(section?.order))
    ok('settings.section 有 label', typeof section?.label === 'function', typeof section?.label)
    ok('settings.section 组件是 SettingsSection', section?.component === internals.SettingsSection)
    const icon = registered.find((r) => r.name === 'settings.section.icon')
    ok('settings.section.icon 与表单同 id', icon?.id === section?.id, String(icon?.id))
    ok('注入过 settings.section 槽位', injected.includes('settings.section'))

    // 老宿主没有 scope → inject 出来的 props 里不能有 settingsScope
    const props = typeof section?.inject === 'function' ? section.inject() : {}
    ok('无 scope 时 inject 不带 settingsScope', props.settingsScope === undefined,
      JSON.stringify(Object.keys(props ?? {})))
  }

  // ---- 2. 有 configForms（whileServed 形态）：绑定到宿主真正服务的 namespace
  {
    let servedCb = null
    const fakeScope = {
      getSnapshot: () => ({ value: { providerDisabled: true, enabledModelIds: ['chat-pro'], toolsAllowlist: [], autoClaimDaily: false }, writable: true }),
      set: async () => true,
      subscribe: () => () => {},
    }
    const forms = {
      whileServed(candidates, callback) {
        servedCb = callback
        callback(new Set())   // 起手：镜像还没填
        return () => {}
      },
      get(ns) { return ns === 'dsh-connect-teleagent' ? fakeScope : undefined },
    }
    const { ctx, registered, effects } = makeCtx({ forms })
    moduleObj.apply(ctx, {})
    ok('用 ctx.effect 持有 whileServed 订阅', effects.some((l) => /settings namespace binding/.test(l)),
      JSON.stringify(effects))

    const before = registered.find((r) => r.name === 'settings.section')
    ok('namespace 未服务时 inject 不带 settingsScope',
      (typeof before?.inject === 'function' ? before.inject() : {}).settingsScope === undefined)

    ok('whileServed 回调已注册', typeof servedCb === 'function')
    if (typeof servedCb === 'function') {
      servedCb(new Set(['dsh-connect-teleagent']))
      const after = registered.find((r) => r.name === 'settings.section')
      const props = typeof after?.inject === 'function' ? after.inject() : {}
      ok('namespace 到达后 inject 带上 settingsScope', props.settingsScope === fakeScope)
    }
  }

  // ---- 2b. 重绑顺序：必须先 dispose 再 register
  //
  // 宿主的 keyed 槽位同一个 key 重复注册会 THROW，而每处注册都各自 try/catch
  // 吞掉错误 —— 先注册后释放会得到一个**空** ledger，界面上什么都不剩。
  // 这里用一个会拒绝重复 key 的假 ledger 把顺序钉住。
  {
    const live = new Map()   // `name#key|id` → 是否存活
    const ledger = {
      register(meta) {
        const id = meta.key !== undefined ? `${meta.name}#${meta.key}` : `${meta.name}#id:${meta.id}`
        if (live.get(id) === true) throw new Error('already has an entry for key ' + id)
        live.set(id, true)
        return () => { live.set(id, false) }
      },
      inject(name, cb) {
        let inner
        const dispose = () => { if (typeof inner === 'function') inner() }
        // 模拟 renderer 缓存：inject 只求值一次
        inner = cb()
        return dispose
      },
    }
    const errors = []
    const realError = console.error
    console.error = (...args) => errors.push(args.join(' '))
    let servedCb = null
    const fakeScope = { getSnapshot: () => ({ value: {}, writable: true }), set: async () => true }
    const forms = {
      whileServed(candidates, callback) { servedCb = callback; callback(new Set()); return () => {} },
      get: () => fakeScope,
    }
    const ctx = {
      slots: ledger,
      effect(fn) { const out = fn(); return typeof out === 'function' ? out : () => {} },
      get: (name) => (name === 'configForms' ? forms : undefined),
    }
    try { moduleObj.apply(ctx, {}) } catch (error) { errors.push('apply threw: ' + error.message) }
    const aliveAfterFirst = [...live.values()].filter(Boolean).length
    if (typeof servedCb === 'function') servedCb(new Set(['dsh-connect-teleagent']))
    const aliveAfterRebind = [...live.values()].filter(Boolean).length
    console.error = realError

    const dead = [...live.entries()].filter(([, alive]) => alive !== true).map(([id]) => id)
    ok('重绑时不因重复注册报错', errors.length === 0, errors.join(' | ').slice(0, 120))
    ok('重绑后槽位数量不减少', aliveAfterRebind >= aliveAfterFirst,
      `${aliveAfterFirst} → ${aliveAfterRebind}`)
    // 回归：胶囊的 disposer 曾经被「调用」而不是「登记」，第一次绑定时就把它自己
    // 释放掉了 —— 界面上少一个胶囊，且不报错。这里要求重绑后一个都不许是死的。
    ok('重绑后所有槽位都是活的', dead.length === 0, dead.join(' | ') || 'all alive')
    ok('重绑后仍有 settings.section', live.get('settings.section#id:dsh-connect-teleagent') === true,
      JSON.stringify([...live.entries()]))
  }

  const { readSettingsValue, overlayStatus, valuesFromStatus, normalizeToolsList, writeSetting, writeSettingsField } = internals

  // ---- 3. 读值：settings 优先，缺失时回退 /status
  {
    const scope = {
      getSnapshot: () => ({ value: { providerDisabled: true, enabledModelIds: ['chat-pro'], toolsAllowlist: null, autoClaimDaily: false } }),
    }
    const v = readSettingsValue(scope)
    ok('readSettingsValue: providerDisabled', v?.providerDisabled === true)
    ok('readSettingsValue: enabledModelIds', JSON.stringify(v?.enabledModelIds) === JSON.stringify(['chat-pro']))
    ok('readSettingsValue: toolsAllowlist null → []', Array.isArray(v?.toolsAllowlist) && v.toolsAllowlist.length === 0)
    ok('readSettingsValue: autoClaimDaily', v?.autoClaimDaily === false)
    ok('readSettingsValue: 无 scope → undefined', readSettingsValue(undefined) === undefined)
    ok('readSettingsValue: 空快照 → undefined',
      readSettingsValue({ getSnapshot: () => ({ value: {} }) }) === undefined)
    ok('readSettingsValue: getSnapshot 抛错不崩',
      readSettingsValue({ getSnapshot: () => { throw new Error('boom') } }) === undefined)

    const status = {
      provider: { disabled: false },
      models: [
        { id: 'chat-pro', enabled: true },
        { id: 'chat-flash', enabled: true },
        { id: 'chat-nano', enabled: true },
      ],
      toolsAllowlist: null,
    }
    const overlaid = overlayStatus(scope, status)
    ok('overlayStatus: 用 settings 覆盖 providerDisabled', overlaid.provider.disabled === true)
    ok('overlayStatus: 只勾了 chat-pro',
      overlaid.models.find((m) => m.id === 'chat-pro').enabled === true &&
      overlaid.models.find((m) => m.id === 'chat-flash').enabled === false)
    ok('overlayStatus: 无 scope 时原样返回', overlayStatus(undefined, status) === status)

    const fromStatus = valuesFromStatus(status)
    ok('valuesFromStatus: 回退读 /status',
      fromStatus.providerDisabled === false && fromStatus.autoClaimDaily === true &&
      Array.isArray(fromStatus.toolsAllowlist))
    ok('normalizeToolsList: null → []', normalizeToolsList(null).length === 0)
    ok('normalizeToolsList: 非数组 → []', normalizeToolsList('x').length === 0)
  }

  // ---- 4/5. 写值：scope 优先，无 scope 或失败才回退 HTTP
  await (async () => {
    // 有状态的假 scope：set 真的改快照，回读校验才有意义
    const makeScope = (initial) => {
      const state = { ...initial }
      const calls = []
      return {
        calls,
        getSnapshot: () => ({ value: { ...state }, writable: true }),
        set: async (field, value) => { calls.push([field, value]); state[field] = value; return true },
      }
    }
    const scope = makeScope({ providerDisabled: false })
    let httpCalls = 0
    const out = await writeSetting({
      scope, field: 'providerDisabled', value: true,
      fallback: async () => { httpCalls += 1; return true },
    })
    ok('scope 优先：写入成功 via=scope', out.ok === true && out.via === 'scope', JSON.stringify(out))
    ok('scope 优先：真的调了 scope.set', scope.calls.length === 1 && scope.calls[0][0] === 'providerDisabled')
    ok('scope 优先：没有走 HTTP 回退', httpCalls === 0)
    ok('scope 优先：值真的落到了快照里', scope.getSnapshot().value.providerDisabled === true)

    // 写入被吞（set resolve 了但快照没变）→ 不能算成功
    const lyingScope = {
      calls: [],
      getSnapshot: () => ({ value: { providerDisabled: false }, writable: true }),
      set: async (field, value) => { lyingScope.calls.push([field, value]); return true },  // resolve 了但快照没变
    }
    const out2 = await writeSetting({
      scope: lyingScope, field: 'providerDisabled', value: true,
      fallback: async () => ({ ok: true, via: 'store' }),
    })
    // 回读对不上就不许报「scope 写成功」，转由 HTTP 回退兜底（两个写入口值相同，幂等）
    ok('回读不一致时不报 scope 成功', out2.via !== 'scope' && lyingScope.calls.length === 1,
      JSON.stringify(out2))

    // 只读 scope → 不假装写成功，直接回退
    let readonlySetCalls = 0
    const readonlyScope = {
      getSnapshot: () => ({ value: {}, writable: false }),
      set: async () => { readonlySetCalls += 1; return true },
    }
    const out3 = await writeSetting({
      scope: readonlyScope, field: 'autoClaimDaily', value: false,
      fallback: async () => ({ ok: true, via: 'store' }),
    })
    ok('只读 scope 回退 HTTP', out3.ok === true && out3.via === 'http', JSON.stringify(out3))
    ok('只读 scope 不调用 set', readonlySetCalls === 0, `${readonlySetCalls} 次`)

    const routes = []
    globalThis.fetch = async (url, init) => {
      routes.push({ url, body: JSON.parse(init.body) })
      return { ok: true, json: async () => ({ ok: true }) }
    }
    const cases = [
      ['providerDisabled', true, '/models', 'providerDisabled'],
      ['enabledModelIds', ['chat-pro'], '/models', 'enabledModelIds'],
      ['toolsAllowlist', ['bash'], '/tools', 'toolsAllowlist'],
      ['autoClaimDaily', false, '/welfare', 'action'],
    ]
    for (const [field, value, pathPart, bodyKey] of cases) {
      const before = routes.length
      const res = await writeSettingsField(undefined, field, value)
      const seen = routes.slice(before)
      ok(`无 scope 回退 HTTP：${field}`,
        res.ok === true && res.via === 'http' && seen.length === 1 &&
          seen[0].url.includes(pathPart) &&
          Object.prototype.hasOwnProperty.call(seen[0].body, bodyKey),
        `${res.via} ${seen[0]?.url ?? '—'}`)
    }
    // 空白名单在路由上必须写成 null（插件语义里 null 与 [] 等价）
    routes.length = 0
    await writeSettingsField(undefined, 'toolsAllowlist', [])
    ok('无 scope 回退：空白名单写成 null',
      routes[0]?.body?.toolsAllowlist === null, JSON.stringify(routes[0]?.body))

    // 路由失败要如实返回 ok:false
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: '炸了' }) })
    const failed = await writeSettingsField(undefined, 'providerDisabled', true)
    ok('HTTP 回退失败时 ok=false', failed.ok === false, JSON.stringify(failed))

    // ---- 6. SettingsSectionView：四个控件都在，且空数据不崩
    const viewHtml = renderToStaticMarkup(React.createElement(SectionView, {
      value: { providerDisabled: false, enabledModelIds: ['chat-pro'], toolsAllowlist: ['bash'], autoClaimDaily: true },
      models: baseModels,
      busy: false, hint: null, toolsText: 'bash', source: 'settings',
      onChange: noop, onEditTools: noop, onSaveTools: noop, onResetTools: noop,
    }))
    for (const text of ['接入 TeleAgent 模型', 'chat-pro', '工具白名单', '自动领取', '保存', '恢复全量']) {
      ok(`SettingsSectionView 含「${text}」`, viewHtml.includes(text))
    }
    ok('SettingsSectionView 使用设计令牌', viewHtml.includes('--dsw-alias-'))
    ok('SettingsSectionView 无 undefined', !/\bundefined\b/.test(viewHtml))

    const emptyHtml = renderToStaticMarkup(React.createElement(SectionView, {
      value: undefined, models: undefined, busy: true, hint: '还在读', toolsText: undefined, source: 'status',
    }))
    ok('SettingsSectionView 空数据不崩',
      emptyHtml.length > 0 && !/\bundefined\b/.test(emptyHtml), `${emptyHtml.length} 字节`)
  })().finally(() => { console.info = realInfo })
}

console.log('\n卡片渲染验证（react-dom/server）')
console.log('─'.repeat(62))
for (const x of report) console.log(`  ${x.c ? '✓' : '✗'} ${x.n.padEnd(22)} ${x.d}`)
const failed = report.filter((x) => !x.c)
console.log('─'.repeat(62))
console.log(failed.length ? `  ${failed.length} 项失败` : '  全部通过')
process.exit(failed.length ? 1 : 0)
