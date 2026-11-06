/**
 * SSE 心跳：长静默时发 `: ping`，防止下游 bodyTimeout（默认 300s）把流判成 terminated。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createHeartbeat } from '../lib/shim.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  await sleep(75)
  stop()
  assert.ok(res.chunks.length >= 2, `heartbeats=${res.chunks.length}`)
  assert.ok(res.chunks.every((chunk) => chunk === ': ping\n\n'))
})

test('createHeartbeat: stop 之后不再写，且结束后不写', async () => {
  const res = fakeRes()
  const stop = createHeartbeat(res, { intervalMs: 20 })
  await sleep(35)
  stop()
  const count = res.chunks.length
  await sleep(60)
  assert.equal(res.chunks.length, count)
})
