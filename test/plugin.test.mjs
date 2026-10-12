/**
 * 插件骨架自测 —— 不需要 DSH 在跑，用 mock ctx 把 apply() 跑一遍。
 *
 *   node --test test/
 *
 * 覆盖：插件元数据、路由注册、Host 校验、几个只读 handler 的真实返回。
 * 不做网络断言（那取决于本机有没有跑网关），只验证接缝本身是对的。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from '../lib/index.js'

/* ---------------------------------------------------------------- mock */

function mockCtx() {
  const routes = new Map()
  const disposers = []
  return {
    routes,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    webServer: {
      register(definition) {
        routes.set(definition.path, definition)
        return () => routes.delete(definition.path)
      },
    },
    disposeAll() {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    },
  }
}

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      Object.assign(this.headers, headers)
      return this
    },
    end(chunk) {
      this.body = chunk ? chunk.toString() : ''
      return this
    },
  }
}

function mockReq(url, method = 'GET', host = '127.0.0.1:8080', body = '') {
  const listeners = {}
  const req = {
    url,
    method,
    headers: { host },
    on(event, cb) {
      listeners[event] = listeners[event] || []
      listeners[event].push(cb)
      // 一旦有人监听 end，就把 body 推过去 —— 模拟真实可读流。
      // 不能在构造时就触发：那时 handler 还没注册监听，事件会丢。
      if (event === 'end' && !req._pushed) {
        req._pushed = true
        queueMicrotask(() => {
          if (body) (listeners.data || []).forEach((fn) => fn(Buffer.from(body)))
          ;(listeners.end || []).forEach((fn) => fn())
        })
      }
      return req
    },
    destroy() {},
  }
  return req
}

async function callRoute(ctx, path, { url, method, host, body } = {}) {
  const route = ctx.routes.get(path)
  assert.ok(route, `路由未注册：${path}`)
  const res = mockRes()
  await route.handler(mockReq(url || path, method || 'GET', host, body), res)
  return res
}

/* ---------------------------------------------------------------- 测试 */

test('插件元数据：name 与 inject 符合 cordis 约定', () => {
  assert.equal(name, 'ai-gateway-console')
  assert.deepEqual(inject, ['webServer'])
})

test('apply() 注册全部路由且可重复调用', () => {
  const ctx = mockCtx()
  apply(ctx, {})
  const expected = [
    '/ai-gateway',
    '/ai-gateway/status',
    '/ai-gateway/config',
    '/ai-gateway/logs',
    '/ai-gateway/console',
    '/ai-gateway/action',
  ]
  for (const path of expected) {
    assert.ok(ctx.routes.has(path), `缺路由：${path}`)
  }
  assert.equal(ctx.routes.size, expected.length)

  // 每个注册都包在 effect 里，dispose 后应该干净
  ctx.disposeAll()
  assert.equal(ctx.routes.size, 0)
})

test('状态页返回 HTML', async () => {
  const ctx = mockCtx()
  apply(ctx, {})
  const res = await callRoute(ctx, '/ai-gateway')
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['Content-Type'], /text\/html/)
  assert.match(res.body, /AI 网关控制台/)
})

test('只接受回环来源：非本机 Host 被 403', async () => {
  const ctx = mockCtx()
  apply(ctx, {})
  for (const path of ['/ai-gateway', '/ai-gateway/status', '/ai-gateway/config']) {
    const res = await callRoute(ctx, path, { host: '10.0.0.5:8080' })
    assert.equal(res.statusCode, 403, `${path} 应该拒绝外网 Host`)
    assert.match(res.body, /forbidden/)
  }
})

test('localhost 与 127.0.0.1 都放行', async () => {
  const ctx = mockCtx()
  apply(ctx, {})
  for (const host of ['127.0.0.1:8080', 'localhost:8080', '[::1]:8080']) {
    const res = await callRoute(ctx, '/ai-gateway/config', { host })
    assert.equal(res.statusCode, 200, `${host} 应该被放行`)
  }
})

test('/ai-gateway/config 返回配置与体检结果', async () => {
  const ctx = mockCtx()
  apply(ctx, {})
  const res = await callRoute(ctx, '/ai-gateway/config')
  assert.equal(res.statusCode, 200)
  const data = JSON.parse(res.body)
  assert.equal(data.ok, true)
  assert.ok(data.config, '应带 config')
  assert.ok(Array.isArray(data.issues), '应带 issues 数组')
  assert.ok(typeof data.file === 'string' && data.file.length > 0, '应带配置文件路径')
})

test('/ai-gateway/logs 对未知来源返回空而不是报错', async () => {
  const ctx = mockCtx()
  apply(ctx, {})
  const res = await callRoute(ctx, '/ai-gateway/logs', { url: '/ai-gateway/logs?src=__nope__&n=5' })
  assert.equal(res.statusCode, 200)
  const data = JSON.parse(res.body)
  assert.equal(data.ok, true)
  assert.ok(Array.isArray(data.lines))
})

test('/ai-gateway/action 拒绝未知动作且不抛异常', async () => {
  const ctx = mockCtx()
  apply(ctx, {})
  const res = await callRoute(ctx, '/ai-gateway/action', {
    method: 'POST',
    body: JSON.stringify({ action: '__nope__' }),
  })
  assert.equal(res.statusCode, 400)
  const data = JSON.parse(res.body)
  assert.equal(data.ok, false)
  assert.match(data.result.error, /未知动作/)
})

test('/ai-gateway/action 只收 POST', async () => {
  const ctx = mockCtx()
  apply(ctx, {})
  const res = await callRoute(ctx, '/ai-gateway/action', { method: 'GET' })
  assert.equal(res.statusCode, 405)
})

test('reload-config 动作只清缓存，不需要外部依赖', async () => {
  const ctx = mockCtx()
  apply(ctx, {})
  const res = await callRoute(ctx, '/ai-gateway/action', {
    method: 'POST',
    body: JSON.stringify({ action: 'reload-config' }),
  })
  assert.equal(res.statusCode, 200)
  const data = JSON.parse(res.body)
  assert.equal(data.ok, true)
})
