/**
 * 旧 JSON → DSH settings 迁移测试（task-2）。
 *
 * 分两段：
 *  1. `migrateLegacyToSettings` 纯函数：全部依赖注入，不碰文件系统。
 *  2. `readLegacyStore` / `isLegacyMigrated` / `markLegacyMigrated`：真实临时目录。
 *
 * 契约见 `.temp/settings-contract.md` §2 / §4。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  readLegacyStore,
  migrateLegacyToSettings,
  markLegacyMigrated,
  isLegacyMigrated,
  readStore,
  storePath,
  STORE_FILENAME,
} from '../lib/store.js'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-migrate-'))
}

/** 在临时 home 下真实写出旧配置文件（自动建 `.dsh/`） */
function seedLegacy(home, value) {
  fs.mkdirSync(path.dirname(storePath(home)), { recursive: true })
  fs.writeFileSync(storePath(home), typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
}

/** settings 侧默认值（全空） */
const EMPTY_SETTINGS = {
  providerDisabled: false,
  enabledModelIds: [],
  toolsAllowlist: [],
  autoClaimDaily: true,
}

/** 构造一个记录写入内容的 writeSettings */
function recorder() {
  const calls = []
  const writeSettings = (patch) => {
    calls.push(patch)
    return true
  }
  return { calls, writeSettings }
}

/* ------------------------------------------------------------------ *
 * 纯函数：迁移
 * ------------------------------------------------------------------ */

test('migrateLegacyToSettings: 空 settings + 有 legacy → 四个字段全迁移', async () => {
  const legacy = readLegacyStoreFromObject({
    providerDisabled: true,
    enabledModelIds: ['chat-pro', 'chat-flash'],
    toolsAllowlist: ['bash*', 'read'],
    welfare: { autoClaimDaily: false },
  })
  const { calls, writeSettings } = recorder()
  const result = await migrateLegacyToSettings({ legacy, isSettingsEmpty: true, writeSettings })

  assert.equal(result.migrated, true)
  assert.deepEqual(result.fields, ['providerDisabled', 'enabledModelIds', 'toolsAllowlist', 'autoClaimDaily'])
  assert.equal(result.reason, undefined)
  assert.equal(calls.length, 1, '应一次写入补丁')
  assert.deepEqual(calls[0], {
    providerDisabled: true,
    enabledModelIds: ['chat-pro', 'chat-flash'],
    toolsAllowlist: ['bash*', 'read'],
    autoClaimDaily: false,
  })
})

test('migrateLegacyToSettings: settings 非空 → 不迁移、不写入', async () => {
  const legacy = readLegacyStoreFromObject({ providerDisabled: true, enabledModelIds: ['chat-pro'] })
  const { calls, writeSettings } = recorder()
  const result = await migrateLegacyToSettings({ legacy, isSettingsEmpty: false, writeSettings })

  assert.equal(result.migrated, false)
  assert.deepEqual(result.fields, [])
  assert.equal(result.reason, 'settings-not-empty')
  assert.equal(calls.length, 0, '绝不能覆盖用户已有的 settings')
})

test('migrateLegacyToSettings: 已标记 migrated → 跳过（即使 settings 是空的）', async () => {
  const legacy = readLegacyStoreFromObject({ providerDisabled: true, migratedToSettings: true })
  const { calls, writeSettings } = recorder()
  const result = await migrateLegacyToSettings({ legacy, isSettingsEmpty: true, writeSettings })

  assert.equal(result.migrated, false)
  assert.equal(result.reason, 'already-migrated')
  assert.equal(calls.length, 0)
})

test('migrateLegacyToSettings: legacy 损坏/缺失（null）→ 不迁移且不抛错', async () => {
  for (const legacy of [null, undefined, 'not-an-object', 42, [1, 2]]) {
    const { calls, writeSettings } = recorder()
    const result = await migrateLegacyToSettings({ legacy, isSettingsEmpty: true, writeSettings })
    assert.equal(result.migrated, false, `legacy=${JSON.stringify(legacy)} 不应迁移`)
    assert.equal(result.reason, 'no-legacy')
    assert.deepEqual(result.fields, [])
    assert.equal(calls.length, 0)
  }
})

test('migrateLegacyToSettings: legacy 什么都没写 → 用默认值补齐四个字段', async () => {
  // 真实场景：旧文件里只有 welfare 的运行态数据，没有卡片四项
  const legacy = readLegacyStoreFromObject({
    welfare: { lastClaimDate: '2026-01-01', lastClaimPoints: 30 },
  })
  const { calls, writeSettings } = recorder()
  const result = await migrateLegacyToSettings({ legacy, isSettingsEmpty: true, writeSettings })

  assert.equal(result.migrated, true)
  assert.deepEqual(calls[0], EMPTY_SETTINGS, '缺失字段应落成默认值，而不是 key 缺失')
})

test('migrateLegacyToSettings: null toolsAllowlist → settings 里是 []（语义保持全发）', async () => {
  const legacy = readLegacyStoreFromObject({ toolsAllowlist: null })
  const { calls, writeSettings } = recorder()
  const result = await migrateLegacyToSettings({ legacy, isSettingsEmpty: true, writeSettings })

  assert.equal(result.migrated, true)
  assert.deepEqual(calls[0].toolsAllowlist, [], 'null 必须归一到 []')
  // 与 filterTools 的语义对齐：[] ⇒ names.length === 0 ⇒ 原样全发
  assert.equal(calls[0].toolsAllowlist.length, 0, '空数组 = 全发，不是"全禁"')
})

test('migrateLegacyToSettings: toolsAllowlist 非数组垃圾值 → []', async () => {
  for (const junk of ['bash', 123, { a: 1 }, true]) {
    const legacy = readLegacyStoreFromObject({ toolsAllowlist: junk })
    const { calls, writeSettings } = recorder()
    await migrateLegacyToSettings({ legacy, isSettingsEmpty: true, writeSettings })
    assert.deepEqual(calls[0].toolsAllowlist, [], `toolsAllowlist=${JSON.stringify(junk)} 应归一为 []`)
  }
})

test('migrateLegacyToSettings: 过滤非法模型 id 与空白工具名', async () => {
  const legacy = readLegacyStoreFromObject({
    enabledModelIds: ['chat-pro', 123, null, '', 'chat-flash'],
    toolsAllowlist: ['bash', '  ', 42, 'read'],
  })
  const { calls, writeSettings } = recorder()
  await migrateLegacyToSettings({ legacy, isSettingsEmpty: true, writeSettings })

  assert.deepEqual(calls[0].enabledModelIds, ['chat-pro', 'chat-flash'])
  assert.deepEqual(calls[0].toolsAllowlist, ['bash', 'read'])
})

test('migrateLegacyToSettings: isSettingsEmpty 可是异步函数（延迟求值）', async () => {
  const legacy = readLegacyStoreFromObject({ enabledModelIds: ['chat-pro'] })
  const { calls, writeSettings } = recorder()
  const result = await migrateLegacyToSettings({
    legacy,
    isSettingsEmpty: async () => true,
    writeSettings,
  })
  assert.equal(result.migrated, true)
  assert.equal(calls.length, 1)
})

test('migrateLegacyToSettings: isSettingsEmpty 抛错 → 保守不迁移', async () => {
  const legacy = readLegacyStoreFromObject({ enabledModelIds: ['chat-pro'] })
  const { calls, writeSettings } = recorder()
  const result = await migrateLegacyToSettings({
    legacy,
    isSettingsEmpty: () => { throw new Error('settings service exploded') },
    writeSettings,
  })
  assert.equal(result.migrated, false)
  assert.equal(result.reason, 'settings-state-unknown')
  assert.equal(calls.length, 0, '拿不准状态时绝不动 settings')
})

test('migrateLegacyToSettings: isSettingsEmpty 返回非布尔 → 保守不迁移', async () => {
  const legacy = readLegacyStoreFromObject({ enabledModelIds: ['chat-pro'] })
  const { calls, writeSettings } = recorder()
  for (const weird of [undefined, null, 'true', 1, {}]) {
    const result = await migrateLegacyToSettings({ legacy, isSettingsEmpty: weird, writeSettings })
    assert.equal(result.migrated, false, `isSettingsEmpty=${JSON.stringify(weird)}`)
    assert.equal(result.reason, 'settings-state-unknown')
  }
  assert.equal(calls.length, 0)
})

test('migrateLegacyToSettings: writeSettings 返回 false → 报 write-failed 且不抛错', async () => {
  const legacy = readLegacyStoreFromObject({ enabledModelIds: ['chat-pro'] })
  const result = await migrateLegacyToSettings({
    legacy,
    isSettingsEmpty: true,
    writeSettings: () => false,
  })
  assert.equal(result.migrated, false)
  assert.equal(result.reason, 'write-failed')
})

test('migrateLegacyToSettings: writeSettings 抛错 → 报 write-failed 且不抛错', async () => {
  const legacy = readLegacyStoreFromObject({ enabledModelIds: ['chat-pro'] })
  const result = await migrateLegacyToSettings({
    legacy,
    isSettingsEmpty: true,
    writeSettings: () => { throw new Error('no settings service') },
  })
  assert.equal(result.migrated, false)
  assert.equal(result.reason, 'write-failed')
})

test('migrateLegacyToSettings: 缺 writeSettings → no-writer', async () => {
  const legacy = readLegacyStoreFromObject({ enabledModelIds: ['chat-pro'] })
  const result = await migrateLegacyToSettings({ legacy, isSettingsEmpty: true })
  assert.equal(result.migrated, false)
  assert.equal(result.reason, 'no-writer')
})

test('migrateLegacyToSettings: 兼容 (key, value) 两参写入函数', async () => {
  const legacy = readLegacyStoreFromObject({
    providerDisabled: true,
    enabledModelIds: ['chat-pro'],
    toolsAllowlist: ['bash'],
    welfare: { autoClaimDaily: false },
  })
  const seen = {}
  const writeSettings = (key, value) => { seen[key] = value; return true }
  const result = await migrateLegacyToSettings({ legacy, isSettingsEmpty: true, writeSettings })

  assert.equal(result.migrated, true)
  assert.deepEqual(seen, {
    providerDisabled: true,
    enabledModelIds: ['chat-pro'],
    toolsAllowlist: ['bash'],
    autoClaimDaily: false,
  })
})

test('migrateLegacyToSettings: 两参写入函数中某个 key 失败 → write-failed', async () => {
  const legacy = readLegacyStoreFromObject({ enabledModelIds: ['chat-pro'] })
  // 声明两个形参才会被识别为 (key, value) 形状
  const writeSettings = (key, value) => (key !== 'toolsAllowlist' ? value !== undefined : false)
  const result = await migrateLegacyToSettings({ legacy, isSettingsEmpty: true, writeSettings })
  assert.equal(result.migrated, false)
  assert.equal(result.reason, 'write-failed')
})

test('migrateLegacyToSettings: 空参数调用不抛错', async () => {
  const result = await migrateLegacyToSettings()
  assert.equal(result.migrated, false)
  assert.equal(result.reason, 'no-legacy')
})

/* ------------------------------------------------------------------ *
 * 真实文件：读迁移源
 * ------------------------------------------------------------------ */

test('readLegacyStore: 文件缺失 → null（而非默认值，表示无迁移源）', () => {
  assert.equal(readLegacyStore(tmpHome()), null)
})

test('readLegacyStore: 损坏 JSON → null 且不抛错', () => {
  const home = tmpHome()
  seedLegacy(home, '{ 这不是合法 JSON')
  assert.equal(readLegacyStore(home), null)
})

test('readLegacyStore: 非对象根 → null', () => {
  const home = tmpHome()
  seedLegacy(home, '[1,2,3]')
  assert.equal(readLegacyStore(home), null)
})

test('readLegacyStore: 与 readStore 归一化一致', () => {
  const home = tmpHome()
  seedLegacy(home, {
    enabledModelIds: ['chat-pro', 123, ''],
    providerDisabled: 'yes',
    toolsAllowlist: null,
    welfare: { autoClaimDaily: false },
  })
  const legacy = readLegacyStore(home)
  const store = readStore(home)

  assert.deepEqual(legacy.enabledModelIds, store.enabledModelIds)
  assert.equal(legacy.providerDisabled, store.providerDisabled)
  assert.equal(legacy.toolsAllowlist, store.toolsAllowlist)
  assert.equal(legacy.welfare.autoClaimDaily, store.welfare.autoClaimDaily)
  // 两边必须给同一个答案（非字符串被过滤，空串保留 —— 与 readStore 原有行为一致）
  assert.deepEqual(legacy.enabledModelIds, ['chat-pro', ''])
  assert.equal(legacy.providerDisabled, false)
  assert.equal(legacy.toolsAllowlist, null)
  assert.equal(legacy.welfare.autoClaimDaily, false)
})

test('readLegacyStore: 暴露迁移标记（默认 false / null）', () => {
  const home = tmpHome()
  seedLegacy(home, { enabledModelIds: ['chat-pro'] })
  const before = readLegacyStore(home)
  assert.equal(before.migratedToSettings, false)
  assert.equal(before.migratedAt, null)

  markLegacyMigrated(home, { now: '2026-11-09T00:00:00.000Z' })
  const after = readLegacyStore(home)
  assert.equal(after.migratedToSettings, true)
  assert.equal(after.migratedAt, '2026-11-09T00:00:00.000Z')
})

/* ------------------------------------------------------------------ *
 * 真实文件：迁移标记
 * ------------------------------------------------------------------ */

test('isLegacyMigrated: 未标记 → false；文件缺失 → false', () => {
  const home = tmpHome()
  assert.equal(isLegacyMigrated(home), false, '文件不存在')
  seedLegacy(home, { enabledModelIds: ['chat-pro'] })
  assert.equal(isLegacyMigrated(home), false)
})

test('isLegacyMigrated: 损坏 JSON → false 且不抛错', () => {
  const home = tmpHome()
  seedLegacy(home, '{ broken')
  assert.equal(isLegacyMigrated(home), false)
})

test('isLegacyMigrated: 非布尔标记 → false（只认字面量 true）', () => {
  const home = tmpHome()
  for (const junk of ['true', 1, 'yes', {}]) {
    seedLegacy(home, { migratedToSettings: junk })
    assert.equal(isLegacyMigrated(home), false, `migratedToSettings=${JSON.stringify(junk)}`)
  }
})

test('markLegacyMigrated: 写标记但保留旧文件与其它所有字段', () => {
  const home = tmpHome()
  const original = {
    version: 1,
    enabledModelIds: ['chat-pro'],
    providerDisabled: true,
    toolsAllowlist: ['bash'],
    welfare: { autoClaimDaily: false, lastClaimDate: '2026-01-01' },
    // 已废弃 / 未知字段也必须原样留着：这是用户的文件，不是我们的
    toolMode: 'kernel',
    someFutureField: { nested: [1, 2, 3] },
  }
  seedLegacy(home, original)

  const ok = markLegacyMigrated(home, { now: '2026-11-09T12:00:00.000Z' })
  assert.equal(ok, true)

  assert.equal(fs.existsSync(storePath(home)), true, '旧文件必须保留')
  const raw = JSON.parse(fs.readFileSync(storePath(home), 'utf8'))
  assert.equal(raw.migratedToSettings, true)
  assert.equal(raw.migratedAt, '2026-11-09T12:00:00.000Z')
  // 逐字段核对：除了两个标记，原文件一个键都没变
  for (const [key, value] of Object.entries(original)) {
    assert.deepEqual(raw[key], value, `字段 ${key} 不应被改动`)
  }
  assert.equal(raw.toolMode, 'kernel', '已废弃字段也不该被清掉')
  assert.equal(raw.someFutureField.nested.length, 3)
})

test('markLegacyMigrated: 文件不存在时**不新建**文件', () => {
  const home = tmpHome()
  assert.equal(markLegacyMigrated(home), false)
  assert.equal(fs.existsSync(storePath(home)), false, '不能凭空造一个旧配置')
})

test('markLegacyMigrated: 损坏 JSON → 不改写、不抛错', () => {
  const home = tmpHome()
  seedLegacy(home, '{ half written')
  assert.equal(markLegacyMigrated(home), false)
  assert.equal(fs.readFileSync(storePath(home), 'utf8'), '{ half written', '不能覆盖损坏文件')
})

test('markLegacyMigrated: 非对象根 → 不改写', () => {
  const home = tmpHome()
  seedLegacy(home, '[1,2,3]')
  assert.equal(markLegacyMigrated(home), false)
  assert.equal(fs.readFileSync(storePath(home), 'utf8'), '[1,2,3]')
})

test('markLegacyMigrated: 幂等（重复打标记仍是 true，字段不变）', () => {
  const home = tmpHome()
  seedLegacy(home, { enabledModelIds: ['chat-pro'] })
  assert.equal(markLegacyMigrated(home, { now: '2026-01-01T00:00:00.000Z' }), true)
  assert.equal(markLegacyMigrated(home, { now: '2026-02-02T00:00:00.000Z' }), true)

  const raw = JSON.parse(fs.readFileSync(storePath(home), 'utf8'))
  assert.equal(raw.migratedToSettings, true)
  assert.equal(raw.migratedAt, '2026-02-02T00:00:00.000Z', '后一次覆盖时间戳')
  assert.deepEqual(raw.enabledModelIds, ['chat-pro'])
})

test('markLegacyMigrated: 不留下临时文件', () => {
  const home = tmpHome()
  seedLegacy(home, { enabledModelIds: ['chat-pro'] })
  markLegacyMigrated(home)
  const stray = fs.readdirSync(path.join(home, '.dsh')).filter((f) => f.includes('.tmp'))
  assert.deepEqual(stray, [], '原子写应清理临时文件')
})

/* ------------------------------------------------------------------ *
 * 端到端：readLegacyStore → migrate → mark → 再启动跳过
 * ------------------------------------------------------------------ */

test('端到端: 老用户首次启动迁移一次，第二次启动跳过', async () => {
  const home = tmpHome()
  seedLegacy(home, {
    enabledModelIds: ['chat-pro'],
    providerDisabled: true,
    toolsAllowlist: null,
    welfare: { autoClaimDaily: true },
  })

  // 第一次启动：settings 全空 → 迁移
  const written = []
  const first = await migrateLegacyToSettings({
    legacy: readLegacyStore(home),
    isSettingsEmpty: true,
    writeSettings: (patch) => { written.push(patch); return true },
  })
  assert.equal(first.migrated, true)
  assert.equal(written.length, 1)
  assert.deepEqual(written[0], {
    providerDisabled: true,
    enabledModelIds: ['chat-pro'],
    toolsAllowlist: [],
    autoClaimDaily: true,
  })
  assert.equal(markLegacyMigrated(home), true)
  assert.equal(isLegacyMigrated(home), true)

  // 第二次启动：旧文件还在，但已标记 → 直接跳过
  const second = await migrateLegacyToSettings({
    legacy: readLegacyStore(home),
    isSettingsEmpty: true,
    writeSettings: () => { throw new Error('不应被调用') },
  })
  assert.equal(second.migrated, false)
  assert.equal(second.reason, 'already-migrated')

  // 旧文件的内容仍在（用户数据不丢）
  const raw = JSON.parse(fs.readFileSync(storePath(home), 'utf8'))
  assert.deepEqual(raw.enabledModelIds, ['chat-pro'])
  assert.equal(raw.providerDisabled, true)
})

test('端到端: 未打标记但 settings 已非空 → 仍不覆盖（双保险）', async () => {
  const home = tmpHome()
  seedLegacy(home, { enabledModelIds: ['chat-pro'] })
  const result = await migrateLegacyToSettings({
    legacy: readLegacyStore(home),
    isSettingsEmpty: false,
    writeSettings: () => { throw new Error('不应被调用') },
  })
  assert.equal(result.migrated, false)
  assert.equal(result.reason, 'settings-not-empty')
})

/* 构造一个内存里的 legacy 对象，走与 readLegacyStore 相同的归一化路径 */
function readLegacyStoreFromObject(value) {
  const home = tmpHome()
  seedLegacy(home, value)
  return readLegacyStore(home)
}

/* 常量自检：文件名没被改动（消费者依赖它） */
test('STORE_FILENAME 保持不变', () => {
  assert.equal(STORE_FILENAME, 'teleagent-plugin.json')
})
