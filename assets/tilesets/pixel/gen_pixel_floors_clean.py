# -*- coding: utf-8 -*-
"""Clean, fully-seamless 32x32 floor tiles (no transparent border, no hard grid).
Fixes the AI tiles' 1px transparent edge that caused dark gaps when tiled.
Outputs floor-cream / floor-wood / floor-gray to the given dir(s).
Usage: python gen_pixel_floors_clean.py <out_dir> [<out_dir2> ...]
"""
import os, sys
from PIL import Image

T = 32

def h(x, y):  # tiny deterministic pseudo-noise 0..1 (wraps softly, low contrast)
    v = (x * 73856093) ^ (y * 19349663)
    return ((v >> 3) & 255) / 255.0

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,)

def make_cream():
    """near-flat cream, NO lines — just a whisper of mottle so it isn't dead-flat."""
    base = (243, 231, 202); lo = (238, 226, 197); hi = (247, 236, 210)
    im = Image.new("RGBA", (T, T), base + (255,)); px = im.load()
    for y in range(T):
        for x in range(T):
            n = h(x, y)
            if n < 0.06: px[x, y] = lo + (255,)
            elif n > 0.94: px[x, y] = hi + (255,)
    return im

def make_gray():
    """flat gray carpet, subtle noise, no lines."""
    base = (156, 161, 158); lo = (148, 153, 150); hi = (166, 171, 168)
    im = Image.new("RGBA", (T, T), base + (255,)); px = im.load()
    for y in range(T):
        for x in range(T):
            n = h(x * 2 + 1, y * 2 + 1)
            if n < 0.22: px[x, y] = lo + (255,)
            elif n > 0.80: px[x, y] = hi + (255,)
    return im

def make_wood():
    """horizontal planks, seamless in both axes, soft plank separators (not black gaps)."""
    base = (198, 150, 96); sep = (176, 128, 78); streak = (214, 172, 120); endm = (166, 118, 70)
    im = Image.new("RGBA", (T, T), base + (255,)); px = im.load()
    plank_h = 8
    for y in range(T):
        for x in range(T):
            # subtle grain
            n = h(x, y // plank_h * 7 + x)
            if n > 0.85: px[x, y] = streak + (255,)
            elif n < 0.10: px[x, y] = lerp(base, sep, 0.4)
    # plank separators at the BOTTOM of each plank (wraps: y=31 meets next tile's y=0)
    for row in range(1, T // plank_h + 1):
        yy = row * plank_h - 1
        for x in range(T):
            px[x, yy] = sep + (255,)
    # staggered plank END marks (interior only, never on x=0/31 -> stays seamless L/R)
    for row in range(T // plank_h):
        ex = 8 + (row % 2) * 13  # stagger
        yy0 = row * plank_h
        for dy in range(plank_h - 1):
            if 0 < ex < T - 1:
                px[ex, yy0 + dy] = endm + (255,)
    return im

TILES = {"floor-cream": make_cream, "floor-wood": make_wood, "floor-gray": make_gray}

outs = sys.argv[1:] or ["."]
for d in outs:
    os.makedirs(d, exist_ok=True)
    for name, fn in TILES.items():
        fn().save(os.path.join(d, name + ".png"))
print("wrote", list(TILES), "to", outs)
