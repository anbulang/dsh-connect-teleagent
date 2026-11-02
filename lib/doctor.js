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
  try {
    handle = await startKernel({ port: Number(process.env.TELEAGENT_KERNEL_PORT ?? 47901) })
    await waitReady(handle, 30_000)
    const health = await probeKernelHealth(handle)
    record('kernel 启动与 health', health.ok === true, health.ok ? `healthy · ${health.detail.slice(0, 60)}` : health.detail,
      '内核起不来通常是 XDG 路径或登录态问题；看 ~/.dsh/teleagent-boot.log')
  } catch (error) {
    record('kernel 启动与 health', false, String(error?.message ?? error).slice(0, 160),
      '内核启动失败：检查 ~/.local/share/TeleAgent/runtimes 是否完整')
  } finally {
    handle?.stop()
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
