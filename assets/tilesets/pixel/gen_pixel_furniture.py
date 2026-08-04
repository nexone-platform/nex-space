# -*- coding: utf-8 -*-
"""Generate REAL placeholder pixel-art FURNITURE (simple blocky sprites) at their
tile footprints, matching docs/02b. Outputs individual PNGs (for Tiled "Collection
of Images") plus a labeled preview atlas.
"""
import os, sys
from PIL import Image, ImageDraw, ImageFont

T=32; TR=(0,0,0,0)
WOOD=(200,148,90,255); WOOD_D=(165,107,57,255); WOOD_DD=(120,74,36,255); WOOD_L=(220,176,120,255)
GRAY=(202,209,217,255); GRAY_D=(150,160,172,255); GRAY_L=(226,231,236,255)
TEAL=(70,199,184,255); TEAL_D=(43,157,144,255); TEAL_L=(126,222,210,255)
DARK=(58,64,76,255); SCREEN=(52,68,84,255); GLOW=(126,182,212,255)
GREEN=(124,197,118,255); GREEN_D=(79,154,82,255); GREEN_L=(152,214,140,255)
WHITE=(245,246,248,255); PEACH=(242,163,101,255); PEACH_D=(217,123,70,255)
POT=(190,120,74,255); METAL=(196,203,212,255); OUTL=(45,42,52,255)
BLUE=(120,170,210,255)

def canvas(w,h):
    im=Image.new("RGBA",(w*T,h*T),TR); return im, ImageDraw.Draw(im)
def box(d,x0,y0,x1,y1,fill,outline=OUTL):
    d.rectangle([x0,y0,x1,y1],fill=fill)
    if outline: d.rectangle([x0,y0,x1,y1],outline=outline)
def sh(d,cx,y,w):  # soft shadow oval-ish at bottom
    d.ellipse([cx-w,y-3,cx+w,y+3],fill=(0,0,0,60))

def f_desk(w=2,h=1):
    im,d=canvas(w,h); W,H=w*T,h*T; sh(d,W//2,H-3,W//2-4)
    box(d,2,H-20,W-3,H-6,WOOD); d.rectangle([2,H-20,W-3,H-16],fill=WOOD_L)
    d.rectangle([3,H-9,W-4,H-7],fill=WOOD_D)
    box(d,W-24,H-30,W-8,H-19,SCREEN); d.rectangle([W-22,H-28,W-10,H-22],fill=GLOW)  # monitor
    d.rectangle([6,H-13,20,H-10],fill=DARK)  # keyboard
    return im
def f_desk_L():
    im,d=canvas(2,2); W,H=64,64; sh(d,W//2,H-3,26)
    box(d,3,20,W-4,40,WOOD); d.rectangle([3,20,W-4,24],fill=WOOD_L)
    box(d,3,20,26,H-5,WOOD); d.rectangle([3,20,26,24],fill=WOOD_L)
    box(d,34,6,54,18,SCREEN); d.rectangle([36,8,52,14],fill=GLOW)
    return im
def f_chair(color=GRAY,cd=GRAY_D):
    im,d=canvas(1,1); sh(d,16,29,10)
    box(d,8,6,24,12,cd)          # back
    box(d,8,14,24,26,color)      # seat
    return im
def f_cabinet():
    im,d=canvas(1,1); sh(d,16,29,10)
    box(d,7,4,25,28,GRAY); d.rectangle([7,15,25,16],fill=GRAY_D)
    d.rectangle([20,9,22,12],fill=DARK); d.rectangle([20,19,22,22],fill=DARK)
    return im
def f_bookshelf(w=2,h=1):
    im,d=canvas(w,h); W,H=w*T,h*T; sh(d,W//2,H-3,W//2-6)
    box(d,4,4,W-5,H-4,WOOD_D)
    for yy in (10,17,24):
        d.rectangle([6,yy,W-7,yy+1],fill=WOOD_DD)
    for i,c in enumerate([TEAL,PEACH,GREEN,BLUE,WOOD_L]):
        x=8+i*10
        d.rectangle([x,5,x+6,9],fill=c)
    return im
def f_table_long():
    im,d=canvas(4,2); W,H=128,64; sh(d,W//2,H-4,52)
    box(d,8,18,W-9,H-10,WOOD); d.rectangle([8,18,W-9,24],fill=WOOD_L)
    d.rectangle([10,H-14,W-11,H-11],fill=WOOD_D)
    return im
def f_whiteboard(w=2,h=1):
    im,d=canvas(w,h); W,H=w*T,h*T
    box(d,4,4,W-5,H-10,GRAY_D); box(d,7,7,W-8,H-13,WHITE)
    d.line([12,H-18,26,H-24],fill=BLUE,width=1); d.line([30,H-16,44,H-22],fill=(230,120,110,255),width=1)
    return im
def f_screen(w=2,h=1):
    im,d=canvas(w,h); W,H=w*T,h*T; sh(d,W//2,H-3,W//2-8)
    box(d,4,4,W-5,H-10,SCREEN); box(d,8,8,W-9,H-14,GLOW)
    d.rectangle([W//2-4,H-9,W//2+4,H-4],fill=DARK)
    return im
def f_sofa(color=TEAL,cd=TEAL_D,cl=TEAL_L,w=2,h=1):
    im,d=canvas(w,h); W,H=w*T,h*T; sh(d,W//2,H-3,W//2-4)
    box(d,3,10,W-4,H-5,color)
    box(d,3,6,W-4,16,cd)                 # backrest
    d.rectangle([4,17,W-5,19],fill=cl)
    d.line([W//2,17,W//2,H-7],fill=cd)   # cushion split
    box(d,2,12,8,H-6,cd); box(d,W-9,12,W-3,H-6,cd)  # arms
    return im
def f_armchair():
    return f_sofa(PEACH,PEACH_D,(250,190,150,255),1,1)
def f_coffee(w=2,h=1):
    im,d=canvas(w,h); W,H=w*T,h*T; sh(d,W//2,H-3,W//2-8)
    box(d,8,14,W-9,H-8,WOOD); d.rectangle([8,14,W-9,17,],fill=WOOD_L)
    return im
def f_plant_tall():
    im,d=canvas(1,2); sh(d,16,60,11)
    box(d,10,40,22,60,POT); d.rectangle([10,40,22,43],fill=(210,140,90,255))
    for (cx,cy,r) in [(16,26,9),(10,32,6),(22,32,6),(16,16,7)]:
        d.ellipse([cx-r,cy-r,cx+r,cy+r],fill=GREEN);
    d.ellipse([12,14,18,20],fill=GREEN_L)
    return im
def f_plant_small():
    im,d=canvas(1,1); sh(d,16,29,8)
    box(d,11,20,21,28,POT)
    for (cx,cy,r) in [(16,14,7),(11,18,4),(21,18,4)]:
        d.ellipse([cx-r,cy-r,cx+r,cy+r],fill=GREEN)
    d.ellipse([13,11,17,15],fill=GREEN_L)
    return im
def f_counter(w=2,h=1):
    im,d=canvas(w,h); W,H=w*T,h*T; sh(d,W//2,H-3,W//2-4)
    box(d,3,12,W-4,H-5,WOOD_D); d.rectangle([3,12,W-4,16],fill=GRAY_L)  # countertop
    d.line([W//2,17,W//2,H-6],fill=WOOD_DD)
    return im
def f_fridge():
    im,d=canvas(1,2); sh(d,16,60,11)
    box(d,7,6,25,60,GRAY_L)
    d.line([7,32,25,32],fill=GRAY_D); d.rectangle([21,20,23,28],fill=DARK); d.rectangle([21,38,23,46],fill=DARK)
    return im
def f_coffee_machine():
    im,d=canvas(1,1); sh(d,16,29,9)
    box(d,9,8,23,28,DARK); d.rectangle([11,20,21,24],fill=GRAY_L)
    d.rectangle([12,12,20,15],fill=(230,120,110,255))
    return im
def f_water_cooler():
    im,d=canvas(1,1); sh(d,16,29,8)
    box(d,11,14,21,28,GRAY); d.ellipse([10,4,22,16],fill=(150,200,230,200))
    return im
def f_rug():
    im,d=canvas(2,2); W,H=64,64
    box(d,4,10,W-5,H-6,TEAL_D); box(d,10,16,W-11,H-12,TEAL_L,None)
    d.rectangle([16,22,W-17,H-18],outline=TEAL)
    return im

ITEMS=[
 ("desk",2,1,f_desk),("desk-L",2,2,f_desk_L),("office-chair",1,1,lambda:f_chair()),
 ("filing-cabinet",1,1,f_cabinet),("bookshelf",2,1,lambda:f_bookshelf()),
 ("meeting-table-long",4,2,f_table_long),("whiteboard",2,1,lambda:f_whiteboard()),
 ("presentation-screen",2,1,lambda:f_screen()),("sofa-2seat",2,1,lambda:f_sofa()),
 ("armchair",1,1,f_armchair),("coffee-table",2,1,lambda:f_coffee()),
 ("plant-tall",1,2,f_plant_tall),("plant-small",1,1,f_plant_small),
 ("counter",2,1,lambda:f_counter()),("fridge",1,2,f_fridge),
 ("coffee-machine",1,1,f_coffee_machine),("water-cooler",1,1,f_water_cooler),("rug-2x2",2,2,f_rug),
]

out=sys.argv[1] if len(sys.argv)>1 else "."
fdir=os.path.join(out,"furniture"); os.makedirs(fdir,exist_ok=True)
rendered=[]
for nm,w,h,fn in ITEMS:
    im=fn(); im.save(os.path.join(fdir,nm+".png")); rendered.append((nm,w,h,im))

# ---- preview atlas ----
COLS=6; CW,CH=168,168
rows=(len(rendered)+COLS-1)//COLS
prev=Image.new("RGBA",(COLS*CW,rows*CH),(238,231,214,255))
d=ImageDraw.Draw(prev)
try: font=ImageFont.truetype("arial.ttf",12); fb=ImageFont.truetype("arialbd.ttf",13)
except: font=fb=ImageFont.load_default()
for i,(nm,w,h,im) in enumerate(rendered):
    cx=(i%COLS)*CW; cy=(i//COLS)*CH
    d.rectangle([cx+4,cy+4,cx+CW-4,cy+CH-4],fill=(250,246,236,255),outline=(210,203,186,255))
    scale=min(3,max(1,110//max(im.width,im.height)))
    big=im.resize((im.width*scale,im.height*scale),Image.NEAREST)
    px=cx+(CW-big.width)//2; py=cy+18+(112-big.height)//2 if big.height<112 else cy+18
    prev.alpha_composite(big,(px,py))
    d.text((cx+CW//2,cy+CH-30),nm,fill=(50,50,55,255),font=fb,anchor="mm")
    d.text((cx+CW//2,cy+CH-15),f"{w}x{h}",fill=(140,133,120,255),font=font,anchor="mm")
prev.save(os.path.join(out,"furniture-pixel-preview.png"))
print("furniture:",len(rendered))
