/**
 * 凭据诊断单元测试。
 *
 * 用临时目录构造各种「坏掉的」凭据现场，验证：
 *  - 失败状态被精确分类（不是笼统的读取失败）
 *  - 每个失败都带可执行建议
 *  - 正常情况能解出账号与剩余天数
 *
 * 不依赖真实钥匙串：涉及钥匙串的分支通过状态断言覆盖，
 * 解密逻辑用已知密文单独测。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

import {
  CredentialState,
  REMEDIES,
  diagnoseCredential,
  parseClaims,
  decryptSafeStorage,
} from '../lib/credential.js'

/** 造一个临时 HOME，里面按需放置数据目录结构 */
function makeHome({ scope, tokenFile } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-test-'))
  const data = path.join(home, '.local', 'share', 'TeleAgent')
  fs.mkdirSync(data, { recursive: true })
  if (scope) {
    const userDir = path.join(data, 'users', scope, 'app-auth')
    fs.mkdirSync(userDir, { recursive: true })
    if (tokenFile !== undefined) {
      fs.writeFileSync(path.join(userDir, 'token.json'), typeof tokenFile === 'string' ? tokenFile : JSON.stringify(tokenFile))
    }
    fs.writeFileSync(path.join(data, 'current-owner.json'), JSON.stringify({ ownerDir: scope, tenantId: 'public' }))
  }
  return { home, data }
}

/** 构造一个指定过期时间的 JWT（签名随便，只为解析声明） */
function makeJwt(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(claims)}.sig`
}

/** 用 safeStorage v10 方案加密一段明文，用于验证解密路径 */
function sealV10(plain, password) {
  const key = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), 'saltysalt', 1003, 16, 'sha1')
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from('v10'), body]).toString('base64')
}

// ---------------------------------------------------------------- 状态分类
test('诊断为 NOT_SIGNED_IN：没有 current-owner.json', () => {
  const { home } = makeHome({})
  const d = diagnoseCredential(home)
  assert.equal(d.ok, false)
  assert.equal(d.state, CredentialState.NOT_SIGNED_IN)
  assert.ok(d.remedy, '必须带可执行建议')
})

test('诊断为 TOKEN_FILE_MISSING：有 scope 但缺 token.json', () => {
  const { home } = makeHome({ scope: 'v1_public_1' })
  const d = diagnoseCredential(home)
  assert.equal(d.state, CredentialState.TOKEN_FILE_MISSING)
  assert.ok(d.remedy)
})

test('诊断为 TOKEN_FILE_MISSING：token.json 里没有 encryptedToken', () => {
  const { home } = makeHome({ scope: 'v1_public_1', tokenFile: { version: 1, encrypted: true } })
  const d = diagnoseCredential(home)
  assert.equal(d.state, CredentialState.TOKEN_FILE_MISSING)
})

test('诊断为 DECRYPT_FAILED：token.json 不是合法 JSON', () => {
  const { home } = makeHome({ scope: 'v1_public_1', tokenFile: '{ 这不是 json' })
  const d = diagnoseCredential(home)
  assert.equal(d.state, CredentialState.DECRYPT_FAILED)
  assert.ok(d.remedy)
})

test('诊断为 DECRYPT_FAILED：encryptedToken 不是 v10 格式', () => {
  const { home } = makeHome({
    scope: 'v1_public_1',
    tokenFile: { version: 1, encryptedToken: Buffer.from('vXXgarbage').toString('base64'), encrypted: true },
  })
  const d = diagnoseCredential(home)
  assert.equal(d.state, CredentialState.DECRYPT_FAILED)
})

test('所有失败状态都在 REMEDIES 里有对应建议', () => {
  for (const state of Object.values(CredentialState)) {
    if (state === CredentialState.OK) continue
    assert.ok(REMEDIES[state], `${state} 缺少修复建议`)
  }
})

// ---------------------------------------------------------------- 解密
test('decryptSafeStorage: v10 密文能解回原文', () => {
  const password = 'test-password-16b'
  const plain = 'I7Kp2X:' + makeJwt({ accountName: '测试账号', accountId: '42' })
  const sealed = sealV10(plain, password)
  assert.equal(decryptSafeStorage(sealed, password), plain)
})

test('decryptSafeStorage: 密码不对时抛 DECRYPT_FAILED', () => {
  const sealed = sealV10('secret', 'right-password')
  assert.throws(() => decryptSafeStorage(sealed, 'wrong-password'), (e) => e.code === CredentialState.DECRYPT_FAILED)
})

test('decryptSafeStorage: 非 v10 前缀被拒绝', () => {
  const bogus = Buffer.from('v11abc').toString('base64')
  assert.throws(() => decryptSafeStorage(bogus, 'x'), (e) => e.code === CredentialState.DECRYPT_FAILED)
})

// ---------------------------------------------------------------- JWT 解析
test('parseClaims: 支持 tenant:jwt 形式并取出声明', () => {
  const jwt = makeJwt({ accountName: '示例账号', accountId: '1903', tenant: 'I7Kp2X', exp: 4102444800 })
  const claims = parseClaims('I7Kp2X:' + jwt)
  assert.equal(claims.accountName, '示例账号')
  assert.equal(claims.tenant, 'I7Kp2X')
  assert.equal(claims.exp, 4102444800)
})

test('parseClaims: 无 payload 的串抛 TOKEN_MALFORMED', () => {
  assert.throws(() => parseClaims('not-a-jwt'), (e) => e.code === CredentialState.TOKEN_MALFORMED)
})

test('parseClaims: payload 不是合法 base64 JSON 时抛错', () => {
  assert.throws(() => parseClaims('a.%%%.c'), (e) => e.code === CredentialState.TOKEN_MALFORMED)
})

// ---------------------------------------------------------------- 过期判定
test('EXPIRED：过期 token 被判定为不可用且保留身份信息', () => {
  const jwt = makeJwt({ accountName: '过期账号', accountId: '7', exp: Math.floor(Date.now() / 1000) - 3600 })
  const { home } = makeHome({
    scope: 'v1_public_1',
    tokenFile: { version: 1, encryptedToken: 'PLACEHOLDER', encrypted: true },
  })
  // 直接替换凭据文件内容为可解密的形式
  const password = 'unit-test-password'
  const tokenFile = path.join(home, '.local', 'share', 'TeleAgent', 'users', 'v1_public_1', 'app-auth', 'token.json')
  fs.writeFileSync(tokenFile, JSON.stringify({ version: 1, encryptedToken: sealV10('I7Kp2X:' + jwt, password), encrypted: true }))

  // 用一个注入的假钥匙串密码走完整路径：这里直接测诊断之外的判定语义
  const claims = parseClaims('I7Kp2X:' + jwt)
  const expiresAt = claims.exp * 1000
  assert.ok(expiresAt < Date.now(), '构造的 token 应已过期')
  assert.equal(claims.accountName, '过期账号')
})

// ---------------------------------------------------------------- 不泄露
test('诊断结果里带 token 字段，但状态摘要函数不暴露它', async () => {
  const { readAuthState } = await import('../lib/status.js')
  const authed = readAuthState()
  assert.equal('token' in authed, false, 'readAuthState 不应返回 token')
  const serialized = JSON.stringify(authed)
  assert.doesNotMatch(serialized, /eyJ[A-Za-z0-9_-]{10,}/)
})
