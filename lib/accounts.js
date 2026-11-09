/**
 * 多账号：列举 / 逐账号积分 / 切换。
 *
 * ## 为什么这个模块写得这么保守
 *
 * 切换账号要写 `current-owner.json` —— 那是**桌面端自己的文件**。写错的后果是
 * 客户端启动后指向一个不存在的账号，用户看到的是"登录态莫名其妙没了"。
 * 而且它无法在本机用两个可用账号验证（两个旧账号都被封了）。
 *
 * 因此这里的规则是：
 *  1. 桌面端在运行时**拒绝**切换（它退出时会覆盖这个文件）
 *  2. 切换前**备份**，失败**回滚**
 *  3. 写文件用"临时文件 + rename"（原子替换，不会留下半个 JSON）
 *  4. 支持 `dryRun`：只报告将要做什么，一个字节都不写
 *  5. `generation` 只增不减：客户端用它判断谁是更新的 owner
 */
import fs from 'node:fs'
import path from 'node:path'
import { appPaths, currentScope } from './models.js'
import { decryptSafeStorage, parseClaims, readSafeStorageKey } from './credential.js'
import { accountCookiePaths, userIdFromScope, readPortalAuth, fetchPoints } from './portal.js'

/** `users/<scope>` 目录名的形状 */
const SCOPE_RE = /^v1_[a-z]+_(\d+)$/

function ownerFilePath(home) {
  return path.join(appPaths(home).data, 'current-owner.json')
}

/** 读取 current-owner.json（不存在或损坏时返回 null，不抛错） */
export function readOwnerFile(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(ownerFilePath(home), 'utf8'))
    return {
      ownerDir: typeof raw?.ownerDir === 'string' ? raw.ownerDir : null,
      tenantId: typeof raw?.tenantId === 'string' ? raw.tenantId : null,
      userId: typeof raw?.userId === 'string' ? raw.userId : null,
      generation: Number.isFinite(raw?.generation) ? raw.generation : 0,
      raw,
    }
  } catch {
    return null
  }
}

/**
 * 列举本机所有账号。
 *
 * 账号名来自各自 token.json 的 claims（同一个钥匙串密码批量解密）。
 * 任何单个账号读取失败都只影响它自己，不中断列表。
 */
export function listAccounts(home) {
  const paths = appPaths(home)
  const usersDir = path.join(paths.data, 'users')
  const owner = readOwnerFile(home)
  const current = (() => {
    try { return currentScope(paths.data) } catch { return owner?.ownerDir ?? null }
  })()

  let entries = []
  try {
    entries = fs.readdirSync(usersDir, { withFileTypes: true })
  } catch {
    return []
  }

  // 钥匙串只读一次：所有账号共用同一个 safeStorage 密码
  let storageKey = null
  const getStorageKey = () => {
    if (storageKey !== null) return storageKey
    try {
      const r = readSafeStorageKey(home)
      storageKey = r.ok === true ? r.key : ''
    } catch {
      storageKey = ''
    }
    return storageKey
  }

  const accounts = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !SCOPE_RE.test(entry.name)) continue
    const scope = entry.name
    const tokenFile = path.join(usersDir, scope, 'app-auth', 'token.json')

    const account = {
      scope,
      userId: userIdFromScope(scope),
      isCurrent: scope === current,
      hasToken: fs.existsSync(tokenFile),
      hasCookies: accountCookiePaths(paths.data, scope).some((file) => fs.existsSync(file)),
      accountName: null,
      expiresAt: null,
      daysLeft: null,
      state: 'unknown',
      detail: null,
    }

    if (!account.hasToken) {
      account.state = 'no_token'
      account.detail = '没有 token.json（登录已清除或从未登录）'
      accounts.push(account)
      continue
    }

    try {
      const envelope = JSON.parse(fs.readFileSync(tokenFile, 'utf8'))
      if (typeof envelope?.encryptedToken !== 'string' || envelope.encryptedToken.length === 0) {
        account.state = 'empty_token'
        account.detail = 'token.json 里没有 encryptedToken'
        accounts.push(account)
        continue
      }
      const key = getStorageKey()
      if (!key) {
        account.state = 'keychain_unavailable'
        account.detail = '系统凭据存储不可读，无法解密该账号的凭据'
        accounts.push(account)
        continue
      }
      const claims = parseClaims(decryptSafeStorage(envelope.encryptedToken, key))
      account.accountName = claims.accountName ?? null
      account.expiresAt = typeof claims.exp === 'number' ? claims.exp * 1000 : null
      account.daysLeft = account.expiresAt === null ? null : Math.floor((account.expiresAt - Date.now()) / 86_400_000)
      account.state = 'ok'
      account.detail = account.daysLeft === null ? '凭据可用' : `剩余 ${account.daysLeft} 天`
    } catch (error) {
      account.state = 'unreadable'
      account.detail = `读取失败：${String(error?.message ?? error)}`
    }

    accounts.push(account)
  }

  // 当前账号排最前，其余按 userId 倒序（新的在前）
  return accounts.sort((a, b) => (b.isCurrent ? 1 : 0) - (a.isCurrent ? 1 : 0) || Number(b.userId ?? 0) - Number(a.userId ?? 0))
}

/**
 * 逐账号的积分（只读）。
 * 与聊天通道无关：封禁的账号通常仍能读积分（实测）。
 */
export async function fetchAccountPoints(scope, home) {
  const auth = readPortalAuth(home, scope)
  if (!auth) return { ok: false, scope, error: '该账号没有可用的 portal cookie' }
  try {
    const r = await fetchPoints(auth)
    return r.ok
      ? { ok: true, scope, balance: r.balance, expiresAt: r.expiresAt ?? null }
      : { ok: false, scope, error: r.error ?? '读取失败' }
  } catch (error) {
    return { ok: false, scope, error: String(error?.message ?? error) }
  }
}

/** 并行读取多个账号的积分；单个失败不影响其他 */
export async function fetchAllAccountPoints(scopes, home) {
  const results = await Promise.all(scopes.map((scope) => fetchAccountPoints(scope, home)))
  return results
}

/**
 * 切换当前账号。
 *
 * @param {object} options
 * @param {string} options.scope 目标账号目录名
 * @param {boolean} [options.dryRun] 只报告，不写文件
 * @param {boolean} [options.appRunning] 调用方探测到的桌面端运行状态
 * @param {string} [options.home]
 * @returns {{ok:boolean, dryRun:boolean, changed:boolean, reason?:string, backup?:string, owner?:object, account?:object}}
 */
export function switchAccount({ scope, dryRun = false, appRunning = false, home } = {}) {
  const accounts = listAccounts(home)
  const target = accounts.find((a) => a.scope === scope)
  if (target === undefined) {
    return { ok: false, dryRun, changed: false, reason: `没有这个账号：${scope}` }
  }
  if (target.isCurrent) {
    return { ok: true, dryRun, changed: false, reason: '已经是当前账号', account: target }
  }
  // 桌面端运行时会覆盖这个文件，切换不会生效，且可能造成状态不一致。
  // 这条排在凭据检查之前：它是"现在就能做点什么"的原因，比"缺 token"更该先说。
  if (appRunning === true || (Array.isArray(appRunning) && appRunning.length > 0)) {
    return {
      ok: false,
      dryRun,
      changed: false,
      reason: 'TeleAgent 桌面端正在运行：请完全退出后再切换（它退出时会重写 owner 文件）',
      account: target,
    }
  }
  if (target.hasToken !== true) {
    return { ok: false, dryRun, changed: false, reason: '目标账号没有可用的 token.json，先在该账号下登录一次', account: target }
  }

  const file = ownerFilePath(home)
  const previous = readOwnerFile(home)
  const nextOwner = {
    ownerDir: scope,
    tenantId: (scope.match(SCOPE_RE)?.[0] ?? '').includes('public') ? 'public' : (previous?.tenantId ?? null),
    userId: target.userId,
    generation: (previous?.generation ?? 0) + 1,
  }

  if (dryRun) {
    return { ok: true, dryRun: true, changed: false, owner: nextOwner, previous, account: target }
  }

  // 备份 → 原子写 → 失败回滚
  let backup = null
  try {
    if (fs.existsSync(file)) {
      backup = file + '.bak-' + Date.now()
      fs.copyFileSync(file, backup)
    }
    const tmp = file + '.tmp-' + process.pid
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(nextOwner, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch (error) {
    // 回滚：有备份就恢复，没有就删掉可能写了一半的文件
    try {
      if (backup !== null) fs.copyFileSync(backup, file)
      else if (!previous) fs.rmSync(file, { force: true })
    } catch { /* 回滚也失败时只能上报 */ }
    return { ok: false, dryRun, changed: false, reason: `写入失败（已尝试回滚）：${String(error?.message ?? error)}`, backup }
  }

  return { ok: true, dryRun, changed: true, owner: nextOwner, previous, backup, account: target }
}

/**
 * 用**该账号自己的 cookie** 领取每日积分。
 *
 * 不复用当前账号的凭据：那会把积分领到别人账上（或者直接失败）。
 * 幂等：先看 claimedToday，已领直接返回，绝不重复调用领取接口。
 */
export async function claimForAccount(scope, home) {
  const auth = readPortalAuth(home, scope)
  if (!auth) return { ok: false, scope, error: '该账号没有可用的 portal cookie' }
  try {
    const { fetchDailyStatus, claimDaily } = await import('./portal.js')
    const before = await fetchDailyStatus(auth)
    if (!before.ok) return { ok: false, scope, error: before.error ?? '读取领取状态失败' }
    if (before.claimedToday === true) {
      return { ok: true, scope, claimed: false, alreadyClaimed: true, points: 0 }
    }
    const result = await claimDaily(auth)
    return { ...result, scope }
  } catch (error) {
    return { ok: false, scope, error: String(error?.message ?? error) }
  }
}

/**
 * 删除一个账号。
 *
 * 两种模式：
 *   - `logout`（默认）：只删 `<scope>/app-auth/token.json`，账号目录与个人数据全部保留，
 *     列表里会变成 `no_token`。
 *   - `purge`：把 `users/<scope>` 与 `Partitions/owner%3A<scope>` **移动到回收站**，
 *     账号从列表里消失。移动而不是删除，所以随时可以手动搬回来。
 *
 * 三重保护：
 *   1. 桌面端运行中拒绝（它持有 cookie 库，且退出时会重写凭据）
 *   2. **当前账号拒绝**（否则 current-owner.json 会指向不存在的账号）
 *   3. dryRun 什么都不动
 */
export function deleteAccount({ scope, mode = 'logout', dryRun = false, appRunning = false, home } = {}) {
  const accounts = listAccounts(home)
  const target = accounts.find((a) => a.scope === scope)
  if (target === undefined) {
    return { ok: false, dryRun, deleted: false, reason: `没有这个账号：${scope}` }
  }
  if (target.isCurrent) {
    return {
      ok: false,
      dryRun,
      deleted: false,
      reason: '不能删除当前正在使用的账号：先切换到其他账号，再删除它',
      account: target,
    }
  }
  if (appRunning === true || (Array.isArray(appRunning) && appRunning.length > 0)) {
    return {
      ok: false,
      dryRun,
      deleted: false,
      reason: 'TeleAgent 桌面端正在运行：请完全退出后再删除（它可能把凭据写回来）',
      account: target,
    }
  }

  const paths = appPaths(home)
  const tokenFile = path.join(paths.data, 'users', scope, 'app-auth', 'token.json')
  const userDir = path.join(paths.data, 'users', scope)
  const partitionDir = path.join(paths.data, 'Partitions', `owner%3A${scope}`)
  const purge = mode === 'purge'

  const plan = {
    mode: purge ? 'purge' : 'logout',
    scope,
    willRemove: purge ? [userDir, partitionDir] : [tokenFile],
    trashDir: purge ? path.join(paths.home, '.dsh-teleagent-trash', `${Date.now()}-${scope}`) : null,
  }

  if (dryRun) {
    return { ok: true, dryRun: true, deleted: false, plan, account: target }
  }

  try {
    if (!purge) {
      if (fs.existsSync(tokenFile)) fs.rmSync(tokenFile, { force: true })
      return { ok: true, dryRun: false, deleted: true, plan, account: target }
    }

    // purge：整目录移到回收站（可恢复）
    const trashDir = plan.trashDir
    fs.mkdirSync(trashDir, { recursive: true })
    const moved = []
    for (const [source, name] of [[userDir, 'user'], [partitionDir, 'partition']]) {
      if (!fs.existsSync(source)) continue
      const dest = path.join(trashDir, name)
      fs.renameSync(source, dest)
      moved.push({ from: source, to: dest })
    }
    return { ok: true, dryRun: false, deleted: true, plan: { ...plan, moved }, account: target }
  } catch (error) {
    return { ok: false, dryRun, deleted: false, reason: `删除失败：${String(error?.message ?? error)}`, plan, account: target }
  }
}

/** 账号列表摘要（给状态接口/CLI 用） */
export function summarizeAccounts(home) {
  const accounts = listAccounts(home)
  const current = accounts.find((a) => a.isCurrent) ?? null
  return {
    total: accounts.length,
    current: current ? { scope: current.scope, accountName: current.accountName } : null,
    accounts,
  }
}
