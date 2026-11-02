/**
 * 积分福利：余额缓存 + 每日自动领取。
 *
 * ## 设计要点
 *
 * 1. **不能每次状态轮询都打接口**：设置卡片每 15 秒拉一次 `/status`，
 *    所以积分走缓存（默认 60 秒），领取检查独立走自己的节奏（默认 6 小时）。
 * 2. **领取必须幂等**：先看 `claimed_today`，再看本地记录，两道闸；
 *    领取成功后再查一次确认，避免"接口 200 但没发积分"。
 * 3. **绝不影响模型可用**：任何失败只记录并在卡片上提示，不抛错、不阻塞。
 */
import { fetchDailyStatus, claimDaily, fetchPoints } from './portal.js'
import { bootlog } from './bootlog.js'

export const DEFAULT_WELFARE = {
  autoClaimDaily: true,
  // 余额缓存：15 秒内不重复打上游（对话结束后会被 markStale 提前作废）
  pointsTtlMs: 60_000,
  // 未领时每小时看一次；已领则拉长到 8 小时
  claimIntervalMs: 60 * 60 * 1000,
  claimedIntervalMs: 8 * 60 * 60 * 1000,
  // 连续失败后间隔翻倍，上限 8 小时
  maxBackoffMs: 8 * 60 * 60 * 1000,
  failureBackoffAfter: 2,
}

/** 本地日期键（用于"今天是否已领"） */
export function localDateKey(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 纯判定：今天是否应该尝试领取。
 *
 * @param {object} p
 * @param {string} p.today 本地日期键
 * @param {string|null} p.lastClaimDate 上次成功领取的本地日期键
 * @param {boolean} [p.claimedToday] 上游说今天已领
 */
export function shouldClaimToday({ today, lastClaimDate, claimedToday = false }) {
  if (claimedToday) return false
  return lastClaimDate !== today
}

/**
 * @param {object} options
 * @param {() => Promise<object|null>} options.getAuth 返回 portal 凭据（可能为 null）
 * @param {object} options.store readStore/writeStore 适配器：{ read, write }
 * @param {object} [options.logger]
 * @param {() => Date} [options.now]
 */
export function createWelfare({ getAuth, store, logger, now = () => new Date(), portal }, overrides = {}) {
  const cfg = { ...DEFAULT_WELFARE, ...overrides }
  // 依赖注入：默认用真实 portal，测试可传假实现（避免测一份复制品）
  const api = portal ?? { fetchPoints, fetchDailyStatus, claimDaily }

  /** @type {{balance:number|null, expiresAt:string|null, planName:string|null, at:number, error:string|null}} */
  let pointsCache = { balance: null, expiresAt: null, planName: null, at: 0, error: null }
  /** @type {{ok:boolean, claimedToday:boolean, claimable:number, totalDays:number, totalPoints:number, at:number, error:string|null}} */
  let dailyCache = { ok: false, claimedToday: false, claimable: 0, totalDays: 0, totalPoints: 0, activity: null, at: 0, error: null }
  let lastClaimAttempt = 0
  let lastClaimResult = null
  let failureCount = 0
  let timer = null
  let firstTimer = null
  let stopped = false

  const readWelfare = () => {
    const raw = store.read()?.welfare
    return {
      autoClaimDaily: raw?.autoClaimDaily !== false,
      lastClaimDate: typeof raw?.lastClaimDate === 'string' ? raw.lastClaimDate : null,
      lastClaimPoints: Number(raw?.lastClaimPoints ?? 0),
      lastClaimOk: raw?.lastClaimOk === true,
      lastClaimAt: raw?.lastClaimAt ?? null,
    }
  }

  const writeWelfare = (patch) => {
    const current = readWelfare()
    try { store.write({ welfare: { ...current, ...patch } }) } catch { /* 持久化失败不影响功能 */ }
  }

  /**
   * 标记余额已过期。
   *
   * 一次对话结束就消耗了积分，此时余额已经不准了；但也不必立刻发请求——
   * 让下一次读取（胶囊每 3 秒轮询本地接口）触发真正的刷新即可。
   */
  function markStale() {
    pointsCache = { ...pointsCache, stale: true }
  }

  /** 刷新积分余额（受 TTL 与 stale 标记保护） */
  async function refreshPoints(force = false) {
    const fresh = Date.now() - pointsCache.at < cfg.pointsTtlMs && !pointsCache.stale
    if (!force && fresh) return pointsCache
    const auth = await getAuth()
    if (!auth) {
      pointsCache = { ...pointsCache, at: Date.now(), error: '未登录（缺少 portal 凭据）' }
      return pointsCache
    }
    const result = await api.fetchPoints(auth)
    pointsCache = result.ok
      ? { balance: result.balance, expiresAt: result.expiresAt, at: Date.now(), error: null, stale: false }
      : { ...pointsCache, at: Date.now(), error: result.error, stale: false }
    return pointsCache
  }

  /** 刷新每日领取状态（只读） */
  async function refreshDaily(force = false) {
    if (!force && Date.now() - dailyCache.at < cfg.pointsTtlMs) return dailyCache
    const auth = await getAuth()
    if (!auth) {
      dailyCache = { ...dailyCache, at: Date.now(), error: '未登录（缺少 portal 凭据）' }
      return dailyCache
    }
    const r = await api.fetchDailyStatus(auth)
    dailyCache = r.ok
      ? { ok: true, claimedToday: r.claimedToday, claimable: r.claimable, totalDays: r.totalDays, totalPoints: r.totalPoints, activity: r.activity ?? null, at: Date.now(), error: null }
      : { ...dailyCache, at: Date.now(), error: r.error }
    return dailyCache
  }

  /**
   * 领取（手动或自动）。
   * @returns {Promise<object>} 结果快照
   */
  async function claim({ source = 'manual' } = {}) {
    const auth = await getAuth()
    if (!auth) return { ok: false, claimed: false, error: '未登录（缺少 portal 凭据）' }

    const today = localDateKey(now())
    const local = readWelfare()
    // 不强制刷新：定时任务刚查过就用缓存（TTL 15 秒），少打一次上游
    const daily = await refreshDaily()

    if (daily.ok && daily.claimedToday) {
      lastClaimResult = { ok: true, claimed: false, alreadyClaimed: true }
      writeWelfare({ lastClaimDate: today, lastClaimOk: true, lastClaimPoints: 0, lastClaimAt: now().toISOString() })
      return lastClaimResult
    }

    const result = await api.claimDaily(auth)
    lastClaimAttempt = Date.now()
    lastClaimResult = result

    if (result.ok) {
      writeWelfare({
        lastClaimDate: today,
        lastClaimOk: result.claimed === true,
        lastClaimPoints: result.points ?? 0,
        lastClaimAt: now().toISOString(),
      })
      bootlog('领取结果', { source, ...result })
      // 领取后立刻刷新余额与状态
      await Promise.all([refreshPoints(true), refreshDaily(true)])
    } else {
      writeWelfare({ lastClaimOk: false, lastClaimAt: now().toISOString() })
      bootlog('领取失败', { source, error: result.error })
    }
    return result
  }

  /** 定时任务体：满足条件才领 */
  /**
   * 定时任务体。
   *
   * 关键优化：**当天已领就不再发任何网络请求**。
   * 否则每次启动/每轮定时都要打一次 `checkDayTask`，纯属浪费——
   * 领取状态是按天变化的，本地 already-known 就是足够的依据。
   */
  async function tick() {
    if (stopped) return
    try {
      const local = readWelfare()
      const today = localDateKey(now())
      const claimedLocallyToday = local.lastClaimDate === today && local.lastClaimOk === true

      // 已领过：只刷新余额（可选），不查领取状态、不尝试领取
      if (claimedLocallyToday) {
        if (cfg.autoClaimDaily && local.autoClaimDaily !== false) {
          // 余额仍需要刷新（用户可能在别处消耗），但失败不放大
          await refreshPoints().catch(() => {})
        }
        return
      }

      const daily = await refreshDaily()
      await refreshPoints().catch(() => {})

      if (!cfg.autoClaimDaily || local.autoClaimDaily === false) return
      if (!shouldClaimToday({ today, lastClaimDate: local.lastClaimDate, claimedToday: daily.claimedToday })) return
      // 接口持续失败时不要频繁重试
      if (lastClaimResult?.ok === false && failureCount >= cfg.failureBackoffAfter
          && Date.now() - lastClaimAttempt < failureBackoffMs()) return

      const result = await claim({ source: 'auto' })
      if (result.ok) { failureCount = 0 } else { failureCount++ }
    } catch (error) {
      failureCount++
      bootlog('福利定时任务异常', { error: String(error?.message ?? error), failureCount })
      logger?.warn?.('dsh-connect-teleagent: 福利任务异常', error?.message ?? error)
    }
  }

  /** 指数退避：失败次数越多间隔越长，上限 maxBackoffMs */
  function failureBackoffMs() {
    const base = cfg.claimIntervalMs
    const factor = Math.pow(2, Math.max(0, failureCount - cfg.failureBackoffAfter + 1))
    return Math.min(base * factor, cfg.maxBackoffMs)
  }

  /** 当前应使用的轮询间隔（已领 → 长间隔；连续失败 → 指数退避） */
  function currentIntervalMs() {
    const local = readWelfare()
    const claimedToday = local.lastClaimDate === localDateKey(now()) && local.lastClaimOk === true
    const base = claimedToday ? cfg.claimedIntervalMs : cfg.claimIntervalMs
    if (failureCount >= cfg.failureBackoffAfter) return Math.max(base, failureBackoffMs())
    return base
  }

  /** 用递归 setTimeout 代替固定 interval：每轮结束后按最新状态决定下次间隔 */
  function scheduleNext() {
    if (stopped) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(async () => {
      await tick()
      scheduleNext()
    }, currentIntervalMs())
    if (typeof timer.unref === 'function') timer.unref()
  }

  /**
   * 保证数据是新鲜的：过期或被标记 stale 时**在这里**触发刷新。
   *
   * 之前的实现只把缓存标记成 stale，却没有任何读者去消费这个标记，
   * 结果就是"对话结束后余额永远不更新，必须手动点刷新"。
   * 现在读取路径统一走这里：胶囊每 3 秒轮询一次本机接口 →
   * 需要刷新时就在这里刷，不需要时纯读缓存（零上游请求）。
   */
  async function ensureFresh({ maxAgeMs } = {}) {
    const ttl = typeof maxAgeMs === 'number' ? maxAgeMs : cfg.pointsTtlMs
    const nowMs = Date.now()
    const pointsExpired = pointsCache.at === 0 || pointsCache.stale === true || (nowMs - pointsCache.at) >= ttl
    const dailyExpired = dailyCache.at === 0 || (nowMs - dailyCache.at) >= ttl

    // 并行刷新；任一失败都不影响返回旧值
    await Promise.all([
      pointsExpired ? refreshPoints(true).catch(() => {}) : Promise.resolve(),
      dailyExpired ? refreshDaily(true).catch(() => {}) : Promise.resolve(),
    ])
    return snapshot()
  }

  /** 快照：只读缓存，不触发网络 */
  function snapshot() {
    const local = readWelfare()
    const today = localDateKey(now())
    return {
      configured: true,
      autoClaimDaily: local.autoClaimDaily,
      balance: pointsCache.balance,
      expiresAt: pointsCache.expiresAt,
      pointsError: pointsCache.error,
      pointsStaleMs: pointsCache.at > 0 ? Date.now() - pointsCache.at : null,
      pointsStale: pointsCache.stale === true,
      daily: {
        ok: dailyCache.ok,
        claimable: dailyCache.claimable,
        claimedToday: dailyCache.claimedToday,
        totalDays: dailyCache.totalDays,
        totalPoints: dailyCache.totalPoints,
        activity: dailyCache.activity,
        error: dailyCache.error,
      },
      lastClaimDate: local.lastClaimDate,
      lastClaimPoints: local.lastClaimPoints,
      lastClaimOk: local.lastClaimOk,
      lastClaimAt: local.lastClaimAt,
      canClaimToday: shouldClaimToday({ today, lastClaimDate: local.lastClaimDate, claimedToday: dailyCache.claimedToday }),
    }
  }

  return {
    /** 立即跑一次（启动时调用） */
    async prime() {
      await tick()
    },

    /** 一次对话结束后调用：余额需要重算 */
    markStale,

    /** 手动领取 */
    claim,

    /** 手动刷新（卡片按钮） */
    async refreshAll() {
      await Promise.all([refreshPoints(true), refreshDaily(true)])
      return snapshot()
    },

    /** 供状态接口读取的快照（不触发网络） */
    snapshot,

    /** 读取前确保新鲜（过期/stale 时自动刷新） */
    ensureFresh,

    /** 自动领取开关 */
    setAutoClaimDaily(enabled) {
      writeWelfare({ autoClaimDaily: enabled === true })
    },

    /** 当前应使用的轮询间隔（已领 → 长间隔；连续失败 → 指数退避） */
    intervalMs: currentIntervalMs,

    start() {
      if (timer !== null) return
      // 首个 tick 延后一点，让 DSH 先把界面拉起来
      firstTimer = setTimeout(() => { void tick() }, 5000)
      if (typeof firstTimer.unref === 'function') firstTimer.unref()
      scheduleNext()
    },

    stop() {
      stopped = true
      if (timer !== null) { clearTimeout(timer); timer = null }
      if (firstTimer !== null) { clearTimeout(firstTimer); firstTimer = null }
    },
  }
}
