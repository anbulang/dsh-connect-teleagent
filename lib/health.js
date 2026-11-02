/**
 * 上游错误分类与最近一次错误的共享状态。
 *
 * 上游返回的错误码有明确语义，直接透传会让用户只看到「API 密钥无效」
 * 这种笼统提示。这里把关键错误码翻译成「原因 + 用户该做什么」，
 * 并缓存最近一次错误供状态卡片显示。
 */

/** 已知的上游业务错误码 */
const KNOWN = {
  40104: {
    code: 'signature_invalid',
    message: '请求签名被拒绝',
    remedy: 'TeleAgent 可能升级了签名协议：更新插件，或运行 node lib/doctor.js 查看详情',
  },
  40108: {
    code: 'token_invalid',
    message: '登录凭据无效',
    remedy: '在 TeleAgent 桌面端重新登录',
  },
  40109: {
    code: 'account_banned',
    message: '账号已被 TeleAgent 封禁',
    remedy: '该账号在上游被禁用（所有模型都会拒绝）。请联系天翼 AI 客服申诉，或换一个账号登录',
  },
  4001: {
    code: 'token_missing',
    message: '令牌不存在',
    remedy: '在 TeleAgent 桌面端重新登录',
  },
  40110: {
    code: 'account_disabled',
    message: '账号已被停用',
    remedy: '联系客服确认账号状态，或换一个账号登录',
  },
  // ---- 额度 / 限流（这些是"某个账号此刻"的状态，不是配置问题）
  402: {
    code: 'insufficient_credits',
    message: '积分不足',
    remedy: '在设置卡片里领取每日积分，或等积分到账后再试',
  },
  4029: {
    code: 'insufficient_credits',
    message: '积分不足',
    remedy: '领取每日积分后重试',
  },
  429: {
    code: 'rate_limited',
    message: '请求过于频繁',
    remedy: '稍等一会儿再发；插件已做并发与每分钟限速，持续出现请把日志发我',
  },
  4290: {
    code: 'rate_limited',
    message: '请求过于频繁',
    remedy: '稍等一会儿再发',
  },
  // ---- 模型侧
  1210: {
    code: 'content_type_unsupported',
    message: '该模型不支持这种内容类型（例如图片）',
    remedy: '换成 chat-pro / chat-flash（实测支持图片），或去掉附件',
  },
  40001: {
    code: 'model_unavailable',
    message: '模型暂不可用',
    remedy: '换一个模型，或稍后重试',
  },
}

/**
 * 把上游响应分类成结构化错误。永不抛错。
 * @param {number} status HTTP 状态码
 * @param {any} json 解析后的响应体（可能为 null）
 * @param {string} text 原始响应文本（用于兜底）
 */
export function classifyUpstreamError(status, json, text = '') {
  const rawCode = json?.code ?? json?.error?.code
  const numericCode = Number(rawCode)
  const known = Number.isFinite(numericCode) ? KNOWN[numericCode] : undefined
  if (known !== undefined) {
    return { ...known, httpStatus: status, upstreamCode: numericCode }
  }
  const message = json?.message ?? json?.error?.message ?? String(text).slice(0, 300)

  // ---- HTTP 层的通用语义（没有命中业务码时使用）
  if (status === 402) {
    return { code: 'insufficient_credits', message: `积分不足：${message}`, remedy: '领取每日积分后重试', httpStatus: status }
  }
  if (status === 429) {
    return { code: 'rate_limited', message: `请求过于频繁：${message}`, remedy: '稍等一会儿再发', httpStatus: status }
  }
  if (status === 401 || status === 403) {
    return { code: 'auth_rejected', message: `认证被拒绝：${message}`, remedy: '在 TeleAgent 桌面端重新登录后重试', httpStatus: status }
  }
  if (status === 404) {
    return { code: 'endpoint_changed', message: `接口不存在：${message}`, remedy: 'TeleAgent 可能改了路径，运行 node lib/doctor.js', httpStatus: status }
  }
  if (status === 413) {
    return { code: 'payload_too_large', message: `请求体过大：${message}`, remedy: '减少工具数量或附件体积；这不是账号问题', httpStatus: status }
  }
  if (status >= 500) {
    return { code: 'upstream_unavailable', message: `上游服务异常（HTTP ${status}）：${message}`, remedy: '稍后重试；持续出现说明是上游故障', httpStatus: status }
  }
  return { code: 'upstream_error', message: String(message), httpStatus: status }
}

// ------------------------------------------------------------ 最近错误缓存

let last = null

/** 记录一次上游错误（供状态卡片读取） */
export function recordUpstreamError(error) {
  last = { ...error, at: Date.now() }
}

/** 清除错误（成功请求后调用） */
export function clearUpstreamError() {
  last = null
}

/** 读取最近一次上游错误 */
export function readUpstreamError() {
  return last
}

/** 把错误渲染成一行人类可读文本 */
export function describeUpstreamError(error) {
  if (!error) return ''
  const parts = [error.message]
  if (error.remedy) parts.push(error.remedy)
  return parts.filter(Boolean).join('；')
}
