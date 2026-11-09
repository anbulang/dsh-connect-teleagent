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
 * Chromium 的 SQLite cookie 库可能在分区的 Network 子目录内。
 * Windows 上加密值使用当前 Windows 用户的 TeleAgent DPAPI 密钥读取。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { appPaths, currentScope } from './models.js'
import { decryptSafeStorageBytes, readSafeStorageKey } from './credential.js'
import { bootlog } from './bootlog.js'

export const PORTAL_BASE = 'https://agent.teleai.com.cn/meter/super-agent/user/portal'
export const MISSING_PORTAL_AUTH_HINT = process.platform === 'win32'
  ? '在 TeleAgent 登录并打开积分福利页，再完全退出 TeleAgent 以释放积分 Cookie 数据库'
  : '在 TeleAgent 登录并打开积分福利页'

/** 从账号目录名 `v1_public_<userId>` 取 userId */
export function userIdFromScope(scope) {
  const m = /^v\d+_public_(\d+)$/.exec(scope ?? '')
  if (m) return m[1]
  const tail = (scope ?? '').split('_').pop() ?? ''
  return /^\d+$/.test(tail) ? tail : ''
}

function cookiePaths(dir) {
  return [path.join(dir, 'Network', 'Cookies'), path.join(dir, 'Cookies')]
}

export function accountCookiePaths(data, scope) {
  const partitionNames = [`owner%3A${scope}`, `owner:${scope}`]
  return partitionNames.flatMap((name) => cookiePaths(path.join(data, 'Partitions', name)))
}

/** 以只读连接访问 Chromium SQLite 库，让 SQLite 一并读取 WAL。 */
function readCookiesFrom(dbPath, getStorageKey) {
  if (!fs.existsSync(dbPath)) return null
  let db
  try {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db.prepare(`
      select name, value, host_key, encrypted_value from cookies
      where name in ('operationToken','operToken')
    `).all()
    const cookies = {}
    for (const row of rows) {
      if (row.host_key && !['agent.teleai.com.cn', '.agent.teleai.com.cn', '.teleai.com.cn'].includes(row.host_key)) continue
      if (row.value) {
        cookies[row.name] = row.value
      } else if (process.platform === 'win32' && row.encrypted_value?.length) {
        try {
          const key = getStorageKey()
          if (!key) continue
          let value = decryptSafeStorageBytes(Buffer.from(row.encrypted_value), key)
          // Chromium schema v24 起，密文前缀包含域名 SHA-256。
          const domainHash = createHash('sha256').update(row.host_key ?? '').digest()
          if (value.subarray(0, 32).equals(domainHash)) value = value.subarray(32)
          cookies[row.name] = value.toString('utf8')
        } catch { /* 该条 cookie 不可解密，不输出其内容 */ }
      }
    }
    return cookies
  } catch (error) {
    const detail = String(error?.message ?? error)
    if (!/no such table/i.test(detail)) bootlog('读取 portal cookie 失败', { dbPath, error: detail })
    return null
  } finally {
    db?.close()
  }
}

/**
 * 读取某个账号的 portal 凭据。
 * @param {string} [home]
 * @param {string} [explicitScope] 指定账号目录名；省略则用当前账号
 * @returns {{userId:string, operationToken:string, operToken:string, source:string}|null}
 */
export function readPortalAuth(home, explicitScope) {
  let scope = ''
  if (typeof explicitScope === 'string' && explicitScope !== '') {
    scope = explicitScope
  } else {
    try { scope = currentScope(appPaths(home).data) } catch { return null }
  }

  const userId = userIdFromScope(scope)
  if (!userId) return null

  const { data } = appPaths(home)
  const candidates = accountCookiePaths(data, scope)
  // 指定账号时只查该账号分区，避免把当前账号的余额归到别的账号。
  if (typeof explicitScope !== 'string' || explicitScope === '') candidates.push(...cookiePaths(data))
  let storageKey
  const getStorageKey = () => (storageKey ??= readSafeStorageKey(home).key ?? false)

  for (const dbPath of candidates) {
    const cookies = readCookiesFrom(dbPath, getStorageKey)
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
