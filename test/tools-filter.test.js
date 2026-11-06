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
