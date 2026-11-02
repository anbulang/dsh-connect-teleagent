/**
 * 只读 DSH 工具：`teleagent_points`。
 *
 * 让模型自己能回答"我还有多少积分 / 今天领了没"，而不是让用户来问插件卡片。
 *
 * ## 边界（重要）
 *
 * 这个工具**只读 portal**（`/meter/super-agent/user/portal/*`），
 * 不触发任何模型调用、不消耗积分、不会自动领取。
 * 原因见工作区 `AGENTS.md`：合成/多余的聊天请求是导致两次封号的直接因素之一，
 * 所以这里刻意不提供任何"测试模型"之类的动作。
 */
import { readPortalAuth, fetchPoints, fetchDailyStatus, fetchUserCenter } from './portal.js'

export const POINTS_TOOL_NAME = 'teleagent_points'

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '是否读取成功' },
    balance: { type: ['number', 'null'], description: '当前可用积分' },
    expiresAt: { type: ['string', 'null'], description: '最近一笔积分的到期时间' },
    planName: { type: ['string', 'null'], description: '套餐名称' },
    claimedToday: { type: ['boolean', 'null'], description: '今日是否已领' },
    claimable: { type: ['number', 'null'], description: '今日可领积分' },
    totalClaimDays: { type: ['number', 'null'], description: '累计领取天数' },
    totalClaimedPoints: { type: ['number', 'null'], description: '累计领取积分' },
    error: { type: ['string', 'null'], description: '失败原因' },
  },
  required: ['ok'],
  additionalProperties: false,
}

/** 渲染成给模型看的一小段文本 */
export function renderPoints(value) {
  if (!value?.ok) {
    return [{ type: 'text', text: `读取 TeleAgent 积分失败：${value?.error ?? '未知原因'}` }]
  }
  const lines = [
    `积分余额：${value.balance === null ? '未知' : Number(value.balance).toFixed(2)}`,
  ]
  if (value.expiresAt) lines.push(`最近到期：${String(value.expiresAt).slice(0, 10)}`)
  if (value.planName) lines.push(`套餐：${value.planName}`)
  if (value.claimedToday === true) {
    lines.push(`今日已领取${value.totalClaimDays ? `（累计 ${value.totalClaimDays} 天 / ${value.totalClaimedPoints ?? 0} 积分）` : ''}`)
  } else if (value.claimedToday === false) {
    lines.push(`今日可领：${value.claimable ?? 0} 积分（在设置卡片里点「领取」，或开启自动领取）`)
  }
  lines.push('（这是只读查询，不会消耗积分，也不会触发领取）')
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * 读取一次积分快照（只读）。
 * portal 注入仅用于测试，生产不传。
 */
export async function readPointsSnapshot(portal) {
  const api = portal ?? { readPortalAuth, fetchPoints, fetchDailyStatus, fetchUserCenter }
  const auth = await api.readPortalAuth()
  if (!auth) {
    return { ok: false, error: '未登录（缺少 portal 凭据）：请先在 TeleAgent 桌面端登录' }
  }

  const [points, daily, center] = await Promise.all([
    api.fetchPoints(auth).catch((e) => ({ ok: false, error: String(e?.message ?? e) })),
    api.fetchDailyStatus(auth).catch((e) => ({ ok: false, error: String(e?.message ?? e) })),
    api.fetchUserCenter(auth).catch(() => ({ ok: false })),
  ])

  if (!points.ok) return { ok: false, error: points.error ?? '读取积分失败' }

  return {
    ok: true,
    balance: points.balance ?? null,
    expiresAt: points.expiresAt ?? null,
    planName: center.ok ? (center.planName ?? null) : null,
    claimedToday: daily.ok ? daily.claimedToday : null,
    claimable: daily.ok ? daily.claimable : null,
    totalClaimDays: daily.ok ? daily.totalDays : null,
    totalClaimedPoints: daily.ok ? daily.totalPoints : null,
    error: null,
  }
}

/**
 * 挂载工具。
 * @param {object} tools DSH 的 tools 服务（`ctx.tools`）
 * @param {object} [options]
 * @param {object} [options.portal] 测试注入
 * @returns {() => void} disposer
 */
export function mountPointsTool(tools, options = {}) {
  if (tools === undefined || typeof tools.register !== 'function') return () => {}
  try {
    return tools.register({
      name: POINTS_TOOL_NAME,
      description: '查询本机登录的 TeleAgent 账号积分余额与每日领取状态。只读：不消耗积分、不触发领取、不发起任何模型调用。',
      timeoutMs: 20_000,
      parameters: { type: 'object', properties: {}, required: [] },
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderPoints(value) },
      async execute() {
        return readPointsSnapshot(options.portal)
      },
    })
  } catch (error) {
    options.logger?.warn?.('dsh-connect-teleagent: 注册 teleagent_points 失败', error)
    return () => {}
  }
}
