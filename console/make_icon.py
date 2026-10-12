"""生成控制台图标：品牌渐变底 + 2x2 圆角网格（与面板左上角标记同构）。

输出 app.ico（多尺寸）与 app.png（预览用），供 PyInstaller 与窗口图标使用。
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT_DIR = Path(__file__).resolve().parent
S = 1024
RADIUS = int(S * 0.225)          # 外圆角
PAD = int(S * 0.255)             # 内部网格留白
GAP = int(S * 0.058)             # 网格间距
CELL = (S - PAD * 2 - GAP) // 2  # 单元边长
CELL_R = int(S * 0.042)          # 单元圆角

C_FROM = (52, 211, 153)   # #34d399
C_TO = (34, 211, 238)     # #22d3ee


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def build() -> Image.Image:
    # 对角渐变底（用斜线填充，避免逐像素循环）
    grad = Image.new("RGB", (S, S), C_FROM)
    gd = ImageDraw.Draw(grad)
    for i in range(S * 2):
        t = i / (S * 2 - 1)
        gd.line([(i, 0), (0, i)], fill=lerp(C_FROM, C_TO, t), width=2)

    # 圆角遮罩
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=RADIUS, fill=255)

    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(grad, (0, 0), mask)

    # 2x2 白色网格
    draw = ImageDraw.Draw(icon)
    for row in range(2):
        for col in range(2):
            x0 = PAD + col * (CELL + GAP)
            y0 = PAD + row * (CELL + GAP)
            draw.rounded_rectangle(
                [x0, y0, x0 + CELL, y0 + CELL],
                radius=CELL_R,
                fill=(255, 255, 255, 236),
            )
    return icon


def main() -> None:
    icon = build()
    png = OUT_DIR / "app.png"
    ico = OUT_DIR / "app.ico"
    icon.resize((256, 256), Image.LANCZOS).save(png)
    icon.save(
        ico,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("WROTE", png)
    print("WROTE", ico)


if __name__ == "__main__":
    main()
