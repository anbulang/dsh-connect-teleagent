/**
 * 图片请求预算：手动构造的 pi-ai profile 必须带上这三个字段，否则图片会报
 * `Image request width must be a positive integer.`
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { IMAGE_REQUEST_BUDGET } from '../lib/image-budget.js'

test('IMAGE_REQUEST_BUDGET: 与官方 profile 默认值一致且均为正整数', () => {
  assert.deepEqual({ ...IMAGE_REQUEST_BUDGET }, {
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
  })
  for (const [key, value] of Object.entries(IMAGE_REQUEST_BUDGET)) {
    assert.ok(Number.isSafeInteger(value) && value > 0, `${key} 必须是正整数`)
  }
})

test('IMAGE_REQUEST_BUDGET: 像素预算能容纳 2048×2048，单张字节预算小于总预算', () => {
  const { requestImagePixelBudget, requestImageMaxBytes, maxRequestImageBytes } = IMAGE_REQUEST_BUDGET
  assert.ok(requestImagePixelBudget >= 2048 * 2048)
  assert.ok(requestImageMaxBytes < maxRequestImageBytes)
})
