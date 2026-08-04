# -*- coding: utf-8 -*-
"""Generate REAL placeholder pixel-art WALL tiles: the full 47-tile blob (8-neighbour),
laid out in an 8-column atlas that matches docs/02a. Also renders a sample room
composed from the tiles to prove they auto-connect.
Outputs:
  walls-white-pixel.png          -> 47-tile atlas, 32px tiles, 8 columns (import to Tiled)
  walls-white-pixel-preview.png  -> a sample room auto-tiled from these, upscaled
"""
import os, sys
from itertools import combinations, chain
from PIL import Image, ImageDraw

S = 32
INSET = 7  # px inset on an open edge
ORTH = ['N', 'E', 'S', 'W']
CORNERS = [('NE', ('N', 'E')), ('SE', ('E', 'S')), ('SW', ('S', 'W')), ('NW', ('W', 'N'))]

WALL   = (214,221,230,255)
CAP    = (240,244,249,255)   # lit top surface
FACE   = (166,178,194,255)   # front face shadow (south)
SIDE_L = (228,233,240,255)
SIDE_R = (188,197,210,255)
OUTL   = (74,84,101,255)
TRANS  = (0,0,0,0)

def subsets(seq):
    seq=list(seq); return list(chain.from_iterable(combinations(seq,r) for r in range(len(seq)+1)))

configs=[]
for orth in subsets(ORTH):
    oset=set(orth)
    elig=[c for c,(a,b) in CORNERS if a in oset and b in oset]
    for diag in subsets(elig):
        configs.append((oset,set(diag)))
assert len(configs)==47
# lookup: (frozenset orth, frozenset diag) -> index
LUT={(frozenset(o),frozenset(d)):i for i,(o,d) in enumerate(configs)}

def render_tile(orth, diag):
    img=Image.new("RGBA",(S,S),TRANS); d=ImageDraw.Draw(img)
    xL=0 if 'W' in orth else INSET
    xR=S if 'E' in orth else S-INSET
    yT=0 if 'N' in orth else INSET
    yB=S if 'S' in orth else S-INSET
    # body
    d.rectangle([xL,yT,xR-1,yB-1],fill=WALL)
    # lit cap only if top is exposed (top of a wall run)
    if 'N' not in orth:
        d.rectangle([xL,yT,xR-1,yT+3],fill=CAP)
    # front face only if bottom exposed
    if 'S' not in orth:
        d.rectangle([xL,yB-4,xR-1,yB-1],fill=FACE)
    # subtle side shading on exposed sides
    if 'W' not in orth: d.rectangle([xL,yT,xL+1,yB-1],fill=SIDE_L)
    if 'E' not in orth: d.rectangle([xR-2,yT,xR-1,yB-1],fill=SIDE_R)
    # inner-corner notches (both flanking present, diagonal absent) -> open floor
    i=INSET
    notch={'NE':(xR-i,yT,xR,yT+i),'SE':(xR-i,yB-i,xR,yB),
           'SW':(xL,yB-i,xL+i,yB),'NW':(xL,yT,xL+i,yT+i)}
    for c,(a,b) in CORNERS:
        if a in orth and b in orth and c not in diag:
            nx0,ny0,nx1,ny1=notch[c]
            d.rectangle([nx0,ny0,nx1-1,ny1-1],fill=TRANS)
    # outline on EXPOSED edges (open sides) + notch inner edges
    if 'N' not in orth: d.rectangle([xL,yT,xR-1,yT],fill=OUTL)
    if 'S' not in orth: d.rectangle([xL,yB-1,xR-1,yB-1],fill=OUTL)
    if 'W' not in orth: d.rectangle([xL,yT,xL,yB-1],fill=OUTL)
    if 'E' not in orth: d.rectangle([xR-1,yT,xR-1,yB-1],fill=OUTL)
    # notch outlines
    for c,(a,b) in CORNERS:
        if a in orth and b in orth and c not in diag:
            nx0,ny0,nx1,ny1=notch[c]
            if c=='NE': d.line([nx0,ny0,nx0,ny1-1],fill=OUTL); d.line([nx0,ny1-1,nx1-1,ny1-1],fill=OUTL)
            if c=='SE': d.line([nx0,ny0,nx0,ny1-1],fill=OUTL); d.line([nx0,ny0,nx1-1,ny0],fill=OUTL)
            if c=='SW': d.line([nx1-1,ny0,nx1-1,ny1-1],fill=OUTL); d.line([nx0,ny0,nx1-1,ny0],fill=OUTL)
            if c=='NW': d.line([nx1-1,ny0,nx1-1,ny1-1],fill=OUTL); d.line([nx0,ny1-1,nx1-1,ny1-1],fill=OUTL)
    return img

# ---- atlas (8 columns, matching docs/02a index order) ----
COLS=8; ROWS=(len(configs)+COLS-1)//COLS
atlas=Image.new("RGBA",(COLS*S,ROWS*S),TRANS)
for i,(o,dg) in enumerate(configs):
    atlas.paste(render_tile(o,dg),((i%COLS)*S,(i//COLS)*S))

# ---- sample room to prove auto-connect ----
def wall_index_for(cells,x,y):
    def w(cx,cy): return (cx,cy) in cells
    orth=set()
    if w(x,y-1):orth.add('N')
    if w(x+1,y):orth.add('E')
    if w(x,y+1):orth.add('S')
    if w(x-1,y):orth.add('W')
    diag=set()
    for c,(a,b) in CORNERS:
        if a in orth and b in orth:
            dx={'NE':(1,-1),'SE':(1,1),'SW':(-1,1),'NW':(-1,-1)}[c]
            if w(x+dx[0],y+dx[1]): diag.add(c)
    return LUT[(frozenset(orth),frozenset(diag))]

GW,GH=13,9
cells=set()
for x in range(GW):        # outer border
    cells.add((x,0)); cells.add((x,GH-1))
for y in range(GH):
    cells.add((0,y)); cells.add((GW-1,y))
for y in range(0,5):       # interior partition (vertical)
    cells.add((7,y))
for x in range(7,GW):      # interior partition (horizontal) -> makes T + corner
    cells.add((x,4))
# doorway gaps
for gap in [(3,0),(7,2)]:
    cells.discard(gap)

FLOOR=(235,228,208,255)
room=Image.new("RGBA",(GW*S,GH*S),FLOOR)
for (x,y) in cells:
    room.paste(render_tile(*configs[wall_index_for(cells,x,y)]),(x*S,y*S))
SCALE=5
room=room.resize((GW*S*SCALE,GH*S*SCALE),Image.NEAREST)

out=sys.argv[1] if len(sys.argv)>1 else "."
os.makedirs(out,exist_ok=True)
atlas.save(os.path.join(out,"walls-white-pixel.png"))
room.save(os.path.join(out,"walls-white-pixel-preview.png"))
print("wall tiles:",len(configs))
