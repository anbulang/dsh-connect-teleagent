/**
 * 插件自身的持久化设置。
 *
 * 为什么不用宿主的 `ctx.settings`：
 *  - 它的写入是 `describe()` 找 namespace + `mutate(ns, ops)` 的两段式，
 *    且必须先 `configure()` 注册 schema 才有 row；不同 DSH 版本的形状还在变
 *    （实测直接调一个不存在的 `update()` 会得到
 *    `Config $ contains a non-plain root`）。
 *  - 我们只需要存一个字符串数组（启用的模型 id），自己落盘更可预测，
 *    也不受宿主 API 变更影响。
 *
 * 位置：`$DSH_HOME/teleagent-plugin.json`（默认 `~/.dsh/`）。
 * 写入用「临时文件 + rename」保证原子性，避免半截文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { appPaths } from './models.js'

export const STORE_FILENAME = 'teleagent-plugin.json'

/**
 * 解析 DSH home（插件自己落盘目录的父目录）。
 *
 * 显式传入 `home` 时**只用它**——这样测试可以完全隔离，不会写到真实配置。
 * 只有调用方不传 home 时才参考 `DSH_HOME`（宿主可能重定向了 Harness home）。
 */
export function dshHome(home) {
  if (home !== undefined) return path.join(home, '.dsh')
  return process.env.DSH_HOME ?? path.join(appPaths().home, '.dsh')
}

/** 解析设置文件路径 */
export function storePath(home) {
  return path.join(dshHome(home), STORE_FILENAME)
}

const DEFAULTS = {
  version: 1,
  enabledModelIds: [],   // 空数组 = 全部启用
  // true = 整体停用：不注册任何模型，模型选择器里彻底看不到 TeleAgent
  providerDisabled: false,
  // 工具白名单：null = 全发；数组 = 只把匹配的工具挂给内核（支持 `bash*`），
  // 用于压低每步重发的工具 schema token
  toolsAllowlist: null,
  // 积分福利：只存"是否开启自动领取"和上次领取结果，余额一律实时读上游
  welfare: {
    autoClaimDaily: true,
    lastClaimDate: null,
    lastClaimPoints: 0,
    lastClaimOk: false,
    lastClaimAt: null,
  },
}

/**
 * 说明：早期版本还有 `toolMode` / `allowedTools`（用于决定工具由 kernel 还是
 * DSH 执行）。直连上游后工具始终由 DSH 执行，这两个字段已废弃；
 * 旧配置文件里残留的键会被忽略并随下次写入清除。
 */

/** 读取设置；文件缺失或损坏时回退默认值（永不抛错） */
export function readStore(home) {
  try {
    const raw = fs.readFileSync(storePath(home), 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULTS }
    const next = {
      ...DEFAULTS,
      ...parsed,
      enabledModelIds: Array.isArray(parsed.enabledModelIds) ? parsed.enabledModelIds.filter((x) => typeof x === 'string') : [],
      providerDisabled: parsed.providerDisabled === true,
      toolsAllowlist: Array.isArray(parsed.toolsAllowlist)
        ? parsed.toolsAllowlist.filter((x) => typeof x === 'string' && x.trim().length > 0)
        : null,
      welfare: {
        ...DEFAULTS.welfare,
        ...(typeof parsed.welfare === 'object' && parsed.welfare !== null ? parsed.welfare : {}),
        autoClaimDaily: (parsed.welfare?.autoClaimDaily ?? DEFAULTS.welfare.autoClaimDaily) !== false,
      },
    }
    // 丢弃已废弃字段，避免它们继续出现在状态文档里误导排查
    delete next.toolMode
    delete next.allowedTools
    return next
  } catch {
    return { ...DEFAULTS }
  }
}

/** 原子写入设置 */
export function writeStore(patch, home) {
  const next = { ...readStore(home), ...patch, version: 1 }
  const target = storePath(home)
  const dir = path.dirname(target)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  fs.renameSync(tmp, target)
  return next
}

/** 校验并保存模型勾选；返回落盘后的设置 */
export function saveEnabledModels(ids, home) {
  const clean = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x.length > 0) : []
  return writeStore({ enabledModelIds: clean }, home)
}
