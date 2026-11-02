/**
 * 插件设置持久化测试。
 *
 * 覆盖：默认值、写入后重读、损坏文件回退、非法输入过滤、原子写。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  readStore,
  writeStore,
  saveEnabledModels,
  storePath,
  STORE_FILENAME,
} from '../lib/store.js'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-store-'))
}

test('readStore: 文件不存在时返回默认值', () => {
  const home = tmpHome()
  const s = readStore(home)
  assert.deepEqual(s.enabledModelIds, [])
})

test('storePath: 落在 $DSH_HOME 下', () => {
  const home = tmpHome()
  assert.equal(storePath(home), path.join(home, '.dsh', STORE_FILENAME))
})

test('saveEnabledModels: 写入后能读回', () => {
  const home = tmpHome()
  saveEnabledModels(['chat-pro', 'chat-flash'], home)
  assert.deepEqual(readStore(home).enabledModelIds, ['chat-pro', 'chat-flash'])
})

test('saveEnabledModels: 过滤非法输入', () => {
  const home = tmpHome()
  saveEnabledModels(['chat-pro', 123, null, '', { a: 1 }], home)
  assert.deepEqual(readStore(home).enabledModelIds, ['chat-pro'])
})

test('saveEnabledModels: 非数组输入存为空数组', () => {
  const home = tmpHome()
  saveEnabledModels('not-an-array', home)
  assert.deepEqual(readStore(home).enabledModelIds, [])
})

test('writeStore: 部分更新不影响其它字段', () => {
  const home = tmpHome()
  writeStore({ extraMark: 'keep-me' }, home)
  writeStore({ enabledModelIds: ['chat-nano'] }, home)
  const s = readStore(home)
  assert.equal(s.extraMark, 'keep-me', '先写的字段应保留')
  assert.deepEqual(s.enabledModelIds, ['chat-nano'])
})

test('readStore: 忽略已废弃的 toolMode 字段', () => {
  const home = tmpHome()
  fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
  fs.writeFileSync(storePath(home), JSON.stringify({ enabledModelIds: ['chat-pro'], toolMode: 'kernel' }))
  const s = readStore(home)
  assert.deepEqual(s.enabledModelIds, ['chat-pro'])
  assert.equal('toolMode' in s, false, '废弃字段不应再出现')
})

test('readStore: 损坏 JSON 回退默认值而不抛错', () => {
  const home = tmpHome()
  fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
  fs.writeFileSync(storePath(home), '{ 这不是合法 JSON')
  const s = readStore(home)
  assert.deepEqual(s.enabledModelIds, [])
})

test('readStore: 非对象根也回退默认值', () => {
  const home = tmpHome()
  fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
  fs.writeFileSync(storePath(home), '[1,2,3]')
  assert.deepEqual(readStore(home).enabledModelIds, [])
})

test('writeStore: 不留下临时文件', () => {
  const home = tmpHome()
  writeStore({ enabledModelIds: ['chat-pro'] }, home)
  const dir = path.join(home, '.dsh')
  const stray = fs.readdirSync(dir).filter((f) => f.includes('.tmp'))
  assert.deepEqual(stray, [], '原子写应清理临时文件')
})

test('readStore: providerDisabled 默认 false', () => {
  const home = tmpHome()
  assert.equal(readStore(home).providerDisabled, false)
})

test('writeStore: providerDisabled 可持久化', () => {
  const home = tmpHome()
  writeStore({ providerDisabled: true }, home)
  assert.equal(readStore(home).providerDisabled, true)
  writeStore({ providerDisabled: false }, home)
  assert.equal(readStore(home).providerDisabled, false)
})

test('readStore: 非布尔 providerDisabled 归一为 false', () => {
  const home = tmpHome()
  fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
  fs.writeFileSync(storePath(home), JSON.stringify({ providerDisabled: 'yes' }))
  assert.equal(readStore(home).providerDisabled, false)
})
