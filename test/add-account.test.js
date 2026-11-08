/**
 * 多账号登录入口测试。
 *
 * 这里保护的核心是「原账号凭据不能丢」：
 *  1. 桌面端退出登录会删掉当前 owner 的 token.json → 流程必须先备份
 *  2. 新账号登录后，原账号 token 要原样写回（多账号才真的可用）
 *  3. 同一账号重新登录时**不能**拿旧备份覆盖新凭据
 *  4. 超时 / 取消 / 崩溃（下次启动）都要能恢复
 *
 * 全部在临时目录里跑：不唤起真实应用、不读钥匙串、不发网络请求。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  backupFilePath,
  clearPendingBackup,
  createPendingBackup,
  inspectToken,
  readPendingBackup,
  restorePendingBackup,
  runAddAccountFlow,
  scanTokenScopes,
} from '../lib/add-account.js'
import { cancelAddAccountFlow, getAddAccountState } from '../lib/status.js'

const SCOPE_A = 'v1_public_2111663603058118656'
const SCOPE_B = 'v1_public_2111663603058119999'

/** 造一个假的 TeleAgent HOME（只放数据目录，不碰真实配置） */
function fakeHome({ scopes = [SCOPE_A], current = SCOPE_A } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-add-account-'))
  const data = path.join(home, '.local', 'share', 'TeleAgent')
  fs.mkdirSync(path.join(data, 'users'), { recursive: true })
  for (const scope of scopes) writeToken(home, scope)
  if (current !== null) writeOwner(home, current)
  return { home, data }
}

function userDir(home, scope) {
  return path.join(home, '.local', 'share', 'TeleAgent', 'users', scope)
}

function tokenPath(home, scope) {
  return path.join(userDir(home, scope), 'app-auth', 'token.json')
}

function writeToken(home, scope, encryptedToken = `v10-fake-${scope}`) {
  fs.mkdirSync(path.join(userDir(home, scope), 'app-auth'), { recursive: true })
  fs.writeFileSync(tokenPath(home, scope), JSON.stringify({ version: 1, encryptedToken, scheme: 'safe_storage' }))
  return tokenPath(home, scope)
}

function writeOwner(home, scope) {
  const data = path.join(home, '.local', 'share', 'TeleAgent')
  fs.writeFileSync(path.join(data, 'current-owner.json'), JSON.stringify({
    ownerDir: scope, tenantId: 'public', userId: scope.split('_').pop(), generation: 3,
  }, null, 2))
}

function removeToken(home, scope) {
  fs.rmSync(tokenPath(home, scope), { force: true })
}

/** 默认的凭据检查：只认这几个 scope，避免依赖真实钥匙串 */
function fakeInspect(allowed) {
  return (scope) => {
    if (!allowed.has(scope)) return { scope, ok: false, reason: 'not_allowed' }
    return {
      scope,
      ok: true,
      verified: true,
      accountName: `acct-${scope.slice(-4)}`,
      accountId: scope.slice(-6),
      userId: scope.split('_').pop(),
      expiresAt: Date.now() + 86_400_000,
      daysLeft: 1,
    }
  }
}

// ---------------------------------------------------------------- 备份 / 恢复

test('createPendingBackup: 逐字节备份当前账号的 token.json', () => {
  const { home } = fakeHome()
  const before = fs.readFileSync(tokenPath(home, SCOPE_A), 'utf8')
  const r = createPendingBackup({ home, scope: SCOPE_A })
  assert.equal(r.created, true)
  const manifest = readPendingBackup(home)
  assert.equal(manifest.scope, SCOPE_A)
  assert.equal(Buffer.from(manifest.bytesBase64, 'base64').toString('utf8'), before)
  assert.ok(fs.existsSync(backupFilePath(home)))
})

test('createPendingBackup: 没有 token 时不创建备份', () => {
  const { home } = fakeHome({ scopes: [] })
  const r = createPendingBackup({ home, scope: SCOPE_A })
  assert.equal(r.created, false)
  assert.equal(fs.existsSync(backupFilePath(home)), false)
})

test('restorePendingBackup: 原 token 被删掉时原样写回', () => {
  const { home } = fakeHome()
  const before = fs.readFileSync(tokenPath(home, SCOPE_A), 'utf8')
  createPendingBackup({ home, scope: SCOPE_A })
  removeToken(home, SCOPE_A)
  const r = restorePendingBackup(home)
  assert.equal(r.restored, true)
  assert.equal(fs.readFileSync(tokenPath(home, SCOPE_A), 'utf8'), before)
  assert.equal(fs.existsSync(backupFilePath(home)), false, '恢复后清单要清掉')
})

test('restorePendingBackup: 已有新凭据时绝不覆盖（同一账号重新登录）', () => {
  const { home } = fakeHome()
  createPendingBackup({ home, scope: SCOPE_A })
  writeToken(home, SCOPE_A, 'v10-fresh-login')
  const fresh = fs.readFileSync(tokenPath(home, SCOPE_A), 'utf8')
  const r = restorePendingBackup(home)
  assert.equal(r.restored, false)
  assert.equal(r.skipped, true)
  assert.equal(fs.readFileSync(tokenPath(home, SCOPE_A), 'utf8'), fresh, '新凭据不能被旧备份覆盖')
  assert.equal(fs.existsSync(backupFilePath(home)), false)
})

test('restorePendingBackup: 没有备份时返回 no_backup 而不是抛错', () => {
  const { home } = fakeHome()
  assert.deepEqual(restorePendingBackup(home), { restored: false, reason: 'no_backup' })
})

test('clearPendingBackup: 幂等', () => {
  const { home } = fakeHome()
  createPendingBackup({ home, scope: SCOPE_A })
  clearPendingBackup(home)
  clearPendingBackup(home)
  assert.equal(fs.existsSync(backupFilePath(home)), false)
})

// ---------------------------------------------------------------- 凭据检查

test('scanTokenScopes: 只列有 token.json 的账号', () => {
  const { home } = fakeHome({ scopes: [SCOPE_A] })
  fs.mkdirSync(path.join(userDir(home, SCOPE_B), 'app-auth'), { recursive: true })
  const map = scanTokenScopes(home)
  assert.deepEqual([...map.keys()], [SCOPE_A])
  assert.ok(map.get(SCOPE_A).mtimeMs > 0)
})

test('inspectToken: 没有 token 时返回结构化结果而不抛错', () => {
  const { home } = fakeHome({ scopes: [] })
  const r = inspectToken(SCOPE_A, home)
  assert.equal(r.ok, false)
  assert.equal(r.hasToken, false)
  assert.equal(r.reason, 'no_token')
})

test('inspectToken: 空 encryptedToken 返回 empty_token', () => {
  const { home } = fakeHome({ scopes: [] })
  writeToken(home, SCOPE_A, '')
  const r = inspectToken(SCOPE_A, home)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'empty_token')
})

// ---------------------------------------------------------------- 流程

test('runAddAccountFlow: 登录新账号后写回原账号凭据，并退出应用', async () => {
  const { home } = fakeHome()
  const originalA = fs.readFileSync(tokenPath(home, SCOPE_A), 'utf8')
  let quitCalls = 0

  const result = await runAddAccountFlow({
    home,
    timeoutMs: 2000,
    pollMs: 5,
    isInstalled: () => true,
    isRunning: () => false,   // 应用本来没开 → 登录完成后由插件退出
    inspect: fakeInspect(new Set([SCOPE_B])),
    quit: async () => { quitCalls += 1; return { method: 'test' } },
    launch: async () => {
      // 模拟桌面端：退出登录删除当前 owner 的 token，然后登录另一个账号
      removeToken(home, SCOPE_A)
      writeToken(home, SCOPE_B)
      writeOwner(home, SCOPE_B)
      return { pids: [1234], alreadyRunning: false }
    },
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.code, 'added')
  assert.equal(result.added.scope, SCOPE_B)
  assert.equal(result.added.accountName, 'acct-9999')
  assert.equal(result.previousScope, SCOPE_A)
  assert.equal(result.restored.restored, true, '原账号登录态应写回')
  assert.equal(fs.readFileSync(tokenPath(home, SCOPE_A), 'utf8'), originalA, '原账号凭据必须逐字节一致')
  assert.ok(fs.existsSync(tokenPath(home, SCOPE_B)), '新账号凭据不能被删')
  assert.equal(quitCalls, 1)
  assert.equal(fs.existsSync(backupFilePath(home)), false, '成功后不能残留备份清单')
})

test('runAddAccountFlow: 应用本来就在运行时不去退出它', async () => {
  const { home } = fakeHome()
  let quitCalls = 0
  const result = await runAddAccountFlow({
    home,
    timeoutMs: 2000,
    pollMs: 5,
    isInstalled: () => true,
    isRunning: () => true,
    inspect: fakeInspect(new Set([SCOPE_B])),
    quit: async () => { quitCalls += 1; return { method: 'test' } },
    launch: async () => {
      removeToken(home, SCOPE_A)
      writeToken(home, SCOPE_B)
      writeOwner(home, SCOPE_B)
      return { alreadyRunning: true }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.appWasRunning, true)
  assert.equal(quitCalls, 0, '用户本来开着的应用不能被插件退出')
})

test('runAddAccountFlow: 超时会恢复原账号凭据并退出我们拉起的应用', async () => {
  const { home } = fakeHome()
  const originalA = fs.readFileSync(tokenPath(home, SCOPE_A), 'utf8')
  let quitCalls = 0
  const result = await runAddAccountFlow({
    home,
    timeoutMs: 60,
    pollMs: 10,
    isInstalled: () => true,
    isRunning: () => false,
    inspect: fakeInspect(new Set([SCOPE_B])),
    quit: async () => { quitCalls += 1; return { method: 'test' } },
    launch: async () => {
      removeToken(home, SCOPE_A)   // 用户退出了登录，但最后没登录新账号
      return { alreadyRunning: false }
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'timeout')
  assert.equal(result.timedOut, true)
  assert.equal(result.restored.restored, true)
  assert.equal(fs.readFileSync(tokenPath(home, SCOPE_A), 'utf8'), originalA)
  assert.equal(quitCalls, 1)
})

test('runAddAccountFlow: 取消后恢复原账号凭据', async () => {
  const { home } = fakeHome()
  const originalA = fs.readFileSync(tokenPath(home, SCOPE_A), 'utf8')
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 30)
  const result = await runAddAccountFlow({
    home,
    timeoutMs: 5000,
    pollMs: 10,
    signal: controller.signal,
    isInstalled: () => true,
    isRunning: () => false,
    inspect: fakeInspect(new Set([SCOPE_B])),
    quit: async () => ({ method: 'test' }),
    launch: async () => {
      removeToken(home, SCOPE_A)
      return { alreadyRunning: false }
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'cancelled')
  assert.equal(result.restored.restored, true)
  assert.equal(fs.readFileSync(tokenPath(home, SCOPE_A), 'utf8'), originalA)
})

test('runAddAccountFlow: 同一账号重新登录不覆盖新凭据', async () => {
  const { home } = fakeHome()
  let quitCalls = 0
  const result = await runAddAccountFlow({
    home,
    timeoutMs: 2000,
    pollMs: 5,
    isInstalled: () => true,
    isRunning: () => false,
    inspect: fakeInspect(new Set([SCOPE_A])),
    quit: async () => { quitCalls += 1; return { method: 'test' } },
    launch: async () => {
      // 用户退出后又用同一个账号登录：应用写入的是新 token
      writeToken(home, SCOPE_A, 'v10-brand-new-login')
      return { alreadyRunning: false }
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'same_account')
  assert.equal(result.reloggedIn.scope, SCOPE_A)
  assert.match(fs.readFileSync(tokenPath(home, SCOPE_A), 'utf8'), /v10-brand-new-login/, '新凭据不能被旧备份覆盖')
  assert.equal(fs.existsSync(backupFilePath(home)), false)
  assert.equal(quitCalls, 1)
})

test('runAddAccountFlow: 未安装桌面端时直接失败，不启动流程', async () => {
  const { home } = fakeHome()
  let launched = false
  const result = await runAddAccountFlow({
    home,
    isInstalled: () => false,
    launch: async () => { launched = true; return {} },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'app_missing')
  assert.equal(launched, false)
})

test('runAddAccountFlow: 备份写不进去时中止（不能让用户丢凭据）', async () => {
  const { home } = fakeHome()
  // 把备份路径占成目录 → 原子写 rename 失败
  fs.mkdirSync(backupFilePath(home), { recursive: true })
  let launched = false
  const originalA = fs.readFileSync(tokenPath(home, SCOPE_A), 'utf8')
  const result = await runAddAccountFlow({
    home,
    isInstalled: () => true,
    isRunning: () => false,
    launch: async () => { launched = true; return {} },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'backup_failed')
  assert.equal(launched, false, '备份失败就不该唤起应用')
  assert.equal(fs.readFileSync(tokenPath(home, SCOPE_A), 'utf8'), originalA)
})

test('runAddAccountFlow: 没有当前账号时也能添加第一个账号（不备份）', async () => {
  const { home } = fakeHome({ scopes: [], current: null })
  const result = await runAddAccountFlow({
    home,
    timeoutMs: 2000,
    pollMs: 5,
    isInstalled: () => true,
    isRunning: () => false,
    inspect: fakeInspect(new Set([SCOPE_B])),
    quit: async () => ({ method: 'test' }),
    launch: async () => {
      writeToken(home, SCOPE_B)
      writeOwner(home, SCOPE_B)
      return { alreadyRunning: false }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.added.scope, SCOPE_B)
  assert.equal(result.backup.created, false)
  assert.equal(result.restored.restored, false)
})

test('runAddAccountFlow: 上次崩溃留下的备份会先恢复再开始', async () => {
  const { home } = fakeHome()
  const originalA = fs.readFileSync(tokenPath(home, SCOPE_A), 'utf8')
  createPendingBackup({ home, scope: SCOPE_A })
  removeToken(home, SCOPE_A)   // 模拟上次流程崩溃在"已退出登录"这一步
  const result = await runAddAccountFlow({
    home,
    timeoutMs: 60,
    pollMs: 10,
    isInstalled: () => true,
    isRunning: () => true,      // 不退出应用，测试只关心恢复
    inspect: fakeInspect(new Set()),
    launch: async () => ({ alreadyRunning: true }),
  })
  assert.equal(result.code, 'timeout')
  assert.equal(fs.readFileSync(tokenPath(home, SCOPE_A), 'utf8'), originalA, '启动时应先恢复上次的备份')
  assert.equal(fs.existsSync(backupFilePath(home)), false)
})

// ---------------------------------------------------------------- DSH home 与数据 home

// 回归：`$DSH_HOME` 指向非默认目录时，备份清单必须和启动恢复走同一个路径。
// 以前 `runAddAccountFlow` 把 `process.env.HOME` 显式传给 `dshHome(home)`，
// `$DSH_HOME` 被忽略 → 清单写到 `$HOME/.dsh`；而启动时 `restorePendingBackup()`
// 无参调用走 `$DSH_HOME` 解析，两边对不上，崩溃后原账号登录就丢了。

test('备份清单跟随 $DSH_HOME，而不是固定 $HOME/.dsh', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-dshhome-'))
  const customDsh = path.join(base, 'custom-dsh-home')
  const savedHome = process.env.HOME
  const savedDsh = process.env.DSH_HOME
  try {
    fs.mkdirSync(customDsh, { recursive: true })
    process.env.HOME = base
    process.env.DSH_HOME = customDsh

    // 生产路径：不传 home，让 store.js 按 $DSH_HOME 解析
    assert.equal(
      backupFilePath(),
      path.join(customDsh, 'teleagent-login-backup.json'),
      '清单必须落在 $DSH_HOME 下',
    )
    assert.notEqual(
      backupFilePath(),
      path.join(base, '.dsh', 'teleagent-login-backup.json'),
      '不能落到 $HOME/.dsh',
    )
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome
    if (savedDsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedDsh
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('写入与启动恢复用同一个清单路径（$DSH_HOME 非默认时也能自愈）', () => {
  const { home } = fakeHome()
  const customDsh = path.join(home, 'custom-dsh-home')
  const savedDsh = process.env.DSH_HOME
  const savedHome = process.env.HOME
  try {
    fs.mkdirSync(customDsh, { recursive: true })
    process.env.DSH_HOME = customDsh
    // 生产形态：数据 home 就是 $HOME，DSH home 被重定向到 $DSH_HOME
    process.env.HOME = home
    const manifestPath = path.join(customDsh, 'teleagent-login-backup.json')
    assert.equal(
      backupFilePath(),
      manifestPath,
      '不传 home 时清单应跟随 $DSH_HOME',
    )

    const originalA = fs.readFileSync(tokenPath(home, SCOPE_A), 'utf8')
    createPendingBackup({ scope: SCOPE_A })
    assert.ok(fs.existsSync(manifestPath), '清单应写在 $DSH_HOME')
    assert.equal(
      fs.existsSync(path.join(home, '.dsh', 'teleagent-login-backup.json')),
      false,
      '不能写到 $HOME/.dsh',
    )

    // 模拟崩溃后重启：index.js 用无参 restorePendingBackup() 自愈
    removeToken(home, SCOPE_A)
    const restored = restorePendingBackup()
    assert.equal(restored.restored, true, '启动恢复必须能找到清单')
    assert.equal(fs.readFileSync(tokenPath(home, SCOPE_A), 'utf8'), originalA)
  } finally {
    if (savedDsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedDsh
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome
  }
})

test('显式传 home 时仍写到 home/.dsh（测试隔离语义不变）', () => {
  const { home } = fakeHome()
  const r = createPendingBackup({ home, scope: SCOPE_A })
  assert.equal(r.created, true)
  assert.equal(r.backupFile, path.join(home, '.dsh', 'teleagent-login-backup.json'))
})

// ---------------------------------------------------------------- 状态单例

test('status: 没有进行中的流程时，状态可读且取消返回可读错误', () => {
  const state = getAddAccountState()
  assert.equal(state.running, false)
  const r = cancelAddAccountFlow()
  assert.equal(r.ok, false)
  assert.match(r.reason, /没有进行中/)
})
