/**
 * 图片附件：把宿主的「持久附件服务」透传给 pi-ai 适配器。
 *
 * DSH 的 `PiAiAdapter` 只有在拿到 `resolveAttachments` / `resolveImageAccess`
 * 时才会把图片（`ImageBlock` 里的 `ImageAttachmentRef`）解析成确定性的请求
 * 版本；否则在发送前就直接失败：
 *
 *   UnsupportedContent: pi-ai image input requires the durable attachment service
 *
 * 官方 `dsh-llm-pi-ai` / `dsh-llm-deepseek` 都是这样接的：
 *
 * ```ts
 * resolveAttachments: () => ctx.get('attachments'),
 * resolveImageAccess: (attachments, ref) =>
 *   resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
 * ```
 *
 * 本插件用软探测（`ctx.get`），在没挂附件服务的精简 profile 里保持原行为。
 *
 * @param ctx 插件上下文（只用到 `ctx.get`）
 * @param resolveImageAttachmentAccess `@deepseek-ai/dsh-llm` 导出的解析器
 * @returns 传给 `new PiAiAdapter({ ... })` 的两个依赖
 */
export function createAttachmentDeps(ctx, resolveImageAttachmentAccess) {
  const get = (name) => {
    try {
      return ctx?.get?.(name)
    } catch {
      return undefined
    }
  }
  return {
    resolveAttachments: () => get('attachments'),
    resolveImageAccess: (attachments, ref) =>
      typeof resolveImageAttachmentAccess === 'function'
        ? resolveImageAttachmentAccess(
            attachments,
            (hostPath) => get('fs')?.processPathFromHostPath?.(hostPath),
            ref,
          )
        : undefined,
  }
}
