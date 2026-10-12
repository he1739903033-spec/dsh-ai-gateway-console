# 更新日志

本文件记录本插件的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [1.0.0] - 2026-10-13

首个版本。

### 新增

**DSH 插件本体（Host 半侧）**
- `lib/detect.js` —— 三级路径与密钥探测：显式配置 → 常见位置扫描 → 特征文件识别。
  不依赖目录名（`trae-relay` 和 `Trae2api-cn` 都能认出来），密钥从对方项目里自动读取。
- `lib/config.js` —— 配置解析与合并（默认值 ← 探测 ← 文件 ← 环境变量）、体检。
- `lib/gateway.js` —— 状态聚合、Windows 单实例互斥体探测、进程管理、日志 tail。
- `lib/index.js` —— 注册 `/ai-gateway/*` 路由：状态页、聚合快照、日志、配置读写、动作。
- 所有路由只接受回环来源（`Host` 头必须解析为 `127.0.0.1` / `localhost` / `::1`）。

**独立控制台（可选组件，纯 Python 标准库）**
- `console/server.py` —— 账号池、今日用量、模型白名单编辑、六路日志 tail、倍率实测。
- `console/dashboard.html` —— 单文件前端，零外部依赖。
- `console/app.py` —— 原生窗口壳（pywebview / WebView2），WebView2 不可用时回退浏览器。
- 控制台与插件**共用同一份配置**，不会出现两处路径不一致。

**脚本**
- `install.ps1` —— 登记 link 依赖与 bundle、建 node_modules 链接、探测并写配置。
- `uninstall.ps1` —— 撤销安装，配置文件默认保留。
- `probe.mjs` —— 单独跑探测，可写入配置（默认只补空缺，不覆盖手写值）。
- `doctor.mjs` —— 环境自检：路径、密钥、服务可达性、控制器存活、Python 候选、端口。
- `verify-install.mjs` —— 按包名解析入口并干跑 `apply()`，**不需要重启 DSH** 就能确认装对了。
- `publish-to-github.ps1` —— 建仓 + 推送一步完成，token 不落 `.git/config`。

### 设计取舍

- **零外部依赖**：插件侧只用 `node:` 内置模块；控制台侧只用 Python 标准库。
  profile 下解析不到 `node_modules` 也不会炸。
- **不改别人的东西**：不碰 DSH 安装目录，不碰网关项目源码，只动 profile 的 `package.json`（带备份）。
- **失败不传染**：任何一项探测失败只影响它自己那一格状态，不让整个快照挂掉。
- **GET 无副作用**：`/ai-gateway/console` 在控制台未运行时返回 409 并给出提示，
  必须显式带 `?start=1` 才会拉起进程 —— 预取和爬虫不该能启动本地进程。

### 已知限制

- 控制器存活探测依赖 PowerShell（`Add-Type` 编译 Win32 互斥体 API），
  执行策略受限或 PowerShell 不可用时该字段显示「未知」，不影响其他状态。
- 控制台需要 Python 3.10+；只用 DSH 状态页的话不必装。
- WorkBuddy 侧「今日用量」靠解析当天审计日志得出 —— 网关自身只在
  `workbuddy-status.json` 里落累计值，没有按天分桶。
