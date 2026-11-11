/**
 * 插件设置的**降级存储** + **旧数据迁移源**。
 *
 * ## 现在的角色（0.13.0 起）
 *
 * ```
 * DSH settings（主，真相源）  ──可用──>  读/写都走它
 *        │
 *        └──不可用（宿主没 provide settings 服务）──> 本文件自持久化（fallback）
 * ```
 *
 * `~/.dsh/teleagent-plugin.json` 不再是主存储：
 *  - **迁移源**：老用户升级后，`readLegacyStore()` + `migrateLegacyToSettings()`
 *    把四个可配字段搬进 DSH settings 一次，之后 settings 就是唯一真相源；
 *    旧文件**保留不删**（用户明确要求），只在里面写一个 `migratedToSettings`
 *    标记，避免每次启动重复尝试。
 *  - **fallback**：宿主版本太老、没提供 settings 服务时，仍然读写这个文件，
 *    保证插件在任何宿主上都能记住用户的勾选。
 *
 * ## 为什么曾经不用宿主的 `ctx.settings`
 *
 * 早期版本的写入是 `describe()` 找 namespace + `mutate(ns, ops)` 的两段式，
 * 且必须先 `configure()` 注册 schema 才有 row；不同 DSH 版本的形状还在变
 * （实测直接调一个不存在的 `update()` 会得到
 * `Config $ contains a non-plain root`）。现在我们按宿主实际提供的服务能力
 * 决定走哪条路，见 `lib/index.js`。
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
 * 每次返回**全新**的默认值副本。
 *
 * 早先是 `{ ...DEFAULTS }`，只复制了顶层：`welfare` 与 `enabledModelIds`
 * 两个引用在多次 `readStore()` 之间共享，任何调用方（含迁移代码）就地改一下
 * 就会污染后续所有读到的"默认值"。这里改成每次深复制，代价可忽略。
 */
function defaultStore() {
  return {
    ...DEFAULTS,
    enabledModelIds: [],
    welfare: { ...DEFAULTS.welfare },
  }
}

/**
 * 说明：早期版本还有 `toolMode` / `allowedTools`（用于决定工具由 kernel 还是
 * DSH 执行）。直连上游后工具始终由 DSH 执行，这两个字段已废弃；
 * 旧配置文件里残留的键会被忽略并随下次写入清除。
 */

/** 把任意解析结果归一化成一个合法设置对象（字段非法时回默认值） */
function normalizeStore(parsed, { defaults = true } = {}) {
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
  if (!defaults) {
    // Presence matters for precedence: synthesized defaults must not override
    // explicit host config or be migrated as if the user saved them.
    for (const key of Object.keys(DEFAULTS)) {
      if (!Object.hasOwn(parsed, key)) delete next[key]
    }
    if (next.welfare) {
      for (const key of Object.keys(DEFAULTS.welfare)) {
        if (!Object.hasOwn(parsed.welfare ?? {}, key)) delete next.welfare[key]
      }
    }
  }
  return next
}

/** 读取设置；defaults:false 只返回实际保存的字段，缺失或损坏时返回 {}。永不抛错。 */
export function readStore(home, { defaults = true } = {}) {
  try {
    const raw = fs.readFileSync(storePath(home), 'utf8')
    const parsed = JSON.parse(raw)
    if (!isPlainRecord(parsed)) return defaults ? defaultStore() : {}
    return normalizeStore(parsed, { defaults })
  } catch {
    return defaults ? defaultStore() : {}
  }
}

/**
 * 读取**旧**设置文件，语义上标记为「迁移源」。
 *
 * 与 `readStore` 用同一套字段归一化，但不补缺失字段的默认值。
 * **文件不存在 / 损坏 / 根不是对象时返回 `null`**，而不是默认值：迁移需要
 * 区分"没有迁移源"和"迁移源是空配置"，`null` 就是不迁移的信号。
 *
 * 永不抛错。
 *
 * @param {string} [home]
 * @returns {object|null} 归一化后的设置；无迁移源时为 null
 */
export function readLegacyStore(home) {
  try {
    const raw = fs.readFileSync(storePath(home), 'utf8')
    const parsed = JSON.parse(raw)
    if (!isPlainRecord(parsed)) return null
    const normalized = normalizeStore(parsed, { defaults: false })
    // 迁移标记单独归一化：只有字面量 true 才算已迁移
    normalized.migratedToSettings = parsed.migratedToSettings === true
    normalized.migratedAt = typeof parsed.migratedAt === 'string' && parsed.migratedAt !== '' ? parsed.migratedAt : null
    return normalized
  } catch {
    return null
  }
}

/** 原子写入设置（fallback 路径） */
export function writeStore(patch, home) {
  // 注意：这是 **settings 不可用时的降级路径**。settings 可用时，写入应走
  // lib/index.js 的 settings 适配器，本函数不再承担主存储职责。
  const previous = readStore(home, { defaults: false })
  const next = { ...previous, ...patch, version: 1 }
  if (isPlainRecord(patch?.welfare)) {
    next.welfare = { ...previous.welfare, ...patch.welfare }
  }
  atomicWriteJson(storePath(home), next)
  return next
}

/** 校验并保存模型勾选；返回落盘后的设置 */
export function saveEnabledModels(ids, home) {
  const clean = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x.length > 0) : []
  return writeStore({ enabledModelIds: clean }, home)
}

/* ------------------------------------------------------------------ *
 * 旧 JSON → DSH settings 迁移
 * ------------------------------------------------------------------ */

/**
 * 从旧设置算出 settings 侧的字段补丁。
 *
 * 两条规则：
 *  1. 只迁移文件实际保存的字段，不能把默认值迁移到 config 之前。
 *     只有领取记录的文件不是设置来源。
 *  2. `toolsAllowlist` 在 settings 里只能表达数组：旧 store 的 `null`（全发）
 *     与 `[]`（全发）在本插件语义下等价（见 `lib/tools-filter.js`：
 *     `names.length === 0` 即原样全发），所以 `null` 一律落成 `[]`。
 *
 * 输出的键顺序固定，`JSON.stringify` 稳定，便于断言。
 */
function legacySettingsPatch(legacy) {
  const patch = {}
  if (Object.hasOwn(legacy, 'providerDisabled')) patch.providerDisabled = legacy.providerDisabled === true
  if (Object.hasOwn(legacy, 'enabledModelIds')) {
    patch.enabledModelIds = Array.isArray(legacy.enabledModelIds)
      ? legacy.enabledModelIds.filter((x) => typeof x === 'string' && x.length > 0)
      : []
  }
  if (Object.hasOwn(legacy, 'toolsAllowlist')) {
    patch.toolsAllowlist = Array.isArray(legacy.toolsAllowlist)
      ? legacy.toolsAllowlist.filter((x) => typeof x === 'string' && x.trim().length > 0)
      : []
  }
  // 旧文件里它在 welfare 下，settings 里是顶层字段
  if (Object.hasOwn(legacy.welfare ?? {}, 'autoClaimDaily')) {
    patch.autoClaimDaily = legacy.welfare.autoClaimDaily !== false
  }
  return patch
}

/**
 * 把旧 JSON 的设置迁移进 DSH settings —— **纯函数 + 注入依赖**。
 *
 * 这里**不**读写文件、也**不**碰 settings 服务：一切外部能力都由调用方注入，
 * 因此可以完全脱离宿主单测。
 *
 * 幂等有两道保险：
 *  1. `isSettingsEmpty` 不是明确的 `true` 时一律不写（非空 → 绝不覆盖）；
 *  2. 调用方在拿到 `migrated === true` 后应调 {@link markLegacyMigrated}；
 *     即使忘了，迁移写完后 settings 也不再是空值，下次启动第 1 条就会拦住。
 *
 * @param {object} options
 * @param {object|null} options.legacy 旧设置（通常来自 `readLegacyStore()`）；null = 无迁移源
 * @param {boolean|(() => boolean|Promise<boolean>)} options.isSettingsEmpty
 *        settings 侧是否全部为默认值。传函数可延迟求值；**无法确定时返回
 *        非布尔值**——此时不迁移（宁可不动，也不覆盖用户配置）。
 * @param {(patch: object) => any} options.writeSettings
 *        写入补丁，可返回 Promise；返回 `false` 视为写入失败。
 *        推荐单参「补丁」形状；也接受 `(key, value)` 两参形状（`lib/index.js`
 *        的 `writeSetting(key, value)` 就是这种），按形参个数区分。
 * @returns {Promise<{migrated:boolean, fields:string[], reason?:string}>}
 *        `fields` 只在 `migrated === true` 时非空，是实际迁移的字段名。
 *        失败原因：`no-legacy` / `already-migrated` / `settings-not-empty` /
 *        `settings-state-unknown` / `no-settings` / `no-writer` / `write-failed`。永不抛错。
 */
export async function migrateLegacyToSettings({ legacy, isSettingsEmpty, writeSettings } = {}) {
  if (!isPlainRecord(legacy)) return fail('no-legacy')
  if (legacy.migratedToSettings === true) return fail('already-migrated')

  const empty = await resolveSettingsEmpty(isSettingsEmpty)
  // 只有明确 true 才迁移：false / undefined / 抛错 一律保守不动
  if (empty === false) return fail('settings-not-empty')
  if (empty !== true) return fail('settings-state-unknown')

  if (typeof writeSettings !== 'function') return fail('no-writer')

  const patch = legacySettingsPatch(legacy)
  if (Object.keys(patch).length === 0) return fail('no-settings')
  try {
    const ok = await writePatch(writeSettings, patch)
    if (ok === false) return fail('write-failed')
  } catch {
    return fail('write-failed')
  }
  return { migrated: true, fields: Object.keys(patch) }
}

/** 统一的"没迁移"返回值 */
function fail(reason) {
  return { migrated: false, fields: [], reason }
}

/**
 * 调注入的写入函数；`false` 表示失败。
 *
 * 两种形状都支持：`writeSettings(patch)`（推荐，一次原子写入）与
 * `writeSettings(key, value)`（宿主 `settings.update(ns, {...})` 的薄封装）。
 * 按**声明形参个数**区分是这里唯一可行的判据；调用方写 `(...args)` 这类
 * 可变形参时请用单参补丁形状，否则会被当成两参。
 */
async function writePatch(writeSettings, patch) {
  if (writeSettings.length >= 2) {
    let ok = true
    for (const key of Object.keys(patch)) {
      if ((await writeSettings(key, patch[key])) === false) ok = false
    }
    return ok
  }
  return (await writeSettings(patch)) === false ? false : true
}

/** 求值 `isSettingsEmpty`：支持布尔与（可异步的）函数；异常/非布尔 → undefined */
async function resolveSettingsEmpty(isSettingsEmpty) {
  try {
    const value = typeof isSettingsEmpty === 'function' ? await isSettingsEmpty() : isSettingsEmpty
    return typeof value === 'boolean' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 旧文件是否已经打过迁移标记（永不抛错）。
 *
 * 文件缺失、损坏、根不是对象 → `false`。
 */
export function isLegacyMigrated(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(home), 'utf8'))
    return isPlainRecord(parsed) && parsed.migratedToSettings === true
  } catch {
    return false
  }
}

/**
 * 在旧文件里写下 `migratedToSettings: true` + `migratedAt`。
 *
 * 硬约束（用户已确认）：
 *  - **不删除**旧文件，也不清空任何字段 —— 原样保留，只加两个标记键；
 *  - 保留所有未知 / 已废弃的键（这里读原始 JSON，不走 `normalizeStore`，
 *    因为归一化会丢掉 `toolMode` 之类的历史键，而那属于"改动用户文件"）；
 *  - 文件不存在时**不新建**（凭空造一个旧配置只会让状态更难解释）；
 *  - 文件损坏时**不改写**（可能是用户手改到一半，别把内容覆盖掉）。
 *
 * 写入走「临时文件 + rename」。永不抛错，返回是否真的写成功。
 *
 * @param {string} [home]
 * @param {{now?: Date|number|string|(() => any)}} [options] `now` 便于测试注入固定时间
 * @returns {boolean}
 */
export function markLegacyMigrated(home, { now } = {}) {
  const target = storePath(home)
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
  } catch {
    // 不存在 或 损坏，都不动它
    return false
  }
  if (!isPlainRecord(parsed)) return false
  const next = { ...parsed, migratedToSettings: true, migratedAt: isoOf(now) }
  try {
    atomicWriteJson(target, next)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * 内部工具
 * ------------------------------------------------------------------ */

/** 只接受普通对象（排除 null / 数组 / 标量） */
function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把注入的 `now` 归一成 ISO 字符串；非法值回落到当前时间 */
function isoOf(now) {
  const value = typeof now === 'function' ? now() : now
  if (typeof value === 'string' && value !== '') return value
  const date = value instanceof Date ? value : new Date(value ?? Date.now())
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

/** 「临时文件 + rename」原子写 JSON，不留 `*.tmp` 残留 */
function atomicWriteJson(target, value) {
  const dir = path.dirname(target)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, target)
}
