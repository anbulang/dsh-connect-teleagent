/**
 * 敏感常量（默认不随仓库分发）。
 *
 * 上游网关的 apiKey 是 TeleAgent 桌面端内置的常量。开源仓库里**不提交真实值**，
 * 运行时按顺序读取：
 *
 *   1. 环境变量 `TELEAGENT_API_KEY`
 *   2. 仓库根目录的 `local.secrets.json`（已 gitignore）：`{ "apiKey": "..." }`
 *
 * 两者都没有时返回空串，由调用方给出「请配置密钥」的明确错误。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL_FILE = path.join(ROOT, 'local.secrets.json')

export function readTeleaiApiKey() {
  const fromEnv = process.env.TELEAGENT_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  try {
    const data = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'))
    if (typeof data?.apiKey === 'string' && data.apiKey.trim().length > 0) return data.apiKey.trim()
  } catch { /* 没有本地密钥文件 */ }
  return ''
}

/** 上游网关 apiKey（可能为空串：调用方需给出可读错误） */
export const TELEAI_API_KEY = readTeleaiApiKey()

/** 缺密钥时的统一提示 */
export const MISSING_API_KEY_HINT = '未配置上游 apiKey：请设置环境变量 TELEAGENT_API_KEY，或在仓库根目录创建 local.secrets.json（{"apiKey":"..."}）'
