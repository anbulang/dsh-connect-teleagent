/**
 * 本地登录态管理：清除异常账号的凭据。
 *
 * ## 为什么只删 `token.json`
 *
 * TeleAgent 的 `users/<scope>/` 目录里除了凭据，还有**用户的技能、长期记忆、
 * 会话记录**。为了"换个账号"而删整个目录是不可接受的破坏性操作。
 *
 * 所以这里只删除 `app-auth/token.json`（以及同目录下可能存在的凭据副本），
 * 保留 `skills/`、`memory`、`sessions` 等用户数据。删掉凭据后桌面端会回到登录页。
 */
import fs from 'node:fs'
import path from 'node:path'

import { appPaths, currentScope } from './models.js'
import { isAppRunning, quitApp } from './lifecycle.js'

/** 需要删除的凭据文件（相对 `<scope>/app-auth/`） */
const CREDENTIAL_FILES = ['token.json']

/**
 * 列出所有"有凭据"的账号作用域。
 * @returns {string[]} scope 目录名
 */
export function listScopesWithCredential(home) {
  const { data } = appPaths(home)
  const usersDir = path.join(data, 'users')
  const scopes = []
  let entries = []
  try { entries = fs.readdirSync(usersDir, { withFileTypes: true }) } catch { return scopes }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const hasToken = CREDENTIAL_FILES.some((f) =>
      fs.existsSync(path.join(usersDir, entry.name, 'app-auth', f)))
    if (hasToken) scopes.push(entry.name)
  }
  return scopes
}

/**
 * 清除凭据。
 *
 * @param {object} [options]
 * @param {string} [options.home]
 * @param {'current'|'all'} [options.scope='current'] 只清当前账号还是全部
 * @param {boolean} [options.quitAppFirst=true] 是否先退出桌面端（否则它可能把凭据写回）
 * @returns {Promise<{ok:boolean, cleared:string[], removedFiles:string[], errors:string[], appQuit:boolean}>}
 */
export async function clearCredential(options = {}) {
  const home = appPaths(options.home).home
  const scopeMode = options.scope ?? 'current'
  const { data } = appPaths(home)
  const usersDir = path.join(data, 'users')

  const targets = []
  if (scopeMode === 'all') {
    targets.push(...listScopesWithCredential(home))
  } else {
    try {
      targets.push(currentScope(data))
    } catch {
      // 当前账号无法识别时退回"清所有带凭据的"
      targets.push(...listScopesWithCredential(home))
    }
  }

  let appQuit = false
  if (options.quitAppFirst !== false && isAppRunning()) {
    // 桌面端在跑的时候会持有并可能重写 token.json，先让它退出
    try {
      const result = await quitApp({ timeoutMs: 8000 })
      appQuit = result?.ok === true
    } catch { /* 退出失败也继续尝试删除 */ }
  }

  const removedFiles = []
  const errors = []
  const cleared = []

  for (const scope of targets) {
    const authDir = path.join(usersDir, scope, 'app-auth')
    let removedAny = false
    for (const file of CREDENTIAL_FILES) {
      const target = path.join(authDir, file)
      try {
        if (fs.existsSync(target)) {
          fs.unlinkSync(target)
          removedFiles.push(target)
          removedAny = true
        }
      } catch (error) {
        errors.push(`${target}: ${error?.message ?? error}`)
      }
    }
    if (removedAny) cleared.push(scope)
  }

  return { ok: errors.length === 0, cleared, removedFiles, errors, appQuit }
}
