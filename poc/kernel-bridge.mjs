/**
 * TeleAgent kernel bridge — 已验证可用的最小实现（PoC）。
 *
 * 链路：本进程 → (X-SA 签名 HTTP) → 自建 TeleAgent kernel(Go) → TeleAgent 上游网关
 *
 * 关键结论（均经实测）：
 *  1. 登录态：$APP_DATA/users/<scope>/app-auth/token.json，Electron safeStorage(v10)
 *     加密；用 keychain "TeleAgent Safe Storage" 的密码做 PBKDF2-SHA1(saltysalt,1003,16)
 *     + AES-128-CBC(IV=16*0x20) 解出 `<tenant>:<JWT>`。
 *  2. 本地鉴权：kernel 读 env SUPER_AGENT_LOCAL_SESSION_KEY；请求需
 *     X-SA-Sign-Version/X-SA-Timestamp/X-SA-Nonce/X-SA-Signature，
 *     签名 = HMAC-SHA256(sessionKey, ["local-v1", METHOD, path, ts, nonce].join("\n")) → base64url
 *  3. 上游鉴权：kernel 通过 SUPER_AGENT_AUTH_STATE（AES-256-GCM 信封，
 *     key = SHA-256(sessionKey)，payload {token,deviceId,installId}）自行对上游签名；
 *     provider 需 useSuperAgentAuth:true + baseURL + apiKey。
 *  4. kernel 无参数启动，env 通过 stdin 传入：4 字节大端长度 + JSON；日志写文件，
 *     默认监听 8080（可用 XDG_* 隔离数据目录避免与桌面端抢 DB）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execSync } from 'node:child_process'

const HOME = process.env.HOME
const APP_DATA = `${HOME}/.local/share/TeleAgent`
const APP_CONF = `${HOME}/.config/TeleAgent`
const KEYCHAIN_SERVICE = 'TeleAgent Safe Storage'

export const TELEAI_BASE = 'https://agent.teleai.com.cn/superCowork/sapi/api/v1'
import { TELEAI_API_KEY } from '../lib/secrets.js'
export { TELEAI_API_KEY }

/** 读取当前登录 owner 的 scope 目录名（如 v1_public_1903...） */
export function currentScope() {
  const p = path.join(APP_DATA, 'current-owner.json')
  return JSON.parse(fs.readFileSync(p, 'utf8')).ownerDir
}

/** 解密 Electron safeStorage(v10) 加密的 owner token */
export function readOwnerToken(scope = currentScope()) {
  const p = path.join(APP_DATA, 'users', scope, 'app-auth', 'token.json')
  const enc = JSON.parse(fs.readFileSync(p, 'utf8')).encryptedToken
  const raw = Buffer.from(enc, 'base64')
  const pw = execSync(`security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`).toString().trim()
  const key = crypto.pbkdf2Sync(Buffer.from(pw, 'utf8'), 'saltysalt', 1003, 16, 'sha1')
  const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  return Buffer.concat([d.update(raw.subarray(3)), d.final()]).toString('utf8')
}

function envEnvelope(state, sessionKey) {
  const iv = crypto.randomBytes(12)
  const key = crypto.createHash('sha256').update(sessionKey).digest()
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(JSON.stringify(state), 'utf8'), c.final()])
  return { version: 'v1', iv: iv.toString('base64url'), tag: c.getAuthTag().toString('base64url'), ciphertext: ct.toString('base64url') }
}

/** 启动一个自有的 kernel 实例并返回签名客户端 */
export async function startKernel({ port = 0, dataDir, confDir, cacheDir } = {}) {
  const scope = currentScope()
  const token = readOwnerToken(scope)
  const sessionKey = crypto.randomBytes(32).toString('base64url')
  const dev = JSON.parse(fs.readFileSync(path.join(APP_DATA, 'app-auth', 'device-meta.json'), 'utf8'))
  const userConf = JSON.parse(fs.readFileSync(path.join(APP_CONF, 'users', scope, 'TeleAgent.jsonc'), 'utf8'))

  const isolated = path.join(dataDir ?? path.join(HOME, '.dsh-teleagent'), 'kernel')
  fs.mkdirSync(isolated, { recursive: true })

  const env = {
    HOME,
    PATH: process.env.PATH,
    SUPER_AGENT_APP_CONFIG_DIR: confDir ?? APP_CONF,
    SUPER_AGENT_APP_DATA_DIR: dataDir ? path.join(dataDir, 'appdata') : APP_DATA,
    SUPER_AGENT_APP_VERSION: '2.7.1',
    OPENCODE_SERVER_USERNAME: 'super-agent',
    OPENCODE_SERVER_PASSWORD: crypto.randomBytes(24).toString('hex'),
    SUPER_AGENT_LOCAL_SESSION_KEY: sessionKey,
    SUPER_AGENT_AUTH_STATE: JSON.stringify(envEnvelope({ token, deviceId: dev.deviceId, installId: dev.installId }, sessionKey)),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      provider: {
        NewApi: {
          id: 'new-api',
          name: '预置模型',
          options: {
            baseURL: TELEAI_BASE,
            apiKey: TELEAI_API_KEY,
            headers: { 'X-Route-Target': 'ops-gateway' },
            useSuperAgentAuth: true,
            timeout: 20 * 60 * 1000,
            chunkTimeout: 15 * 60 * 1000,
          },
          models: userConf.provider.NewApi.models,
        },
      },
      permission: {},
    }),
    SUPER_AGENT_MODEL_CATALOG: fs.readFileSync(path.join(APP_DATA, 'users', scope, 'model-catalog.json'), 'utf8'),
    XDG_DATA_HOME: dataDir ?? path.join(HOME, '.dsh-teleagent'),
    XDG_CONFIG_HOME: confDir ?? APP_CONF,
    XDG_CACHE_HOME: cacheDir ?? path.join(isolated, 'cache'),
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
  }

  const bin = path.join(APP_DATA, 'runtimes', 'super-agent-code', 'bin', 'TeleAgent')
  const child = spawn(bin, [], { cwd: HOME, stdio: ['pipe', 'ignore', 'ignore'] })
  const payload = Buffer.from(JSON.stringify(env), 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(payload.length, 0)
  child.stdin.end(Buffer.concat([len, payload]))

  const base = `http://127.0.0.1:${port || 8080}`
  const sign = (method, p) => {
    const ts = String(Date.now())
    const nonce = crypto.randomBytes(12).toString('hex')
    const msg = ['local-v1', method.toUpperCase(), p, ts, nonce].join('\n')
    return {
      'X-SA-Sign-Version': 'local-v1',
      'X-SA-Timestamp': ts,
      'X-SA-Nonce': nonce,
      'X-SA-Signature': crypto.createHmac('sha256', Buffer.from(sessionKey, 'utf8')).update(msg).digest('base64url'),
      'Content-Type': 'application/json',
    }
  }
  const request = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: sign(method, p), body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, json: await r.json().catch(() => null) }
  }
  return { child, request, sessionKey, scope, base }
}

/** 等待 kernel 就绪（/global/health） */
export async function waitReady(kb, timeoutMs = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await kb.request('GET', '/global/health')
      if (r.status === 200) return true
    } catch { /* 未监听 */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

/** 发一条消息，返回助手文本 */
export async function chat(kb, { modelID = 'chat-flash', text, sessionID, providerID = 'NewApi' }) {
  let sid = sessionID
  if (!sid) {
    const s = await kb.request('POST', '/session', { title: 'dsh' })
    sid = s.json?.id
    if (!sid) throw new Error(`create session failed: ${s.status} ${JSON.stringify(s.json).slice(0, 200)}`)
  }
  const r = await kb.request('POST', `/session/${sid}/message`, {
    model: { providerID, modelID },
    parts: [{ type: 'text', text }],
  })
  const info = r.json?.data?.info
  if (info?.error) throw new Error(`upstream: ${JSON.stringify(info.error).slice(0, 300)}`)
  const parts = r.json?.data?.parts ?? []
  return { sessionID: sid, text: parts.filter((p) => p.type === 'text').map((p) => p.text).join(''), info }
}

export const MODELS = {
  'chat-pro': { name: '智能', context: 400000, output: 65536 },
  'chat-flagship': { name: '旗舰', context: 400000, output: 65536 },
  'chat-flash': { name: '极速', context: 400000, output: 65536 },
  'chat-lite': { name: '轻量', context: 100000, output: 16384 },
  'chat-nano': { name: '轻速', context: 100000, output: 16384 },
}

// 直接运行时自检
if (process.argv[1] && process.argv[1].endsWith('kernel-bridge.mjs')) {
  const kb = await startKernel()
  if (!(await waitReady(kb))) { console.error('kernel not ready'); kb.child.kill(); process.exit(1) }
  const out = await chat(kb, { text: '只回复两个字：你好' })
  console.log('reply:', out.text)
  console.log('tokens:', JSON.stringify(out.info.tokens))
  kb.child.kill('SIGTERM')
}
