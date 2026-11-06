#!/usr/bin/env node
/**
 * dsh-connect-teleagent 命令行。
 *
 * 三个子命令，覆盖"不开 DSH 也能确认状态"的需求：
 *
 *   status [--json]     账号 / 积分 / 今日领取 / 上游连通性（只读）
 *   doctor [--json]     完整自检（转发给 doctor.js）
 *   logout [--all]      清除本机登录态（只删凭据，保留技能/记忆）
 *
 * 退出码：0 = 正常，1 = 有问题（便于脚本判断）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { diagnoseCredential } from './credential.js'
import { readPortalAuth, fetchPoints, fetchDailyStatus, fetchUserCenter } from './portal.js'
import { readUpstreamAuth, probeUpstream } from './upstream.js'
import { clearCredential, listScopesWithCredential } from './account.js'
import { listAccounts, fetchAllAccountPoints, switchAccount, claimForAccount, deleteAccount } from './accounts.js'
import { runAddAccountFlow } from './add-account.js'
import { isAppRunningNow } from './lifecycle.js'
import { readStore } from './store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('-')))
const wantsHelp = flags.has('--help') || flags.has('-h') || flags.has('help')
// 没有子命令且没要帮助时才默认 doctor；--help 必须优先于默认值
const command = wantsHelp ? 'help' : (args.find((a) => !a.startsWith('-')) ?? 'doctor')
const asJson = flags.has('--json')

const C = {
  dim: (s) => `\u001b[2m${s}\u001b[0m`,
  ok: (s) => `\u001b[32m${s}\u001b[0m`,
  bad: (s) => `\u001b[31m${s}\u001b[0m`,
  bold: (s) => `\u001b[1m${s}\u001b[0m`,
}

async function runStatus() {
  const diag = diagnoseCredential()
  const portalAuth = readPortalAuth()
  const result = {
    account: {
      signedIn: diag.ok === true,
      accountName: diag.accountName ?? null,
      expiresAt: diag.expiresAt ?? null,
      daysLeft: diag.daysLeft ?? null,
      state: diag.state ?? null,
      detail: diag.detail ?? null,
      remedy: diag.remedy ?? null,
    },
    points: null,
    daily: null,
    plan: null,
    upstream: null,
    provider: { disabled: readStore()?.providerDisabled === true },
    accounts: listScopesWithCredential().length,
  }

  if (portalAuth) {
    const [points, daily, plan] = await Promise.all([
      fetchPoints(portalAuth).catch((e) => ({ ok: false, error: String(e?.message ?? e) })),
      fetchDailyStatus(portalAuth).catch((e) => ({ ok: false, error: String(e?.message ?? e) })),
      fetchUserCenter(portalAuth).catch(() => ({ ok: false })),
    ])
    result.points = points.ok ? { balance: points.balance, expiresAt: points.expiresAt } : { error: points.error }
    result.daily = daily.ok
      ? { claimable: daily.claimable, claimedToday: daily.claimedToday, totalDays: daily.totalDays, totalPoints: daily.totalPoints }
      : { error: daily.error }
    result.plan = plan.ok ? { name: plan.planName, endDate: plan.endDate } : null
  }

  // 默认不打聊天请求：portal 已能证明账号可用，聊天探测只在 --probe 时做
  if (diag.ok === true && flags.has('--probe') && !flags.has('--no-probe')) {
    try {
      const auth = readUpstreamAuth()
      const probe = await probeUpstream(auth, { allow: true })
      result.upstream = probe.ok
        ? { ok: true, status: probe.status }
        : { ok: false, status: probe.status, code: probe.json?.code ?? null, message: probe.json?.message ?? null }
    } catch (error) {
      result.upstream = { ok: false, error: String(error?.message ?? error) }
    }
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    const line = (label, value, good) => {
      const mark = good === undefined ? ' ' : good ? C.ok('✓') : C.bad('✗')
      console.log(`  ${mark} ${label.padEnd(14)} ${value}`)
    }
    console.log(`\n  ${C.bold('dsh-connect-teleagent status')}  ${C.dim('v' + readVersion())}`)
    console.log('  ' + '─'.repeat(52))
    line('账号', result.account.signedIn
      ? `${result.account.accountName ?? '已登录'}${result.account.daysLeft != null ? ` · 剩余 ${result.account.daysLeft} 天` : ''}`
      : (result.account.detail ?? '未登录'), result.account.signedIn)

    if (result.points) {
      const p = result.points
      line('积分', p.error ? `读取失败：${p.error}` : `${Number(p.balance).toFixed(2)}${p.expiresAt ? ` · 最近到期 ${String(p.expiresAt).slice(0, 10)}` : ''}`, !p.error)
    } else {
      line('积分', '未登录，无法读取', false)
    }

    if (result.daily) {
      const d = result.daily
      line('每日领取', d.error ? `读取失败：${d.error}`
        : (d.claimedToday ? `今日已领 · 累计 ${d.totalDays} 天 ${d.totalPoints} 积分` : `今日可领 ${d.claimable} 积分`), !d.error)
    }

    if (result.plan) line('套餐', `${result.plan.name ?? '—'}${result.plan.endDate ? ` · 到期 ${result.plan.endDate}` : ''}`, true)

    if (result.upstream) {
      line('上游连通', result.upstream.ok
        ? `HTTP ${result.upstream.status}`
        : `失败 ${result.upstream.status ?? ''} ${result.upstream.code ?? ''} ${result.upstream.message ?? result.upstream.error ?? ''}`.trim(), result.upstream.ok)
    }

    line('模型供应商', result.provider.disabled ? '已停用（不会出现在模型选择器）' : '启用中', !result.provider.disabled)
    console.log('  ' + '─'.repeat(52))
    if (!result.account.signedIn && result.account.remedy) console.log(`  → ${result.account.remedy}`)
    console.log()
  }

  const healthy = result.account.signedIn && (result.upstream?.ok !== false)
  return healthy ? 0 : 1
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version
  } catch {
    return '0.x'
  }
}

function runDoctor() {
  const child = spawnSync(process.execPath, [path.join(here, 'doctor.js'), ...args.filter((a) => a.startsWith('-'))], { stdio: 'inherit' })
  return child.status ?? 1
}

async function runAccounts() {
  // 多账号登录入口：先把「添加账号」挡在前面，避免为了一个登录入口去拉所有账号积分
  if (flags.has('--add')) {
    const timeoutArg = args.find((a) => a.startsWith('--timeout='))
    const timeoutMs = timeoutArg === undefined ? undefined : Number(timeoutArg.split('=')[1])
    if (!asJson) {
      console.log()
      console.log(`  ${C.bold('添加账号')}  ${C.dim('会先备份当前账号的登录态')}`)
      console.log(`  ${C.dim('已唤起 TeleAgent：请在应用里「设置 → 账号 → 退出登录」，再用另一个账号登录')}`)
      console.log(`  ${C.dim('检测到新账号后，原账号的凭据会自动写回，两个账号都能在 accounts 列表里切换')}`)
    }
    const result = await runAddAccountFlow({
      ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
      onProgress: (stage) => {
        if (asJson) return
        if (stage === 'recovered') console.log(`  ${C.dim('已恢复上次未完成流程里备份的登录态')}`)
        if (stage === 'restored') console.log(`  ${C.dim('原账号登录态已写回')}`)
      },
    })
    if (asJson) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log()
      if (result.ok === true && result.added) {
        console.log(`  ${C.ok('✓')} ${result.message ?? `已添加账号 ${result.added.scope}`}`)
      } else {
        console.log(`  ${C.bad('✗')} ${result.reason ?? '添加账号失败'}`)
        if (result.hint) console.log(`    ${C.dim(result.hint)}`)
      }
      if (result.restored?.restored === true) console.log(`  ${C.dim('原账号登录态已恢复：' + result.restored.scope)}`)
      console.log()
    }
    return result.ok === true ? 0 : 1
  }

  const withPoints = !flags.has('--no-points')
  const list = listAccounts()
  const balances = withPoints ? await fetchAllAccountPoints(list.map((a) => a.scope)) : []
  const byScope = new Map(balances.map((b) => [b.scope, b]))
  const appRunning = (() => { try { return isAppRunningNow() } catch { return false } })()

  const claimTarget = args.find((a) => a.startsWith('--claim='))
  if (claimTarget !== undefined) {
    const scope = claimTarget.split('=')[1]
    const result = await claimForAccount(scope)
    if (asJson) console.log(JSON.stringify(result, null, 2))
    else {
      console.log()
      if (result.ok && result.claimed) console.log(`  ${C.ok('✓')} 已为 ${scope.slice(-6)} 领取 +${result.points ?? 0} 积分`)
      else if (result.ok && result.alreadyClaimed) console.log(`  ${C.dim('该账号今天已经领过了')}`)
      else console.log(`  ${C.bad('✗')} ${result.error ?? '领取失败'}`)
      console.log()
    }
    return result.ok ? 0 : 1
  }

  const deleteTarget = args.find((a) => a.startsWith('--delete='))
  if (deleteTarget !== undefined) {
    const scope = deleteTarget.split('=')[1]
    const result = deleteAccount({
      scope,
      mode: flags.has('--purge') ? 'purge' : 'logout',
      dryRun: flags.has('--dry-run'),
      appRunning,
    })
    if (asJson) console.log(JSON.stringify(result, null, 2))
    else {
      console.log()
      if (result.ok && result.dryRun) {
        console.log(`  ${C.dim('dry-run：将删除 ' + (result.plan.willRemove ?? []).join(', '))}`)
      } else if (result.ok && result.deleted) {
        console.log(`  ${C.ok('✓')} 已删除 ${scope.slice(-8)}${result.plan.mode === 'purge' ? `（已移入回收站：${result.plan.trashDir}）` : '（仅摘除登录态）'}`)
      } else {
        console.log(`  ${C.bad('✗')} ${result.reason}`)
      }
      console.log()
    }
    return result.ok ? 0 : 1
  }

  const target = args.find((a) => a.startsWith('--to=') || a.startsWith('--switch='))
  if (target !== undefined) {
    const scope = target.split('=')[1]
    const result = switchAccount({ scope, dryRun: flags.has('--dry-run'), appRunning })
    if (asJson) console.log(JSON.stringify(result, null, 2))
    else {
      console.log()
      if (result.changed) console.log(`  ${C.ok('✓')} 已切换到 ${result.account?.accountName ?? scope}${result.backup ? `（备份：${result.backup}）` : ''}`)
      else if (result.dryRun && result.ok) console.log(`  ${C.dim('dry-run：将把 ownerDir 改为 ' + scope + '，generation ' + (result.previous?.generation ?? 0) + ' → ' + result.owner.generation)}`)
      else if (result.ok) console.log(`  ${C.dim(result.reason ?? '无需切换')}`)
      else console.log(`  ${C.bad('✗')} ${result.reason}`)
      console.log()
    }
    return result.ok ? 0 : 1
  }

  if (asJson) {
    console.log(JSON.stringify({ appRunning, accounts: list.map((a) => ({ ...a, points: byScope.get(a.scope) ?? null })) }, null, 2))
  } else {
    console.log(`\n  ${C.bold('账号列表')}  ${C.dim(appRunning ? '（TeleAgent 桌面端运行中，切换会被拒绝）' : '')}`)
    console.log('  ' + '─'.repeat(64))
    for (const a of list) {
      const pts = byScope.get(a.scope)
      const mark = a.isCurrent ? C.ok('★') : ' '
      const name = (a.accountName ?? a.userId?.slice(-6) ?? a.scope).padEnd(10)
      const left = a.daysLeft != null ? `${a.daysLeft} 天` : a.state
      const balance = pts ? (pts.ok ? Number(pts.balance).toFixed(2) : '读取失败') : '—'
      console.log(`  ${mark} ${name} ${String(left).padEnd(10)} 积分 ${String(balance).padStart(10)}  ${C.dim(a.scope)}`)
    }
    console.log('  ' + '─'.repeat(64))
    console.log(`  ${C.dim('切换：dsh-connect-teleagent accounts --to=<scope> [--dry-run]')}`)
    console.log()
  }
  return 0
}

async function runLogout() {
  const all = flags.has('--all')
  const before = listScopesWithCredential().length
  const result = await clearCredential({ scope: all ? 'all' : 'current' })
  if (asJson) {
    console.log(JSON.stringify({ ...result, before, scope: all ? 'all' : 'current' }, null, 2))
  } else {
    console.log()
    if (result.cleared.length > 0) {
      console.log(`  ${C.ok('✓')} 已清除 ${result.cleared.length} 个账号的登录态${result.appQuit ? '（已先退出桌面端）' : ''}`)
      for (const scope of result.cleared) console.log(`    ${C.dim(scope)}`)
      console.log(`  ${C.dim('技能、记忆、日志等个人数据均未改动。')}`)
    } else {
      console.log(`  ${C.dim('没有可清除的登录态（当前未登录）。')}`)
    }
    for (const err of result.errors) console.log(`  ${C.bad('✗')} ${err}`)
    console.log()
  }
  return result.errors.length === 0 ? 0 : 1
}

function usage() {
  console.log(`
  ${C.bold('dsh-connect-teleagent')} — TeleAgent 模型接入 DSH 的命令行工具

  用法：
    dsh-connect-teleagent status [--json] [--probe]      账号 / 积分 / 领取 / 套餐（只读）
    dsh-connect-teleagent doctor [--json]                完整自检
    dsh-connect-teleagent logout [--all] [--json]        清除登录态（只删凭据）
    dsh-connect-teleagent accounts [--json] [--no-points]  列出本机账号与各自积分
    dsh-connect-teleagent accounts --add [--timeout=<ms>]  添加账号（退出旧账号 → 登录新账号，保留旧账号凭据）
    dsh-connect-teleagent accounts --to=<scope> [--dry-run]  切换当前账号
    dsh-connect-teleagent accounts --claim=<scope>         用该账号自己的凭据领取今日积分
    dsh-connect-teleagent accounts --delete=<scope> [--purge] [--dry-run]
                                                           删除账号（默认只摘登录态；--purge 移入回收站）

  说明：
    status 默认不发聊天请求；加 --probe 才探测聊天通道（会产生真实流量）
    logout 默认只清"当前"账号，--all 清全部；技能/记忆不受影响
    accounts --add 会先备份当前账号登录态；等待你在 TeleAgent 里换号登录后自动写回
`)
}

let code = 1
switch (command) {
  case 'status':
    code = await runStatus()
    break
  case 'doctor':
    code = runDoctor()
    break
  case 'logout':
    code = await runLogout()
    break
  case 'accounts':
    code = await runAccounts()
    break
  case 'help':
  case '--help':
  case '-h':
    usage()
    code = 0
    break
  default:
    console.error(`未知子命令：${command}`)
    usage()
    code = 1
}

// 用 exitCode 而不是 process.exit()：后者可能截断尚未 flush 的 stdout（管道场景）
process.exitCode = code
