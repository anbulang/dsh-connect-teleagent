/**
 * 防护层测试：并发节流 + 认证失败熔断。
 *
 * 用注入时钟验证状态机，不依赖真实时间与网络。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createGuard, GuardBlockedError, DEFAULT_GUARD } from '../lib/guard.js'

const mk = (opts = {}) => {
  let t = 1_000_000
  const guard = createGuard({ failureThreshold: 3, cooldownMs: 60_000, maxConcurrent: 2, ...opts }, () => t)
  return { guard, advance: (ms) => { t += ms }, now: () => t }
}

// ------------------------------------------------------------ 熔断
test('熔断：未达阈值不打开', () => {
  const { guard } = mk()
  guard.observe(401)
  guard.observe(401)
  assert.equal(guard.snapshot().open, false)
  assert.equal(guard.snapshot().consecutiveFailures, 2)
})

test('熔断：连续 3 次 401 后打开', () => {
  const { guard } = mk()
  guard.observe(401)
  guard.observe(401)
  guard.observe(401)
  const s = guard.snapshot()
  assert.equal(s.open, true)
  assert.ok(s.cooldownRemainingMs > 0)
  assert.match(s.lastReason, /认证失败/)
})

test('熔断：打开后 check() 抛 GuardBlockedError', () => {
  const { guard } = mk()
  for (let i = 0; i < 3; i++) guard.observe(403)
  assert.throws(() => guard.check(), (e) => {
    assert.ok(e instanceof GuardBlockedError)
    assert.equal(e.code, 'circuit_open')
    assert.ok(e.retryAfterMs > 0)
    return true
  })
})

test('熔断：冷却结束后半开，只放行一个探测', () => {
  const { guard, advance } = mk()
  for (let i = 0; i < 3; i++) guard.observe(401)
  advance(61_000)
  assert.equal(guard.snapshot().open, false)
  guard.check() // 第一个探测放行
  assert.throws(() => guard.check(), (e) => e.code === 'circuit_open')
})

test('熔断：半开探测成功则闭合并清零', () => {
  const { guard, advance } = mk()
  for (let i = 0; i < 3; i++) guard.observe(401)
  advance(61_000)
  guard.check()
  guard.observe(200)
  const s = guard.snapshot()
  assert.equal(s.open, false)
  assert.equal(s.consecutiveFailures, 0)
  assert.doesNotThrow(() => guard.check())
})

test('熔断：半开探测失败则重新打开', () => {
  const { guard, advance } = mk()
  for (let i = 0; i < 3; i++) guard.observe(401)
  advance(61_000)
  guard.check()
  guard.observe(401)
  assert.equal(guard.snapshot().open, true)
})

test('熔断：非认证失败（如 5xx/429）重置计数不打开', () => {
  const { guard } = mk()
  guard.observe(401)
  guard.observe(401)
  guard.observe(500)
  assert.equal(guard.snapshot().consecutiveFailures, 0)
  assert.equal(guard.snapshot().open, false)
})

test('熔断：成功请求清零连续失败', () => {
  const { guard } = mk()
  guard.observe(401)
  guard.observe(401)
  guard.observe(200)
  assert.equal(guard.snapshot().consecutiveFailures, 0)
})

test('熔断：reset() 立即恢复可用', () => {
  const { guard } = mk()
  for (let i = 0; i < 3; i++) guard.observe(401)
  assert.equal(guard.snapshot().open, true)
  guard.reset()
  assert.equal(guard.snapshot().open, false)
  assert.doesNotThrow(() => guard.check())
})

test('熔断：阈值可配置', () => {
  const { guard } = mk({ failureThreshold: 1 })
  guard.observe(401)
  assert.equal(guard.snapshot().open, true)
})

// ------------------------------------------------------------ 并发节流
test('并发：最多 2 个同时在途，其余排队', async () => {
  const { guard } = mk({ maxConcurrent: 2, failureThreshold: 99 })
  let running = 0
  let peak = 0
  const task = () => guard.withSlot(async () => {
    running++
    peak = Math.max(peak, running)
    await new Promise((r) => setTimeout(r, 20))
    running--
  })
  await Promise.all([task(), task(), task(), task(), task()])
  assert.equal(peak, 2, `峰值并发应为 2，实际 ${peak}`)
})

test('并发：全部任务最终都执行', async () => {
  const { guard } = mk({ maxConcurrent: 1, failureThreshold: 99 })
  let done = 0
  const task = () => guard.withSlot(async () => {
    await new Promise((r) => setTimeout(r, 5))
    done++
  })
  await Promise.all([task(), task(), task()])
  assert.equal(done, 3)
})

test('并发：fn 抛错也会释放槽位', async () => {
  const { guard } = mk({ maxConcurrent: 1, failureThreshold: 99 })
  await assert.rejects(guard.withSlot(async () => { throw new Error('boom') }))
  // 槽位已释放，下一次应能立即执行
  const v = await guard.withSlot(async () => 'ok')
  assert.equal(v, 'ok')
})

test('快照：包含卡片需要的字段', () => {
  const { guard } = mk()
  const s = guard.snapshot()
  for (const k of ['open', 'cooldownRemainingMs', 'consecutiveFailures', 'failureThreshold', 'maxConcurrent', 'active', 'queued', 'lastReason']) {
    assert.ok(k in s, `快照缺少 ${k}`)
  }
})

test('默认配置合理', () => {
  assert.equal(DEFAULT_GUARD.maxConcurrent, 2)
  assert.equal(DEFAULT_GUARD.failureThreshold, 3)
  assert.equal(DEFAULT_GUARD.cooldownMs, 10 * 60 * 1000)
})

// ------------------------------------------------------------ 分钟级限速
test('限速：每分钟上限内不等待', async () => {
  const { guard } = mk({ maxPerMinute: 5, maxConcurrent: 1 })
  const started = Date.now()
  for (let i = 0; i < 5; i++) await guard.throttle()
  assert.ok(Date.now() - started < 50, '未超限不应等待')
  assert.equal(guard.snapshot().totalThrottled, 0)
})

test('限速：可关闭（0 = 不限制）', async () => {
  const { guard } = mk({ maxPerMinute: 0 })
  const started = Date.now()
  for (let i = 0; i < 100; i++) await guard.throttle()
  assert.ok(Date.now() - started < 50)
})

test('限速：快照暴露配置与触发次数', () => {
  const { guard } = mk({ maxPerMinute: 7 })
  const s = guard.snapshot()
  assert.equal(s.maxPerMinute, 7)
  assert.equal(typeof s.totalThrottled, 'number')
})

test('限速：默认值存在且合理', () => {
  assert.equal(DEFAULT_GUARD.maxPerMinute, 20)
})
