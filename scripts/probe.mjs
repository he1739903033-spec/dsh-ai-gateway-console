#!/usr/bin/env node
/**
 * 探测网关位置并（可选）写入配置文件。
 *
 *   node scripts/probe.mjs            只看探测结果，不动任何文件
 *   node scripts/probe.mjs --write    把探测结果写进 ~/.dsh/ai-gateway-console.json
 *   node scripts/probe.mjs --write --force   连已存在的配置也覆盖（默认只补空缺）
 *
 * 安装脚本会调它，也可以单独跑来排查「为什么没找到我的网关」。
 */

import fs from 'node:fs'

import { configPath, resolveConfig, saveConfig } from '../lib/config.js'
import { detectAll, detectTraeKey, detectWbKey, searchRoots, SIGNATURES } from '../lib/detect.js'

const write = process.argv.includes('--write')
const force = process.argv.includes('--force')

const found = detectAll()

const patch = {}
if (found.trae) {
  patch.trae = { base: found.trae, key: detectTraeKey(found.trae) }
}
if (found.workbuddy) {
  patch.workbuddy = { base: found.workbuddy, key: detectWbKey(found.workbuddy) }
}
if (found.hub) {
  patch.hub = { base: found.hub }
}

console.log('\n探测结果')
for (const kind of ['trae', 'workbuddy', 'hub']) {
  const label = SIGNATURES[kind].label
  const value = found[kind]
  console.log(`  ${label.padEnd(18)} ${value || '（未找到）'}`)
}
if (patch.trae?.key) console.log(`  Trae key           ${patch.trae.key.slice(0, 12)}…`)
if (patch.workbuddy?.key) console.log(`  WorkBuddy key      ${patch.workbuddy.key.slice(0, 10)}…`)

console.log(`\n搜索根（${searchRoots().length} 个）`)
for (const root of searchRoots()) console.log(`  ${root}`)

if (!write) {
  console.log(`\n未写文件。要写入配置：node scripts/probe.mjs --write`)
  console.log(`配置文件位置：${configPath()}\n`)
  process.exit(0)
}

// 默认只补空缺：不覆盖用户手写/手调过的路径
const existing = resolveConfig({ probeIfMissing: false })
const effective = {}
for (const [kind, value] of Object.entries(patch)) {
  const already = existing[kind]?.base
  if (already && !force) {
    console.log(`  ${kind}: 配置里已有 ${already}，保留（要覆盖加 --force）`)
    continue
  }
  effective[kind] = value
}

if (!Object.keys(effective).length) {
  console.log('\n没有需要写入的项。\n')
  process.exit(0)
}

const result = saveConfig(effective)
if (!result.ok) {
  console.error(`\n写入失败：${result.error}\n`)
  process.exit(1)
}
console.log(`\n已写入 ${result.file}`)
for (const [kind, value] of Object.entries(effective)) {
  console.log(`  ${kind}.base = ${value.base}`)
}
console.log('')
