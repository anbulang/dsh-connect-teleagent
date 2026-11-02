/**
 * TeleAgent「积分福利社」portal 客户端。
 *
 * ## 与聊天网关的区别
 *
 * 聊天走 `https://agent.teleai.com.cn/superCowork/sapi`，需要两步 HMAC 签名（见 upstream.js）。
 * 积分走的是**另一个服务** `https://agent.teleai.com.cn/meter/super-agent/user/portal`，
 * 由桌面端渲染层直接调用，鉴权是 **cookie + 请求头**，不签名：
 *
 *   X-Token: <operationToken>      （agent.teleai.com.cn 域下的 cookie）
 *   userId:  <userId>              （账号目录名 v1_public_<userId> 的尾段）
 *   Cookie:  operToken=…;  operationToken=…
 *
 * 这些结论来自静态分析（portal SPA bundle 里的请求封装）与一次只读实测，实测返回：
 *   /points/detail          → {"pointsBalance":5967.79, groups:[…]}
 *   /companyStore/v2/checkDayTask → {"daily_task":{"daily_claimable_points":100,"claimed_today":false,…}}
 *   /companyStore/userCenter      → {"current_points_balance":"5967.79","plan_display_name":"免费版",…}
 *
 * ## 为什么读 cookie 而不是别的
 *
 * 桌面端把每个账号的 cookie 存在独立分区：
 *   ~/.local/share/TeleAgent/Partitions/owner%3A<scope>/Cookies
 * 这是 Chromium 的 SQLite cookie 库。实测该实例把值**明文存在 `value` 列**
 * （`encrypted_value` 为空），因此不需要钥匙串解密即可读取。
 * 若将来改成加密存储，这里会读不到值并显式报错，而不是静默返回空积分。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { appPaths, currentScope } from './models.js'
import { bootlog } from './bootlog.js'

export const PORTAL_BASE = 'https://agent.teleai.com.cn/meter/super-agent/user/portal'

/** 从账号目录名 `v1_public_<userId>` 取 userId */
export function userIdFromScope(scope) {
  const m = /^v\d+_public_(\d+)$/.exec(scope ?? '')
  if (m) return m[1]
  const tail = (scope ?? '').split('_').pop() ?? ''
  return /^\d+$/.test(tail) ? tail : ''
}

/**
 * 复制 cookie 库到临时文件后读取（桌面端运行时会锁住原文件）。
 * 只取 portal 需要的两个 cookie。
 */
function readCookiesFrom(dbPath) {
  if (!fs.existsSync(dbPath)) return null
  const tmp = path.join(os.tmpdir(), `te-ck-${process.pid}-${Date.now()}.db`)
  const out = {}
  try {
    fs.copyFileSync(dbPath, tmp)
    // 用 sqlite3 命令行读取，避免引入 node 原生依赖
    const sql = "select name,value from cookies where name in ('operationToken','operToken')"
    const stdout = execFileSync('sqlite3', ['-readonly', tmp, sql], { encoding: 'utf8', timeout: 10000 })
    for (const line of stdout.split('\n')) {
      if (!line.includes('|')) continue
      const idx = line.indexOf('|')
      const name = line.slice(0, idx)
      const value = line.slice(idx + 1)
      if (name && value) out[name] = value
    }
    return Object.keys(out).length > 0 ? out : null
  } catch (error) {
    bootlog('读取 portal cookie 失败', { dbPath, error: String(error?.message ?? error) })
    return null
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
  }
}

/**
 * 读取当前账号的 portal 凭据。
 * @returns {{userId:string, operationToken:string, operToken:string, source:string}|null}
 */
/**
 * 读取某个账号的 portal 凭据。
 * @param {string} [home]
 * @param {string} [explicitScope] 指定账号目录名；省略则用当前账号
 */
export function readPortalAuth(home = process.env.HOME, explicitScope) {
  let scope = ''
  if (typeof explicitScope === 'string' && explicitScope !== '') {
    scope = explicitScope
  } else {
    try { scope = currentScope(appPaths(home).data) } catch { return null }
  }

  const userId = userIdFromScope(scope)
  if (!userId) return null

  const userData = path.join(home, '.local', 'share', 'TeleAgent')
  const candidates = [
    path.join(userData, 'Partitions', `owner%3A${scope}`, 'Cookies'),
    path.join(userData, 'Partitions', `owner:${scope}`, 'Cookies'),
  ]
  // 主 cookie 库只在"没指定账号"时兜底：
  // 指定账号却回落到主库，会把当前账号的凭据当成别人的，余额就串了。
  if (typeof explicitScope !== 'string' || explicitScope === '') {
    candidates.push(path.join(userData, 'Cookies'))
  }

  for (const dbPath of candidates) {
    const cookies = readCookiesFrom(dbPath)
    if (cookies?.operationToken) {
      return {
        userId,
        operationToken: cookies.operationToken,
        operToken: cookies.operToken ?? '',
        source: dbPath,
      }
    }
  }
  return null
}

/**
 * 调 portal 接口。返回 `{ ok, status, json, error }`，永不抛错。
 */
export async function portalRequest(auth, apiPath, { query, timeoutMs = 15000 } = {}) {
  const url = new URL(PORTAL_BASE + apiPath)
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))

  const headers = {
    'X-Token': auth.operationToken,
    userId: auth.userId,
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 TeleAgent',
    Referer: 'https://agent.teleai.com.cn/teleagent-space',
  }
  const cookieParts = []
  if (auth.operToken) cookieParts.push(`operToken=${auth.operToken}`)
  cookieParts.push(`operationToken=${auth.operationToken}`)
  headers.Cookie = cookieParts.join('; ')

  try {
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(timeoutMs) })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON（可能是登录页 HTML） */ }
    if (!res.ok) return { ok: false, status: res.status, json, error: `HTTP ${res.status}` }
    if (json === null) return { ok: false, status: res.status, json: null, error: '响应不是 JSON（可能需要重新登录桌面端）' }
    // portal 的业务码
    if (json.code !== undefined && Number(json.code) !== 200) {
      return { ok: false, status: res.status, json, error: `${json.code} ${json.msg ?? ''}`.trim() }
    }
    return { ok: true, status: res.status, json, error: null }
  } catch (error) {
    return { ok: false, status: 0, json: null, error: String(error?.message ?? error) }
  }
}

/**
 * 积分余额与明细。
 * @returns {Promise<{ok:boolean, balance?:number, groups?:Array, error?:string}>}
 */
export async function fetchPoints(auth) {
  const r = await portalRequest(auth, '/points/detail')
  if (!r.ok) return { ok: false, error: r.error }
  const data = r.json?.data ?? {}
  const balance = Number(data.pointsBalance)
  const groups = Array.isArray(data.groups) ? data.groups : []

  // 找到最早到期的活动余额，用于卡片提示「X 积分将于 Y 过期」
  let soonestExpiry = null
  for (const g of groups) {
    for (const item of (g.active ?? [])) {
      const end = item?.effectiveEnd
      if (typeof end === 'string' && (soonestExpiry === null || end < soonestExpiry)) soonestExpiry = end
    }
  }

  return {
    ok: true,
    balance: Number.isFinite(balance) ? balance : null,
    userRole: data.userRole ?? null,
    groups,
    expiresAt: soonestExpiry,
  }
}

/**
 * 每日领取状态（只读）。
 * @returns {Promise<{ok:boolean, claimable?:number, claimedToday?:boolean, totalDays?:number, totalPoints?:number, buttonText?:string, error?:string}>}
 */
export async function fetchDailyStatus(auth) {
  const r = await portalRequest(auth, '/companyStore/v2/checkDayTask')
  if (!r.ok) return { ok: false, error: r.error }
  const data = r.json?.data ?? {}
  const task = data.daily_task ?? {}
  const activity = data.activity ?? null
  return {
    ok: true,
    // 活动信息（有就带回，供卡片显示徽标；没有则为 null）
    activity: activity && activity.visible === true
      ? {
          title: activity.activity_title ?? null,
          endText: activity.end_date_text ?? null,
          actionText: activity.action_text ?? null,
        }
      : null,
    brandTitle: data.brand_title ?? null,
    visible: task.visible === true,
    claimable: Number(task.daily_claimable_points ?? 0),
    claimedToday: task.claimed_today === true,
    totalDays: Number(task.total_claim_days ?? 0),
    totalPoints: Number(task.total_claimed_points ?? 0),
    buttonText: task.button_text ?? null,
  }
}

/**
 * 执行每日领取。
 *
 * 先查状态，已领就直接返回（幂等）；否则调用领取接口，再查一次确认。
 * @returns {Promise<{ok:boolean, claimed:boolean, points?:number, alreadyClaimed?:boolean, error?:string}>}
 */
export async function claimDaily(auth) {
  const before = await fetchDailyStatus(auth)
  if (!before.ok) return { ok: false, claimed: false, error: before.error }
  if (before.claimedToday) {
    return { ok: true, claimed: false, alreadyClaimed: true, points: 0 }
  }

  const r = await portalRequest(auth, '/companyStore/checkTask', { query: { type: 'daily_login' } })
  if (!r.ok) return { ok: false, claimed: false, error: r.error }

  // 再确认一次，避免"接口成功但实际没发"也报成功
  const after = await fetchDailyStatus(auth)
  const claimedNow = after.ok ? after.claimedToday && !before.claimedToday : true
  bootlog('每日领取', {
    before: before.claimedToday, after: after.ok ? after.claimedToday : 'unknown',
    claimable: before.claimable,
  })
  return {
    ok: true,
    claimed: claimedNow,
    points: before.claimable,
    alreadyClaimed: !claimedNow,
  }
}

/** 套餐与账号信息（用于卡片展示计划名/并发数） */
export async function fetchUserCenter(auth) {
  const r = await portalRequest(auth, '/companyStore/userCenter')
  if (!r.ok) return { ok: false, error: r.error }
  const d = r.json?.data ?? {}
  return {
    ok: true,
    planName: d.plan_display_name ?? null,
    balance: d.current_points_balance != null ? Number(d.current_points_balance) : null,
    maxConcurrentTasks: d.max_concurrent_tasks ?? null,
    endDate: d.end_date ?? null,
  }
}
