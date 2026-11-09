/**
 * TeleAgent 进程生命周期管理：按需唤起、用后退出。
 *
 * ## 为什么退出这么麻烦（实测结论）
 *
 * TeleAgent 是打包版 Electron 应用，主进程注册了 `before-quit` 守卫：
 *
 * ```js
 * function xZt() { return me.isPackaged }          // 打包版永远走确认流程
 * async function UZt() {
 *   if (!hasRunningTask && !hasEnabledScheduledTask) return true   // 空闲才免确认
 *   return (await showMessageBox({ buttons: ['取消','退出'], defaultId: 0 })).response === 1
 * }
 * ```
 *
 * 于是：
 *  - `osascript quit` → 弹确认框 → 无人在场 → 返回 -128（用户已取消）
 *  - `kill -TERM` / `kill -SIGINT` → Electron 忽略
 *  - `kill -9` → 有效，但**跳过 `will-quit` 清理**，留下 scheduler daemon、
 *    im-service、kernel 三个孤儿进程
 *
 * 所以退出必须分两步：先礼后兵，且兵之后要自己收拾残留。
 */
import path from 'node:path'
import { once } from 'node:events'
import { execFileSync, execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { checkDesktopApp, resolveDesktopApp } from './desktop.js'
import { runPowerShell } from './windows.js'

const execFileAsync = promisify(execFile)

const MAIN_BINARY_MATCH = 'TeleAgent.app/Contents/MacOS/TeleAgent'

/** 子进程匹配规则：主进程之外的、属于 TeleAgent 的辅助进程 */
const ORPHAN_PATTERNS = [
  'TeleAgent.app/Contents/Resources/scheduler/index.cjs',
  'TeleAgent.app/Contents/Resources/app.asar.unpacked/dist-electron/im-service',
  'super-agent-code/bin/TeleAgent',
]

/** 应用是否在运行 */
export function isAppRunning() {
  try {
    if (process.platform === 'win32') {
      const appPath = resolveDesktopApp()
      if (!appPath) return []
      const out = runPowerShell(`
        Get-Process -Name $env:DSH_TELEAGENT_NAME -ErrorAction SilentlyContinue |
          Where-Object { $_.Path -eq $env:DSH_TELEAGENT_EXE } |
          Select-Object -ExpandProperty Id
      `, { env: { DSH_TELEAGENT_EXE: appPath, DSH_TELEAGENT_NAME: path.basename(appPath, '.exe') } })
      return out.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0)
    }
    const match = process.env.TELEAGENT_APP_PATH?.trim()
      ? path.join(process.env.TELEAGENT_APP_PATH.trim(), 'Contents', 'MacOS', 'TeleAgent')
      : MAIN_BINARY_MATCH
    const out = execFileSync('pgrep', ['-f', match], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim()
    return out.length > 0 ? out.split('\n').map(Number) : []
  } catch {
    return []
  }
}

/**
 * 应用是否在运行（布尔）。
 *
 * `isAppRunning()` 返回的是 PID 数组——空数组是 falsy 吗？不是，`[]` 是 truthy。
 * 直接 `if (isAppRunning())` 会把"没在运行"判成"在运行"，
 * 而 `isAppRunning() === true` 又永远为假。这里统一给出布尔值。
 */
export function isAppRunningNow() {
  const pids = isAppRunning()
  return Array.isArray(pids) ? pids.length > 0 : Boolean(pids)
}

/** 应用是否已安装 */
export function isAppInstalled() {
  return resolveDesktopApp() !== null
}

/** 启动应用，返回启动前的 pid 列表（用于判断是否「本来就开着」） */
export async function launchApp() {
  const appPath = resolveDesktopApp()
  if (!appPath) throw new Error('未安装 TeleAgent 桌面端')
  const before = isAppRunning()
  if (process.platform === 'win32') {
    const child = spawn(appPath, [], { detached: true, stdio: 'ignore', cwd: path.dirname(appPath) })
    await once(child, 'spawn')
    child.unref()
  } else {
    await execFileAsync('open', ['-a', appPath])
  }
  // 等到主进程真正出现（最多 15 秒）
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const now = isAppRunning()
    const fresh = now.filter((pid) => !before.includes(pid))
    if (fresh.length > 0) return { pids: fresh, alreadyRunning: before.length > 0, before }
    if (process.platform === 'win32' && now.length > 0 && before.length > 0) {
      return { pids: now, alreadyRunning: true, before }
    }
    await sleep(400)
  }
  return { pids: isAppRunning(), alreadyRunning: before.length > 0, before }
}

/**
 * 退出应用。
 *
 * 策略：
 *  1. 先试 AppleScript `quit`（走正常 will-quit 清理）——空闲时通常能成功；
 *  2. 失败则 SIGKILL 主进程；
 *  3. 无论哪条路，最后都按 ORPHAN_PATTERNS 清理残留辅助进程。
 *
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{method: string, killed: string[], remaining: number[]}>}
 */
export async function quitApp({ timeoutMs = 8000 } = {}) {
  const pids = isAppRunning()
  if (pids.length === 0) {
    return { method: 'not-running', killed: [], remaining: [] }
  }

  if (process.platform === 'win32') {
    let method = 'close-window'
    try {
      runPowerShell(`
        Get-Process -Id ($env:DSH_TELEAGENT_PIDS.Split(',') -as [int[]]) -ErrorAction SilentlyContinue |
          Where-Object { $_.Path -eq $env:DSH_TELEAGENT_EXE } |
          ForEach-Object { [void]$_.CloseMainWindow() }
      `, { env: { DSH_TELEAGENT_PIDS: pids.join(','), DSH_TELEAGENT_EXE: resolveDesktopApp() } })
    } catch { /* 进程可能已经退出 */ }

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && isAppRunning().length > 0) await sleep(300)

    const killed = []
    for (const pid of isAppRunning()) {
      try {
        await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 })
        killed.push(`TeleAgent.exe:${pid}`)
        method = 'taskkill'
      } catch { /* 进程可能已经退出 */ }
    }
    return { method, killed, remaining: isAppRunning() }
  }

  let method = 'none'

  // 1. 优雅退出
  try {
    await execFileAsync('osascript', ['-e', 'tell application "TeleAgent" to quit'], { timeout: 5000 })
    method = 'applescript'
  } catch {
    // -128 表示被 QuitGuard 取消，继续走强制路径
    method = 'applescript-cancelled'
  }

  // 等主进程消失
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isAppRunning().length === 0) break
    await sleep(300)
  }

  // 2. 还在就强杀
  if (isAppRunning().length > 0) {
    for (const pid of isAppRunning()) {
      try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ }
    }
    method = 'sigkill'
    await sleep(1200)
  }

  // 3. 清理残留辅助进程（优雅退出时通常已自行停止，这里是兜底）
  const killed = []
  for (const pattern of ORPHAN_PATTERNS) {
    try {
      const out = execFileSync('pgrep', ['-f', pattern], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim()
      for (const pidText of out.split('\n').filter(Boolean)) {
        const pid = Number(pidText)
        try {
          process.kill(pid, 'SIGTERM')
          killed.push(`${pattern.split('/').pop()}:${pid}`)
        } catch { /* 已退出 */ }
      }
    } catch { /* 该 pattern 没有进程 */ }
  }

  await sleep(800)
  return { method, killed, remaining: isAppRunning() }
}

/** 登录是否已完成（凭据可用） */
export function isSignedIn(diagnose) {
  try {
    return diagnose().ok === true
  } catch {
    return false
  }
}

/**
 * 唤起应用 → 等用户完成登录 → 退出应用。
 *
 * @param {object} options
 * @param {() => {ok: boolean, detail?: string}} options.diagnose 凭据诊断函数
 * @param {number} [options.timeoutMs] 等待登录的最长时间（默认 5 分钟）
 * @param {number} [options.pollMs] 轮询间隔
 * @param {(state: string) => void} [options.onProgress]
 * @returns {Promise<{ok: boolean, reason?: string, quit?: object}>}
 */
export async function loginThenQuit({ diagnose, timeoutMs = 5 * 60_000, pollMs = 2000, onProgress } = {}) {
  const desktop = checkDesktopApp()
  if (!desktop.ok) return { ok: false, reason: desktop.detail, remedy: desktop.remedy }

  // 已经登录就不折腾
  if (isSignedIn(diagnose)) {
    return { ok: true, reason: 'already-signed-in' }
  }

  const launch = await launchApp()
  onProgress?.('launched')

  const deadline = Date.now() + timeoutMs
  let signedIn = false
  while (Date.now() < deadline) {
    if (isSignedIn(diagnose)) { signedIn = true; break }
    // 用户可能中途把应用关了：重新拉起一次
    if (isAppRunning().length === 0) {
      try { await launchApp() } catch { /* 忽略 */ }
    }
    await sleep(pollMs)
  }

  onProgress?.(signedIn ? 'signed-in' : 'timeout')

  // 只有「是我们拉起来的」或者登录成功时才退出，不擅自杀掉用户本来开着的应用
  const shouldQuit = signedIn || !launch.alreadyRunning
  const quit = shouldQuit ? await quitApp() : undefined

  if (!signedIn) {
    const minutes = Math.max(1, Math.round(timeoutMs / 60_000))
    return { ok: false, reason: `登录超时（${minutes} 分钟内未检测到有效凭据）`, quit }
  }
  return { ok: true, quit }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
