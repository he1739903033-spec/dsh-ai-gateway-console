/**
 * 配置读写与合并。
 *
 * 解析优先级（后者覆盖前者）：
 *   内置默认值  ←  自动探测结果  ←  配置文件  ←  环境变量
 *
 * 配置文件查找顺序：
 *   1. $AIGW_CONFIG 指向的文件（绝对路径）
 *   2. <DSH_HOME>/ai-gateway-console.json   （默认 ~/.dsh/ai-gateway-console.json）
 *   3. <本插件目录>/config.json              （仓库内随手改，便于随身携带）
 *
 * 环境变量（都可选，用于临时覆盖而不改文件）：
 *   AIGW_TRAE_BASE / AIGW_WB_BASE / AIGW_HUB_BASE   组件根目录
 *   AIGW_TRAE_URL  / AIGW_WB_URL  / AIGW_HUB_URL    服务地址
 *   AIGW_TRAE_KEY  / AIGW_WB_KEY                    网关密钥
 *   AIGW_CONSOLE_PORT                               控制台端口（默认 8330）
 *   AIGW_PYTHON                                     Python 可执行文件
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { detectAll, detectTraeKey, detectWbKey, dshHome } from './detect.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = path.resolve(HERE, '..')

export const DEFAULTS = {
  console: {
    host: '127.0.0.1',
    port: 8330,
    python: '',            // 留空 = 自动探测
    autoStart: false,      // dsh 启动时是否自动拉起控制台
  },
  trae: {
    base: '',
    url: 'http://127.0.0.1:8327',
    key: '',
    startScript: 'launch-all.vbs',
    logDir: 'logs',
  },
  workbuddy: {
    base: '',
    url: 'http://127.0.0.1:8317',
    key: '',
    startScript: 'launch-gateway.vbs',
    statusFile: 'workbuddy-status.json',
    configFile: 'config.json',
    logDir: 'logs',
  },
  hub: {
    base: '',
    url: 'http://127.0.0.1:8788',
  },
  /** 控制台纳管的后台控制器（无端口，靠单实例互斥体探测）。
   *  用 name 而不是写死路径 —— 组件根目录由上面的 base 决定。 */
  controllers: [
    {
      id: 'watchdog',
      name: '服务守护',
      desc: '网关 + Hub 的看门狗，30 秒内拉起掉线服务',
      mutex: 'Local\\WorkBuddyServiceWatchdog',
      script: 'guard-workbuddy-gateway.ps1',
      log: 'watchdog.log',
    },
    {
      id: 'v41flash',
      name: 'v4.1-flash 站点控制',
      desc: '免费站点可用时把付费账号移出池子；被限流/失联时放回',
      mutex: 'Local\\WorkBuddyV41FlashPriority',
      script: 'prefer-intl-v41flash.ps1',
      log: 'v41flash-priority.log',
    },
  ],
}

export function configPath() {
  if (process.env.AIGW_CONFIG) return path.resolve(process.env.AIGW_CONFIG)
  return path.join(dshHome(), 'ai-gateway-console.json')
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function mergeDeep(base, patch) {
  if (!patch || typeof patch !== 'object') return base
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = mergeDeep(out[key], value)
    } else if (value !== undefined && value !== null && value !== '') {
      out[key] = value
    }
  }
  return out
}

/** 自动探测 —— 只在配置文件没给路径时才跑（扫描有 I/O 成本）。 */
export function probe() {
  const found = detectAll()
  const out = {
    trae: { base: found.trae || '' },
    workbuddy: { base: found.workbuddy || '' },
    hub: { base: found.hub || '' },
  }
  if (found.trae) out.trae.key = detectTraeKey(found.trae)
  if (found.workbuddy) out.workbuddy.key = detectWbKey(found.workbuddy)
  return out
}

function fromEnv() {
  const env = process.env
  const out = {}
  const put = (section, field, value) => {
    if (!value) return
    out[section] = out[section] || {}
    out[section][field] = value
  }
  put('trae', 'base', env.AIGW_TRAE_BASE)
  put('trae', 'url', env.AIGW_TRAE_URL)
  put('trae', 'key', env.AIGW_TRAE_KEY)
  put('workbuddy', 'base', env.AIGW_WB_BASE)
  put('workbuddy', 'url', env.AIGW_WB_URL)
  put('workbuddy', 'key', env.AIGW_WB_KEY)
  put('hub', 'base', env.AIGW_HUB_BASE)
  put('hub', 'url', env.AIGW_HUB_URL)
  if (env.AIGW_PYTHON) put('console', 'python', env.AIGW_PYTHON)
  if (env.AIGW_CONSOLE_PORT) put('console', 'port', Number(env.AIGW_CONSOLE_PORT))
  return out
}

/**
 * 解析出最终配置。
 * @param {{probeIfMissing?: boolean}} options
 *        probeIfMissing=false 时跳过目录扫描（只想读文件配置的场合）。
 */
export function resolveConfig(options = {}) {
  const { probeIfMissing = true } = options

  let cfg = JSON.parse(JSON.stringify(DEFAULTS))

  const fileCfg = readJson(configPath()) || readJson(path.join(PLUGIN_ROOT, 'config.json')) || {}
  const explicitPaths = Boolean(fileCfg.trae?.base && fileCfg.workbuddy?.base)

  if (probeIfMissing && !explicitPaths) {
    cfg = mergeDeep(cfg, probe())
  }
  cfg = mergeDeep(cfg, fileCfg)
  cfg = mergeDeep(cfg, fromEnv())

  // 由 base 推导派生路径，省得每处都写一遍
  if (cfg.trae.base) {
    cfg.trae.logFile = path.join(cfg.trae.base, cfg.trae.logDir || 'logs', 'gateway.log')
  }
  if (cfg.workbuddy.base) {
    cfg.workbuddy.statusPath = path.join(cfg.workbuddy.base, cfg.workbuddy.statusFile || 'workbuddy-status.json')
    cfg.workbuddy.configPath = path.join(cfg.workbuddy.base, cfg.workbuddy.configFile || 'config.json')
    cfg.workbuddy.logDirPath = path.join(cfg.workbuddy.base, cfg.workbuddy.logDir || 'logs')
  }
  if (cfg.hub.base) {
    cfg.hub.healthUrl = `${cfg.hub.url}/health`
  }

  cfg._meta = {
    configFile: configPath(),
    configFileExists: fs.existsSync(configPath()),
    pluginRoot: PLUGIN_ROOT,
    probed: probeIfMissing && !explicitPaths,
  }
  return cfg
}

/** 写回配置文件（保留未识别的字段，避免抹掉用户手写的东西）。 */
export function saveConfig(patch) {
  const file = configPath()
  const current = readJson(file) || {}
  const next = mergeDeep(current, patch)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return { ok: true, file, config: next }
  } catch (error) {
    return { ok: false, file, error: String(error && error.message ? error.message : error) }
  }
}

/** 配置体检：缺什么、哪条路径不存在，一次说清（安装向导与 doctor 都用它）。 */
export function diagnose(cfg = resolveConfig()) {
  const issues = []
  const checks = [
    ['trae', cfg.trae.base, 'Trae 网关目录'],
    ['workbuddy', cfg.workbuddy.base, 'WorkBuddy 网关目录'],
    ['hub', cfg.hub.base, 'WorkBuddy Hub 目录'],
  ]
  for (const [kind, base, label] of checks) {
    if (!base) {
      issues.push({ level: 'error', kind, message: `未找到${label} —— 请在配置里填写 ${kind}.base` })
    } else if (!fs.existsSync(base)) {
      issues.push({ level: 'error', kind, message: `${label}路径不存在：${base}` })
    }
  }
  if (!cfg.trae.key) {
    issues.push({ level: 'warn', kind: 'trae', message: 'Trae 网关密钥为空 —— 部分接口会 401（可在配置里填 trae.key）' })
  }
  if (!cfg.workbuddy.key) {
    issues.push({ level: 'warn', kind: 'workbuddy', message: 'WorkBuddy 网关密钥为空 —— /health 会 401（可在配置里填 workbuddy.key）' })
  }
  return {
    ok: !issues.some((i) => i.level === 'error'),
    issues,
    config: cfg,
  }
}
