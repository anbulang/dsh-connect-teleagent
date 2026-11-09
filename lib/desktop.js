import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { runPowerShell } from './windows.js'

export const MIN_TELEAGENT_VERSION = '2.7.1'
const APP_BUNDLE = '/Applications/TeleAgent.app'
const DOWNLOAD_URL = 'https://www.teleai.com.cn/product/TeleAgent'

export function resolveDesktopApp({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const override = env.TELEAGENT_APP_PATH?.trim()
  if (override) return exists(override) ? override : null
  if (platform !== 'win32') return exists(APP_BUNDLE) ? APP_BUNDLE : null

  const candidates = [
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs', 'TeleAgent', 'TeleAgent.exe'),
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'TeleAgent', 'TeleAgent.exe'),
    ...[env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)
      .map((root) => path.win32.join(root, 'TeleAgent', 'TeleAgent.exe')),
  ]
  return candidates.find((file) => file && exists(file)) ?? null
}

function readDesktopVersion(appPath, platform) {
  if (platform === 'win32') {
    return runPowerShell('[Diagnostics.FileVersionInfo]::GetVersionInfo($env:DSH_TELEAGENT_EXE).ProductVersion', {
      env: { DSH_TELEAGENT_EXE: appPath },
    })
  }
  return execFileSync('/usr/libexec/PlistBuddy', [
    '-c', 'Print :CFBundleShortVersionString', path.join(appPath, 'Contents', 'Info.plist'),
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim()
}

let cachedVersion
export function checkDesktopApp({
  platform = process.platform, appPath = resolveDesktopApp({ platform }), readVersion,
} = {}) {
  if (!appPath || !fs.existsSync(appPath)) {
    return {
      ok: false, state: 'app_missing', version: null, minVersion: MIN_TELEAGENT_VERSION,
      detail: '未检测到 TeleAgent 桌面端',
      remedy: `安装 TeleAgent ${MIN_TELEAGENT_VERSION} 或更高版本（${DOWNLOAD_URL}）；自定义安装路径可设置 TELEAGENT_APP_PATH`,
    }
  }

  let version
  try {
    if (readVersion) {
      version = readVersion(appPath)
    } else {
      const metadata = platform === 'win32' ? appPath : path.join(appPath, 'Contents', 'Info.plist')
      const stat = fs.statSync(metadata)
      const fingerprint = `${metadata}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
      if (cachedVersion?.fingerprint === fingerprint) {
        version = cachedVersion.version
      } else {
        version = readDesktopVersion(appPath, platform)
        if (version) cachedVersion = { fingerprint, version }
      }
    }
  } catch { /* 安装不完整或版本信息不可读 */ }

  const match = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version ?? '')
  if (!match) {
    return {
      ok: false, state: 'app_version_unknown', version: null, minVersion: MIN_TELEAGENT_VERSION,
      detail: '无法读取 TeleAgent 桌面端版本',
      remedy: `确认安装路径，或重新安装 TeleAgent ${MIN_TELEAGENT_VERSION} 或更高版本（${DOWNLOAD_URL}）`,
    }
  }

  // Electron 的 Windows EXE 元数据会给三段版本补上 .0。上游使用桌面端的三段版本。
  if (match[4] === '0') {
    version = version.replace(/^(\d+\.\d+\.\d+)\.0(?=$|[-+])/, '$1')
  }
  const installed = match.slice(1, 5).map((part) => BigInt(part ?? 0))
  const minimum = [...MIN_TELEAGENT_VERSION.split('.').map(BigInt), 0n]
  const firstDifference = installed.findIndex((part, index) => part !== minimum[index])
  const supported = firstDifference < 0 ? !match[5] : installed[firstDifference] > minimum[firstDifference]
  return {
    ok: supported, state: supported ? 'ok' : 'app_version_unsupported',
    version, minVersion: MIN_TELEAGENT_VERSION,
    detail: supported ? `已安装，版本 ${version}` : `TeleAgent ${version} 低于最低要求 ${MIN_TELEAGENT_VERSION}`,
    remedy: supported ? undefined : `升级到 TeleAgent ${MIN_TELEAGENT_VERSION} 或更高版本（${DOWNLOAD_URL}）`,
  }
}
