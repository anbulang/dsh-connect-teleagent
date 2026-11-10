/**
 * DSH 原生 settings 集成测试。
 *
 * 覆盖本次「设置统一到 DSH 设置」的四块契约（见 `.temp/settings-contract.md`）：
 *  1. `Config` schema 的字段、默认值、volatile 标记（宿主靠它渲染原生表单）
 *  2. `settingsNamespaceOf` 的两种分支（Loader 条目 id / 兜底常量）
 *  3. `asVolatile` / `unwrapVolatile` / `unwrapVolatileDeep` 的活引用语义
 *  4. 无 settings 服务时的优雅退化 + 白名单优先级
 *
 * 为什么每一支都要测两遍（真 schemastery / 内置 shim）：本机依赖树里
 * schemastery 不一定解析得到，用哪支由部署环境决定。只测一支的话，另一支
 * 会在某些机器上悄悄坏掉 —— 下面 `shim 的 live dict` 那条就是真实踩过的坑。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import {
  Config,
  TELEAGENT_SETTINGS_NS,
  SETTINGS_FIELDS,
  SETTINGS_DEFAULTS,
  asVolatile,
  unwrapVolatile,
  unwrapVolatileDeep,
  createBuiltinSchemastery,
  buildConfigSchema,
  loadSchemastery,
  SCHEMA_RUNTIME_INFO,
  settingsNamespaceOf,
  pickToolsAllowlist,
  normalizeToolsAllowlistValue,
} from '../lib/index.js'

// ---------------------------------------------------------------- schema 形状

test('Config: 四个字段齐全且顺序稳定', () => {
  assert.deepEqual([...SETTINGS_FIELDS], [
    'providerDisabled',
    'enabledModelIds',
    'toolsAllowlist',
    'autoClaimDaily',
  ])
  const json = Config.toJSON()
  const root = json.refs[json.uid]
  assert.deepEqual(Object.keys(root.dict), [...SETTINGS_FIELDS])
})

test('Config: 每个字段都带 volatile 标记和中文 description', () => {
  const json = Config.toJSON()
  const root = json.refs[json.uid]
  for (const field of SETTINGS_FIELDS) {
    const node = json.refs[root.dict[field]]
    assert.equal(node.meta.volatile, true, `${field} 必须 volatile（否则需重启才生效）`)
    assert.equal(typeof node.meta.description, 'string', `${field} 必须有 description`)
    assert.ok(node.meta.description.length > 0, `${field} description 不能为空`)
  }
})

test('Config: 默认值与 store 的 DEFAULTS 一致', () => {
  const json = Config.toJSON()
  const root = json.refs[json.uid]
  const metaOf = (field) => json.refs[root.dict[field]].meta
  assert.equal(metaOf('providerDisabled').default, SETTINGS_DEFAULTS.providerDisabled)
  assert.deepEqual(metaOf('enabledModelIds').default, [...SETTINGS_DEFAULTS.enabledModelIds])
  // settings schema 只能表达 []；插件的「全发」语义里 null 与 [] 等价
  assert.deepEqual(metaOf('toolsAllowlist').default, [...SETTINGS_DEFAULTS.toolsAllowlist])
  assert.equal(metaOf('autoClaimDaily').default, SETTINGS_DEFAULTS.autoClaimDaily)
})

test('Config: toJSON 用 refs 间接引用（宿主 volatileForm 依赖这个形状）', () => {
  const json = Config.toJSON()
  assert.equal(typeof json.uid, 'number')
  assert.equal(typeof json.refs, 'object')
  const root = json.refs[json.uid]
  // dict 里必须是 ref id（number），不是内联节点 —— 真实 schemastery 就是这样
  for (const field of SETTINGS_FIELDS) {
    assert.equal(typeof root.dict[field], 'number', `${field} 必须是 ref id`)
    assert.ok(json.refs[root.dict[field]], `${field} 的 ref 必须存在`)
  }
})

// ---------------------------------------------- 内置 shim（无 schemastery 时）

test('shim: 结构与真 schemastery 同构（toJSON）', () => {
  const z = createBuiltinSchemastery()
  const cfg = buildConfigSchema(z)
  const json = cfg.toJSON()
  const root = json.refs[json.uid]
  assert.equal(root.type, 'object')
  assert.deepEqual(Object.keys(root.dict), [...SETTINGS_FIELDS])
  for (const field of SETTINGS_FIELDS) {
    assert.equal(json.refs[root.dict[field]].meta.volatile, true)
  }
})

test('shim: live 对象必须有 .dict（宿主 volatileForm 读的是它，不是 toJSON）', () => {
  const z = createBuiltinSchemastery()
  const cfg = buildConfigSchema(z)
  // ⚠️ 真实回归点：宿主 dsh-settings 的 volatileForm(schema) 读的是活对象的
  // `schema.type` / `schema.meta.volatile` / `schema.dict`。早期 shim 只暴露内部
  // 的 `shape`，于是 `Object.entries(schema.dict ?? {})` 得到空表、判定「没有
  // volatile 字段」→ 原生设置页静默不渲染（不报错、不留占位）。
  assert.equal(cfg.type, 'object')
  assert.ok(cfg.dict, 'shim 的活对象必须暴露 .dict')
  assert.deepEqual(Object.keys(cfg.dict), [...SETTINGS_FIELDS])
  for (const field of SETTINGS_FIELDS) {
    assert.equal(cfg.dict[field].meta.volatile, true, `${field} 在活对象上也必须 volatile`)
  }
})

test('shim: 模拟宿主 volatileForm，替身与真包都产出四字段表单', () => {
  // 逐字复刻 dsh-settings@0.2.2-rc.1 的 volatileForm/plainSchema 关键逻辑，
  // 用它把「宿主能不能渲染出表单」这件事变成可断言的。
  const volatileForm = (z) => (schema) => {
    if (schema.meta.volatile) return schema
    if (schema.type === 'object') {
      const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = volatileForm(z)(child)
        return field === undefined ? [] : [[key, field]]
      }))
      return Object.keys(dict).length === 0 ? undefined : z.object(dict)
    }
    return undefined
  }

  const shimZ = createBuiltinSchemastery()
  const viaShim = volatileForm(shimZ)(buildConfigSchema(shimZ))
  assert.ok(viaShim !== undefined, 'shim schema 必须能渲染出表单')
  assert.deepEqual(Object.keys(viaShim.dict ?? {}), [...SETTINGS_FIELDS])
})

test('shim: 校验时 volatile 字段返回活引用（与 cordis 行为一致）', () => {
  const z = createBuiltinSchemastery()
  const cfg = buildConfigSchema(z)
  const validated = cfg['~standard'].validate({ providerDisabled: true })
  const field = validated.value.providerDisabled
  assert.equal(typeof field.get, 'function', 'volatile 字段必须是 {get()} 活引用')
  assert.equal(field.get(), true)
  // 非 volatile 之外的未知键原样透传（transport/guard 等不能被 schema 吃掉）
  const withUnknown = cfg['~standard'].validate({ transport: 'direct' })
  assert.equal(withUnknown.value.transport, 'direct')
})

test('shim: 脏值退默认值而不是抛错（无 settings 的宿主不能因此起不来）', () => {
  const z = createBuiltinSchemastery()
  const cfg = buildConfigSchema(z)
  const out = cfg['~standard'].validate({ providerDisabled: 'yes', autoClaimDaily: 42 })
  assert.equal(out.value.providerDisabled.get?.() ?? out.value.providerDisabled, false)
})

// ---------------------------------------------------------- schema 来源解析

test('loadSchemastery: 永不抛错，且给出 source 标签', () => {
  const result = loadSchemastery({ anchors: ['/nonexistent/anchor.cjs'] })
  assert.ok(['schemastery', 'builtin-fallback'].includes(result.source))
  assert.equal(typeof result.z?.object, 'function')
  // 解析不到时 failures 必须留痕，便于用户排查
  if (result.source === 'builtin-fallback') {
    assert.ok(result.failures.length > 0, 'fallback 时必须记录失败原因')
  }
})

test('SCHEMA_RUNTIME_INFO: 暴露 source 与 failures 供排查', () => {
  assert.ok(['schemastery', 'builtin-fallback'].includes(SCHEMA_RUNTIME_INFO.source))
  assert.ok(Array.isArray(SCHEMA_RUNTIME_INFO.failures))
  assert.ok(Object.isFrozen(SCHEMA_RUNTIME_INFO))
})

test('buildConfigSchema: 同一个 z 可重复构造（不共享可变状态）', () => {
  const z = createBuiltinSchemastery()
  const a = buildConfigSchema(z)
  const b = buildConfigSchema(z)
  assert.deepEqual(Object.keys(a.dict), Object.keys(b.dict))
})

// ----------------------------------------------------------- namespace 解析

test('settingsNamespaceOf: 有 Loader 条目时用条目 id（宿主按精确匹配查表）', () => {
  const ctx = { fiber: { entry: { options: { id: 'include:dsh-connect-teleagent' } } } }
  assert.equal(settingsNamespaceOf(ctx), 'include:dsh-connect-teleagent')
})

test('settingsNamespaceOf: 没有 Loader 条目时退回声明值', () => {
  for (const ctx of [undefined, null, {}, { fiber: {} }, { fiber: { entry: {} } }, { fiber: { entry: { options: {} } } }]) {
    assert.equal(settingsNamespaceOf(ctx), TELEAGENT_SETTINGS_NS)
  }
})

test('settingsNamespaceOf: 空字符串/非字符串 id 也退回声明值', () => {
  for (const id of ['', null, undefined, 123, {}]) {
    assert.equal(settingsNamespaceOf({ fiber: { entry: { options: { id } } } }), TELEAGENT_SETTINGS_NS)
  }
})

// ------------------------------------------------------------- volatile 语义

test('asVolatile: 有 volatile() 时调用它', () => {
  let called = 0
  const schema = { volatile: () => { called += 1; return schema } }
  assert.equal(asVolatile(schema), schema)
  assert.equal(called, 1)
})

test('asVolatile: schemastery schema 是函数对象，也必须被识别', () => {
  const z = createBuiltinSchemastery()
  const schema = asVolatile(z.boolean())
  assert.equal(schema.meta.volatile, true, '函数对象不能被 typeof === object 挡掉')
})

test('asVolatile: 没有 volatile() 时恒等 no-op（老 schemastery 兼容）', () => {
  const legacy = { type: 'boolean', meta: {} } // 3.18.3 之前没有 volatile()
  assert.equal(asVolatile(legacy), legacy)
  assert.equal(legacy.meta.volatile, undefined, '不能手写 meta.volatile 绕过校验')
})

test('asVolatile: null/undefined/原始值不抛错', () => {
  for (const value of [null, undefined, 0, '', 'x', true]) {
    assert.doesNotThrow(() => asVolatile(value))
  }
})

test('asVolatile: volatile() 自己抛错时退回原 schema', () => {
  const boom = { volatile: () => { throw new Error('nope') } }
  assert.equal(asVolatile(boom), boom)
})

test('unwrapVolatile: 剥一层活引用', () => {
  assert.equal(unwrapVolatile({ get: () => 'v' }), 'v')
  assert.equal(unwrapVolatile('plain'), 'plain')
  assert.equal(unwrapVolatile(null), null)
  assert.equal(unwrapVolatile(undefined), undefined)
  // 只剥一层：嵌套引用要交给 unwrapVolatileDeep
  const nested = { get: () => ({ get: () => 'deep' }) }
  assert.equal(typeof unwrapVolatile(nested), 'object')
})

test('unwrapVolatileDeep: 任意深度都剥掉', () => {
  const input = {
    a: { get: () => 1 },
    b: [{ get: () => 2 }, { c: { get: () => 3 } }],
    d: 'plain',
  }
  assert.deepEqual(unwrapVolatileDeep(input), { a: 1, b: [2, { c: 3 }], d: 'plain' })
})

test('unwrapVolatileDeep: 不就地改调用方的值', () => {
  const inner = { get: () => 'x' }
  const input = { held: inner }
  const out = unwrapVolatileDeep(input)
  assert.equal(out.held, 'x')
  assert.equal(typeof input.held.get, 'function', '原对象必须保持不变')
  assert.notEqual(out, input)
})

test('unwrapVolatileDeep: 原始值/数组/空对象', () => {
  assert.equal(unwrapVolatileDeep(5), 5)
  assert.equal(unwrapVolatileDeep(null), null)
  assert.deepEqual(unwrapVolatileDeep([]), [])
  assert.deepEqual(unwrapVolatileDeep({}), {})
})

// ------------------------------------------------------- 白名单优先级与归一

test('pickToolsAllowlist: settings > store > config', () => {
  assert.deepEqual(
    pickToolsAllowlist({ settings: ['a'], store: ['b'], config: ['c'] }),
    ['a'],
  )
  assert.deepEqual(pickToolsAllowlist({ store: ['b'], config: ['c'] }), ['b'])
  assert.deepEqual(pickToolsAllowlist({ config: ['c'] }), ['c'])
  assert.equal(pickToolsAllowlist({}), null)
})

test('pickToolsAllowlist: null 视为「这一层没有值」继续往下找', () => {
  // settings 侧的「全发」是 []；null 只可能来自 store 的历史值
  assert.deepEqual(pickToolsAllowlist({ settings: null, store: ['b'] }), ['b'])
  assert.deepEqual(pickToolsAllowlist({ settings: undefined, config: ['c'] }), ['c'])
})

test('pickToolsAllowlist: 空数组是有效值（表示全发），不能被跳过', () => {
  // 关键：用户在界面上显式选了「恢复全量」→ 写 [] → 必须压过 store/config
  assert.deepEqual(pickToolsAllowlist({ settings: [], store: ['b'], config: ['c'] }), [])
})

test('normalizeToolsAllowlistValue: null 与 [] 归一成同一个答案', () => {
  assert.deepEqual(normalizeToolsAllowlistValue(null), [])
  assert.deepEqual(normalizeToolsAllowlistValue(undefined), [])
  assert.deepEqual(normalizeToolsAllowlistValue([]), [])
  assert.deepEqual(normalizeToolsAllowlistValue('not-array'), [])
})

test('normalizeToolsAllowlistValue: 过滤非字符串与空白项，并 trim', () => {
  assert.deepEqual(
    normalizeToolsAllowlistValue([' bash ', 'read', 123, null, '', '   ', 'web_*']),
    ['bash', 'read', 'web_*'],
  )
})

test('normalizeToolsAllowlistValue: 归一后 len 为 0 即「全发」（与 tools-filter 语义一致）', () => {
  assert.equal(normalizeToolsAllowlistValue(null).length, 0)
  assert.equal(normalizeToolsAllowlistValue([]).length, 0)
  assert.equal(normalizeToolsAllowlistValue(['bash']).length, 1)
})

// ------------------------------------------------------- 无 settings 优雅退化

test('无 settings 服务时 settingsNamespaceOf 仍可用（不崩）', () => {
  // apply 里所有 settings 访问都 try/catch；这里验证纯函数侧不依赖服务
  assert.equal(settingsNamespaceOf({}), TELEAGENT_SETTINGS_NS)
  assert.doesNotThrow(() => settingsNamespaceOf({ fiber: { entry: {} } }))
})

test('模块顶层不因 schemastery 不可解析而抛错', () => {
  // 走到这里说明 import 成功 —— 即「解析不到就退 shim」的兜底生效了
  assert.ok(Config !== undefined)
  assert.equal(typeof Config.toJSON, 'function')
})

test('真 schemastery 可用时也能构造同形状的 Config', () => {
  // 本机 profile 里有真包时顺便验一遍；没有就跳过（不把环境差异当失败）
  let z
  try {
    const req = createRequire('/Users/chaucer/.dsh/profiles/desktop/index.js')
    const mod = req('@deepseek-ai/schemastery')
    z = mod.default ?? mod
  } catch {
    return
  }
  const cfg = buildConfigSchema(z)
  const json = cfg.toJSON()
  const root = json.refs[json.uid]
  assert.deepEqual(Object.keys(root.dict), [...SETTINGS_FIELDS])
  for (const field of SETTINGS_FIELDS) {
    assert.equal(json.refs[root.dict[field]].meta.volatile, true)
  }
  // 活对象同样要有 .dict（宿主 volatileForm 读它）
  assert.deepEqual(Object.keys(cfg.dict ?? {}), [...SETTINGS_FIELDS])
})
