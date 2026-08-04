# -*- coding: utf-8 -*-
"""47-tile blob walls in a WHITE + TEAL-trim style (matches the AI wall look).
Same 47 enumeration/order as gen_pixel_walls.py so the runtime autotile LUT matches.
Usage: python gen_pixel_walls_teal.py <out_dir>
"""
import os, sys
from itertools import combinations, chain
from PIL import Image, ImageDraw

S=32; INSET=7
ORTH=['N','E','S','W']
CORNERS=[('NE',('N','E')),('SE',('E','S')),('SW',('S','W')),('NW',('W','N'))]

WALL=(245,242,235,255); CAP=(255,255,255,255)
TEAL=(43,157,144,255); TEALD=(31,120,110,255)
SIDE=(228,232,229,255); OUTL=(54,64,66,255); TRANS=(0,0,0,0)

def subsets(seq):
    seq=list(seq); return list(chain.from_iterable(combinations(seq,r) for r in range(len(seq)+1)))

configs=[]
for orth in subsets(ORTH):
    o=set(orth); elig=[c for c,(a,b) in CORNERS if a in o and b in o]
    for diag in subsets(elig): configs.append((o,set(diag)))
assert len(configs)==47
LUT={(frozenset(o),frozenset(d)):i for i,(o,d) in enumerate(configs)}

def tile(orth,diag):
    im=Image.new("RGBA",(S,S),TRANS); d=ImageDraw.Draw(im)
    xL=0 if 'W' in orth else INSET
    xR=S if 'E' in orth else S-INSET
    yT=0 if 'N' in orth else INSET
    yB=S if 'S' in orth else S-INSET
    d.rectangle([xL,yT,xR-1,yB-1],fill=WALL)
    # white cap highlight along top-left interior
    d.rectangle([xL,yT,xR-1,yT+2],fill=CAP)
    # teal trim band along each EXPOSED (open) edge = faces the room
    if 'N' not in orth: d.rectangle([xL,yT+2,xR-1,yT+4],fill=TEAL)
    if 'S' not in orth: d.rectangle([xL,yB-4,xR-1,yB-2],fill=TEAL); d.rectangle([xL,yB-2,xR-1,yB-1],fill=TEALD)
    if 'W' not in orth: d.rectangle([xL+2,yT,xL+3,yB-1],fill=TEAL)
    if 'E' not in orth: d.rectangle([xR-4,yT,xR-3,yB-1],fill=TEAL)
    # notches (inner corner open)
    i=INSET
    notch={'NE':(xR-i,yT,xR,yT+i),'SE':(xR-i,yB-i,xR,yB),'SW':(xL,yB-i,xL+i,yB),'NW':(xL,yT,xL+i,yT+i)}
    for c,(a,b) in CORNERS:
        if a in orth and b in orth and c not in diag:
            x0,y0,x1,y1=notch[c]; d.rectangle([x0,y0,x1-1,y1-1],fill=TRANS)
    # outline exposed edges
    if 'N' not in orth: d.rectangle([xL,yT,xR-1,yT],fill=OUTL)
    if 'S' not in orth: d.rectangle([xL,yB-1,xR-1,yB-1],fill=OUTL)
    if 'W' not in orth: d.rectangle([xL,yT,xL,yB-1],fill=OUTL)
    if 'E' not in orth: d.rectangle([xR-1,yT,xR-1,yB-1],fill=OUTL)
    return im

COLS=8; ROWS=(47+COLS-1)//COLS
atlas=Image.new("RGBA",(COLS*S,ROWS*S),TRANS)
for i,(o,dg) in enumerate(configs):
    atlas.paste(tile(o,dg),((i%COLS)*S,(i//COLS)*S))

# preview room
def widx(cells,x,y):
    def w(a,b): return (a,b) in cells
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
GW,GH=13,9; cells=set()
for x in range(GW): cells|={(x,0),(x,GH-1)}
for y in range(GH): cells|={(0,y),(GW-1,y)}
for y in range(0,5): cells.add((7,y))
for x in range(7,GW): cells.add((x,4))
cells-={(3,0),(7,2)}
room=Image.new("RGBA",(GW*S,GH*S),(236,229,208,255))
for (x,y) in cells: room.paste(tile(*configs[widx(cells,x,y)]),(x*S,y*S))
room=room.resize((GW*S*4,GH*S*4),Image.NEAREST)

out=sys.argv[1] if len(sys.argv)>1 else "."
os.makedirs(out,exist_ok=True)
atlas.save(os.path.join(out,"walls-teal.png"))
room.save(os.path.join(out,"walls-teal-preview.png"))
print("wrote walls-teal.png (47 tiles) +preview")
