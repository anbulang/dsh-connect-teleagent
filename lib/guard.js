/**
 * 上游调用防护：并发节流 + 认证失败熔断。
 *
 * ## 为什么需要
 *
 * 插件直连 TeleAgent 上游，行为模式是唯一可控的风险变量。实测过的教训：
 * 短时间内几十次 401（签名探测）足以让账号被离线风控标记。
 * 因此这里做两件事：
 *
 *  1. **并发节流**：同时最多 N 个上游请求，其余排队。
 *     官方客户端是人工交互，天然低并发；DSH 可能并行调用多个模型。
 *  2. **熔断**：连续 M 次 401/403 后暂停一段时间，直接快速失败。
 *     避免「凭据失效/账号被封」时被 DSH 的重试逻辑放大成持续异常流量。
 *
 * 熔断冷却结束后进入半开状态：只放行一个请求试探，成功则闭合。
 */
import { bootlog } from './bootlog.js'

export const DEFAULT_GUARD = {
  maxConcurrent: 2,
  failureThreshold: 3,
  cooldownMs: 10 * 60 * 1000,
  /** 连续失败计数只由这些状态码触发（认证/权限类） */
  authFailureStatuses: [401, 403],
  /** 每分钟最多发起的上游请求数（防突发；0 = 不限制） */
  maxPerMinute: 20,
}

/** 熔断打开时抛出，调用方据此快速失败 */
export class GuardBlockedError extends Error {
  constructor(retryAfterMs, reason) {
    super(`上游调用已暂停：${reason}`);
    this.name = 'GuardBlockedError'
    this.code = 'circuit_open'
    this.circuitOpen = true
    this.retryAfterMs = retryAfterMs
    this.reason = reason
  }
}

/**
 * @param {Partial<typeof DEFAULT_GUARD>} [options]
 * @param {() => number} [options.now] 可注入时钟（测试用）
 */
export function createGuard(options = {}, now = () => Date.now()) {
  const cfg = { ...DEFAULT_GUARD, ...options }
  const maxConcurrent = Math.max(1, Number(cfg.maxConcurrent) || 1)
  const failureThreshold = Math.max(1, Number(cfg.failureThreshold) || 1)
  const cooldownMs = Math.max(0, Number(cfg.cooldownMs) || 0)

  let active = 0
  const waiters = []

  let consecutiveFailures = 0
  let openUntil = 0
  let halfOpenProbeInFlight = false
  let lastReason = null
  let lastFailureAt = null
  let totalRejected = 0
  // 分钟级限速窗口
  let windowStart = 0
  let windowCount = 0
  let totalThrottled = 0

  function acquire() {
    if (active < maxConcurrent) {
      active++
      return Promise.resolve()
    }
    return new Promise((resolve) => waiters.push(resolve))
  }

  function release() {
    active--
    const next = waiters.shift()
    if (next) {
      active++
      next()
    }
  }

  /** 熔断是否处于打开状态；到点则切半开 */
  function isOpen() {
    if (openUntil === 0) return false
    if (now() < openUntil) return true
    // 冷却结束：进入半开（openUntil 保留，由下一次 observe 决定闭合或重开）
    return false
  }

  return {
    config: cfg,

    /**
     * 请求前检查。熔断打开时抛 GuardBlockedError。
     * 半开状态下只放行一个试探请求。
     */
    check() {
      if (openUntil === 0) return
      const remaining = openUntil - now()
      if (remaining > 0) {
        totalRejected++
        throw new GuardBlockedError(remaining, lastReason ?? '连续认证失败')
      }
      // 冷却已过：半开，只允许一个探测
      if (halfOpenProbeInFlight) {
        totalRejected++
        throw new GuardBlockedError(cooldownMs, '半开状态已有探测请求在途')
      }
      halfOpenProbeInFlight = true
    },

    /**
     * 分钟级限速：超过 maxPerMinute 就等到下一个窗口。
     *
     * 目的不是性能，而是**避免突发**：短时间内几十个请求是最容易被风控标记的形态。
     */
    async throttle() {
      const limit = Number(cfg.maxPerMinute) || 0
      if (limit <= 0) return
      const nowMs = now()
      if (nowMs - windowStart >= 60_000) {
        windowStart = nowMs
        windowCount = 0
      }
      if (windowCount < limit) { windowCount++; return }
      const waitMs = Math.max(0, 60_000 - (nowMs - windowStart))
      totalThrottled++
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 60_000)))
      windowStart = now()
      windowCount = 1
    },

    /** 在并发槽内执行 fn */
    async withSlot(fn) {
      await this.throttle()
      await acquire()
      try {
        return await fn()
      } finally {
        release()
      }
    },

    /** 记录一次上游响应状态 */
    observe(status) {
      const numeric = Number(status)
      if (cfg.authFailureStatuses.includes(numeric)) {
        consecutiveFailures++
        lastReason = `连续 ${consecutiveFailures} 次认证失败（HTTP ${numeric}）`
        lastFailureAt = now()
        halfOpenProbeInFlight = false
        // 半开探测失败：立即重新打开
        if (openUntil !== 0) {
          openUntil = now() + cooldownMs
          bootlog('熔断：探测失败，重新打开', { consecutiveFailures, cooldownMs })
        } else if (consecutiveFailures >= failureThreshold) {
          openUntil = now() + cooldownMs
          bootlog('熔断：打开', { consecutiveFailures, cooldownMs, reason: lastReason })
        }
        return
      }
      // 任何非认证失败（含 2xx / 4xx 业务错误 / 5xx）都视为链路可用，重置计数
      if (consecutiveFailures !== 0 || openUntil !== 0) {
        bootlog('熔断：闭合', { previousFailures: consecutiveFailures, status: numeric })
      }
      consecutiveFailures = 0
      openUntil = 0
      halfOpenProbeInFlight = false
      lastReason = null
    },

    /** 供状态卡片/doctor 读取 */
    snapshot() {
      const open = isOpen()
      const remaining = openUntil === 0 ? 0 : Math.max(0, openUntil - now())
      return {
        open,
        cooldownRemainingMs: open ? remaining : 0,
        consecutiveFailures,
        failureThreshold,
        maxConcurrent,
        active,
        queued: waiters.length,
        totalRejected,
        totalThrottled,
        maxPerMinute: cfg.maxPerMinute,
        lastReason,
        lastFailureAt,
      }
    },

    /** 手动复位（登录成功后调用，避免旧账号的熔断状态影响新账号） */
    reset() {
      consecutiveFailures = 0
      openUntil = 0
      halfOpenProbeInFlight = false
      lastReason = null
      lastFailureAt = null
    },
  }
}
