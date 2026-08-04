# -*- coding: utf-8 -*-
"""Key magenta from PixelLab wall pieces, infer each piece's edge-connectivity
(which of N/E/S/W the wall extends to), and render a labeled contact sheet.
Outputs: _cleaned/NN.png (magenta removed) + _contact.png
"""
import os, glob
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
files = sorted(glob.glob(os.path.join(HERE, "*.png")),
               key=lambda p: int(os.path.splitext(os.path.basename(p))[0])
               if os.path.splitext(os.path.basename(p))[0].isdigit() else 9999)
os.makedirs(os.path.join(HERE, "_cleaned"), exist_ok=True)

def key_magenta(im):
    a = np.asarray(im.convert("RGBA")).astype(np.int16)
    R, G, B, A = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    mag = (R > 175) & (B > 175) & (G < 130) & ((R - G) > 55) & ((B - G) > 55)
    A2 = np.where(mag, 0, A).astype(np.uint8)
    return Image.fromarray(np.dstack([a[..., :3].astype(np.uint8), A2]), "RGBA")

def edges(im):
    """return dict N/E/S/W True if wall reaches that edge (central band opaque)."""
    a = np.asarray(im)[..., 3]  # alpha
    T = a.shape[0]
    c0, c1 = T // 4, T - T // 4           # central band
    band = 3                               # outer pixels to test
    thr = 40
    def cov(strip): return (strip > thr).mean()
    return {
        "N": cov(a[0:band, c0:c1]) > 0.35,
        "S": cov(a[T-band:T, c0:c1]) > 0.35,
        "W": cov(a[c0:c1, 0:band]) > 0.35,
        "E": cov(a[c0:c1, T-band:T]) > 0.35,
    }

data = []
for p in files:
    name = os.path.splitext(os.path.basename(p))[0]
    im = key_magenta(Image.open(p))
    im.save(os.path.join(HERE, "_cleaned", name + ".png"))
    e = edges(im)
    code = "".join(d for d in ["N", "E", "S", "W"] if e[d]) or "·"
    cov = (np.asarray(im)[..., 3] > 40).mean()
    data.append((name, im, code, cov))

# contact sheet grouped by code
order = sorted(range(len(data)), key=lambda i: (len(data[i][2]) if data[i][2] != "·" else 9, data[i][2]))
SC, T, COLS = 5, 32, 8
CW, CH = 180, 200
rows = (len(data) + COLS - 1) // COLS
sheet = Image.new("RGBA", (COLS * CW + 10, rows * CH + 46), (238, 231, 214, 255))
d = ImageDraw.Draw(sheet)
try: fb = ImageFont.truetype("arialbd.ttf", 14); fn = ImageFont.truetype("arial.ttf", 12)
except Exception: fb = fn = ImageFont.load_default()
d.text((12, 14), f"{len(data)} wall pieces — inferred connect-edges (N/E/S/W the wall reaches)", fill=(40, 40, 45, 255), font=fb)
for slot, i in enumerate(order):
    name, im, code, cov = data[i]
    cx = 6 + (slot % COLS) * CW; cy = 40 + (slot // COLS) * CH
    d.rectangle([cx, cy, cx + CW - 8, cy + CH - 8], outline=(200, 193, 176, 255), width=1, fill=(250, 246, 236, 255))
    ix, iy = cx + (CW - 8 - T * SC) // 2, cy + 12
    for yy in range(0, T * SC, 10):
        for xx in range(0, T * SC, 10):
            c = (221,221,226,255) if (xx//10+yy//10) % 2 else (245,245,250,255)
            d.rectangle([ix+xx, iy+yy, ix+xx+9, iy+yy+9], fill=c)
    sheet.alpha_composite(im.resize((T*SC, T*SC), Image.NEAREST), (ix, iy))
    d.text((cx + 10, cy + CH - 30), f"#{name}", fill=(45,45,50,255), font=fb)
    d.text((cx + 60, cy + CH - 29), f"edges: {code}", fill=(43,120,110,255), font=fb)
    d.text((cx + 10, cy + CH - 15), f"fill {int(cov*100)}%", fill=(140,133,120,255), font=fn)
sheet.save(os.path.join(HERE, "_contact.png"))
# summary: how many per code
from collections import Counter
cnt = Counter(c for _, _, c, _ in data)
print("codes:", dict(cnt))
print("saved _contact.png + _cleaned/")
