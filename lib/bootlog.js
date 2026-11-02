/**
 * 插件引导日志。
 *
 * 插件运行在 DSH 进程内，`ctx.logger` 的输出不一定落到任何文件里；
 * 排查启动失败时只能靠猜。这里把**每个装配阶段**追加写入一个固定文件，
 * 出问题时可以直接读，而不必反复重启、靠控制台观察。
 *
 * 只记录阶段名与错误信息，**不记录 token、密钥或请求体**。
 */
import fs from 'node:fs'
import path from 'node:path'

const MAX_BYTES = 512 * 1024

function logPath() {
  const dshHome = process.env.DSH_HOME ?? path.join(process.env.HOME ?? '', '.dsh')
  return path.join(dshHome, 'teleagent-boot.log')
}

/**
 * 追加一行引导日志（永不抛错）。
 * @param {string} step 阶段名
 * @param {unknown} [detail] 附加信息（会 JSON 序列化并截断）
 */
export function bootlog(step, detail) {
  try {
    const target = logPath()
    try {
      const st = fs.statSync(target)
      if (st.size > MAX_BYTES) fs.truncateSync(target, 0)
    } catch { /* 文件不存在 */ }

    let extra = ''
    if (detail !== undefined) {
      let text
      if (detail instanceof Error) {
        text = `${detail.name}: ${detail.message}`
        if (detail.code) text += ` [code=${detail.code}]`
        if (detail.stack) text += `\n${String(detail.stack).split('\n').slice(0, 6).join('\n')}`
      } else {
        try { text = JSON.stringify(detail) } catch { text = String(detail) }
      }
      extra = ' ' + String(text).slice(0, 1200)
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.appendFileSync(target, `[${new Date().toISOString()}] ${step}${extra}\n`, 'utf8')
  } catch { /* 日志失败绝不影响主流程 */ }
}

/**
 * 开启一段新的引导日志。
 *
 * **不截断**：之前的实现每次启动都清空，导致排查"上一轮发生了什么"时证据已经没了
 * （2026-10-27 定位封禁原因时就吃了这个亏）。现在改为追加 + 分隔线，
 * 只在超过大小上限时做一次保留尾部的裁剪。
 */
export function resetBootlog() {
  try {
    const target = logPath()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    try {
      const st = fs.statSync(target)
      if (st.size > MAX_BYTES) {
        // 只保留最后一半，避免无限增长
        const buf = fs.readFileSync(target)
        fs.writeFileSync(target, buf.subarray(Math.floor(buf.length / 2)), 'utf8')
      }
    } catch { /* 文件不存在 */ }
    fs.appendFileSync(target, `\n===== 新的启动 ${new Date().toISOString()} =====\n`, 'utf8')
  } catch { /* ignore */ }
}
