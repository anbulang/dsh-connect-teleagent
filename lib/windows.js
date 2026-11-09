import path from 'node:path'
import { execFileSync } from 'node:child_process'

/** 固定脚本用环境变量接收路径，避免把路径拼进 PowerShell 命令。 */
export function runPowerShell(script, { env, input } = {}) {
  const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const command = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ${script}`
  return execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    input,
    timeout: 10000,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}
