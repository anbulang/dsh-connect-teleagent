import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import http from 'node:http'
import { startMcpServer } from '../lib/mcp-server.js'

// Never inspect or clear the developer's real TeleAgent credentials.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-local-access-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = path.join(home, '.dsh')
delete process.env.TELEAI_TA_DEVICE_DATA_DIR
delete process.env.TELEAGENT_CONFIG_DIR
after(() => fs.rmSync(home, { recursive: true, force: true }))

const { loopbackOrigin, sameOriginRequest, registerStatusRoutes } = await import('../lib/status.js')

function request({ host = '127.0.0.1:52200', origin, site, peer = '127.0.0.1', encrypted = false, method = 'GET', url = '/', body, contentType = 'application/json' } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  req.method = method
  req.url = url
  req.socket = { remoteAddress: peer, encrypted }
  req.headers = { host }
  if (origin !== undefined) req.headers.origin = origin
  if (site !== undefined) req.headers['sec-fetch-site'] = site
  if (body !== undefined) {
    req.headers['content-length'] = String(Buffer.byteLength(body))
    if (contentType !== undefined) req.headers['content-type'] = contentType
  }
  return req
}

function response() {
  return {
    status: null, body: null,
    writeHead(status) { this.status = status },
    end(body) { this.body = body ? JSON.parse(String(body)) : null },
  }
}

test('local authority rejects attacker prefixes and malformed Host values', () => {
  for (const host of [
    'localhost.attacker.example:52200', '127.0.0.1.attacker.example:52200',
    '[::1].attacker.example:52200', 'localhost@attacker.example:52200',
    'localhost:52200/path', 'localhost:52200?query', 'localhost:52200#fragment',
    'localhost:52200,localhost:52200', 'localhost:65536', 'localhost:',
    '127.1:52200', '2130706433:52200', 'localhost.:52200', '', ['localhost:52200'],
  ]) assert.equal(loopbackOrigin(request({ host })), false, JSON.stringify(host))
})

test('local authority allows supported loopback hosts and mapped loopback peers', () => {
  for (const host of ['127.0.0.1:52200', 'localhost:52200', 'LOCALHOST:52200', '[::1]:52200', '[0:0:0:0:0:0:0:1]:52200']) {
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      assert.equal(loopbackOrigin(request({ host, peer })), true, `${host} via ${peer}`)
    }
  }
})

test('a spoofed local Host does not authorize a non-loopback socket', () => {
  for (const peer of ['192.168.1.10', '10.0.0.2', '203.0.113.1', '::ffff:192.168.1.10', '2001:db8::1', 'fe80::1%lo']) {
    assert.equal(loopbackOrigin(request({ peer })), false, peer)
  }
})

test('Origin comparison uses the actual transport, strict syntax and effective port', () => {
  for (const origin of [
    'https://127.0.0.1:52200', 'http://127.0.0.1:52201', 'http://localhost:52200',
    'null', '', 'http://user@127.0.0.1:52200', 'http://127.0.0.1:52200/path',
    'http://127.0.0.1:52200?query', 'http://127.0.0.1:52200#fragment',
    'http://127.0.0.1:52200 http://evil.example', ['http://127.0.0.1:52200'],
  ]) assert.equal(sameOriginRequest(request({ origin })), false, JSON.stringify(origin))
  assert.equal(sameOriginRequest(request({ origin: 'http://127.0.0.1:52200' })), true)
  assert.equal(sameOriginRequest(request({ host: '127.0.0.1:80', origin: 'http://127.0.0.1' })), true)
  assert.equal(sameOriginRequest(request({ host: 'localhost:443', origin: 'https://localhost', encrypted: true })), true)
  assert.equal(sameOriginRequest(request({ host: 'localhost', origin: 'https://localhost' })), false)
  assert.equal(sameOriginRequest(request({ host: 'localhost:80', origin: 'https://localhost', encrypted: true })), false)
  assert.equal(sameOriginRequest(request({ host: '[::1]:52200', origin: 'http://[::1]:52200' })), true)
})

test('Origin-less native clients remain supported but explicit browser cross-site metadata is rejected', () => {
  for (const site of [undefined, 'none', 'same-origin']) assert.equal(sameOriginRequest(request({ site })), true)
  for (const site of ['cross-site', 'same-site', 'invalid', ['same-origin', 'cross-site']]) {
    assert.equal(sameOriginRequest(request({ site })), false, JSON.stringify(site))
  }
})

const routeCases = [
  ['status', 'GET', ''], ['accounts', 'GET', '?points=1'], ['welfare', 'GET', '?refresh=1'],
  ['login', 'GET', '?mode=add'], ['tools', 'POST', ''], ['models', 'POST', ''],
  ['logout', 'POST', ''], ['probe', 'POST', ''],
  ['accounts', 'POST', ''], ['welfare', 'POST', ''], ['login', 'POST', ''],
]

for (const [attack, overrides] of [
  ['DNS-rebinding authority', { host: 'localhost.attacker.example:52200', origin: 'http://localhost.attacker.example:52200' }],
  ['foreign Origin', { origin: 'https://attacker.example' }],
  ['Origin-less cross-site fetch', { site: 'cross-site' }],
  ['non-loopback peer', { peer: '192.168.1.10' }],
]) {
  test(`every registered route rejects ${attack} before accessing dependencies`, async (t) => {
    let accessed = 0
    const handlers = new Map()
    const dispose = registerStatusRoutes({
      webServer: { register({ path, handler }) { handlers.set(path, handler); return () => handlers.delete(path) } },
      deps: () => { accessed++; throw new Error('unauthorized dependency access') },
    })
    t.after(dispose)
    for (const [name, method, query] of routeCases) {
      await t.test(`${method} ${name}${query}`, async () => {
        const route = `/plugins/dsh-connect-teleagent/${name}`
        const req = request({ ...overrides, method, url: route + query, ...(method === 'POST' ? { body: '{}' } : {}) })
        const res = response()
        await handlers.get(route)(req, res)
        assert.equal(res.status, 403)
        assert.equal(accessed, 0)
      })
    }
  })
}

test('local same-origin UI and Origin-less CLI retain GET, JSON POST and bodyless login access', async (t) => {
  let logins = 0
  let tools = null
  const handlers = new Map()
  const dispose = registerStatusRoutes({
    webServer: { register({ path, handler }) { handlers.set(path, handler); return () => handlers.delete(path) } },
    deps: () => ({
      listAccounts: () => [{ scope: 'synthetic-test-account', hasToken: false }],
      toolsAllowlist: () => tools,
      setToolsAllowlist: (value) => { tools = value; return { ok: true, via: 'store', value } },
      startLoginFlow: () => { logins++; return { ok: true } },
    }),
  })
  t.after(dispose)
  for (const origin of [undefined, 'http://127.0.0.1:52200']) {
    for (const [name, method, body] of [['accounts', 'GET'], ['tools', 'POST', '{"toolsAllowlist":["read"]}'], ['login', 'POST']]) {
      const route = `/plugins/dsh-connect-teleagent/${name}`
      const res = response()
      await handlers.get(route)(request({ origin, method, body, url: route }), res)
      assert.equal(res.status, 200, `${method} ${name}: ${JSON.stringify(res.body)}`)
    }
  }
  assert.equal(logins, 2)
  assert.deepEqual(tools, ['read'])
})

function httpCall(url, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      if (res.headers['content-type'] === 'text/event-stream') {
        resolve({ status: res.statusCode, body: null })
        res.destroy()
        return
      }
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('MCP rejects browser-simple tool injection and rebinding before callbacks or stats change', async (t) => {
  let calls = 0
  const server = await startMcpServer({ getTools: () => [], onCall: async () => { calls++; return 'fake result' } })
  t.after(() => server.close())
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read', arguments: {} } })
  for (const headers of [
    { origin: 'https://attacker.example', 'content-type': 'text/plain' },
    { host: 'localhost.attacker.example:52200', origin: 'http://localhost.attacker.example:52200', 'content-type': 'application/json' },
    { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
  ]) {
    const result = await httpCall(server.url, { headers, body })
    assert.equal(result.status, 403)
    assert.equal(calls, 0)
    assert.equal(server.stats.called, 0)
  }
  const text = await httpCall(server.url, { headers: { 'content-type': 'text/plain' }, body })
  assert.equal(text.status, 415)
  assert.equal(calls, 0)
})

test('MCP protects SSE and session termination from foreign browser requests', async (t) => {
  const server = await startMcpServer()
  t.after(() => server.close())
  for (const method of ['GET', 'DELETE']) {
    assert.equal((await httpCall(server.url, { method, headers: { origin: 'https://attacker.example' } })).status, 403)
  }
})

test('MCP native JSON RPC, same-origin clients, SSE and DELETE remain usable', async (t) => {
  let calls = 0
  const server = await startMcpServer({
    getTools: () => [{ function: { name: 'read' } }],
    onCall: async () => { calls++; return 'fake result' },
  })
  t.after(() => server.close())
  for (const origin of [undefined, new URL(server.url).origin]) {
    for (const method of ['initialize', 'tools/list', 'tools/call', 'ping']) {
      const result = await httpCall(server.url, {
        headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { name: 'read', arguments: {} } }),
      })
      assert.equal(result.status, 200)
      assert.ok(result.body.result)
    }
  }
  assert.equal(calls, 2)
  assert.equal((await httpCall(server.url, { method: 'GET' })).status, 200)
  assert.equal((await httpCall(server.url, { method: 'DELETE' })).status, 200)
})
