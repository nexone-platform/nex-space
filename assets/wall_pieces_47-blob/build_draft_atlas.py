# -*- coding: utf-8 -*-
"""DRAFT: best-effort 47-blob atlas = procedural teal base with a few AI wall pieces
overlaid where they fit (straight H/V, cross). Renders a test room to expose seams.
"""
import os
from itertools import combinations, chain
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
S = 32

# --- rebuild the 47 configs + LUT (same order as gen_pixel_walls_teal.py) ---
ORTH = ["N", "E", "S", "W"]
CORNERS = [("NE", ("N", "E")), ("SE", ("E", "S")), ("SW", ("S", "W")), ("NW", ("W", "N"))]
def subsets(seq):
    seq = list(seq); return list(chain.from_iterable(combinations(seq, r) for r in range(len(seq)+1)))
configs = []
for orth in subsets(ORTH):
    o = set(orth); elig = [c for c, (a, b) in CORNERS if a in o and b in o]
    for diag in subsets(elig): configs.append((o, set(diag)))
def key(o, d): return "".join(x for x in ORTH if x in o) + "|" + "".join(c for c, _ in CORNERS if c in d)
LUT = {key(o, d): i for i, (o, d) in enumerate(configs)}

# --- base: procedural teal atlas sliced into 47 tiles ---
teal = Image.open(os.path.join(ROOT, "tilesets/pixel/walls-teal.png")).convert("RGBA")
COLS = 8
tiles = []
for i in range(47):
    x, y = (i % COLS) * S, (i // COLS) * S
    tiles.append(teal.crop((x, y, x + S, y + S)).copy())

# --- AI overrides (from _cleaned, magenta already removed) ---
def ai(n): return Image.open(os.path.join(HERE, "_cleaned", f"{n}.png")).convert("RGBA")
ew = ai(15)                              # horizontal straight
ns = ew.transpose(Image.ROTATE_90)       # derive vertical from same piece (consistent)
cross = ai(10)                           # 4-way junction (open corners)

overrides = {
    "EW|": ew,
    "NS|": ns,
    "NESW|": cross,
}
for k, img in overrides.items():
    if k in LUT:
        tiles[LUT[k]] = img.resize((S, S), Image.NEAREST)

# --- rebuild atlas ---
ROWS = (47 + COLS - 1) // COLS
atlas = Image.new("RGBA", (COLS * S, ROWS * S), (0, 0, 0, 0))
for i, t in enumerate(tiles):
    atlas.paste(t, ((i % COLS) * S, (i // COLS) * S))
atlas.save(os.path.join(ROOT, "tilesets/pixel/walls-ai-draft.png"))

# --- test room render (same layout as the teal preview) ---
def widx(cells, x, y):
    def w(a, b): return (a, b) in cells
    o = set()
    if w(x, y-1): o.add("N")
    if w(x+1, y): o.add("E")
    if w(x, y+1): o.add("S")
    if w(x-1, y): o.add("W")
    d = set()
    off = {"NE": (1, -1), "SE": (1, 1), "SW": (-1, 1), "NW": (-1, -1)}
    for c, (a, b) in CORNERS:
        if a in o and b in o and w(x+off[c][0], y+off[c][1]): d.add(c)
    return LUT[key(o, d)]

GW, GH = 13, 9
cells = set()
for x in range(GW): cells |= {(x, 0), (x, GH-1)}
for y in range(GH): cells |= {(0, y), (GW-1, y)}
for y in range(0, 5): cells.add((7, y))
for x in range(7, GW): cells.add((x, 4))
cells -= {(3, 0), (7, 2)}
room = Image.new("RGBA", (GW*S, GH*S), (236, 229, 208, 255))
for (x, y) in cells:
    room.paste(tiles[widx(cells, x, y)], (x*S, y*S), tiles[widx(cells, x, y)])
room.resize((GW*S*4, GH*S*4), Image.NEAREST).save(os.path.join(HERE, "_draft-room.png"))
print("wrote walls-ai-draft.png + _draft-room.png ; overrode:", list(overrides))
