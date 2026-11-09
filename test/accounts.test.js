/**
 * 多账号测试。
 *
 * 重点保护「切换」这个**会改桌面端文件**的操作：
 *  1. 桌面端运行中必须拒绝
 *  2. 目标账号没有 token 必须拒绝
 *  3. dry-run 一个字节都不写
 *  4. 正常切换要备份原文件、原子替换、generation 递增
 *  5. 写失败必须回滚
 *
 * 全部在临时目录里跑，不碰真实账号，也不发网络请求。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { listAccounts, readOwnerFile, switchAccount, summarizeAccounts, deleteAccount } from '../lib/accounts.js'

/** 造一个假的 TeleAgent 数据目录 */
function fakeHome({ scopes = ['v1_public_100', 'v1_public_200'], current = 'v1_public_100', withOwner = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-accounts-'))
  const data = path.join(home, '.local', 'share', 'TeleAgent')
  fs.mkdirSync(path.join(data, 'users'), { recursive: true })
  for (const scope of scopes) {
    fs.mkdirSync(path.join(data, 'users', scope, 'app-auth'), { recursive: true })
    // 只放 token.json 的位置；encryptedToken 是假的（解密会失败，列表要能容忍）
    fs.writeFileSync(
      path.join(data, 'users', scope, 'app-auth', 'token.json'),
      JSON.stringify({ encryptedToken: 'v10-fake-token' }),
    )
    fs.mkdirSync(path.join(data, 'Partitions', `owner%3A${scope}`), { recursive: true })
    fs.writeFileSync(path.join(data, 'Partitions', `owner%3A${scope}`, 'Cookies'), '')
  }
  if (withOwner) {
    fs.writeFileSync(
      path.join(data, 'current-owner.json'),
      JSON.stringify({ ownerDir: current, tenantId: 'public', userId: current.split('_').pop(), generation: 3 }, null, 2),
    )
  }
  return { home, data, ownerFile: path.join(data, 'current-owner.json') }
}

test('listAccounts: 列出所有账号目录，标记当前账号', () => {
  const { home } = fakeHome()
  const list = listAccounts(home)
  assert.equal(list.length, 2)
  assert.equal(list[0].isCurrent, true, '当前账号应排最前')
  assert.equal(list[0].scope, 'v1_public_100')
  assert.ok(list.every((a) => a.hasToken === true))
})

test('listAccounts: 没有 users 目录时返回空数组而不是抛错', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-empty-'))
  assert.deepEqual(listAccounts(home), [])
})

test('listAccounts: 缺 token.json 的账号标记为 no_token', () => {
  const { home, data } = fakeHome({ scopes: ['v1_public_100', 'v1_public_300'] })
  fs.rmSync(path.join(data, 'users', 'v1_public_300', 'app-auth'), { recursive: true, force: true })
  const list = listAccounts(home)
  const missing = list.find((a) => a.scope === 'v1_public_300')
  assert.equal(missing.state, 'no_token')
  assert.equal(missing.hasToken, false)
})

test('readOwnerFile: 读取 ownerDir 与 generation', () => {
  const { home } = fakeHome()
  const owner = readOwnerFile(home)
  assert.equal(owner.ownerDir, 'v1_public_100')
  assert.equal(owner.generation, 3)
})

test('readOwnerFile: 文件缺失返回 null', () => {
  const { home } = fakeHome({ withOwner: false })
  assert.equal(readOwnerFile(home), null)
})

test('switchAccount: 桌面端运行中必须拒绝（否则会被它覆盖）', () => {
  const { home, ownerFile } = fakeHome()
  const before = fs.readFileSync(ownerFile, 'utf8')
  const r = switchAccount({ scope: 'v1_public_200', appRunning: true, home })
  assert.equal(r.ok, false)
  assert.match(r.reason, /桌面端正在运行/)
  assert.equal(fs.readFileSync(ownerFile, 'utf8'), before, '拒绝时不应改动文件')
})

test('switchAccount: dry-run 不写任何文件，但报告将发生什么', () => {
  const { home, ownerFile } = fakeHome()
  const before = fs.readFileSync(ownerFile, 'utf8')
  const r = switchAccount({ scope: 'v1_public_200', dryRun: true, home })
  assert.equal(r.ok, true)
  assert.equal(r.dryRun, true)
  assert.equal(r.changed, false)
  assert.equal(r.owner.ownerDir, 'v1_public_200')
  assert.equal(r.owner.generation, 4, 'generation 应比原来 +1')
  assert.equal(fs.readFileSync(ownerFile, 'utf8'), before, 'dry-run 不应改动文件')
})

test('switchAccount: 正常切换会备份、原子替换并递增 generation', () => {
  const { home, ownerFile } = fakeHome()
  const r = switchAccount({ scope: 'v1_public_200', home })
  assert.equal(r.ok, true)
  assert.equal(r.changed, true)
  assert.ok(r.backup, '应产生备份文件')
  assert.ok(fs.existsSync(r.backup), '备份文件应存在')

  const after = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
  assert.equal(after.ownerDir, 'v1_public_200')
  assert.equal(after.userId, '200')
  assert.equal(after.generation, 4)

  // 不应留下临时文件
  const leftovers = fs.readdirSync(path.dirname(ownerFile)).filter((f) => f.includes('.tmp-'))
  assert.deepEqual(leftovers, [], '不应留下 .tmp- 文件')
})

test('switchAccount: 切到不存在的账号被拒绝', () => {
  const { home } = fakeHome()
  const r = switchAccount({ scope: 'v1_public_999', home })
  assert.equal(r.ok, false)
  assert.match(r.reason, /没有这个账号/)
})

test('switchAccount: 目标账号没有 token 时拒绝', () => {
  const { home, data } = fakeHome()
  fs.rmSync(path.join(data, 'users', 'v1_public_200', 'app-auth'), { recursive: true, force: true })
  const r = switchAccount({ scope: 'v1_public_200', home })
  assert.equal(r.ok, false)
  assert.match(r.reason, /没有可用的 token/)
})

test('switchAccount: 已经是当前账号时不重复写', () => {
  const { home, ownerFile } = fakeHome()
  const before = fs.readFileSync(ownerFile, 'utf8')
  const r = switchAccount({ scope: 'v1_public_100', home })
  assert.equal(r.ok, true)
  assert.equal(r.changed, false)
  assert.equal(fs.readFileSync(ownerFile, 'utf8'), before)
})

test('switchAccount: 写失败时回滚到原内容', () => {
  const { home, ownerFile } = fakeHome()
  const before = fs.readFileSync(ownerFile, 'utf8')
  // 让 rename 失败：把目标路径变成目录
  const blocked = path.join(path.dirname(ownerFile), 'current-owner.json.tmp-' + process.pid)
  fs.mkdirSync(blocked, { recursive: true })
  const r = switchAccount({ scope: 'v1_public_200', home })
  // 无论是否失败，原文件都必须完好
  assert.equal(fs.readFileSync(ownerFile, 'utf8'), before, '失败后必须回滚')
  if (!r.ok) assert.match(String(r.reason), /写入失败|回滚/)
})

test('summarizeAccounts: 给出总数与当前账号', () => {
  const { home } = fakeHome()
  const s = summarizeAccounts(home)
  assert.equal(s.total, 2)
  assert.equal(s.current.scope, 'v1_public_100')
  assert.equal(s.accounts.length, 2)
})

// ------------------------------------------------------------ 逐账号领取
test('claimForAccount: 没有 cookie 的账号返回可读错误（不发请求）', async () => {
  const { claimForAccount } = await import('../lib/accounts.js')
  const { home } = fakeHome()
  // fakeHome 里 Cookies 是空文件 → 解析不出 operationToken
  const r = await claimForAccount('v1_public_200', home)
  assert.equal(r.ok, false)
  assert.match(r.error, /portal cookie/)
})

test('claimForAccount: 不存在的账号也不抛错', async () => {
  const { claimForAccount } = await import('../lib/accounts.js')
  const { home } = fakeHome()
  const r = await claimForAccount('v1_public_does_not_exist', home)
  assert.equal(r.ok, false)
})

// 回归：空 Cookies 文件是**正常的空状态**（Chromium 还没初始化该 Partition），
// 但 sqlite3 会报 `no such table: cookies`，而 execFileSync 默认继承 stderr，
// 于是 `Error: in prepare, ...` 直接漏进测试输出和用户终端，夹在通过的测试之间像失败。
test('readPortalAuth: 空 Cookies 文件是空状态，静默返回 null', async () => {
  const { readPortalAuth } = await import('../lib/portal.js')
  const { home } = fakeHome()
  const r = readPortalAuth(home, 'v1_public_100')
  assert.equal(r, null, '空 cookie 库应返回 null（走降级），而不是抛错')
})

test('readPortalAuth: 真实格式的 cookie 库能读出 token', async () => {
  const { readPortalAuth } = await import('../lib/portal.js')
  const { DatabaseSync } = await import('node:sqlite')
  const { home } = fakeHome()
  const db = path.join(home, '.local', 'share', 'TeleAgent', 'Partitions', 'owner%3Av1_public_100', 'Cookies')
  const sqlite = new DatabaseSync(db)
  try {
    sqlite.exec('create table cookies(name text, value text, host_key text, encrypted_value blob, creation_utc integer); ' +
      "insert into cookies values('operationToken','op-abc','agent.teleai.com.cn',NULL,13438710481134143)," +
      "('operToken','oper-xyz','.teleai.com.cn',NULL,13438710481134143);")
  } finally {
    sqlite.close()
  }
  const r = readPortalAuth(home, 'v1_public_100')
  assert.ok(r, '应能读出 cookie')
  assert.equal(r.operationToken, 'op-abc')
  assert.equal(r.operToken, 'oper-xyz')
})

test('switchAccount: appRunning 传 PID 数组时也要认作"在运行"', () => {
  // 回归：isAppRunning() 返回的是 PID 数组，[] 是 truthy、[pid] 也不是 true，
  // 早期实现用 === true 判断，导致"桌面端在运行"这条保护完全失效。
  const { home, ownerFile } = fakeHome()
  const before = fs.readFileSync(ownerFile, 'utf8')
  const r = switchAccount({ scope: 'v1_public_200', appRunning: [1234], home })
  assert.equal(r.ok, false)
  assert.match(r.reason, /桌面端正在运行/)
  assert.equal(fs.readFileSync(ownerFile, 'utf8'), before)
})

test('switchAccount: 空数组表示没在运行，允许切换', () => {
  const { home } = fakeHome()
  const r = switchAccount({ scope: 'v1_public_200', appRunning: [], home })
  assert.equal(r.ok, true)
  assert.equal(r.changed, true)
})

test('isAppRunningNow: 返回布尔而不是数组', async () => {
  const { isAppRunningNow, isAppRunning } = await import('../lib/lifecycle.js')
  assert.equal(typeof isAppRunningNow(), 'boolean')
  assert.equal(isAppRunningNow(), Array.isArray(isAppRunning()) ? isAppRunning().length > 0 : false)
})

// ---------------------------------------------------------------- 删除账号

test('deleteAccount: 默认只摘登录态，账号目录与个人数据保留', () => {
  const { home, data } = fakeHome()
  const skills = path.join(data, 'users', 'v1_public_200', 'skills')
  fs.mkdirSync(skills, { recursive: true })
  fs.writeFileSync(path.join(skills, 'a.md'), 'personal')

  const r = deleteAccount({ scope: 'v1_public_200', home })
  assert.equal(r.ok, true)
  assert.equal(r.deleted, true)
  assert.equal(r.plan.mode, 'logout')
  assert.equal(fs.existsSync(path.join(data, 'users', 'v1_public_200', 'app-auth', 'token.json')), false, 'token.json 应被删除')
  assert.equal(fs.readFileSync(path.join(skills, 'a.md'), 'utf8'), 'personal', '个人数据必须保留')

  // 列表里仍在，但变成 no_token
  const listed = listAccounts(home).find((a) => a.scope === 'v1_public_200')
  assert.equal(listed.state, 'no_token')
})

test('deleteAccount: purge 移入回收站，账号从列表消失且可恢复', () => {
  const { home, data } = fakeHome()
  const skills = path.join(data, 'users', 'v1_public_200', 'skills')
  fs.mkdirSync(skills, { recursive: true })
  fs.writeFileSync(path.join(skills, 'a.md'), 'personal')

  const r = deleteAccount({ scope: 'v1_public_200', mode: 'purge', home })
  assert.equal(r.ok, true)
  assert.equal(r.plan.mode, 'purge')
  assert.ok(r.plan.trashDir, '应给出回收站路径')

  assert.equal(listAccounts(home).some((a) => a.scope === 'v1_public_200'), false, '应从列表消失')
  assert.equal(fs.existsSync(path.join(data, 'Partitions', 'owner%3Av1_public_200')), false, '分区 cookie 也应移走')

  // 回收站里数据完整 → 可手动恢复
  assert.equal(fs.readFileSync(path.join(r.plan.trashDir, 'user', 'skills', 'a.md'), 'utf8'), 'personal')
  assert.ok(fs.existsSync(path.join(r.plan.trashDir, 'partition', 'Cookies')))
})

test('deleteAccount: 拒绝删除当前账号（否则 owner 指向不存在的账号）', () => {
  const { home, ownerFile } = fakeHome()
  const before = fs.readFileSync(ownerFile, 'utf8')
  const r = deleteAccount({ scope: 'v1_public_100', mode: 'purge', home })
  assert.equal(r.ok, false)
  assert.match(r.reason, /当前正在使用/)
  assert.equal(fs.readFileSync(ownerFile, 'utf8'), before)
})

test('deleteAccount: 桌面端运行中拒绝', () => {
  const { home, data } = fakeHome()
  const r = deleteAccount({ scope: 'v1_public_200', mode: 'purge', appRunning: [1234], home })
  assert.equal(r.ok, false)
  assert.match(r.reason, /桌面端正在运行/)
  assert.ok(fs.existsSync(path.join(data, 'users', 'v1_public_200', 'app-auth', 'token.json')))
})

test('deleteAccount: dry-run 一个文件都不动', () => {
  const { home, data } = fakeHome()
  const r = deleteAccount({ scope: 'v1_public_200', mode: 'purge', dryRun: true, home })
  assert.equal(r.ok, true)
  assert.equal(r.dryRun, true)
  assert.equal(r.deleted, false)
  assert.ok(Array.isArray(r.plan.willRemove) && r.plan.willRemove.length === 2)
  assert.ok(fs.existsSync(path.join(data, 'users', 'v1_public_200', 'app-auth', 'token.json')))
  assert.equal(fs.existsSync(r.plan.trashDir), false)
})

test('deleteAccount: 不存在的账号返回可读错误', () => {
  const { home } = fakeHome()
  const r = deleteAccount({ scope: 'v1_public_999', home })
  assert.equal(r.ok, false)
  assert.match(r.reason, /没有这个账号/)
})

test('readPortalAuth: reads the Network/Cookies database in a newer Electron partition', async () => {
  const { readPortalAuth } = await import('../lib/portal.js')
  const { DatabaseSync } = await import('node:sqlite')
  const { home } = fakeHome()
  const partition = path.join(home, '.local', 'share', 'TeleAgent', 'Partitions', 'owner%3Av1_public_100')
  const network = path.join(partition, 'Network')
  fs.mkdirSync(network)
  const db = new DatabaseSync(path.join(network, 'Cookies'))
  try {
    db.exec("create table cookies(name text, value text, host_key text, encrypted_value blob); insert into cookies values ('operationToken','op-network','agent.teleai.com.cn',NULL);")
  } finally {
    db.close()
  }
  assert.equal(readPortalAuth(home, 'v1_public_100')?.operationToken, 'op-network')
})
