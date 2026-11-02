/**
 * 模型清单与应用路径解析。
 *
 * 这些是**静态元数据**，与运行时架构无关：模型目录来自 TeleAgent 内置的
 * 5 个 NewApi 模型（`creditMultiplier` 是积分倍率，不是余额），路径来自桌面端
 * 默认的 XDG 位置。
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * 五个内置模型（顺序即选择器顺序）。
 *
 * `vision` 是**实测结论**，不是上游目录的声明：
 * 用同一张「蓝色三角形 + 文字 42」的图片逐个测，能正确读出的才算支持。
 *
 *   chat-pro       ✅ 正确识别
 *   chat-flash     ✅ 正确识别
 *   chat-lite      ❌ 返回 200 但内容与图片无关（胡编），不算支持
 *   chat-nano      ❌ HTTP 400 "telechat-29b is not a multimodal model"
 *   chat-flagship  ❌ HTTP 400 code 1210（参数不支持 image 内容块）
 *
 * 注意：客户端自己的能力目录里 chat-pro/chat-flash 标的是 `Input.Image:false`，
 * 与实测不符——以实测为准。
 */
export const MODELS = [
  { id: 'chat-pro', name: '智能', contextWindow: 400000, maxTokens: 65536, creditMultiplier: '0.6', vision: true },
  { id: 'chat-flagship', name: '旗舰', contextWindow: 400000, maxTokens: 65536, creditMultiplier: '1.0', vision: false },
  { id: 'chat-flash', name: '极速', contextWindow: 400000, maxTokens: 65536, creditMultiplier: '0.2', vision: true },
  { id: 'chat-lite', name: '轻量', contextWindow: 100000, maxTokens: 65536, creditMultiplier: '0.5', vision: false },
  { id: 'chat-nano', name: '轻速', contextWindow: 100000, maxTokens: 65536, creditMultiplier: '0.1', vision: false },
]

/** 支持图片输入的模型 id 集合 */
export const VISION_MODEL_IDS = MODELS.filter((m) => m.vision === true).map((m) => m.id)

/** TeleAgent 桌面端的数据/配置目录 */
export function appPaths(home = process.env.HOME) {
  return {
    home,
    data: path.join(home, '.local', 'share', 'TeleAgent'),
    config: path.join(home, '.config', 'TeleAgent'),
  }
}

/**
 * 当前登录的账号作用域目录名。
 *
 * 优先读 `current-owner.json` 的 `ownerDir`；否则在 `users/` 下找唯一一个
 * 带 `app-auth/token.json` 的目录。
 */
export function currentScope(data = appPaths().data) {
  const ownerFile = path.join(data, 'current-owner.json')
  try {
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
    if (typeof owner?.ownerDir === 'string' && owner.ownerDir.length > 0) return owner.ownerDir
  } catch { /* 回退到目录扫描 */ }

  const usersDir = path.join(data, 'users')
  let entries = []
  try { entries = fs.readdirSync(usersDir, { withFileTypes: true }) } catch { /* 无 users 目录 */ }
  // 可能同时存在多个账号目录（切换过账号）；选 token.json 最新的那个，
  // 而不是依赖目录顺序——否则换账号后可能仍读到旧账号的凭据。
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const tokenFile = path.join(usersDir, entry.name, 'app-auth', 'token.json')
    try {
      const st = fs.statSync(tokenFile)
      candidates.push({ name: entry.name, mtime: st.mtimeMs })
    } catch { /* 该账号无凭据 */ }
  }
  if (candidates.length === 0) throw new Error('未找到已登录账号（缺少 app-auth/token.json）')
  if (candidates.length === 1) return candidates[0].name
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0].name
}
