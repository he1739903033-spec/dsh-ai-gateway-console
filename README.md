# dsh-ai-gateway-console

把**本地 AI 反代网关**的部署状态与控制能力挂进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ——
一条命令看全三个服务的运行态、账号池、模型白名单和后台控制器。

> 这不是给某个人的机器写的脚本。它按「配置文件 → 常见位置扫描 → 特征文件识别」三级解析路径，
> 每个人的安装目录不同也能直接跑；网关密钥也从对方项目里自动读，不用手抄。

```
┌─ DSH ────────────────────────────────────────────────────────┐
│  /ai-gateway        状态页：三个服务 + 控制器，一屏看完         │
│  /ai-gateway/status 聚合快照（JSON，可给别的工具用）            │
│  /ai-gateway/logs   日志 tail（网关 / 守护 / 站点控制）         │
│  /ai-gateway/action 启动控制台 / 启动网关                      │
└──────────────────────────────────────────────────────────────┘
        │ 可选：拉起独立控制台（Python，带完整 Web UI）
        ▼
   127.0.0.1:8330  账号池 · 今日用量 · 模型白名单 · 网关配置编辑器
```

## 它管的是什么

| 组件 | 默认端口 | 说明 |
|---|---|---|
| **Trae 网关** | 8327 | 把 Trae CN 包成 OpenAI 兼容 API（`Trae2api-cn`，Python） |
| **WorkBuddy 网关** | 8317 | 把腾讯 CodeBuddy 包成 OpenAI 兼容 API（`workbuddy-gateway.exe`，Go） |
| **WorkBuddy Hub** | 8788 | 账号自动化 + 自带看板（`wb-proxy`，Python） |
| 后台控制器 | 无端口 | 看门狗 / 站点优先级控制等常驻脚本，靠**单实例互斥体**探测存活 |

这三个服务本身是独立项目，本插件**不打包它们**，只负责发现、聚合与控制。

## 前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| DeepSeek Harness | 已至少启动过一次 | 需要 `~/.dsh/profiles/<name>/` 存在 |
| Node.js | ≥ 18 | DSH 自带运行时，插件会自己找 |
| Python | 3.10+ | **只有**想用独立控制台 UI 时才需要；只用 DSH 状态页可以不装 |

## 安装

```powershell
git clone <本仓库地址> dsh-ai-gateway-console
cd dsh-ai-gateway-console
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

脚本做三件事，每件都可跳过：

1. 在 profile 的 `package.json` 里登记 `link:` 依赖与 bundle 名（**原文件自动备份**）
2. 把插件目录链进 profile 的 `node_modules`
3. 探测本机网关位置，写进 `~/.dsh/ai-gateway-console.json`

**然后重启 DSH** —— cordis 的插件树在启动时组装，新 bundle 不会热加载。

重启后打开 `http://127.0.0.1:<dsh端口>/ai-gateway`。

### 装完先自检

```powershell
node scripts\doctor.mjs
```

它会把「路径探测到了什么、哪个服务没起来、缺什么」一次说清，包括：

```
组件路径
  Trae 网关          ✓ D:\tools\Trae2api-cn
  WorkBuddy 网关     ✓ D:\tools\workbuddy-gateway
  WorkBuddy Hub      ✗ 未找到
服务状态
  Trae 网关          ● 在线 http://127.0.0.1:8327 · 2 账号
  WorkBuddy 网关     ● 在线 http://127.0.0.1:8317 · 1 模型
后台控制器
  服务守护           ● 在跑 watchdog
```

## 使用

### 在 DSH 里

| 地址 | 用途 |
|---|---|
| `/ai-gateway` | 状态页 —— 服务卡 + 控制器灯 + 快捷按钮，8 秒自刷 |
| `/ai-gateway/status?deep=1` | 完整快照（含控制器互斥体探测，约 0.5 秒） |
| `/ai-gateway/config` | GET 看当前配置与体检，POST 写回 |
| `/ai-gateway/logs?src=wb&n=200` | 日志 tail（`src` 取 `trae` / `wb` / 控制器 id） |
| `/ai-gateway/console` | 拉起控制台并跳转过去 |

### 独立控制台（可选）

装了 Python 的话，`/ai-gateway` 页面上的「启动控制台」会拉起完整 Web UI：
账号池（可切活跃 / 切模型开关）、今日用量、模型倍率实测、网关配置编辑器（白名单 / 站点绑定）、
六路日志实时 tail。也可以直接：

```powershell
python console\server.py
# 然后开 http://127.0.0.1:8330/
```

控制台与插件**共用同一份配置**，不会出现两处路径不一致。

## 路径是怎么自动找到的

三级策略，前者命中就不再往下走：

1. **显式配置** —— `~/.dsh/ai-gateway-console.json` 里的 `*.base`，或环境变量
   `AIGW_TRAE_BASE` / `AIGW_WB_BASE` / `AIGW_HUB_BASE`
2. **常见位置扫描** —— 家目录下的 `Tools`/`Documents`/`Desktop`/`Downloads`、
   各盘符的 `\Tools` 与根目录（可用 `AIGW_SEARCH_ROOTS` 追加）
3. **特征文件识别** —— 不只看目录名，还要求标志文件存在：

   | 组件 | 标志物（必须全部存在） |
   |---|---|
   | Trae | `web_login.py` + `src/main.py` |
   | WorkBuddy | `workbuddy-gateway.exe` |
   | Hub | `wb-proxy/wb_proxy.py` |

   所以你的目录叫 `trae-relay` 还是 `Trae2api-cn` 都能认出来。

**密钥同理**：Trae 的 key 从 `.env` / `src/main.py` 里抓 `trae-gw-<hex>`，
WorkBuddy 的 key 从 `WorkBuddyConsole.ps1` 里读 `GATEWAY_KEY` —— 每台机器都不同，
能自动读就不该让人手抄。

## 配置参考

配置文件 `~/.dsh/ai-gateway-console.json`（首次安装由探测生成，之后手改即可）：

```jsonc
{
  "console": { "host": "127.0.0.1", "port": 8330, "python": "", "autoStart": false },
  "trae": {
    "base": "D:/tools/Trae2api-cn",
    "url": "http://127.0.0.1:8327",
    "key": "trae-gw-……"
  },
  "workbuddy": {
    "base": "D:/tools/workbuddy-gateway",
    "url": "http://127.0.0.1:8317",
    "key": "……"
  },
  "hub": { "base": "D:/tools/workbuddy2api-hub", "url": "http://127.0.0.1:8788" },
  "controllers": [
    {
      "id": "watchdog",
      "name": "服务守护",
      "desc": "网关 + Hub 的看门狗",
      "mutex": "Local\\WorkBuddyServiceWatchdog",
      "log": "watchdog.log"
    }
  ]
}
```

插件的 `config` 段（`cordis.patch.yml`）只放三个与路径无关的开关：

```yaml
- insert:
    - id: ai-gateway-console
      name: 'dsh-ai-gateway-console'
      config:
        consolePort: 8330    # 覆盖控制台端口
        autoStart: false     # dsh 启动时自动拉起控制台
        statusTtlMs: 5000    # 快照缓存，避免面板刷新打爆网关
```

## 常见问题

**`/ai-gateway` 404**
插件没加载。确认 `install.ps1` 跑完、profile 的 `dsh.profile.bundles` 里有 `dsh-ai-gateway-console`，
然后**重启** DSH。`node scripts\doctor.mjs` 能看出配置问题。

**路径找不到我的网关**
先看 `node scripts\probe.mjs` 打印的搜索根，把你的目录加进 `AIGW_SEARCH_ROOTS`，或直接
在配置文件里写 `trae.base` / `workbuddy.base`。两条都不需要改代码。

**状态页显示「未知」而不是「在线/离线」**
控制器互斥体探测没拿到结果 —— 一般是 PowerShell 不可用或被执行策略挡住。
它只影响控制器那一格，不影响服务状态。

**控制台起不来**
`node scripts\doctor.mjs` 会列出 Python 候选路径。装了 Python 还是失败的话，
在配置里显式写 `console.python`（绝对路径）。

**多个 profile 都要装**
对每个 profile 跑一次 `install.ps1 -Profile <名字>`。插件目录只有一份，多个 profile 共享。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
```

撤销 `package.json` 的两处改动、删掉 `node_modules` 链接；配置文件默认保留（`-RemoveConfig` 可一并删）。
重启 DSH 生效。

## 目录结构

```
dsh-ai-gateway-console/
├── package.json          插件元数据（dsh.bundle.patch 指向 cordis.patch.yml）
├── cordis.patch.yml      bundle 补丁：注册插件条目 + 三个开关
├── lib/
│   ├── index.js          插件入口：注册 /ai-gateway/* 路由
│   ├── detect.js         路径与密钥探测（三级策略）
│   ├── config.js         配置读写与合并、体检
│   └── gateway.js        状态聚合、互斥体探测、进程管理
├── console/              独立控制台（可选组件，纯 Python 标准库）
│   ├── server.py         后端
│   ├── dashboard.html    前端（单文件，零外部依赖）
│   └── app.py            原生窗口壳（pywebview/WebView2）
├── scripts/
│   ├── install.ps1       安装
│   ├── uninstall.ps1     卸载
│   ├── probe.mjs         探测并写配置
│   └── doctor.mjs        环境自检
└── docs/
    ├── 安装.md
    ├── 网关部署.md        反代服务本身的部署方法
    └── 配置参考.md
```

## 设计约束

- **零外部依赖**：插件侧只用 `node:` 内置模块，profile 下解析不到 `node_modules` 也不会炸；
  控制台侧只用 Python 标准库。
- **不改别人的东西**：不碰 DSH 安装目录，不碰网关项目源码，只动 profile 的 `package.json`
  （带备份）与自己的配置文件。
- **只认本机来源**：所有路由都校验 `Host` 头是回环地址，局域网内别的机器打不开。
- **失败不传染**：任何一项探测失败只影响它自己那一格状态。

## License

MIT
