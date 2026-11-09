import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as desktop from '../lib/desktop.js'
import { diagnoseCredential } from '../lib/credential.js'
import { appPaths } from '../lib/models.js'
import { resolveKernelBinary } from '../lib/kernel.js'

test('desktop version check distinguishes missing, unreadable and outdated releases', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-desktop-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const appPath = path.join(dir, 'TeleAgent.exe')
  const check = (version) => desktop.checkDesktopApp({ appPath, readVersion: () => version })

  assert.equal(check('3.0.0').state, 'app_missing')
  fs.writeFileSync(appPath, '')
  for (const [version, expected] of [
    ['invalid', 'app_version_unknown'],
    ['2.7.0', 'app_version_unsupported'],
    ['2.7.1-rc.1', 'app_version_unsupported'],
    ['2.7.1', 'ok'],
    ['2.7.1.0', 'ok'],
    ['2.10.0', 'ok'],
    ['3.0.0', 'ok'],
  ]) {
    assert.equal(check(version).state, expected, version)
  }
  assert.equal(check('2.7.1.0').version, '2.7.1')
  const outdated = check('2.7.0')
  assert.equal(diagnoseCredential(dir, outdated).state, 'app_version_unsupported')
  assert.match(outdated.remedy, /2\.7\.1/)
})

test('Windows uses TeleAgent data overrides and the .exe kernel', () => {
  const home = 'C:\\Users\\Test User'
  const env = { TELEAI_TA_DEVICE_DATA_DIR: 'D:\\TeleAgent\\data', TELEAGENT_CONFIG_DIR: 'D:\\TeleAgent\\config' }
  assert.deepEqual(appPaths(home, { platform: 'win32', env }), {
    home, data: 'D:\\TeleAgent\\data', config: 'D:\\TeleAgent\\config',
  })
  assert.equal(resolveKernelBinary(home, { platform: 'win32', env }), 'D:\\TeleAgent\\data\\runtimes\\super-agent-code\\bin\\TeleAgent.exe')
})

test('Windows discovery checks an actual desktop executable in the NSIS per-user directory', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\Test User\\AppData\\Local' }
  const installed = env.LOCALAPPDATA + '\\Programs\\TeleAgent\\TeleAgent.exe'
  assert.equal(desktop.resolveDesktopApp({ platform: 'win32', env, exists: (file) => file === installed }), installed)
})

test('Windows uses native DPAPI to read TeleAgent credentials and encrypted portal cookies', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const { runPowerShell } = await import('../lib/windows.js')
  const { createCipheriv, createHash } = await import('node:crypto')
  const { DatabaseSync } = await import('node:sqlite')
  const { readPortalAuth } = await import('../lib/portal.js')

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'te-win-dpapi-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const { data } = appPaths(home)
  const scope = 'v1_public_123'
  const auth = path.join(data, 'users', scope, 'app-auth')
  fs.mkdirSync(auth, { recursive: true })

  const key = Buffer.alloc(32, 0x71)
  const wrapped = runPowerShell(`
    Add-Type -AssemblyName System.Security
    $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
    $wrapped = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
    [Convert]::ToBase64String($wrapped)
  `, { input: key.toString('base64') })
  const encryptedKey = Buffer.concat([Buffer.from('DPAPI'), Buffer.from(wrapped, 'base64')]).toString('base64')
  fs.writeFileSync(path.join(data, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: encryptedKey } }))
  fs.writeFileSync(path.join(data, 'current-owner.json'), JSON.stringify({ ownerDir: scope }))

  const encrypt = (value, seed) => {
    const nonce = Buffer.alloc(12, seed)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    return Buffer.concat([Buffer.from('v10'), nonce, cipher.update(value), cipher.final(), cipher.getAuthTag()])
  }
  const claims = Buffer.from(JSON.stringify({ accountName: '测试账号', exp: 4102444800 })).toString('base64url')
  const token = `tenant:a.${claims}.signature`
  fs.writeFileSync(path.join(auth, 'token.json'), JSON.stringify({ encryptedToken: encrypt(token, 1).toString('base64') }))

  const installed = desktop.checkDesktopApp({ appPath: process.execPath })
  assert.equal(installed.ok, true, installed.detail)
  assert.equal(diagnoseCredential(home, installed).accountName, '测试账号')

  const network = path.join(data, 'Partitions', `owner%3A${scope}`, 'Network')
  fs.mkdirSync(network, { recursive: true })
  const db = new DatabaseSync(path.join(network, 'Cookies'))
  try {
    const host = 'agent.teleai.com.cn'
    const cookie = Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from('fixture-portal')])
    db.exec('create table cookies(name text, value text, host_key text, encrypted_value blob)')
    db.prepare('insert into cookies values (?, ?, ?, ?)').run('operationToken', '', host, encrypt(cookie, 2))
  } finally {
    db.close()
  }
  assert.equal(readPortalAuth(home, scope)?.operationToken, 'fixture-portal')
})

test('Windows desktop lifecycle targets only the configured executable', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const { isAppRunning, launchApp, quitApp } = await import('../lib/lifecycle.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-win-lifecycle-'))
  const appPath = path.join(dir, 'TeleAgent.exe')
  const preload = path.join(dir, 'keepalive.cjs')
  fs.copyFileSync(process.execPath, appPath)
  fs.writeFileSync(preload, 'setInterval(() => {}, 1000)')
  const previousApp = process.env.TELEAGENT_APP_PATH
  const previousNodeOptions = process.env.NODE_OPTIONS
  process.env.TELEAGENT_APP_PATH = appPath
  process.env.NODE_OPTIONS = `--require "${preload.replaceAll('\\', '/')}"`
  t.after(async () => {
    if (isAppRunning().length) await quitApp({ timeoutMs: 0 })
    if (previousApp === undefined) delete process.env.TELEAGENT_APP_PATH
    else process.env.TELEAGENT_APP_PATH = previousApp
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = previousNodeOptions
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  })

  assert.deepEqual(isAppRunning(), [])
  const started = await launchApp()
  assert.equal(started.alreadyRunning, false)
  assert.ok(started.pids.length > 0)
  assert.ok(!started.pids.includes(process.pid))
  assert.deepEqual((await quitApp({ timeoutMs: 0 })).remaining, [])
})
