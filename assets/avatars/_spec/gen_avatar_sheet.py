# -*- coding: utf-8 -*-
"""Generate a visual reference for the NexSpace AVATAR layered spritesheet:
  avatar-spritesheet-layout.svg
Shows: frame grid (4 directions x 5 frames), layer stack / draw order,
a pivot-alignment guide, and customization slots.
"""
import os, sys

C_SHEET="#f4f1ea"; C_CARD="#ffffff"; C_CARD_S="#e3ded3"
C_TXT="#2a2f36"; C_SUB="#8a8378"; C_ACCENT="#2bb3a3"; GRID="#e7e3da"
SKIN="#f0c9a8"; HAIR="#5b3a29"; TOP="#2bb3a3"; BOT="#34506b"; SHOE="#3a2f2a"; PIVOT="#e07a5f"

def esc(s): return s.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')

# ---- character schematic ---------------------------------------------------
def character(cx, cy, w, h, direction, swing):
    """draw a schematic avatar in cell top-left (cx,cy) size (w,h). foot baseline at bottom."""
    p=[]
    midx=cx+w/2
    footy=cy+h*0.92
    # shadow
    p.append(f'<ellipse cx="{midx:.1f}" cy="{footy+2:.1f}" rx="{w*0.26:.1f}" ry="{h*0.03:.1f}" fill="#00000022"/>')
    bw=w*0.34; bh=h*0.34          # body
    bx=midx-bw/2; by=cy+h*0.40
    hr=w*0.20                      # head radius
    hy=by-hr*0.9                   # head center y
    # legs (swing)
    lw=w*0.11; lh=h*0.20
    p.append(f'<rect x="{midx-bw*0.42-lw/2+swing:.1f}" y="{by+bh-2:.1f}" width="{lw:.1f}" height="{lh:.1f}" rx="3" fill="{BOT}"/>')
    p.append(f'<rect x="{midx+bw*0.42-lw/2-swing:.1f}" y="{by+bh-2:.1f}" width="{lw:.1f}" height="{lh:.1f}" rx="3" fill="{BOT}"/>')
    # shoes
    p.append(f'<rect x="{midx-bw*0.42-lw/2+swing:.1f}" y="{by+bh+lh-6:.1f}" width="{lw:.1f}" height="{h*0.05:.1f}" rx="2" fill="{SHOE}"/>')
    p.append(f'<rect x="{midx+bw*0.42-lw/2-swing:.1f}" y="{by+bh+lh-6:.1f}" width="{lw:.1f}" height="{h*0.05:.1f}" rx="2" fill="{SHOE}"/>')
    # arms (swing opposite)
    aw=w*0.09; ah=h*0.22
    p.append(f'<rect x="{bx-aw*0.7:.1f}" y="{by+2:.1f}" width="{aw:.1f}" height="{ah:.1f}" rx="3" fill="{TOP}" transform="rotate({-swing*3:.1f} {bx:.1f} {by:.1f})"/>')
    p.append(f'<rect x="{bx+bw-aw*0.3:.1f}" y="{by+2:.1f}" width="{aw:.1f}" height="{ah:.1f}" rx="3" fill="{TOP}" transform="rotate({swing*3:.1f} {bx+bw:.1f} {by:.1f})"/>')
    # body (top / shirt)
    p.append(f'<rect x="{bx:.1f}" y="{by:.1f}" width="{bw:.1f}" height="{bh:.1f}" rx="5" fill="{TOP}"/>')
    # head
    p.append(f'<circle cx="{midx:.1f}" cy="{hy:.1f}" r="{hr:.1f}" fill="{SKIN}"/>')
    # hair + face by direction
    if direction=="down":
        p.append(f'<path d="M {midx-hr:.1f} {hy:.1f} A {hr:.1f} {hr:.1f} 0 0 1 {midx+hr:.1f} {hy:.1f} L {midx+hr:.1f} {hy-hr*0.3:.1f} L {midx-hr:.1f} {hy-hr*0.3:.1f} Z" fill="{HAIR}"/>')
        p.append(f'<circle cx="{midx-hr*0.4:.1f}" cy="{hy+hr*0.2:.1f}" r="{hr*0.12:.1f}" fill="{C_TXT}"/>')
        p.append(f'<circle cx="{midx+hr*0.4:.1f}" cy="{hy+hr*0.2:.1f}" r="{hr*0.12:.1f}" fill="{C_TXT}"/>')
    elif direction=="up":
        p.append(f'<circle cx="{midx:.1f}" cy="{hy:.1f}" r="{hr:.1f}" fill="{HAIR}"/>')  # back of head = hair
    elif direction=="left":
        p.append(f'<path d="M {midx-hr:.1f} {hy:.1f} A {hr:.1f} {hr:.1f} 0 0 1 {midx+hr:.1f} {hy:.1f} L {midx+hr:.1f} {hy-hr*0.3:.1f} L {midx-hr:.1f} {hy-hr*0.3:.1f} Z" fill="{HAIR}"/>')
        p.append(f'<circle cx="{midx-hr*0.5:.1f}" cy="{hy+hr*0.2:.1f}" r="{hr*0.12:.1f}" fill="{C_TXT}"/>')
    elif direction=="right":
        p.append(f'<path d="M {midx-hr:.1f} {hy:.1f} A {hr:.1f} {hr:.1f} 0 0 1 {midx+hr:.1f} {hy:.1f} L {midx+hr:.1f} {hy-hr*0.3:.1f} L {midx-hr:.1f} {hy-hr*0.3:.1f} Z" fill="{HAIR}"/>')
        p.append(f'<circle cx="{midx+hr*0.5:.1f}" cy="{hy+hr*0.2:.1f}" r="{hr*0.12:.1f}" fill="{C_TXT}"/>')
    return "".join(p), (midx, footy)

DIRS=[("down","▼ down"),("up","▲ up"),("left","◄ left"),("right","► right (flip ของ left)")]
FRAMES=["idle","walk-1","walk-2","walk-3","walk-4"]
SWING=[0, 6, 0, -6, 0]

def render():
    PAD=28; parts=[]
    CW=118; CH=140   # cell
    grid_x=PAD+150; grid_y=150
    W=grid_x+len(FRAMES)*CW+PAD+40
    # title
    parts.append(f'<text x="{PAD}" y="44" font-size="26" font-weight="700" fill="{C_TXT}">NexSpace — Avatar Spritesheet Layout</text>')
    parts.append(f'<text x="{PAD}" y="70" font-size="13" fill="{C_SUB}">Layered sprite · frame 32×48px (draw @2x = 64×96) · row = ทิศ · column = เฟรม · foot pivot = ล่างกึ่งกลาง</text>')
    parts.append(f'<text x="{PAD}" y="120" font-size="17" font-weight="700" fill="{C_ACCENT}">1 · Frame grid (ต่อ 1 layer — ทุก layer ใช้ grid นี้เป๊ะกัน)</text>')
    # column headers
    for c,fn in enumerate(FRAMES):
        parts.append(f'<text x="{grid_x+c*CW+CW/2:.0f}" y="{grid_y-8}" font-size="12.5" font-weight="600" text-anchor="middle" fill="{C_TXT}">{fn}</text>')
    # rows
    for r,(d,label) in enumerate(DIRS):
        ry=grid_y+r*CH
        parts.append(f'<text x="{PAD}" y="{ry+CH/2:.0f}" font-size="13.5" font-weight="600" fill="{C_TXT}">{esc(label)}</text>')
        for c,fn in enumerate(FRAMES):
            gx=grid_x+c*CW;
            parts.append(f'<rect x="{gx}" y="{ry}" width="{CW-6}" height="{CH-6}" rx="8" fill="{C_CARD}" stroke="{C_CARD_S}"/>')
            # 32x48 proportion guide inside cell (light)
            fw=(CW-6)*0.5; fh=fw*1.5
            fx=gx+((CW-6)-fw)/2; fy=ry+((CH-6)-fh)/2-4
            parts.append(f'<rect x="{fx:.1f}" y="{fy:.1f}" width="{fw:.1f}" height="{fh:.1f}" rx="2" fill="none" stroke="{GRID}" stroke-dasharray="3 3"/>')
            svg_c,(pvx,pvy)=character(gx, ry, CW-6, CH-6, d, SWING[c])
            parts.append(svg_c)
            # pivot cross
            parts.append(f'<line x1="{pvx-6:.1f}" y1="{pvy:.1f}" x2="{pvx+6:.1f}" y2="{pvy:.1f}" stroke="{PIVOT}" stroke-width="1.5"/>'
                         f'<line x1="{pvx:.1f}" y1="{pvy-6:.1f}" x2="{pvx:.1f}" y2="{pvy+6:.1f}" stroke="{PIVOT}" stroke-width="1.5"/>')
    grid_bottom=grid_y+len(DIRS)*CH

    # ---- section 2: layer stack ----
    sy=grid_bottom+30
    parts.append(f'<text x="{PAD}" y="{sy}" font-size="17" font-weight="700" fill="{C_ACCENT}">2 · Layer stack (ลำดับวาด ล่าง→บน)</text>')
    layers=[("0 · Body / สีผิว",SKIN),("1 · Hair (back)",HAIR),("2 · Top / เสื้อ",TOP),
            ("3 · Bottom / กางเกง",BOT),("4 · Shoes",SHOE),("5 · Hair (front)",HAIR),("6 · Accessory",C_ACCENT)]
    ly=sy+16
    for i,(nm,col) in enumerate(layers):
        yy=ly+i*30
        parts.append(f'<rect x="{PAD}" y="{yy}" width="18" height="18" rx="3" fill="{col}" stroke="{C_CARD_S}"/>')
        parts.append(f'<text x="{PAD+28}" y="{yy+14}" font-size="13" fill="{C_TXT}">{esc(nm)}</text>')
        if i<len(layers)-1:
            parts.append(f'<text x="{PAD+6}" y="{yy+30}" font-size="12" fill="{C_SUB}">↓</text>')
    # composed result preview
    rx=PAD+230; ry2=sy+10
    parts.append(f'<text x="{rx}" y="{ry2+4}" font-size="13" font-weight="600" fill="{C_SUB}">= composed</text>')
    parts.append(f'<rect x="{rx}" y="{ry2+12}" width="120" height="150" rx="10" fill="{C_CARD}" stroke="{C_CARD_S}"/>')
    cc,(pvx,pvy)=character(rx, ry2+12, 120, 150, "down", 0)
    parts.append(cc)
    parts.append(f'<line x1="{pvx-6:.1f}" y1="{pvy:.1f}" x2="{pvx+6:.1f}" y2="{pvy:.1f}" stroke="{PIVOT}" stroke-width="1.5"/>'
                 f'<line x1="{pvx:.1f}" y1="{pvy-6:.1f}" x2="{pvx:.1f}" y2="{pvy+6:.1f}" stroke="{PIVOT}" stroke-width="1.5"/>')

    # ---- section 3: pivot guide ----
    gx3=rx+200; gy3=sy+16
    parts.append(f'<text x="{gx3}" y="{sy}" font-size="17" font-weight="700" fill="{C_ACCENT}">3 · Pivot / alignment guide</text>')
    # big single frame 32x48 scaled
    scale=3.0; fw=32*scale; fh=48*scale
    bx=gx3; by=gy3+10
    parts.append(f'<rect x="{bx}" y="{by}" width="{fw}" height="{fh}" fill="#faf8f3" stroke="{C_ACCENT}" stroke-width="1.5"/>')
    # 32px foot tile marker (bottom 32x32)
    parts.append(f'<rect x="{bx}" y="{by+fh-32*scale}" width="{fw}" height="{32*scale}" fill="none" stroke="{GRID}" stroke-dasharray="4 3"/>')
    cc2,(pvx,pvy)=character(bx, by, fw, fh, "down", 0)
    parts.append(cc2)
    parts.append(f'<line x1="{pvx-9:.1f}" y1="{pvy:.1f}" x2="{pvx+9:.1f}" y2="{pvy:.1f}" stroke="{PIVOT}" stroke-width="2"/>'
                 f'<line x1="{pvx:.1f}" y1="{pvy-9:.1f}" x2="{pvx:.1f}" y2="{pvy+9:.1f}" stroke="{PIVOT}" stroke-width="2"/>')
    parts.append(f'<text x="{bx+fw+12}" y="{by+16}" font-size="12" fill="{C_SUB}">32 × 48 px frame</text>')
    parts.append(f'<text x="{bx+fw+12}" y="{by+36}" font-size="12" fill="{C_SUB}">(@2x = 64 × 96)</text>')
    parts.append(f'<text x="{bx+fw+12}" y="{by+fh-38:.0f}" font-size="12" fill="{C_SUB}">กล่องประ = footprint</text>')
    parts.append(f'<text x="{bx+fw+12}" y="{by+fh-22:.0f}" font-size="12" fill="{C_SUB}">1 tile (32px) ที่ยืน</text>')
    parts.append(f'<text x="{bx+fw+12}" y="{by+fh-2:.0f}" font-size="12" fill="{PIVOT}">✚ pivot = เท้า (ล่างกึ่งกลาง)</text>')
    parts.append(f'<text x="{gx3}" y="{by+fh+26:.0f}" font-size="12" fill="{C_TXT}">ทุก layer วาง pivot จุดนี้เป๊ะ → ซ้อนกันไม่เหลื่อม · หัวโผล่เหนือ tile ที่ยืน = ดูมีมิติ</text>')

    total_h=max(by+fh+50, ly+len(layers)*30+30)
    svg=(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{total_h:.0f}" '
         f'viewBox="0 0 {W} {total_h:.0f}" font-family="Segoe UI, Arial, sans-serif">'
         f'<rect width="{W}" height="{total_h:.0f}" fill="{C_SHEET}"/>'+"".join(parts)+'</svg>')
    return svg

out=sys.argv[1] if len(sys.argv)>1 else "."
os.makedirs(out,exist_ok=True)
with open(os.path.join(out,"avatar-spritesheet-layout.svg"),"w",encoding="utf-8") as f:
    f.write(render())
