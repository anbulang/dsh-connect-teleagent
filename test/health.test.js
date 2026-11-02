/**
 * 上游错误分类测试。
 *
 * 重点覆盖「账号被封禁」(40109)：它和签名错误、token 失效长得像（都是 401），
 * 但处置方式完全不同——误报成「密钥无效」会让用户一直去重新登录。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyUpstreamError,
  recordUpstreamError,
  readUpstreamError,
  clearUpstreamError,
  describeUpstreamError,
} from '../lib/health.js'

test('classify: 40109 → account_banned，并给出申诉建议', () => {
  const info = classifyUpstreamError(401, { code: 40109, message: 'current user is banned' })
  assert.equal(info.code, 'account_banned')
  assert.match(info.message, /封禁/)
  assert.match(info.remedy, /客服|换一个账号/)
  assert.equal(info.httpStatus, 401)
  assert.equal(info.upstreamCode, 40109)
})

test('classify: 40104 → signature_invalid（指向协议变更）', () => {
  const info = classifyUpstreamError(401, { code: 40104, message: 'invalid signature' })
  assert.equal(info.code, 'signature_invalid')
  assert.match(info.remedy, /升级|签名/)
})

test('classify: 40108 → token_invalid（指向重新登录）', () => {
  const info = classifyUpstreamError(401, { code: 40108, message: 'invalid token' })
  assert.equal(info.code, 'token_invalid')
  assert.match(info.remedy, /重新登录/)
})

test('classify: 字符串错误码也能识别', () => {
  const info = classifyUpstreamError(401, { code: '40109', message: 'banned' })
  assert.equal(info.code, 'account_banned')
})

test('classify: 未知 401 归为 auth_rejected 并保留原文', () => {
  const info = classifyUpstreamError(401, { message: 'something else' })
  assert.equal(info.code, 'auth_rejected')
  assert.match(info.message, /something else/)
})

test('classify: 5xx 归为 upstream_unavailable（上游故障，不是配置问题）', () => {
  const info = classifyUpstreamError(503, { message: 'overloaded' })
  assert.equal(info.code, 'upstream_unavailable')
  assert.equal(info.httpStatus, 503)
  assert.match(info.remedy, /稍后|上游/)
})

test('classify: 非 JSON 响应用文本兜底', () => {
  const info = classifyUpstreamError(500, null, 'plain text failure')
  assert.equal(info.code, 'upstream_unavailable')
  assert.match(info.message, /plain text failure/)
})

test('classify: 402 → 积分不足', () => {
  const info = classifyUpstreamError(402, { message: 'no credits' })
  assert.equal(info.code, 'insufficient_credits')
  assert.match(info.remedy, /积分/)
})

test('classify: 429 → 限流（含业务码 4290）', () => {
  assert.equal(classifyUpstreamError(429, {}).code, 'rate_limited')
  assert.equal(classifyUpstreamError(400, { code: 4290 }).code, 'rate_limited')
})

test('classify: 413 → 请求体过大（明确不是账号问题）', () => {
  const info = classifyUpstreamError(413, {})
  assert.equal(info.code, 'payload_too_large')
  assert.match(info.remedy, /不是账号问题/)
})

test('classify: 404 → 接口变更（提示跑 doctor）', () => {
  assert.equal(classifyUpstreamError(404, {}).code, 'endpoint_changed')
})

test('classify: 1210 → 内容类型不支持（例如图片）', () => {
  const info = classifyUpstreamError(400, { code: 1210 })
  assert.equal(info.code, 'content_type_unsupported')
  assert.match(info.remedy, /chat-pro|图片/)
})

test('classify: 40110 → 账号停用', () => {
  assert.equal(classifyUpstreamError(401, { code: 40110 }).code, 'account_disabled')
})

test('classify: 永不抛错', () => {
  assert.doesNotThrow(() => classifyUpstreamError(undefined, undefined, undefined))
  assert.doesNotThrow(() => classifyUpstreamError(0, null, ''))
})

test('最近错误缓存：记录、读取、清除', () => {
  clearUpstreamError()
  assert.equal(readUpstreamError(), null)

  recordUpstreamError(classifyUpstreamError(401, { code: 40109, message: 'banned' }))
  const last = readUpstreamError()
  assert.equal(last.code, 'account_banned')
  assert.ok(typeof last.at === 'number')

  clearUpstreamError()
  assert.equal(readUpstreamError(), null)
})

test('describeUpstreamError: 拼接原因与建议', () => {
  const text = describeUpstreamError(classifyUpstreamError(401, { code: 40109, message: 'banned' }))
  assert.match(text, /封禁/)
  assert.match(text, /客服|账号/)
  assert.equal(describeUpstreamError(null), '')
})
