# NexSpace — Map & Asset Style Guide (Gather-Town look)

เป้าหมาย: ทำให้แมพ NexSpace ดูสวย/คุมโทนแบบ Gather Town โดยใช้ **PixelLab** สร้าง asset
เอกสารนี้เป็น "แหล่งความจริงเดียว" สำหรับสไตล์ + prompt + วิธีเอา asset เข้าโปรเจกต์

ปัจจุบัน: แมพ `20×15` tile (`TILE=32px`) วางเฟอร์นิเจอร์ด้วย array ใน
`apps/web/src/scenes/OfficeScene.ts` — asset อยู่ที่ `apps/web/public/assets/`

---

## 1. หลักการที่ทำให้ "ดูเหมือน Gather"

1. **สไตล์เดียวทั้งแมพ** (สำคัญที่สุด) — มุมมองเดียว, แสงทิศเดียว, พาเลตต์ชุดเดียว, เส้นขอบแบบเดียว
2. **กรอบด้วย outdoor** — หญ้า + ต้นไม้ + ทางเดินล้อมอาคาร
3. **โซนมีธีม** — แต่ละห้อง พื้น/ผนัง/เฟอร์นิเจอร์คนละแบบ
4. **ตกแต่งเป็นชั้น** — พรมใต้โซฟา, ต้นไม้มุมห้อง, รูปบนผนัง, props เล็กเยอะ ๆ
5. **เงา contact shadow** ใต้ของทุกชิ้น
6. **พื้นมีลาย/ขอบ** ไม่ใช่สีเรียบ

---

## 2. ระบบความคงเส้นคงวา (ต้องยึดทุกครั้งที่ gen)

### 2.1 Style suffix — ต่อท้าย prompt **ทุกอัน**
```
top-down 3/4 view, 32x32 pixel grid, soft pastel color palette,
clean thin outline, subtle shadow with light from top-left,
cozy modern office aesthetic, Gather Town style, transparent background
```

### 2.2 พาเลตต์อ้างอิง (คุมสีให้ทั้งแมพเป็นชุดเดียว)
- Walls teal (ของเดิม): `#2bb3a3` accent
- พื้น: cream `#f3e7ca`, wood อบอุ่น, carpet พาสเทล (ชมพู/มินต์/ฟ้า)
- Outdoor: หญ้าเขียวนุ่ม, หินเทาอ่อน
- โทนรวม: พาสเทล + คอนทราสต์ต่ำ (Gather ไม่ใช้สีจัด)

### 2.3 กฎขนาด (สำคัญมากสำหรับ pixel art)
| ประเภท | ขนาด gen | หมายเหตุ |
|---|---|---|
| พื้น / ผนัง (tile) | **32×32** | ต้อง **seamless tileable**, flat top-down |
| props เล็ก (เก้าอี้, ต้นไม้เล็ก, ของแขวน) | **32×32** | transparent bg |
| props ใหญ่ (โซฟา, ตู้, ต้นไม้ใหญ่, น้ำพุ) | **64×64** | วางคร่อม 2×2 tile |
| ของยาว (โต๊ะประชุม, เคาน์เตอร์) | **64×32** หรือ **96×32** | |

### 2.4 มุมมอง
- พื้น/ผนัง = flat top-down (มองตรงลงมา ไม่มี perspective)
- เฟอร์นิเจอร์/ตัวละคร = top-down 3/4 (เห็นด้านบน + ด้านหน้านิดหน่อย) — ให้ตรงกับของเดิม
- ของแขวนผนัง (รูป/นาฬิกา) = front-facing วางบน layer บนสุด

---

## 3. Asset ที่ต้องมี (target inventory)

เก็บไฟล์ตามโฟลเดอร์นี้ (ชื่อ = key ที่ใช้ในโค้ด/Tiled):

```
apps/web/public/assets/
├── floors/      พื้น (seamless)
├── tilesets/    atlas พื้น+ผนัง
├── furniture/   เฟอร์นิเจอร์ + props ตั้งพื้น
├── decor/       ของบนผนัง (windows/รูป/นาฬิกา)
└── outdoor/     ← โฟลเดอร์ใหม่: ต้นไม้/น้ำพุ/พุ่มไม้/ทางเดิน
```

ที่ยัง**ขาด**เทียบกับ Gather: outdoor ทั้งหมด, พื้นหลากหลาย (carpet/tile/หญ้า/ทางเดิน),
วอลเปเปอร์ตามธีม, ของแขวนผนัง, props cozy (โซฟาใหญ่, ชั้นหนังสือ, โคมไฟ, ชุดโต๊ะอาหาร, เตียง)

---

## 4. PixelLab Prompts (พร้อมก๊อป)

> ต่อท้ายทุกอันด้วย **Style suffix** (ข้อ 2.1) เสมอ
> พื้น/ผนัง เพิ่ม: `seamless tileable, flat top-down, no perspective` และตั้งขนาดตามตาราง 2.3

### A. พื้น floors — 32×32, seamless
```
1. seamless light oak wood plank floor tile
2. seamless cream marble tile floor with subtle grid lines
3. seamless soft pink carpet floor tile
4. seamless mint green carpet floor tile
5. seamless light blue carpet floor tile
6. seamless checkered diagonal lobby tile, beige and white
7. seamless grass ground tile, top-down, soft green
8. seamless stone path tile, light grey cobblestone
9. seamless dark wood floor tile (meeting room)
```

### B. ผนัง/วอลเปเปอร์ walls — 32×32, seamless (ทำ "fill" + "top edge" แยกถ้าได้)
```
10. interior wall, warm beige wallpaper with wooden baseboard
11. interior wall, soft pink wallpaper with white trim
12. interior wall, teal painted wall with baseboard
13. interior wall, light green wallpaper
14. interior wall, lavender purple wallpaper
15. exterior building wall, cream stucco with corner trim
```

### C. Outdoor — props 64×64 (บางอันใหญ่กว่า)
```
16. lush green tree with round canopy, top-down 3/4 view, soft ground shadow
17. tall pine tree, top-down 3/4 view
18. small round bush shrub, top-down
19. stone water fountain with blue water, octagonal base, top-down 3/4 view, centerpiece (128x128)
20. colorful potted flower planter, top-down
21. wooden park bench, top-down 3/4 view
22. outdoor lamp post with warm light, top-down 3/4 view
23. wooden welcome sign board, top-down 3/4 view
```

### D. พรม & ตัวแบ่งโซน — 64×64
```
24. round soft area rug, cream and grey pattern, top-down
25. rectangular striped rug, warm mustard tones, top-down
26. round rug, soft teal, top-down
27. indoor room divider partition, wood frame with frosted glass, top-down 3/4 view
```

### E. เฟอร์นิเจอร์ cozy — โซฟา/ตู้/เตียง 64×64, ที่เหลือ 32×32
```
28. cozy L-shaped lounge sofa, mustard yellow, top-down 3/4 view
29. two-seat sofa, soft teal fabric, top-down 3/4 view
30. tall wooden bookshelf filled with books and small plants, top-down 3/4 view
31. modern floor lamp with warm glow, top-down 3/4 view
32. dining table with four chairs, top-down 3/4 view
33. retro arcade cabinet game machine, top-down 3/4 view
34. single bed with pillow and cozy blanket, top-down 3/4 view
35. kitchen counter with sink and cabinets, top-down 3/4 view
36. large monstera plant in ceramic pot, top-down 3/4 view
37. office desk with dual monitors and desk lamp, top-down 3/4 view
38. small coffee side table with mug, top-down 3/4 view
```

### F. ของแขวนผนัง decor — 32×32, front-facing (วาง layer บนสุด)
```
39. framed landscape painting on wall, front-facing
40. framed abstract art poster, front-facing
41. round minimal wall clock, front-facing
42. corkboard with sticky notes and photos, front-facing
43. wall-mounted shelf with small plants and books, front-facing
44. soft neon wall sign with gentle glow, front-facing
45. arched interior window with plants on sill, front-facing
```

### G. ทางเดิน/รายละเอียดพื้น (optional) — 32×32
```
46. seamless entrance doormat tile, top-down
47. floor vent / manhole detail tile, top-down
48. rug runner strip, hallway, top-down
```

---

## 5. Workflow หลังได้ไฟล์จาก PixelLab

1. Export PNG (transparent bg) ขนาดตรงตามตาราง 2.3
2. ตั้งชื่อ **kebab-case** = key เช่น `sofa-l-mustard.png`, `tree-round.png`
3. วางลงโฟลเดอร์ให้ถูก (`furniture/`, `floors/`, `outdoor/`, `decor/`)
4. ลงทะเบียน:
   - แบบโค้ด (ปัจจุบัน): เพิ่มใน array `FURNITURE`/`DECOR` ใน `OfficeScene.ts`
   - แบบ Tiled (หลังตั้ง pipeline): เพิ่มเป็น tile ใน tileset แล้วลากวางใน Tiled
5. props ที่ต้อง "เดินชนได้" ตั้ง `solid=true`

**Checklist คุณภาพก่อนใช้:**
- [ ] เส้นขอบ/ความหนาเท่าของเดิม
- [ ] แสงมาทางบนซ้ายเหมือนกัน
- [ ] พื้น/ผนังต่อ tile แล้วไม่เห็นรอยต่อ
- [ ] พาเลตต์อยู่ในโทนพาสเทลเดียวกัน
- [ ] มีเงา contact shadow ใต้ของ

---

## 6. เลย์เอาต์แมพใหม่ที่แนะนำ (ขยาย + outdoor)

ขยายเป็น ~`40×30`, วางอาคารกลาง ล้อมด้วย outdoor ring:

```
┌──────── OUTDOOR: หญ้า + ต้นไม้ + ทางเดิน ────────┐
│  ┌── private ─┐ ┌ courtyard ┐ ┌── private ──┐   │
│  │ office 1   │ │  น้ำพู 🟦  │ │  office 2    │   │
│  ├────────────┴─┴───────────┴─┴──────────────┤   │
│  │  lounge(ชมพู)   โถงกลาง    meeting(เขียว)   │   │
│  │  โซฟา+พรม       reception   โต๊ะประชุม       │   │
│  ├──────────────┬─────────────┬───────────────┤   │
│  │ pantry(ไม้)   │ dining      │ game/art room │   │
│  └──────────────┴──── ประตูเข้า ───────────────┘   │
└──────────────────────────────────────────────────┘
```

หลักการวาง: 1 โซน = 1 พื้น + 1 ผนัง + เฟอร์นิเจอร์ธีมเดียว, ทางเดินกว้าง ≥2 tile,
ประตูเชื่อมโซน, ตกแต่งมุมห้องด้วยต้นไม้/ของแขวนเสมอ

---

## 7. Tiled pipeline (แผนโครงสร้าง layer)

ออกแบบใน **Tiled** (mapeditor.org, ฟรี) แล้ว export `.tmj` ไป `public/assets/maps/`
Phaser โหลดผ่าน `this.load.tilemapTiledJSON(...)`

Layer ที่ใช้ (ล่าง→บน):
| Layer | ชนิด | ใช้ tileset | หมายเหตุ |
|---|---|---|---|
| `floor` | tile | floors-atlas | พื้นทุกโซน + หญ้า |
| `walls` | tile | walls | ผนัง (autotile) |
| `decor-below` | object | furniture collection | พรม/ของวางพื้นใต้ตัวละคร |
| `furniture` | object | furniture collection | เฟอร์นิเจอร์ (มี prop `solid`) |
| `decor-above` | object | decor collection | รูป/หน้าต่าง วางทับผนัง |
| `collision` | object | – | สี่เหลี่ยมกันชน (นอกเหนือกำแพง) |
| `objects` | object | – | `spawn`, `interactive` (whiteboard/screen/portal) |

ข้อกำหนด object: ตั้ง `name` หรือ property `key` = ชื่อไฟล์ asset, property `dir` สำหรับเก้าอี้,
`solid` (bool), `type` สำหรับ interactive (`whiteboard`/`screen`/`portal`)

> pipeline นี้ทำให้ออกแบบแมพแบบลากวางใน Tiled เห็นผลทันที ไม่ต้องแก้โค้ด

---

## 7.5 เก้าอี้ (chairs) — PixelLab prompts

**ปัญหาปัจจุบัน:** `chair-1` … `chair-8` เป็นเก้าอี้ออฟฟิศสี teal ทรงเดียวกันหมด
ต่างกันแทบไม่เห็น ทำให้ห้องดูจำเจ → ชุดใหม่ต้องต่างกันที่ **ทรง (silhouette)** ก่อน
แล้วค่อยต่างที่สี

### ข้อกำหนดที่ต้องตรง (ไม่ตรงแล้วเก้าอี้จะวางในแผนที่ไม่ได้)

| หัวข้อ | ค่า |
|---|---|
| จำนวนทิศ | **8 ทิศ** — PixelLab ตั้ง `directions: 8` |
| ชื่อทิศ | `south, south-east, east, north-east, north, north-west, west, south-west` (PixelLab ตั้งชื่อแบบนี้อยู่แล้ว) |
| ขนาด | **32×32** — เท่าเก้าอี้เดิม (ถ้าใหญ่กว่านี้จะล้นโต๊ะและจุดนั่งเพี้ยน) |
| ชื่อไฟล์ปลายทาง | `chair-<เลข>-<ทิศ>.png` เช่น `chair-9-south.png` |
| โฟลเดอร์ | `apps/web/public/assets/furniture/` |
| พื้นหลัง | โปร่งใส |

> เก้าอี้ที่ **ไม่ต้องหมุน** (อาร์มแชร์/บีนแบ็ก/ม้านั่ง) ทำทิศเดียว (`south`) ขนาด 32×32
> หรือ 64×64 ถ้าเป็นตัวใหญ่ก็ได้ — ไม่ต้องเข้าระบบหมุน

### Style suffix — ต่อท้ายทุก prompt (เหมือนเดิมทั้งโปรเจกต์)
```
top-down 3/4 view, 32x32 pixel grid, soft pastel color palette,
clean thin outline, subtle shadow with light from top-left,
cozy modern office aesthetic, Gather Town style, transparent background
```

### A. เก้าอี้ทำงาน (หมุนได้ — ทำ 8 ทิศ, 32×32)
```
1.  ergonomic mesh office chair with black mesh back and five-star caster base, seat facing viewer
2.  executive high-back leather office chair, warm cognac brown, chrome base
3.  minimal office chair with light grey fabric seat and thin white frame
4.  office chair with mustard yellow cushioned seat and light wood legs
5.  office chair with dusty rose pink upholstered seat and matte black base
6.  office chair with sage green padded seat and slim brass legs
7.  transparent acrylic office chair with soft blue seat pad, modern
8.  gaming chair with black and red racing-style high back, on casters
```

### B. เก้าอี้ห้องประชุม / โต๊ะอาหาร (หมุนได้ — 8 ทิศ, 32×32)
```
9.  wooden dining chair, oak, vertical slat back, no wheels
10. scandinavian chair with beige woven seat and tapered light wood legs
11. clear-back conference chair, white shell with cream cushion
12. bentwood cafe chair, walnut brown, round back
```

### C. ที่นั่งชิลล์ (ทิศเดียว `south` ก็พอ — 32×32 หรือ 64×64)
```
13. cozy accent armchair with terracotta orange fabric and short wooden legs
14. round papasan lounge chair with cream cushion
15. small wooden bench with soft grey seat pad, two-seater
16. floor bean bag, deep teal, slouched
17. bar stool with round walnut seat and thin black metal legs
18. rocking chair, light wood with knitted throw over the back
```

### วิธีนำเข้าโปรเจกต์
1. PixelLab → export ชุด 8 ทิศ (ได้ `south.png`, `east.png`, …)
2. เปลี่ยนชื่อเป็น `chair-9-south.png`, `chair-9-east.png`, … (เลขไม่ซ้ำของเดิม)
3. วางที่ `apps/web/public/assets/furniture/`
4. เพิ่มเลขใหม่ใน `CHAIR_STYLES` ใน `apps/web/src/scenes/OfficeScene.ts`
   (โค้ดจะ preload ทุกทิศให้เอง และระบบคลิก-ลากหมุนใช้ได้ทันที)
5. เปลี่ยนเก้าอี้ในแมพโดยแก้ key ใน `FURNITURE` เช่น `chair-4-south` → `chair-9-south`

## 8. ลำดับแนะนำ

1. ✅ เอกสารนี้ (style guide + prompts)
2. Gen asset ชุด **outdoor + พื้น + วอลเปเปอร์** ก่อน (ได้ภาพรวม Gather เร็วสุด)
3. ตั้ง Tiled loader ในโค้ด (ทำคู่ขนานได้)
4. ออกแบบแมพใหม่ใน Tiled ตามข้อ 6
5. Gen เฟอร์นิเจอร์/ของแขวนเพิ่มเติมเติมรายละเอียด
