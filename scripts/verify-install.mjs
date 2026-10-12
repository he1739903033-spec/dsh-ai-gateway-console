#!/usr/bin/env node
/**
 * 验证插件是否被正确安装进某个 DSH profile —— 不需要重启 DSH。
 *
 *   node scripts/verify-install.mjs
 *   node scripts/verify-install.mjs --profile desktop
 *
 * 检查四件事：
 *   1. profile 的 package.json 里登记了 link 依赖与 bundle 名
 *   2. node_modules 下能按包名解析到插件（DSH 就是这样找入口的）
 *   3. 入口能被真正 import，且导出了 cordis 需要的 name / inject / apply
 *   4. 入口能带着 mock ctx 跑完 apply（会注册路由，不发任何网络请求）
 *
 * 退出码 0 = 装好了（重启 DSH 后即可生效）；1 = 有问题，输出会指出是哪一步。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const PLUGIN_NAME = 'dsh-ai-gateway-console'

const profileArg = process.argv.indexOf('--profile')
const profile = profileArg > -1 ? process.argv[profileArg + 1] : 'desktop'

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profileDir = path.join(dshHome, 'profiles', profile)

const ok = (m) => console.log(`  \u001b[32m[OK]\u001b[0m ${m}`)
const bad = (m) => console.log(`  \u001b[31m[X] \u001b[0m ${m}`)
const info = (m) => console.log(`  \u001b[2m${m}\u001b[0m`)

let failed = false

console.log(`\n验证 ${PLUGIN_NAME} 是否已装进 profile「${profile}」`)
info(profileDir)
console.log('')

/* 1. package.json ------------------------------------------------------ */
const pkgPath = path.join(profileDir, 'package.json')
if (!fs.existsSync(pkgPath)) {
  bad(`profile 不存在或没有 package.json：${pkgPath}`)
  process.exit(1)
}

let profilePkg = null
try {
  profilePkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  ok('profile package.json 可解析')
} catch (error) {
  bad(`package.json 解析失败（常见原因：被写成了带 BOM 的 UTF-8）：${error.message}`)
  process.exit(1)
}

const dep = profilePkg.dependencies?.[PLUGIN_NAME]
if (!dep) {
  bad(`dependencies 里没有 ${PLUGIN_NAME} —— 跑 scripts/install.ps1`)
  failed = true
} else {
  ok(`dependencies.${PLUGIN_NAME} = ${dep}`)
}

const bundles = profilePkg.dsh?.profile?.bundles || []
if (!bundles.includes(PLUGIN_NAME)) {
  bad(`dsh.profile.bundles 里没有 ${PLUGIN_NAME} —— 插件不会被加载`)
  failed = true
} else {
  ok('dsh.profile.bundles 已登记')
}

/* 2. 模块解析 ---------------------------------------------------------- */
let entry = null
try {
  const requireFromProfile = createRequire(pkgPath)
  entry = requireFromProfile.resolve(PLUGIN_NAME)
  ok(`按包名解析到入口：${entry}`)
} catch (error) {
  bad(`解析不到包（node_modules 链接缺失？）：${error.message}`)
  failed = true
}

if (!entry) {
  console.log('')
  process.exit(1)
}

/* 3. 导入与导出 -------------------------------------------------------- */
let mod = null
try {
  mod = await import(pathToFileURL(entry).href)
  ok('入口 import 成功')
} catch (error) {
  bad(`import 失败：${error.message}`)
  process.exit(1)
}

if (mod.name !== 'ai-gateway-console') {
  bad(`导出的 name 不对：${mod.name}`)
  failed = true
} else {
  ok(`name = ${mod.name}`)
}
if (!Array.isArray(mod.inject) || !mod.inject.includes('webServer')) {
  bad(`inject 里缺少 webServer：${JSON.stringify(mod.inject)}`)
  failed = true
} else {
  ok(`inject = ${JSON.stringify(mod.inject)}`)
}
if (typeof mod.apply !== 'function') {
  bad('没有导出 apply()')
  failed = true
} else {
  ok('apply() 存在')
}

/* 4. 干跑 apply -------------------------------------------------------- */
if (typeof mod.apply === 'function') {
  const routes = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) {
      const d = fn()
      return () => {
        if (typeof d === 'function') d()
      }
    },
    webServer: {
      register(def) {
        routes.set(def.path, def)
        return () => routes.delete(def.path)
      },
    },
  }
  try {
    mod.apply(ctx, {})
    ok(`apply() 干跑通过，注册了 ${routes.size} 条路由`)
    for (const p of routes.keys()) info(`    ${p}`)
  } catch (error) {
    bad(`apply() 抛异常：${error.message}`)
    failed = true
  }
}

console.log('')
if (failed) {
  console.log('\u001b[33m还有问题没解决 —— 修完再重启 DSH。\u001b[0m\n')
  process.exit(1)
}
console.log('\u001b[32m一切就绪。重启 DSH 后打开 http://127.0.0.1:<dsh端口>/ai-gateway\x1b[0m\n')
