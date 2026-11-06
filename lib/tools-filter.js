/**
 * 工具白名单：DSH 会把**所有插件**的工具都塞进每次请求（实测 255 个，
 * 光 schema 就有 875 KB ≈ 22 万 tokens）。这些 schema 每一步都会重发，
 * 是长会话烧积分/变慢的最大固定成本。
 *
 * 这里按配置裁剪真正挂给内核的 MCP 工具集：
 *  - 未配置（undefined/null/[]）→ 原样全发，保持旧行为
 *  - 支持精确名字，也支持后缀通配 `bash*`
 *  - 配置了但一个都没匹配上 → 回退全量并发警告，避免把用户的工具全关掉
 */

/** 取 OpenAI/pi-ai 工具条目的名字 */
export function toolName(tool) {
  const fn = tool?.function ?? tool
  return typeof fn?.name === 'string' ? fn.name : undefined
}

/**
 * @param {any[]} tools DSH 传来的工具定义
 * @param {string[]|null|undefined} allowlist 白名单（支持 `foo*`）
 * @returns {{tools:any[], applied:boolean, dropped:number, kept:number, empty:boolean}}
 */
export function filterTools(tools, allowlist) {
  const list = Array.isArray(tools) ? tools : []
  const names = Array.isArray(allowlist)
    ? allowlist.filter((x) => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
    : []
  if (names.length === 0) return { tools: list, applied: false, dropped: 0, kept: list.length, empty: false }
  if (names.includes('*')) return { tools: list, applied: false, dropped: 0, kept: list.length, empty: false }
  const matches = (name) => names.some((pattern) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern))
  const kept = list.filter((tool) => {
    const name = toolName(tool)
    return typeof name === 'string' && matches(name)
  })
  if (kept.length === 0) {
    // 配置写错时不静默禁用全部工具：回退全量，由调用方记录警告
    return { tools: list, applied: false, dropped: 0, kept: list.length, empty: true }
  }
  return { tools: kept, applied: true, dropped: list.length - kept.length, kept: kept.length, empty: false }
}

/**
 * 估算一次请求的 prompt tokens（bytes/4 的粗估），可替换工具数组后再算，
 * 用来在状态卡片上显示“上次请求大概多少 token”。
 *
 * @param {any} body 原始请求体
 * @param {any[]} [toolsOverride] 实际发给内核的工具
 * @returns {{bytes:number, tokensApprox:number, toolBytes:number}}
 */
export function estimatePrompt(body, toolsOverride) {
  let bytes = 0
  let toolBytes = 0
  try {
    bytes = JSON.stringify(body).length
    const original = Array.isArray(body?.tools) ? body.tools : []
    toolBytes = JSON.stringify(original).length
    if (Array.isArray(toolsOverride)) {
      bytes = bytes - toolBytes + JSON.stringify(toolsOverride).length
      toolBytes = JSON.stringify(toolsOverride).length
    }
  } catch { /* 不可序列化时按 0 处理 */ }
  // 中英文混排按 4 字节/token 粗估（英文 JSON 接近 4，中文更少，取保守值）
  return { bytes, toolBytes, tokensApprox: Math.round(bytes / 4) }
}
