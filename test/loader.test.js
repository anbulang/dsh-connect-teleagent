/**
 * pi-ai 适配器加载器测试。
 *
 * 回归背景：DSH 在临时沙箱里用桩包提供 pi-ai，其 `api/openai-completions.lazy`
 * 是**目录**（只有 index.js、没有 exports 映射），裸目录导入会抛
 * ERR_UNSUPPORTED_DIR_IMPORT，导致 boot 失败、shim 起不来 → 用户侧 ECONNREFUSED。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { loadOpenAICompletionsApi, PI_AI_ADAPTER_SPECIFIERS } from '../lib/pi-ai-loader.js'

test('候选顺序：先标准子路径，再 /index.js', () => {
  assert.deepEqual(PI_AI_ADAPTER_SPECIFIERS, [
    '@earendil-works/pi-ai/api/openai-completions.lazy',
    '@earendil-works/pi-ai/api/openai-completions.lazy/index.js',
  ])
})

test('第一个候选可用时直接用，不再尝试后面的', async () => {
  const tried = []
  const mod = await loadOpenAICompletionsApi(async (spec) => {
    tried.push(spec)
    return { openAICompletionsApi: () => ({ kind: 'ok' }) }
  })
  assert.equal(typeof mod.openAICompletionsApi, 'function')
  assert.deepEqual(tried, [PI_AI_ADAPTER_SPECIFIERS[0]])
})

test('目录导入失败（ERR_UNSUPPORTED_DIR_IMPORT）时自动退到 /index.js', async () => {
  const tried = []
  const mod = await loadOpenAICompletionsApi(async (spec) => {
    tried.push(spec)
    if (spec === PI_AI_ADAPTER_SPECIFIERS[0]) {
      throw Object.assign(new Error('Directory import is not supported'), { code: 'ERR_UNSUPPORTED_DIR_IMPORT' })
    }
    return { openAICompletionsApi: () => ({ kind: 'fallback' }) }
  })
  assert.equal(typeof mod.openAICompletionsApi, 'function')
  assert.deepEqual(tried, [PI_AI_ADAPTER_SPECIFIERS[0], PI_AI_ADAPTER_SPECIFIERS[1]], '应退到第二个候选')
})

test('子路径都没有时退到主包上的同名导出', async () => {
  const mod = await loadOpenAICompletionsApi(async (spec) => {
    if (spec === '@earendil-works/pi-ai') return { openAICompletionsApi: () => ({ kind: 'main' }) }
    throw Object.assign(new Error('not found'), { code: 'ERR_MODULE_NOT_FOUND' })
  })
  assert.equal(typeof mod.openAICompletionsApi, 'function')
})

test('全部失败：报错里含每个候选的真实原因（可诊断）', async () => {
  await assert.rejects(
    () => loadOpenAICompletionsApi(async () => { throw Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' }) }),
    (error) => {
      assert.match(error.message, /已尝试 3 种方式/)
      assert.match(error.message, /ERR_MODULE_NOT_FOUND/)
      return true
    },
  )
})

test('候选模块存在但没有目标导出时继续往下找', async () => {
  const mod = await loadOpenAICompletionsApi(async (spec) => {
    if (spec.endsWith('/index.js')) return { openAICompletionsApi: () => ({ kind: 'index' }) }
    return { somethingElse: true }
  })
  assert.equal(typeof mod.openAICompletionsApi, 'function')
})
