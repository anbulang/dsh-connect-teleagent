/**
 * 图片请求预算（pi-ai profile 字段）。
 *
 * DSH 的 `PiAiAdapter` 用 profile 上的这三个字段给每张图片算「请求尺寸」：
 *
 * ```ts
 * requestImageTarget(image, {
 *   maxPixels: profile.requestImagePixelBudget,
 *   maxBytes: profile.requestImageMaxBytes,
 * })
 * ```
 *
 * 插件是手动构造 profile（不经过 dsh-llm-pi-ai 的 Config schema），所以 schema 的
 * `.default()` 不会生效。字段缺失时 `requestImageDimensions(width, height, undefined)`
 * 会算出非正整数宽高，附件服务随后抛：
 *
 *   Image request width must be a positive integer.
 *
 * 这里显式补上，数值与官方默认值一致（20 MiB / 2048² / 1 MiB）。
 */
export const IMAGE_REQUEST_BUDGET = Object.freeze({
  /** 单次请求里累计 base64 图片负载上限（20 MiB） */
  maxRequestImageBytes: 20 * 1024 * 1024,
  /** 单张请求图片的总像素预算（2048 × 2048） */
  requestImagePixelBudget: 2048 * 2048,
  /** 单张请求图片的目标字节数（1 MiB） */
  requestImageMaxBytes: 1024 * 1024,
})
