"""AI 网关控制台 —— 桌面版。

把原来的「VBS 启动服务 + 手动开浏览器」换成原生窗口：
内嵌 HTTP 服务跑在后台线程，pywebview 用 WebView2 渲染 dashboard.html。

单实例行为：端口 8330 已被监听时不再启动第二个服务，直接开窗口连过去，
所以重复双击不会出错。
"""

from __future__ import annotations

import socket
import threading
import time
import webbrowser
from pathlib import Path

from server import DATA_DIR, PORT, ConsoleServer, Handler

APP_TITLE = "AI 网关控制台"
WINDOW_W, WINDOW_H = 1200, 860
URL = f"http://127.0.0.1:{PORT}/"


def _resource_dir() -> Path:
    import sys

    bundled = getattr(sys, "_MEIPASS", None)
    return Path(bundled) if bundled else Path(__file__).resolve().parent


def _port_live() -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.35)
        return sock.connect_ex(("127.0.0.1", PORT)) == 0


def _serve() -> None:
    try:
        server = ConsoleServer(("127.0.0.1", PORT), Handler)
    except OSError:
        return  # 已有实例在监听，交给它
    server.serve_forever()


def _wait_ready(timeout: float = 8.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _port_live():
            return True
        time.sleep(0.12)
    return False


def main() -> int:
    if not _port_live():
        threading.Thread(target=_serve, daemon=True).start()
        _wait_ready()

    icon_path = _resource_dir() / "app.ico"
    icon = str(icon_path) if icon_path.exists() else None

    try:
        import webview

        webview.create_window(
            APP_TITLE,
            URL,
            width=WINDOW_W,
            height=WINDOW_H,
            min_size=(960, 680),
            background_color="#08090b",
            text_select=True,
        )
        webview.start(
            private_mode=False,             # 保留 localStorage（主题偏好）
            storage_path=str(DATA_DIR / "webview-profile"),
            icon=icon,
        )
    except Exception as exc:  # noqa: BLE001 - 退化为浏览器，不让用户卡住
        print(f"原生窗口不可用（{exc}），改用浏览器打开 {URL}")
        webbrowser.open(URL)
        # 让后台服务继续跑，用户关掉浏览器后手动结束进程
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
