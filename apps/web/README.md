# NexSpace Web — Phase 1 (Foundation)

Vite + Phaser 3 (TypeScript) client. เดินตัวละครในออฟฟิศ pixel-art + collision (Phase 1 ของ roadmap)

## รัน
```bash
cd apps/web
npm install
npm run dev
```
เปิด http://localhost:5173 — เดินด้วย **WASD / ลูกศร**

## สิ่งที่มีใน Phase 1
- โหลดพื้น (floor-cream), ผนัง **47-blob autotile** (walls-teal), เฟอร์นิเจอร์ (จาก AI ที่คัดแล้ว)
- ตัวละคร placeholder เดิน 4 ทิศ + อนิเมชัน (client-side)
- collision: ชนผนัง + เฟอร์นิเจอร์ที่เป็น solid
- กล้อง follow + zoom, pixel-perfect

## โครงสร้าง
```
src/
├─ main.ts              # Phaser game config
├─ wallAutotile.ts      # 47-blob index (ตรงกับ walls-teal.png atlas)
└─ scenes/OfficeScene.ts# map, player, movement, collision, camera
public/assets/          # floors / tilesets(walls) / furniture / player.png
```

## ทดสอบแล้ว (ผ่าน)
เดิน 4 ทิศ + อนิเมชัน · ชนผนัง (หยุดที่ขอบพอดี) · ชนโต๊ะ · idle frame ต่อทิศ
> หมายเหตุ: ถ้าเปิดใน headless/แท็บที่ซ่อน rAF จะถูกหยุด (เกมนิ่ง) — เปิดหน้าจอจริงถึงจะเดินได้

## รันครบ 3 services
```bash
cd apps/api && npm i && npx prisma db push && npm run dev      # :3001 (auth + persistence)
cd apps/game-server && npm run dev                              # :2567 (multiplayer + livekit token)
cd apps/web && npm run dev                                      # :5173 (client)
```
เปิด http://localhost:5173 → **หน้า login/register + เลือกตัวละคร** (หรือ "เข้าแบบ Guest") → ชื่อ/avatar เข้าเกม
- ชื่อจริงโชว์ทุกที่: roster, chat, ป้ายชื่อ, avatar chip
- login สำเร็จ → token เก็บใน localStorage → ครั้งหน้าเข้าอัตโนมัติ (auto-resume)
- ถ้า API ไม่รัน → ปุ่ม Guest ยังเข้าได้

## Multiplayer (Phase 2 — ทำแล้ว ✅)
ต้องรัน **game-server คู่กัน** (`apps/game-server`, ws://localhost:2567):
```bash
# terminal 1
cd apps/game-server && npm run dev
# terminal 2
cd apps/web && npm run dev
```
เปิด 2 แท็บ → เห็นผู้เล่นอื่นเดิน + ป้ายชื่อ (remote sync + interpolation + walk anim)
ถ้า game-server ไม่รัน เกมยังเล่นคนเดียวได้ (fallback single-player)

server URL อยู่ที่ `SERVER_URL` ใน [scenes/OfficeScene.ts](src/scenes/OfficeScene.ts) (deploy จริงเปลี่ยนเป็น wss://…)

## ถัดไป (Phase 3)
proximity chat → LiveKit (เสียง/วิดีโอตามระยะ) — ดู [docs/04](../../docs/04-realtime-features.md)
