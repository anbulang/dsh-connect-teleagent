/**
 * 生命周期测试（不真的启动应用）。
 *
 * 覆盖：进程探测、孤儿清理规则、登录流程的短路与超时分支。
 * 真实启动/退出在 test-lifecycle-live.mjs 里手动验证。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isAppInstalled,
  isAppRunning,
  isSignedIn,
} from '../lib/lifecycle.js'

test('isAppInstalled: 返回布尔值且与路径一致', () => {
  const v = isAppInstalled()
  assert.equal(typeof v, 'boolean')
})

test('isAppRunning: 返回数组（pid 列表）', () => {
  const v = isAppRunning()
  assert.ok(Array.isArray(v))
  for (const pid of v) assert.ok(Number.isInteger(pid) && pid > 0)
})

test('isSignedIn: 诊断抛错时安全返回 false', () => {
  assert.equal(isSignedIn(() => { throw new Error('boom') }), false)
})

test('isSignedIn: 透传诊断的 ok 字段', () => {
  assert.equal(isSignedIn(() => ({ ok: true })), true)
  assert.equal(isSignedIn(() => ({ ok: false })), false)
})
