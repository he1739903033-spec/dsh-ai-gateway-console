/**
 * dsh-ai-gateway-console — Host 半侧
 *
 * 把「本地 AI 反代网关」的部署状态与控制能力挂进 DeepSeek Harness：
 *
 *   GET  /ai-gateway                 浏览器可直接打开的状态页（含跳转按钮）
 *   GET  /ai-gateway/status          聚合快照（?deep=1 附带控制器存活探测）
 *   GET  /ai-gateway/config          当前生效配置 + 体检结果
 *   POST /ai-gateway/config          写回配置文件
 *   GET  /ai-gateway/logs?src=&n=    日志 tail（trae / wb / hub / 控制器）
 *   POST /ai-gateway/action          动作：start-console / stop-console /
 *                                    start-trae / start-wb / start-all
 *
 * 设计取向：
 *   - 本插件**零外部依赖**，只用 node: 内置模块，profile 下解析不到 node_modules
 *     也不会炸；具名路由是最小且稳定的接缝。
 *   - 所有动作都由服务端执行，页面不持有任何密钥。
 *   - 路径全部走 lib/config.js 的三级解析（配置 → 探测 → 特征识别），
 *     因此每个人的安装目录不同也能跑。
 *   - 只接受本机来源的请求（与 dsh-mcp-panel 同一套 trusted 判据）。
 *
 * 配置段（cordis.patch.yml 的 config）：
 *   consolePort  控制台端口（覆盖默认 8330）
 *   autoStart    dsh 启动时是否自动拉起控制台进程
 *   statusTtlMs  快照缓存时长，默认 5000（避免面板刷新打爆网关）
 */

import fs from 'node:fs'
import path from 'node:path'

import { resolveConfig, diagnose, saveConfig, configPath, PLUGIN_ROOT } from './config.js'
import {
  consoleStatus,
  controllersSnapshot,
  fetchJson,
  latestFile,
  probePort,
  snapshot,
  startConsole,
  startGateway,
  stopConsole,
  tailLines,
} from './gateway.js'

export const name = 'ai-gateway-console'
export const inject = ['webServer']

const DEFAULT_TTL = 5000

/* ------------------------------------------------------------------ *
 * HTTP 辅助
 * ------------------------------------------------------------------ */

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function sendHtml(res, code, html) {
  const body = Buffer.from(html, 'utf8')
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** 只放行本机来源：Host 头必须是回环地址。 */
function trusted(req) {
  const raw = String(req.headers.host || '').toLowerCase()
  if (!raw) return false
  let name
  if (raw.startsWith('[')) {
    // IPv6 字面量：[::1]:8080 → ::1
    const end = raw.indexOf(']')
    name = end > 0 ? raw.slice(1, end) : ''
  } else {
    name = raw.split(':')[0]
  }
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve) => {
    let data = ''
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolve(v)
    }
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > limit) {
        finish('')
        try {
          req.destroy()
        } catch {
          /* ignore */
        }
      }
    })
    req.on('end', () => finish(data))
    req.on('error', () => finish(''))
  })
}

/* ------------------------------------------------------------------ *
 * 状态页（/ai-gateway）
 * ------------------------------------------------------------------ */

function statusPage() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI 网关控制台 · DSH 插件</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font:14px/1.6 "Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;background:#08090b;color:#f0f1f3;
       min-height:100vh;padding:32px 20px}
  .wrap{max-width:880px;margin:0 auto}
  h1{font-size:19px;font-weight:640;margin-bottom:4px}
  .sub{color:#6b7280;font-size:12.5px;margin-bottom:22px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-bottom:20px}
  .card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:15px 16px}
  .card h2{font-size:13.5px;font-weight:620;margin-bottom:9px;display:flex;align-items:center;gap:8px}
  .led{width:8px;height:8px;border-radius:50%;background:#6b7280;flex:0 0 auto}
  .led.ok{background:#34d399;box-shadow:0 0 0 3px rgba(52,211,153,.15)}
  .led.bad{background:#f87171;box-shadow:0 0 0 3px rgba(248,113,113,.15)}
  .kv{font-size:12.5px;color:#a2a7b0;display:flex;justify-content:space-between;gap:10px;padding:3px 0}
  .kv b{color:#f0f1f3;font-weight:600;font-variant-numeric:tabular-nums}
  .mono{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:#6b7280;word-break:break-all}
  .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
  button{font:inherit;font-size:12.5px;padding:7px 13px;border-radius:9px;cursor:pointer;
         border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);color:#f0f1f3}
  button:hover{border-color:rgba(255,255,255,.2)}
  button.primary{background:linear-gradient(135deg,#34d399,#22d3ee);border-color:transparent;color:#04231a;font-weight:640}
  pre{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px;
      padding:12px;font-size:11.5px;max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-all}
  .hint{color:#6b7280;font-size:12px;margin-top:10px}
</style></head>
<body><div class="wrap">
  <h1>AI 网关控制台</h1>
  <div class="sub">DSH 插件 · 三个本地反代服务 + 后台控制器</div>
  <div class="grid" id="cards"></div>
  <div class="row">
    <button class="primary" onclick="act('start-console')">启动控制台</button>
    <button onclick="openConsole()">打开控制台</button>
    <button onclick="act('start-all')">启动全部网关</button>
    <button onclick="load(true)">刷新（含控制器）</button>
  </div>
  <div class="hint" id="hint"></div>
  <pre id="raw" style="margin-top:16px;display:none"></pre>
</div>
<script>
const $ = (id) => document.getElementById(id);
async function load(deep){
  try{
    const r = await fetch('/ai-gateway/status' + (deep ? '?deep=1' : ''), {cache:'no-store'});
    const d = await r.json();
    render(d);
  }catch(e){ $('hint').textContent = '状态获取失败：' + e; }
}
function led(on){ return '<span class="led ' + (on ? 'ok' : 'bad') + '"></span>'; }
function render(d){
  const cards = [];
  const t = d.trae || {}, w = d.workbuddy || {}, h = d.hub || {}, c = d.console || {};
  cards.push(card('Trae 网关', t.running, [
    ['账号', t.accountCount ?? '—'],
    ['令牌', t.tokenOk ? '有效' : (t.authorized ? '待刷新' : '未授权')],
    ['轮询', t.polling ? '开' : '关'],
    ['地址', t.url || '—'],
  ]));
  cards.push(card('WorkBuddy 网关', w.running, [
    ['模型', w.modelCount ?? '—'],
    ['账号', (w.accounts || []).length],
    ['版本', w.version || '—'],
    ['地址', w.url || '—'],
  ]));
  cards.push(card('WorkBuddy Hub', h.running, [
    ['地址', h.url || '—'],
  ]));
  cards.push(card('控制台', c.running, [
    ['端口', c.port ?? '—'],
    ['版本', c.version || '—'],
    ['地址', c.url || '—'],
  ]));
  if (d.controllers){
    for (const x of d.controllers){
      cards.push(card(x.name, x.alive === true, [
        ['状态', x.alive === null ? '未知' : (x.alive ? '在跑' : '未运行')],
        ['说明', x.desc || ''],
      ]));
    }
  }
  $('cards').innerHTML = cards.join('');
}
function card(title, on, rows){
  return '<div class="card"><h2>' + led(on) + title + '</h2>' +
    rows.map(([k,v]) => '<div class="kv"><span>' + k + '</span><b>' + String(v ?? '—') + '</b></div>').join('') +
    '</div>';
}
async function act(name){
  $('hint').textContent = '执行 ' + name + ' …';
  try{
    const r = await fetch('/ai-gateway/action', {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({action: name})});
    const d = await r.json();
    $('hint').textContent = d.ok ? ('完成：' + JSON.stringify(d.result || {})) : ('失败：' + d.error);
    setTimeout(() => load(false), 1200);
  }catch(e){ $('hint').textContent = '请求失败：' + e; }
}
function openConsole(){ window.open('/ai-gateway/console', '_blank'); }
load(true);
setInterval(() => load(false), 8000);
</script>
</body></html>`
}

/* ------------------------------------------------------------------ *
 * 插件主体
 * ------------------------------------------------------------------ */

export function apply(ctx, pluginConfig = {}) {
  const logger = ctx?.logger ?? console
  const log = (level, message) => {
    const sink = typeof logger[level] === 'function' ? logger[level] : logger.info || console.log
    try {
      sink.call(logger, `[ai-gateway-console] ${message}`)
    } catch {
      /* 日志失败绝不影响插件 */
    }
  }

  /* 配置解析一次缓存住：目录扫描有 I/O 成本，不能每个请求跑一遍 */
  let cached = null
  const config = () => {
    if (!cached) {
      cached = resolveConfig()
      if (pluginConfig.consolePort) cached.console.port = Number(pluginConfig.consolePort)
      const report = diagnose(cached)
      for (const issue of report.issues) {
        log(issue.level === 'error' ? 'warn' : 'info', `${issue.message}`)
      }
      log('info', `配置：${configPath()}${report.ok ? '' : '（存在待修项，打开 /ai-gateway 查看）'}`)
    }
    return cached
  }
  const invalidate = () => {
    cached = null
  }

  /* 快照缓存：面板 8 秒刷一次，别每次都打上游 */
  const ttl = Number(pluginConfig.statusTtlMs) > 0 ? Number(pluginConfig.statusTtlMs) : DEFAULT_TTL
  let snapCache = { at: 0, deep: false, value: null }
  const getSnapshot = async (deep) => {
    const now = Date.now()
    if (snapCache.value && now - snapCache.at < ttl && (!deep || snapCache.deep)) return snapCache.value
    const value = await snapshot(config(), { deep })
    snapCache = { at: now, deep, value }
    return value
  }

  const json = async (fn) => {
    try {
      return await fn()
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) }
    }
  }

  /* ---------------- 路由 ---------------- */

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/ai-gateway',
      handler: async (req, res) => {
        if (!trusted(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
        sendHtml(res, 200, statusPage())
      },
    })
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/ai-gateway/status',
      handler: async (req, res) => {
        if (!trusted(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
        const deep = /[?&]deep=1/.test(req.url || '')
        const data = await json(async () => {
          const [snap, console] = await Promise.all([getSnapshot(deep), consoleStatus(config())])
          return { ok: true, ...snap, console }
        })
        sendJson(res, 200, data)
      },
    })
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/ai-gateway/config',
      handler: async (req, res) => {
        if (!trusted(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
        if (req.method === 'GET') {
          const report = diagnose(config())
          return sendJson(res, 200, {
            ok: true,
            file: configPath(),
            pluginRoot: PLUGIN_ROOT,
            config: report.config,
            issues: report.issues,
          })
        }
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET or POST only' })
        const raw = await readBody(req)
        let patch = {}
        try {
          patch = raw.trim() ? JSON.parse(raw) : {}
        } catch {
          return sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
        }
        const result = saveConfig(patch)
        if (result.ok) invalidate()
        sendJson(res, result.ok ? 200 : 500, result)
      },
    })
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/ai-gateway/logs',
      handler: async (req, res) => {
        if (!trusted(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
        const cfg = config()
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const src = url.searchParams.get('src') || 'wb'
        const n = Math.min(Math.max(Number(url.searchParams.get('n')) || 200, 20), 2000)
        let file = null
        if (src === 'trae') file = cfg.trae.logFile || null
        else if (src === 'wb') file = cfg.workbuddy.logDirPath ? latestFile(cfg.workbuddy.logDirPath, 'gateway-', '.log') : null
        else {
          const spec = (cfg.controllers || []).find((c) => c.id === src)
          file = spec?.log || null
        }
        if (!file || !fs.existsSync(file)) {
          return sendJson(res, 200, { ok: true, source: src, path: file || '', lines: [], missing: true })
        }
        const lines = tailLines(file, n)
        sendJson(res, 200, { ok: true, source: src, path: file, count: lines.length, lines })
      },
    })
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/ai-gateway/console',
      handler: async (req, res) => {
        if (!trusted(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
        const cfg = config()
        const status = await consoleStatus(cfg)
        if (!status.running) {
          // 没起就顺手起一个，省得用户先去别处点一次
          const started = startConsole(cfg)
          if (!started.ok) return sendJson(res, 500, started)
          for (let i = 0; i < 20; i += 1) {
            await new Promise((r) => setTimeout(r, 300))
            if (await probePort('127.0.0.1', Number(cfg.console.port))) break
          }
        }
        res.writeHead(302, { Location: `http://127.0.0.1:${cfg.console.port}/` })
        res.end()
      },
    })
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/ai-gateway/action',
      handler: async (req, res) => {
        if (!trusted(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        const raw = await readBody(req)
        let body = {}
        try {
          body = raw.trim() ? JSON.parse(raw) : {}
        } catch {
          return sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
        }
        const cfg = config()
        const action = String(body.action || '')
        const result = await json(async () => {
          switch (action) {
            case 'start-console':
              return startConsole(cfg)
            case 'stop-console':
              return stopConsole(cfg)
            case 'start-trae':
              return startGateway(cfg, 'trae')
            case 'start-wb':
              return startGateway(cfg, 'workbuddy')
            case 'start-all':
              return { trae: startGateway(cfg, 'trae'), workbuddy: startGateway(cfg, 'workbuddy') }
            case 'reload-config':
              invalidate()
              return { ok: true }
            case 'controllers':
              return { ok: true, controllers: await controllersSnapshot(cfg) }
            default:
              return { ok: false, error: `未知动作：${action}` }
          }
        })
        sendJson(res, result.ok === false ? 400 : 200, { ok: result.ok !== false, action, result })
      },
    })
  )

  /* ---------------- 生命周期 ---------------- */

  ctx.effect(() => {
    // 延迟探测，别拖慢 dsh 启动
    const timer = setTimeout(async () => {
      const cfg = config()
      const report = diagnose(cfg)
      if (!report.ok) {
        log('warn', '网关路径未就绪 —— 打开 http://127.0.0.1:<port>/ai-gateway 查看，或运行 scripts/doctor.ps1')
      } else {
        log('info', '网关路径就绪，控制台入口：/ai-gateway')
      }
      if (pluginConfig.autoStart) {
        const status = await consoleStatus(cfg)
        if (!status.running) {
          const started = startConsole(cfg)
          log('info', started.ok ? `控制台已自动拉起（pid ${started.pid}）` : `控制台自动拉起失败：${started.error}`)
        }
      }
    }, 2500)
    return () => clearTimeout(timer)
  })
}

export { fetchJson, tailLines, latestFile, path }
