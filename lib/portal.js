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
 * 桌面端把每个账号的 cookie 存在独立分区（macOS 与 Windows 都用 XDG 目录）：
 *   ~/.local/share/TeleAgent/Partitions/owner%3A<scope>/Cookies
 * Windows Chromium 多一层 Network 子目录：
 *   ~/.local/share/TeleAgent/Partitions/owner%3A<scope>/Network/Cookies
 * 这是 Chromium 的 SQLite cookie 库。macOS 版把值**明文存在 `value` 列**
 * （`encrypted_value` 为空）；Windows 版值是 safeStorage v10 密文，需要用
 * `Local State` 里 DPAPI 保护的主密钥做 AES-256-GCM 解密（见 decryptWindowsCookieValue）。
 * 读不到时显式回退 token.json 与磁盘缓存，而不是静默返回空积分。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

import { appPaths, currentScope } from './models.js'
import { readWindowsMasterKey, diagnoseCredential } from './credential.js'
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
 * 解 Windows Chromium cookie 的 v10 密文。
 *
 * Windows 版把 cookie 值用 AES-256-GCM 加密（不是明文）：
 *   "v10" + 12 字节 nonce + 密文 + 16 字节 tag
 * 主密钥与 token.json 共用 `Local State` 里那把 DPAPI 保护的 key。
 */
function decryptWindowsCookieValue(raw, dataDir) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  if (buf.length < 3 + 12 + 16 || buf.subarray(0, 3).toString() !== 'v10') {
    throw new Error('cookie 不是 safeStorage v10 格式')
  }
  const key = readWindowsMasterKey(dataDir)
  const iv = buf.subarray(3, 15)
  const tag = buf.subarray(buf.length - 16)
  const ciphertext = buf.subarray(15, buf.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/** 用 Node 24 自带的 node:sqlite 读（Windows 通常没有 sqlite3 命令） */
function loadDatabaseSync() {
  try {
    const mod = typeof process.getBuiltinModule === 'function'
      ? process.getBuiltinModule('node:sqlite')
      : null
    return mod?.DatabaseSync ?? null
  } catch {
    return null
  }
}

/** 从查询结果里取出两个 portal cookie；遇到加密值就本地解密 */
function extractCookies(rows, dataDir) {
  const out = {}
  const ordered = [...rows].sort((a, b) => {
    const score = (row) => (String(row.host_key ?? '').includes('teleai.com.cn') ? 0 : 1)
    return score(a) - score(b)
  })
  for (const row of ordered) {
    const name = String(row.name ?? '')
    if (name !== 'operationToken' && name !== 'operToken') continue
    if (out[name]) continue
    let value = typeof row.value === 'string' ? row.value : ''
    // 只有 Windows 的 cookie 才走 DPAPI 解密；其他平台别在这里刷一条注定失败的日志
    if (value.length === 0 && row.encrypted_value && process.platform === 'win32') {
      try {
        value = decryptWindowsCookieValue(row.encrypted_value, dataDir)
      } catch (error) {
        bootlog('portal cookie 解密失败', { name, error: String(error?.message ?? error) })
      }
    }
    if (value.length > 0) out[name] = value
  }
  return out
}

// 按 cookie 库路径分别去重：主库能复制成功不代表分区库的锁也释放了，
// 用一个全局变量会在每次"主库成功→分区库失败"之间来回重置，等于没去重。
const lastCookieErrors = new Map()
/**
 * 内存缓存：Windows 桌面端运行时会独占 cookie 库，成功读到一次后先缓存，
 * 这样用户重新打开 TeleAgent 也不会立刻让积分卡片失效。
 * 同时会把结果写进 DPAPI 加密的磁盘缓存，供 DSH 冷启动时使用。
 */
let portalAuthCache = null
const PORTAL_AUTH_CACHE_MS = 30 * 24 * 60 * 60 * 1000

/** 从 JWT 取过期时间（只解码，不验签） */
function tokenExpiryMs(token) {
  try {
    const payload = String(token ?? '').split('.')[1]
    if (!payload) return null
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null
  } catch {
    return null
  }
}

/** 缓存是否还能用（同账号、未过期） */
function cachedPortalAuth(scope) {
  if (!portalAuthCache || portalAuthCache.scope !== scope) return null
  if (portalAuthCache.expiresAt !== null && Date.now() >= portalAuthCache.expiresAt - 60_000) return null
  if (Date.now() - portalAuthCache.at >= PORTAL_AUTH_CACHE_MS) return null
  return portalAuthCache.auth
}

// ---------------------------------------------------------------- 磁盘缓存
//
// 桌面端运行时会一直锁着 cookie 库。如果 DSH 在这时重启，内存缓存就没了；
// 只靠 token.json 能拿到 operationToken，但拿不到 operToken。
// 因此把上次成功读到的两个 cookie 用 Chromium 同一把 DPAPI 主密钥加密后落盘，
// 下次冷启动在锁库状态下也能直接复用。只在本机、只对当前 Windows 用户可解。

const PORTAL_CACHE_VERSION = 1
let lastCacheError = null

function portalCacheFile() {
  const dshHome = process.env.DSH_HOME ?? path.join(process.env.HOME || os.homedir(), '.dsh')
  return path.join(dshHome, 'teleagent-portal-auth.bin')
}

function decryptWindowsCache(raw, dataDir) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  if (buf.length < 3 + 12 + 16 || buf.subarray(0, 3).toString() !== 'v10') {
    throw new Error('portal 缓存不是 v10 格式')
  }
  const key = readWindowsMasterKey(dataDir)
  const iv = buf.subarray(3, 15)
  const tag = buf.subarray(buf.length - 16)
  const ciphertext = buf.subarray(15, buf.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

function encryptWindowsCache(text, dataDir) {
  const key = readWindowsMasterKey(dataDir)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from('v10'), iv, ciphertext, cipher.getAuthTag()])
}

function loadDiskCache(home) {
  if (process.platform !== 'win32') return null
  try {
    const file = portalCacheFile()
    if (!fs.existsSync(file)) return null
    const data = JSON.parse(decryptWindowsCache(fs.readFileSync(file), appPaths(home).data))
    if (data?.version !== PORTAL_CACHE_VERSION) return null
    if (typeof data.scope !== 'string' || typeof data.operationToken !== 'string' || data.operationToken === '') {
      return null
    }
    const expiresAt = tokenExpiryMs(data.operationToken)
    if (expiresAt !== null && Date.now() >= expiresAt - 60_000) return null
    return {
      scope: data.scope,
      at: Number(data.savedAt) || Date.now(),
      expiresAt,
      auth: {
        userId: String(data.userId ?? ''),
        operationToken: data.operationToken,
        operToken: typeof data.operToken === 'string' ? data.operToken : '',
        source: typeof data.source === 'string' && data.source !== '' ? data.source : 'cache',
      },
    }
  } catch (error) {
    const message = String(error?.message ?? error)
    if (message !== lastCacheError) {
      lastCacheError = message
      bootlog('读取 portal 凭据缓存失败（忽略）', { error: message })
    }
    return null
  }
}

function saveDiskCache(home, scope, auth) {
  if (process.platform !== 'win32') return
  // 没有 operToken 的缓存没有价值，也不要覆盖已有的完整缓存
  if (typeof auth.operToken !== 'string' || auth.operToken === '') return
  try {
    const data = {
      version: PORTAL_CACHE_VERSION,
      scope,
      userId: auth.userId,
      operationToken: auth.operationToken,
      operToken: auth.operToken,
      source: auth.source,
      savedAt: Date.now(),
    }
    const file = portalCacheFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, encryptWindowsCache(JSON.stringify(data), appPaths(home).data))
  } catch (error) {
    const message = String(error?.message ?? error)
    if (message !== lastCacheError) {
      lastCacheError = message
      bootlog('写入 portal 凭据缓存失败（忽略）', { error: message })
    }
  }
}

/**
 * 复制 cookie 库到临时文件后读取（桌面端运行时会锁住原文件）。
 * 只取 portal 需要的两个 cookie。
 */
function readCookiesFrom(dbPath, dataDir) {
  if (!fs.existsSync(dbPath)) return null
  const tmp = path.join(os.tmpdir(), `te-ck-${process.pid}-${Date.now()}.db`)
  const out = {}
  try {
    fs.copyFileSync(dbPath, tmp)
    // 这个库这次能复制成功，说明它的锁已经释放；下次再锁可以重新记一条
    lastCookieErrors.delete(dbPath)

    const DatabaseSync = loadDatabaseSync()
    if (DatabaseSync !== null) {
      const db = new DatabaseSync(tmp)
      try {
        const rows = db.prepare(
          "select name, value, encrypted_value, host_key from cookies where name in ('operationToken','operToken')",
        ).all()
        const cookies = extractCookies(rows, dataDir)
        return Object.keys(cookies).length > 0 ? cookies : null
      } finally {
        db.close()
      }
    }

    // 老宿主没有 node:sqlite 时退回 sqlite3 命令（只能读明文 value）
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
    // 错误信息里带着带时间戳的临时文件名，直接比较会让去重失效（每 15 秒刷一行）
    const code = String(error?.code ?? '')
    const message = String(error?.message ?? error).split(tmp).join('<tmp>')
    const key = `${dbPath}|${code}|${message}`
    if (key !== lastCookieErrors.get(dbPath)) {
      lastCookieErrors.set(dbPath, key)
      bootlog('读取 portal cookie 失败（桌面端运行时属正常，已回退 token.json）', { dbPath, code, error: message })
    }
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
/**
 * 读取 portal 凭据。
 *
 * 关键事实（Windows 2.7.1 实测）：`operationToken` cookie 的值与
 * `token.json` 解密出来的登录 JWT **完全相同**。因此 cookie 库被桌面端
 * 独占锁住时，仍可以用 token.json 作为 operationToken；cookie 只用来补
 * `operToken`（有就用，没有也不阻塞）。
 *
 * @param {string} [home]
 * @param {string} [explicitScope] 指定账号目录名；省略则用当前账号
 */
export function readPortalAuth(home = process.env.HOME, explicitScope) {
  const hasExplicitScope = typeof explicitScope === 'string' && explicitScope !== ''

  let diag = null
  try {
    diag = diagnoseCredential(home, hasExplicitScope ? explicitScope : undefined)
  } catch { /* 诊断失败时继续尝试 cookie */ }

  let scope = hasExplicitScope ? explicitScope : (diag?.scope ?? '')
  if (!scope) {
    try { scope = currentScope(appPaths(home).data) } catch { return null }
  }

  const userId = userIdFromScope(scope)
    || (diag?.claims?.accountId != null ? String(diag.claims.accountId) : '')
  if (!userId) return null

  const userData = appPaths(home).data
  const partitionDir = path.join(userData, 'Partitions', `owner%3A${scope}`)
  // Windows 版 Chromium 把 cookie 放在 <partition>/Network/Cookies；
  // 旧版/旧平台放在 <partition>/Cookies。两种都试。
  const candidates = [
    path.join(partitionDir, 'Network', 'Cookies'),
    path.join(partitionDir, 'Cookies'),
    path.join(userData, 'Partitions', `owner:${scope}`, 'Network', 'Cookies'),
    path.join(userData, 'Partitions', `owner:${scope}`, 'Cookies'),
  ]
  // 主 cookie 库只在"没指定账号"时兜底：
  // 指定账号却回落到主库，会把当前账号的凭据当成别人的，余额就串了。
  if (!hasExplicitScope) {
    candidates.push(path.join(userData, 'Network', 'Cookies'))
    candidates.push(path.join(userData, 'Cookies'))
  }

  let operationToken = ''
  let operToken = ''
  let source = ''

  for (const dbPath of candidates) {
    const cookies = readCookiesFrom(dbPath, userData)
    if (!cookies) continue
    if (operationToken === '' && cookies.operationToken) {
      operationToken = cookies.operationToken
      source = dbPath
    }
    if (operToken === '' && cookies.operToken) operToken = cookies.operToken
    if (operationToken !== '' && operToken !== '') break
  }

  // cookie 读不到（桌面端运行中会锁库）时，token.json 里的登录 JWT 就是 operationToken
  if (operationToken === '' && diag?.ok === true && typeof diag.token === 'string') {
    operationToken = diag.token
    source = path.join(userData, 'users', scope, 'app-auth', 'token.json')
  }

  // 冷启动且 cookie 库被锁时，磁盘缓存里的 operToken 是唯一来源
  if (portalAuthCache === null) {
    const disk = loadDiskCache(home)
    if (disk !== null) portalAuthCache = disk
  }

  const cached = cachedPortalAuth(scope)
  if (operToken === '' && cached?.operToken) operToken = cached.operToken

  if (operationToken === '') return cached

  const previous = portalAuthCache
  const auth = { userId, operationToken, operToken, source }
  const expiresAt = tokenExpiryMs(operationToken)
    ?? (typeof diag?.expiresAt === 'number' ? diag.expiresAt : null)
  // 只在凭据变化时落盘，避免每 15 秒重写一次
  if (operToken !== '' && (previous === null
    || previous.auth.operationToken !== operationToken
    || previous.auth.operToken !== operToken)) {
    saveDiskCache(home, scope, auth)
  }
  portalAuthCache = { scope, at: Date.now(), expiresAt, auth }
  return auth
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
