/**
 * SSE 心跳：长静默时发 `: ping`，防止下游 bodyTimeout（默认 300s）把流判成 terminated。
 *
 * ⚠️ 定时器断言一律用「等到条件成立 + 上限」而不是固定 sleep：
 * 全量测试并行跑时事件循环会抖动，固定 sleep 会偶发误报。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createHeartbeat } from '../lib/shim.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 等到 predicate() 为真，最多等 timeoutMs；返回是否在期限内满足 */
async function waitFor(predicate, timeoutMs = 2000, stepMs = 5) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(stepMs)
  }
  return predicate()
}

function fakeRes() {
  return {
    chunks: [],
    writableEnded: false,
    write(chunk) { this.chunks.push(String(chunk)); return true },
  }
}

test('createHeartbeat: 按间隔写注释帧', async () => {
  const res = fakeRes()
  const stop = createHeartbeat(res, { intervalMs: 20 })
  const got2 = await waitFor(() => res.chunks.length >= 2)
  stop()
  assert.ok(got2, `heartbeats=${res.chunks.length}`)
  assert.ok(res.chunks.every((chunk) => chunk === ': ping\n\n'))
})

test('createHeartbeat: stop 之后不再写，且结束后不写', async () => {
  const res = fakeRes()
  const stop = createHeartbeat(res, { intervalMs: 20 })
  await waitFor(() => res.chunks.length >= 1)
  stop()
  const count = res.chunks.length
  await sleep(120) // 至少跨过 5 个间隔
  assert.equal(res.chunks.length, count)
})

test('createHeartbeat: 半帧挂起时跳过这一拍，回到帧边界后恢复写', async () => {
  const res = fakeRes()
  // 模拟转发循环：false = 输出流尾部停在行中间（有半行挂起）
  let atBoundary = false
  const stop = createHeartbeat(res, { intervalMs: 15, isAtBoundary: () => atBoundary })

  // 负向断言：挂起期间跨过多个间隔都不能写
  await sleep(150) // ≈10 个间隔
  assert.equal(res.chunks.length, 0, `半帧挂起期间不该写心跳，却写了 ${res.chunks.length} 次`)

  // 上游补齐剩余字节，回到帧边界
  atBoundary = true
  const resumed = await waitFor(() => res.chunks.length >= 2)
  stop()
  assert.ok(resumed, `回到边界后应恢复心跳，实际 ${res.chunks.length}`)
  assert.ok(res.chunks.every((chunk) => chunk === ': ping\n\n'))
})

test('createHeartbeat: isAtBoundary 抛错时按不安全处理（不写）', async () => {
  const res = fakeRes()
  const stop = createHeartbeat(res, {
    intervalMs: 15,
    isAtBoundary: () => { throw new Error('boom') },
  })
  await sleep(150)
  stop()
  assert.equal(res.chunks.length, 0)
})

test('createHeartbeat: writableEnded 时即使 atBoundary 也不写', async () => {
  const res = fakeRes()
  res.writableEnded = true
  const stop = createHeartbeat(res, { intervalMs: 15, isAtBoundary: () => true })
  await sleep(150)
  stop()
  assert.equal(res.chunks.length, 0)
})

test('createHeartbeat: isAtBoundary 返回非 true 也算不安全', async () => {
  const res = fakeRes()
  for (const value of [false, undefined, null, 0, 'yes']) {
    const stop = createHeartbeat(res, { intervalMs: 15, isAtBoundary: () => value })
    await sleep(60)
    stop()
  }
  assert.equal(res.chunks.length, 0)
})

test('createHeartbeat: 不传 isAtBoundary 时保持旧行为（无条件写）', async () => {
  const res = fakeRes()
  const stop = createHeartbeat(res, { intervalMs: 20 })
  const got2 = await waitFor(() => res.chunks.length >= 2)
  stop()
  assert.ok(got2, `heartbeats=${res.chunks.length}`)
  assert.ok(res.chunks.every((chunk) => chunk === ': ping\n\n'))
})
