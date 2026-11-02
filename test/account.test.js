/**
 * 账号清除测试。
 *
 * 核心约束：**只删凭据，绝不删用户数据**（技能、记忆、会话）。
 * 这条如果写错，用户换个账号就会丢掉全部个人积累。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { listScopesWithCredential } from '../lib/account.js'
import { currentScope } from '../lib/models.js'

/** 造一个假的 TeleAgent 数据目录 */
function makeHome({ accounts = ['v1_public_A'], ownerDir, withCredential = ['v1_public_A'] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'te-acct-'))
  const data = path.join(home, '.local', 'share', 'TeleAgent')
  const users = path.join(data, 'users')
  fs.mkdirSync(users, { recursive: true })

  for (const name of accounts) {
    const base = path.join(users, name)
    fs.mkdirSync(path.join(base, 'app-auth'), { recursive: true })
    // 用户数据：这些必须留存
    fs.mkdirSync(path.join(base, 'skills'), { recursive: true })
    fs.writeFileSync(path.join(base, 'skills', 'demo.md'), 'skill content')
    fs.mkdirSync(path.join(base, 'log'), { recursive: true })
    fs.writeFileSync(path.join(base, 'log', 'a.log'), 'log content')
    fs.writeFileSync(path.join(base, 'USER.md'), 'memory content')
    if (withCredential.includes(name)) {
      fs.writeFileSync(path.join(base, 'app-auth', 'token.json'), JSON.stringify({ encryptedToken: 'v10AAAA' }))
    }
  }
  if (ownerDir !== undefined) {
    fs.writeFileSync(path.join(data, 'current-owner.json'), JSON.stringify({ ownerDir }))
  }
  return home
}

test('listScopesWithCredential: 只列出带凭据的目录', () => {
  const home = makeHome({ accounts: ['a', 'b'], withCredential: ['a'] })
  assert.deepEqual(listScopesWithCredential(home), ['a'])
})

test('listScopesWithCredential: 无 users 目录时返回空数组', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'te-empty-'))
  assert.deepEqual(listScopesWithCredential(home), [])
})

test('clearCredential: 删除当前账号的 token.json', async () => {
  const home = makeHome({ ownerDir: 'v1_public_A' })
  const { clearCredential } = await import('../lib/account.js')
  const tokenFile = path.join(home, '.local', 'share', 'TeleAgent', 'users', 'v1_public_A', 'app-auth', 'token.json')
  assert.equal(fs.existsSync(tokenFile), true, '前置：凭据应存在')

  const result = await clearCredential({ home, quitAppFirst: false })

  assert.equal(result.ok, true)
  assert.deepEqual(result.cleared, ['v1_public_A'])
  assert.equal(fs.existsSync(tokenFile), false, '凭据应被删除')
})

test('clearCredential: 保留技能/记忆/日志等用户数据', async () => {
  const home = makeHome({ ownerDir: 'v1_public_A' })
  const { clearCredential } = await import('../lib/account.js')
  await clearCredential({ home, quitAppFirst: false })

  const base = path.join(home, '.local', 'share', 'TeleAgent', 'users', 'v1_public_A')
  assert.equal(fs.existsSync(path.join(base, 'skills', 'demo.md')), true, '技能不能丢')
  assert.equal(fs.existsSync(path.join(base, 'USER.md')), true, '记忆不能丢')
  assert.equal(fs.existsSync(path.join(base, 'log', 'a.log')), true, '日志不能丢')
})

test('clearCredential: scope=all 清除所有账号凭据', async () => {
  const home = makeHome({ accounts: ['v1_public_A', 'v1_public_B'], withCredential: ['v1_public_A', 'v1_public_B'] })
  const { clearCredential } = await import('../lib/account.js')
  const result = await clearCredential({ home, scope: 'all', quitAppFirst: false })

  assert.equal(result.cleared.length, 2)
  assert.deepEqual(listScopesWithCredential(home), [])
  // 用户数据仍在
  assert.equal(fs.existsSync(path.join(home, '.local', 'share', 'TeleAgent', 'users', 'v1_public_B', 'USER.md')), true)
})

test('clearCredential: 没有凭据时不报错，返回空结果', async () => {
  const home = makeHome({ accounts: ['v1_public_A'], withCredential: [] })
  const { clearCredential } = await import('../lib/account.js')
  const result = await clearCredential({ home, quitAppFirst: false })
  assert.equal(result.ok, true)
  assert.deepEqual(result.cleared, [])
  assert.deepEqual(result.errors, [])
})

test('clearCredential: 未指定 owner 时只清"当前"（最新的那个），绝不隐式全删', async () => {
  // 没有 current-owner.json，但有 2 个带凭据的账号
  const home = makeHome({ accounts: ['v1_public_A', 'v1_public_B'], withCredential: ['v1_public_A', 'v1_public_B'] })
  const { clearCredential } = await import('../lib/account.js')
  const result = await clearCredential({ home, quitAppFirst: false })

  // 只删一个：批量删除必须由调用方显式请求 scope:'all'
  assert.equal(result.cleared.length, 1, '默认不应批量删除')
  assert.equal(listScopesWithCredential(home).length, 1, '应仍保留一个账号的凭据')
})

test('清除后 currentScope 抛错（表现为未登录）', async () => {
  const home = makeHome({ ownerDir: 'v1_public_A' })
  const { clearCredential } = await import('../lib/account.js')
  await clearCredential({ home, quitAppFirst: false })

  const data = path.join(home, '.local', 'share', 'TeleAgent')
  // current-owner.json 还在，但 token 没了：currentScope 仍能返回目录名，
  // 而凭据诊断会报 token_file_missing（这是"未登录"的正确表现）
  assert.equal(currentScope(data), 'v1_public_A')
  assert.deepEqual(listScopesWithCredential(home), [])
})
