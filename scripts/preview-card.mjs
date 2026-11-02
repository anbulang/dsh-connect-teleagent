/**
 * 生成卡片预览 HTML（明/暗两套主题并排）。
 *
 * 用与宿主一致的 --dsw-alias-* 令牌名，但在这里补上具体取值，
 * 这样离线打开就能看到接近真实的效果，不必重启 DSH。
 *
 * 运行：node scripts/preview-card.mjs [输出路径]
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire('/tmp/uicheck/package.json')
let React, renderToStaticMarkup
try {
  React = require('react')
  ;({ renderToStaticMarkup } = require('react-dom/server'))
} catch {
  console.error('需要 react/react-dom 才能渲染预览：npm i react@18 react-dom@18')
  process.exit(1)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

let captured = null
globalThis.window = { __ModuleLoader__: { load(o) { captured = o } } }
await import(path.join(root, 'lib', 'client.js'))
const mod = captured.factory((n) => {
  if (n === 'react') return React
  throw new Error('未知依赖 ' + n)
})
const CardView = mod.__internals.CardView
const PointsCapsule = mod.__internals.PointsCapsule

const models = [
  { id: 'chat-pro', name: '智能', contextWindow: 400000, maxTokens: 65536, creditMultiplier: '0.6', enabled: true },
  { id: 'chat-flagship', name: '旗舰', contextWindow: 400000, maxTokens: 65536, creditMultiplier: '1.0', enabled: true },
  { id: 'chat-flash', name: '极速', contextWindow: 400000, maxTokens: 65536, creditMultiplier: '0.2', enabled: false },
  { id: 'chat-lite', name: '轻量', contextWindow: 100000, maxTokens: 65536, creditMultiplier: '0.5', enabled: true },
  { id: 'chat-nano', name: '轻速', contextWindow: 100000, maxTokens: 65536, creditMultiplier: '0.1', enabled: false },
]

const noop = () => {}
const welfare = {
  balance: 1234.56, expiresAt: '2026-10-31 23:59:59', autoClaimDaily: true,
  canClaimToday: false, pointsError: null, lastClaimPoints: 100,
  daily: { ok: true, claimable: 100, claimedToday: true, totalDays: 2, totalPoints: 200, error: null },
}

const render = (status, extra = {}) => renderToStaticMarkup(React.createElement(CardView, {
  status, error: null, busy: false, hint: null, confirmClear: false, welfare, tab: 'account', onTab: noop,
  onRefresh: noop, onLogin: noop, onClear: noop, onToggle: noop,
  onClaim: noop, onToggleAuto: noop, onRefreshWelfare: noop, onToggleProvider: noop, ...extra,
}))

const cases = [
  {
    title: '正常（已登录、上游可用）',
    html: render({
      pluginVersion: '0.6.0',
      auth: { signedIn: true, accountName: '示例账号', expiresAt: Date.UTC(2026, 10, 24), daysLeft: 28 },
      upstream: { ready: true },
      account: { abnormal: false, canClear: true, scopes: 1 },
      guard: { open: false, consecutiveFailures: 0, failureThreshold: 3 },
      models,
    }),
  },
  {
    title: '未登录（提示去登录）',
    html: render({
      auth: { signedIn: false, reason: '凭据文件不存在', remedy: '在 TeleAgent 桌面端登录一次' },
      upstream: { ready: false, error: 'TeleAgent 凭据不可用' },
      account: { abnormal: false, canClear: false, scopes: 0 },
      guard: { open: false, consecutiveFailures: 0, failureThreshold: 3 },
      models: models.map((m) => ({ ...m, enabled: true })),
    }),
  },
  {
    title: '今日可领积分',
    html: render({
      auth: { signedIn: true, accountName: '示例账号', daysLeft: 28 },
      upstream: { ready: true },
      account: { abnormal: false, canClear: true, scopes: 1 },
      guard: { open: false, consecutiveFailures: 0, failureThreshold: 3 },
      models,
    }, { welfare: { ...welfare, canClaimToday: true, lastClaimPoints: 0,
      daily: { ...welfare.daily, claimedToday: false } } }),
  },
  {
    title: '账号被封（可清除后换号）',
    html: render({
      auth: { signedIn: true, accountName: '示例账号', daysLeft: 28 },
      upstream: { ready: true, lastError: { code: 'account_banned', message: '账号已被 TeleAgent 封禁', remedy: '联系客服申诉，或换一个账号登录' } },
      account: { abnormal: true, banned: true, canClear: true, scopes: 1, nextStep: '该账号已被上游封禁：清除登录态后换账号登录' },
      guard: { open: false, consecutiveFailures: 1, failureThreshold: 3 },
      models,
    }),
  },
  {
    title: '模型栏（含图片徽标）',
    html: render({
      pluginVersion: '0.6.0',
      auth: { signedIn: true, accountName: '示例账号', daysLeft: 28 },
      upstream: { ready: true },
      account: { abnormal: false, canClear: true, scopes: 1 },
      guard: { open: false, consecutiveFailures: 0, failureThreshold: 3 },
      provider: { disabled: false },
      models,
    }, { tab: 'models' }),
  },
  {
    title: '诊断栏（只读事实表）',
    html: render({
      pluginVersion: '0.6.0',
      auth: { signedIn: true, accountName: '示例账号', daysLeft: 28, expiresAt: Date.UTC(2026, 10, 24) },
      upstream: { ready: true },
      account: { abnormal: false, canClear: true, scopes: 1 },
      guard: { open: false, consecutiveFailures: 0, failureThreshold: 3 },
      provider: { disabled: false },
      models,
    }, { tab: 'diagnostics' }),
  },
  {
    title: '已熔断（连续 401 后暂停）',
    html: render({
      auth: { signedIn: true, accountName: '示例账号', daysLeft: 28 },
      upstream: { ready: true },
      account: { abnormal: false, canClear: true, scopes: 1 },
      guard: { open: true, cooldownRemainingMs: 480000, lastReason: '连续 3 次认证失败（HTTP 401）', consecutiveFailures: 3, failureThreshold: 3 },
      models,
    }),
  },
]

const capsule = (w) => renderToStaticMarkup(React.createElement(PointsCapsule, { initialWelfare: w }))
const capsules = [
  ['已领完（显示余额）', capsule(welfare)],
  ['今日可领（高亮）', capsule({ ...welfare, canClaimToday: true, daily: { ...welfare.daily, claimedToday: false } })],
  ['无数据（不占位）', capsule({ balance: null, daily: { ok: false } })],
]

const LIGHT = `
  --dsw-alias-label-primary: #1b1d21;
  --dsw-alias-label-secondary: #4a4f57;
  --dsw-alias-label-tertiary: #767c86;
  --dsw-alias-border-l1: rgba(16,18,22,.12);
  --dsw-alias-border-l2: rgba(16,18,22,.22);
  --dsw-alias-bg-layer-2: #f6f7f9;
  --dsw-alias-bg-layer-3: #eceef1;
  --dsw-alias-interactive-bg-hover: #e3e6ea;
  --dsw-alias-state-success-primary: #12813d;
  --dsw-alias-state-warn-primary: #9a6a00;
  --dsw-alias-state-error-primary: #c02a1f;
  --dsw-alias-brand-primary: #2f6bff;
  --dsw-radius-lg: 12px;
`
const DARK = `
  --dsw-alias-label-primary: #e8eaed;
  --dsw-alias-label-secondary: #b3b8c0;
  --dsw-alias-label-tertiary: #868d97;
  --dsw-alias-border-l1: rgba(255,255,255,.12);
  --dsw-alias-border-l2: rgba(255,255,255,.22);
  --dsw-alias-bg-layer-2: #24262b;
  --dsw-alias-bg-layer-3: #2e3138;
  --dsw-alias-interactive-bg-hover: #383c44;
  --dsw-alias-state-success-primary: #3fb950;
  --dsw-alias-state-warn-primary: #d29922;
  --dsw-alias-state-error-primary: #f85149;
  --dsw-alias-brand-primary: #5b8dff;
  --dsw-radius-lg: 12px;
`

const panel = (themeClass, css, label) => `
  <section class="panel ${themeClass}" style="${css}">
    <div class="panel-label">${label}</div>
    ${cases.map((c) => `<div class="case"><div class="case-title">${c.title}</div>${c.html}</div>`).join('\n')}
  </section>`

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-connect-teleagent · 设置卡片预览</title>
<style>
  body { margin: 0; padding: 24px; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; background: #0b0c0e; }
  .note { color: #868d97; font-size: 12px; margin: 0 0 16px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: start; }
  @media (max-width: 1100px) { .row { grid-template-columns: 1fr; } }
  .panel { border-radius: 14px; padding: 16px; }
  .panel.light { background: #ffffff; }
  .panel.dark { background: #17181c; }
  .panel-label { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #868d97; margin-bottom: 12px; }
  .case { margin-bottom: 18px; }
  .case-title { font-size: 11px; color: #868d97; margin-bottom: 6px; }
</style>
</head>
<body>
  <p class="note">静态预览：用与 DSH 相同的 <code>--dsw-alias-*</code> 令牌渲染，明暗两套取值。真实宿主里令牌由 DSH 提供。</p>
  <div class="row">
    ${panel('light', LIGHT, 'Light')}
    ${panel('dark', DARK, 'Dark')}
  </div>
  <div class="row" style="margin-top:20px">
    <section class="panel light" style="${LIGHT}">
      <div class="panel-label">输入框左下角 · 积分胶囊（Light）</div>
      ${capsules.map(([label, html]) => `<div class="case"><div class="case-title">${label}</div>
        <div style="display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;min-height:44px">
          ${html}<span style="font-size:12px;color:var(--dsw-alias-label-tertiary)">输入消息…</span>
        </div></div>`).join('\n')}
    </section>
    <section class="panel dark" style="${DARK}">
      <div class="panel-label">输入框左下角 · 积分胶囊（Dark）</div>
      ${capsules.map(([label, html]) => `<div class="case"><div class="case-title">${label}</div>
        <div style="display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;min-height:44px">
          ${html}<span style="font-size:12px;color:var(--dsw-alias-label-tertiary)">输入消息…</span>
        </div></div>`).join('\n')}
    </section>
  </div>
</body>
</html>`

const out = process.argv[2] ?? path.join(root, 'docs', 'card-preview.html')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, html, 'utf8')
console.log('已生成预览:', out, `(${html.length} 字节)`)
