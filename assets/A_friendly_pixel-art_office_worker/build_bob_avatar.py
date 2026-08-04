# -*- coding: utf-8 -*-
"""Synthesize a walk cycle from an avatar that only has 8 static direction PNGs
(no walk GIF). Each direction gets 6 frames with a subtle vertical BOB (+ a tiny
squash on the plant frames) so it reads as "walking/bouncing" instead of sliding.
Not real leg animation (needs source frames) but gives motion feedback.
Usage: python build_bob_avatar.py <rotations-dir> <out.png>
"""
import os, sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
src = sys.argv[1]
out = sys.argv[2]
DIRS = ["south", "north", "west", "east", "south-east", "south-west", "north-east", "north-west"]
BOB = [0, -1, -2, -1, 0, -1]  # per-frame vertical offset (up), ~1.5 bounces / cycle
SQUASH = [1.0, 1.0, 1.0, 1.0, 0.97, 1.0]  # slight vertical squash on a plant frame
COLS = len(BOB)
PAD_X, TOP_EXTRA, BOTTOM = 2, 4, 2  # TOP_EXTRA leaves room for the bob

crops = [Image.open(os.path.join(HERE, src, f"{d}.png")).convert("RGBA") for d in DIRS]
crops = [c.crop(c.getbbox()) for c in crops]
FW = max(c.width for c in crops) + PAD_X * 2
FH = max(c.height for c in crops) + TOP_EXTRA + BOTTOM

sheet = Image.new("RGBA", (FW * COLS, FH * len(DIRS)), (0, 0, 0, 0))
for row, c in enumerate(crops):
    for f in range(COLS):
        cc = c
        if SQUASH[f] != 1.0:
            h2 = max(1, round(c.height * SQUASH[f]))
            cc = c.resize((c.width, h2), Image.NEAREST)
        x = (FW - cc.width) // 2
        y = row * FH + (FH - BOTTOM - cc.height) + BOB[f]  # feet baseline + bob
        sheet.paste(cc, (f * FW + x, y), cc)

sheet.save(os.path.join(HERE, out))
sheet.save(os.path.abspath(os.path.join(HERE, "..", "..", "apps", "web", "public", "assets", out)))
print(f"{out}: frame {FW}x{FH}")
