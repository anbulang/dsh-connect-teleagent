/**
 * TeleAgent kernel 传输层。
 *
 * 为什么用 kernel 而不是直连上游：直连需要自己复刻上游签名，流量形态与客户端不同，
 * 三个账号因此被封（见 AGENTS.md）。kernel 是 TeleAgent 自己的 Go 程序，
 * 由它解密登录态、自己加签、自己发请求 —— 我们只驱动它，流量就是原生流量。
 *
 * ## 已验证的 kernel 协议（来自早期会话的实测结论，本次沿用）
 *
 * - kernel 进程**无参数启动**，环境变量走 **stdin：4 字节大端长度 + JSON**
 * - 本地 API 需要签名头：`HMAC-SHA256(sessionKey, "local-v1\nMETHOD\npath\nts\nnonce")`
 * - 存活探测：`GET /global/health`
 * - 建会话：`POST /session` → `{ id }`
 * - 发消息：`POST /session/:id/prompt_async` → 204，输出走 `GET /event`（SSE）
 * - 事件 `message.part.updated`：`part.text` 是**累积全文**（要自己转增量）
 * - 事件 `session.status { type: 'idle' }`：本轮结束
 * - 同一 session 再 prompt 会自动带上历史 → 多轮由 kernel 负责
 *
 * ## 对外接口
 *
 * `createKernelTransport()` 返回的对象与 `upstream.createUpstream()` **同形**：
 * `{ auth, url, chat(body), chatStream(body, signal) }`。
 * 这样 shim / provider / 卡片 / 积分 / CLI 全都不用改，只换传输。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFileSync } from 'node:child_process'

import net from 'node:net'
import { appPaths, currentScope, MODELS } from './models.js'
import { callsToOpenAiToolCalls } from './mcp-bridge.js'
import { filterTools, estimatePrompt } from './tools-filter.js'
import { bootlog } from './bootlog.js'
import { readUpstreamAuth } from './upstream.js'
import { TELEAI_API_KEY } from './secrets.js'

const KEYCHAIN_SERVICE = 'TeleAgent Safe Storage'
/** 上游网关基址（与桌面端常量一致；真实值来自客户端配置，这里是兜底） */
export const DEFAULT_GATEWAY_BASE = 'https://agent.teleai.com.cn/superCowork/sapi'
export const DEFAULT_GATEWAY_KEY = TELEAI_API_KEY

/**
 * kernel 侧有执行器的全部工具。
 *
 * 清单来自对二进制的枚举 + 内核日志里实际出现过的调用
 * （`memory_get` / `memory_search` / `question` 就是这么发现的——
 * 早期只 deny 了 bash/read/write 那几个，结果内核照样查记忆、还会反问用户）。
 *
 * 默认**全部 deny**：kernel 是 agent 运行时，不是纯对话模型。
 * 让它执行工具会把文件改到它自己的沙箱里，还会在对话里插入工具调用噪音。
 */
/**
 * 官方客户端的默认禁用表（抄自 Electron 的 `GLOBAL_DISABLED_TOOLS_PERMISSION`）。
 *
 * 不套用会让发出去的 tools 列表变长（实测 27 个 vs 客户端 21 个），属于可识别差异。
 */
export const CLIENT_DISABLED_TOOLS = {
  // 客户端发出去的 21 个工具里不含这几个文件类工具（实测差集）
  read: 'deny',
  write: 'deny',
  edit: 'deny',
  multiedit: 'deny',
  glob: 'deny',
  grep: 'deny',
  coze_search: 'deny',
  arxiv_search: 'deny',
  websearch: 'deny',
  codesearch: 'deny',
  baidu_search: 'deny',
  image_read: 'deny',
}

export const KERNEL_TOOLS = [
  // 文件与命令
  'bash', 'read', 'write', 'edit', 'multiedit', 'patch', 'apply_patch', 'glob', 'grep', 'list',
  // 待办
  'todowrite', 'todoread',
  // 联网
  'webfetch', 'websearch', 'online_search', 'baidu_search', 'arxiv_search', 'codesearch', 'coze_search',
  // 记忆（这三个最容易在对话里"自作主张"）
  'memory_get', 'memory_search', 'memory_write', 'memory_delete',
  // 交互（会阻塞等用户回答，在 DSH 里表现为"卡住"）
  'question',
  // 其它
  'skill', 'task', 'lsp', 'image_read', 'imagegen',
]

/**
 * 构造 kernel 的 permission 配置。
 *
 * 语义：未列出的工具默认 allow，这里反过来 —— 只 allow 白名单，其余显式 deny。
 * 默认传空 = **全部 deny**：kernel 不该替 DSH 执行工具（会把文件改到它的沙箱里）。
 */
export function buildPermission(allowedTools = []) {
  const allow = new Set(Array.isArray(allowedTools) ? allowedTools : [])
  const permission = {}
  for (const tool of KERNEL_TOOLS) {
    permission[tool] = allow.has(tool) ? 'allow' : 'deny'
  }
  // keras 的联网类工具一律关掉：DSH 有自己的 web 工具，重复执行既花钱又不可控
  for (const tool of ['websearch', 'online_search', 'baidu_search', 'arxiv_search', 'codesearch', 'coze_search', 'image_read']) {
    permission[tool] = allow.has(tool) ? 'allow' : 'deny'
  }
  return permission
}

/**
 * 找一个空闲端口。
 *
 * 之前固定用 47823：DSH 重启后，上一个内核若变成孤儿进程还占着这个端口，
 * 新内核就绑不上 —— 表现为"插件明显有问题"但日志里看不到明显错误。
 */
export async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** kernel 可执行文件路径 */
export function resolveKernelBinary(home = process.env.HOME) {
  const { data } = appPaths(home)
  return path.join(data, 'runtimes', 'super-agent-code', 'bin', 'TeleAgent')
}

/** 读取设备指纹（kernel 需要） */
function readDeviceMeta(home) {
  const { data } = appPaths(home)
  const file = path.join(data, 'app-auth', 'device-meta.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * 读账号自己的 provider 配置（`~/.config/TeleAgent/users/<scope>/TeleAgent.jsonc`）。
 *
 * 这是客户端真正在用的配置：provider 名、models（含 id/limit/options）都在里面。
 * 自己拼一份"看起来一样"的 provider 是不行的——内核会因为 schema 对不上
 * 报 `provider "NewApi" not found`（已实测）。
 */
export function readAccountProvider(home, scope) {
  const { config } = appPaths(home)
  const file = path.join(config, 'users', scope, 'TeleAgent.jsonc')
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const provider = parsed?.provider?.NewApi
    if (provider && typeof provider === 'object') {
      return {
        provider,
        // 客户端自己声明的模型清单（真实目录）
        models: provider.models ?? null,
        permission: parsed?.permission ?? null,
      }
    }
  } catch { /* 没有配置就用兜底 */ }
  return null
}

/** 用 authState 加密登录态（AES-256-GCM，key = SHA-256(sessionKey)） */
export function sealAuthState(state, sessionKey) {
  const iv = crypto.randomBytes(12)
  const key = crypto.createHash('sha256').update(sessionKey).digest()
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()])
  return {
    version: 'v1',
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  }
}

/** 内核 pidfile 路径（用于跨 DSH 重启找回上一条内核） */
export function kernelPidFile(runtimeDir) {
  return path.join(runtimeDir, 'kernel.pid')
}

/**
 * 读取一个进程的「启动标识」—— 用来判断 pid 有没有被系统复用。
 *
 * 为什么需要它：pid 只是编号，进程退出后系统会把它**复用**给新进程。
 * 只靠 `pid 还活着` 判断「上个宿主还在」，会在复用发生时得出完全相反的结论：
 * 上个宿主早已崩溃，但它留下的内核因为 pid 撞上了一个无关的活进程而被跳过，
 * 于是永远没人给它发信号，DSH 退出后内核继续空转（无人值守的真实流量）。
 *
 * 平台能力：
 *  - Linux：`/proc/<pid>/stat` 第 22 字段 `starttime`（自 boot 起的 clock ticks），
 *    与 locale / 时区无关，进程一生不变，最可靠。
 *  - macOS 及其它 POSIX：`ps -p <pid> -o lstart=`（精确到秒的开始时刻）。
 *    用 lstart 而不是 etime —— etime 每秒都在涨，不能当身份。
 *    子进程固定 `LC_ALL=C` + `TZ=UTC`，避免换了 locale 或时区后同一进程算出不同字符串。
 *  - 其它平台（如 Windows 没有 ps）：返回 null = **显式降级**。
 *    调用方必须把 null 当作「无法校验」，退回只比 pid 的老逻辑，
 *    绝不能当成「身份不符」——那会误杀另一个 DSH 正在用的内核
 *    （曾导致正在进行的对话 terminated）。
 *
 * @param {number} pid
 * @returns {string|null} 稳定的身份字符串；取不到时 null
 */
export function processStartToken(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null

  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      // comm(第 2 字段) 可能是带空格/括号的路径，从**最后一个** ')' 之后开始切
      const cut = stat.lastIndexOf(')')
      if (cut > 0) {
        // 去掉 pid(1)、comm(2) 后，starttime 是第 22 字段 → 数组下标 19
        const starttime = stat.slice(cut + 2).split(' ')[19]
        if (/^\d+$/.test(starttime ?? '')) return `linux-starttime:${starttime}`
      }
    } catch { /* 进程不存在或 /proc 不可读 → 继续试 ps */ }
  }

  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }).trim()
    if (out !== '') return `ps-lstart:${out}`
  } catch { /* 没有 ps（Windows）或进程已退出 */ }

  return null
}

/**
 * 处理"上一次 DSH 退出没来得及收尾"的内核。
 *
 * 背景（实测）：DSH 退出时不一定执行插件 dispose，于是内核变成孤儿（ppid=1），
 * 而且**还会继续跑上一轮**——实测 22:56:57 退出后，孤儿内核把挂起的工具调用
 * 判错、接着调模型、执行内置 bash，22:57:45 才结束，属于无人值守的真实流量。
 *
 * 新内核启动前先把这些孤儿收掉；有 pidfile 就按 pidfile，没有就按
 * 「可执行文件匹配 + ppid=1」扫描。SIGTERM 不行再 SIGKILL。
 */
export async function reapStaleKernels({ home = process.env.HOME, runtimeDir, logger, binary, listProcesses = listSystemProcesses, killProcess, isAlive, readStartToken = processStartToken, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const bin = binary ?? resolveKernelBinary(home)
  const dir = runtimeDir ?? path.join(home, '.dsh-teleagent-kernel')
  const pidFile = kernelPidFile(dir)
  const targets = new Set()
  /** 认出来「还归别的活宿主所有」的 pid —— 这些**绝不能杀** */
  const skipped = []
  const errors = []

  const alive = isAlive ?? ((pid) => {
    try { process.kill(pid, 0); return true } catch { return false }
  })

  // 进程表：用来判断某个内核的父进程（宿主）是不是还活着。
  // 只靠 pidfile 无法区分「遗留内核」和「另一个 DSH 实例正在用的内核」，
  // 见下面 pidfile 分支的注释。
  let rows = []
  if (typeof listProcesses === 'function') {
    try {
      rows = listProcesses() ?? []
    } catch (error) {
      errors.push(String(error?.message ?? error))
    }
  }
  const ppidOf = new Map()
  for (const row of rows) {
    if (!row || typeof row.pid !== 'number') continue
    ppidOf.set(row.pid, row.ppid)
  }

  /**
   * 这个内核是否挂在「另一个仍然活着的宿主」下。
   *
   * 判定：父进程存在、不是 init(1)、不是本进程，且仍然存活。
   * 命中就说明有别的 DSH（或别的进程）正拿它干活，属于**别人的活内核**。
   */
  function belongsToAnotherLiveHost(pid) {
    const ppid = ppidOf.get(pid)
    if (typeof ppid !== 'number' || ppid <= 1 || ppid === process.pid) return false
    return alive(ppid)
  }

  // pidfile：只有「记下的宿主已经不在了」时，才把它当遗留内核清理。
  //
  // 以前这里无条件杀 pidfile 里的 pid，结果是：跑测试/doctor（它们也走
  // startKernel，会覆盖同一个 pidfile）之后，DSH 正在用的内核被别的进程杀掉，
  // 正在进行的对话当场 `terminated`（TRANSPORT）并重试 5 次。
  //
  // 现在还必须校验宿主**身份**，不能只看 pid 活着：pid 会被系统复用，
  // 上个宿主崩了、pid 恰好被无关进程占用时，只看存活会把它误判成
  // 「另一个活宿主」，于是孤儿内核被 skip → 后面的 filter 又排除 skipped →
  // 永不发信号，DSH 退出后内核继续空转。
  try {
    const raw = fs.readFileSync(pidFile, 'utf8')
    const rec = JSON.parse(raw)
    const pid = rec?.pid
    if (typeof pid === 'number' && pid > 0 && pid !== process.pid) {
      const hostPid = typeof rec?.hostPid === 'number' ? rec.hostPid : null
      // 记下宿主身份时才校验；老 pidfile 没有 hostStartToken → hostTokenMatches 为 null（未知）
      const hostStartToken = typeof rec?.hostStartToken === 'string' && rec.hostStartToken !== ''
        ? rec.hostStartToken
        : null
      const hostTokenMatches = hostStartToken === null || hostPid === null
        ? null
        : (() => {
            let current = null
            try { current = readStartToken(hostPid) } catch { current = null }
            // 取不到当前身份（平台不支持 / 权限不足）→ 未知，退回只比 pid
            if (current === null || current === undefined) return null
            return current === hostStartToken
          })()

      if (hostPid !== null && hostPid !== process.pid && hostPid > 0 && alive(hostPid)) {
        // 内核自己被 reparent 成了 init 的子进程，说明拉起它的父进程早就不在了。
        // 记下的 hostPid 却"活着" → 那个 pid 一定被复用给了无关进程。
        // 这条判断不需要任何平台能力，用来兜住**老格式 pidfile**（没有 hostStartToken）。
        const kernelReparented = ppidOf.get(pid) === 1
        const hostStale = hostTokenMatches === false || (hostTokenMatches === null && kernelReparented)

        if (hostStale) {
          targets.add(pid)
          errors.push(`宿主 pid ${hostPid} 已被复用（身份不符或内核已成孤儿），按遗留内核处理`)
        } else {
          // 另一个活着的宿主（例如第二个 DSH 实例）仍在使用它；身份未知时也保守跳过
          skipped.push({ pid, reason: 'host-alive', hostPid, ...(hostTokenMatches === null ? { hostIdentity: 'unknown' } : {}) })
        }
      } else if (belongsToAnotherLiveHost(pid)) {
        // 老格式 pidfile（没有 hostPid）：退回看父进程
        skipped.push({ pid, reason: 'ppid-alive' })
      } else {
        targets.add(pid)
      }
    }
  } catch { /* 没有 pidfile */ }

  // 兜底扫描：可执行文件匹配本插件内核、且已被 reparent 成 ppid=1 的孤儿
  for (const row of rows) {
    if (!row || row.pid === process.pid) continue
    if (row.ppid !== 1) continue
    if (typeof row.command !== 'string' || !row.command.includes(bin)) continue
    targets.add(row.pid)
  }

  const killed = []
  const list = [...targets].filter((pid) => pid !== process.pid && alive(pid) && !skipped.some((s) => s.pid === pid))
  for (const pid of list) {
    try {
      killProcess ? killProcess(pid, 'SIGTERM') : process.kill(pid, 'SIGTERM')
      killed.push(pid)
    } catch { /* ignore */ }
  }
  if (list.length > 0) {
    // 给内核留点时间优雅退出
    for (let i = 0; i < 8; i += 1) { await wait(150) }
    for (const pid of list) {
      try {
        if (!alive(pid)) continue
        killProcess ? killProcess(pid, 'SIGKILL') : process.kill(pid, 'SIGKILL')
        logger?.warn?.('dsh-connect-teleagent: 清理孤儿内核（SIGKILL）', { pid })
      } catch { /* ignore */ }
    }
  }
  // pidfile 只在「里面的内核已经被处理掉」时才删；若跳过的是别人正在用的内核，
  // 删掉 pidfile 会让那个宿主失去追踪能力，所以保留。
  if (skipped.length === 0) {
    try { fs.rmSync(pidFile, { force: true }) } catch { /* ignore */ }
  }
  if (killed.length > 0) logger?.info?.('dsh-connect-teleagent: 已清理上一次遗留的内核', { pids: killed })
  if (skipped.length > 0) {
    logger?.info?.('dsh-connect-teleagent: 保留其他宿主正在使用的内核', { skipped })
  }
  return { killed, skipped, errors }
}

/**
 * 列出系统进程（供 reapStaleKernels 使用；抽出来方便测试）。
 * @returns {{pid:number,ppid:number,command:string}[]}
 */
export function listSystemProcesses() {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    return out.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      if (!m) return null
      return { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }
    }).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 拉起一个属于本插件的 kernel 实例。
 *
 * 用独立的 XDG 目录（`~/.dsh-teleagent-kernel/`），不碰桌面端的数据目录，
 * 否则会抢 SQLite 锁 / 端口 / 单例锁。
 */
export async function startKernel(options = {}) {
  const home = options.home ?? process.env.HOME
  // 注意：appPaths 的字段名是 `config`，不是 `conf`。
  // 写成 conf 会得到 undefined，JSON.stringify 直接丢掉该键，
  // 内核就会报 missing required path environment variables。
  const { data: appData, config: appConf } = appPaths(home)
  const scope = currentScope(appData)

  // 登录态来自我们自己的解密路径（与直连模式共用，避免两套凭据逻辑）
  const auth = readUpstreamAuth(home)
  const sessionKey = crypto.randomBytes(32).toString('base64url')
  const device = readDeviceMeta(home)

  const runtimeDir = options.runtimeDir ?? path.join(home, '.dsh-teleagent-kernel')
  fs.mkdirSync(runtimeDir, { recursive: true })

  const binary = options.binary ?? resolveKernelBinary(home)
  if (!fs.existsSync(binary)) {
    throw new Error(`找不到 TeleAgent kernel：${binary}（请先安装并至少启动一次 TeleAgent 桌面端）`)
  }

  const account = readAccountProvider(home, scope)
  // 内核内置了 NewApi 这个 provider 的定义（baseURL/鉴权方式都在二进制里），
  // 配置里只需要给它 models。自己拼 options 会被判成"provider not found"（已实测）。
  const models = account?.models ?? Object.fromEntries(MODELS.map((m) => [m.id, {
    id: m.id,
    name: m.name,
    limit: { context: m.contextWindow, input: m.contextWindow, output: m.maxTokens },
  }]))

  const port = options.port
    ?? (process.env.TELEAGENT_KERNEL_PORT ? Number(process.env.TELEAGENT_KERNEL_PORT) : await pickFreePort())
  const env = {
    HOME: home,
    // 内核的监听端口由这个变量决定（Electron 侧就是这么传的）；不传它内核不会监听
    SERVER_PORT: String(port),
    PATH: process.env.PATH,
    SUPER_AGENT_APP_CONFIG_DIR: appConf,
    SUPER_AGENT_APP_DATA_DIR: appData,
    SUPER_AGENT_APP_VERSION: options.appVersion ?? auth.appVersion ?? '2.7.1',
    // 客户端用它往网关发 X-TeleAI-Client-Type（usage 归因）；不传就没有这个头，是明显差异
    OPENCODE_CLIENT: options.clientType ?? 'desktop',
    SUPER_AGENT_SERVER_URL: options.serverURL ?? 'https://agent.teleai.com.cn',
    OPENCODE_SERVER_USERNAME: 'super-agent',
    OPENCODE_SERVER_PASSWORD: crypto.randomBytes(24).toString('hex'),
    SUPER_AGENT_LOCAL_SESSION_KEY: sessionKey,
    SUPER_AGENT_AUTH_STATE: JSON.stringify(sealAuthState({
      token: auth.token,
      deviceId: auth.deviceId ?? device.deviceId,
      installId: auth.installId ?? device.installId,
    }, sessionKey)),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      provider: {
        NewApi: {
          // 这一段必须自备：内核内置的 provider 定义只认 id/options，
          // 缺 options.baseURL 会报 "compat(NewApi): baseURL is required"（已实测）。
          // 结构取自桌面端 defaultProvider 原文。
          id: 'new-api',
          name: '预置模型',
          options: {
            baseURL: options.baseURL ?? DEFAULT_GATEWAY_BASE + '/api/v1',
            apiKey: options.apiKey ?? DEFAULT_GATEWAY_KEY,
            headers: { 'X-Route-Target': 'ops-gateway' },
            useSuperAgentAuth: true,
            timeout: 20 * 60 * 1000,
            chunkTimeout: 15 * 60 * 1000,
          },
          // 账号配置里的 models / blacklist 覆盖上面
          ...(account?.provider ?? {}),
          models,
        },
      },
      // 工具默认全部禁止：kernel 不该替 DSH 执行（会把文件改到它的沙箱里）
      // 默认沿用账号自己的权限配置（= 客户端行为）。只有显式要求时才追加 deny：
      // 加 deny 会让发出去的 tools 列表变短（实测 21 → 11），属于可识别差异。
      // 顺序：客户端默认禁用表 → 账号自己的配置（覆盖前者）→ 显式 deny（可选）
      permission: options.denyBuiltinTools === true
        ? { ...CLIENT_DISABLED_TOOLS, ...(account?.permission ?? {}), ...buildPermission(options.allowedTools ?? []) }
        : { ...CLIENT_DISABLED_TOOLS, ...(account?.permission ?? {}) },
      enabled_providers: ['NewApi'],
    }),
    XDG_DATA_HOME: options.xdgData ?? path.join(runtimeDir, 'data'),
    XDG_CONFIG_HOME: options.xdgConfig ?? path.join(runtimeDir, 'config'),
    XDG_CACHE_HOME: options.xdgCache ?? path.join(runtimeDir, 'cache'),
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
  }

  // 两路都给：stdin 的 4 字节长度 + JSON 是 Electron 的做法，
  // 但实测本机内核只认 spawn 的 env（stdin 那份没被采纳，会报
  // "missing required path environment variables"）。所以两边都传。
  const child = spawn(binary, [], {
    cwd: home,
    stdio: ['pipe', 'ignore', 'pipe'],
    detached: false,
    env: { ...process.env, ...env },
  })
  const payload = Buffer.from(JSON.stringify(env), 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(payload.length, 0)
  child.stdin.end(Buffer.concat([len, payload]))

  const logLines = []
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk)
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      logLines.push(line)
      if (logLines.length > 200) logLines.shift()
    }
  })

  const base = `http://127.0.0.1:${port}`

  // 记下 pid：DSH 退出没 dispose 时，下一次启动能找回并清理它。
  //
  // `hostPid` 是**拉起它的宿主进程**（DSH 主进程，或跑测试/doctor 的 node）。
  // 没有它的话，下一次启动无法区分「遗留内核」和「另一个 DSH 正在用的内核」——
  // 曾经因此误杀活内核，导致正在进行的对话 `terminated` 并重试 5 次。
  //
  // `hostStartToken` 是宿主进程的启动标识。**光有 hostPid 不够**：pid 会被系统
  // 复用，上个宿主崩溃后 pid 被无关进程占用时，"宿主还活着"是假象，孤儿内核
  // 于是永远清不掉。下次启动时校验身份，不符就按遗留内核处理。
  // 取不到身份（平台不支持）时写 null，读取侧会退回只比 pid。
  try {
    fs.mkdirSync(runtimeDir, { recursive: true })
    let hostStartToken = null
    try { hostStartToken = processStartToken(process.pid) } catch { hostStartToken = null }
    fs.writeFileSync(kernelPidFile(runtimeDir), JSON.stringify({
      pid: child.pid,
      hostPid: process.pid,
      hostStartToken,
      port,
      base,
      startedAt: Date.now(),
    }))
  } catch { /* pidfile 写不了不影响启动 */ }

  /** 本地 API 签名头 */
  const authHeaders = (method, p) => {
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

  const request = async (method, p, body, { timeoutMs = 15 * 60 * 1000 } = {}) => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    timer.unref?.()
    try {
      const res = await fetch(base + p, {
        method,
        headers: authHeaders(method, p),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      })
      const text = await res.text()
      let json = null
      try { json = JSON.parse(text) } catch { /* 非 JSON */ }
      return { status: res.status, json, text }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    base,
    scope,
    child,
    authHeaders,
    request,
    /** 最近的 stderr（诊断用） */
    logs: () => logLines.slice(-50),
    stop() {
      try { child.kill('SIGTERM') } catch { /* 已退出 */ }
      try {
        const rec = JSON.parse(fs.readFileSync(kernelPidFile(runtimeDir), 'utf8'))
        if (rec?.pid === child.pid) fs.rmSync(kernelPidFile(runtimeDir), { force: true })
      } catch { /* ignore */ }
    },
  }
}

/** 等待 kernel 就绪（`GET /global/health`） */
export async function waitReady(kernel, timeoutMs = 60_000) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await kernel.request('GET', '/global/health', undefined, { timeoutMs: 3000 })
      if (res.status === 200) return true
      lastError = new Error(`health ${res.status}: ${String(res.text).slice(0, 120)}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`TeleAgent kernel 未就绪：${lastError?.message ?? 'timeout'}`)
}

// ---------------------------------------------------------------- 会话映射

/** DSH 会话 → kernel session（进程内，带 TTL） */
export class SessionStore {
  #byKey = new Map()
  #ttlMs

  constructor({ ttlMs = 6 * 60 * 60 * 1000 } = {}) {
    this.#ttlMs = ttlMs
  }

  get(key) {
    const rec = this.#byKey.get(key)
    if (!rec) return undefined
    if (Date.now() - rec.usedAt > this.#ttlMs) {
      this.#byKey.delete(key)
      return undefined
    }
    rec.usedAt = Date.now()
    return rec
  }

  set(key, value) {
    this.#byKey.set(key, { ...value, usedAt: Date.now() })
  }

  delete(key) {
    this.#byKey.delete(key)
  }

  sweep() {
    const now = Date.now()
    for (const [key, rec] of this.#byKey) {
      if (now - rec.usedAt > this.#ttlMs) this.#byKey.delete(key)
    }
  }
}

/** 文本化（兼容 string / 数组内容） */
export function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).filter(Boolean).join('\n')
}

/**
 * 对话指纹：DSH 每次都发完整历史，用「首条用户消息」定位同一会话。
 * 有显式会话标识（`user` / `conversation_id` / `session_id`）时优先用。
 */
export function conversationKey(body, messages = []) {
  const explicit = body?.user ?? body?.conversation_id ?? body?.session_id
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const firstUser = messages.find((m) => m.role === 'user')
  const hash = crypto.createHash('sha1').update(contentToText(firstUser?.content ?? '').slice(0, 400)).digest('hex').slice(0, 16)
  return `auto-${hash}`
}

/**
 * 本轮该发什么文本。
 *
 * 首次：system 作为前缀 + 全部非 system/tool 消息折叠。
 * 后续：只发**新增**的消息（kernel 自己保存历史）。
 */
export function planTurn(history, messages = []) {
  const sys = messages.filter((m) => m.role === 'system').map((m) => contentToText(m.content))
  const users = messages.filter((m) => m.role === 'user')
  const toolResults = messages.filter((m) => m.role === 'tool')

  if (!history) {
    const convo = messages.filter((m) => m.role === 'user' || m.role === 'assistant')
    const body = convo.map((m) => `${m.role === 'assistant' ? '助手' : '用户'}：${contentToText(m.content)}`).join('\n')
    return {
      text: (sys.length > 0 ? `${sys.join('\n')}\n\n` : '') + body,
      seenUserCount: users.length,
      seenToolCount: toolResults.length,
    }
  }

  // 助手消息**永远不重发**：那是 kernel 自己的输出，它已经存在会话里了。
  // 之前按"非 system 消息数"计数，会把上一轮助手回复当成新内容又发一遍。
  const freshUsers = users.slice(history.seenUserCount ?? 0)
  const freshTools = toolResults.slice(history.seenToolCount ?? 0)
  const chunks = [
    ...freshUsers.map((m) => contentToText(m.content)),
    ...freshTools.map((m) => `【工具结果】\n${contentToText(m.content)}`),
  ]

  if (chunks.length === 0) {
    const last = users[users.length - 1]
    return {
      text: contentToText(last?.content ?? ''),
      seenUserCount: users.length,
      seenToolCount: toolResults.length,
    }
  }

  return {
    text: chunks.join('\n'),
    seenUserCount: users.length,
    seenToolCount: toolResults.length,
  }
}

/** 把 OpenAI 的图片 part 落成临时文件（kernel 的 file part 需要可读路径） */
export function materializeImages(messages = [], dir) {
  const files = []
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part?.type !== 'image_url') continue
      const url = part.image_url?.url ?? part.imageUrl
      if (typeof url !== 'string') continue
      const match = /^data:([^;]+);base64,(.+)$/.exec(url)
      if (!match) continue
      try {
        fs.mkdirSync(dir, { recursive: true })
        const ext = match[1].includes('png') ? 'png' : match[1].includes('jpeg') ? 'jpg' : 'bin'
        const bytes = Buffer.from(match[2], 'base64')
        if (bytes.length === 0) continue   // "data:...;base64,!!!" 这类坏数据不要落盘
        const file = path.join(dir, `img-${crypto.randomUUID()}.${ext}`)
        fs.writeFileSync(file, bytes)
        files.push({ mime: match[1], file })
      } catch { /* 单张失败不影响整体 */ }
    }
  }
  return files
}

// ---------------------------------------------------------------- 事件流

/** 打开 kernel 事件流（SSE） */
export async function openEventStream(kernel, { signal } = {}) {
  const ac = new AbortController()
  if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true })
  const res = await fetch(`${kernel.base}/event`, {
    headers: kernel.authHeaders('GET', '/event'),
    signal: ac.signal,
  })
  if (!res.ok) throw new Error(`kernel /event 失败：${res.status}`)
  return { res, abort() { try { ac.abort() } catch { /* ignore */ } } }
}

/**
 * 发一轮 prompt 并流式消费事件。
 *
 * @param {object} args
 * @param {(delta:string, full:string)=>void} [args.onDelta]
 * @returns {Promise<{text:string, tokens?:object, toolParts:any[]}>}
 */
/**
 * 把内核 message.updated 里的 error 归一成可读文案与业务码。
 *
 * 上游 402 的形状：
 *   {name:'APIError', data:{message:'Payment Required', statusCode:402,
 *    responseBody:'{"code":5005,"resultMsg":"用户额度不足","resultData":null}', responseCode:5005}}
 * 直接把 message 抛出去，宿主只会显示 “Payment Required”，也无法识别为额度问题。
 *
 * 内容审核（`finish_reason: sensitive`）是另一类：内核直接中断本轮，
 * 只给一句「内容包含敏感信息，已被中断」，没有任何业务码 —— 宿主无从分类。
 *
 * @param {any} payload 内核错误载荷
 * @returns {{message:string, code?:number, status?:number, quota:boolean, sensitive:boolean, detail?:string}}
 */
export function normalizeUpstreamFailure(payload) {
  const data = payload?.data ?? payload ?? {}
  const rawMessage = typeof data?.message === 'string'
    ? data.message
    // 内核有几种形状：`{error:{message}}`、`{error:{data:{message}}}`、`{name}`。
    // 只读 `data.message` 会漏掉前两种 —— 审核断言就走这条分支。
    : (typeof payload?.error?.message === 'string'
      ? payload.error.message
      : (typeof payload?.error?.data?.message === 'string'
        ? payload.error.data.message
        : (payload?.name ?? '')))
  let detail
  const body = data?.responseBody ?? data?.body
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body)
      detail = parsed?.resultMsg ?? parsed?.message ?? parsed?.data?.message
    } catch { /* 非 JSON 响应体忽略 */ }
  }
  const status = typeof data?.statusCode === 'number' ? data.statusCode : undefined
  const code = data?.responseCode ?? data?.code
  const text = [rawMessage, detail, typeof code === 'string' ? code : ''].filter(Boolean).join(' ')
  const quota = /insufficient[\s_-]+(?:quota|balance|credits?)|out[\s_-]+of[\s_-]+credits?|额度不足|余额不足|配额不足/i.test(text)
  // 内核侧 finish_reason=sensitive → `sensitive content detected`；
  // 中文文案「内容包含敏感信息，已被中断」是它对外暴露的那一句
  const sensitive = /sensitive[\s_-]*content|content[\s_-]*sensitive|finish_reason["'\s:=]*sensitive|敏感信息|敏感内容|内容违规/i.test(text)
  return {
    message: quota
      ? `insufficient quota: ${detail ?? rawMessage}${status === undefined ? '' : ` (HTTP ${status}${code === undefined ? '' : `/${code}`})`}`
      : `上游错误：${detail ?? (rawMessage || JSON.stringify(payload).slice(0, 200))}`,
    code: typeof code === 'number' ? code : undefined,
    status,
    quota,
    sensitive,
    detail,
  }
}

/**
 * 只消费 /event 事件流（不发 prompt）。
 *
 * 用途有两个：
 *  1. 正常一轮：先开流、再 prompt_async（避免漏掉开头的 part）
 *  2. **续跑**：DSH 送来工具结果后，放行挂起的 MCP 调用，然后接着读同一条流
 */
export async function consumeEvents({ kernel, sessionID, onDelta, onReasoningDelta, signal, deadlineMs = 20 * 60 * 1000, callWatcher, onReady, text: sentText }) {
  const stream = await openEventStream(kernel, { signal })
  const reader = stream.res.body.getReader()
  const decoder = new TextDecoder()

  if (typeof onReady === 'function') {
    // 续跑：先开好流，再放行挂起的调用
    await onReady()
  }

  let buf = ''
  let assistantMessageID = null
  let currentMessageID = null
  const textsByMessage = new Map()
  /** 思维链：按 part.id 记累积文本（part.text 是累积全文），避免多段 reasoning 串味 */
  const reasoningByPart = new Map()
  /** 按消息拼好的思维链（非流式返回用） */
  const reasoningByMessage = new Map()
  /** 本会话每条消息的角色（来自 message.updated） */
  const rolesByMessage = new Map()
  /** 角色还没判明的 part：先攒着，等 message.updated 到了再决定发不发 */
  const pendingParts = new Map()
  let full = ''
  let tokens
  let done = false
  let interrupted = false
  let errorPayload = null
  const toolParts = []
  const deadline = Date.now() + deadlineMs

  /** 把一条**已确认属于本会话助手消息**的 part 计入正文（累积全文 → 增量） */
  function applyAssistantPart(part, messageID) {
    if (messageID !== currentMessageID) {
      // 换到下一条消息（续跑时内核会产生新的 assistant 消息）：
      // 之前的累积清掉，从新消息重新算增量，否则最终答案会被丢掉。
      currentMessageID = messageID
      full = textsByMessage.get(messageID) ?? ''
    }
    if (part.type === 'text' && typeof part.text === 'string') {
      const prev = textsByMessage.get(messageID) ?? ''
      if (part.text.length > prev.length) {
        const delta = part.text.slice(prev.length)
        textsByMessage.set(messageID, part.text)
        full = part.text
        onDelta?.(delta, part.text)
      }
      if (part.tokens) tokens = part.tokens
    } else if (part.type === 'reasoning' && typeof part.text === 'string') {
      // 内核把模型的思维链存成 reasoning part（累积全文）。以前直接丢掉，
      // DSH 就看不到思考过程；这里按 part 累积算增量，转成 reasoning_content 下发。
      const partID = typeof part.id === 'string' ? part.id : `${messageID}:reasoning`
      const prev = reasoningByPart.get(partID) ?? ''
      if (part.text.length > prev.length) {
        const delta = part.text.slice(prev.length)
        reasoningByPart.set(partID, part.text)
        reasoningByMessage.set(messageID, (reasoningByMessage.get(messageID) ?? '') + delta)
        onReasoningDelta?.(delta, part.text)
      }
    } else if (part.type === 'tool' || part.type === 'tool-invocation') {
      toolParts.push(part)
    }
  }

  /**
   * 收到一条 part：先按「会话 + 角色」过滤，再交给正文。
   *
   * 两个坑都是实测出来的（本地拉起内核 + 假上游，零真实流量）：
   *
   * 1. `/event` 是**全局**流 —— 两个 session 同时跑时，两边的事件会出现在同一条流里。
   *    不过滤 sessionID 就会把别的会话（比如并发的标题生成）的问题/答案串进本轮回复。
   * 2. 内核会把**本轮用户消息**（也就是我们发出去的提示词）也作为
   *    `message.part.updated` 发回来。以前照单全收，回复会以整段提示词开头
   *    （线上事故：18 KB 系统提示词被当成助手输出，用户看到「You are an AI agent…」）。
   */
  function onPart(part) {
    if (!part || typeof part !== 'object') return
    if (typeof part.sessionID === 'string' && part.sessionID !== sessionID) return
    const messageID = typeof part.messageID === 'string' ? part.messageID : null
    if (messageID === null) return
    const role = rolesByMessage.get(messageID)
    if (role !== undefined && role !== 'assistant') return
    if (role === undefined) {
      // 角色还没到（message.updated 通常先到，但不保证）：暂存，等判明再补发
      pendingParts.set(messageID, part)
      return
    }
    applyAssistantPart(part, messageID)
  }

  // 内核在等 MCP 工具结果时**不会再发任何事件**；如果只在收到事件后才复查工具桥，
  // 就会一直卡在 reader.read() 上。线上表现：模型发起工具调用后整轮挂起约 5 分钟
  // （宿主超时），重试时内核已经 busy，整个会话卡死。
  // 所以这里边等事件边轮询：最多 150ms 就回来复查一次 callWatcher。
  const WAKE_INTERVAL_MS = 150
  let pendingRead = null
  let wakeTimer = null

  try {
    pendingRead = reader.read()
    pendingRead.catch(() => { /* 退出时会取消读，避免未处理的拒绝 */ })
    while (!done) {
      if (Date.now() > deadline) throw new Error('等待模型响应超时')
      // 1) 工具桥拦到调用 → 本轮立刻收尾，把调用交给 DSH 执行
      if (typeof callWatcher === 'function' && callWatcher() === true) {
        interrupted = true
        break
      }
      // 2) 等事件；没有事件也要按时醒来看一眼工具桥
      const winner = await Promise.race([
        pendingRead.then((read) => ({ read })),
        new Promise((resolve) => {
          wakeTimer = setTimeout(() => resolve({ wake: true }), WAKE_INTERVAL_MS)
          wakeTimer.unref?.()
        }),
      ])
      if (wakeTimer !== null) { clearTimeout(wakeTimer); wakeTimer = null }
      if (winner.wake) continue
      const { value, done: streamDone } = winner.read
      if (streamDone) break
      pendingRead = reader.read()
      pendingRead.catch(() => {})
      buf += decoder.decode(value, { stream: true })
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''
      for (const frame of frames) {
        if (!frame.startsWith('data: ')) continue
        let ev
        try { ev = JSON.parse(frame.slice(6)) } catch { continue }
        const props = ev?.properties ?? {}

        if (ev.type === 'message.updated') {
          const info = props.info
          if (!info || typeof info.id !== 'string' || typeof info.role !== 'string') continue
          if (info.sessionID !== sessionID) continue
          rolesByMessage.set(info.id, info.role)
          if (info.role !== 'assistant') {
            // 用户/系统消息的 part 一律不进正文（这就是提示词回显的来源）
            pendingParts.delete(info.id)
            continue
          }
          if (assistantMessageID === null) assistantMessageID = info.id
          if (info.id === assistantMessageID) {
            if (info.tokens) tokens = info.tokens
            if (info.error) errorPayload = info.error
          }
          // 角色判明后，把之前暂存的助手 part 补发出去
          const pending = pendingParts.get(info.id)
          if (pending) {
            pendingParts.delete(info.id)
            applyAssistantPart(pending, info.id)
          }
        }

        if (ev.type === 'message.part.updated') {
          onPart(props.part)
        }

        // 内核侧错误（如 session is busy / abort）：立刻收尾并抛出去，
        // 否则会一直等一个永远不会来的 idle。
        if (ev.type === 'session.error' && props.sessionID === sessionID) {
          errorPayload = errorPayload ?? props.error
          done = true
        }

        if (ev.type === 'session.status' && props.sessionID === sessionID && props.status?.type === 'idle') {
          done = true
        }
      }
    }
  } finally {
    if (wakeTimer !== null) clearTimeout(wakeTimer)
    stream.abort()
    try { await reader.cancel() } catch { /* ignore */ }
  }

  if (errorPayload) {
    const failure = normalizeUpstreamFailure(errorPayload)
    const error = new Error(failure.message)
    error.upstream = errorPayload
    if (failure.code !== undefined) error.upstreamCode = failure.code
    if (failure.status !== undefined) error.status = failure.status
    // 内容审核：内核不给业务码，只中断本轮。把判定结果带上去，
    // 让 kernelErrorResult 能映射成可操作的错误，而不是不可读的 kernel_error。
    if (failure.sensitive === true) error.contentSensitive = true
    throw error
  }

  // 极端兜底：内核若没发 message.updated（角色未知）但正文非空，且不是我们发出去的提示词，
  // 就当作助手输出（正常情况下走不到这里；宁可少发也不要把提示词当答案回显）。
  if (finalTextEmpty()) {
    for (const [messageID, part] of pendingParts) {
      if (part?.type !== 'text' || typeof part.text !== 'string' || part.text.length === 0) continue
      if (typeof sentText === 'string' && sentText.length > 0 && sentText.startsWith(part.text)) continue
      applyAssistantPart(part, messageID)
    }
  }

  const finalText = currentMessageID !== null ? (textsByMessage.get(currentMessageID) ?? full) : full
  const reasoning = currentMessageID !== null ? (reasoningByMessage.get(currentMessageID) ?? '') : ''
  return { text: finalText, reasoning, tokens, toolParts, interrupted }

  function finalTextEmpty() {
    return currentMessageID === null || (textsByMessage.get(currentMessageID) ?? full) === ''
  }
}

/**
 * 发一轮 prompt 并消费事件（最常用的一条路径）。
 */
export async function promptStream(opts) {
  const { kernel, sessionID, modelID, providerID = 'NewApi', parts, text, toolFlags } = opts
  const payloadParts = Array.isArray(parts) && parts.length > 0 ? parts : [{ type: 'text', text }]
  const promptBody = { model: { providerID, modelID }, parts: payloadParts }
  if (toolFlags !== null && typeof toolFlags === 'object' && Object.keys(toolFlags).length > 0) {
    promptBody.tools = toolFlags
  }
  return consumeEvents({
    ...opts,
    onReady: async () => {
      const sent = await kernel.request('POST', `/session/${sessionID}/prompt_async`, promptBody)
      if (sent.status >= 400) {
        const detail = sent.json?.data?.message ?? sent.json?.message ?? String(sent.text).slice(0, 200)
        const error = new Error(`prompt_async 失败：${sent.status} ${detail}`)
        error.status = sent.status
        error.json = sent.json
        error.upstream = sent.json
        throw error
      }
    },
  })
}

/** 建会话 */
export async function createSession(kernel, title = 'dsh') {
  const res = await kernel.request('POST', '/session', { title })
  const id = res.json?.id
  if (!id) throw new Error(`创建会话失败：${res.status} ${String(res.text).slice(0, 200)}`)
  return id
}

// ---------------------------------------------------------------- 传输适配

/**
 * token 统计 → OpenAI usage。
 *
 * **内核的 `input` 不含缓存命中**，缓存是单独的 `cache.read` / `cache.write`
 * （实测样本见 docs/DESIGN.md：`{"total":15001,"input":150,"output":3,"cache":{"read":14848}}`
 * —— 15001 = 150 + 3 + 14848）。OpenAI 语义里 `prompt_tokens` 是**整个 prompt**，
 * `prompt_tokens_details.cached_tokens` 只是其中命中缓存的那部分。
 *
 * 以前直接 `prompt_tokens: t.input` 会导致 DSH 侧反算成负数并被钳到 0
 * （pi-ai 的 openai-completions：`input = max(0, prompt_tokens - cached - cacheWrite)`），
 * 于是**每一步的输入 token 都显示为 0**，上下文用量表完全失真。
 *
 * @param {{input?:number, output?:number, total?:number, cache?:{read?:number,write?:number}}} [tokens]
 */
export function usageOf(tokens) {
  const t = tokens ?? {}
  const input = t.input ?? 0
  const output = t.output ?? 0
  const cacheRead = t.cache?.read ?? 0
  const cacheWrite = t.cache?.write ?? 0
  // prompt = 未命中 + 命中读 + 命中写；缓存命中也是 prompt 的一部分
  const promptTokens = input + cacheRead + cacheWrite
  return {
    prompt_tokens: promptTokens,
    completion_tokens: output,
    // 内核的 total 已经是四项之和，没有就自己算，不能只用 input+output
    total_tokens: t.total ?? promptTokens + output,
    prompt_tokens_details: { cached_tokens: cacheRead, cache_write_tokens: cacheWrite },
  }
}

/**
 * 只在**真的拿到 token 统计**时才产出 usage。
 *
 * 工具调用触发 `callWatcher` 后本轮回提前收尾（不等内核 idle），而内核的
 * `[cost] tokens(in=… out=… cacheRead=…)` 日志要晚 0.3~2.6 秒才出现
 * （实测：本机 2026-11-07 会话 seq17 收尾 07:45:15.612，内核计费 07:45:15.972；
 * seq24 收尾 07:45:35.711，内核计费 07:45:38.341）。
 *
 * 等它是纯亏（每一步工具调用再多付半秒到两秒半），但上报一个全 0 的 usage
 * 更糟：宿主会把 0 当成真实用量画进上下文表，用户看到"这步没花积分"。
 * 所以拿不到就**整块省略** —— OpenAI 协议里 usage 本就是可选的。
 *
 * @param {any} tokens 内核给的 token 统计，可能为 undefined
 * @returns {object|undefined}
 */
export function usageOrUndefined(tokens) {
  if (tokens === undefined || tokens === null || typeof tokens !== 'object') return undefined
  const usage = usageOf(tokens)
  // 四项全 0 说明内核还没结算，等同于没拿到
  if (usage.total_tokens === 0 && usage.prompt_tokens === 0 && usage.completion_tokens === 0) return undefined
  return usage
}

/**
 * 创建"与 upstream.createUpstream() 同形"的传输对象。
 *
 * @param {object} options
 * @param {object} options.kernel startKernel() 的返回值
 * @param {object} [options.logger]
 * @returns {{auth:object, url:string, chat:Function, chatStream:Function, transport:'kernel'}}
 */
export function createKernelTransport({ kernel, getKernel, revive, waitReady, bridge, getBridge, logger, getToolsAllowlist } = {}) {
  /**
   * 取工具桥。
   *
   * **必须延迟取**：宿主是先建 transport、再建工具桥（桥要挂到内核上，
   * 依赖内核已就绪）。如果创建 transport 时直接把当时的 toolBridge（null）
   * 拷进来，它会永远是 null —— 线上表现就是每条消息都报
   * "Cannot read properties of null (reading 'setTools')"。
   */
  const bridgeRef = () => (typeof getBridge === 'function' ? getBridge() : bridge)

  const sessions = new SessionStore()
  const sweeper = setInterval(() => sessions.sweep(), 10 * 60 * 1000)
  sweeper.unref?.()
  const imageDir = path.join(os.tmpdir(), 'dsh-teleagent-images')
  /** 最近一次请求的统计（状态卡片展示 token 估算/工具裁剪） */
  let lastRequestStats = null

  /** 当前内核句柄（支持热替换：重启后仍然是同一个 transport 对象） */
  const currentKernel = () => (typeof getKernel === 'function' ? getKernel() : kernel)

  /** 内核是否连得上（ECONNREFUSED 这类） */
  function isUnreachable(error) {
    const text = `${error?.code ?? ''} ${error?.message ?? ''} ${error?.cause?.code ?? ''}`
    return /ECONNREFUSED|fetch failed|ECONNRESET|socket hang up/i.test(text)
  }

  /**
   * 执行一次"要连内核"的操作；连不上就让宿主重启内核后重试一次。
   *
   * 没有这层的话，内核一旦挂掉（崩溃/被系统回收），所有请求都会把
   * `ECONNREFUSED` 直接抛给用户，只能重启 DSH 才能恢复。
   */
  async function withRevive(fn, label) {
    try {
      return await fn(currentKernel())
    } catch (error) {
      if (typeof revive !== 'function' || !isUnreachable(error)) throw error
      logger?.warn?.(`dsh-connect-teleagent: 内核失联（${label}），尝试重启`)
      const fresh = await revive()
      if (!fresh) throw error
      return fn(fresh)
    }
  }

  /**
   * 放弃本轮：把内核从"等工具结果"的状态里救出来。
   *
   * 必须在**这一轮已经失败/被宿主中止**时调用；正常把 tool_calls 交给 DSH 的中断不能走这里
   * （那一步内核还要继续等工具结果）。
   *
   * 不清的话线上会这样：工具调用挂起 → 宿主超时 → 内核会话永远 busy →
   * 下一次请求直接 "session is busy"，整个会话卡死。
   */
  async function abandonTurn(k, sessionID, reason) {
    if (!sessionID) return
    try { bridgeRef()?.cancelSuspended?.(reason) } catch { /* ignore */ }
    try { bridgeRef()?.takeCalls?.() } catch { /* ignore */ }
    try { await k.request('POST', `/session/${sessionID}/abort`, {}) } catch { /* 内核没有该路由/已退出：忽略 */ }
  }

  /** 组装本轮请求：会话、文本、图片 */
  async function prepare(body) {
    // ---- 续跑：上一轮我们把工具调用交给了 DSH，内核正在等 MCP 结果
    const messagesAll = body?.messages ?? []
    const convKeyEarly = conversationKey(body, messagesAll)
    const recEarly = sessions.get(convKeyEarly)
    if (recEarly?.awaiting === true) {
      // 取本轮的新工具结果（role:'tool' 里、上次之后的）
      const toolMsgs = messagesAll.filter((m) => m.role === 'tool')
      const fresh = toolMsgs.slice(recEarly.seenToolCount ?? 0)
      if (bridgeRef()?.hasSuspended?.() === true && fresh.length > 0) {
        const resultText = fresh.map((m) => contentToText(m.content)).filter(Boolean).join('\n')
        return {
          continued: true,
          convKey: convKeyEarly,
          sessionID: recEarly.sessionID,
          plan: {
            seenUserCount: messagesAll.filter((m) => m.role === 'user').length,
            seenToolCount: toolMsgs.length,
          },
          toolResultText: resultText,
          model: recEarly.model ?? body?.model,
          text: '',
          parts: [],
          toolFlags: null,
        }
      }
      // 上一轮的工具交接没有落地（用户中断 / 宿主超时 / 内核重启）：
      // 不能当续跑，否则这一轮只会再发一次空工具结果。先清掉挂起调用并 abort 内核会话，
      // 再按"全新会话"处理（DSH 每次都会带完整历史，折叠后语义不丢）。
      logger?.warn?.('dsh-connect-teleagent: 上一轮工具结果未送达，放弃旧内核会话')
      await abandonTurn(currentKernel(), recEarly.sessionID, '工具结果未送达，放弃上一轮').catch(() => {})
      sessions.delete(convKeyEarly)
    }

    // 内核刚拉起时还没监听，等它就绪再发（否则开机头几秒的请求会白失败）
    if (typeof waitReady === 'function') {
      try { await waitReady() } catch { /* 失败也继续：由下面的请求给出真实错误 */ }
    }
    const messages = body?.messages ?? []
    const convKey = conversationKey(body, messages)
    const rec = sessions.get(convKey)
    const plan = planTurn(rec, messages)
    const { text } = plan

    let sessionID = rec?.sessionID
    if (!sessionID) sessionID = await withRevive((k) => createSession(k, `dsh-${convKey.slice(0, 8)}`), 'createSession')

    // ---- 工具桥：把 DSH 的工具挂到内核（MCP），并按需刷新清单
    //
    // 判空必须用 `bridge &&`：宿主在工具桥创建失败时会传 **null**，
    // 用 `bridge !== undefined` 会漏过去，然后崩在 setTools 上
    // （线上表现：每条消息都返回 "Cannot read properties of null"）。
    let toolFlags = null
    let sentTools
    const bridgeNow = bridgeRef()
    if (bridgeNow && Array.isArray(body?.tools) && body.tools.length > 0) {
      try {
        // 工具白名单：DSH 会把所有插件的工具都塞进请求（实测 255 个 / 875 KB schema），
        // 每步重发是长会话烧 token 的最大固定成本。未配置时保持原样全发。
        const allowlist = typeof getToolsAllowlist === 'function' ? getToolsAllowlist() : undefined
        const filtered = filterTools(body.tools, allowlist)
        if (filtered.empty) logger?.warn?.('dsh-connect-teleagent: toolsAllowlist 没有任何匹配，已回退全量工具')
        sentTools = filtered.tools
        if (filtered.applied) {
          bootlog('工具白名单生效', { total: body.tools.length, sent: filtered.kept, dropped: filtered.dropped })
        }
        const changed = bridgeNow.setTools(filtered.tools)
        // 内核会缓存 tools/list（实测 list_changed 通知不生效），
        // 所以变化时重新挂载一次（本地握手，代价很小）
        await bridgeNow.mount(currentKernel(), { force: changed })
        // 注册是异步的：不等就会出现"第一轮模型看不到工具"
        await bridgeNow.waitForRegistration(currentKernel(), { expected: filtered.tools.length, timeoutMs: 4000 })
        // 内核自带的工具全部关掉（否则它会在自己的沙箱里执行 bash 之类）
        toolFlags = await bridgeNow.builtinFlags(currentKernel())
      } catch (error) {
        // 工具桥坏了不该让整条对话失败：本轮降级为纯文本
        logger?.warn?.('dsh-connect-teleagent: 工具桥异常，本轮降级为纯文本', error?.message ?? error)
        toolFlags = null
      }
    }

    // 估算本次 prompt 规模（工具已按白名单裁剪），供状态卡片提示成本
    try {
      const estimate = estimatePrompt(body, sentTools)
      lastRequestStats = {
        at: Date.now(),
        model: body?.model,
        messages: messages.length,
        toolsTotal: Array.isArray(body?.tools) ? body.tools.length : 0,
        toolsSent: sentTools === undefined ? (Array.isArray(body?.tools) ? body.tools.length : 0) : sentTools.length,
        filtered: sentTools !== undefined && sentTools.length !== (body?.tools?.length ?? 0),
        tokensApprox: estimate.tokensApprox,
      }
    } catch { /* 统计失败不影响请求 */ }

    // 图片：只取**本轮新增**消息里的，避免每轮重复发同一张
    const freshMessages = rec
      ? messages.filter((m) => m.role !== 'system' && m.role !== 'assistant').slice(rec.seenUserCount ?? 0)
      : messages
    const images = materializeImages(freshMessages, imageDir)
    const parts = [{ type: 'text', text }]
    for (const image of images) {
      parts.push({ type: 'file', mime: image.mime, url: 'file://' + image.file, filename: path.basename(image.file) })
    }

    return { convKey, sessionID, plan, text, parts, model: body?.model, toolFlags, continued: false }
  }

  return {
    transport: 'kernel',
    get auth() { return { accountName: currentKernel()?.scope ?? null } },
    get url() { return currentKernel()?.base ?? '' },
    /** 最近一次请求的规模估算（状态卡片用；没有请求时为 null） */
    lastRequest: () => lastRequestStats,

    /** 非流式：聚合后返回 OpenAI 响应 */
    async chat(body) {
      let prepared
      try {
        prepared = await prepare(body)
      } catch (error) {
        return kernelErrorResult(error, body?.model)
      }
      const { convKey, sessionID, plan, text, parts, model, toolFlags, continued, toolResultText } = prepared
      try {
        // 续跑：放行挂起的 MCP 调用后继续读同一条流；否则正常发 prompt
        const result = await withRevive((k) => (continued === true
          ? consumeEvents({
              kernel: k, sessionID,
              onReady: async () => { bridgeRef().resolveSuspended(toolResultText) },
              callWatcher: () => bridgeRef()?.hasCalls?.() === true,
            })
          : promptStream({
              kernel: k, sessionID, modelID: model, text, parts, toolFlags,
              callWatcher: () => bridgeRef()?.hasCalls?.() === true,
            })), continued === true ? 'continue' : 'prompt')
        const calls = bridgeRef()?.takeCalls?.() ?? []
        sessions.set(convKey, { sessionID, ...plan, model, awaiting: calls.length > 0 })
        // 拿不到内核结算就不写 usage，别把全 0 当真实用量（见 usageOrUndefined）
        const usage = usageOrUndefined(result.tokens)
        const usageField = usage === undefined ? {} : { usage }
        if (calls.length > 0) {
          const toolCalls = callsToOpenAiToolCalls(calls)
          return {
            status: 200,
            json: {
              id: `chatcmpl-${crypto.randomUUID()}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: toolCalls }, finish_reason: 'tool_calls' }],
              ...usageField,
            },
            text: '',
          }
        }
        return {
          status: 200,
          json: {
            id: `chatcmpl-${crypto.randomUUID()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: result.text,
                ...(typeof result.reasoning === 'string' && result.reasoning.length > 0 ? { reasoning_content: result.reasoning } : {}),
              },
              finish_reason: 'stop',
            }],
            ...usageField,
          },
          text: '',
        }
      } catch (error) {
        // 本轮失败/被中止：清掉挂起调用并 abort 内核会话，避免会话永远 busy
        await abandonTurn(currentKernel(), sessionID, `本轮失败：${error?.message ?? error}`).catch(() => {})
        sessions.delete(convKey)
        return kernelErrorResult(error, model)
      }
    },

    /**
     * 流式：返回一个 SSE Response（OpenAI chunk 流）。
     * shim 只需要把这个 Response 原样转发给下游。
     */
    async chatStream(body, signal) {
      let prepared
      try {
        prepared = await prepare(body)
      } catch (error) {
        const mapped = kernelErrorResult(error, body?.model)
        return new Response(JSON.stringify(mapped.json), {
          status: mapped.status,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      const { convKey, sessionID, plan, text, parts, model, toolFlags, continued, toolResultText } = prepared
      const id = `chatcmpl-${crypto.randomUUID()}`
      const created = Math.floor(Date.now() / 1000)
      const encoder = new TextEncoder()

      const stream = new ReadableStream({
        async start(controller) {
          const send = (delta, finish = null, extra = {}) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              id, object: 'chat.completion.chunk', created, model,
              choices: finish === null && Object.keys(delta).length === 0 ? [] : [{ index: 0, delta, finish_reason: finish }],
              ...extra,
            })}\n\n`))
          }
          try {
            send({ role: 'assistant', content: '' })
            const result = await withRevive((k) => (continued === true
              ? consumeEvents({
                  kernel: k, sessionID, signal,
                  onReady: async () => { bridgeRef().resolveSuspended(toolResultText) },
                  onDelta: (delta) => send({ content: delta }),
                  onReasoningDelta: (delta) => send({ reasoning_content: delta }),
                  callWatcher: () => bridgeRef()?.hasCalls?.() === true,
                })
              : promptStream({
                  kernel: k, sessionID, modelID: model, text, parts, toolFlags, signal,
                  onDelta: (delta) => send({ content: delta }),
                  onReasoningDelta: (delta) => send({ reasoning_content: delta }),
                  callWatcher: () => bridgeRef()?.hasCalls?.() === true,
                })), continued === true ? 'continue-stream' : 'prompt-stream')

            const calls = bridgeRef()?.takeCalls?.() ?? []
            sessions.set(convKey, { sessionID, ...plan, model, awaiting: calls.length > 0 })
            // 拿不到 kernel 结算就拿不到，别把全 0 当真实用量发出去（见 usageOrUndefined）
            const usage = usageOrUndefined(result.tokens)
            const usageExtra = usage === undefined ? {} : { usage }
            if (calls.length > 0) {
              // 把调用翻译成 OpenAI 的 tool_calls（带索引，符合流式累加语义）
              const toolCalls = callsToOpenAiToolCalls(calls).map((call, index) => ({ index, ...call }))
              send({ tool_calls: toolCalls }, 'tool_calls', usageExtra)
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              return
            }

            send({}, 'stop', usageExtra)
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          } catch (error) {
            logger?.warn?.('dsh-connect-teleagent: kernel 流式失败', error?.message ?? error)
            const mapped = kernelErrorResult(error, model)
            // 宿主中止/超时后也要把内核从"等工具结果"里救出来，否则下一轮 session is busy
            await abandonTurn(currentKernel(), sessionID, `本轮失败：${error?.message ?? error}`).catch(() => {})
            sessions.delete(convKey)
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: mapped.json.error })}\n\n`))
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          } finally {
            try { controller.close() } catch { /* 已关闭 */ }
          }
        },
      })

      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
    },

    close() {
      clearInterval(sweeper)
    },
  }
}

/**
 * 把 kernel 侧错误映射成 OpenAI 错误体（让 health.js 能分类）。
 *
 * kernel 的错误形态不统一（可能是 `{error:{message}}`、`{data:{code,message}}`、
 * 或直接一句文本），所以这里逐个形状挖；再根据文案兜底识别封禁，
 * 否则用户只会看到没法处理的 "kernel_error"。
 */
export function kernelErrorResult(error, model) {
  const status = typeof error?.status === 'number' && error.status >= 400 ? error.status : 502
  const upstream = error?.upstream ?? error?.json ?? {}

  const candidateMessages = [
    upstream?.data?.message,
    upstream?.error?.message,
    upstream?.error?.data?.message,
    upstream?.message,
    error?.message,
  ].filter((x) => typeof x === 'string' && x.length > 0)

  const failure = normalizeUpstreamFailure(upstream)
  const candidateCodes = [
    upstream?.data?.responseCode,
    upstream?.data?.statusCode,
    upstream?.data?.code,
    upstream?.error?.code,
    upstream?.error?.data?.code,
    upstream?.code,
    error?.upstreamCode,
  ].filter((x) => x !== undefined && x !== null)

  let code = candidateCodes.length > 0 ? candidateCodes[0] : undefined
  // 额度不足必须走带 “insufficient quota” 的文案，宿主的 isQuotaExceededError 才认
  let message = failure.quota ? failure.message : (candidateMessages[0] ?? 'kernel 调用失败')
  if (failure.quota && (code === undefined || code === 5005)) code = 402

  // 内容审核：内核只中断、不给码。以前这句「内容包含敏感信息，已被中断」
  // 原样透传，宿主分类不出任何已知模式 → 整轮变成不可读的 PI_AI_ERROR，
  // 用户既不知道发生了什么，也不知道下一步该做什么。
  // 这里把它变成带处置建议的独立错误码（非重试，重试同样的内容只会再被拦）。
  if (error?.contentSensitive === true || failure.sensitive === true) {
    return {
      status: 400,
      json: {
        error: {
          type: 'content_moderated',
          code: 'content_moderated',
          message: [
            '内容被上游安全审核拦截，本轮已中断（"内容包含敏感信息，已被中断"）。',
            '这不是插件、网络或账号额度问题，重试同样的内容会被再次拦截。',
            '可以：① 换一种措辞重述需求；② 把长命令/大段抓取拆成几次更小的调用；',
            '③ 避开被拦的那一步，改用别的数据来源或让模型先只做分析不抓取。',
          ].join(''),
          sensitive: true,
        },
      },
      text: '',
      model,
    }
  }

  // 文案兜底：上游有时只给一句英文/中文，没有业务码
  if (code === undefined) {
    if (/banned|封禁|禁用/i.test(message)) code = 40109
    else if (/token|凭据|unauthorized|not logged/i.test(message)) code = 40108
    else if (/signature|签名/i.test(message)) code = 40104
    else if (/rate limit|too many|频繁/i.test(message)) code = 429
    else if (/credit|积分不足|insufficient/i.test(message)) code = 402
  }

  return {
    status: code === 40109 || code === 40108 || code === 40104 ? 401 : status,
    json: {
      error: {
        message,
        type: code ? 'upstream_error' : 'kernel_error',
        code: code ?? 'kernel_error',
      },
    },
    text: '',
    model,
  }
}

/** 供 doctor 用的只读探测：不建会话、不发 prompt */
export async function probeKernelHealth(kernel, timeoutMs = 5000) {
  try {
    const res = await kernel.request('GET', '/global/health', undefined, { timeoutMs })
    return { ok: res.status === 200, status: res.status, detail: String(res.text).slice(0, 200) }
  } catch (error) {
    return { ok: false, status: 0, detail: String(error?.message ?? error) }
  }
}

/** 用系统钥匙串读取 safeStorage 密码（doctor 里校验用，不打印值） */
export function canReadKeychain() {
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] })
    return out.toString().trim().length > 0
  } catch {
    return false
  }
}
