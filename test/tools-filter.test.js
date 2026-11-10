import test from 'node:test'
import assert from 'node:assert/strict'
import { filterTools, estimatePrompt, toolName } from '../lib/tools-filter.js'

const t = (name) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } })
const tools = [t('bash'), t('read'), t('web_fetch'), t('office_docx'), t('obsidian_search')]

test('filterTools: 未配置时原样全发', () => {
  for (const allow of [undefined, null, []]) {
    const r = filterTools(tools, allow)
    assert.equal(r.tools.length, tools.length)
    assert.equal(r.applied, false)
  }
})

test('filterTools: 精确名字与通配符', () => {
  const r = filterTools(tools, ['bash', 'read', 'web_*'])
  assert.deepEqual(r.tools.map(toolName), ['bash', 'read', 'web_fetch'])
  assert.equal(r.applied, true)
  assert.equal(r.dropped, 2)
})

test('filterTools: * 表示全发', () => {
  const r = filterTools(tools, ['*'])
  assert.equal(r.tools.length, tools.length)
  assert.equal(r.applied, false)
})

test('filterTools: 一个都没匹配时回退全量（避免配置写错把工具全关）', () => {
  const r = filterTools(tools, ['no_such_tool'])
  assert.equal(r.tools.length, tools.length)
  assert.equal(r.applied, false)
  assert.equal(r.empty, true)
})

test('estimatePrompt: 替换工具后按字节/4 估算 tokens', () => {
  const body = { model: 'chat-flagship', messages: [{ role: 'user', content: 'hi' }], tools }
  const full = estimatePrompt(body)
  const slim = estimatePrompt(body, [t('bash')])
  assert.ok(full.tokensApprox > slim.tokensApprox)
  assert.ok(slim.toolBytes < full.toolBytes)
})

test('estimatePrompt: 按 UTF-8 字节计，不是 UTF-16 code unit', () => {
  const body = { model: 'chat-flagship', messages: [{ role: 'user', content: '中文内容' }] }
  const est = estimatePrompt(body)
  // 关键断言：bytes 必须等于 UTF-8 字节数（汉字 3 字节），而不是 .length
  assert.equal(est.bytes, Buffer.byteLength(JSON.stringify(body), 'utf8'))
  assert.ok(est.bytes > JSON.stringify(body).length, 'UTF-8 字节数应大于 UTF-16 长度')
})

test('estimatePrompt: 纯中文被低估的问题已修正（每字 3 字节）', () => {
  const zhChar = '中'
  assert.equal(Buffer.byteLength(zhChar, 'utf8'), 3)
  const body = { model: 'm', messages: [{ role: 'user', content: zhChar }] }
  const est = estimatePrompt(body)
  const utf16Length = JSON.stringify(body).length
  // 一个汉字：UTF-8 比 UTF-16 多 2 字节
  assert.equal(est.bytes - utf16Length, 2)
})

test('estimatePrompt: 中文工具数组的 toolBytes 也按 UTF-8 字节计', () => {
  const zhTool = {
    type: 'function',
    function: {
      name: '说明工具',
      description: '用于测试的中文工具描述',
      parameters: { type: 'object', properties: {} },
    },
  }
  const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [zhTool] }
  const est = estimatePrompt(body)
  assert.equal(est.toolBytes, Buffer.byteLength(JSON.stringify([zhTool]), 'utf8'))
  assert.ok(est.toolBytes > JSON.stringify([zhTool]).length, '中文工具 schema 应按 UTF-8 计')
})

test('estimatePrompt: 替换工具时 body 与 tools 字节口径一致', () => {
  const zhTools = [
    { type: 'function', function: { name: '中文一', description: '描述一', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: '中文二', description: '描述二', parameters: { type: 'object', properties: {} } } },
  ]
  const body = { model: 'm', messages: [{ role: 'user', content: '你好' }], tools: zhTools }
  const override = [zhTools[0]]
  const est = estimatePrompt(body, override)

  const fullBytes = Buffer.byteLength(JSON.stringify(body), 'utf8')
  const originalToolBytes = Buffer.byteLength(JSON.stringify(zhTools), 'utf8')
  const overrideBytes = Buffer.byteLength(JSON.stringify(override), 'utf8')
  assert.equal(est.toolBytes, overrideBytes)
  assert.equal(est.bytes, fullBytes - originalToolBytes + overrideBytes)
  assert.equal(est.tokensApprox, Math.round(est.bytes / 4))
})

test('estimatePrompt: 英文场景与旧行为一致（UTF-8 与 UTF-16 长度相同）', () => {
  const body = { model: 'chat-flagship', messages: [{ role: 'user', content: 'hello world' }], tools }
  const est = estimatePrompt(body)
  const json = JSON.stringify(body)
  assert.equal(Buffer.byteLength(json, 'utf8'), json.length)
  assert.equal(est.bytes, json.length)
})
