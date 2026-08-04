# 05a — PixelLab Avatar Prompts (ครบ + ครอบคลุม)

ชุด prompt สำหรับสั่ง **PixelLab.ai** สร้าง avatar ให้ NexSpace ต่อจาก [05-avatar-system](05-avatar-system.md)
ให้ตรงสไตล์ pixel art ของเกม (top-down, warm + teal palette, 1px outline)

> **ความจริงเรื่องเครื่องมือ:** PixelLab สร้าง **ตัวละครทั้งตัว + อนิเมชันเดินหลายทิศ** ได้ดีมาก
> แต่ **ไม่เหมาะทำ "layer แยกชิ้น" (ผม/เสื้อ/กางเกง) ที่ align กันเป๊ะ** — เพราะเจนแต่ละภาพอิสระ
> → MVP ใช้ **แนวทาง A (ตัวละครสำเร็จหลาย preset)**; ถ้าจะทำ avatar creator แบบ custom เต็มค่อยใช้ B

---

## 0. ตั้งค่า PixelLab (ทุกครั้ง — สำคัญกว่าตัว prompt)

| ตัวเลือก | ค่าที่ใช้ | เหตุผล |
|---------|----------|--------|
| **Size** | **32 × 48 px** (หรือ 48×64 ถ้าต้องการดีเทลสูง) | ตรง frame ตัวละครในเกม (กว้าง 1 tile, สูง ~1.5) |
| **View** | **low top-down** | ตรงมุมกล้องเกม (Gather/Stardew) |
| **Directions** | **4 directions** (S, N, E, W) | เกมใช้ 4 ทิศ |
| **Animation** | **walk** (+ **idle** ถ้ามี) | ต้องมี walk cycle |
| **Background** | **transparent** | ห้ามใส่ magenta (PixelLab จะระบายทับ) |
| **Outline** | single, dark | ให้เข้าชุดกับ asset อื่น |

> ทิศ "S/down" = หันหน้าเข้าหาผู้เล่น (เห็นหน้า), "N/up" = หันหลัง (เห็นผม), W/E = ด้านข้าง

---

## แนวทาง A — ตัวละครสำเร็จ (แนะนำสำหรับ MVP)

### A1. Prompt แม่แบบ (ปรับ `[...]`)
```
A friendly pixel-art office worker for a cozy top-down 2D virtual-office game,
low top-down view (bird's-eye) like Gather Town and Stardew Valley characters.
Character: [young adult], [medium] build, [warm tan] skin, [short dark-brown] hair.
Outfit: [teal short-sleeve shirt], [navy trousers], [white sneakers].
Accessory: [none / round glasses].
Pixel art, crisp clean pixels, single 1px dark outline, 2-3 shades per color,
warm palette, soft light from the top-left, no anti-aliasing, transparent background.
```
**ตั้ง:** size 32×48 · 4 directions · walk animation

### A2. Roster สำเร็จ 8 แบบ (คัดลอกวางได้เลย — เปลี่ยนแค่บรรทัด Character/Outfit)
> ใช้บล็อก Pixel art/style ท้าย A1 เหมือนกันทุกตัว เพื่อให้ทั้ง roster สไตล์เดียวกัน

1. `warm tan skin, short dark-brown hair; teal shirt, navy trousers, white sneakers; round glasses`
2. `light skin, blonde bob hair; mustard cardigan, cream trousers, brown loafers`
3. `dark brown skin, short black afro; white shirt, charcoal trousers, black shoes`
4. `tan skin, long black ponytail; coral blouse, dark jeans, white sneakers`
5. `pale skin, red short hair; olive hoodie, grey joggers, green sneakers`
6. `medium skin, brown undercut; light-blue oxford shirt, khaki chinos, loafers`
7. `deep skin, braided hair with bun; teal cardigan, black skirt, ankle boots`
8. `light-tan skin, grey short hair (senior), glasses; navy blazer, grey trousers, brown shoes`

> เจนทีละตัว → ได้ตัวละคร + เดิน 4 ทิศ พร้อมใช้ (32×48 transparent, ไม่ต้อง downscale)

### A3. Prompt ต่อยอด (ท่าทาง/อารมณ์ เผื่ออนาคต)
```
Using the same character, add a [sitting / waving / typing] pose, low top-down, same style.
```
(สำหรับ emote/นั่งเก้าอี้ — ทำเมื่อมีเวลา)

---

## แนวทาง B — Layered Parts (สำหรับ avatar creator แบบ custom)

> ทำเมื่อจะให้ผู้เล่นผสมชิ้นเองตาม [05 §1](05-avatar-system.md) — **ต้องคุม alignment เข้ม**

### กติกาคุม alignment (สำคัญมาก)
1. เจน **body base ก่อน** แล้วใช้ PixelLab **"same character / edit"** เพื่อเพิ่มเสื้อ/ผมบนโครงเดิม (อย่าเจนแยกจากศูนย์ทุกชิ้น)
2. ทุกชิ้น size เท่ากัน (32×48), view/pose/directions เดียวกัน, pivot เท้าตำแหน่งเดียวกัน
3. export แยกชั้นแล้ว **เอาเข้า Aseprite/Pixelorama เช็คซ้อน** ให้ตรง (ต้องเกลามือ)

### B1. Body base (สีผิว)
```
A plain pixel-art human base body for a top-down 2D game, low top-down view,
[warm tan] skin, neutral underwear (no clothes), neutral face, short hair guide.
32x48 pixel art, 1px dark outline, 2-3 shades, light from top-left, transparent bg.
```
size 32×48 · 4 directions · walk — ทำ 6–8 สีผิว (เปลี่ยน `[warm tan]`)

### B2. Hair (grayscale เพื่อ tint สีได้)
```
Only a pixel-art [short bob] HAIRSTYLE for a top-down character, aligned to sit on a
32x48 head, low top-down, 4 directions. GRAYSCALE (white→grey) so it can be recolored.
1px dark outline, transparent background, nothing else (no head, no body).
```
ทำ 10–15 ทรง — grayscale แล้ว `setTint()` ในเกม

### B3. Tops / Bottoms / Shoes
```
Only a pixel-art [teal t-shirt] TOP for a top-down character, worn on a 32x48 body,
low top-down, 4 directions, matching walk pose. Transparent background, 1px outline,
nothing else (no body, no arms outline beyond the garment).
```
เปลี่ยน `[teal t-shirt] TOP` → `[navy trousers] BOTTOM`, `[white sneakers] SHOES` ทำอย่างละ 8–15 แบบ

### B4. Accessories
```
Only a pixel-art [round glasses / headphones / cap] ACCESSORY for a top-down 32x48
character, 4 directions, transparent background, 1px outline, nothing else.
```

---

## 3. นำเข้าเกม (สำคัญ — ให้ frame ตรง loader)

เกมโหลด `player.png` เป็น spritesheet **frame 32×32**, 4 แถว (down/up/left/right) × N เฟรม
([OfficeScene.ts](../apps/web/src/scenes/OfficeScene.ts): `frameWidth/Height` + anims)

**ขั้นตอน:**
1. PixelLab export → ได้เฟรมแยกทิศ/อนิเมชัน
2. จัดใหม่เป็น sheet: **แถว = ทิศ (down,up,left,right)**, **คอลัมน์ = เฟรม walk**, ทุก cell ขนาดเท่ากัน
3. ถ้าใช้ 32×48: อัปเดต loader เป็น `frameWidth: 32, frameHeight: 48` + ปรับ body hitbox/anchor
4. pivot เท้า = ล่างกึ่งกลางทุกเฟรม (ให้ y-sort ถูก)
5. วางทับ `apps/web/public/assets/player.png` → เปลี่ยนตัวละครในเกมทันที

> ถ้าใช้แนวทาง A (ตัวละครสำเร็จ) แต่ละ preset = 1 sheet → เก็บเป็น `avatars/<name>.png` แล้วให้ผู้เล่นเลือก preset (customization ระดับ "เลือกตัว" ก่อน, ค่อยอัปเป็น layered ทีหลัง)

---

## 4. เช็คลิสต์คุณภาพ (ก่อนรับงานจาก PixelLab)
- [ ] transparent background จริง (ไม่มี magenta/ขอบ fringe)
- [ ] 4 ทิศครบ + เดินลื่น (walk loop ไม่กระตุก)
- [ ] pivot เท้าตรงกันทุกเฟรม/ทุกทิศ
- [ ] สไตล์เข้าชุด: 1px outline, warm+teal palette, แสงบน-ซ้าย
- [ ] size ตรง (32×48) — ถ้าไม่ตรง resize nearest + เกลาขอบใน Pixelorama
