# -*- coding: utf-8 -*-
"""Build walk spritesheets for avatars 3-7 from individual PNG frames.

These avatars store walk frames as individual PNGs:
  animations/Walking/<direction>/frame_000.png ... frame_007.png

Output: player-walk-{N}.png  (8 rows x 8 frames per direction)
Rows order: down, up, left, right, down-right, down-left, up-right, up-left
Also generates avatar{N}.png previews (south-facing static) for character select.
"""
import os
import sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
WEB_ASSETS = os.path.abspath(os.path.join(HERE, "..", "..", "apps", "web", "public", "assets"))

# Direction mapping: game-facing -> folder name in Walking/
DIR_MAP = [
    ("down", "south"),
    ("up", "north"),
    ("left", "west"),
    ("right", "east"),
    ("down-right", "south-east"),
    ("down-left", "south-west"),
    ("up-right", "north-east"),
    ("up-left", "north-west"),
]


def load_frames(base_dir, direction_folder, max_frames=8):
    """Load individual PNG frames for a direction."""
    d = os.path.join(base_dir, "animations", "Walking", direction_folder)
    frames = []
    for i in range(max_frames):
        p = os.path.join(d, f"frame_{i:03d}.png")
        if not os.path.exists(p):
            break
        frames.append(Image.open(p).convert("RGBA"))
    return frames


def build_spritesheet(char_dir, rotation_id):
    """Build a walk spritesheet and avatar preview for one rotation."""
    base = os.path.join(HERE, char_dir)
    
    # Load all frames per direction
    all_frames = {}
    for _, dir_name in DIR_MAP:
        fs = load_frames(base, dir_name)
        if not fs:
            print(f"  WARNING: no frames found for {dir_name} in {char_dir}")
            return None
        all_frames[dir_name] = fs
    
    NF = min(len(v) for v in all_frames.values())
    print(f"  {char_dir}: {NF} frames/direction, {len(DIR_MAP)} directions")
    
    # Compute shared union bbox across ALL frames for consistent alignment
    union = None
    for _, dir_name in DIR_MAP:
        for f in all_frames[dir_name][:NF]:
            b = f.getbbox()
            if b is None:
                continue
            union = b if union is None else (
                min(union[0], b[0]), min(union[1], b[1]),
                max(union[2], b[2]), max(union[3], b[3]))
    
    if union is None:
        print(f"  ERROR: all frames empty for {char_dir}")
        return None
    
    PAD = 2
    x0, y0, x1, y1 = union
    x0 = max(0, x0 - PAD)
    y0 = max(0, y0 - PAD)
    x1 += PAD
    y1 += PAD
    FW, FH = x1 - x0, y1 - y0
    
    # Build walk spritesheet
    sheet = Image.new("RGBA", (FW * NF, FH * len(DIR_MAP)), (0, 0, 0, 0))
    for row, (_, dir_name) in enumerate(DIR_MAP):
        for col in range(NF):
            crop = all_frames[dir_name][col].crop((x0, y0, x1, y1))
            sheet.paste(crop, (col * FW, row * FH), crop)
    
    walk_name = f"player-walk-{rotation_id}.png"
    sheet.save(os.path.join(HERE, walk_name))
    sheet.save(os.path.join(WEB_ASSETS, walk_name))
    print(f"  -> {walk_name}: {sheet.size} (frame={FW}x{FH}, {NF} frames/dir)")
    
    # Build static avatar preview (south-facing, first frame)
    south_static = Image.open(os.path.join(base, "south.png")).convert("RGBA")
    bbox = south_static.getbbox()
    if bbox:
        south_static = south_static.crop(bbox)
    avatar_name = f"avatar{rotation_id}.png"
    south_static.save(os.path.join(WEB_ASSETS, avatar_name))
    print(f"  -> {avatar_name}: {south_static.size}")
    
    return {"fw": FW, "fh": FH, "nf": NF}


def main():
    os.makedirs(WEB_ASSETS, exist_ok=True)
    
    # Avatar 3-7 = rotations-3 to rotations-7
    for rot_id in range(3, 8):
        char_dir = f"rotations-{rot_id}"
        print(f"\nBuilding avatar {rot_id} ({char_dir})...")
        info = build_spritesheet(char_dir, rot_id)
        if info:
            print(f"  [OK] Done! frame size: {info['fw']}x{info['fh']}")
        else:
            print(f"  [FAIL] Failed!")


if __name__ == "__main__":
    main()
