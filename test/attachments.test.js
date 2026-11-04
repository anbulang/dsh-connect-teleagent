/**
 * 图片附件依赖透传（pi-ai adapter 的 resolveAttachments / resolveImageAccess）。
 *
 * 回归背景：不传这两个依赖时，pi-ai 在发请求前直接报
 * `UNSUPPORTED_CONTENT: pi-ai image input requires the durable attachment service`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createAttachmentDeps } from '../lib/attachments.js'

test('createAttachmentDeps: resolveAttachments 读宿主的 attachments 服务', () => {
  const service = { admitPromptContent: () => {} }
  const deps = createAttachmentDeps({ get: (name) => (name === 'attachments' ? service : undefined) }, undefined)
  assert.equal(deps.resolveAttachments(), service)
})

test('createAttachmentDeps: resolveImageAccess 透传服务、路径映射和 ref', () => {
  const service = { imageHostPath: () => '/host/object' }
  const seen = []
  const resolver = (attachments, mapHostPath, ref) => {
    seen.push([attachments, mapHostPath('/host/object'), ref])
    return { kind: 'resolved' }
  }
  const deps = createAttachmentDeps({
    get: (name) => {
      if (name === 'attachments') return service
      if (name === 'fs') return { processPathFromHostPath: (p) => `/process${p}` }
      return undefined
    },
  }, resolver)
  const ref = { id: 'img_1' }
  assert.deepEqual(deps.resolveImageAccess(service, ref), { kind: 'resolved' })
  assert.deepEqual(seen, [[service, '/process/host/object', ref]])
})

test('createAttachmentDeps: 没有附件服务/解析器时保持 undefined（精简 profile 不崩）', () => {
  const deps = createAttachmentDeps({ get: () => undefined }, undefined)
  assert.equal(deps.resolveAttachments(), undefined)
  assert.equal(deps.resolveImageAccess(undefined, { id: 'x' }), undefined)
})

test('createAttachmentDeps: ctx.get 抛错时软降级', () => {
  const deps = createAttachmentDeps({ get: () => { throw new Error('service unavailable') } }, undefined)
  assert.equal(deps.resolveAttachments(), undefined)
})
