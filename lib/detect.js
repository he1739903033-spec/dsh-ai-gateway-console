/**
 * 路径与密钥探测 —— 这个插件里最需要容错的一块。
 *
 * 每个人的网关装在不同地方（C:\Tools、家目录、别的盘……），
 * 所以这里不假设任何固定路径，按三级策略解析：
 *
 *   1. 显式配置     配置文件 / 环境变量给的路径 —— 命中即用，不再探测
 *   2. 常见位置扫描 家目录下的 Tools / Documents / Desktop、各盘符的 \Tools 与根目录
 *   3. 特征文件识别 按目录里的标志文件确认身份，而不是只看目录名 ——
 *                   别人的目录可能叫 trae-relay 也可能叫 Trae2api-cn
 *
 * 密钥同理：Trae 的网关 key 与 WorkBuddy 的 key 每台机器都不同，
 * 能从对方项目里读出来就不该让用户手抄。
 *
 * 零外部依赖：只用 node: 内置模块。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* ------------------------------------------------------------------ *
 * 各组件的身份特征
 * ------------------------------------------------------------------ */

/**
 * markers 是「必须全部存在」的文件/目录（相对该组件根目录）。
 * 只看目录名会误判，所以每个组件都要用真实存在的标志物确认。
 */
export const SIGNATURES = {
  trae: {
    label: 'Trae 网关',
    dirNames: ['Trae2api-cn', 'Trae2api', 'trae2api-cn', 'trae-relay', 'TraeRelay'],
    markers: ['web_login.py', path.join('src', 'main.py')],
    startScript: 'launch-all.vbs',
    altStartScripts: ['启动Trae网关.cmd'],
    logDir: 'logs',
  },
  workbuddy: {
    label: 'WorkBuddy 网关',
    dirNames: ['workbuddy-gateway', 'workbuddy', 'WorkBuddyGateway'],
    markers: ['workbuddy-gateway.exe'],
    startScript: 'launch-gateway.vbs',
    logDir: 'logs',
    statusFile: 'workbuddy-status.json',
    configFile: 'config.json',
  },
  hub: {
    label: 'WorkBuddy Hub',
    dirNames: ['workbuddy2api-hub', 'workbuddy-hub'],
    markers: [path.join('wb-proxy', 'wb_proxy.py')],
    logDir: path.join('wb-proxy', 'logs'),
  },
}

/* ------------------------------------------------------------------ *
 * 搜索根
 * ------------------------------------------------------------------ */

/** 环境变量 AIGW_SEARCH_ROOTS 可用 ; 或 : 追加自定义搜索根（优先级最高）。 */
export function searchRoots() {
  const home = os.homedir()
  const roots = []
  const seen = new Set()
  const add = (p) => {
    if (!p) return
    const norm = path.resolve(p)
    if (seen.has(norm)) return
    seen.add(norm)
    try {
      if (fs.existsSync(norm)) roots.push(norm)
    } catch {
      /* 无权限的路径直接跳过 */
    }
  }

  for (const p of String(process.env.AIGW_SEARCH_ROOTS || '').split(path.delimiter)) {
    add(p.trim())
  }

  add(path.join(home, 'Tools'))
  add(path.join(home, 'tools'))
  add(path.join(home, 'Documents'))
  add(path.join(home, 'Desktop'))
  add(path.join(home, 'Downloads'))
  add(path.join(home, 'opt'))

  for (const drive of ['C', 'D', 'E', 'F', 'G']) add(`${drive}:\\Tools`)
  add(home)
  for (const drive of ['C', 'D', 'E', 'F', 'G']) add(`${drive}:\\`)

  return roots
}

/** 目录身份确认：markers 全部命中才算数。 */
export function matchesSignature(dir, spec) {
  if (!dir) return false
  for (const marker of spec.markers) {
    try {
      if (!fs.existsSync(path.join(dir, marker))) return false
    } catch {
      return false
    }
  }
  return true
}

function listDirs(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name))
  } catch {
    return []
  }
}

/**
 * 探测一个组件。返回绝对路径或 null。
 * 顺序：搜索根下的同名目录 → 搜索根下的一级子目录（按特征匹配）。
 */
export function detectComponent(kind, roots = searchRoots()) {
  const spec = SIGNATURES[kind]
  if (!spec) return null

  for (const root of roots) {
    for (const name of spec.dirNames) {
      const candidate = path.join(root, name)
      if (matchesSignature(candidate, spec)) return candidate
    }
  }
  for (const root of roots) {
    for (const dir of listDirs(root)) {
      if (matchesSignature(dir, spec)) return dir
    }
  }
  return null
}

/** 一次探完三个组件。 */
export function detectAll() {
  const roots = searchRoots()
  return {
    trae: detectComponent('trae', roots),
    workbuddy: detectComponent('workbuddy', roots),
    hub: detectComponent('hub', roots),
  }
}

/* ------------------------------------------------------------------ *
 * 密钥提取（能从对方项目里读到就不让用户手抄）
 * ------------------------------------------------------------------ */

function readTextIfExists(file, limit = 4 * 1024 * 1024) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > limit) return ''
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Trae 网关的 key。
 * 项目里它出现在几处：.env / src/main.py 的默认值 / 部署说明文档。
 * 取第一个形如 trae-gw-<hex> 的串即可。
 */
export function detectTraeKey(base) {
  if (!base) return ''
  const files = [
    path.join(base, '.env'),
    path.join(base, 'src', 'main.py'),
    path.join(base, '部署与使用说明.md'),
  ]
  for (const file of files) {
    const text = readTextIfExists(file)
    const m = text.match(/trae-gw-[0-9a-fA-F]{16,}/)
    if (m) return m[0]
  }
  return ''
}

/**
 * WorkBuddy 网关的 key。
 * 控制台脚本里有 GATEWAY_KEY = '...'，v41flash 控制器也是这么读的。
 */
export function detectWbKey(base) {
  if (!base) return ''
  const files = [
    path.join(base, 'WorkBuddyConsole.ps1'),
    path.join(base, 'launch-gateway.vbs'),
    path.join(base, 'config.json'),
  ]
  for (const file of files) {
    const text = readTextIfExists(file)
    const m = text.match(/GATEWAY_KEY\s*=\s*'([^']+)'/) || text.match(/-api-key\s+(\S+)/)
    if (m) return m[1] || m[0].replace('-api-key', '').trim()
  }
  return ''
}

/* ------------------------------------------------------------------ *
 * 端口
 * ------------------------------------------------------------------ */

/** 从网关自己的启动脚本里读端口，读不到就用默认值。 */
export function detectPort(base, scriptName, fallback) {
  if (!base || !scriptName) return fallback
  const text = readTextIfExists(path.join(base, scriptName))
  const m = text.match(/-port\s+(\d{2,5})/)
  return m ? Number(m[1]) : fallback
}

export function homeDir() {
  return os.homedir()
}

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}
