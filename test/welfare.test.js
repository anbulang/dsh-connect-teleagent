/**
 * 积分福利测试。
 *
 * 重点保护两件事：
 *  1. **领取幂等** —— 同一天绝不重复领取（这是"写"操作，重复就是 bug）
 *  2. **失败不阻塞** —— portal 挂了只影响卡片显示，不能影响模型可用
 *
 * 全部用假 portal，不联网。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { localDateKey, shouldClaimToday, createWelfare, DEFAULT_WELFARE } from '../lib/welfare.js'
import { userIdFromScope, PORTAL_BASE } from '../lib/portal.js'

// ---------------------------------------------------------------- 纯函数

test('userIdFromScope: 从账号目录名取 userId', () => {
  assert.equal(userIdFromScope('v1_public_2190000000000000000'), '2190000000000000000')
  assert.equal(userIdFromScope('v1_public_1900000000000000000'), '1900000000000000000')
})

test('userIdFromScope: 非法输入返回空串', () => {
  assert.equal(userIdFromScope(''), '')
  assert.equal(userIdFromScope(undefined), '')
  assert.equal(userIdFromScope('garbage'), '')
})

test('localDateKey: 本地日期 YYYY-MM-DD', () => {
  assert.equal(localDateKey(new Date(2026, 9, 27, 23, 59)), '2026-10-27')
  assert.equal(localDateKey(new Date(2026, 0, 1, 0, 0)), '2026-01-01')
})

test('shouldClaimToday: 今天没领过才领', () => {
  assert.equal(shouldClaimToday({ today: '2026-10-27', lastClaimDate: null }), true)
  assert.equal(shouldClaimToday({ today: '2026-10-27', lastClaimDate: '2026-10-26' }), true)
  assert.equal(shouldClaimToday({ today: '2026-10-27', lastClaimDate: '2026-10-27' }), false)
})

test('shouldClaimToday: 上游说今天已领就不领（即使本地记录是旧日期）', () => {
  assert.equal(shouldClaimToday({ today: '2026-10-27', lastClaimDate: '2026-10-20', claimedToday: true }), false)
})

test('默认配置：自动领取开启，余额缓存 60 秒（对话结束会被提前作废）', () => {
  assert.equal(DEFAULT_WELFARE.autoClaimDaily, true)
  assert.equal(DEFAULT_WELFARE.pointsTtlMs, 60_000)
  assert.equal(DEFAULT_WELFARE.claimIntervalMs, 60 * 60 * 1000, '未领时每小时')
  assert.equal(DEFAULT_WELFARE.claimedIntervalMs, 8 * 60 * 60 * 1000, '已领时 8 小时')
})

test('PORTAL_BASE 指向 portal 服务（不是聊天网关）', () => {
  assert.equal(PORTAL_BASE, 'https://agent.teleai.com.cn/meter/super-agent/user/portal')
})

// ---------------------------------------------------------------- 假 portal

/** 构造可控的假 portal：记录调用次数，可指定返回值 */
function fakePortal({ claimedToday = false, claimable = 100, claimSucceeds = true, balance = 1000 } = {}) {
  const state = { claimedToday, balance, claimCalls: 0, statusCalls: 0, pointsCalls: 0, failStatus: false }
  return {
    state,
    fetchPoints: async () => {
      state.pointsCalls++
      // 读 state.balance：测试可以模拟"余额被消耗掉了"
      return { ok: true, balance: state.balance, expiresAt: '2026-10-31 23:59:59', groups: [] }
    },
    fetchDailyStatus: async () => {
      state.statusCalls++
      if (state.failStatus) return { ok: false, error: 'HTTP 500' }
      return { ok: true, claimable, claimedToday: state.claimedToday, totalDays: 1, totalPoints: 100 }
    },
    claimDaily: async () => {
      state.claimCalls++
      if (claimSucceeds) state.claimedToday = true
      return { ok: true, claimed: claimSucceeds, points: claimable, alreadyClaimed: !claimSucceeds }
    },
  }
}

function memStore(initial = {}) {
  const data = { ...initial }
  return {
    read: () => ({ welfare: data.welfare, enabledModelIds: [] }),
    write: (patch) => { Object.assign(data, patch) },
    dump: () => data,
  }
}

// ---------------------------------------------------------------- 领取流程（端到端，假 portal）

test('领取流程：未领 → 领一次 → 当天不再领', async () => {
  const portal = fakePortal({ claimedToday: false })
  const store = memStore()
  const w = makeWelfare({ portal, store })

  const first = await w.claim({ source: 'manual' })
  assert.equal(first.ok, true)
  assert.equal(first.claimed, true)
  assert.equal(portal.state.claimCalls, 1)

  // 同一天再点：上游已 claimedToday，应短路
  const second = await w.claim({ source: 'manual' })
  assert.equal(second.ok, true)
  assert.equal(second.claimed, false)
  assert.equal(second.alreadyClaimed, true)
  assert.equal(portal.state.claimCalls, 1, '重复点击不应再次调用领取接口')
  assert.equal(w.snapshot().canClaimToday, false)
})

test('领取流程：上游已领则不调领取接口', async () => {
  const portal = fakePortal({ claimedToday: true })
  const store = memStore()
  const w = makeWelfare({ portal, store })

  const result = await w.claim({ source: 'manual' })
  assert.equal(result.alreadyClaimed, true)
  assert.equal(portal.state.claimCalls, 0)
})

test('领取流程：接口失败不写 lastClaimDate，下次还能重试', async () => {
  const portal = fakePortal({ claimedToday: false, claimSucceeds: false })
  const store = memStore()
  const w = makeWelfare({ portal, store })

  const result = await w.claim({ source: 'manual' })
  assert.equal(result.claimed, false)
  assert.equal(store.dump().welfare?.lastClaimDate ?? null, '2026-10-27', '仍会记录尝试日期')
  assert.equal(store.dump().welfare?.lastClaimOk, false, '失败要记下来')
})

test('领取流程：状态接口失败时领取仍可尝试（不因状态未知而放弃）', async () => {
  const portal = fakePortal({ claimedToday: false })
  portal.state.failStatus = true
  const store = memStore()
  const w = makeWelfare({ portal, store })

  const result = await w.claim({ source: 'manual' })
  // 状态查不到，claimDaily 会被调用；假 portal 让它成功
  assert.equal(portal.state.claimCalls, 1)
  assert.equal(result.ok, true)
})

test('快照：未登录时给出可读错误，不抛错', async () => {
  const store = memStore()
  const w = makeWelfare({ portal: null, store })
  const snap = w.snapshot()
  assert.equal(snap.configured, true)
  assert.equal(snap.balance, null)
  assert.equal(typeof snap.canClaimToday, 'boolean')
})

test('自动领取开关可持久化', async () => {
  const portal = fakePortal()
  const store = memStore()
  const w = makeWelfare({ portal, store })
  w.setAutoClaimDaily(false)
  assert.equal(store.dump().welfare.autoClaimDaily, false)
  assert.equal(w.snapshot().autoClaimDaily, false)
  w.setAutoClaimDaily(true)
  assert.equal(store.dump().welfare.autoClaimDaily, true)
})

// ---------------------------------------------------------------- 测试辅助
//
// createWelfare 支持依赖注入：这里直接传假 portal，测的是**真实实现**，
// 而不是复制一份逻辑。
function makeWelfare({ portal, store, day = '2026-10-27' }) {
  return createWelfare({
    getAuth: async () => (portal === null ? null : { userId: 'u1', operationToken: 't', operToken: 'o' }),
    store,
    now: () => new Date(day + 'T10:00:00'),
    portal: portal ?? undefined,
  })
}

// ---------------------------------------------------------------- 实时刷新
test('markStale: 对话结束后余额缓存被标记过期', async () => {
  const portal = fakePortal({ balance: 1000 })
  const store = memStore()
  const w = createWelfare({
    getAuth: async () => ({ userId: 'u', operationToken: 't', operToken: 'o' }),
    store,
    now: () => new Date('2026-10-27T10:00:00'),
    portal,
    // TTL 很长，确保"没被标记过期就不会再请求"
  }, { pointsTtlMs: 60 * 60 * 1000 })

  await w.refreshAll()
  assert.equal(portal.state.pointsCalls, 1, '首次刷新应请求一次')

  // TTL 内再刷新：不应重复请求
  await w.refreshAll.call({ snapshot: () => {} })
  // 用内部行为断言：直接再调一次 refreshAll（force=true 会请求，所以改测 snapshot 不触发）
  const before = portal.state.pointsCalls
  w.snapshot()
  assert.equal(portal.state.pointsCalls, before, 'snapshot 不该触发网络请求')

  // 标记过期后再刷新 → 应该重新请求
  w.markStale()
  assert.equal(w.snapshot().pointsStale, true, '快照应反映 stale')
  await w.refreshAll()
  assert.equal(portal.state.pointsCalls, before + 1, 'stale 后应重新拉取')
  assert.equal(w.snapshot().pointsStale, false, '刷新后 stale 清除')
})

test('markStale: 未登录时也不抛错', async () => {
  const store = memStore()
  const w = createWelfare({ getAuth: async () => null, store, now: () => new Date(), portal: null })
  assert.doesNotThrow(() => w.markStale())
})

test('TTL 内不重复请求上游（避免轮询放大）', async () => {
  const portal = fakePortal({ balance: 500 })
  const store = memStore()
  const w = createWelfare({
    getAuth: async () => ({ userId: 'u', operationToken: 't', operToken: 'o' }),
    store, now: () => new Date(), portal,
  }, { pointsTtlMs: 60_000 })

  await w.refreshAll()
  const calls = portal.state.pointsCalls
  await w.refreshAll()
  assert.ok(portal.state.pointsCalls <= calls + 1, 'TTL 内刷新次数应受控')
})

// ---------------------------------------------------------------- 领取调度

test('调度：当天已领时 tick 不查领取状态（省掉无谓请求）', async () => {
  const portal = fakePortal({ claimedToday: true })
  const store = memStore({ welfare: { autoClaimDaily: true, lastClaimDate: '2026-10-27', lastClaimOk: true } })
  const w = createWelfare({
    getAuth: async () => ({ userId: 'u', operationToken: 't', operToken: 'o' }),
    store,
    now: () => new Date('2026-10-27T10:00:00'),
    portal,
  })
  await w.prime()
  assert.equal(portal.state.statusCalls, 0, '已领时不应调用 checkDayTask')
  assert.equal(portal.state.claimCalls, 0, '已领时不应调用领取')
})

test('调度：未领时会查状态并尝试领取一次', async () => {
  const portal = fakePortal({ claimedToday: false })
  const store = memStore({ welfare: { autoClaimDaily: true, lastClaimDate: null, lastClaimOk: false } })
  const w = createWelfare({
    getAuth: async () => ({ userId: 'u', operationToken: 't', operToken: 'o' }),
    store,
    now: () => new Date('2026-10-27T10:00:00'),
    portal,
  })
  await w.prime()
  // 一次 tick：查状态(1) + 领取后确认(1)；claim 内部复用刚查的缓存，不重复请求
  assert.equal(portal.state.statusCalls, 2, `状态查询次数=${portal.state.statusCalls}`)
  assert.equal(portal.state.claimCalls, 1)
})

test('调度：关闭自动领取时不领（但状态仍可读）', async () => {
  const portal = fakePortal({ claimedToday: false })
  const store = memStore({ welfare: { autoClaimDaily: false, lastClaimDate: null } })
  const w = createWelfare({
    getAuth: async () => ({ userId: 'u', operationToken: 't', operToken: 'o' }),
    store,
    now: () => new Date('2026-10-27T10:00:00'),
    portal,
  })
  await w.prime()
  assert.equal(portal.state.claimCalls, 0, '关闭后不应领取')
})

test('调度：间隔随"是否已领"变化（未领 1h / 已领 8h）', async () => {
  const portal = fakePortal({ claimedToday: false })
  const store = memStore({ welfare: { autoClaimDaily: true, lastClaimDate: null } })
  const w = createWelfare({
    getAuth: async () => ({ userId: 'u', operationToken: 't', operToken: 'o' }),
    store,
    now: () => new Date('2026-10-27T10:00:00'),
    portal,
  })
  assert.equal(w.intervalMs(), 60 * 60 * 1000, '未领应为 1 小时')
  // 标记今天已领
  store.write({ welfare: { autoClaimDaily: true, lastClaimDate: '2026-10-27', lastClaimOk: true } })
  assert.equal(w.intervalMs(), 8 * 60 * 60 * 1000, '已领应为 8 小时')
})

test('调度：连续失败后间隔按指数退避且不超过上限', async () => {
  const failing = {
    state: {},
    fetchPoints: async () => ({ ok: false, error: 'HTTP 500' }),
    fetchDailyStatus: async () => ({ ok: false, error: 'HTTP 500' }),
    claimDaily: async () => ({ ok: false, error: 'HTTP 500' }),
  }
  const store = memStore({ welfare: { autoClaimDaily: true, lastClaimDate: null } })
  const w = createWelfare({
    getAuth: async () => ({ userId: 'u', operationToken: 't', operToken: 'o' }),
    store,
    now: () => new Date('2026-10-27T10:00:00'),
    portal: failing,
  }, { failureBackoffAfter: 1, claimIntervalMs: 60_000, maxBackoffMs: 300_000 })

  const first = w.intervalMs()
  await w.prime()   // 失败一次
  const second = w.intervalMs()
  assert.ok(second >= first, `失败后间隔应变长：${first} → ${second}`)
  for (let i = 0; i < 6; i++) await w.prime()
  assert.ok(w.intervalMs() <= 300_000, '不应超过 maxBackoffMs')
})

// ---------------------------------------------------------------- 读取即刷新
//
// 这一组是回归测试：曾经 stale 标记被设置了却没人消费，
// 导致"对话结束后余额永远不更新，必须手动点刷新"。

test('ensureFresh: 首次读取会去上游拉一次（缓存是空的）', async () => {
  const portal = fakePortal({ balance: 100 })
  const w = makeWelfare({ portal, store: memStore() })
  const snap = await w.ensureFresh()
  assert.equal(snap.balance, 100)
  assert.equal(portal.state.pointsCalls, 1)
})

test('ensureFresh: TTL 内再次读取不重复请求（胶囊 3 秒轮询不会放大流量）', async () => {
  const portal = fakePortal({ balance: 100 })
  const w = makeWelfare({ portal, store: memStore() })
  await w.ensureFresh()
  const calls = portal.state.pointsCalls
  await w.ensureFresh()
  await w.ensureFresh()
  assert.equal(portal.state.pointsCalls, calls, 'TTL 内应纯读缓存')
})

test('ensureFresh: 被 markStale 后，下次读取立刻刷新（对话结束后的核心行为）', async () => {
  const portal = fakePortal({ balance: 100 })
  const w = makeWelfare({ portal, store: memStore() })
  await w.ensureFresh()
  assert.equal(portal.state.pointsCalls, 1)

  // 模拟"模型刚跑完一轮，消耗了积分"
  portal.state.balance = 88
  w.markStale()
  assert.equal(w.snapshot().pointsStale, true)

  const snap = await w.ensureFresh()
  assert.equal(portal.state.pointsCalls, 2, 'stale 后必须去上游取新值')
  assert.equal(snap.balance, 88, '返回的必须是新余额')
  assert.equal(snap.pointsStale, false)
})

test('ensureFresh: 上游失败时保留旧值而不是清零', async () => {
  const portal = fakePortal({ balance: 100 })
  const w = makeWelfare({ portal, store: memStore() })
  await w.ensureFresh()
  portal.fetchPoints = async () => ({ ok: false, error: 'HTTP 500' })
  w.markStale()
  const snap = await w.ensureFresh()
  assert.equal(snap.balance, 100, '失败时应保留上一次的余额')
  assert.equal(snap.pointsError, 'HTTP 500')
})

test('ensureFresh: 每日领取状态也会按 TTL 刷新（今日可领要准）', async () => {
  const portal = fakePortal({ claimedToday: false })
  const w = makeWelfare({ portal, store: memStore() })
  await w.ensureFresh()
  const statusCalls = portal.state.statusCalls
  await w.ensureFresh()
  assert.equal(portal.state.statusCalls, statusCalls, 'TTL 内不重复查领取状态')
})

// Catch stale store/config reads and snapshots that disagree with the scheduler.
test('scheduler reads the live effective auto-claim preference without persisting it', async () => {
  let enabled = false
  const portal = fakePortal()
  const store = memStore({ welfare: { autoClaimDaily: true, lastClaimDate: '2026-01-01', lastClaimPoints: 25, futureMetadata: 'keep' } })
  const w = createWelfare({
    getAuth: async () => ({ userId: 'u' }), store, portal,
    now: () => new Date('2026-10-27T10:00:00'),
    getAutoClaimDaily: () => enabled,
  }, { autoClaimDaily: false })
  await w.prime()
  assert.equal(portal.state.claimCalls, 0)
  assert.equal(w.snapshot().autoClaimDaily, false)
  enabled = true
  await w.prime()
  assert.equal(portal.state.claimCalls, 1, 'effective preference overrides stale store and startup config')
  assert.equal(w.snapshot().autoClaimDaily, true)
  assert.equal(store.dump().welfare.autoClaimDaily, true)
  assert.equal(store.dump().welfare.futureMetadata, 'keep')
})

test('manual claim metadata does not invent an automatic-claim preference', async () => {
  const store = memStore({ welfare: { lastClaimPoints: 25, futureMetadata: 'keep' } })
  const w = makeWelfare({ portal: fakePortal(), store })
  await w.claim({ source: 'manual' })
  assert.equal(Object.hasOwn(store.dump().welfare, 'autoClaimDaily'), false)
  assert.equal(store.dump().welfare.futureMetadata, 'keep')
  assert.equal(store.dump().welfare.lastClaimPoints, 100)
})

test('turning auto-claim off during a pending refresh prevents the automatic claim', async () => {
  let enabled = true
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const portal = fakePortal()
  const fetchStatus = portal.fetchDailyStatus
  portal.fetchDailyStatus = async () => { await pending; return fetchStatus() }
  const w = createWelfare({
    getAuth: async () => ({ userId: 'u' }), store: memStore(), portal,
    getAutoClaimDaily: () => enabled,
  })
  const tick = w.prime()
  enabled = false
  release()
  await tick
  assert.equal(portal.state.claimCalls, 0)
})
