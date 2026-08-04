# -*- coding: utf-8 -*-
"""Build a static 8-direction walk sheet from a rotations-N folder that has only
the 8 static direction PNGs (no walk GIFs). Each direction's single frame is
repeated across 6 columns so it plays the same 6-frame walk anim (stands still).
Usage: python build_static_avatar.py <rotations-dir> <out.png>
"""
import os, sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
src = sys.argv[1]
out = sys.argv[2]
DIRS = ["south", "north", "west", "east", "south-east", "south-west", "north-east", "north-west"]
COLS = 6

crops = []
for d in DIRS:
    im = Image.open(os.path.join(HERE, src, f"{d}.png")).convert("RGBA")
    crops.append(im.crop(im.getbbox()))
FW = max(c.width for c in crops) + 4
FH = max(c.height for c in crops) + 4

sheet = Image.new("RGBA", (FW * COLS, FH * len(DIRS)), (0, 0, 0, 0))
for row, c in enumerate(crops):
    x = (FW - c.width) // 2
    y = row * FH + (FH - 2 - c.height)
    for col in range(COLS):
        sheet.paste(c, (col * FW, y), c)

sheet.save(os.path.join(HERE, out))
sheet.save(os.path.abspath(os.path.join(HERE, "..", "..", "apps", "web", "public", "assets", out)))
print(f"{out}: frame {FW}x{FH}")
