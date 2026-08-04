# -*- coding: utf-8 -*-
"""Parse LPC sheet_definitions + palette_definitions -> apps/web/public/lpc/catalog.json.

- male + female base (body + human head + neutral face).
- Categories map LPC type_name -> Gather-style editor tabs.
- Each item lists: material (for recolor), which body types it supports,
  and layer(s) {z, male, female} sheet paths under /lpc/spritesheets/.
- Bundles the ulpc recolor palettes (with each material's base ramp) so the
  client can recolor sprites in real time.
"""
import json, glob, os

HERE = os.path.dirname(os.path.abspath(__file__))
DEFS = os.path.join(HERE, "sheet_definitions")
PALS = os.path.join(HERE, "palette_definitions")
SHEETS = os.path.abspath(os.path.join(HERE, "..", "..", "apps", "web", "public", "lpc", "spritesheets"))
OUT = os.path.abspath(os.path.join(HERE, "..", "..", "apps", "web", "public", "lpc", "catalog.json"))

BODYTYPES = ["male", "female"]

# type_name -> (category key, label). One tab can pull several type_names.
CATS = [
    ("skin",    "ผิว",         []),            # color-only tab (body palette)
    ("eyes",    "ตา",          []),            # color-only tab (eye palette)
    ("hair",    "ผม",          ["hair"]),
    ("facial",  "หนวด/เครา",   ["beard", "mustache"]),
    ("top",     "เสื้อ",        ["clothes"]),
    ("jacket",  "แจ็กเก็ต",     ["jacket", "vest"]),
    ("bottom",  "กางเกง",       ["legs"]),
    ("shoes",   "รองเท้า",      ["shoes"]),
    ("hat",     "หมวก",         ["hat"]),
    ("glasses", "แว่น",         ["facial_eyes"]),
    ("other",   "อื่นๆ",        ["accessory", "cape", "necklace", "earrings"]),
]
TYPE2CAT = {tn: key for key, _lbl, tns in CATS for tn in tns}


def load(f):
    try:
        return json.load(open(f, encoding="utf-8"))
    except Exception:
        return None


def layer_path(v, bt, head="male"):
    """sprite path for a given body type from a layer dict (None if unavailable)."""
    p = v.get(bt) or v.get("adult")
    if not p:
        return None
    return p.replace("${head}", head).rstrip("/")


def item_layers(d):
    """all layer_N -> {z, male, female}; requires walk.png to exist for a body type."""
    out = []
    for k, v in d.items():
        if not (k.startswith("layer_") and isinstance(v, dict) and "zPos" in v):
            continue
        entry = {"z": v["zPos"]}
        for bt in BODYTYPES:
            p = layer_path(v, bt, head=bt)
            if p and os.path.isfile(os.path.join(SHEETS, p.replace("/", os.sep), "walk.png")):
                entry[bt] = p
        if any(bt in entry for bt in BODYTYPES):
            out.append(entry)
    out.sort(key=lambda x: x["z"])
    return out


def find_exact(type_name, name):
    for f in glob.glob(os.path.join(DEFS, "**", "*.json"), recursive=True):
        if os.path.basename(f).startswith("meta"):
            continue
        d = load(f)
        if d and d.get("type_name") == type_name and d.get("name", "").strip() == name:
            return d
    return None


# --- base per body type (always composited): body + human head + neutral face ---
HEAD_NAME = {"male": "Human Male", "female": "Human Female"}
body_def = find_exact("body", "Body Color")
face_def = find_exact("expression", "Neutral")
base = {bt: [] for bt in BODYTYPES}
for bt in BODYTYPES:
    defs = [body_def, find_exact("head", HEAD_NAME[bt]), face_def]
    for d in defs:
        if not d:
            continue
        for l in item_layers(d):
            if bt in l:
                base[bt].append({"z": l["z"], "sheet": l[bt], "material": "body"})
    base[bt].sort(key=lambda x: x["z"])

# --- categories ---
cats_out = []
counts = {}
for key, label, _tns in CATS:
    items = []
    if key not in ("skin", "eyes"):
        for f in sorted(glob.glob(os.path.join(DEFS, "**", "*.json"), recursive=True)):
            b = os.path.basename(f)
            if b.startswith("meta"):
                continue
            d = load(f)
            if not d or TYPE2CAT.get(d.get("type_name")) != key:
                continue
            if "walk" not in (d.get("animations") or []):
                continue
            layers = item_layers(d)
            if not layers:
                continue
            support = sorted({bt for l in layers for bt in BODYTYPES if bt in l})
            items.append({
                "id": os.path.splitext(b)[0],
                "name": d.get("name", os.path.splitext(b)[0]),
                "material": (d.get("recolors") or {}).get("material"),
                "bodyTypes": support,
                "layers": layers,
            })
        seen = set(); uniq = []
        for it in items:
            if it["id"] in seen:
                continue
            seen.add(it["id"]); uniq.append(it)
        items = uniq
    counts[key] = len(items)
    cat_mat = {"skin": "body", "eyes": "eye"}.get(key)
    cats_out.append({"key": key, "label": label, "material": cat_mat, "items": items})

# --- palette bundle (ulpc ramps + each material's base ramp) ---
materials = {}
for mat in ["hair", "cloth", "body", "eye"]:
    meta = load(os.path.join(PALS, mat, f"meta_{mat}.json")) or {}
    colors = load(os.path.join(PALS, mat, f"{mat}_ulpc.json")) or {}
    materials[mat] = {"base": meta.get("base"), "colors": colors}

catalog = {
    "grid": 64, "walkCols": 9, "anim": "walk",
    "rowByDir": {"north": 0, "west": 1, "south": 2, "east": 3},
    "spriteBase": "/lpc/spritesheets",
    "materials": materials,
    "base": base,
    "categories": cats_out,
}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(catalog, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("category counts:", counts)
print("materials:", {m: len(materials[m]["colors"]) for m in materials}, "base:", {m: materials[m]["base"] for m in materials})
