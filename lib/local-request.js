/**
 * Browser-to-local HTTP boundary shared by the settings routes and MCP bridge.
 * This is not authentication against other local processes. Native clients may
 * omit Origin; browser requests must not carry foreign Origin/Fetch Metadata.
 * Forwarded headers are intentionally ignored: there is no trusted-proxy contract.
 */
import { isIP } from 'node:net'

function authority(value, protocol) {
  if (typeof value !== 'string') return null
  // Parse an authority, not a URL: reject userinfo, paths, query, fragments,
  // whitespace, multiple values and empty ports before URL normalization.
  const match = /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]+))?$/.exec(value)
  if (!match) return null
  try {
    const url = new URL(`${protocol}//${value}`)
    return { rawHost: match[1].toLowerCase(), hostname: url.hostname, origin: url.origin }
  } catch { return null }
}

function loopbackAddress(value) {
  if (typeof value !== 'string') return false
  if (isIP(value) === 4) return value.startsWith('127.')
  if (isIP(value) !== 6 || value.includes('%')) return false
  const host = new URL(`http://[${value}]`).hostname
  if (host === '[::1]') return true
  const mapped = /^\[::ffff:([0-9a-f]+):([0-9a-f]+)\]$/.exec(host)
  return mapped !== null && (parseInt(mapped[1], 16) >>> 8) === 127
}

function protocolOf(req) {
  return req?.socket?.encrypted === true ? 'https:' : 'http:'
}

/** Validate an exact loopback Host and reject a known non-loopback TCP peer. */
export function loopbackOrigin(req) {
  const host = authority(req?.headers?.host, protocolOf(req))
  if (!host) return false
  const localHost = host.rawHost === 'localhost'
    || (isIP(host.rawHost) === 4 && loopbackAddress(host.rawHost))
    || (host.rawHost.startsWith('[') && host.hostname === '[::1]')
  if (!localHost) return false
  // Some legacy host wrappers expose no socket. Do not invent proxy trust when
  // one is available, and recognize Node's IPv4-mapped loopback representation.
  const peer = req?.socket?.remoteAddress
  return peer === undefined || loopbackAddress(peer)
}

/** Same-origin browser checks also apply to GETs, which can omit Origin. */
export function sameOriginRequest(req) {
  const site = req?.headers?.['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
  const raw = req?.headers?.origin
  if (raw === undefined) return true // Native clients and same-origin GETs.
  if (typeof raw !== 'string') return false
  const match = /^(https?):\/\/([^/?#\s\\]+)$/.exec(raw)
  if (!match) return false // Includes opaque/null and non-serialized origins.
  const source = authority(match[2], `${match[1]}:`)
  const target = authority(req?.headers?.host, protocolOf(req))
  return source !== null && target !== null && source.origin === target.origin
}

function reject(res, status, error, reason) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify({ error, reason }))
  return false
}

/** Run before any dependency lookup or side effect, for every HTTP method. */
export function localRequestGuard(req, res) {
  if (!loopbackOrigin(req) || !sameOriginRequest(req)) {
    return reject(res, 403, 'forbidden', '只接受本机同源请求')
  }
  return true
}

/** Preserve bodyless login requests; bodies must use non-simple JSON media type. */
export function mutationGuard(req, res) {
  if (!localRequestGuard(req, res)) return false
  const length = Number(req?.headers?.['content-length'] ?? 0)
  const hasBody = (Number.isFinite(length) && length > 0) || req?.headers?.['transfer-encoding'] !== undefined
  if (hasBody) {
    const raw = req?.headers?.['content-type']
    const type = typeof raw === 'string' ? raw.split(';')[0].trim().toLowerCase() : ''
    if (type !== 'application/json') return reject(res, 415, 'unsupported media type', '只接受 application/json')
  }
  return true
}
