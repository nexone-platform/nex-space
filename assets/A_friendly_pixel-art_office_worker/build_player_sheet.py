# -*- coding: utf-8 -*-
"""Turn PixelLab 88x88 directional rotations into a game-ready player spritesheet.
Crops each direction to content (NO downscaling -> stays crisp), aligns all by the
FEET baseline (bottom-center), stacks 4 cardinal dirs as rows: down/up/left/right.
Usage: python build_player_sheet.py <char_dir> <out_png>
"""
import os, sys
from PIL import Image

char = sys.argv[1] if len(sys.argv) > 1 else "rotations-1"
out = sys.argv[2] if len(sys.argv) > 2 else "player-avatar.png"
HERE = os.path.dirname(os.path.abspath(__file__))

# game facing -> PixelLab direction file
MAP = [("down", "south"), ("up", "north"), ("left", "west"), ("right", "east")]

crops = []
for _, fname in MAP:
    im = Image.open(os.path.join(HERE, char, f"{fname}.png")).convert("RGBA")
    bbox = im.getbbox()
    crops.append(im.crop(bbox))

PAD = 3
FW = max(c.width for c in crops) + PAD * 2
FH = max(c.height for c in crops) + PAD * 2

sheet = Image.new("RGBA", (FW, FH * len(crops)), (0, 0, 0, 0))
for row, c in enumerate(crops):
    x = (FW - c.width) // 2          # center horizontally
    y = row * FH + (FH - PAD - c.height)  # bottom-align (feet on common baseline)
    sheet.paste(c, (x, y), c)

# outputs
sheet.save(os.path.join(HERE, out))
web = os.path.abspath(os.path.join(HERE, "..", "..", "apps", "web", "public", "assets", out))
sheet.save(web)
print(f"frame = {FW} x {FH}  (rows: down,up,left,right)")
print("saved:", out, "and", web)
