#!/usr/bin/env python3
"""AI 网关控制台 v2 —— 三个本地反代服务 + 三个后台控制器的统一控制面。

覆盖：
  * Trae 网关      127.0.0.1:8327   Trae2api-cn（Python）  账号池 / 轮询 / 签到 / 用量
  * WorkBuddy 网关 127.0.0.1:8317   workbuddy-gateway.exe（Go）凭据池 / 模型 / 站点绑定
  * WorkBuddy Hub  127.0.0.1:8788   wb_proxy.py（Python）  账号自动化 + 自带看板
  * watchdog / v41flash 控制器 / keepawake —— 三个无端口的隐藏控制器

设计取向跟随自托管面板（gethomepage/homepage、glance、clash 系 dashboard）：
一个常驻轻量服务把所有本地服务的状态与动作聚合成一页；服务端执行所有动作，
前端只发指令，因此页面不持有任何密钥、也没有跨域问题。只用标准库。

Windows 专有部分（mutex / pid 探测）用 ctypes，非 Windows 上自动降级为未知。
"""

from __future__ import annotations

import concurrent.futures
import ctypes
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from ctypes import wintypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = 8330
VERSION = "2.0.0"


# ---------------------------------------------------------------- 路径与常量
def _resource_dir() -> Path:
    """只读资源目录：打包后是 PyInstaller 解压目录，源码运行时是脚本目录。"""
    bundled = getattr(sys, "_MEIPASS", None)
    return Path(bundled) if bundled else Path(__file__).resolve().parent


def _data_dir() -> Path:
    """可写数据目录：打包后跟随 exe，源码运行时跟随脚本。

    不能复用 _resource_dir()：_MEIPASS 是临时目录，进程退出即被删除，
    rates.json 写在那里下次启动就丢了。
    """
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


BASE_DIR = _resource_dir()
DATA_DIR = _data_dir()


# ---------------------------------------------------------------- 配置解析
# 与 Node 侧 lib/config.js 同一套三级策略：显式配置 → 常见位置扫描 → 特征文件识别。
# 每个人的网关装在不同地方，所以这里不假设任何固定路径。

CONFIG_ENV = "AIGW_CONFIG"

# 各组件的身份特征：markers 必须全部存在才算命中 —— 只看目录名会误判
_SIGNATURES = {
    "trae": {
        "dirs": ["Trae2api-cn", "Trae2api", "trae2api-cn", "trae-relay", "TraeRelay"],
        "markers": ["web_login.py", "src/main.py"],
    },
    "workbuddy": {
        "dirs": ["workbuddy-gateway", "workbuddy", "WorkBuddyGateway"],
        "markers": ["workbuddy-gateway.exe"],
    },
    "hub": {
        "dirs": ["workbuddy2api-hub", "workbuddy-hub"],
        "markers": ["wb-proxy/wb_proxy.py"],
    },
}


def _config_candidates() -> list:
    out = []
    env = os.environ.get(CONFIG_ENV)
    if env:
        out.append(Path(env))
    out.append(Path(os.path.expanduser("~/.dsh")) / "ai-gateway-console.json")
    out.append(Path(__file__).resolve().parent.parent / "config.json")
    return out


def _load_config() -> dict:
    for candidate in _config_candidates():
        try:
            data = json.loads(candidate.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except Exception:
            continue
    return {}


def _search_roots() -> list:
    home = Path.home()
    roots, seen = [], set()

    def add(value):
        if not value:
            return
        try:
            resolved = Path(value).resolve()
        except Exception:
            return
        if str(resolved) in seen or not resolved.exists():
            return
        seen.add(str(resolved))
        roots.append(resolved)

    for extra in os.environ.get("AIGW_SEARCH_ROOTS", "").split(os.pathsep):
        add(extra.strip())
    for sub in ("Tools", "tools", "Documents", "Desktop", "Downloads", "opt"):
        add(home / sub)
    for drive in ("C", "D", "E", "F", "G"):
        add(Path(f"{drive}:/Tools"))
    add(home)
    for drive in ("C", "D", "E", "F", "G"):
        add(Path(f"{drive}:/"))
    return roots


def _matches(directory: Path, spec: dict) -> bool:
    try:
        return all((directory / marker).exists() for marker in spec["markers"])
    except Exception:
        return False


def _detect(kind: str):
    spec = _SIGNATURES.get(kind)
    if not spec:
        return None
    roots = _search_roots()
    for root in roots:
        for name in spec["dirs"]:
            candidate = root / name
            if _matches(candidate, spec):
                return candidate
    for root in roots:
        try:
            entries = [e for e in root.iterdir() if e.is_dir()]
        except Exception:
            continue
        for entry in entries:
            if _matches(entry, spec):
                return entry
    return None


def _detect_key(kind: str, base) -> str:
    """从对方项目里读网关密钥 —— 每台机器都不同，能自动读就不该让用户手抄。"""
    if not base:
        return ""
    if kind == "trae":
        files = [base / ".env", base / "src" / "main.py", base / "部署与使用说明.md"]
        pattern = r"trae-gw-[0-9a-fA-F]{16,}"
    else:
        files = [base / "WorkBuddyConsole.ps1", base / "launch-gateway.vbs"]
        pattern = r"GATEWAY_KEY\s*=\s*'([^']+)'"
    for path in files:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        found = re.search(pattern, text)
        if found:
            return found.group(1) if found.groups() else found.group(0)
    return ""


CFG = _load_config()
_trae_cfg = CFG.get("trae") or {}
_wb_cfg = CFG.get("workbuddy") or {}
_hub_cfg = CFG.get("hub") or {}
_console_cfg = CFG.get("console") or {}


def _env_or(name: str, fallback: str) -> str:
    return os.environ.get(name) or fallback


TRAE_BASE = Path(_trae_cfg["base"]) if _trae_cfg.get("base") else (_detect("trae") or Path())
WB_BASE = Path(_wb_cfg["base"]) if _wb_cfg.get("base") else (_detect("workbuddy") or Path())
HUB_BASE = Path(_hub_cfg["base"]) if _hub_cfg.get("base") else (_detect("hub") or Path())

TRAE_URL = _env_or("AIGW_TRAE_URL", _trae_cfg.get("url") or "http://127.0.0.1:8327")
WB_URL = _env_or("AIGW_WB_URL", _wb_cfg.get("url") or "http://127.0.0.1:8317")
HUB_URL = _env_or("AIGW_HUB_URL", _hub_cfg.get("url") or "http://127.0.0.1:8788")

TRAE_KEY = _env_or("AIGW_TRAE_KEY", _trae_cfg.get("key") or _detect_key("trae", TRAE_BASE))
WB_KEY = _env_or("AIGW_WB_KEY", _wb_cfg.get("key") or _detect_key("workbuddy", WB_BASE))

PORT = int(_console_cfg.get("port") or os.environ.get("AIGW_CONSOLE_PORT") or PORT)

DASHBOARD = BASE_DIR / "dashboard.html"
RATES_FILE = DATA_DIR / "rates.json"

TRAE_LOG = TRAE_BASE / "logs" / "gateway.log"
TRAE_AUTH_LOG = TRAE_BASE / "logs" / "auth.log"
WB_LOGS = WB_BASE / "logs"
WB_STATUS = WB_BASE / "workbuddy-status.json"
WB_CONFIG = WB_BASE / "config.json"

DSH_HOME = Path(os.path.expanduser("~/.dsh"))
DSH_PROFILE = _console_cfg.get("profile") or os.environ.get("AIGW_PROFILE") or "desktop"
DSH_CONFIG = DSH_HOME / "profiles" / DSH_PROFILE / "cordis.patch.yml"

# 倍率实测的对象清单：优先取配置里的 rateModels；留空时再从 DSH 的 provider 配置里刮。
# 两者都拿不到就不实测 —— 猜一组模型名发请求只会浪费额度。
RATE_MODELS = CFG.get("rateModels") or []


def wb_cred_files() -> list:
    """现扫账号文件 —— 运行中新增的账号要能立刻出现在界面上。

    要排掉网关自己的状态快照：workbuddy-status.json 同样匹配 workbuddy*.json，
    但它不是凭据，混进列表会让"账号数"虚高。
    """
    try:
        skip = {WB_STATUS.name, WB_CONFIG.name}
        return sorted(p.name for p in WB_BASE.glob("workbuddy*.json") if p.name not in skip)
    except Exception:
        return []

# 后台控制器：没有监听端口，靠单实例互斥体探测存活 —— 控制器进程持有它直到
# 退出，内核在进程死亡的瞬间释放，所以探测 mutex 等价于探测存活，且不受
# 命令行嗅探那类误判影响（见 guard-workbuddy-gateway.ps1 的注释）。
# 这份清单可在配置文件的 controllers 段整体替换。
DEFAULT_CONTROLLERS = [
    {
        "id": "watchdog",
        "name": "服务守护",
        "desc": "网关 + Hub 的看门狗，30 秒内拉起掉线服务",
        "mutex": r"Local\WorkBuddyServiceWatchdog",
        "log": "watchdog.log",
    },
    {
        "id": "v41flash",
        "name": "v4.1-flash 站点控制",
        "desc": "免费站点可用时把付费账号移出池子；被限流/失联时放回",
        "mutex": r"Local\WorkBuddyV41FlashPriority",
        "log": "v41flash-priority.log",
    },
]
CONTROLLERS = CFG.get("controllers") or DEFAULT_CONTROLLERS


# ---------------------------------------------------------------- Win32 探测
_k32 = ctypes.WinDLL("kernel32", use_last_error=True)
_k32.OpenMutexW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
_k32.OpenMutexW.restype = wintypes.HANDLE
_k32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
_k32.WaitForSingleObject.restype = wintypes.DWORD
_k32.ReleaseMutex.argtypes = [wintypes.HANDLE]
_k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
_k32.OpenProcess.restype = wintypes.HANDLE
_k32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
_k32.CloseHandle.argtypes = [wintypes.HANDLE]

SYNCHRONIZE = 0x00100000
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
WAIT_OBJECT_0 = 0x0
WAIT_TIMEOUT = 0x102
STILL_ACTIVE = 259


def mutex_held(name: str) -> bool:
    """互斥体被别的进程持有 == 对应控制器活着。

    拿到句柄后试 Wait(0)：立刻拿到说明无人持有（进程已死），
    超时（WAIT_TIMEOUT）说明持有者还在。句柄一律释放。
    """
    handle = _k32.OpenMutexW(SYNCHRONIZE, False, name)
    if not handle:
        return False
    try:
        result = _k32.WaitForSingleObject(handle, 0)
        if result == WAIT_OBJECT_0:
            _k32.ReleaseMutex(handle)
            return False
        return result == WAIT_TIMEOUT
    finally:
        _k32.CloseHandle(handle)


def pid_alive(pid: int) -> bool:
    handle = _k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        return False
    try:
        code = wintypes.DWORD()
        if not _k32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == STILL_ACTIVE
    finally:
        _k32.CloseHandle(handle)


# ---------------------------------------------------------------- 通用 HTTP
def _request(url: str, method: str = "GET", payload=None, headers=None, timeout: float = 4.0):
    body = None
    head = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        head["Content-Type"] = "application/json"
    head.update(headers or {})
    req = urllib.request.Request(url, data=body, method=method, headers=head)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"_raw": raw[:4000]}
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="replace")[:600]
        except Exception:
            pass
        return {"_error": f"HTTP {exc.code}", "_detail": detail}
    except Exception as exc:  # noqa: BLE001 - 网络层任何异常都当作"不可达"
        return {"_error": str(exc)}


def _get(url: str, headers=None, timeout: float = 4.0):
    return _request(url, "GET", None, headers, timeout)


def _post(url: str, payload=None, headers=None, timeout: float = 15.0):
    return _request(url, "POST", payload if payload is not None else {}, headers, timeout)


def _read_json_file(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json_file(path: Path, obj) -> None:
    """写 UTF-8 无 BOM —— Go 的 encoding/json 见到 BOM 会直接解析失败。"""
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def tail_lines(path: Path, count: int = 200, window: int = 512 * 1024) -> list[str]:
    """只读文件尾部一个窗口，避免把 18 MB 的日志整个读进内存。"""
    try:
        size = path.stat().st_size
        with path.open("rb") as fh:
            if size > window:
                fh.seek(size - window)
                fh.readline()  # 丢弃可能被截断的首行
            data = fh.read()
        text = data.decode("utf-8", errors="replace")
        return text.splitlines()[-count:]
    except Exception:
        return []


def latest_wb_log() -> Path | None:
    try:
        files = sorted(WB_LOGS.glob("gateway-*.log"), key=lambda p: p.stat().st_mtime)
        return files[-1] if files else None
    except Exception:
        return None


def _run(args: list, cwd: Path | None = None) -> None:
    subprocess.Popen(
        args,
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def _run_console(args: list, cwd: Path | None = None) -> None:
    """给需要用户交互的命令（登录扫码）开一个可见控制台。

    不能用 _run：扫码提示和二维码要让人看见。
    """
    subprocess.Popen(args, cwd=str(cwd) if cwd else None,
                     creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0))


def wb_next_cred_file(intl: bool) -> str:
    """给新账号挑一个不会覆盖既有账号的文件名。

    gateway 用 workbuddy*.json 自动发现账号池，所以新文件同样会被自动加载。
    刻意避开 workbuddy.json —— 那是 v41flash 控制器专门托管的主 CN 账号，
    新建的账号放进去会被控制器当成它自己那份来回搬。
    """
    taken = {p.name for p in WB_BASE.glob("workbuddy*.json")}
    if intl:
        n = 1
        while True:
            name = "workbuddy-intl.json" if n == 1 else f"workbuddy-intl{n}.json"
            if name not in taken:
                return name
            n += 1
    n = 2
    while True:
        name = f"workbuddy{n}.json"
        if name not in taken:
            return name
        n += 1


def wb_login(intl: bool, name: str = "") -> dict:
    """打开登录窗口。name 非空时按指定文件重新登录（更新已有账号的 token）。"""
    if name:
        # 文件名来自前端，只允许账号文件形态，挡掉路径穿越
        if not re.fullmatch(r"workbuddy[\w.-]*\.json", name):
            raise ValueError(f"非法的账号文件名: {name}")
    else:
        name = wb_next_cred_file(intl)
    args = [str(WB_BASE / "workbuddy-gateway.exe"), "login"]
    if intl:
        args.append("-intl")
    args += ["-auth", name]
    _run_console(args, cwd=WB_BASE)
    return {"cred_file": name, "intl": intl, "relogin": bool(name)}


# ---------------------------------------------------------------- 轻量缓存
_cache_lock = threading.Lock()
_cache: dict = {}


def _cached(key: str, ttl: float, producer):
    """给上游轮询做节流。

    状态带每 5 秒刷一次，Trae 页也要同一份用量 —— 不缓存的话每个周期都会
    打到 Trae 网关上，而 /api/overview 实测要 2 秒左右。
    """
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    value = producer()
    with _cache_lock:
        _cache[key] = (time.time(), value)
    return value


# ---------------------------------------------------------------- Trae 快照
def trae_status() -> dict:
    return _get(f"{TRAE_URL}/v1/status", timeout=2.5)


def trae_accounts() -> dict:
    return _get(f"{TRAE_URL}/api/accounts", timeout=3.0)


def trae_overview(days: int = 7) -> dict:
    return _cached(
        f"trae-overview:{int(days)}",
        8.0,
        lambda: _get(f"{TRAE_URL}/api/overview?days={int(days)}", timeout=10.0),
    )


def trae_checkin() -> dict:
    return _cached(
        "trae-checkin",
        20.0,
        lambda: _get(f"{TRAE_URL}/api/checkin/accounts", timeout=10.0),
    )


def trae_today() -> dict:
    """今日用量精简版 —— 状态带每轮刷新都要用，所以只取 today 一块。

    注意 /api/overview 的用量嵌在 usage 键下，不是顶层。
    """
    ov = trae_overview(7)   # 与 Trae 页共用同一份缓存，避免重复打上游
    usage = (ov or {}).get("usage") or {}
    today = usage.get("today") or {}
    if not today:
        return {}
    return {
        "requests": today.get("requests"),
        "completed": today.get("completed"),
        "failed": today.get("failed"),
        "tokens": today.get("total_tokens"),
        "credits": today.get("credits"),
    }


def trae_snapshot(full: bool = False) -> dict:
    status = trae_status()
    if status.get("_error"):
        return {"running": False, "port": 8327, "url": TRAE_URL}
    accounts = trae_accounts()
    acc_list = accounts.get("accounts") or []
    polling = accounts.get("polling") or {}
    snap = {
        "running": True,
        "port": 8327,
        "url": TRAE_URL,
        "edition": status.get("edition") or "",
        "source": status.get("source") or "",
        "upstream": status.get("upstream_mode") or "",
        "authorized": bool(status.get("has_token")),
        "token_ok": bool(status.get("token_ok")),
        "account_count": len(acc_list),
        "active_account": polling.get("active_account") or accounts.get("active") or "",
        "polling": bool(polling.get("enabled")),
        "polling_mode": polling.get("mode") or "",
        "accounts": [
            {
                "id": a.get("id") or a.get("user_id"),
                "label": a.get("label") or a.get("user_id"),
                "valid": bool(a.get("is_valid")),
                "active": bool(a.get("is_active")),
                "model_enabled": bool(a.get("model_enabled")),
                "checked_in": bool(a.get("checked_in")),
                "expires": a.get("expires"),
                "credits": a.get("account_credits") or None,
            }
            for a in acc_list
        ],
    }
    if full:
        # overview 与 checkin 互不依赖，串行要等两份；并行只等最慢的一份。
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            f_ov = pool.submit(trae_overview)
            f_ci = pool.submit(trae_checkin)
            snap["overview"] = f_ov.result()
            snap["checkin"] = f_ci.result()
    return snap


# ---------------------------------------------------------------- WorkBuddy 快照
def wb_health() -> dict:
    return _get(f"{WB_URL}/health", headers={"Authorization": f"Bearer {WB_KEY}"}, timeout=2.5)


def wb_status_file() -> dict:
    return _read_json_file(WB_STATUS, {}) or {}


def wb_config() -> dict:
    cfg = _read_json_file(WB_CONFIG, {}) or {}
    models = cfg.get("models") or {}
    return {
        "allowlist": models.get("allowlist") or [],
        "blocklist": models.get("blocklist") or [],
        "accounts": models.get("accounts") or {},
    }


def wb_snapshot() -> dict:
    health = wb_health()
    status = wb_status_file()
    if health.get("_error") and not status:
        return {"running": False, "port": 8317, "url": WB_URL}
    accounts = []
    for a in status.get("accounts") or []:
        accounts.append({
            "path": a.get("path") or "",
            "nickname": a.get("nickname") or "-",
            "edition": a.get("edition") or "",
            "plan": a.get("planLabel") or "-",
            "state": a.get("state") or "-",
            "quotaRemaining": a.get("quotaRemaining"),
            "quotaTotal": a.get("quotaTotal"),
            "quotaUsed": a.get("quotaUsed"),
            "paid": bool(a.get("isPaidUser")),
            "expires": a.get("tokenExpiresAt"),
            "modelStates": a.get("modelStates") or {},
        })
    models = []
    for m in status.get("models") or []:
        models.append({
            "id": m.get("id"),
            "cnMultiplier": m.get("cnMultiplier"),
            "intlMultiplier": m.get("intlMultiplier"),
            "availableAccounts": m.get("availableAccounts"),
            "requests": m.get("requests"),
            "success": m.get("success"),
            "failed": m.get("failed"),
            "tokens": m.get("tokens"),
            "lastStatus": m.get("lastStatus"),
        })
    return {
        "running": not health.get("_error"),
        "port": 8317,
        "url": WB_URL,
        "hub_url": HUB_URL,
        "version": health.get("version") or "",
        "model_count": health.get("model_count"),
        "model_source": health.get("model_source") or "",
        "updated": status.get("updatedAt"),
        "accounts": accounts,
        "models": models,
        "config": wb_config(),
        "cred_files": wb_cred_files(),
        "today": wb_today(),
    }


def hub_health() -> dict:
    return _get(f"{HUB_URL}/health", timeout=2.5)


def _parse_wb_log_today() -> dict:
    """从当天的审计日志里现算今日用量。

    网关只在 status.json 里落**累计**统计（requests/success/tokens），没有按天的
    分桶，而审计日志的文件名自带日期（gateway-YYYY-MM-DD.log），所以当天那一份
    就是"今日"的完整事实来源。
    """
    path = WB_LOGS / f"gateway-{time.strftime('%Y-%m-%d')}.log"
    if not path.exists():
        return {}
    req = done = tokens = 0
    ttfts: list[float] = []
    elapsed: list[float] = []
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if "[模型Token累计]" in line:
                    m = re.search(r"本次token=(\d+)", line)
                    if m:
                        tokens += int(m.group(1))
                elif "-> Upstream [Model:" in line:
                    req += 1
                elif "输出完成" in line:
                    done += 1
                    m = re.search(r"耗时 ([\d.]+)s, 首字 ([\d.]+)s", line)
                    if m:
                        elapsed.append(float(m.group(1)))
                        ttfts.append(float(m.group(2)))
    except Exception:
        return {}
    return {
        "requests": req,
        "completed": done,
        "failed": max(0, req - done),
        "tokens": tokens,
        "avg_ttft_ms": round(sum(ttfts) / len(ttfts) * 1000) if ttfts else None,
        "avg_elapsed_ms": round(sum(elapsed) / len(elapsed) * 1000) if elapsed else None,
        "log": path.name,
    }


def wb_today() -> dict:
    # 日志当天最大见过 18 MB，30 秒缓存足够把解析成本摊平
    return _cached("wb-today", 30.0, _parse_wb_log_today)


# ---------------------------------------------------------------- 控制器状态
def controllers_snapshot() -> list[dict]:
    out = []
    for spec in CONTROLLERS:
        alive = False
        detail = ""
        if spec.get("mutex"):
            alive = mutex_held(spec["mutex"])
        elif spec.get("pid_file"):
            pid_file = WB_LOGS / spec["pid_file"]
            try:
                pid = int(pid_file.read_text(encoding="ascii").strip())
                alive = pid_alive(pid)
                detail = f"pid {pid}"
            except Exception:
                alive = False
                detail = "无 pid 记录"
        out.append({
            "id": spec["id"],
            "name": spec["name"],
            "desc": spec["desc"],
            "alive": alive,
            "detail": detail,
            "log": spec["log"],
        })
    return out


# ---------------------------------------------------------------- 日志源
LOG_SOURCES = {
    "trae": lambda: TRAE_LOG,
    "trae-auth": lambda: TRAE_AUTH_LOG,
    "wb": latest_wb_log,
    "watchdog": lambda: WB_LOGS / "watchdog.log",
    "v41flash": lambda: WB_LOGS / "v41flash-priority.log",
    "credential": lambda: WB_LOGS / "credential-sync.log",
}


def read_log(src: str, count: int = 200) -> dict:
    getter = LOG_SOURCES.get(src)
    if not getter:
        return {"error": f"未知日志源: {src}"}
    path = getter()
    if not path or not path.exists():
        return {"source": src, "path": "", "lines": [], "missing": True}
    return {
        "source": src,
        "path": str(path),
        "size": path.stat().st_size,
        "lines": tail_lines(path, count),
    }


# ---------------------------------------------------------------- 模型倍率实测
_rate_lock = threading.Lock()
_rate_state: dict = {
    "running": False,
    "progress": "",
    "results": [],
    "updated": None,
    "error": None,
}


def _load_rates() -> None:
    data = _read_json_file(RATES_FILE)
    if isinstance(data, dict) and data.get("results"):
        with _rate_lock:
            _rate_state["results"] = data.get("results") or []
            _rate_state["updated"] = data.get("updated")


def _save_rates() -> None:
    try:
        RATES_FILE.write_text(
            json.dumps(
                {"results": _rate_state["results"], "updated": _rate_state["updated"]},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception:
        pass


def _trae_models_for_measure() -> list[str]:
    """要实测的模型清单。

    优先取配置里的 rateModels；留空时从 DSH 的 provider 配置里刮 ——
    那份配置里的模型清单天然就是"当前真正在用的那几个"。
    两者都拿不到就返回空，由调用方给出明确提示，而不是猜一组名字乱发请求。
    """
    if RATE_MODELS:
        return list(RATE_MODELS)
    try:
        text = DSH_CONFIG.read_text(encoding="utf-8")
        match = re.search(r"trae-local:.*?\n\s*models:\s*\n(.*?)(?=\n-\s*id:|\Z)", text, re.S)
        if match:
            ids = re.findall(r"^\s+- id:\s*(.+?)\s*$", match.group(1), re.M)
            if ids:
                return [i.strip() for i in ids]
    except Exception:
        pass
    return []


def _trae_records() -> list[dict]:
    data = _read_json_file(TRAE_BASE / "data" / "usage_records.json", {})
    return (data or {}).get("records") or []


def _call_model(model: str) -> dict:
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "请只回复两个字：收到"}],
        "max_tokens": 64,
        "stream": False,
        "reasoning_effort": "max",
    }
    return _post(
        f"{TRAE_URL}/v1/chat/completions",
        payload,
        headers={"Authorization": f"Bearer {TRAE_KEY}"},
        timeout=240,
    )


def _measure_worker(models: list[str]) -> None:
    results: list[dict] = []
    try:
        for model in models:
            with _rate_lock:
                _rate_state["progress"] = f"正在测试 {model}"
            before = {r.get("request_id") for r in _trae_records()}
            resp = _call_model(model)
            credits = None
            if "_error" not in resp:
                # 积分账单异步落库，轮询等待
                for _ in range(15):
                    time.sleep(2)
                    for rec in _trae_records():
                        if rec.get("request_id") in before:
                            continue
                        if rec.get("model") == model and rec.get("status") == "completed":
                            credits = rec.get("credits_consumed")
                            break
                    if credits is not None:
                        break
            usage = resp.get("usage") or {}
            results.append({
                "model": model,
                "credits": credits,
                "prompt_tokens": usage.get("prompt_tokens"),
                "completion_tokens": usage.get("completion_tokens"),
                "error": resp.get("_error"),
            })

        for item in results:
            total = (item.get("prompt_tokens") or 0) + (item.get("completion_tokens") or 0)
            item["ratio"] = (item["credits"] / total) if (item.get("credits") and total) else None
        floor = min((i["ratio"] for i in results if i.get("ratio")), default=None)
        for item in results:
            item["relative"] = (item["ratio"] / floor) if (item.get("ratio") and floor) else None

        with _rate_lock:
            _rate_state["results"] = results
            _rate_state["updated"] = time.time()
            _rate_state["progress"] = "完成"
            _rate_state["error"] = None
        _save_rates()
    except Exception as exc:  # noqa: BLE001
        with _rate_lock:
            _rate_state["error"] = str(exc)
            _rate_state["progress"] = "失败"
    finally:
        with _rate_lock:
            _rate_state["running"] = False


def start_measure() -> bool:
    models = _trae_models_for_measure()
    if not models:
        with _rate_lock:
            _rate_state["error"] = (
                "没有可实测的模型：请在配置文件里加 rateModels 数组，"
                f"或确认 DSH provider 配置可达（当前找的是 {DSH_CONFIG}）"
            )
            _rate_state["progress"] = "无法开始"
        return False
    with _rate_lock:
        if _rate_state["running"]:
            return False
        _rate_state["running"] = True
        _rate_state["progress"] = "准备中…"
        _rate_state["error"] = None
    threading.Thread(
        target=_measure_worker,
        args=(models,),
        daemon=True,
    ).start()
    return True


# ---------------------------------------------------------------- 动作
def start_trae() -> None:
    _run(["wscript.exe", str(TRAE_BASE / "launch-all.vbs")], cwd=TRAE_BASE)


def start_wb() -> None:
    _run(["wscript.exe", str(WB_BASE / "launch-gateway.vbs")], cwd=WB_BASE)


def start_hub() -> None:
    _run(["wscript.exe", str(WB_BASE / "launch-gateway.vbs")], cwd=WB_BASE)


def start_keepawake() -> None:
    _run(["wscript.exe", str(WB_BASE / "launch-keepawake.vbs")], cwd=WB_BASE)


def restart_wb() -> str:
    """强杀 gateway 进程再经 VBS 隐藏拉起；watchdog 也会兜底。"""
    killed = 0
    try:
        out = subprocess.run(
            ["taskkill", "/F", "/IM", "workbuddy-gateway.exe"],
            capture_output=True, text=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        killed = out.returncode
    except Exception:
        pass
    time.sleep(1.2)
    start_wb()
    return f"kill_rc={killed}"


def open_url(url: str) -> None:
    os.startfile(url)  # noqa: S606 - Windows-only intentional shell open


def open_dir(path: Path) -> None:
    os.startfile(str(path))  # noqa: S606


def trae_switch(payload: dict) -> dict:
    account_id = (payload or {}).get("account_id") or ""
    return _post(
        f"{TRAE_URL}/api/accounts/switch",
        {"account_id": account_id},
        headers={"Authorization": f"Bearer {TRAE_KEY}"},
    )


def trae_toggle_model(payload: dict) -> dict:
    account_id = (payload or {}).get("account_id") or ""
    enabled = bool((payload or {}).get("enabled"))
    return _post(
        f"{TRAE_URL}/api/accounts/model-enabled",
        {"account_id": account_id, "enabled": enabled},
        headers={"Authorization": f"Bearer {TRAE_KEY}"},
    )


def trae_checkin_all() -> dict:
    return _post(
        f"{TRAE_URL}/api/checkin/claim-all",
        {},
        headers={"Authorization": f"Bearer {TRAE_KEY}"},
        timeout=60,
    )


def wb_apply_config(payload: dict) -> dict:
    """只接受 allowlist / blocklist / accounts 三个键 —— gateway 用
    DisallowUnknownFields 解析，多一个未知键整个文件就加载不了。"""
    payload = payload or {}
    current = wb_config()
    models: dict = {}
    allow = payload.get("allowlist", current["allowlist"])
    block = payload.get("blocklist", current["blocklist"])
    accounts = payload.get("accounts", current["accounts"])
    if allow:
        models["allowlist"] = [str(x) for x in allow if str(x).strip()]
    if block:
        models["blocklist"] = [str(x) for x in block if str(x).strip()]
    if accounts:
        cleaned = {}
        for model, rule in accounts.items():
            files = (rule or {}).get("allowlist") if isinstance(rule, dict) else rule
            files = [str(f) for f in (files or []) if str(f).strip()]
            if files:
                cleaned[str(model)] = {"allowlist": files}
        if cleaned:
            models["accounts"] = cleaned
    _write_json_file(WB_CONFIG, {"models": models})
    return {"ok": True, "written": {"models": models}, "restart_required": True}


ACTIONS = {
    "start-trae": lambda _b: start_trae(),
    "start-wb": lambda _b: start_wb(),
    "start-all": lambda _b: (start_trae(), start_wb()),
    "restart-wb": lambda _b: restart_wb(),
    "open-trae-console": lambda _b: open_url(f"{TRAE_URL}/web/login"),
    "open-hub": lambda _b: open_url(HUB_URL),
    "open-trae-logs": lambda _b: open_dir(TRAE_BASE / "logs"),
    "open-wb-logs": lambda _b: open_dir(WB_LOGS),
    "open-docs": lambda _b: open_dir(TRAE_BASE),
    "open-wb-docs": lambda _b: open_dir(WB_BASE),
    "add-account": lambda _b: _run([str(TRAE_BASE / "添加Trae账号.cmd")], cwd=TRAE_BASE),
    "measure-rates": lambda _b: start_measure(),
    "switch-account": lambda b: trae_switch(b),
    "toggle-model": lambda b: trae_toggle_model(b),
    "checkin-all": lambda b: trae_checkin_all(),
    "wb-config": lambda b: wb_apply_config(b),
    "wb-add-cn": lambda b: wb_login(False, (b or {}).get("file") or ""),
    "wb-add-intl": lambda b: wb_login(True, (b or {}).get("file") or ""),
}


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = f"AIGatewayConsole/{VERSION}"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 静音，避免刷屏
        pass

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _read_body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return {}
        if length <= 0:
            return {}
        try:
            raw = self.rfile.read(length).decode("utf-8", errors="replace")
            data = json.loads(raw)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    # ------------------------------------------------------------ GET
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        query = {}
        if "?" in self.path:
            from urllib.parse import parse_qsl
            query = dict(parse_qsl(self.path.split("?", 1)[1]))

        if path in ("/", "/index.html"):
            try:
                html = DASHBOARD.read_bytes()
            except OSError:
                self._json({"error": "dashboard.html 缺失"}, 500)
                return
            self._send(200, html, "text/html; charset=utf-8")
            return

        if path == "/favicon.ico":
            icon = BASE_DIR / "app.ico"
            if icon.exists():
                self._send(200, icon.read_bytes(), "image/x-icon")
            else:
                self._send(204, b"", "image/x-icon")
            return

        if path == "/api/status":
            trae = trae_snapshot(False)
            wb = wb_snapshot()
            self._json({
                "trae": trae,
                "workbuddy": wb,
                "controllers": controllers_snapshot(),
                "hub": {"running": not hub_health().get("_error"), "url": HUB_URL},
                "trae_today": trae_today() if trae.get("running") else {},
                "now": int(time.time()),
                "version": VERSION,
            })
            return

        if path == "/api/trae":
            self._json(trae_snapshot(True))
            return

        if path == "/api/wb":
            self._json(wb_snapshot())
            return

        if path == "/api/controllers":
            self._json({"controllers": controllers_snapshot()})
            return

        if path == "/api/logs":
            src = query.get("src") or "wb"
            try:
                n = max(20, min(int(query.get("n") or 200), 2000))
            except ValueError:
                n = 200
            self._json(read_log(src, n))
            return

        if path == "/api/model-rates":
            with _rate_lock:
                self._json(dict(_rate_state))
            return

        self._json({"error": "not found", "path": path}, 404)

    # ------------------------------------------------------------ POST
    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/action/"):
            name = path[len("/api/action/"):]
            fn = ACTIONS.get(name)
            if not fn:
                self._json({"ok": False, "error": f"未知操作: {name}"}, 404)
                return
            body = self._read_body()
            try:
                result = fn(body)
                payload = {"ok": True, "action": name}
                if isinstance(result, dict):
                    payload["result"] = result
                self._json(payload)
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": str(exc)}, 500)
            return
        self._json({"error": "not found"}, 404)


class ConsoleServer(ThreadingHTTPServer):
    """单实例面板服务。

    Windows 默认允许重复绑定同一端口（SO_REUSEADDR），导致多次启动/双击
    后会有多个进程同时监听 8330，请求被随机分发到旧代码上。关掉复用后，
    第二个实例会直接绑定失败退出，始终只保留一个服务进程。
    """

    allow_reuse_address = False
    daemon_threads = True

    def __init__(self, *args, **kwargs):
        # 两个入口（server.main 与 app.py 的桌面壳）都经这里构造，
        # 历史倍率数据必须在此加载，否则只有源码直跑才看得到 rates.json。
        _load_rates()
        super().__init__(*args, **kwargs)


def main() -> int:
    try:
        server = ConsoleServer(("127.0.0.1", PORT), Handler)
    except OSError as exc:
        print(f"端口 {PORT} 已被占用（面板可能已在运行）：{exc}", file=sys.stderr)
        return 1
    print(f"AI 网关控制台 v{VERSION} 已启动: http://127.0.0.1:{PORT}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
