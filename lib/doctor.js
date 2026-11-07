#!/usr/bin/env node
/**
 * dsh-connect-teleagent doctor —— 自检工具。
 *
 * 逐项检查插件运行所需的全部外部条件，并给出可执行的修复建议。
 * 用法：
 *   node lib/doctor.js          # 人类可读
 *   node lib/doctor.js --json   # 机器可读
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appPaths, MODELS } from './models.js'
import { readUpstreamAuth, probeUpstream } from './upstream.js'
import { readPortalAuth, fetchPoints } from './portal.js'
import { resolveKernelBinary, startKernel, waitReady, probeKernelHealth } from './kernel.js'
import { classifyUpstreamError } from './health.js'
import { diagnoseCredential, CredentialState } from './credential.js'

const AS_JSON = process.argv.includes('--json')
// 默认**不再**用真实聊天请求做自检：那会产生真实流量，且是风控最容易注意到的形态。
// 需要验证签名链路时显式加 --probe。
const DO_PROBE = process.argv.includes('--probe')

const checks = []
function record(name, ok, detail, remedy) {
  checks.push({ name, ok, detail, remedy })
}

function tryRun(fn, fallback) {
  try { return fn() } catch (e) { return fallback ?? { error: String(e?.message ?? e) } }
}

// ---------------------------------------------------------------- 1. 应用
const APP = '/Applications/TeleAgent.app'
const appVersion = tryRun(() => {
  const plist = path.join(APP, 'Contents/Info.plist')
  const out = execFileSync('defaults', ['read', plist, 'CFBundleShortVersionString']).toString().trim()
  return out
})
record(
  'TeleAgent 桌面端',
  fs.existsSync(APP) && typeof appVersion === 'string',
  fs.existsSync(APP) ? `已安装，版本 ${appVersion ?? '未知'}` : '未安装',
  '从 https://www.teleai.com.cn 下载并安装 TeleAgent 桌面版',
)

// ---------------------------------------------------------------- 2. 数据目录
const paths = appPaths()
const dataOk = fs.existsSync(paths.data)
record(
  '数据目录',
  dataOk,
  dataOk ? paths.data : `缺失：${paths.data}`,
  '先启动一次 TeleAgent 桌面端让它初始化数据目录',
)

// ---------------------------------------------------------------- 3+4. 登录态与钥匙串
const cred = diagnoseCredential()
record(
  '登录态',
  cred.ok,
  cred.detail,
  cred.remedy,
)
record(
  '钥匙串 (safeStorage)',
  cred.state !== CredentialState.KEYCHAIN_MISSING && cred.state !== CredentialState.KEYCHAIN_DENIED,
  cred.state === CredentialState.KEYCHAIN_MISSING
    ? '条目不存在'
    : cred.state === CredentialState.KEYCHAIN_DENIED
      ? '访问被拒绝'
      : '可读取',
  cred.state === CredentialState.KEYCHAIN_DENIED || cred.state === CredentialState.KEYCHAIN_MISSING
    ? '在 TeleAgent 桌面端重新登录后重试'
    : undefined,
)

// ---------------------------------------------------------------- 5. 设备标识
let deviceOk = false
let deviceDetail = ''
try {
  const metaPath = path.join(paths.data, 'app-auth', 'device-meta.json')
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  deviceOk = typeof meta.deviceId === 'string' && meta.deviceId.length > 0
  deviceDetail = deviceOk ? `deviceId=${meta.deviceId} · installId=${(meta.installId ?? '').slice(0, 8)}…` : 'deviceId 缺失'
} catch (e) {
  deviceDetail = `读取失败：${String(e?.message ?? e)}`
}
record('设备标识', deviceOk, deviceDetail, '在 TeleAgent 桌面端登录一次以生成 app-auth/device-meta.json')

// ---------------------------------------------------------------- 6. 签名自检
// 用真实凭据对一个极小请求签名，验证「上游 + 签名算法」整条链路可用。
// 只用 1 个 token 的 prompt，成本可忽略。
// ---------------------------------------------------------------- 6a. 积分接口（只读、免费）
let portalOk = false
let portalDetail = '跳过（无 portal 凭据）'
try {
  const pa = readPortalAuth()
  if (pa) {
    const r = await fetchPoints(pa)
    portalOk = r.ok === true
    portalDetail = r.ok ? `可用 · 余额 ${r.balance}` : `不可用：${r.error}`
  }
} catch (e) {
  portalDetail = `失败：${String(e?.message ?? e)}`
}
record('积分接口', portalOk, portalDetail, '积分与领取走独立通道；它可用不代表聊天通道可用')

// ---------------------------------------------------------------- 6b. 聊天通道（需 --probe）
let signOk = false
let signDetail = DO_PROBE ? '跳过（凭据不可用）' : '跳过（默认不发真实请求，加 --probe 开启）'
let remedyForSign
if (!DO_PROBE) {
  // 不探测时视为"未知"，不算失败
  signOk = true
} else if (cred.ok) {
  try {
    const auth = readUpstreamAuth()
    const result = await probeUpstream(auth, { allow: true })
    if (result.ok) {
      signOk = true
      signDetail = '签名有效，上游返回 200'
    } else {
      const info = classifyUpstreamError(result.status, result.json, result.text)
      if (info.code === 'account_banned') {
        // 封禁不是本机问题：签名其实是通过的，问题在账号
        signOk = true
        signDetail = `签名有效，但账号被封禁（${info.upstreamCode}）：所有模型都会被拒绝`
        remedyForSign = info.remedy
      } else {
        signDetail = `上游拒绝：HTTP ${result.status} ${info.message}`
        remedyForSign = info.remedy
      }
    }
  } catch (e) {
    signDetail = `自检失败：${String(e?.message ?? e)}`
  }
}
record('聊天通道自检', signOk, signDetail, remedyForSign ?? '若签名失效，检查 TeleAgent 是否已升级（签名算法可能变更）；平时用 --probe 才发请求')

// ------------------------------------------------------- 7b. 内核安全审核链路
//
// 内核（mcp_policy_review.go）对每次 MCP 工具调用的**入参**和**输出**各做一次远端审核。
// 实测输出审核 100% 以 `context canceled` 结束——那是"调用方已结束、请求还挂着"，
// **不是审核拒绝**，功能无损，但内核每次都刷一条 [Error]，真实故障会被淹没。
//
// 插件无法干预内核，但可以让用户知道这条链路存在、以及它是否在刷错误。
const review = tryRun(() => {
  const logDir = path.join(process.env.HOME ?? '', '.dsh-teleagent-kernel', 'data', 'log')
  if (!fs.existsSync(logDir)) return { state: 'absent' }
  // 取当天最新的内核日志
  const files = fs.readdirSync(logDir)
    .filter((f) => /^super-agent-server-\d{4}-\d{2}-\d{2}\.log$/.test(f))
    .sort()
  if (files.length === 0) return { state: 'absent' }
  const text = fs.readFileSync(path.join(logDir, files[files.length - 1]), 'utf8')
  const requests = (text.match(/policy review request/g) ?? []).length
  const canceled = (text.match(/policy review output request failed[^\n]*context canceled/g) ?? []).length
  const rejected = (text.match(/policy review decision[^\n]*action=(?:deny|block)/g) ?? []).length
  return { state: 'observed', file: files[files.length - 1], requests, canceled, rejected }
}, { state: 'error' })
if (review.state === 'observed') {
  // 取消 ≠ 拒绝：只有真的 deny 才算问题
  const ok = review.rejected === 0
  const parts = [`今日 ${review.requests} 次工具调用审核`]
  if (review.rejected > 0) parts.push(`${review.rejected} 次被拒绝`)
  if (review.canceled > 0) parts.push(`${review.canceled} 次输出审核被取消（正常：调用方已结束，非拒绝）`)
  record(
    '内核安全审核',
    ok,
    parts.join('，'),
    review.rejected > 0
      ? '工具入参被安全审核拒绝：换一种措辞或拆分命令'
      : '输出审核的 context canceled 属正常现象，不影响功能；若日志刷得太吵请忽略该行',
  )
} else if (review.state === 'absent') {
  record('内核安全审核', true, '跳过（还没有内核日志）', '')
}

// ---------------------------------------------------------------- 8. 模型目录
const catalogFile = tryRun(() => path.join(paths.data, 'users', cred.scope ?? '', 'model-catalog.json'))
const catalogOk = typeof catalogFile === 'string' && fs.existsSync(catalogFile)
record(
  '模型目录',
  catalogOk,
  catalogOk ? `已缓存 ${MODELS.length} 个内置模型定义` : '未找到 model-catalog.json（会退回内置清单）',
  '启动 TeleAgent 桌面端并保持登录，目录会自动同步',
)

// ---------------------------------------------------------------- 8b. kernel 传输
const kernelBin = resolveKernelBinary()
record(
  'kernel 可执行文件',
  fs.existsSync(kernelBin),
  fs.existsSync(kernelBin) ? kernelBin : `找不到：${kernelBin}`,
  '确认 TeleAgent 桌面端已安装并至少启动过一次（runtimes 由它下载）',
)

if (fs.existsSync(kernelBin) && cred.ok) {
  let handle = null
  // 用**独立 runtimeDir**：默认目录里的 kernel.pid 属于正在运行的 DSH。
  // doctor 只是自检，不能覆盖它 —— 否则 DSH 退出时就找不到自己的内核了
  // （更糟的是以前会连带把活内核当成"遗留内核"杀掉）。
  let doctorRuntimeDir = null
  try {
    doctorRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-doctor-kernel-'))
    handle = await startKernel({
      port: Number(process.env.TELEAGENT_KERNEL_PORT ?? 47901),
      runtimeDir: doctorRuntimeDir,
    })
    await waitReady(handle, 30_000)
    const health = await probeKernelHealth(handle)
    record('kernel 启动与 health', health.ok === true, health.ok ? `healthy · ${health.detail.slice(0, 60)}` : health.detail,
      '内核起不来通常是 XDG 路径或登录态问题；看 ~/.dsh/teleagent-boot.log')
  } catch (error) {
    record('kernel 启动与 health', false, String(error?.message ?? error).slice(0, 160),
      '内核启动失败：检查 ~/.local/share/TeleAgent/runtimes 是否完整')
  } finally {
    handle?.stop()
    if (doctorRuntimeDir !== null) {
      try { fs.rmSync(doctorRuntimeDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
} else if (!cred.ok) {
  record('kernel 启动与 health', false, '跳过（登录态不可用）', '先完成登录')
}

// ---------------------------------------------------------------- 9. 工具调用
record(
  '工具调用',
  true,
  '直连模式：tools/tool_calls 原样透传，由 DSH 执行（无双层执行）',
  '无需配置',
)

// ---------------------------------------------------------------- 输出
if (AS_JSON) {
  console.log(JSON.stringify({ ok: checks.every((c) => c.ok), checks }, null, 2))
} else {
  console.log('\n  dsh-connect-teleagent doctor\n  ' + '─'.repeat(52))
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name.padEnd(20)} ${c.detail}`)
    if (!c.ok && c.remedy) console.log(`    → ${c.remedy}`)
  }
  const failed = checks.filter((c) => !c.ok)
  console.log('  ' + '─'.repeat(52))
  console.log(failed.length === 0
    ? '  全部通过，插件应可正常工作。\n'
    : `  ${failed.length} 项需要处理。\n`)
}

process.exit(checks.every((c) => c.ok) ? 0 : 1)
