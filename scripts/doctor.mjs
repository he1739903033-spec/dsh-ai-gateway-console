#!/usr/bin/env node
/**
 * 自检 —— 安装后跑一次，把「路径探测到了什么、哪个服务没起来、缺什么」一次说清。
 *
 *   node scripts/doctor.mjs
 *   node scripts/doctor.mjs --json      机器可读输出
 *
 * 退出码：0 = 全绿或只有警告；1 = 有阻塞项（路径没找到）。
 */

import fs from 'node:fs'
import path from 'node:path'

import { configPath, diagnose, PLUGIN_ROOT, resolveConfig } from '../lib/config.js'
import {
  consoleServerPath,
  consoleStatus,
  controllersSnapshot,
  probePort,
  pythonCandidates,
  snapshot,
} from '../lib/gateway.js'

const asJson = process.argv.includes('--json')

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  ok: '\u001b[32m',
  warn: '\u001b[33m',
  bad: '\u001b[31m',
  cyan: '\u001b[36m',
}
const paint = (color, text) => (process.stdout.isTTY ? `${color}${text}${C.reset}` : text)
const mark = (ok) => (ok === true ? paint(C.ok, '● 在线') : ok === false ? paint(C.bad, '○ 离线') : paint(C.dim, '? 未知'))

function line(label, value) {
  console.log(`  ${label.padEnd(18)} ${value}`)
}

function section(title) {
  console.log(`\n${paint(C.bold, title)}`)
}

async function main() {
  const cfg = resolveConfig()
  const report = diagnose(cfg)

  if (asJson) {
    const snap = await snapshot(cfg, { deep: true })
    const consoleInfo = await consoleStatus(cfg)
    console.log(JSON.stringify({ config: cfg, issues: report.issues, snapshot: snap, console: consoleInfo }, null, 2))
    process.exit(report.ok ? 0 : 1)
  }

  console.log(paint(C.bold, '\ndsh-ai-gateway-console · 环境自检'))
  console.log(paint(C.dim, `插件目录  ${PLUGIN_ROOT}`))
  console.log(paint(C.dim, `配置文件  ${configPath()}${fs.existsSync(configPath()) ? '' : '（尚未创建，当前用探测结果）'}`))

  section('组件路径')
  const rows = [
    ['Trae 网关', cfg.trae.base],
    ['WorkBuddy 网关', cfg.workbuddy.base],
    ['WorkBuddy Hub', cfg.hub.base],
  ]
  for (const [label, base] of rows) {
    const exists = base && fs.existsSync(base)
    line(label, base ? `${exists ? paint(C.ok, '✓') : paint(C.bad, '✗')} ${base}` : paint(C.bad, '未找到'))
  }

  section('密钥')
  line('Trae key', cfg.trae.key ? `${cfg.trae.key.slice(0, 12)}…（已自动读取）` : paint(C.warn, '未读到 —— 部分接口会 401'))
  line('WorkBuddy key', cfg.workbuddy.key ? `${cfg.workbuddy.key.slice(0, 10)}…（已自动读取）` : paint(C.warn, '未读到'))

  section('服务状态')
  const snap = await snapshot(cfg, { deep: true })
  line('Trae 网关', `${mark(snap.trae.running)} ${cfg.trae.url}${snap.trae.running ? ` · ${snap.trae.accountCount ?? '?'} 账号` : ''}`)
  line('WorkBuddy 网关', `${mark(snap.workbuddy.running)} ${cfg.workbuddy.url}${snap.workbuddy.running ? ` · ${snap.workbuddy.modelCount ?? '?'} 模型` : ''}`)
  line('WorkBuddy Hub', `${mark(snap.hub.running)} ${cfg.hub.url}`)
  const consoleInfo = await consoleStatus(cfg)
  line('控制台', `${mark(consoleInfo.running)} ${consoleInfo.url}${consoleInfo.version ? ` · v${consoleInfo.version}` : ''}`)

  section('后台控制器')
  for (const c of snap.controllers || []) {
    line(c.name, `${c.alive === true ? paint(C.ok, '● 在跑') : c.alive === false ? paint(C.bad, '○ 未运行') : paint(C.dim, '? 未知')} ${paint(C.dim, c.id)}`)
  }
  if (!snap.controllers?.length) console.log(paint(C.dim, '  （配置里没有 controllers 段）'))

  section('控制台运行时')
  const server = consoleServerPath()
  line('后端脚本', fs.existsSync(server) ? `${paint(C.ok, '✓')} ${server}` : `${paint(C.bad, '✗')} 缺失：${server}`)
  const pythons = pythonCandidates(cfg).filter((p) => {
    if (!p.includes(path.sep)) return true
    return fs.existsSync(p)
  })
  line('Python 候选', pythons.slice(0, 3).join(', ') || paint(C.warn, '未找到 —— 控制台需要 Python 3.10+'))

  section('端口')
  for (const [label, raw] of [
    ['控制台', `127.0.0.1:${cfg.console.port}`],
    ['Trae', cfg.trae.url],
    ['WorkBuddy', cfg.workbuddy.url],
    ['Hub', cfg.hub.url],
  ]) {
    let host = '127.0.0.1'
    let port = 0
    try {
      const parsed = new URL(raw.startsWith('http') ? raw : `http://${raw}`)
      host = parsed.hostname || host
      port = Number(parsed.port)
    } catch {
      /* 地址写错就当离线显示 */
    }
    const up = port ? await probePort(host, port) : false
    line(label, `${up ? paint(C.ok, '●') : paint(C.dim, '○')} ${raw}`)
  }

  section('体检结论')
  if (!report.issues.length) {
    console.log(`  ${paint(C.ok, '没有发现问题。')}`)
  } else {
    for (const issue of report.issues) {
      const tag = issue.level === 'error' ? paint(C.bad, '[阻塞]') : paint(C.warn, '[提示]')
      console.log(`  ${tag} ${issue.message}`)
    }
  }

  console.log(`\n${paint(C.dim, '在 DSH 里打开： http://127.0.0.1:<dsh端口>/ai-gateway')}`)
  console.log(paint(C.dim, '要显式钉死路径：写 ~/.dsh/ai-gateway-console.json，或设 AIGW_TRAE_BASE / AIGW_WB_BASE / AIGW_HUB_BASE\n'))

  process.exit(report.ok ? 0 : 1)
}

main().catch((error) => {
  console.error(paint(C.bad, `自检异常：${error && error.stack ? error.stack : error}`))
  process.exit(1)
})
