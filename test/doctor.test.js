/**
 * doctor 自检逻辑测试。
 *
 * 重点覆盖三条审核意见修掉的行为：
 *  1. 内核日志只把**今天**的算"今日"，历史日志要如实标日期且不能让 doctor 判失败；
 *  2. 日志读不出来时必须记一条显式失败检查项，不能被静默吞掉；
 *  3. 内核探针必须用**独立端口**，不能复用 DSH 正在用的端口。
 *
 * 全部用假的 fs / 假的 startKernel，不启动真内核、不碰真实 HOME。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  localDateStamp, selectReviewLog, summarizeReviewLog, describeReviewLog,
  readReviewLog, doctorProbePort,
} from '../lib/doctor.js'

// ---------------------------------------------------------------- 日期基准

test('localDateStamp: 按本地时区出日期，不是 UTC', () => {
  // 东八区 2026-11-08 00:30 = UTC 2026-11-07 16:30。
  // 用 toISOString().slice(0,10) 会得到 11-07（错一天），这正是不该犯的错。
  const localEarlyMorning = new Date(2026, 10, 8, 0, 30, 0)
  assert.equal(localDateStamp(localEarlyMorning), '2026-11-08')
  assert.match(localDateStamp(localEarlyMorning), /^\d{4}-\d{2}-\d{2}$/)
  // 补零
  assert.equal(localDateStamp(new Date(2026, 0, 5, 12, 0, 0)), '2026-01-05')
})

// ---------------------------------------------------------------- 日志选择

test('selectReviewLog: 今天有日志就选今天', () => {
  const picked = selectReviewLog([
    'super-agent-server-2026-11-06.log',
    'super-agent-server-2026-11-08.log',
    'super-agent-server-2026-11-07.log',
  ], '2026-11-08')
  assert.equal(picked.file, 'super-agent-server-2026-11-08.log')
  assert.equal(picked.stamp, '2026-11-08')
  assert.equal(picked.isToday, true)
})

test('selectReviewLog: 今天没日志时退回最新一份，但标 isToday=false', () => {
  const picked = selectReviewLog([
    'super-agent-server-2026-11-06.log',
    'super-agent-server-2026-11-07.log',
  ], '2026-11-08')
  assert.equal(picked.file, 'super-agent-server-2026-11-07.log')
  assert.equal(picked.stamp, '2026-11-07')
  assert.equal(picked.isToday, false, '历史日志不能当成今日')
})

test('selectReviewLog: 忽略非日志文件与格式不对的文件名', () => {
  const picked = selectReviewLog([
    'super-agent-server-2026-11-07.log',
    'super-agent-server.log',
    'super-agent-server-2026-11-07.log.1',
    'other-2026-11-09.log',
    'notes.txt',
  ], '2026-11-08')
  assert.equal(picked.file, 'super-agent-server-2026-11-07.log')
})

test('selectReviewLog: 目录里没有匹配文件时返回 null', () => {
  assert.equal(selectReviewLog([], '2026-11-08'), null)
  assert.equal(selectReviewLog(['notes.txt'], '2026-11-08'), null)
})

test('selectReviewLog: 按日期而非字典序取最新', () => {
  // 跨年时字典序和日期序一致，但同一月内补零文件名也要稳妥：
  // 这里用不同年份确认比较的是日期而不是字符串长度
  const picked = selectReviewLog([
    'super-agent-server-2025-12-31.log',
    'super-agent-server-2026-01-01.log',
  ], '2026-06-01')
  assert.equal(picked.stamp, '2026-01-01')
})

// ---------------------------------------------------------------- 统计与文案

test('summarizeReviewLog: 分别数出请求、取消、拒绝', () => {
  const text = [
    'policy review request input=abc',
    'policy review request input=def',
    'policy review output request failed: context canceled',
    'policy review decision action=deny',
    'policy review decision action=allow',
  ].join('\n')
  const s = summarizeReviewLog(text)
  assert.equal(s.requests, 2)
  assert.equal(s.canceled, 1)
  assert.equal(s.rejected, 1, '只数 deny/block，allow 不算')
})

test('describeReviewLog: 今日无审核记录时如实说"还没有"，不报 0 次为异常', () => {
  const r = describeReviewLog({ isToday: true, stamp: '2026-11-08', requests: 0, canceled: 0, rejected: 0 })
  assert.equal(r.ok, true)
  assert.match(r.detail, /今日（2026-11-08）/)
  assert.match(r.detail, /还没有/)
})

test('describeReviewLog: 今日有拒绝才算失败', () => {
  const bad = describeReviewLog({ isToday: true, stamp: '2026-11-08', requests: 5, canceled: 0, rejected: 2 })
  assert.equal(bad.ok, false)
  assert.match(bad.detail, /2 次被拒绝/)
})

test('describeReviewLog: 历史日志的拒绝不影响结论，但要点明是历史数据', () => {
  const stale = describeReviewLog({ isToday: false, stamp: '2026-11-07', requests: 26, canceled: 0, rejected: 3 })
  assert.equal(stale.ok, true, '昨天的拒绝不能让今天的 doctor 一直红着')
  assert.match(stale.detail, /历史日志（2026-11-07，不是今天）/)
  assert.match(stale.detail, /历史数据，不代表当前/)
  assert.doesNotMatch(stale.detail, /^今日/, '绝不能把历史数据写成"今日"')
})

test('describeReviewLog: 取消不等于拒绝，文案保持原样说明', () => {
  const r = describeReviewLog({ isToday: true, stamp: '2026-11-08', requests: 26, canceled: 26, rejected: 0 })
  assert.equal(r.ok, true)
  assert.match(r.detail, /取消（正常：调用方已结束，非拒绝）/)
})

// ---------------------------------------------------------------- 读日志（含失败分支）

function withTempLogDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'))
  try { return fn(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test('readReviewLog: 目录不存在返回 absent', () => {
  withTempLogDir((dir) => {
    const r = readReviewLog(path.join(dir, 'nope'), '2026-11-08')
    assert.equal(r.state, 'absent')
  })
})

test('readReviewLog: 目录为空返回 absent', () => {
  withTempLogDir((dir) => {
    assert.equal(readReviewLog(dir, '2026-11-08').state, 'absent')
  })
})

test('readReviewLog: 读今天的日志并带上 date 元信息', () => {
  withTempLogDir((dir) => {
    fs.writeFileSync(path.join(dir, 'super-agent-server-2026-11-08.log'), 'policy review request x\npolicy review decision action=deny\n')
    const r = readReviewLog(dir, '2026-11-08')
    assert.equal(r.state, 'observed')
    assert.equal(r.isToday, true)
    assert.equal(r.stamp, '2026-11-08')
    assert.equal(r.requests, 1)
    assert.equal(r.rejected, 1)
  })
})

test('readReviewLog: 只有历史日志时 state 仍是 observed 但 isToday=false', () => {
  withTempLogDir((dir) => {
    fs.writeFileSync(path.join(dir, 'super-agent-server-2026-11-07.log'), 'policy review request x\n')
    const r = readReviewLog(dir, '2026-11-08')
    assert.equal(r.state, 'observed')
    assert.equal(r.isToday, false)
    assert.equal(r.stamp, '2026-11-07')
    assert.equal(describeReviewLog(r).ok, true, '历史日志不该判失败')
  })
})

test('readReviewLog: 日志文件读不出来返回 error（不再被静默吞掉）', () => {
  withTempLogDir((dir) => {
    // 用目录冒充日志文件：readFileSync 必然抛 EISDIR，模拟"文件存在但读失败"
    fs.mkdirSync(path.join(dir, 'super-agent-server-2026-11-08.log'))
    const r = readReviewLog(dir, '2026-11-08')
    assert.equal(r.state, 'error', 'error 状态必须能被拿到，而不是变成 absent/skip')
    assert.equal(typeof r.error, 'string')
    assert.ok(r.error.length > 0)
  })
})

test('readReviewLog: 权限不足时返回 error', { skip: process.getuid?.() === 0 }, () => {
  withTempLogDir((dir) => {
    const file = path.join(dir, 'super-agent-server-2026-11-08.log')
    fs.writeFileSync(file, 'policy review request x\n')
    fs.chmodSync(file, 0o000)
    try {
      const r = readReviewLog(dir, '2026-11-08')
      assert.equal(r.state, 'error')
      assert.match(r.error, /EACCES|permission/i)
    } finally {
      fs.chmodSync(file, 0o600)
    }
  })
})

// ---------------------------------------------------------------- 探针端口

test('doctorProbePort: 每次重新分配端口，不复用 TELEAGENT_KERNEL_PORT', async () => {
  const prev = process.env.TELEAGENT_KERNEL_PORT
  process.env.TELEAGENT_KERNEL_PORT = '47901'
  const calls = []
  try {
    const port = await doctorProbePort(async () => { calls.push(1); return 54321 })
    assert.equal(port, 54321)
    assert.equal(calls.length, 1, '应该调用 pickFreePort 而不是读环境变量')
    assert.notEqual(port, 47901, '不能等于 DSH 正在用的端口')
  } finally {
    if (prev === undefined) delete process.env.TELEAGENT_KERNEL_PORT
    else process.env.TELEAGENT_KERNEL_PORT = prev
  }
})

test('doctorProbePort: 默认分配的端口真的没人监听（可绑定）', async () => {
  const net = await import('node:net')
  const port = await doctorProbePort()
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536)
  await new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(port, '127.0.0.1', () => srv.close(resolve))
  })
})
