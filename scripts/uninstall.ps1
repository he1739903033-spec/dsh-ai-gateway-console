#Requires -Version 5.1
<#
.SYNOPSIS
  从 DSH profile 里卸载 dsh-ai-gateway-console。

.DESCRIPTION
  撤销 install.ps1 的两处改动（package.json 的 link 依赖与 bundle 名、node_modules 链接）。
  默认**保留** ~/.dsh/ai-gateway-console.json —— 里面是路径与密钥，重装时还能用；
  要一起删就加 -RemoveConfig。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
  powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -RemoveConfig
#>
param(
    [string]$Profile = 'desktop',
    [switch]$RemoveConfig
)

$ErrorActionPreference = 'Stop'

function Say  { param($m) Write-Host "  $m" }
function Ok   { param($m) Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Fail { param($m) Write-Host "  [X]  $m" -ForegroundColor Red }

$PLUGIN_NAME = 'dsh-ai-gateway-console'

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome ('profiles\' + $Profile)
$profilePkgPath = Join-Path $profileDir 'package.json'

Write-Host ''
Write-Host "卸载 $PLUGIN_NAME（profile: $Profile）" -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path -LiteralPath $profilePkgPath)) {
    Fail "找不到 profile 配置：$profilePkgPath"
    exit 1
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item -LiteralPath $profilePkgPath -Destination "$profilePkgPath.bak-before-aigw-remove-$stamp" -Force

$pkg = (Get-Content -LiteralPath $profilePkgPath -Raw -Encoding UTF8) | ConvertFrom-Json

if ($pkg.PSObject.Properties['dependencies'] -and $pkg.dependencies.PSObject.Properties[$PLUGIN_NAME]) {
    $pkg.dependencies.PSObject.Properties.Remove($PLUGIN_NAME)
    Ok "已移除 dependencies.$PLUGIN_NAME"
}

if ($pkg.PSObject.Properties['dsh'] -and $pkg.dsh.PSObject.Properties['profile'] -and $pkg.dsh.profile.PSObject.Properties['bundles']) {
    $bundles = @($pkg.dsh.profile.bundles) | Where-Object { $_ -ne $PLUGIN_NAME }
    $pkg.dsh.profile | Add-Member -NotePropertyName 'bundles' -NotePropertyValue $bundles -Force
    Ok "已从 bundles 移除（剩余：$($bundles -join ', ')）"
}

$json = $pkg | ConvertTo-Json -Depth 12
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($profilePkgPath, $json, $utf8NoBom)

$linkPath = Join-Path $profileDir "node_modules\$PLUGIN_NAME"
$item = Get-Item -LiteralPath $linkPath -Force -ErrorAction SilentlyContinue
if ($item) {
    if ($item.LinkType -in @('Junction', 'SymbolicLink')) {
        Remove-Item -LiteralPath $linkPath -Force -Recurse
        Ok '已删除 node_modules 链接'
    } else {
        Warn "那是真实目录，没动它：$linkPath"
    }
}

$cfgFile = Join-Path $dshHome 'ai-gateway-console.json'
if ($RemoveConfig) {
    if (Test-Path -LiteralPath $cfgFile) {
        Copy-Item -LiteralPath $cfgFile -Destination "$cfgFile.bak-$stamp" -Force
        Remove-Item -LiteralPath $cfgFile -Force
        Ok "已删除配置文件（备份：$cfgFile.bak-$stamp）"
    }
} else {
    Say "保留配置文件：$cfgFile（要删加 -RemoveConfig）"
}

Write-Host ''
Write-Host '卸载完成，重启 DSH 生效。' -ForegroundColor Green
Write-Host ''
