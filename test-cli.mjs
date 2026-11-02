/**
 * CLI 子命令测试。
 *
 * 只测不需要网络与不需要破坏状态的部分：
 *  - `--help` / 未知子命令
 *  - `status --json --no-probe` 的结构（允许上游读取失败，但字段必须齐全）
 *
 * **故意不测 `logout`**：它会真的删除凭据。用 `--help` 覆盖到命令存在即可。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 本文件在仓库根目录（不是 test/ 子目录）
const root = path.dirname(fileURLToPath(import.meta.url))
const bin = path.join(root, 'lib', 'bin.js')

function run(args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [bin, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      ...opts,
    })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
  }
}

test('CLI: --help 退出码 0 且列出三个子命令', () => {
  const r = run(['--help'])
  const { code, stdout } = r
  assert.equal(code, 0, `诊断：code=${code} stderr=${JSON.stringify((r.stderr ?? '').slice(0, 300))} stdout=${JSON.stringify(stdout.slice(0,120))}`)
  for (const cmd of ['status', 'doctor', 'logout']) {
    assert.ok(stdout.includes(cmd), `帮助里缺少 ${cmd}`)
  }
})

test('CLI: 未知子命令退出码 1 并给出提示', () => {
  const { code, stdout, stderr } = run(['bogus'])
  assert.equal(code, 1)
  assert.ok(`${stdout}${stderr}`.includes('未知子命令'))
})

test('CLI: status --json 输出合法 JSON 且字段齐全', () => {
  const { stdout } = run(['status', '--json', '--no-probe'])
  const data = JSON.parse(stdout)
  for (const key of ['account', 'points', 'daily', 'provider', 'accounts']) {
    assert.ok(key in data, `缺少字段 ${key}`)
  }
  assert.equal(typeof data.account.signedIn, 'boolean')
  assert.equal(typeof data.accounts, 'number')
  assert.equal(typeof data.provider.disabled, 'boolean')
})

test('CLI: status --json 不含 token 原文', () => {
  const { stdout } = run(['status', '--json', '--no-probe'])
  assert.doesNotMatch(stdout, /eyJ[A-Za-z0-9_-]{10,}/, '不应输出 JWT')
  assert.doesNotMatch(stdout, /v10[A-Za-z0-9+/=]{20,}/, '不应输出 safeStorage 密文')
})

test('CLI: status --json 的未登录/已登录形态自洽', () => {
  const { stdout } = run(['status', '--json', '--no-probe'])
  const data = JSON.parse(stdout)
  if (data.account.signedIn) {
    assert.ok(data.account.accountName || data.account.detail, '已登录应有账号名或描述')
  } else {
    assert.ok(data.account.detail || data.account.state, '未登录应有原因')
  }
})

test('CLI: logout 在帮助里说明只删凭据', () => {
  const { stdout } = run(['--help'])
  assert.match(stdout, /只删凭据|技能\/记忆不受影响/)
})
