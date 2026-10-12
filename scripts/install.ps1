#Requires -Version 5.1
<#
.SYNOPSIS
  把 dsh-ai-gateway-console 装进指定的 DeepSeek Harness profile。

.DESCRIPTION
  做三件事，每件都可单独跳过：

    1. 在 profile 的 package.json 里登记 link 依赖与 bundle 名（原文件自动备份）
    2. 把插件目录链进 profile 的 node_modules
    3. 探测本机网关位置并写进 ~/.dsh/ai-gateway-console.json（已有配置默认不覆盖）

  装完**需要重启 DSH** —— cordis 的插件树在启动时组装，新 bundle 不会热加载。
  本脚本不修改 DSH 安装目录里的任何文件，只动 profile 与配置文件。

.PARAMETER Profile
  profile 名，默认 desktop。可用 'default' / 'web' 等。

.PARAMETER RepoPath
  插件仓库根目录。默认取本脚本的上级目录。

.PARAMETER SkipProbe
  跳过网关路径探测（稍后手动跑 scripts\probe.mjs --write）。

.PARAMETER SkipLink
  只改 package.json，不建 node_modules 链接（想自己跑 pnpm install 时用）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Profile desktop -SkipProbe
#>
param(
    [string]$Profile = 'desktop',
    [string]$RepoPath = '',
    [switch]$SkipProbe,
    [switch]$SkipLink
)

$ErrorActionPreference = 'Stop'

function Say  { param($m) Write-Host "  $m" }
function Ok   { param($m) Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Fail { param($m) Write-Host "  [X]  $m" -ForegroundColor Red }

$PLUGIN_NAME = 'dsh-ai-gateway-console'

Write-Host ''
Write-Host "dsh-ai-gateway-console 安装器" -ForegroundColor Cyan
Write-Host ''

# ---------------------------------------------------------------- 定位
if (-not $RepoPath) { $RepoPath = Split-Path -Parent $PSScriptRoot }
if (-not (Test-Path -LiteralPath $RepoPath)) { Fail "插件目录不存在：$RepoPath"; exit 1 }
$RepoPath = (Resolve-Path -LiteralPath $RepoPath).Path

if (-not (Test-Path -LiteralPath (Join-Path $RepoPath 'package.json'))) {
    Fail "插件目录不完整（缺 package.json）：$RepoPath"
    exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $RepoPath 'cordis.patch.yml'))) {
    Fail "插件目录不完整（缺 cordis.patch.yml）：$RepoPath"
    exit 1
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome ('profiles\' + $Profile)

Say "插件目录   $RepoPath"
Say "DSH 主目录 $dshHome"
Say "目标 profile $profileDir"
Write-Host ''

if (-not (Test-Path -LiteralPath $profileDir)) {
    Fail "找不到 profile：$profileDir"
    Say '可用 profile：'
    $profilesRoot = Join-Path $dshHome 'profiles'
    if (Test-Path -LiteralPath $profilesRoot) {
        Get-ChildItem -LiteralPath $profilesRoot -Directory | ForEach-Object { Say "  - $($_.Name)" }
    } else {
        Say '  （profiles 目录不存在，DSH 是否已至少启动过一次？）'
    }
    exit 1
}

# ---------------------------------------------------------------- 1. package.json
$profilePkgPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $profilePkgPath)) {
    Fail "profile 里没有 package.json：$profilePkgPath"
    exit 1
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$profilePkgPath.bak-before-aigw-$stamp"
Copy-Item -LiteralPath $profilePkgPath -Destination $backup -Force
Ok "已备份原配置 -> $(Split-Path -Leaf $backup)"

$pkg = (Get-Content -LiteralPath $profilePkgPath -Raw -Encoding UTF8) | ConvertFrom-Json

$linkValue = 'link:' + ($RepoPath -replace '\\', '/')

if (-not $pkg.PSObject.Properties['dependencies']) {
    $pkg | Add-Member -NotePropertyName 'dependencies' -NotePropertyValue ([pscustomobject]@{})
}
$pkg.dependencies | Add-Member -NotePropertyName $PLUGIN_NAME -NotePropertyValue $linkValue -Force
Ok "dependencies.$PLUGIN_NAME = $linkValue"

if (-not $pkg.PSObject.Properties['dsh']) {
    $pkg | Add-Member -NotePropertyName 'dsh' -NotePropertyValue ([pscustomobject]@{})
}
if (-not $pkg.dsh.PSObject.Properties['profile']) {
    $pkg.dsh | Add-Member -NotePropertyName 'profile' -NotePropertyValue ([pscustomobject]@{})
}
$bundles = @()
if ($pkg.dsh.profile.PSObject.Properties['bundles']) { $bundles = @($pkg.dsh.profile.bundles) }
if ($bundles -notcontains $PLUGIN_NAME) { $bundles += $PLUGIN_NAME }
$pkg.dsh.profile | Add-Member -NotePropertyName 'bundles' -NotePropertyValue $bundles -Force
Ok "dsh.profile.bundles = $($bundles -join ', ')"

# JSON 必须无 BOM —— 带 BOM 的话 Node 侧 JSON.parse 直接抛错
$json = $pkg | ConvertTo-Json -Depth 12
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($profilePkgPath, $json, $utf8NoBom)
Ok "已写回 profile 配置"

# ---------------------------------------------------------------- 2. node_modules 链接
if ($SkipLink) {
    Warn '已跳过链接（-SkipLink）—— 记得自己跑 pnpm install'
} else {
    $nmDir = Join-Path $profileDir 'node_modules'
    if (-not (Test-Path -LiteralPath $nmDir)) {
        New-Item -ItemType Directory -Path $nmDir -Force | Out-Null
    }
    $linkPath = Join-Path $nmDir $PLUGIN_NAME
    $existing = Get-Item -LiteralPath $linkPath -Force -ErrorAction SilentlyContinue
    if ($existing) {
        if ($existing.LinkType -in @('Junction', 'SymbolicLink')) {
            Remove-Item -LiteralPath $linkPath -Force -Recurse
            Ok '已移除旧链接，准备重建'
        } else {
            Warn "同名真实目录已存在，跳过链接：$linkPath"
        }
    }
    if (-not (Test-Path -LiteralPath $linkPath)) {
        try {
            New-Item -ItemType Junction -Path $linkPath -Target $RepoPath | Out-Null
            Ok "已链接 node_modules\$PLUGIN_NAME -> $RepoPath"
        } catch {
            Warn "建链接失败：$($_.Exception.Message)"
            Say  '  改用 pnpm install（如果本机装了 pnpm）：'
            Say  "    cd `"$profileDir`"; pnpm install"
        }
    }
}

# ---------------------------------------------------------------- 3. 探测网关
$node = Get-ChildItem -LiteralPath (Join-Path $dshHome 'dsh-runtimes') -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue |
        Select-Object -First 1
if (-not $node) {
    $node = Get-Command node -ErrorAction SilentlyContinue
}

if ($SkipProbe) {
    Warn '已跳过路径探测（-SkipProbe）'
} elseif ($node) {
    Write-Host ''
    Say '探测本机网关位置…'
    $probe = Join-Path $RepoPath 'scripts\probe.mjs'
    & $node.FullName $probe --write
    if ($LASTEXITCODE -ne 0) { Warn '探测未完成，可稍后手动重跑' }
} else {
    Warn '没找到 node.exe，跳过探测。稍后手动跑：node scripts\probe.mjs --write'
}

# ---------------------------------------------------------------- 完成
Write-Host ''
Write-Host '安装完成' -ForegroundColor Green
Write-Host ''
Say '下一步：'
Say '  1. 重启 DSH（插件树在启动时组装，新 bundle 不会热加载）'
Say '  2. 重启后打开：http://127.0.0.1:<dsh端口>/ai-gateway'
Say '  3. 状态不对就先跑自检：node scripts\doctor.mjs'
Write-Host ''
Say "回滚：把 $backup 覆盖回 package.json，删掉 node_modules\$PLUGIN_NAME 即可"
Write-Host ''
