#Requires -Version 5.1
<#
.SYNOPSIS
  把这个插件推到 GitHub —— 建仓库、设远程、推送，一步到位。

.DESCRIPTION
  凭据只在本进程内使用，不会写进 .git/config：

    * 建仓库走 GitHub REST API（token 放在请求头里）
    * 推送用临时的带 token URL，推完 remote 里只留干净的 https 地址

  本机命令行默认不读系统代理，所以脚本会自己从注册表读一次 IE 代理设置
  传给 git —— 走不通的常见症状是 "schannel: failed to receive handshake"。

.PARAMETER User
  GitHub 用户名（或组织名）。

.PARAMETER Repo
  仓库名，默认 dsh-ai-gateway-console。

.PARAMETER Token
  有 repo 权限的 Personal Access Token。不给就读 $env:GITHUB_TOKEN。

.PARAMETER Private
  建成私有仓库。默认公开。

.PARAMETER AuthorName / AuthorEmail
  给了就把已有提交的作者改写成这对身份（用 GitHub 的 noreply 邮箱可以避免暴露真实邮箱）。
  不给则保留现状。

.PARAMETER Proxy
  HTTP 代理地址，如 http://127.0.0.1:7892。不给则自动从注册表读。

.EXAMPLE
  $env:GITHUB_TOKEN = 'ghp_xxx'
  powershell -ExecutionPolicy Bypass -File scripts\publish-to-github.ps1 `
      -User yourname -Private `
      -AuthorName yourname -AuthorEmail '1234567+yourname@users.noreply.github.com'

.EXAMPLE
  # 只改作者、先不推（演练）
  powershell -ExecutionPolicy Bypass -File scripts\publish-to-github.ps1 -User yourname -AuthorName you -AuthorEmail you@example.com -DryRun
#>
param(
    [Parameter(Mandatory = $true)][string]$User,
    [string]$Repo = 'dsh-ai-gateway-console',
    [string]$Token = $env:GITHUB_TOKEN,
    [switch]$Private,
    [string]$AuthorName = '',
    [string]$AuthorEmail = '',
    [string]$Proxy = '',
    [string]$Description = '本地 AI 反代网关（Trae / WorkBuddy / Hub）的 DeepSeek Harness 控制面插件',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Say  { param($m) Write-Host "  $m" }
function Ok   { param($m) Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Fail { param($m) Write-Host "  [X]  $m" -ForegroundColor Red }

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

Write-Host ''
Write-Host '推送到 GitHub' -ForegroundColor Cyan
Write-Host ''

# ---------------------------------------------------------------- 前置检查
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot '.git'))) {
    Fail "当前目录不是 git 仓库：$repoRoot"
    exit 1
}
Ok "仓库根：$repoRoot"

if (-not $Token) {
    Fail '没有 token。设 $env:GITHUB_TOKEN，或用 -Token 传入一个带 repo 权限的 PAT。'
    Say '  生成地址：https://github.com/settings/tokens  （勾 repo 即可）'
    exit 1
}

# ---------------------------------------------------------------- 代理
if (-not $Proxy) {
    try {
        $ie = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
        if ($ie -and $ie.ProxyEnable -eq 1 -and $ie.ProxyServer) {
            $Proxy = 'http://' + ($ie.ProxyServer -replace '^https?://', '')
        }
    } catch { }
}
if ($Proxy) { Say "使用代理：$Proxy" } else { Say '未检测到系统代理（直连）' }

$gitProxyArgs = @()
if ($Proxy) { $gitProxyArgs = @('-c', "http.proxy=$Proxy", '-c', "https.proxy=$Proxy") }

# ---------------------------------------------------------------- 改写作者
if ($AuthorName -and $AuthorEmail) {
    Say "改写提交身份为：$AuthorName <$AuthorEmail>"
    if ($DryRun) {
        Warn '演练模式，跳过改写'
    } else {
        $env:FILTER_BRANCH_SQUELCH_WARNING = '1'
        # 单行 filter：git 会用 sh 执行它。PS 里不要用 here-string 传参，
        # "@ 后面跟别的 token 在 5.1 上会被解析成语法错误。
        $envFilter = "export GIT_AUTHOR_NAME='$AuthorName'; " +
                     "export GIT_AUTHOR_EMAIL='$AuthorEmail'; " +
                     "export GIT_COMMITTER_NAME='$AuthorName'; " +
                     "export GIT_COMMITTER_EMAIL='$AuthorEmail'"
        git filter-branch -f --env-filter $envFilter -- --all 2>&1 | Select-Object -Last 3
        if (Test-Path -LiteralPath (Join-Path $repoRoot 'refs\original')) {
            Remove-Item -LiteralPath (Join-Path $repoRoot 'refs\original') -Recurse -Force -ErrorAction SilentlyContinue
        }
        Ok '已改写'
    }
} else {
    Warn '未指定作者身份，保留现有提交作者（用 -AuthorName/-AuthorEmail 可改写）'
}

git log --format='  作者: %an <%ae>' | Select-Object -Unique | ForEach-Object { Write-Host $_ }

# ---------------------------------------------------------------- 建仓库
$headers = @{
    Authorization          = "Bearer $Token"
    Accept                 = 'application/vnd.github+json'
    'User-Agent'           = 'dsh-ai-gateway-console'
    'X-GitHub-Api-Version' = '2022-11-28'
}

Say "校验 token…"
try {
    $me = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $headers -TimeoutSec 30
    Ok "已认证为 $($me.login)"
} catch {
    Fail "token 校验失败：$($_.Exception.Message)"
    exit 1
}

Say "检查仓库 $User/$Repo …"
$repoExists = $false
try {
    $null = Invoke-RestMethod -Uri "https://api.github.com/repos/$User/$Repo" -Headers $headers -TimeoutSec 30
    $repoExists = $true
    Warn '仓库已存在，将直接推送'
} catch {
    $repoExists = $false
}

if (-not $repoExists) {
    if ($DryRun) {
        Warn "演练模式，跳过创建仓库 $User/$Repo"
    } else {
        Say '创建仓库…'
        $payload = @{
            name        = $Repo
            description = $Description
            private     = [bool]$Private
            has_issues  = $true
            has_wiki    = $false
            auto_init   = $false
        } | ConvertTo-Json
        try {
            $created = Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Method Post `
                -Headers $headers -Body $payload -ContentType 'application/json' -TimeoutSec 60
            Ok "已创建：$($created.html_url)（$(if ($Private) { '私有' } else { '公开' })）"
        } catch {
            Fail "创建失败：$($_.Exception.Message)"
            Say '  若报 422，检查仓库名是否已被占用'
            exit 1
        }
    }
}

# ---------------------------------------------------------------- 推送
$cleanUrl = "https://github.com/$User/$Repo.git"
$pushUrl  = "https://${User}:${Token}@github.com/$User/$Repo.git"

if ($DryRun) {
    Warn "演练模式，跳过推送。将执行：git push $cleanUrl main"
    Write-Host ''
    exit 0
}

Say '设置 remote（不含 token）…'
$existing = git remote 2>$null
if ($existing -contains 'origin') {
    git remote set-url origin $cleanUrl
} else {
    git remote add origin $cleanUrl
}
Ok "origin = $cleanUrl"

Say '推送…'
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
# PS 对原生命令会把数组变量展开成多个参数；不要用 @var（那是 PS 命令的 splatting）
git $gitProxyArgs -c "credential.helper=" push $pushUrl $branch 2>&1 | Select-Object -Last 6
if ($LASTEXITCODE -ne 0) {
    Fail '推送失败'
    Say '  常见原因：'
    Say '    · token 没有 repo 权限'
    Say '    · 网络不通 —— 用 -Proxy http://127.0.0.1:7892 重试'
    Say "    · 远端分支冲突（当前本地分支：$branch）"
    exit 1
}
Ok '推送完成'

# 推完把临时 URL 从 reflog 里也擦掉，避免 token 残留在本地历史
git remote set-url origin $cleanUrl
Ok 'remote 已还原为干净地址（token 未落盘）'

Write-Host ''
Write-Host "完成：$cleanUrl" -ForegroundColor Green
Write-Host ''
