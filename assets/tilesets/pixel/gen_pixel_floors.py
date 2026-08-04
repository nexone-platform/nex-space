# -*- coding: utf-8 -*-
"""Generate REAL placeholder pixel-art floor tiles (32x32, seamless-tileable) as PNGs.
Outputs:
  floor-pixel.png          -> atlas, one 32x32 tile per column (1x, for Tiled)
  floor-pixel-preview.png  -> each tile tiled 3x3 and upscaled x6 (proves tileability)
These are PLACEHOLDERS for Phase 1; final art via AI + Aseprite (see docs/06).
"""
import os, sys, random
from PIL import Image, ImageDraw, ImageFont

random.seed(42)
S = 32

def C(*rgb): return tuple(rgb)
CREAM=C(244,236,214); CREAM_D=C(228,213,176); CREAM_L=C(252,246,230)
WOOD=C(200,148,90); WOOD_D=C(165,107,57); WOOD_DD=C(110,66,31); WOOD_L=C(216,170,116)
GRAY=C(207,214,221); GRAY_D=C(154,163,173); GRAY_L=C(224,229,234)
TEAL=C(150,205,197); TEAL_D=C(110,175,167); TEAL_L=C(178,222,214)
MARB=C(238,240,244); MARB_D=C(212,218,226); MARB_V=C(200,207,217)
GRASS=C(124,197,118); GRASS_D=C(79,154,82); GRASS_L=C(150,214,140)
CONC=C(215,211,202); CONC_D=C(190,186,176)

def new(): return Image.new("RGBA",(S,S),(0,0,0,255))

def fill(img,col):
    d=ImageDraw.Draw(img); d.rectangle([0,0,S-1,S-1],fill=col+(255,)); return d

def px(d,x,y,col): d.point((x%S,y%S),fill=col+(255,))

def speckle(d,cols,n):
    for _ in range(n):
        x=random.randrange(S); y=random.randrange(S)
        px(d,x,y,random.choice(cols))

def t_light():
    img=new(); d=fill(img,CREAM); speckle(d,[CREAM_D],30); speckle(d,[CREAM_L],22); return img

def t_wood():
    img=new(); d=fill(img,WOOD)
    for y in (0,16):  # plank seams (height 16 -> tiles vertically)
        d.line([0,y,S-1,y],fill=WOOD_DD+(255,))
        d.line([0,y+1,S-1,y+1],fill=WOOD_D+(255,))
    # butt joints (staggered) - tileable via modulo
    for (jx,y0,y1) in [(16,1,15),(0,17,31)]:
        for yy in range(y0,y1): px(d,jx,yy,WOOD_DD)
    # grain dashes
    for _ in range(26):
        x=random.randrange(S); y=random.randrange(S); ln=random.randrange(2,5)
        col=random.choice([WOOD_D,WOOD_L])
        for i in range(ln): px(d,x+i,y,col)
    return img

def t_carpet(base,dark):
    img=new(); d=fill(img,base)
    for y in range(S):
        for x in range(S):
            if (x//2+y//2)%2==0: px(d,x,y,dark)  # subtle 2x2 dither (tileable)
    speckle(d,[base],40)
    return img

def t_marble():
    img=new(); d=fill(img,MARB)
    # faint internal veins (kept away from edges -> edges plain = tileable)
    pts=[(6,26),(10,20),(15,16),(20,13),(24,8)]
    for i in range(len(pts)-1):
        d.line([pts[i],pts[i+1]],fill=MARB_V+(255,))
    d.line([(22,24),(26,20),(29,19)],fill=MARB_V+(255,))
    speckle(d,[MARB_D],18)
    return img

def t_concrete():
    img=new(); d=fill(img,CONC); speckle(d,[CONC_D],55); return img

def t_grass():
    img=new(); d=fill(img,GRASS)
    speckle(d,[GRASS_D],40); speckle(d,[GRASS_L],28)
    for _ in range(16):  # tiny blades (2px vertical)
        x=random.randrange(S); y=random.randrange(S)
        px(d,x,y,GRASS_D); px(d,x,y+1,GRASS_D)
    return img

TILES=[
 ("floor-light",t_light()),
 ("wood-plank",t_wood()),
 ("carpet-gray",t_carpet(GRAY,GRAY_D)),
 ("carpet-teal",t_carpet(TEAL,TEAL_D)),
 ("marble",t_marble()),
 ("concrete",t_concrete()),
 ("grass",t_grass()),
]

out=sys.argv[1] if len(sys.argv)>1 else "."
os.makedirs(out,exist_ok=True)

# --- atlas (1x, 32px per tile, single row) ---
atlas=Image.new("RGBA",(S*len(TILES),S),(0,0,0,0))
for i,(_,im) in enumerate(TILES): atlas.paste(im,(i*S,0))
atlas.save(os.path.join(out,"floor-pixel.png"))

# --- preview: each tile 3x3 tiled, upscaled x6, labeled ---
SCALE=6; REP=3; label_h=18; gap=14
cellw=S*REP*SCALE
prev_w=len(TILES)*cellw+(len(TILES)+1)*gap
prev_h=S*REP*SCALE+label_h+gap*2
preview=Image.new("RGBA",(prev_w,prev_h),(244,236,230,255))
dr=ImageDraw.Draw(preview)
try: font=ImageFont.truetype("arial.ttf",12)
except: font=ImageFont.load_default()
for i,(nm,im) in enumerate(TILES):
    block=Image.new("RGBA",(S*REP,S*REP))
    for a in range(REP):
        for b in range(REP):
            block.paste(im,(a*S,b*S))
    block=block.resize((cellw,cellw),Image.NEAREST)
    x=gap+i*(cellw+gap); y=gap
    preview.paste(block,(x,y))
    dr.rectangle([x-1,y-1,x+cellw,y+cellw],outline=(140,140,140,255))
    dr.text((x,y+cellw+3),nm,fill=(60,60,60,255),font=font)
preview.save(os.path.join(out,"floor-pixel-preview.png"))
print("tiles:",len(TILES))
