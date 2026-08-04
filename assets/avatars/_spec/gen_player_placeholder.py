# -*- coding: utf-8 -*-
"""Placeholder player spritesheet: 4 rows (down,up,left,right) x 4 frames, 32x32 each.
Frame 0 = idle, 1-3 = walk cycle. Output: player.png (128x128).
Usage: python gen_player_placeholder.py <out_dir>
"""
import os, sys
from PIL import Image, ImageDraw

T=32; FR=4; DIRS=["down","up","left","right"]
SKIN=(240,201,168,255); SKD=(214,167,130,255)
HAIR=(91,58,41,255); SHIRT=(43,157,144,255); SHIRTD=(31,120,110,255)
PANTS=(60,72,96,255); SHOE=(52,44,40,255); OUTL=(40,38,48,255)
EYE=(40,38,48,255); TRANS=(0,0,0,0)
SWING=[0,2,0,-2]

def draw(d, direction, sw):
    mx=16
    # shadow
    d.ellipse([9,28,23,31],fill=(0,0,0,60))
    # legs
    d.rectangle([12+sw,24,14+sw,29],fill=PANTS); d.rectangle([18-sw,24,20-sw,29],fill=PANTS)
    d.rectangle([12+sw,29,14+sw,30],fill=SHOE);  d.rectangle([18-sw,29,20-sw,30],fill=SHOE)
    # arms
    d.rectangle([8,15,10,22],fill=SHIRT); d.rectangle([22,15,24,22],fill=SHIRT)
    # body
    d.rectangle([10,14,22,24],fill=SHIRT); d.rectangle([10,14,22,15],fill=SHIRTD)
    d.rectangle([10,14,22,24],outline=OUTL)
    # head
    d.ellipse([9,3,23,15],fill=SKIN); d.ellipse([9,3,23,15],outline=OUTL)
    # hair + face
    if direction=="down":
        d.chord([9,3,23,13],180,360,fill=HAIR)
        d.point([(13,10),(14,10)],fill=EYE); d.point([(18,10),(19,10)],fill=EYE)
    elif direction=="up":
        d.ellipse([9,3,23,14],fill=HAIR)
    elif direction=="left":
        d.chord([9,3,23,13],180,360,fill=HAIR)
        d.point([(12,10),(13,10)],fill=EYE)
    elif direction=="right":
        d.chord([9,3,23,13],180,360,fill=HAIR)
        d.point([(19,10),(20,10)],fill=EYE)

sheet=Image.new("RGBA",(T*FR,T*len(DIRS)),TRANS)
for r,dir_ in enumerate(DIRS):
    for c in range(FR):
        cell=Image.new("RGBA",(T,T),TRANS); d=ImageDraw.Draw(cell)
        draw(d, dir_, SWING[c] if c>0 else 0)
        sheet.paste(cell,(c*T,r*T))

out=sys.argv[1] if len(sys.argv)>1 else "."
os.makedirs(out,exist_ok=True)
sheet.save(os.path.join(out,"player.png"))
print("wrote player.png 128x128 (4 dir x 4 frames)")
