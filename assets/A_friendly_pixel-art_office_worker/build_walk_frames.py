# -*- coding: utf-8 -*-
"""Build a walk sheet from real frame PNGs in animations/Walking/<dir>/frame_*.png
(N frames x 8 directions). Shared union bbox -> consistent anchor. Rows follow the
game's facing order. Usage: python build_walk_frames.py <rotations-dir> <out.png>
"""
import os, sys, glob
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
src, out = sys.argv[1], sys.argv[2]
DIRS = ["south", "north", "west", "east", "south-east", "south-west", "north-east", "north-west"]
base = os.path.join(HERE, src, "animations", "Walking")

frames = {}
for d in DIRS:
    fs = sorted(glob.glob(os.path.join(base, d, "frame_*.png")))
    frames[d] = [Image.open(f).convert("RGBA") for f in fs]
NF = min(len(v) for v in frames.values())

union = None
for d in DIRS:
    for im in frames[d][:NF]:
        b = im.getbbox()
        if b:
            union = b if union is None else (min(union[0], b[0]), min(union[1], b[1]), max(union[2], b[2]), max(union[3], b[3]))
PAD = 2
x0, y0, x1, y1 = union
x0, y0 = max(0, x0 - PAD), max(0, y0 - PAD)
x1, y1 = x1 + PAD, y1 + PAD
FW, FH = x1 - x0, y1 - y0

sheet = Image.new("RGBA", (FW * NF, FH * len(DIRS)), (0, 0, 0, 0))
for row, d in enumerate(DIRS):
    for f in range(NF):
        crop = frames[d][f].crop((x0, y0, x1, y1))
        sheet.paste(crop, (f * FW, row * FH), crop)

sheet.save(os.path.join(HERE, out))
sheet.save(os.path.abspath(os.path.join(HERE, "..", "..", "apps", "web", "public", "assets", out)))
print(f"{out}: frame {FW}x{FH}  nf={NF}")
