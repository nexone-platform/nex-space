# -*- coding: utf-8 -*-
"""Auto-slice a Gemini anchor sheet into individual game-ready sprites.
Pipeline (STEP 3-5 of docs/07):
  1. key out the magenta background (tolerant — handles JPEG artifacts)
  2. find connected sprite blobs, compute bounding boxes
  3. export tight TRANSPARENT full-res cutouts  -> _wip/cutouts/
  4. downscale each to a 32px grid (nearest)    -> _wip/downscaled/
  5. build a labeled contact sheet for review    -> _wip/_contact-sheet.png
Human still finishes in Aseprite: pixel-edge cleanup, tileable floors, assemble 47-blob.
Usage: python slice_anchor.py <source_image> [out_dir]
"""
import os, sys, collections
import numpy as np
from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else "anchor-02.png.jpg"
OUT = sys.argv[2] if len(sys.argv) > 2 else "_wip"
here = os.path.dirname(os.path.abspath(__file__))
SRC = SRC if os.path.isabs(SRC) else os.path.join(here, SRC)
OUT = OUT if os.path.isabs(OUT) else os.path.join(here, OUT)

# ---- load ----
img = Image.open(SRC).convert("RGB")
arr = np.asarray(img).astype(np.int16)
H, W, _ = arr.shape
R, G, B = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]

# ---- magenta key (tolerant): high R, high B, low G ----
bg = (R > 175) & (B > 175) & (G < 130) & ((R - G) > 55) & ((B - G) > 55)
fg = ~bg

# RGBA with transparent background
rgba = np.dstack([arr.astype(np.uint8), np.where(fg, 255, 0).astype(np.uint8)])
keyed = Image.fromarray(rgba, "RGBA")

# ---- connected components on a 4x-downscaled mask (fast) ----
F = 4
H4, W4 = H // F, W // F
small = fg[:H4 * F, :W4 * F].reshape(H4, F, W4, F).any(axis=(1, 3))

labels = np.zeros((H4, W4), np.int32)
comps = []  # (r0,c0,r1,c1,area)
cur = 0
NB = [(-1,-1),(-1,0),(-1,1),(0,-1),(0,1),(1,-1),(1,0),(1,1)]
for sr in range(H4):
    for sc in range(W4):
        if small[sr, sc] and labels[sr, sc] == 0:
            cur += 1
            r0=r1=sr; c0=c1=sc; area=0
            stack=[(sr,sc)]; labels[sr,sc]=cur
            while stack:
                r,c=stack.pop(); area+=1
                r0=min(r0,r); r1=max(r1,r); c0=min(c0,c); c1=max(c1,c)
                for dr,dc in NB:
                    nr,nc=r+dr,c+dc
                    if 0<=nr<H4 and 0<=nc<W4 and small[nr,nc] and labels[nr,nc]==0:
                        labels[nr,nc]=cur; stack.append((nr,nc))
            comps.append([r0,c0,r1,c1,area])

# filter noise
comps=[c for c in comps if c[4]>=25]

# to full-res bboxes with padding, merge overlaps
def to_full(c):
    r0,c0,r1,c1,_=c
    return [max(0,r0*F-3), max(0,c0*F-3), min(H,(r1+1)*F+3), min(W,(c1+1)*F+3)]
boxes=[to_full(c) for c in comps]

def overlap(a,b):
    return not (a[2]<b[0] or b[2]<a[0] or a[3]<b[1] or b[3]<a[1])
merged=True
while merged:
    merged=False
    out=[]
    while boxes:
        a=boxes.pop()
        i=0
        while i<len(boxes):
            if overlap(a,boxes[i]):
                b=boxes.pop(i)
                a=[min(a[0],b[0]),min(a[1],b[1]),max(a[2],b[2]),max(a[3],b[3])]
                merged=True
            else: i+=1
        out.append(a)
    boxes=out

# ---- cluster into 3 rows by vertical center (2 largest gaps) ----
boxes.sort(key=lambda b:(b[0]+b[2])/2)
cys=[(b[0]+b[2])/2 for b in boxes]
gaps=sorted(range(len(cys)-1), key=lambda i:cys[i+1]-cys[i], reverse=True)[:2]
splits=sorted(gaps)
rows=[]; start=0
for s in splits:
    rows.append(boxes[start:s+1]); start=s+1
rows.append(boxes[start:])
for r in rows: r.sort(key=lambda b:b[1])  # left-to-right

# expected names per row (falls back to generic if count differs)
NAMES=[
 ["floor-wood","floor-cream","floor-carpet"],
 ["wall-straight-h","wall-straight-v","wall-corner-a","wall-corner-b","wall-T"],
 ["desk","office-chair","plant","rug"],
]

# px-per-tile from floor row (row 0) median size
floor_row = rows[0] if rows else []
if floor_row:
    dims=[max(b[2]-b[0], b[3]-b[1]) for b in floor_row]
    px_per_tile=float(np.median(dims))
else:
    px_per_tile=460.0
scale=32.0/px_per_tile

os.makedirs(os.path.join(OUT,"cutouts"),exist_ok=True)
os.makedirs(os.path.join(OUT,"downscaled"),exist_ok=True)

# suggested target footprint per spec (docs/02b); walls become a 32px unit,
# floors 32x32, others keep aspect but snapped to nearest 32-multiple >=1
SPEC={"desk":(2,1),"office-chair":(1,1),"plant":(1,2),"rug":(2,2)}

results=[]  # (name, w_full, h_full, dw, dh, footprint_note, down_img)
for ri,row in enumerate(rows):
    names=NAMES[ri] if ri<len(NAMES) else []
    for ci,b in enumerate(row):
        name = names[ci] if ci<len(names) else f"row{ri}-{ci}"
        r0,c0,r1,c1=b
        cut=keyed.crop((c0,r0,c1,r1))
        bbox=cut.getbbox()
        if bbox: cut=cut.crop(bbox)
        cut.save(os.path.join(OUT,"cutouts",name+".png"))
        wf,hf=cut.size
        if name.startswith("floor"):
            dw,dh=32,32; note="1x1 (floor)"
        elif name.startswith("wall"):
            # keep the strip's aspect; a wall UNIT is 32 wide, height by aspect
            dw=32; dh=max(4,round(hf*(32.0/wf))); note="wall unit (rebuild 47-blob)"
        else:
            # proportional uniform downscale (NO distortion), keep true shape
            dw=max(1,round(wf*scale)); dh=max(1,round(hf*scale))
            sp=SPEC.get(name); note=f"spec {sp[0]}x{sp[1]}" if sp else "proportional"
        down=cut.resize((dw,dh),Image.NEAREST)
        down.save(os.path.join(OUT,"downscaled",name+".png"))
        results.append((name,wf,hf,dw,dh,note,down))

# ---- contact sheet ----
COLS=5; CW,CH=210,210
rowsn=(len(results)+COLS-1)//COLS
sheet=Image.new("RGBA",(COLS*CW,rowsn*CH+40),(238,231,214,255))
from PIL import ImageDraw, ImageFont
d=ImageDraw.Draw(sheet)
try: font=ImageFont.truetype("arial.ttf",13); fb=ImageFont.truetype("arialbd.ttf",14)
except: font=fb=ImageFont.load_default()
d.text((14,12),f"Auto-sliced from anchor  ·  {len(results)} sprites  ·  px/tile~{px_per_tile:.0f}",fill=(40,40,45,255),font=fb)
for i,(name,wf,hf,dw,dh,note,down) in enumerate(results):
    cx=(i%COLS)*CW; cy=40+(i//COLS)*CH
    d.rectangle([cx+6,cy+6,cx+CW-6,cy+CH-6],fill=(250,246,236,255),outline=(210,203,186,255))
    sc=min(4,max(1,150//max(down.width,down.height)))
    big=down.resize((down.width*sc,down.height*sc),Image.NEAREST)
    px=cx+(CW-big.width)//2; py=cy+24+(140-big.height)//2 if big.height<140 else cy+24
    sheet.alpha_composite(big,(px,py))
    d.text((cx+CW//2,cy+CH-30),name,fill=(45,45,50,255),font=fb,anchor="mm")
    d.text((cx+CW//2,cy+CH-14),f"{dw}x{dh}px  ·  {note}",fill=(140,133,120,255),font=font,anchor="mm")
sheet.save(os.path.join(OUT,"_contact-sheet.png"))

print(f"source {W}x{H} | sprites {len(results)} | px/tile~{px_per_tile:.0f} | scale {scale:.3f}")
for name,wf,hf,dw,dh,note,_ in results:
    print(f"  {name:20s} src {wf:4d}x{hf:<4d} -> {dw}x{dh}px  [{note}]")
