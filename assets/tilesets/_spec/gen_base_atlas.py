# -*- coding: utf-8 -*-
"""Generate visual reference sheets for the NexSpace BASE tileset:
  1) base-tileset-atlas.svg  -> floor tiles (uniform 32px) + furniture catalog (sized sprites)
  2) prefab-rooms.svg        -> example prefab room layouts drawn on a tile grid
Furniture uses a "Collection of Images" tileset (arbitrary-size sprites on the Objects layer);
floor uses a uniform 32px tile-grid tileset (painted on Floor layer).
"""
import os, sys

# ---------- palette --------------------------------------------------------
C_SHEET="#f4f1ea"; C_CARD="#ffffff"; C_CARD_S="#e3ded3"
C_TXT="#2a2f36"; C_SUB="#8a8378"; C_ACCENT="#2bb3a3"
C_COLLIDE="#e07a5f"; C_WALK="#6fbf73"
GRID="#e7e3da"
# glyph fills
FILL={
 "wood":"#c89b6c","wood2":"#a9764a","gray":"#c9d3de","dark":"#5c6773",
 "teal":"#2bb3a3","green":"#6fbf73","cream":"#efe9dc","blue":"#7fb0d6",
 "peach":"#f2a365","white":"#ffffff","screen":"#3a4a5a",
}

def esc(s): return s.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')

# ---------- glyph drawers (schematic furniture icons) ----------------------
def glyph(kind, x, y, w, h, color):
    """draw a schematic icon inside rect (x,y,w,h)."""
    f=FILL.get(color,color); p=[]
    def r(rx,ry,rw,rh,fill,rd=3,op=1.0,stroke="none",sw=0):
        return (f'<rect x="{rx:.1f}" y="{ry:.1f}" width="{rw:.1f}" height="{rh:.1f}" rx="{rd}" '
                f'fill="{fill}" opacity="{op}" stroke="{stroke}" stroke-width="{sw}"/>')
    def el(cx,cy,rxr,ryr,fill,stroke="none",sw=0):
        return (f'<ellipse cx="{cx:.1f}" cy="{cy:.1f}" rx="{rxr:.1f}" ry="{ryr:.1f}" '
                f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>')
    if kind=="desk":
        p.append(r(x,y+h*0.25,w,h*0.6,f))
        p.append(r(x+w*0.55,y+h*0.30,w*0.32,h*0.24,FILL["screen"]))  # monitor
        p.append(r(x+w*0.20,y+h*0.55,w*0.22,h*0.16,FILL["dark"],2)) # keyboard
    elif kind=="counter":
        p.append(r(x,y+h*0.3,w,h*0.5,f)); p.append(r(x,y+h*0.3,w,h*0.12,FILL["cream"]))
    elif kind=="reception":
        p.append(r(x,y+h*0.28,w,h*0.5,f)); p.append(r(x,y+h*0.28,w,h*0.14,FILL["teal"]))
    elif kind=="seat":  # chair / armchair
        p.append(r(x+w*0.18,y+h*0.2,w*0.64,h*0.62,f))
        p.append(r(x+w*0.18,y+h*0.12,w*0.64,h*0.16,FILL["dark"],3))  # backrest
    elif kind=="sofa":
        p.append(r(x+w*0.06,y+h*0.28,w*0.88,h*0.5,f))
        p.append(r(x+w*0.06,y+h*0.18,w*0.88,h*0.16,f))
        p.append(r(x+w*0.02,y+h*0.3,w*0.1,h*0.42,FILL["dark"],3,0.5))
        p.append(r(x+w*0.88,y+h*0.3,w*0.1,h*0.42,FILL["dark"],3,0.5))
    elif kind=="sofa_corner":
        p.append(r(x+w*0.08,y+h*0.1,w*0.84,h*0.35,f))
        p.append(r(x+w*0.08,y+h*0.1,w*0.35,h*0.8,f))
    elif kind=="table_round":
        p.append(el(x+w/2,y+h/2,w*0.4,h*0.4,f,FILL["dark"],1))
    elif kind=="table_long":
        p.append(r(x+w*0.1,y+h*0.2,w*0.8,h*0.6,f,4,1,FILL["dark"],1))
    elif kind=="coffee":
        p.append(r(x+w*0.2,y+h*0.32,w*0.6,h*0.36,f,4))
    elif kind=="panel":  # whiteboard / wall art / screen frame
        p.append(r(x+w*0.1,y+h*0.15,w*0.8,h*0.62,FILL["white"],2,1,FILL["dark"],1.5))
    elif kind=="screen":
        p.append(r(x+w*0.08,y+h*0.12,w*0.84,h*0.58,FILL["screen"],2))
        p.append(r(x+w*0.14,y+h*0.18,w*0.72,h*0.46,FILL["blue"],1,0.5))
    elif kind=="tall":  # fridge / cabinet / shelf / cooler
        p.append(r(x+w*0.2,y+h*0.06,w*0.6,h*0.86,f))
        p.append(r(x+w*0.66,y+h*0.35,w*0.05,h*0.25,FILL["dark"],1))  # handle
    elif kind=="shelf":
        p.append(r(x+w*0.15,y+h*0.1,w*0.7,h*0.8,f))
        for i in range(3):
            p.append(r(x+w*0.15,y+h*(0.28+0.22*i),w*0.7,h*0.05,FILL["dark"],0,0.6))
    elif kind=="plant":
        p.append(el(x+w/2,y+h*0.35,w*0.3,h*0.28,FILL["green"]))
        p.append(r(x+w*0.38,y+h*0.6,w*0.24,h*0.28,FILL["wood2"],2))
    elif kind=="plant_tall":
        p.append(el(x+w/2,y+h*0.3,w*0.26,h*0.26,FILL["green"]))
        p.append(el(x+w*0.4,y+h*0.42,w*0.18,h*0.18,FILL["green"]))
        p.append(r(x+w*0.4,y+h*0.6,w*0.2,h*0.3,FILL["cream"],2))
    elif kind=="machine":  # coffee machine
        p.append(r(x+w*0.28,y+h*0.2,w*0.44,h*0.6,FILL["dark"],2))
        p.append(r(x+w*0.34,y+h*0.55,w*0.32,h*0.12,FILL["cream"],1))
    elif kind=="cooler":
        p.append(r(x+w*0.3,y+h*0.1,w*0.4,h*0.35,FILL["blue"],3,0.7))
        p.append(r(x+w*0.32,y+h*0.42,w*0.36,h*0.48,FILL["gray"],2))
    elif kind=="lamp":
        p.append(r(x+w*0.47,y+h*0.3,w*0.06,h*0.6,FILL["dark"]))
        p.append(el(x+w/2,y+h*0.24,w*0.22,h*0.14,FILL["peach"]))
    elif kind=="rug":
        p.append(r(x+w*0.06,y+h*0.12,w*0.88,h*0.72,f,6,1,FILL["dark"],1))
        p.append(r(x+w*0.16,y+h*0.22,w*0.68,h*0.52,FILL["cream"],4,0.4))
    elif kind=="bar_table":
        p.append(el(x+w/2,y+h*0.4,w*0.28,h*0.22,f))
        p.append(r(x+w*0.46,y+h*0.5,w*0.08,h*0.32,FILL["dark"]))
    else:
        p.append(r(x+w*0.2,y+h*0.2,w*0.6,h*0.6,f))
    return "".join(p)

# ---------- data -----------------------------------------------------------
FLOOR=[  # (name, color)
 ("floor-light","cream"),("floor-warm","#e4ddd1"),("wood-plank","wood"),
 ("carpet-gray","gray"),("carpet-teal","#bfe3dd"),("marble","#eef1f4"),
 ("concrete","#d7d3ca"),("grass","#bfe0b0"),("tile-checker","#e9e4d8"),
 ("carpet-blue","#cdd9e6"),
]
# furniture: (name, w, h, collides, glyph, color, dirs)
CATS=[
 ("Work / Desk  ·  layer: Objects",[
   ("desk",2,1,True,"desk","wood",1),
   ("desk-L",2,2,True,"desk","wood",4),
   ("office-chair",1,1,False,"seat","gray",4),
   ("stool",1,1,False,"seat","wood",1),
   ("filing-cabinet",1,1,True,"tall","gray",1),
   ("bookshelf",2,1,True,"shelf","wood2",1),
 ]),
 ("Meeting",[
   ("meeting-table-long",4,2,True,"table_long","wood",1),
   ("meeting-table-round",2,2,True,"table_round","wood",1),
   ("whiteboard",2,1,True,"panel","gray",1),
   ("presentation-screen",2,1,True,"screen","dark",1),
 ]),
 ("Lounge",[
   ("sofa-2seat",2,1,True,"sofa","teal",4),
   ("sofa-corner",2,2,True,"sofa_corner","teal",4),
   ("armchair",1,1,True,"seat","peach",4),
   ("coffee-table",2,1,True,"coffee","wood",1),
   ("rug-2x2",2,2,False,"rug","teal",1),
   ("plant-tall",1,2,True,"plant_tall","green",1),
 ]),
 ("Pantry / Cafe",[
   ("counter",2,1,True,"counter","wood2",1),
   ("fridge",1,2,True,"tall","gray",1),
   ("coffee-machine",1,1,True,"machine","dark",1),
   ("water-cooler",1,1,True,"cooler","blue",1),
   ("bar-table",1,1,True,"bar_table","wood",1),
 ]),
 ("Decor & Misc",[
   ("reception-desk",3,1,True,"reception","wood",1),
   ("plant-small",1,1,False,"plant","green",1),
   ("floor-lamp",1,1,True,"lamp","peach",1),
   ("wall-art",1,1,False,"panel","gray",1),
 ]),
]

# ---------- render base atlas ---------------------------------------------
def render_base():
    PAD=24; W=1180
    parts=[]; y=0
    def H(): return "".join(parts)
    # header
    parts.append(f'<text x="{PAD}" y="42" font-size="26" font-weight="700" fill="{C_TXT}">NexSpace — Base Tileset Atlas</text>')
    parts.append(f'<text x="{PAD}" y="66" font-size="13" fill="{C_SUB}">Floor = uniform 32px tile-grid (Floor layer) · Furniture = Collection-of-Images sprites (Objects layer) · draw @2x</text>')
    y=88
    # legend
    parts.append(f'<rect x="{PAD}" y="{y}" width="14" height="14" rx="3" fill="none" stroke="{C_COLLIDE}" stroke-width="2"/>'
                 f'<text x="{PAD+20}" y="{y+12}" font-size="12" fill="{C_SUB}">collides (กันชน)</text>')
    parts.append(f'<rect x="{PAD+150}" y="{y}" width="14" height="14" rx="3" fill="none" stroke="{C_WALK}" stroke-width="2" stroke-dasharray="3 2"/>'
                 f'<text x="{PAD+170}" y="{y+12}" font-size="12" fill="{C_SUB}">walkable (เดินผ่าน/นั่งได้)</text>')
    parts.append(f'<text x="{PAD+340}" y="{y+12}" font-size="12" fill="{C_SUB}">ตัวเลข = footprint (กว้าง×สูง เป็น tile 32px) · ×N = จำนวนทิศที่ต้องวาด</text>')
    y+=36
    # floor section
    parts.append(f'<text x="{PAD}" y="{y+14}" font-size="16" font-weight="700" fill="{C_ACCENT}">Floor tiles · 1×1 · Floor layer</text>')
    y+=28
    tp=52
    for i,(nm,col) in enumerate(FLOOR):
        fx=PAD+i*(tp+30); fy=y
        c=FILL.get(col,col)
        parts.append(f'<rect x="{fx}" y="{fy}" width="{tp}" height="{tp}" rx="4" fill="{c}" stroke="{C_CARD_S}"/>')
        # subtle texture hint
        parts.append(f'<rect x="{fx}" y="{fy}" width="{tp}" height="{tp}" rx="4" fill="none" stroke="{GRID}"/>')
        parts.append(f'<text x="{fx+tp/2}" y="{fy+tp+14}" font-size="10" text-anchor="middle" fill="{C_SUB}">{esc(nm)}</text>')
    y+=tp+30
    # furniture sections
    CARD_W=182; CARD_H=150; COLS=6; TILE=26
    for title,items in CATS:
        parts.append(f'<text x="{PAD}" y="{y+16}" font-size="16" font-weight="700" fill="{C_ACCENT}">{esc(title)}</text>')
        y+=26
        for i,(nm,w,h,col,gl,color,dirs) in enumerate(items):
            r_=i//COLS; c_=i%COLS
            cx=PAD+c_*(CARD_W+6); cy=y+r_*(CARD_H+6)
            parts.append(f'<rect x="{cx}" y="{cy}" width="{CARD_W}" height="{CARD_H}" rx="10" fill="{C_CARD}" stroke="{C_CARD_S}"/>')
            # footprint grid preview centered in upper area
            gw=w*TILE; gh=h*TILE
            gx=cx+(CARD_W-gw)/2; gy=cy+16+(72-gh)/2 if gh<72 else cy+16
            # tile grid backing
            for tx in range(w):
                for ty in range(h):
                    parts.append(f'<rect x="{gx+tx*TILE}" y="{gy+ty*TILE}" width="{TILE}" height="{TILE}" '
                                 f'fill="#faf8f3" stroke="{GRID}" stroke-width="1"/>')
            # glyph
            parts.append(glyph(gl,gx,gy,gw,gh,color))
            # collision outline
            st=C_COLLIDE if col else C_WALK
            dash='' if col else 'stroke-dasharray="4 3"'
            parts.append(f'<rect x="{gx-1}" y="{gy-1}" width="{gw+2}" height="{gh+2}" rx="3" fill="none" stroke="{st}" stroke-width="2" {dash}/>')
            # labels
            parts.append(f'<text x="{cx+CARD_W/2}" y="{cy+CARD_H-30}" font-size="12.5" font-weight="600" text-anchor="middle" fill="{C_TXT}">{esc(nm)}</text>')
            meta=f'{w}×{h}' + (f'  ·  ×{dirs} dir' if dirs>1 else '')
            parts.append(f'<text x="{cx+CARD_W/2}" y="{cy+CARD_H-13}" font-size="11" text-anchor="middle" fill="{C_SUB}">{esc(meta)}</text>')
        rows=(len(items)+COLS-1)//COLS
        y+=rows*(CARD_H+6)+14
    total_h=y+PAD
    svg=(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{total_h}" '
         f'viewBox="0 0 {W} {total_h}" font-family="Segoe UI, Arial, sans-serif">'
         f'<rect width="{W}" height="{total_h}" fill="{C_SHEET}"/>'+H()+'</svg>')
    return svg

# ---------- prefab rooms ---------------------------------------------------
# each prefab: (title, cols, rows, walls[(x,y,w,h)], floor_color, items[(name,x,y,w,h,glyph,color)])
PREFABS=[
 ("desk-cluster-4  ·  6×5",6,5,[], "carpet-gray",[
   ("desk",1,1,2,1,"desk","wood"),("office-chair",1,2,1,1,"seat","gray"),("office-chair",2,2,1,1,"seat","gray"),
   ("desk",3,1,2,1,"desk","wood"),("office-chair",3,2,1,1,"seat","gray"),("office-chair",4,2,1,1,"seat","gray"),
   ("desk",1,3,2,1,"desk","wood"),("office-chair",1,3,1,1,"seat","gray"),
   ("desk",3,3,2,1,"desk","wood"),("plant-tall",5,0,1,2,"plant_tall","green"),
 ]),
 ("meeting-room-8  ·  8×6 (glass walls)",8,6,[(0,0,8,1),(0,0,1,6),(7,0,1,6),(0,5,8,1)], "marble",[
   ("presentation-screen",3,0,2,1,"screen","dark"),
   ("meeting-table-long",2,2,4,2,"table_long","wood"),
   ("office-chair",2,1,1,1,"seat","gray"),("office-chair",3,1,1,1,"seat","gray"),
   ("office-chair",4,1,1,1,"seat","gray"),("office-chair",5,1,1,1,"seat","gray"),
   ("office-chair",2,4,1,1,"seat","gray"),("office-chair",3,4,1,1,"seat","gray"),
   ("office-chair",4,4,1,1,"seat","gray"),("office-chair",5,4,1,1,"seat","gray"),
 ]),
 ("lounge-corner  ·  6×5",6,5,[], "carpet-teal",[
   ("rug-2x2",1,1,3,3,"rug","teal"),
   ("sofa-corner",1,1,2,2,"sofa_corner","teal"),
   ("sofa-2seat",3,1,2,1,"sofa","teal"),
   ("coffee-table",2,3,2,1,"coffee","wood"),
   ("plant-tall",5,0,1,2,"plant_tall","green"),("plant-small",0,4,1,1,"plant","green"),
 ]),
]

def render_prefabs():
    PAD=24; TILE=40; GAP=40
    # layout prefabs in a row, wrap if needed
    parts=[]
    parts.append(f'<text x="{PAD}" y="40" font-size="24" font-weight="700" fill="{C_TXT}">NexSpace — Prefab Rooms (ตัวอย่างห้องสำเร็จรูป)</text>')
    parts.append(f'<text x="{PAD}" y="62" font-size="13" fill="{C_SUB}">ประกอบจากเฟอร์นิเจอร์ใน base atlas + รวม Meta zone ในตัว · เซฟเป็น Tiled template (.tx) ลากวางซ้ำได้</text>')
    x=PAD; y=84; rowH=0; maxW=0
    for title,cols,rows,walls,fcol,items in PREFABS:
        gw=cols*TILE; gh=rows*TILE
        cardw=gw+32; cardh=gh+64
        if x+cardw>1500 and x>PAD:
            x=PAD; y+=rowH+GAP; rowH=0
        # card
        parts.append(f'<rect x="{x}" y="{y}" width="{cardw}" height="{cardh}" rx="12" fill="{C_CARD}" stroke="{C_CARD_S}"/>')
        parts.append(f'<text x="{x+16}" y="{y+26}" font-size="14" font-weight="700" fill="{C_ACCENT}">{esc(title)}</text>')
        ox=x+16; oy=y+40
        # floor
        fc=FILL.get(fcol,fcol)
        parts.append(f'<rect x="{ox}" y="{oy}" width="{gw}" height="{gh}" fill="{fc}"/>')
        # tile grid
        for i in range(cols+1):
            parts.append(f'<line x1="{ox+i*TILE}" y1="{oy}" x2="{ox+i*TILE}" y2="{oy+gh}" stroke="{GRID}" stroke-width="1"/>')
        for j in range(rows+1):
            parts.append(f'<line x1="{ox}" y1="{oy+j*TILE}" x2="{ox+gw}" y2="{oy+j*TILE}" stroke="{GRID}" stroke-width="1"/>')
        # walls
        for (wx,wy,ww,wh) in walls:
            parts.append(f'<rect x="{ox+wx*TILE}" y="{oy+wy*TILE}" width="{ww*TILE}" height="{wh*TILE}" '
                         f'fill="#c9d3de" stroke="#93a2b3" stroke-width="1.5" opacity="0.85"/>')
        # items
        for (nm,ix,iy,iw,ih,gl,color) in items:
            parts.append(glyph(gl, ox+ix*TILE, oy+iy*TILE, iw*TILE, ih*TILE, color))
        x+=cardw+GAP
        rowH=max(rowH,cardh); maxW=max(maxW,x)
    total_w=max(maxW,900)+PAD; total_h=y+rowH+PAD
    svg=(f'<svg xmlns="http://www.w3.org/2000/svg" width="{total_w}" height="{total_h}" '
         f'viewBox="0 0 {total_w} {total_h}" font-family="Segoe UI, Arial, sans-serif">'
         f'<rect width="{total_w}" height="{total_h}" fill="{C_SHEET}"/>'+"".join(parts)+'</svg>')
    return svg

out=sys.argv[1] if len(sys.argv)>1 else "."
os.makedirs(out,exist_ok=True)
with open(os.path.join(out,"base-tileset-atlas.svg"),"w",encoding="utf-8") as f: f.write(render_base())
with open(os.path.join(out,"prefab-rooms.svg"),"w",encoding="utf-8") as f: f.write(render_prefabs())
