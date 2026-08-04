# -*- coding: utf-8 -*-
"""Batch-process a dump of PixelLab sprites (_incoming/*.png):
  1. key out any leftover magenta -> transparent
  2. cluster near-duplicate sprites together (dedup aid)
  3. rough-classify FILL (floor/tile) vs SPRITE (object) by alpha coverage
  4. write cleaned PNGs + a grouped, numbered contact sheet for manual picking
Outputs:
  _cleaned/NN.png            cleaned 32x32 transparent sprites
  _contact-sheet-all.png     numbered, cluster-grouped review sheet
  _report.txt                clusters + flags
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
    """return RGBA with magenta-ish pixels made transparent + flag if any removed."""
    im = im.convert("RGBA")
    a = np.asarray(im).astype(np.int16)
    R, G, B, A = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    mag = (R > 175) & (B > 175) & (G < 130) & ((R - G) > 55) & ((B - G) > 55)
    had = bool(mag.any())
    A2 = np.where(mag, 0, A).astype(np.uint8)
    out = np.dstack([a[..., :3].astype(np.uint8), A2])
    return Image.fromarray(out, "RGBA"), had

def feat(im):
    """16x16 RGB feature (transparent -> mid gray) for similarity."""
    s = im.resize((16, 16), Image.BILINEAR)
    a = np.asarray(s).astype(np.float32)
    rgb, al = a[..., :3], a[..., 3:4] / 255.0
    return (rgb * al + 128 * (1 - al)).reshape(-1)

def coverage_stats(im):
    a = np.asarray(im)
    al = a[..., 3] > 20
    cov = al.mean()
    border = np.concatenate([al[0, :], al[-1, :], al[:, 0], al[:, -1]])
    return cov, border.mean()

sprites = []  # dict per file
for p in files:
    im0 = Image.open(p)
    im, had = key_magenta(im0)
    name = os.path.splitext(os.path.basename(p))[0]
    im.save(os.path.join(HERE, "_cleaned", name + ".png"))
    cov, bcov = coverage_stats(im)
    kind = "FILL" if (cov > 0.9 and bcov > 0.8) else "sprite"
    sprites.append({"name": name, "img": im, "feat": feat(im),
                    "magenta": had, "cov": cov, "kind": kind})

# ---- greedy similarity clustering ----
THRESH = 16.0
clusters = []  # list of {rep_feat, members[idx]}
order_cluster = [0] * len(sprites)
for i, s in enumerate(sprites):
    best, bestd = -1, 1e9
    for ci, c in enumerate(clusters):
        d = np.abs(s["feat"] - c["rep"]).mean()
        if d < bestd:
            bestd, best = d, ci
    if best >= 0 and bestd < THRESH:
        clusters[best]["members"].append(i)
        order_cluster[i] = best
    else:
        clusters.append({"rep": s["feat"], "members": [i]})
        order_cluster[i] = len(clusters) - 1

# order sprites grouped by cluster (largest clusters first)
cl_sorted = sorted(range(len(clusters)), key=lambda k: -len(clusters[k]["members"]))
ordered = []
for rank, ci in enumerate(cl_sorted):
    for idx in clusters[ci]["members"]:
        ordered.append((idx, rank))

# ---- contact sheet ----
SC, T, COLS = 5, 32, 8
CW, CH = T * SC + 16, T * SC + 40
rows = (len(ordered) + COLS - 1) // COLS
sheet = Image.new("RGBA", (COLS * CW + 10, rows * CH + 50), (238, 231, 214, 255))
d = ImageDraw.Draw(sheet)
try:
    font = ImageFont.truetype("arial.ttf", 12); fb = ImageFont.truetype("arialbd.ttf", 13)
except Exception:
    font = fb = ImageFont.load_default()
CLUSTER_COLORS = [(43,157,144),(217,123,70),(120,120,200),(90,160,90),(200,90,140),
                  (150,110,60),(80,150,190),(180,160,60),(140,90,180),(90,170,150)]
d.text((12, 14), f"{len(sprites)} sprites  |  {len(clusters)} groups  |   same-color border = likely duplicates (keep 1 per group)",
       fill=(40, 40, 45, 255), font=fb)
for i, (idx, rank) in enumerate(ordered):
    s = sprites[idx]
    cx = 6 + (i % COLS) * CW; cy = 40 + (i // COLS) * CH
    col = CLUSTER_COLORS[rank % len(CLUSTER_COLORS)]
    d.rectangle([cx, cy, cx + CW - 8, cy + CH - 8], outline=col, width=3,
                fill=(250, 246, 236, 255))
    # checker
    ix, iy = cx + 8, cy + 8
    for yy in range(0, T * SC, 10):
        for xx in range(0, T * SC, 10):
            c = (221,221,226,255) if (xx//10+yy//10) % 2 else (245,245,250,255)
            d.rectangle([ix+xx, iy+yy, ix+xx+9, iy+yy+9], fill=c)
    sheet.alpha_composite(s["img"].resize((T*SC, T*SC), Image.NEAREST), (ix, iy))
    tag = f'#{s["name"]}  g{rank}'
    if s["magenta"]: tag += "  [M]"
    d.text((cx + 6, cy + CH - 28), tag, fill=(45,45,50,255), font=fb)
    d.text((cx + 6, cy + CH - 14), f'{s["kind"]} {int(s["cov"]*100)}%', fill=(140,133,120,255), font=font)
sheet.save(os.path.join(HERE, "_contact-sheet-all.png"))

# ---- report ----
with open(os.path.join(HERE, "_report.txt"), "w", encoding="utf-8") as f:
    f.write(f"{len(sprites)} sprites, {len(clusters)} groups\n")
    mg = [s["name"] for s in sprites if s["magenta"]]
    f.write(f"had magenta (cleaned): {', '.join(mg) or 'none'}\n\n")
    for rank, ci in enumerate(cl_sorted):
        mem = [sprites[m]["name"] for m in clusters[ci]["members"]]
        f.write(f"group {rank} ({len(mem)}): {', '.join(mem)}\n")

print(f"{len(sprites)} sprites | {len(clusters)} groups | magenta cleaned: {sum(s['magenta'] for s in sprites)}")
for rank, ci in enumerate(cl_sorted):
    mem = [sprites[m]["name"] for m in clusters[ci]["members"]]
    print(f"  group {rank:2d} ({len(mem):2d}): {', '.join(mem)}")
