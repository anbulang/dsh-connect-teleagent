/**
 * 凭据诊断：把「为什么拿不到可用的 TeleAgent 登录态」变成结构化状态 + 可执行建议。
 *
 * 背景（已核实）：
 *  - `app-auth/token.json` 只有 `encryptedToken`，**没有 refresh token**，
 *    因此 token 过期后无法自动续期，只能引导用户重登。
 *  - 本机可能只有一个 owner scope，也没有「换另一个账号」这条路。
 *
 * 所以这里不做假的自愈，只做三件真事：
 *  1. 精确分类失败原因（不是笼统的 "读取失败"）
 *  2. 每个原因给出**用户能直接执行**的动作
 *  3. 对可恢复的情况（如钥匙串首次拒绝）给出重试指引
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appPaths, currentScope } from './models.js'
import { checkDesktopApp, MIN_TELEAGENT_VERSION } from './desktop.js'
import { runPowerShell } from './windows.js'

const KEYCHAIN_SERVICE = 'TeleAgent Safe Storage'

/** 凭据状态枚举（值即 code，便于卡片/日志稳定匹配） */
export const CredentialState = {
  OK: 'ok',
  APP_MISSING: 'app_missing',
  APP_VERSION_UNKNOWN: 'app_version_unknown',
  APP_VERSION_UNSUPPORTED: 'app_version_unsupported',
  DPAPI_UNAVAILABLE: 'dpapi_unavailable',
  DATA_MISSING: 'data_missing',
  NOT_SIGNED_IN: 'not_signed_in',
  TOKEN_FILE_MISSING: 'token_file_missing',
  KEYCHAIN_MISSING: 'keychain_missing',
  KEYCHAIN_DENIED: 'keychain_denied',
  DECRYPT_FAILED: 'decrypt_failed',
  TOKEN_MALFORMED: 'token_malformed',
  EXPIRED: 'expired',
}

/** 每种状态对应的用户动作 */
export const REMEDIES = {
  [CredentialState.APP_MISSING]: '安装 TeleAgent 桌面版（https://www.teleai.com.cn）',
  [CredentialState.APP_VERSION_UNKNOWN]: `重新安装 TeleAgent ${MIN_TELEAGENT_VERSION} 或更高版本`,
  [CredentialState.APP_VERSION_UNSUPPORTED]: `升级到 TeleAgent ${MIN_TELEAGENT_VERSION} 或更高版本`,
  [CredentialState.DPAPI_UNAVAILABLE]: '用登录 TeleAgent 的同一个 Windows 用户运行 DSH，必要时重新登录 TeleAgent',
  [CredentialState.DATA_MISSING]: '启动一次 TeleAgent 桌面端，让它初始化数据目录',
  [CredentialState.NOT_SIGNED_IN]: '在 TeleAgent 桌面端登录',
  [CredentialState.TOKEN_FILE_MISSING]: '在 TeleAgent 桌面端登录一次；若已登录，重启桌面端让它写出凭据',
  [CredentialState.KEYCHAIN_MISSING]: '在 TeleAgent 桌面端重新登录，重建钥匙串条目',
  [CredentialState.KEYCHAIN_DENIED]: '首次读取会弹出钥匙串授权，选择「始终允许」；若已拒绝，打开「钥匙串访问」删除 TeleAgent Safe Storage 后重登',
  [CredentialState.DECRYPT_FAILED]: '凭据格式与当前 TeleAgent 版本不匹配：更新 TeleAgent 桌面端后重新登录',
  [CredentialState.TOKEN_MALFORMED]: '在 TeleAgent 桌面端重新登录',
  [CredentialState.EXPIRED]: '登录已过期，在 TeleAgent 桌面端重新登录（本插件无法自动续期：凭据文件里没有 refresh token）',
}

/** 读取钥匙串密码，区分「不存在」与「被拒绝」 */
export function readKeychainPassword() {
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim()
    if (out.length === 0) return { ok: false, state: CredentialState.KEYCHAIN_MISSING }
    return { ok: true, password: out }
  } catch (error) {
    const text = String(error?.stderr ?? error?.message ?? '')
    // security 找不到条目时返回 44；用户拒绝访问时通常提到 "denied"/"canceled"/交互失败
    if (/could not be found|SecKeychainSearchCopyNext|44$/.test(text)) {
      return { ok: false, state: CredentialState.KEYCHAIN_MISSING }
    }
    if (/denied|cancel|user interaction|not allowed|errSecAuthFailed/i.test(text)) {
      return { ok: false, state: CredentialState.KEYCHAIN_DENIED }
    }
    return { ok: false, state: CredentialState.KEYCHAIN_DENIED }
  }
}

/** macOS 返回钥匙串密码，Windows 返回经当前用户 DPAPI 解封的 AES 密钥。 */
export function readSafeStorageKey(home) {
  if (process.platform !== 'win32') {
    const { ok, password, state } = readKeychainPassword()
    return { ok, key: password, state }
  }

  try {
    const localState = JSON.parse(fs.readFileSync(path.join(appPaths(home).data, 'Local State'), 'utf8'))
    const wrapped = Buffer.from(localState.os_crypt.encrypted_key, 'base64')
    if (wrapped.subarray(0, 5).toString() !== 'DPAPI') throw new Error('DPAPI header missing')
    const unwrapped = runPowerShell(`
      Add-Type -AssemblyName System.Security
      $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
      $key = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
      [Convert]::ToBase64String($key)
    `, { input: wrapped.subarray(5).toString('base64') })
    const key = Buffer.from(unwrapped, 'base64')
    if (key.length !== 32) throw new Error('Invalid AES key size')
    return { ok: true, key }
  } catch {
    // PowerShell 的原始错误可能包含解密材料，只返回稳定状态。
    return { ok: false, state: CredentialState.DPAPI_UNAVAILABLE }
  }
}

/** 解 Electron safeStorage(v10)。字符串密钥用于 macOS，32 字节密钥用于 Windows。 */
export function decryptSafeStorage(encryptedToken, key) {
  return decryptSafeStorageBytes(Buffer.from(encryptedToken, 'base64'), key).toString('utf8')
}

export function decryptSafeStorageBytes(raw, key) {
  if (raw.subarray(0, 3).toString() !== 'v10') {
    const error = new Error('凭据不是 safeStorage v10 格式')
    error.code = CredentialState.DECRYPT_FAILED
    throw error
  }
  try {
    if (Buffer.isBuffer(key)) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(3, 15), { authTagLength: 16 })
      decipher.setAuthTag(raw.subarray(-16))
      return Buffer.concat([decipher.update(raw.subarray(15, -16)), decipher.final()])
    }
    const derived = crypto.pbkdf2Sync(Buffer.from(key, 'utf8'), 'saltysalt', 1003, 16, 'sha1')
    const decipher = crypto.createDecipheriv('aes-128-cbc', derived, Buffer.alloc(16, 0x20))
    return Buffer.concat([decipher.update(raw.subarray(3)), decipher.final()])
  } catch {
    const error = new Error('凭据解密失败（系统密钥与凭据不匹配）')
    error.code = CredentialState.DECRYPT_FAILED
    throw error
  }
}

/** 解析 JWT（不校验签名，只取声明） */
export function parseClaims(token) {
  const jwt = token.includes(':') ? token.slice(token.indexOf(':') + 1) : token
  const payload = jwt.split('.')[1]
  if (!payload) {
    const error = new Error('凭据不是合法的 JWT')
    error.code = CredentialState.TOKEN_MALFORMED
    throw error
  }
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    const error = new Error('凭据里的声明不是合法 JSON')
    error.code = CredentialState.TOKEN_MALFORMED
    throw error
  }
}

/**
 * 完整诊断。永不抛错，总是返回结构化结果。
 *
 * @returns {{
 *   state: string, ok: boolean, remedy?: string,
 *   token?: string, scope?: string, claims?: object,
 *   accountName?: string, accountId?: string, tenant?: string,
 *   expiresAt?: number, daysLeft?: number,
 *   detail: string,
 * }}
 */
export function diagnoseCredential(home, desktop = checkDesktopApp()) {
  const paths = appPaths(home)
  if (!desktop.ok) {
    return fail(desktop.state, desktop.detail, { remedy: desktop.remedy, appVersion: desktop.version })
  }
  if (!fs.existsSync(paths.data)) {
    return fail(CredentialState.DATA_MISSING, `数据目录不存在：${paths.data}`)
  }

  let scope
  try {
    scope = currentScope(paths.data)
  } catch (error) {
    return fail(CredentialState.NOT_SIGNED_IN, String(error?.message ?? error))
  }

  const tokenFile = path.join(paths.data, 'users', scope, 'app-auth', 'token.json')
  if (!fs.existsSync(tokenFile)) {
    return fail(CredentialState.TOKEN_FILE_MISSING, `凭据文件不存在：${tokenFile}`, { scope })
  }

  let envelope
  try {
    envelope = JSON.parse(fs.readFileSync(tokenFile, 'utf8'))
  } catch (error) {
    return fail(CredentialState.DECRYPT_FAILED, `凭据文件无法解析：${String(error?.message ?? error)}`, { scope })
  }
  if (typeof envelope?.encryptedToken !== 'string' || envelope.encryptedToken.length === 0) {
    return fail(CredentialState.TOKEN_FILE_MISSING, '凭据文件里没有 encryptedToken', { scope })
  }

  const storage = readSafeStorageKey(home)
  if (!storage.ok) {
    return fail(storage.state, safeStorageDetail(storage), { scope })
  }

  let token
  try {
    token = decryptSafeStorage(envelope.encryptedToken, storage.key)
  } catch (error) {
    return fail(error?.code ?? CredentialState.DECRYPT_FAILED, String(error?.message ?? error), { scope })
  }

  let claims
  try {
    claims = parseClaims(token)
  } catch (error) {
    return fail(error?.code ?? CredentialState.TOKEN_MALFORMED, String(error?.message ?? error), { scope })
  }

  const expiresAt = typeof claims.exp === 'number' ? claims.exp * 1000 : undefined
  const daysLeft = expiresAt === undefined ? undefined : Math.floor((expiresAt - Date.now()) / 86_400_000)
  const base = {
    ok: true,
    appVersion: desktop.version,
    token,
    scope,
    claims,
    accountName: claims.accountName,
    accountId: claims.accountId,
    tenant: claims.tenant,
    expiresAt,
    daysLeft,
  }

  if (expiresAt !== undefined && expiresAt < Date.now()) {
    return {
      ...base,
      ok: false,
      state: CredentialState.EXPIRED,
      remedy: REMEDIES[CredentialState.EXPIRED],
      detail: `登录已于 ${new Date(expiresAt).toISOString().slice(0, 10)} 过期`,
    }
  }

  return {
    ...base,
    state: CredentialState.OK,
    detail: daysLeft === undefined
      ? `已登录：${claims.accountName ?? claims.accountId ?? '未知账号'}`
      : `已登录：${claims.accountName ?? claims.accountId ?? '未知账号'}，剩余 ${daysLeft} 天`,
  }
}

function fail(state, detail, extra = {}) {
  return { ok: false, state, detail, remedy: REMEDIES[state], ...extra }
}

/** 把诊断结果压成一行给日志用 */
export function describeFailure(diagnosis) {
  if (diagnosis.ok) return diagnosis.detail
  return `${diagnosis.detail}${diagnosis.remedy ? ` → ${diagnosis.remedy}` : ''}`
}

/**
 * 凭据探测详情：逐条列出"探过哪里、各自为什么没成"。
 *
 * 只报"凭据文件不存在"对用户没有帮助——桌面端装在非常规位置、或账号目录换过名，
 * 表现都一样。这里把候选路径与判定分开呈现，让用户能直接看出是哪一环断了。
 *
 * @returns {{home:string, dataDir:string, currentOwner:string|null, scopes:Array, keychain:object, verdict:object}}
 */
export function probeDetails(home) {
  const paths = appPaths(home)
  const usersDir = path.join(paths.data, 'users')

  // 1) 当前账号指向
  let currentOwner = null
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(paths.data, 'current-owner.json'), 'utf8'))
    currentOwner = typeof owner?.ownerDir === 'string' ? owner.ownerDir : null
  } catch { /* 不存在或损坏 */ }

  // 2) 逐个账号目录的凭据状态
  const scopes = []
  let entries = []
  try { entries = fs.readdirSync(usersDir, { withFileTypes: true }) } catch { /* 无 users 目录 */ }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const authDir = path.join(usersDir, entry.name, 'app-auth')
    const tokenFile = path.join(authDir, 'token.json')
    let state = 'ok'
    let detail = '凭据存在'
    if (!fs.existsSync(authDir)) {
      state = 'no_auth_dir'
      detail = '没有 app-auth 目录（该账号从未在此设备登录）'
    } else if (!fs.existsSync(tokenFile)) {
      state = 'no_token'
      detail = '有 app-auth 但没有 token.json（登录被清除，或桌面端还没写出）'
    } else {
      try {
        const stat = fs.statSync(tokenFile)
        const envelope = JSON.parse(fs.readFileSync(tokenFile, 'utf8'))
        if (typeof envelope?.encryptedToken !== 'string' || envelope.encryptedToken.length === 0) {
          state = 'empty_token'
          detail = 'token.json 里没有 encryptedToken'
        } else {
          detail = `凭据存在（${stat.size} 字节，更新于 ${new Date(stat.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')}）`
        }
      } catch (error) {
        state = 'unreadable'
        detail = `token.json 无法读取或解析：${String(error?.message ?? error)}`
      }
    }
    scopes.push({
      scope: entry.name,
      isCurrent: entry.name === currentOwner,
      tokenFile,
      state,
      detail,
    })
  }

  // 3) 系统凭据存储，只暴露状态。
  const storage = readSafeStorageKey(home)
  const keychain = {
    ok: storage.ok,
    state: storage.state ?? null,
    detail: safeStorageDetail(storage),
    label: process.platform === 'win32' ? 'Windows DPAPI' : '钥匙串',
  }

  // 4) 结论
  const diag = diagnoseCredential(home)
  const verdict = {
    ok: diag.ok === true,
    state: diag.state,
    detail: diag.detail,
    remedy: diag.remedy,
    // 常见误判：凭据在，但钥匙串读不到 → 需要用户解锁钥匙串而不是重新登录
    hint:
      diag.ok === false && scopes.some((s) => s.state === 'ok') && keychain.ok === false
        ? REMEDIES[storage.state]
        : diag.ok === false && scopes.length === 0
          ? '本机没有任何账号目录：需要在 TeleAgent 桌面端登录一次'
          : null,
  }

  return { home: paths.home, dataDir: paths.data, currentOwner, scopes, keychain, verdict }
}

function safeStorageDetail({ ok, state }) {
  if (process.platform === 'win32') return ok ? 'Windows DPAPI 可读取' : '无法通过 Windows DPAPI 读取当前用户的 TeleAgent 密钥'
  if (ok) return `已取得「${KEYCHAIN_SERVICE}」条目`
  if (state === CredentialState.KEYCHAIN_MISSING) return `钥匙串里没有「${KEYCHAIN_SERVICE}」条目`
  return `无法读取钥匙串条目「${KEYCHAIN_SERVICE}」`
}
