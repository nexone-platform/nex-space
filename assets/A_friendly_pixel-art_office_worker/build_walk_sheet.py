# -*- coding: utf-8 -*-
"""Build a walk spritesheet from PixelLab walk GIFs (4 cardinal directions x 6 frames).
Crops every frame with ONE shared union bbox so the character stays anchored
(feet fixed) across the whole cycle -> clean walk-in-place. No downscaling (crisp).
Rows: down(south), up(north), left(west), right(east).  Cols: 6 walk frames.
"""
import os, sys
from PIL import Image, ImageSequence

HERE = os.path.dirname(os.path.abspath(__file__))
char = sys.argv[1] if len(sys.argv) > 1 else "rotations-1"
base = os.path.join(HERE, char)
PREFIX = "A_friendly_pixel-art_office_worker_walk_"
MAP = [
    ("down", "south"), ("up", "north"), ("left", "west"), ("right", "east"),
    ("down-right", "south-east"), ("down-left", "south-west"),
    ("up-right", "north-east"), ("up-left", "north-west"),
]

# load all frames per direction
frames = {}
for facing, dname in MAP:
    im = Image.open(os.path.join(base, f"{PREFIX}{dname}.gif"))
    frames[facing] = [f.convert("RGBA").copy() for f in ImageSequence.Iterator(im)]

NF = min(len(v) for v in frames.values())  # frames per direction (6)

# shared union bbox across EVERY frame -> consistent anchor
union = None
for facing, _ in MAP:
    for f in frames[facing][:NF]:
        b = f.getbbox()
        if b is None:
            continue
        union = b if union is None else (
            min(union[0], b[0]), min(union[1], b[1]),
            max(union[2], b[2]), max(union[3], b[3]))
PAD = 2
x0, y0, x1, y1 = union
x0, y0 = max(0, x0 - PAD), max(0, y0 - PAD)
x1, y1 = x1 + PAD, y1 + PAD
FW, FH = x1 - x0, y1 - y0

sheet = Image.new("RGBA", (FW * NF, FH * len(MAP)), (0, 0, 0, 0))
for row, (facing, _) in enumerate(MAP):
    for col in range(NF):
        crop = frames[facing][col].crop((x0, y0, x1, y1))
        sheet.paste(crop, (col * FW, row * FH), crop)

out = sys.argv[2] if len(sys.argv) > 2 else "player-walk.png"
sheet.save(os.path.join(HERE, out))
web = os.path.abspath(os.path.join(HERE, "..", "..", "apps", "web", "public", "assets", out))
sheet.save(web)
print(f"frame = {FW} x {FH}  |  {NF} frames/dir  |  rows: down,up,left,right")
print("sheet:", sheet.size)
