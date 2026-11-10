/**
 * 多账号登录入口：在 TeleAgent 桌面端登录**另一个**账号，并把原账号的登录态保留下来。
 *
 * ## 为什么必须「备份 → 登录 → 写回」token
 *
 * TeleAgent 桌面端同一时刻只有一个 owner（`current-owner.json`）。在应用里点
 * 「退出登录」时，主进程执行 `setToken("")` → `deleteOwnerToken(currentOwner)`，
 * 会**删掉当前 owner 的 `app-auth/token.json`**（逆向自 main-runtime 的
 * `AppAuth.setToken`，见 CHANGELOG「多账号登录入口」）。也就是说：
 * 桌面端自己换号登录，会把原账号的凭据删掉 —— 不备份的话，插件里的「多账号」
 * 永远退化成单账号（列表里另一个账号变成 `no_token`，切过去也用不了）。
 *
 * 因此这里的流程是：
 *   1. 先把当前账号的 `token.json` **原字节**备份到插件自己的目录
 *      （`$DSH_HOME/teleagent-login-backup.json`，原子写）
 *   2. 唤起 TeleAgent：用户在应用里「设置 → 账号 → 退出登录」，
 *      再用另一个账号登录（登录窗是主进程 IPC 独占的，外部进程打不开）
 *   3. 轮询检测新账号（新 `users/<scope>/app-auth/token.json` 出现且能解密）
 *   4. 检测到后，如果原账号的 token.json 已被应用删掉，**原样写回**
 *      （只在文件不存在时写；用户重新登录的是同一账号时绝不覆盖新凭据）
 *   5. 如果是我们拉起的应用，完成后退出它（与 lifecycle.loginThenQuit 一致）
 *
 * ## 保守规则（与 accounts.js 同源）
 *
 *  - 绝不修改 `current-owner.json`：换号是桌面端自己做的
 *  - 只写回「应用自己删掉、且我们逐字节备份过」的文件，不生成任何新凭据
 *  - 超时 / 取消 / 出错也恢复，不让用户遇到「登录态莫名其妙没了」
 *  - 备份清单原子落盘；DSH 中途崩溃时，下次启动用 `restorePendingBackup()` 自愈
 */
import fs from 'node:fs'
import path from 'node:path'

import { appPaths, currentScope } from './models.js'
import { decryptSafeStorage, parseClaims, readSafeStorageKey } from './credential.js'
import { isAppRunningNow, launchApp, quitApp } from './lifecycle.js'
import { checkDesktopApp } from './desktop.js'
import { userIdFromScope } from './portal.js'
import { dshHome } from './store.js'

/** 备份清单文件名（位于 $DSH_HOME） */
export const BACKUP_FILENAME = 'teleagent-login-backup.json'

/** 默认等待用户完成登录的时长 */
export const DEFAULT_ADD_ACCOUNT_TIMEOUT_MS = 5 * 60_000
/** 默认轮询间隔 */
export const DEFAULT_ADD_ACCOUNT_POLL_MS = 2000

/**
 * 备份清单路径。
 *
 * **这里必须解析 DSH home，绝不能用「TeleAgent 数据 home」。** 两个概念不同：
 *  - TeleAgent 数据 home（`$HOME`，或测试里注入的临时目录）→ 决定 token.json 在哪
 *  - DSH home（`$DSH_HOME`，缺省 `$HOME/.dsh`）→ 决定插件自己的状态文件在哪
 *
 * 历史 bug：调用方把 `process.env.HOME` 当第一个参数显式传进来时，
 * `dshHome(home)` 会走「显式路径」分支返回 `$HOME/.dsh`，把 `$DSH_HOME`
 * 整个忽略掉 —— 清单于是落到一个用户配置之外的位置。现在 `home` 只作为
 * 「TeleAgent 数据 home」的**回退基准**：不传就按 `$HOME` 解析 DSH home。
 */
export function backupFilePath(home) {
  return path.join(dshHome(home), BACKUP_FILENAME)
}

/**
 * 备份清单路径（显式区分两个 home）。
 *
 * @param {object} [options]
 * @param {string} [options.home]      TeleAgent 数据 home（调用方显式指定时才用于推导）
 * @param {string} [options.dshHomeDir] DSH home（定位清单）；给出时优先用它
 */
export function backupFilePathFor({ home, dshHomeDir } = {}) {
  if (typeof dshHomeDir === 'string' && dshHomeDir !== '') {
    return path.join(dshHomeDir, BACKUP_FILENAME)
  }
  // 注意：这里传的是**调用方是否显式给了 home**，不是 `home ?? $HOME`。
  // 后者会让 dshHome(home) 走进「显式路径」分支，把 $DSH_HOME 忽略掉。
  return backupFilePath(home)
}

/** 某个账号的 token.json 路径 */
export function tokenFilePath(home, scope) {
  return path.join(appPaths(home).data, 'users', scope, 'app-auth', 'token.json')
}

/** 原子写文件（临时文件 + rename），不会留下半个 JSON */
function writeFileAtomic(file, bytes) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, bytes)
  try {
    fs.renameSync(tmp, file)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw error
  }
}

/**
 * 扫描本机所有「有 token.json」的账号。
 *
 * 只做目录/文件层面的快照，不碰钥匙串：轮询每 2 秒一次，解密留给候选账号。
 *
 * @returns {Map<string, {scope:string, tokenFile:string, mtimeMs:number, size:number}>}
 */
export function scanTokenScopes(home) {
  const usersDir = path.join(appPaths(home).data, 'users')
  const result = new Map()
  let entries = []
  try { entries = fs.readdirSync(usersDir, { withFileTypes: true }) } catch { return result }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const tokenFile = tokenFilePath(home, entry.name)
    try {
      const stat = fs.statSync(tokenFile)
      result.set(entry.name, { scope: entry.name, tokenFile, mtimeMs: stat.mtimeMs, size: stat.size })
    } catch { /* 该账号没有凭据 */ }
  }
  return result
}

/**
 * 解密并解析某个账号的凭据，返回账号身份。
 *
 * `password` 选项用于批量检查时复用一次钥匙串读取；不传则自己读。
 * 永不抛错：失败都落到 `reason`，让调用方能区分「还没有凭据」和「凭据坏了」。
 *
 * @param {string} scope
 * @param {string} [home]
 * @param {{password?: string|Buffer|null}} [options]
 */
export function inspectToken(scope, home, options = {}) {
  const tokenFile = tokenFilePath(home, scope)
  const base = { scope, tokenFile, hasToken: false, ok: false, verified: false, mtimeMs: null, size: null }

  let stat
  try {
    stat = fs.statSync(tokenFile)
  } catch {
    return { ...base, reason: 'no_token' }
  }
  base.hasToken = true
  base.mtimeMs = stat.mtimeMs
  base.size = stat.size

  let envelope
  try {
    envelope = JSON.parse(fs.readFileSync(tokenFile, 'utf8'))
  } catch {
    return { ...base, reason: 'unreadable' }
  }
  if (typeof envelope?.encryptedToken !== 'string' || envelope.encryptedToken.length === 0) {
    return { ...base, reason: 'empty_token' }
  }

  let password = options.password
  let keychainState = null
  if (password === undefined) {
    const keychain = readSafeStorageKey(home)
    if (keychain.ok === true) password = keychain.key
    else {
      password = null
      keychainState = keychain.state ?? null
    }
  }
  if (!password?.length) {
    return { ...base, reason: 'keychain_unavailable', keychainState }
  }

  let token
  try {
    token = decryptSafeStorage(envelope.encryptedToken, password)
  } catch (error) {
    return { ...base, reason: 'decrypt_failed', error: String(error?.message ?? error) }
  }

  let claims
  try {
    claims = parseClaims(token)
  } catch (error) {
    return { ...base, reason: 'token_malformed', error: String(error?.message ?? error) }
  }

  const expiresAt = typeof claims.exp === 'number' ? claims.exp * 1000 : null
  return {
    ...base,
    ok: true,
    verified: true,
    accountName: claims.accountName ?? null,
    accountId: claims.accountId ?? null,
    tenant: claims.tenant ?? null,
    userId: userIdFromScope(scope) || (claims.userId != null ? String(claims.userId) : null),
    expiresAt,
    daysLeft: expiresAt === null ? null : Math.floor((expiresAt - Date.now()) / 86_400_000),
  }
}

/** 当前 owner（无法识别时返回 null，不抛错） */
export function safeCurrentScope(home) {
  try {
    return currentScope(appPaths(home).data)
  } catch {
    return null
  }
}

/**
 * 备份当前账号的 token.json（逐字节）。
 *
 * 备份失败时返回 `created:false` —— 调用方应**中止**换号流程：
 * 没有备份还让用户退出登录，等于把原账号凭据弄丢。
 */
export function createPendingBackup({ home, dshHomeDir, scope } = {}) {
  if (typeof scope !== 'string' || scope.length === 0) {
    return { created: false, reason: '无法识别当前账号' }
  }
  // TeleAgent 数据 home：显式传入优先，否则按平台取 $HOME / $USERPROFILE 的缺省值。
  // **不能把它当成 `home` 传给 backupFilePathFor**：那会走「显式路径」分支，
  // 把 $DSH_HOME 忽略掉，清单落到 $HOME/.dsh。
  const tokenHome = appPaths(home).home
  const tokenFile = tokenFilePath(tokenHome, scope)
  let bytes
  try {
    bytes = fs.readFileSync(tokenFile)
  } catch {
    return { created: false, scope, reason: '当前账号没有可备份的 token.json' }
  }
  try {
    const envelope = JSON.parse(bytes.toString('utf8'))
    if (typeof envelope?.encryptedToken !== 'string' || envelope.encryptedToken.length === 0) {
      return { created: false, scope, reason: 'token.json 里没有 encryptedToken' }
    }
  } catch {
    return { created: false, scope, reason: 'token.json 无法解析' }
  }

  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    scope,
    tokenFile,
    bytesBase64: bytes.toString('base64'),
  }
  const file = backupFilePathFor({ home, dshHomeDir })
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    writeFileAtomic(file, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
    // 备份里是加密凭据，仍然按最小权限落盘
    try { fs.chmodSync(file, 0o600) } catch { /* 某些文件系统不支持 chmod */ }
    return { created: true, scope, tokenFile, backupFile: file }
  } catch (error) {
    // 写不进备份 = 后续退出登录会真的丢凭据，调用方必须中止流程
    return { created: false, fatal: true, scope, reason: `备份失败：${String(error?.message ?? error)}` }
  }
}

/** 读取未完成的备份清单；不存在或损坏时返回 null（永不抛错） */
export function readPendingBackup(home, options = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(backupFilePathFor({ home, dshHomeDir: options.dshHomeDir }), 'utf8'))
    if (raw?.version !== 1) return null
    if (typeof raw.scope !== 'string' || typeof raw.tokenFile !== 'string') return null
    if (typeof raw.bytesBase64 !== 'string' || raw.bytesBase64.length === 0) return null
    return raw
  } catch {
    return null
  }
}

/** 删除备份清单（幂等） */
export function clearPendingBackup(home, options = {}) {
  try { fs.rmSync(backupFilePathFor({ home, dshHomeDir: options.dshHomeDir }), { force: true }) } catch { /* ignore */ }
}

/**
 * 把备份写回原账号。
 *
 * **只在目标 token.json 不存在时写**：
 *  - 新账号登录后，原账号文件已被应用删掉 → 写回，原账号恢复可用
 *  - 用户重新登录的是同一账号 → 文件已存在（新凭据），跳过，绝不覆盖
 *
 * @returns {{restored:boolean, skipped?:boolean, scope?:string, reason?:string, error?:string}}
 */
export function restorePendingBackup(home, options = {}) {
  const manifest = readPendingBackup(home, options)
  if (manifest === null) return { restored: false, reason: 'no_backup' }

  try {
    if (fs.existsSync(manifest.tokenFile)) {
      clearPendingBackup(home, options)
      return { restored: false, skipped: true, scope: manifest.scope, reason: '该账号已有新的登录凭据（不覆盖）' }
    }
    const bytes = Buffer.from(manifest.bytesBase64, 'base64')
    fs.mkdirSync(path.dirname(manifest.tokenFile), { recursive: true })
    writeFileAtomic(manifest.tokenFile, bytes)
    clearPendingBackup(home, options)
    return { restored: true, scope: manifest.scope, tokenFile: manifest.tokenFile }
  } catch (error) {
    // 保留清单：下次启动还能再试一次
    return { restored: false, scope: manifest.scope, error: String(error?.message ?? error) }
  }
}

// ---------------------------------------------------------------- 流程

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted === true || ms <= 0) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener?.('abort', done, { once: true })
  })
}

function safeCall(fn, ...args) {
  try {
    return fn(...args)
  } catch {
    return undefined
  }
}

function failure(code, reason, extra = {}) {
  return { ok: false, code, reason, ...extra }
}

/**
 * 走完整的「添加账号」流程。
 *
 * 参数全部可注入：测试里不唤起真实应用，也不碰真实钥匙串。
 *
 * @param {object} [options]
 * @param {string} [options.home]
 * @param {number} [options.timeoutMs] 等待登录的时长
 * @param {number} [options.pollMs] 轮询间隔
 * @param {AbortSignal} [options.signal] 取消信号
 * @param {() => Promise<object>} [options.launch] 唤起应用
 * @param {() => Promise<object>} [options.quit] 退出应用
 * @param {() => boolean} [options.isRunning] 应用是否在运行
 * @param {() => boolean} [options.isInstalled] 应用是否已安装
 * @param {(scope:string) => object} [options.inspect] 账号凭据检查
 * @param {(stage:string, info?:object) => void} [options.onProgress]
 * @param {() => number} [options.now]
 */
export async function runAddAccountFlow(options = {}) {
  // 两个 home 必须分开：
  //  - `dataHome`   TeleAgent 数据 home → 决定 token.json 在哪
  //  - `dshHomeDir` DSH home           → 决定备份清单在哪
  // 以前把 `process.env.HOME` 当 `home` 显式传给 `dshHome(home)`，`$DSH_HOME`
  // 被整个忽略，清单落到 `$HOME/.dsh`；DSH_HOME 重定向过的用户崩溃后启动恢复
  // 找不到清单，旧登录就丢了。
  // 默认值交给 appPaths()：macOS 取 `$HOME`，Windows 取 `$USERPROFILE`。
  const dataHome = appPaths(options.home).home
  // 清单路径的解析基准：
  //  - 显式给了 dshHomeDir  → 直接用（测试 / 调用方完全可控）
  //  - 显式给了 home        → 按老语义用 `home/.dsh`（测试隔离，不碰真实配置）
  //  - 两者都没给（生产）   → **保持 undefined**，让 store.js 按 `$DSH_HOME`
  //    （缺省 `$HOME/.dsh`）解析。这里绝不能填 `$HOME`，否则 DSH_HOME 又被忽略。
  const backupOptions = typeof options.dshHomeDir === 'string' && options.dshHomeDir !== ''
    ? { dshHomeDir: options.dshHomeDir }
    : { home: options.home }
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs >= 0
    ? options.timeoutMs
    : DEFAULT_ADD_ACCOUNT_TIMEOUT_MS
  const pollMs = Number.isFinite(options.pollMs) && options.pollMs > 0
    ? options.pollMs
    : DEFAULT_ADD_ACCOUNT_POLL_MS
  const signal = options.signal
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const launch = options.launch ?? (() => launchApp())
  const quit = options.quit ?? (() => quitApp())
  const isRunning = options.isRunning ?? (() => isAppRunningNow())
  const desktop = options.isInstalled
    ? { ok: options.isInstalled() === true, state: 'app_missing', detail: '未安装 TeleAgent 桌面端' }
    : checkDesktopApp()
  if (!desktop.ok) return failure(desktop.state, desktop.detail, { hint: desktop.remedy })
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  const progress = (stage, info) => { try { onProgress(stage, info) } catch { /* 不让回调拖垮流程 */ } }

  const startedAt = now()

  // 上一次流程如果崩在中间，先把原账号凭据恢复，再开始新一轮
  const recovered = restorePendingBackup(dataHome, backupOptions)
  if (recovered.restored === true) progress('recovered', recovered)

  const baseline = scanTokenScopes(dataHome)
  const previousScope = safeCurrentScope(dataHome)
  const previous = previousScope !== null ? baseline.get(previousScope) ?? null : null

  // 先备份：写不进备份就不继续，避免「退出登录后原凭据丢失」
  let backup = { created: false, reason: '当前没有可保留的登录态' }
  if (previousScope !== null && previous !== null) {
    backup = createPendingBackup({ home: options.home, ...backupOptions, scope: previousScope })
    if (backup.created !== true && backup.fatal === true) {
      return failure('backup_failed', `备份当前账号登录态失败：${backup.reason ?? '未知原因'}`, { backup, previousScope })
    }
  }

  // 备份都做完了才响应取消：否则用户点了取消还要等下一轮
  if (signal?.aborted === true) {
    const restored = restorePendingBackup(dataHome, backupOptions)
    return {
      ok: false,
      code: 'cancelled',
      reason: '已取消添加账号',
      previousScope,
      backup,
      restored,
      quit: null,
      appWasRunning: safeCall(isRunning) === true,
      elapsedMs: now() - startedAt,
    }
  }

  const wasRunning = safeCall(isRunning) === true
  progress('launching', { previousScope, backedUp: backup.created === true, wasRunning })

  let launched
  try {
    launched = await launch()
  } catch (error) {
    // 应用没起来，token 不会被删；清单保留反而会在下次启动时写回一个"本来就还在"的文件
    clearPendingBackup(dataHome, backupOptions)
    return failure('launch_failed', `唤起 TeleAgent 失败：${String(error?.message ?? error)}`, { backup })
  }
  const alreadyRunning = typeof launched?.alreadyRunning === 'boolean' ? launched.alreadyRunning : wasRunning
  progress('waiting', { previousScope })

  const deadline = startedAt + timeoutMs
  const keychain = { resolved: false, password: undefined, state: null }
  const inspect = typeof options.inspect === 'function'
    ? (scope) => safeCall(options.inspect, scope)
    : (scope) => {
        if (keychain.resolved !== true) {
          keychain.resolved = true
          const result = safeCall(readSafeStorageKey, dataHome)
          keychain.password = result?.ok === true ? result.key : null
          keychain.state = result?.state ?? null
        }
        return inspectToken(scope, dataHome, { password: keychain.password })
      }

  /** @type {{type:'added'|'same_account'|'timeout'|'cancelled', scope?:string, info?:object}|null} */
  let outcome = null
  let pending = []

  while (outcome === null) {
    const snapshot = scanTokenScopes(dataHome)
    pending = []

    // 1) 新账号：基线里没有、现在有 token 且能解密
    const addedScopes = [...snapshot.keys()]
      .filter((scope) => !baseline.has(scope))
      .sort((a, b) => (snapshot.get(b)?.mtimeMs ?? 0) - (snapshot.get(a)?.mtimeMs ?? 0))
    for (const scope of addedScopes) {
      const info = inspect(scope)
      if (info?.ok === true) {
        outcome = { type: 'added', scope, info }
        break
      }
      pending.push({ scope, reason: info?.reason ?? 'unknown' })
    }

    // 2) 同一账号重新登录（新 token 写回原目录）
    if (outcome === null && previousScope !== null) {
      const before = baseline.get(previousScope)
      const after = snapshot.get(previousScope)
      if (after !== undefined && (before === undefined || after.mtimeMs !== before.mtimeMs || after.size !== before.size)) {
        const info = inspect(previousScope)
        if (info?.ok === true) outcome = { type: 'same_account', scope: previousScope, info }
      }
    }

    if (outcome !== null) break
    if (signal?.aborted === true) {
      outcome = { type: 'cancelled' }
      break
    }
    const remaining = deadline - now()
    if (remaining <= 0) {
      outcome = { type: 'timeout' }
      break
    }
    await sleep(Math.min(pollMs, remaining), signal)
    if (signal?.aborted === true) outcome = { type: 'cancelled' }
  }

  progress('detected', outcome)

  // ---- 收尾：恢复原账号凭据 → （必要时）退出应用
  let restored
  if (outcome.type === 'same_account') {
    // 用户重新登录的就是原账号：应用已经写入了新凭据，绝不能用旧备份覆盖
    clearPendingBackup(dataHome, backupOptions)
    restored = {
      restored: false,
      skipped: true,
      scope: outcome.scope,
      reason: '原账号已重新登录，保留应用写入的新凭据',
    }
  } else {
    restored = restorePendingBackup(dataHome, backupOptions)
  }
  if (restored.restored === true) progress('restored', restored)

  let quitInfo = null
  if (alreadyRunning !== true) {
    progress('quitting')
    try {
      quitInfo = await quit()
    } catch (error) {
      quitInfo = { error: String(error?.message ?? error) }
    }
  }

  const elapsedMs = now() - startedAt
  const resultBase = {
    elapsedMs,
    previousScope,
    backup,
    restored,
    quit: quitInfo,
    appWasRunning: alreadyRunning === true,
  }

  if (outcome.type === 'added') {
    const info = outcome.info
    const name = info.accountName ?? info.userId ?? outcome.scope
    const previousName = previousScope === null ? null : (previousScope === outcome.scope ? name : previousScope)
    const message = previousName === null
      ? `已添加账号「${name}」`
      : `已添加账号「${name}」${restored.restored === true ? `；原账号「${previousName}」的登录态已保留` : ''}`
    const result = {
      ok: true,
      code: 'added',
      added: {
        scope: outcome.scope,
        accountName: info.accountName ?? null,
        accountId: info.accountId ?? null,
        userId: info.userId ?? null,
        expiresAt: info.expiresAt ?? null,
        daysLeft: info.daysLeft ?? null,
        verified: true,
      },
      ...resultBase,
      message,
    }
    progress('done', result)
    return result
  }

  if (outcome.type === 'same_account') {
    const info = outcome.info
    const name = info.accountName ?? outcome.scope
    const result = {
      ok: false,
      code: 'same_account',
      reloggedIn: { scope: outcome.scope, accountName: info.accountName ?? null },
      ...resultBase,
      reason: `登录的是已有账号「${name}」，没有新增账号`,
      hint: '如果要添加另一个账号，请在应用里退出登录后使用「另一个」账号登录',
    }
    progress('done', result)
    return result
  }

  if (outcome.type === 'cancelled') {
    const result = {
      ok: false,
      code: 'cancelled',
      ...resultBase,
      reason: '已取消添加账号',
      hint: restored.restored === true ? '原账号的登录态已恢复' : null,
    }
    progress('done', result)
    return result
  }

  const minutes = Math.max(1, Math.round(timeoutMs / 60_000))
  const result = {
    ok: false,
    code: 'timeout',
    timedOut: true,
    ...resultBase,
    reason: `等待超时（${minutes} 分钟内未检测到新账号登录）`,
    hint: '在 TeleAgent 里「设置 → 账号 → 退出登录」后，用另一个账号完成登录，插件会自动检测到新账号',
    pending,
  }
  if (restored.restored === true) result.hint = '原账号的登录态已恢复；' + result.hint
  progress('done', result)
  return result
}
