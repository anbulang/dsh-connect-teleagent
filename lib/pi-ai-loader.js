/**
 * pi-ai 适配器加载器（容错）。
 *
 * 为什么需要候选列表：DSH 在临时沙箱（`…/T/te-harness/`）里用**桩包**提供 pi-ai，
 * 而那个桩包的 `api/openai-completions.lazy` 是个**目录**（只有 index.js，
 * 没有 exports 映射）。Node 的 ESM 不支持目录导入，直接 import 会抛
 * `ERR_UNSUPPORTED_DIR_IMPORT`，导致整个 boot 失败 —— shim 根本没起来，
 * 宿主调用时就表现为 `ECONNREFUSED`。
 *
 * 所以按"最标准 → 最具体"的顺序尝试，谁都行就用谁。
 */
export const PI_AI_ADAPTER_SPECIFIERS = [
  '@earendil-works/pi-ai/api/openai-completions.lazy',
  '@earendil-works/pi-ai/api/openai-completions.lazy/index.js',
]

export async function loadOpenAICompletionsApi(load = (specifier) => import(specifier)) {
  const failures = []

  for (const specifier of PI_AI_ADAPTER_SPECIFIERS) {
    try {
      const mod = await load(specifier)
      if (typeof mod?.openAICompletionsApi === 'function') return mod
      failures.push(`${specifier}: 没有导出 openAICompletionsApi`)
    } catch (error) {
      failures.push(`${specifier}: ${error?.code ?? error?.message ?? error}`)
    }
  }

  // 兜底：有些版本把它挂在主包上
  try {
    const main = await load('@earendil-works/pi-ai')
    if (typeof main?.openAICompletionsApi === 'function') return main
    failures.push('@earendil-works/pi-ai: 没有导出 openAICompletionsApi')
  } catch (error) {
    failures.push(`@earendil-works/pi-ai: ${error?.code ?? error?.message ?? error}`)
  }

  throw new Error(
    `无法加载 pi-ai 的 openai-completions 适配器（已尝试 ${PI_AI_ADAPTER_SPECIFIERS.length + 1} 种方式）：\n  ${failures.join('\n  ')}`,
  )
}
