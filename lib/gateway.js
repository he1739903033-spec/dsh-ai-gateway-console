/**
 * 网关状态聚合与进程管理。
 *
 * 这一层刻意做到「零依赖 + 可降级」：
 *   - 端口探测走 node:net，不依赖任何 HTTP 客户端
 *   - HTTP 走 Node 18+ 内置 fetch，超时自己兜
 *   - 控制器的存活探测走 Windows 互斥体（和 Python 控制台同一套判据），
 *     非 Windows 上直接返回 unknown，不抛错
 *
 * 任何一项失败都只影响它自己那一格状态，绝不让整个快照挂掉。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* ------------------------------------------------------------------ *
 * 基础探测
 * ------------------------------------------------------------------ */

export function probePort(host, port, timeout = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    try {
      socket.connect(port, host)
    } catch {
      done(false)
    }
  })
}

export async function fetchJson(url, { headers = {}, timeout = 4000, method = 'GET', body } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    try {
      return { ok: res.ok, status: res.status, data: JSON.parse(text) }
    } catch {
      return { ok: res.ok, status: res.status, data: null, text: text.slice(0, 500) }
    }
  } catch (error) {
    return { ok: false, status: 0, error: String(error && error.message ? error.message : error) }
  } finally {
    clearTimeout(timer)
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 读文件尾部若干行（不把 18 MB 的日志整个读进来）。 */
export function tailLines(file, count = 200, window = 512 * 1024) {
  try {
    const { size } = fs.statSync(file)
    const start = Math.max(0, size - window)
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(window, size - start))
      fs.readSync(fd, buffer, 0, buffer.length, start)
      return buffer.toString('utf8').split(/\r?\n/).slice(-count)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return []
  }
}

function latestFile(dir, prefix, suffix = '.log') {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
      .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    return files.length ? path.join(dir, files[0].f) : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 控制器存活（Windows 互斥体）
 * ------------------------------------------------------------------ */

const isWindows = process.platform === 'win32'

/**
 * 一次 PowerShell 调用探完所有互斥体 —— 逐个调用要 200ms×N，太贵。
 * 判据与 Python 控制台一致：拿到句柄后 Wait(0) 立即成功 = 无人持有 = 已退出。
 */
export function probeMutexes(names, timeout = 6000) {
  if (!isWindows || !names.length) {
    return Promise.resolve(Object.fromEntries(names.map((n) => [n, null])))
  }
  const list = names.map((n) => `'${String(n).replace(/'/g, "''")}'`).join(',')
  const script = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class AigwMx {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern IntPtr OpenMutex(uint a, bool i, string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReleaseMutex(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  public static string Probe(string n){
    IntPtr h = OpenMutex(0x00100000, false, n);
    if (h == IntPtr.Zero) return "absent";
    uint r = WaitForSingleObject(h, 0);
    if (r == 0) { ReleaseMutex(h); CloseHandle(h); return "unheld"; }
    CloseHandle(h);
    return r == 0x102 ? "held" : "unknown";
  }
}
'@
$out = @{}
foreach ($n in @(${list})) { $out[$n] = [AigwMx]::Probe($n) }
$out | ConvertTo-Json -Compress
`
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true }
    )
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish(Object.fromEntries(names.map((n) => [n, null])))
    }, timeout)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish(Object.fromEntries(names.map((n) => [n, null])))
    })
    child.on('close', () => {
      clearTimeout(timer)
      let parsed = null
      try {
        parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop())
      } catch {
        parsed = null
      }
      const out = {}
      for (const n of names) {
        const v = parsed && parsed[n]
        out[n] = v === 'held' ? true : v === 'absent' || v === 'unheld' ? false : null
      }
      finish(out)
    })
  })
}

/* ------------------------------------------------------------------ *
 * 快照
 * ------------------------------------------------------------------ */

export async function traeSnapshot(cfg) {
  const base = cfg.trae
  const up = await probePort('127.0.0.1', Number(new URL(base.url).port || 8327))
  if (!up) return { running: false, url: base.url, port: Number(new URL(base.url).port || 8327) }

  const status = await fetchJson(`${base.url}/v1/status`, { timeout: 3000 })
  const accounts = await fetchJson(`${base.url}/api/accounts`, {
    headers: base.key ? { Authorization: `Bearer ${base.key}` } : {},
    timeout: 4000,
  })
  const list = accounts.data?.accounts || []
  return {
    running: true,
    url: base.url,
    port: Number(new URL(base.url).port || 8327),
    edition: status.data?.edition || '',
    upstream: status.data?.upstream_mode || '',
    authorized: Boolean(status.data?.has_token),
    tokenOk: Boolean(status.data?.token_ok),
    accountCount: list.length,
    polling: Boolean(accounts.data?.polling?.enabled),
    pollingMode: accounts.data?.polling?.mode || '',
    accounts: list.map((a) => ({
      id: a.id || a.user_id,
      label: a.label || a.user_id,
      valid: Boolean(a.is_valid),
      active: Boolean(a.is_active),
      modelEnabled: Boolean(a.model_enabled),
      checkedIn: Boolean(a.checked_in),
      expires: a.expires,
      credits: a.account_credits || null,
    })),
  }
}

export async function wbSnapshot(cfg) {
  const base = cfg.workbuddy
  const port = Number(new URL(base.url).port || 8317)
  const up = await probePort('127.0.0.1', port)
  const status = base.statusPath ? readJsonSafe(base.statusPath) : null
  if (!up && !status) return { running: false, url: base.url, port }

  const health = await fetchJson(`${base.url}/health`, {
    headers: base.key ? { Authorization: `Bearer ${base.key}` } : {},
    timeout: 3000,
  })
  const accounts = (status?.accounts || []).map((a) => ({
    path: a.path || '',
    nickname: a.nickname || '-',
    edition: a.edition || '',
    plan: a.planLabel || '-',
    state: a.state || '-',
    quotaRemaining: a.quotaRemaining,
    quotaTotal: a.quotaTotal,
    paid: Boolean(a.isPaidUser),
    expires: a.tokenExpiresAt,
    modelStates: a.modelStates || {},
  }))
  const models = (status?.models || []).map((m) => ({
    id: m.id,
    cnMultiplier: m.cnMultiplier,
    intlMultiplier: m.intlMultiplier,
    availableAccounts: m.availableAccounts,
    requests: m.requests,
    success: m.success,
    tokens: m.tokens,
    lastStatus: m.lastStatus,
  }))
  return {
    running: up,
    url: base.url,
    port,
    version: health.data?.version || '',
    modelCount: health.data?.model_count ?? models.length,
    updated: status?.updatedAt,
    accounts,
    models,
    config: base.configPath ? readJsonSafe(base.configPath) : null,
  }
}

export async function hubSnapshot(cfg) {
  const base = cfg.hub
  const port = Number(new URL(base.url).port || 8788)
  const up = await probePort('127.0.0.1', port)
  if (!up) return { running: false, url: base.url, port }
  const health = await fetchJson(`${base.url}/health`, { timeout: 3000 })
  return { running: true, url: base.url, port, health: health.data || null }
}

/** 控制器列表 —— 带上存活判定与日志路径。 */
export async function controllersSnapshot(cfg) {
  const specs = cfg.controllers || []
  const names = specs.filter((s) => s.mutex).map((s) => s.mutex)
  const mutexState = await probeMutexes(names)
  return specs.map((spec) => {
    const logDir = cfg.workbuddy.logDirPath || ''
    return {
      id: spec.id,
      name: spec.name,
      desc: spec.desc,
      alive: spec.mutex ? mutexState[spec.mutex] : null,
      script: spec.script ? path.join(cfg.workbuddy.base || '', spec.script) : '',
      log: logDir && spec.log ? path.join(logDir, spec.log) : '',
    }
  })
}

/**
 * 聚合快照。
 * @param {object} cfg
 * @param {{deep?: boolean}} options deep=true 才探控制器（要起 PowerShell，贵）
 */
export async function snapshot(cfg, options = {}) {
  const { deep = false } = options
  const [trae, workbuddy, hub] = await Promise.all([
    traeSnapshot(cfg).catch((e) => ({ running: false, error: String(e) })),
    wbSnapshot(cfg).catch((e) => ({ running: false, error: String(e) })),
    hubSnapshot(cfg).catch((e) => ({ running: false, error: String(e) })),
  ])
  const out = { trae, workbuddy, hub, at: Date.now() }
  if (deep) {
    out.controllers = await controllersSnapshot(cfg).catch(() => [])
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 动作
 * ------------------------------------------------------------------ */

export function runDetached(command, args = [], options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: true,
    stdio: options.stdio || 'ignore',
    windowsHide: options.windowsHide !== false,
  })
  child.unref()
  return child.pid
}

/** 拉起一个网关。脚本优先用 VBS（隐藏宿主窗口），退化到 cmd。 */
export function startGateway(cfg, kind) {
  const base = cfg[kind]
  if (!base || !base.base) return { ok: false, error: `未配置 ${kind}.base` }
  const script = path.join(base.base, base.startScript || '')
  if (fs.existsSync(script)) {
    const pid = runDetached('wscript.exe', ['//B', script], { cwd: base.base })
    return { ok: true, pid, via: 'wscript', script }
  }
  const alt = (base.altStartScripts || [])
    .map((s) => path.join(base.base, s))
    .find((p) => fs.existsSync(p))
  if (alt) {
    const pid = runDetached('cmd.exe', ['/c', 'start', '', alt], { cwd: base.base })
    return { ok: true, pid, via: 'cmd', script: alt }
  }
  return { ok: false, error: `找不到启动脚本：${script}` }
}

/* ------------------------------------------------------------------ *
 * 控制台进程（可选组件）
 * ------------------------------------------------------------------ */

export function pythonCandidates(cfg) {
  const list = []
  if (cfg?.console?.python) list.push(cfg.console.python)
  if (process.env.AIGW_PYTHON) list.push(process.env.AIGW_PYTHON)
  list.push('python', 'python3', 'py')
  const home = os.homedir()
  list.push(path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'))
  list.push(path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'))
  list.push('C:\\Python312\\python.exe')
  list.push('C:\\Python311\\python.exe')
  return [...new Set(list.filter(Boolean))]
}

export function consoleServerPath() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', 'console', 'server.py')
}

export async function consoleStatus(cfg) {
  const port = Number(cfg.console.port || 8330)
  const up = await probePort('127.0.0.1', port)
  if (!up) return { running: false, port, url: `http://127.0.0.1:${port}/` }
  const info = await fetchJson(`http://127.0.0.1:${port}/api/status`, { timeout: 5000 })
  return { running: true, port, url: `http://127.0.0.1:${port}/`, version: info.data?.version || '' }
}

export function startConsole(cfg, { background = true } = {}) {
  const server = consoleServerPath()
  if (!fs.existsSync(server)) return { ok: false, error: `控制台后端缺失：${server}` }

  let lastError = 'no python found'
  for (const candidate of pythonCandidates(cfg)) {
    try {
      const pid = runDetached(candidate, [server], {
        cwd: path.dirname(server),
        stdio: background ? 'ignore' : 'inherit',
        windowsHide: true,
      })
      return { ok: true, pid, python: candidate, server }
    } catch (error) {
      lastError = `${candidate}: ${error && error.message ? error.message : error}`
    }
  }
  return { ok: false, error: `未找到可用的 Python（${lastError}）。装一个，或在配置里填 console.python` }
}

/**
 * 停掉控制台。
 *
 * 按镜像名杀 python.exe 会误伤同一台机器上别的 Python 项目，所以先看端口
 * 被谁占着，只在占用者是 python/pythonw 时才动手 —— 与启动逻辑对称。
 */
export function stopConsole(cfg) {
  if (!isWindows) return Promise.resolve({ ok: false, error: 'only windows' })
  const port = Number(cfg?.console?.port || 8330)
  const script = `
$ErrorActionPreference='SilentlyContinue'
$c = Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1
if (-not $c) { Write-Output '{"ok":false,"error":"no listener on ${port}"}'; exit }
$p = Get-Process -Id $c.OwningProcess
if ($p.ProcessName -notin @('python','pythonw')) {
  Write-Output ('{"ok":false,"error":"port ${port} held by ' + $p.ProcessName + '"}'); exit
}
Stop-Process -Id $p.Id -Force
Write-Output ('{"ok":true,"pid":' + $p.Id + ',"name":"' + $p.ProcessName + '"}')
`
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: 'timeout' })
    }, 8000)
    child.stdout.on('data', (c) => {
      stdout += c
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      finish({ ok: false, error: String(e) })
    })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        finish(JSON.parse(stdout.trim().split(/\r?\n/).pop()))
      } catch {
        finish({ ok: false, error: stdout.trim().slice(0, 200) || 'no output' })
      }
    })
  })
}

export { latestFile, readJsonSafe, isWindows }
