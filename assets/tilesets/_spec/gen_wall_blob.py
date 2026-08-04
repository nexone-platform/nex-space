# -*- coding: utf-8 -*-
"""Generate a visual reference atlas for a 47-tile "blob" wall tileset (8-neighbor).
Output: an SVG sheet where every one of the 47 unique wall configurations is drawn
schematically, with a 3x3 neighbour indicator, index, and connection code.
Also emits a JSON mapping index -> (col,row,px) for the atlas table.
"""
from itertools import combinations, chain
import json, os

ORTH = ['N', 'E', 'S', 'W']
# corner name -> the two orthogonal neighbours that flank it
CORNERS = [('NE', ('N', 'E')), ('SE', ('E', 'S')), ('SW', ('S', 'W')), ('NW', ('W', 'N'))]

def subsets(seq):
    seq = list(seq)
    return list(chain.from_iterable(combinations(seq, r) for r in range(len(seq) + 1)))

# --- enumerate the 47 valid configurations ---------------------------------
configs = []  # each: (orth:set, diag:set)
for orth in subsets(ORTH):
    orthset = set(orth)
    eligible = [c for c, (a, b) in CORNERS if a in orthset and b in orthset]
    for diag in subsets(eligible):
        configs.append((orthset, set(diag)))

assert len(configs) == 47, f"expected 47 got {len(configs)}"

# --- layout params ----------------------------------------------------------
COLS = 8
ROWS = (len(configs) + COLS - 1) // COLS  # 6
CELL_W, CELL_H = 150, 168
PAD = 24
HEADER = 96
SHEET_W = COLS * CELL_W + PAD * 2
SHEET_H = HEADER + ROWS * CELL_H + PAD

# colours (clean / office palette)
C_SHEET = "#f4f1ea"
C_CARD = "#ffffff"
C_CARD_STROKE = "#e3ded3"
C_WALL = "#c9d3de"
C_WALL_CAP = "#eaf0f6"
C_WALL_STROKE = "#93a2b3"
C_ACCENT = "#2bb3a3"
C_NB = "#5c6773"
C_NB_EMPTY = "#e7e3da"
C_TXT = "#2a2f36"
C_SUB = "#8a8378"

B = 78          # size of the wall-shape box
INSET = B * 0.17  # inset for an "open" edge

def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

def wall_shape(ox, oy, orth, diag):
    """Return svg for one schematic wall tile inside box at (ox,oy) size B."""
    xL = 0 if 'W' in orth else INSET
    xR = B if 'E' in orth else B - INSET
    yT = 0 if 'N' in orth else INSET
    yB = B if 'S' in orth else B - INSET
    parts = []
    # frame of the tile cell (grid reference)
    parts.append(f'<rect x="{ox}" y="{oy}" width="{B}" height="{B}" fill="none" '
                 f'stroke="#d9d3c7" stroke-width="1" stroke-dasharray="3 3"/>')
    # wall body
    parts.append(f'<rect x="{ox+xL:.1f}" y="{oy+yT:.1f}" width="{xR-xL:.1f}" height="{yB-yT:.1f}" '
                 f'rx="3" fill="{C_WALL}" stroke="{C_WALL_STROKE}" stroke-width="1.5"/>')
    # subtle cap highlight along the top of the body
    parts.append(f'<rect x="{ox+xL:.1f}" y="{oy+yT:.1f}" width="{xR-xL:.1f}" height="{min(10,(yB-yT)/3):.1f}" '
                 f'rx="3" fill="{C_WALL_CAP}" opacity="0.9"/>')
    # inner-corner notches (both flanking orth present, diagonal absent)
    i = INSET
    notch = {
        'NE': (xR - i, yT, i, i),
        'SE': (xR - i, yB - i, i, i),
        'SW': (xL, yB - i, i, i),
        'NW': (xL, yT, i, i),
    }
    for c, (a, b) in CORNERS:
        if a in orth and b in orth and c not in diag:
            nx, ny, nw, nh = notch[c]
            parts.append(f'<rect x="{ox+nx:.1f}" y="{oy+ny:.1f}" width="{nw:.1f}" height="{nh:.1f}" '
                         f'fill="{C_CARD}"/>')
            # redraw the two inner edges of the notch for definition
            parts.append(f'<path d="M {ox+nx:.1f} {oy+ny+ (nh if c in ("NW","NE") else 0):.1f} " fill="none"/>')
    return "\n".join(parts)

def mini_grid(ox, oy, orth, diag, g=9):
    """3x3 neighbour indicator. center = this tile."""
    parts = []
    # map cell (row,col) 0..2 to direction
    dir_at = {
        (0,0):'NW',(0,1):'N',(0,2):'NE',
        (1,0):'W', (1,1):'C',(1,2):'E',
        (2,0):'SW',(2,1):'S',(2,2):'SE',
    }
    for r in range(3):
        for c in range(3):
            d = dir_at[(r,c)]
            x = ox + c*g; y = oy + r*g
            if d == 'C':
                fill = C_ACCENT
            elif d in orth:
                fill = C_NB
            elif d in ('NE','SE','SW','NW') and d in diag:
                fill = C_NB
            else:
                fill = C_NB_EMPTY
            parts.append(f'<rect x="{x}" y="{y}" width="{g-1.5:.1f}" height="{g-1.5:.1f}" rx="1.2" fill="{fill}"/>')
    return "\n".join(parts)

def code_str(orth, diag):
    o = ''.join(d for d in ORTH if d in orth) or '–'
    dd = '+' + ''.join(sorted(diag)) if diag else ''
    return o + dd

# --- build svg --------------------------------------------------------------
svg = []
svg.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{SHEET_W}" height="{SHEET_H}" '
           f'viewBox="0 0 {SHEET_W} {SHEET_H}" font-family="Segoe UI, Arial, sans-serif">')
svg.append(f'<rect width="{SHEET_W}" height="{SHEET_H}" fill="{C_SHEET}"/>')
# header
svg.append(f'<text x="{PAD}" y="42" font-size="26" font-weight="700" fill="{C_TXT}">'
           f'NexSpace — Wall Tileset · 47-tile Blob (8-neighbour)</text>')
svg.append(f'<text x="{PAD}" y="68" font-size="14" fill="{C_SUB}">'
           f'Logical tile 32×32px · draw @2x (64×64) · atlas = {COLS} columns · order = index below (grouped by neighbour count)</text>')
# legend
lx = PAD; ly = 80
svg.append(f'<rect x="{lx}" y="{ly}" width="12" height="12" rx="2" fill="{C_ACCENT}"/>'
           f'<text x="{lx+18}" y="{ly+11}" font-size="12" fill="{C_SUB}">this tile</text>')
svg.append(f'<rect x="{lx+110}" y="{ly}" width="12" height="12" rx="2" fill="{C_NB}"/>'
           f'<text x="{lx+128}" y="{ly+11}" font-size="12" fill="{C_SUB}">connected neighbour (wall)</text>')
svg.append(f'<rect x="{lx+330}" y="{ly}" width="12" height="12" rx="2" fill="{C_NB_EMPTY}"/>'
           f'<text x="{lx+348}" y="{ly+11}" font-size="12" fill="{C_SUB}">empty (open / floor)</text>')

atlas_map = []
for idx, (orth, diag) in enumerate(configs):
    col = idx % COLS
    row = idx // COLS
    cx = PAD + col * CELL_W
    cy = HEADER + row * CELL_H
    # card
    svg.append(f'<rect x="{cx}" y="{cy}" width="{CELL_W-12}" height="{CELL_H-12}" rx="10" '
               f'fill="{C_CARD}" stroke="{C_CARD_STROKE}" stroke-width="1"/>')
    # index badge
    svg.append(f'<text x="{cx+14}" y="{cy+24}" font-size="15" font-weight="700" fill="{C_TXT}">#{idx}</text>')
    # mini grid top-right
    svg.append(mini_grid(cx + CELL_W - 12 - 3*9 - 12, cy + 10, orth, diag))
    # wall shape centered
    sx = cx + (CELL_W - 12 - B) / 2
    sy = cy + 34
    svg.append(wall_shape(sx, sy, orth, diag))
    # code label
    svg.append(f'<text x="{cx + (CELL_W-12)/2}" y="{cy+CELL_H-20}" font-size="13" '
               f'font-weight="600" text-anchor="middle" fill="{C_ACCENT}">{esc(code_str(orth,diag))}</text>')
    atlas_map.append({
        "index": idx, "col": col, "row": row,
        "px_1x": [col*32, row*32], "px_2x": [col*64, row*64],
        "orth": ''.join(d for d in ORTH if d in orth),
        "diag": ''.join(sorted(diag)),
        "code": code_str(orth, diag),
    })

svg.append('</svg>')

out_dir = os.path.join(os.path.dirname(__file__))
# actual output goes to project assets folder passed via env / argv
import sys
proj_spec = sys.argv[1] if len(sys.argv) > 1 else out_dir
os.makedirs(proj_spec, exist_ok=True)
svg_path = os.path.join(proj_spec, "wall-blob-47.svg")
with open(svg_path, "w", encoding="utf-8") as f:
    f.write("\n".join(svg))
json_path = os.path.join(proj_spec, "wall-blob-47.atlas.json")
with open(json_path, "w", encoding="utf-8") as f:
    json.dump({"cols": COLS, "rows": ROWS, "tile_px": 32, "tile_px_2x": 64,
               "count": len(configs), "tiles": atlas_map}, f, indent=2)
print("wrote", svg_path)
print("wrote", json_path)
print("tiles:", len(configs))
