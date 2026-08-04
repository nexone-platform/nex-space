# 02b — Base Tileset & Prefab Spec — สเปกพื้น เฟอร์นิเจอร์ และห้องสำเร็จรูป

ใช้คู่กับภาพอ้างอิง:
> 🖼️ [`assets/tilesets/_spec/base-tileset-atlas.svg`](../assets/tilesets/_spec/base-tileset-atlas.svg) — floor + furniture catalog
> 🖼️ [`assets/tilesets/_spec/prefab-rooms.svg`](../assets/tilesets/_spec/prefab-rooms.svg) — ตัวอย่าง prefab 3 ห้อง
> 🛠️ [`assets/tilesets/_spec/gen_base_atlas.py`](../assets/tilesets/_spec/gen_base_atlas.py) — แก้รายการ/สีแล้ว regenerate

---

## 1. แยก 2 ชนิด tileset (สำคัญ)

| ชนิด | ใช้กับ | รูปแบบใน Tiled | วางบน layer |
|------|-------|----------------|-------------|
| **Uniform tile-grid** | พื้น (floor), ผนัง | tileset 32×32 ปกติ | `Floor`, `FloorDecor`, `Walls` |
| **Collection of Images** | เฟอร์นิเจอร์/ของตกแต่ง | แต่ละชิ้นเป็นรูปขนาดอิสระ | `Objects` (object layer) |

> ทำไมเฟอร์นิเจอร์เป็น "Collection of Images"? เพราะเฟอร์นิเจอร์มีขนาดไม่เท่ากัน (โต๊ะ 2×1, โซฟา 2×2, จอ 2×1) การเก็บเป็นสไปรต์อิสระแล้ววางเป็น object ยืดหยุ่นกว่าการหั่นเป็น tile 32px + ใส่ custom property (collision, layer, dir) ต่อชิ้นได้ตรง ๆ

---

## 2. Floor tiles (10 แบบเริ่มต้น · 1×1 · uniform 32px)

`floor-light`, `floor-warm`, `wood-plank`, `carpet-gray`, `carpet-teal`, `marble`, `concrete`, `grass`, `tile-checker`, `carpet-blue`

**กติกาวาด:**
- เรียบ สะอาด texture ต่ำ (noise เบา ๆ พอ ไม่ลายจนตาลาย)
- **tileable ทุกทิศ** — วางต่อกันต้องไม่เห็นรอยซ้ำชัด (ทดสอบด้วยการปูเต็มพื้นที่)
- โทนสว่างกว่าเฟอร์นิเจอร์ เพื่อให้ตัวละคร/ของเด่น
- (option) ทำ transition/edge tile ระหว่างพื้นต่างชนิดภายหลัง

---

## 3. Furniture catalog (25 ชิ้น MVP)

อ่านจากภาพ: กรอบ **สีส้ม = collides** (กันชน), **สีเขียวประ = walkable** (เดินผ่าน/นั่งได้), ตัวเลข = footprint (tile), `×N dir` = ต้องวาดหลายทิศ

| หมวด | ชิ้น (footprint · collision · ทิศ) |
|------|-----------------------------------|
| **Work** | desk (2×1·🟥), desk-L (2×2·🟥·×4), office-chair (1×1·🟩·×4), stool (1×1·🟩), filing-cabinet (1×1·🟥), bookshelf (2×1·🟥) |
| **Meeting** | meeting-table-long (4×2·🟥), meeting-table-round (2×2·🟥), whiteboard (2×1·🟥), presentation-screen (2×1·🟥 — เป็นจอแชร์ได้) |
| **Lounge** | sofa-2seat (2×1·🟥·×4), sofa-corner (2×2·🟥·×4), armchair (1×1·🟥·×4), coffee-table (2×1·🟥), rug-2×2 (2×2·🟩), plant-tall (1×2·🟥) |
| **Pantry** | counter (2×1·🟥), fridge (1×2·🟥), coffee-machine (1×1·🟥), water-cooler (1×1·🟥), bar-table (1×1·🟥) |
| **Decor** | reception-desk (3×1·🟥), plant-small (1×1·🟩), floor-lamp (1×1·🟥), wall-art (1×1·🟩) |

### custom property ต่อชิ้น (ตั้งใน Tiled tile properties)
| property | ชนิด | ความหมาย |
|----------|------|----------|
| `collides` | bool | เป็นกันชนไหม |
| `layer` | string | `objects` (ปกติ) หรือ `above` (ต้องวาดทับตัวละคร เช่น plant-tall ส่วนบน) |
| `interact` | string? | ถ้ากดโต้ตอบได้ เช่น `whiteboard`, `screen`, `seat` |
| `dir` | string? | สำหรับของที่มีทิศ / เก้าอี้ (บอกทิศที่นั่งหันไป) |
| `anchor` | string | จุดอ้างอิงวาง (`bottom` แนะนำ เพื่อ y-sort ถูก) |

### กติกาวาดเฟอร์นิเจอร์
1. **origin/anchor = ขอบล่างกึ่งกลาง** ให้ y-sort (เดินหน้า-หลัง) ถูกต้อง
2. ของสูง (fridge, plant-tall, bookshelf) วาดส่วนบนให้เผื่อ "ทับตัวละคร" ได้ → ตั้ง `layer=above` เฉพาะส่วนยอด หรือแยกเป็น 2 ชิ้น
3. เงาใต้ของ = เงานุ่มทิศเดียว (สอดคล้อง palette แสงบน-ซ้าย)
4. ของที่มีทิศ (โซฟา/เก้าอี้/โต๊ะ L) วาดครบตามจำนวน `×N dir` (right = flip ของ left ได้)
5. footprint ที่ระบุ = พื้นที่ collision จริง (ส่วนภาพยื่นเกินได้ถ้าเป็น `above`)

---

## 4. Prefab Rooms (ห้องสำเร็จรูป)

ดูภาพ `prefab-rooms.svg` — ตัวอย่าง 3 ห้องประกอบจาก catalog ข้างบน:

| Prefab | Grid | ประกอบด้วย | Meta ที่ฝังมาด้วย |
|--------|------|-----------|-------------------|
| **desk-cluster-4** | 6×5 | desk ×4 + เก้าอี้ + plant | (ไม่มี zone — เป็นพื้นที่ทำงานเปิด) |
| **meeting-room-8** | 8×6 | ผนังกระจกล้อม + โต๊ะยาว + เก้าอี้ 8 + จอ | `MeetingRoom` zone + `ScreenShare` (screenTargetId → จอ) |
| **lounge-corner** | 6×5 | โซฟา corner + 2seat + coffee-table + rug + plant | `PrivateZone` |

### วิธีทำ prefab (Tiled Object Template `.tx`)
1. จัดวางเฟอร์นิเจอร์ (+ ผนัง + Meta object) ในแมพให้ครบชุด
2. เลือกทั้งกลุ่ม → คลิกขวา → **Save As Template** → `templates/meeting-room-8.tx`
3. ครั้งต่อไปลาก template จาก panel มาวาง = ได้ทั้งภาพ + zone/collision ครบ
4. แก้ไฟล์ `.tx` ต้นทาง = อัปเดตทุกที่ที่ใช้

### กติกา prefab ให้ประกอบต่อกันได้ (modular)
- ขนาดเป็นจำนวนเต็ม tile, snap grid เสมอ
- ผนัง/ประตูที่ขอบอยู่ตำแหน่งมาตรฐาน (ประตูกึ่งกลางด้าน) เพื่อต่อกับทางเดิน
- รวม `Meta` object (zone/spawn/screen) ไว้ในตัว prefab

---

## 5. Checklist ส่งมอบ
- [ ] `floor.png/.tsx` — floor 10 แบบ (uniform 32px, tileable, @2x)
- [ ] `furniture.tsx` — Collection of Images 25 ชิ้น + custom property ครบ (collides/layer/anchor/dir)
- [ ] ของมีทิศวาดครบ (chair/sofa/armchair/desk-L)
- [ ] `templates/*.tx` — prefab ≥ 7 ชุด (เริ่มจาก 3 ในภาพ + reception, pantry, focus-booth, stage)
- [ ] ทดสอบวาง prefab หลายชุด → y-sort ถูก, ตัวละครเดินหน้า-หลังของสมเหตุผล
