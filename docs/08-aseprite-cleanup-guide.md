# 08 — Aseprite: Redraw/เก็บ asset ที่ 32px โดยใช้ full-res เป็นแบบ

คู่มือละเอียดสำหรับ STEP 6 ของ [07](07-asset-processing-workflow.md) — แปลง `cutouts/*.png` (ภาพ AI full-res)
ให้เป็น pixel art 32px ที่คมและใช้ในเกมได้จริง

> เมนู/คำอาจต่างเล็กน้อยตามเวอร์ชัน Aseprite · ถ้าใช้ฟรีทาง Photopea/GIMP ก็ทำแนวคิดเดียวกันได้ (reference layer + ดินสอ 1px)

---

## แนวคิดหลัก: ทำไมต้อง "redraw" ไม่ใช่ "ย่อ"
ย่อภาพ 660px → 32px ตรง ๆ = สีเลอะ ขอบฟุ้ง เพราะ 1 pixel ปลายทางต้องเฉลี่ยจาก ~20 pixel ต้นทาง
**วิธีที่ได้ผลดีสุด = วาดใหม่ที่ 32px โดยมีภาพ full-res เป็น "แบบร่าง" (reference) อยู่ข้างหลัง** แล้ว "ลอก" รูปทรง/สี/แสงเงาลงทีละ pixel

---

## PART 0 — ตั้งค่า Aseprite ครั้งเดียว (ทำครั้งแรกพอ)

1. **โหลด palette ของเกม**
   - หน้าต่าง Palette (ซ้ายล่าง) → ไอคอนเมนู ▾ → **Load Palette** → เลือก `assets/palette/nexspace.gpl`
   - (ถ้ายังไม่มีไฟล์นี้ ให้เปิด anchor เต็ม → Palette menu → **Create Palette from Sprite** → เซฟเป็น `.gpl` ก่อน)
2. **เปิด Pixel-Perfect** ให้ดินสอ
   - เลือกเครื่องมือ Pencil (กด **B**) → แถบ option ด้านบน → ติ๊ก **Pixel-perfect** (เส้นจะไม่มีมุมเบิ้ล)
3. **เปิด Grid + Pixel Grid**
   - `View > Grid > Grid Settings` → 32×32 (หรือ footprint ของชิ้นนั้น)
   - `View > Show > Pixel Grid` (เห็นเส้นตารางทุก pixel ตอน zoom)
4. เครื่องมือที่ใช้บ่อย (จำ shortcut ไว้):

| คีย์ | เครื่องมือ |
|------|-----------|
| **B** | Pencil (วาด 1px) |
| **E** | Eraser |
| **I** หรือ **Alt(ค้าง)** | Eyedropper (ดูดสี) |
| **G** | Bucket fill |
| **M** | Marquee (เลือกพื้นที่) |
| **V** | Move |
| **Z** / Ctrl+scroll | Zoom |
| **1–5** | ความ zoom เร็ว |

---

## PART A — วิธี Trace over Reference (แนะนำ, คุณภาพดีสุด) ⭐

### A1. สร้างไฟล์เปล่าขนาดเป้าหมาย
- `File > New` → กว้าง×สูง = **footprint × 32**
  (เก้าอี้ 32×32, โต๊ะ 64×32, ต้นไม้ 32×64, พรม 64×64, floor 32×32, wall 32×32)
- Color Mode: RGBA, Background: **Transparent**

### A2. วางภาพ full-res เป็น Reference Layer
- `Layer > New > New Reference Layer…` → เลือก `_wip/cutouts/<ชื่อ>.png`
- ภาพจะโผล่มาใหญ่ → กด **V** (Move) → ลากมุมย่อ/จัดให้ **พอดีกรอบ canvas** (เต็มพื้นที่ 32px)
- ข้อดีของ Reference Layer: แสดงตอนวาด แต่ **ไม่ถูก export** และล็อกไม่ให้เผลอวาดโดน
- (ทางเลือก: ลดความทึบ reference เหลือ ~50% เพื่อให้เห็น pixel ที่เราวาดชัด — คลิกเลเยอร์ ปรับ Opacity)

### A3. สร้างเลเยอร์วาดจริงทับด้านบน
- `Layer > New > New Layer` (ตั้งชื่อ `art`) — วาดทุกอย่างบนเลเยอร์นี้

### A4. ลำดับการวาด (ลอกจาก reference ทีละชั้น)
zoom ให้เห็นทั้งชิ้น (~800%) แล้ววาดตามลำดับนี้:

1. **Silhouette (เงาทึบ)** — กด **B**, ดูดสีฐานจาก reference (Alt-คลิก), วาด "รูปร่างทึบ" ของวัตถุก่อน ไม่ต้องสนดีเทล ให้ได้ทรงถูกก่อน
2. **Outline (เส้นขอบ)** — ใช้สีเข้มจาก palette (เช่น `#2b2a33`) ตีเส้นขอบ 1px รอบส่วนที่ต้องเน้น (selective — ไม่ต้องรอบทุกด้าน)
3. **Base colors** — เทสีฐานแต่ละส่วน (Bucket **G** หรือ Pencil) อ่านสีจาก reference
4. **Shadow (เฉดเข้ม)** — เลือกสีเข้มกว่าฐาน 1 ระดับจาก palette ใส่ด้านที่ห่างแสง (ล่าง/ขวา เพราะแสงมาจากบน-ซ้าย)
5. **Highlight (เฉดสว่าง)** — ใส่ขอบบน-ซ้าย จุดเดียวพอ อย่าเยอะ
6. **Detail จุดสำคัญ** — เช่นจอมอนิเตอร์, ใบไม้ 2–3 จุด ที่ทำให้ "อ่านออก" ว่าเป็นอะไร (ที่ 32px ใส่ได้แค่ดีเทลหลัก)

### A5. เก็บงาน (cleanup)
- **ลบ jaggies** — มองหา pixel เดี่ยว ๆ ที่ยื่นออกมา ทำเส้นขรุขระ → ลบ/ปรับให้เส้นลื่น (โค้งควรเป็นขั้นบันได 2-2-1)
- **อย่าใช้สีนอก palette** — ถ้าเผลอ ให้ดูดสีที่ใกล้จาก palette มาทับ
- ปิดตา 👁 หรือลบ Reference Layer ออกก่อน export

---

## PART B — วิธี Downscale + Repair (เร็วกว่า, ใช้กับของง่าย เช่น floor)

1. เปิด `cutouts/<ชื่อ>.png`
2. `Sprite > Sprite Size` → ตั้งเป้าหมาย (เช่น 32×32), **Interpolation = Nearest-neighbor**
3. `Sprite > Color Mode > Indexed` → เลือก palette เกม (บังคับให้สีเข้าชุด) แล้วกลับเป็น RGB ถ้าต้องการ
4. **เก็บมือ**: zoom เข้า → ใช้ Pencil ดูดสีจาก palette แก้ pixel เลอะ, ตีเส้นขอบใหม่ให้คม, ลบจุดหลง
5. เหมาะกับ floor/พื้นผิว ที่ไม่มีรูปทรงชัด — furniture/wall แนะนำ PART A

---

## PART C — ทำ Floor ให้ Tileable (สำคัญ ห้ามข้าม)

1. เปิดไฟล์ floor 32×32 → `View > Tiled Mode > Tiled in Both Axes`
   → canvas จะโชว์ตัวเองปูซ้ำรอบด้าน **เห็นรอยต่อทันที**
2. ดูขอบซ้าย-ขวา และบน-ล่าง ว่าลาย/เส้น grout ต่อกันไหม
3. ใช้ **Offset** เพื่อดันรอยต่อมากลางจอ: `Layer > Replace/Offset` หรือกด selection ทั้งหมด (**Ctrl+A**) แล้ว Move ทีละ 16px — แก้รอยที่โผล่กลางจอให้เนียน
4. โดยเฉพาะ `floor-cream`: เส้น grout หนา/ถี่ไป → ทำให้บางลงหรือลดเป็น 1 เส้นต่อขอบ ให้ดูสะอาดตอนปูเต็ม
5. เสร็จแล้วปิด Tiled Mode ก่อน export

---

## PART D — ประกอบผนัง 47-blob ใน Aseprite

wall 5 ชิ้นจาก AI = "ต้นแบบสไตล์" ต้องสร้างครบ 47 เคส:

1. เปิดไฟล์ใหม่ **8×6 tiles = 256×192 px** (atlas ผนังตาม [02a](02a-wall-tileset-spec.md))
2. เปิด Grid 32×32 (`View > Grid Settings`)
3. เอา **`assets/tilesets/pixel/walls-white-pixel.png`** (placeholder 47-blob ที่วางไว้แล้ว) เป็น **Reference Layer** — จะได้ตำแหน่ง/รูปทรงครบ 47 ช่องเป็นไกด์
4. วาดผนังสไตล์ AI (ขาว + เส้น teal ด้านใน) ทับทีละช่องตามไกด์:
   - ด้านที่ "ต่อผนัง" = ลากเต็มขอบ pixel เดียวกันทุก tile (สำคัญ! ไม่งั้นต่อไม่เนียน)
   - เส้น teal อยู่ **ด้านในห้อง** เสมอ — ระวังทิศให้ถูกในมุม/แยก
5. ตรวจด้วยการวาง 2 tile ติดกัน → เส้นต้องต่อเป็นเส้นเดียว
6. export เป็น `walls-white.png` (8 คอลัมน์)

> เร็วกว่านี้: ถ้าไม่อยากวาด 47 ช่องมือ ให้ **regenerate ผนังชุด 47 จาก Gemini/PixelLab** (ผมช่วยร่าง prompt/ใช้ tool autotile ได้)

---

## PART E — Furniture: footprint + anchor

1. วาดในไฟล์ขนาด footprint จริง (desk 64×32 ฯลฯ)
2. **จัด anchor = ขอบล่างกึ่งกลาง** — ให้ส่วนล่างสุดของเฟอร์นิเจอร์แตะขอบล่าง canvas (เผื่อ y-sort ในเกม)
3. ของสูง (ต้นไม้ 1×2, ตู้เย็น 1×2): ครึ่งบนที่ต้อง "ทับตัวละคร" ให้แยกคิดว่าจะตั้ง `layer=above` ([02b](02b-base-and-prefab-spec.md))
4. ของที่สมมาตร (เก้าอี้/พรม): เปิด **Symmetry** (แถบ option ด้านบน → ไอคอนสมมาตรแนวตั้ง) วาดครึ่งเดียว อีกครึ่งมิเรอร์เอง

---

## PART F — Export ให้ถูกต้อง

1. ปิด/ลบ Reference Layer ทั้งหมดก่อน (กันติดไปด้วย)
2. เช็คพื้นหลัง **โปร่งใส** (ไม่มีเลเยอร์ชื่อ "Background" ทึบ — ถ้ามีให้ `Layer > Background from Layer` สลับ หรือลบ)
3. `File > Export Sprite Sheet` (สำหรับ atlas floor/wall) หรือ `File > Save As` PNG (สำหรับ furniture แยกชิ้น)
4. **ห้าม resize ตอน export** (ให้เป็น 1:1 pixel) — การ scale ×2/×3 ให้ทำตอน render ในเกม (Phaser) ไม่ใช่ในไฟล์
5. เซฟเข้าโฟลเดอร์จริง: floor/wall → `assets/tilesets/`, furniture → `assets/tilesets/furniture/`

---

## สรุป checklist ต่อ 1 ชิ้น
- [ ] New file ขนาด footprint×32, transparent
- [ ] Reference Layer = cutout full-res, ย่อพอดี canvas
- [ ] เลเยอร์ art ใหม่ → silhouette → outline → base → shadow → highlight → detail
- [ ] เก็บ jaggies, ล็อกสีใน palette
- [ ] (floor) Tiled Mode เช็ค tileable
- [ ] (furniture) anchor ล่างกึ่งกลาง
- [ ] ลบ reference → export PNG 1:1 โปร่งใส → เข้าโฟลเดอร์

---

## เวลาโดยประมาณ (มือใหม่ pixel art)
| ชิ้น | เวลา |
|------|------|
| floor 1 แบบ | 10–20 นาที |
| furniture 1 ชิ้น | 20–40 นาที |
| wall 47-blob (ทั้งชุด) | 2–4 ชม. (หรือใช้ AI/autotile ลดเหลือ ~30 นาที) |
| avatar + walk 4 ทิศ | ครึ่งวัน (แนะนำ PixelLab) |
