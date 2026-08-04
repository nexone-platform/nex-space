# NexSpace 🏢

เว็บแอป **ออฟฟิศเสมือน (virtual office)** แนวเดียวกับ Gather Town —
เดินตัวละครในแผนที่ 2D เจอกันแล้วคุยด้วยเสียง/วิดีโอตามระยะใกล้ไกล แชร์หน้าจอ และสร้าง avatar ได้เอง
งานศิลป์ทั้งหมดออกแบบให้ทำงานร่วมกับ **Tiled Map Editor**

> 📄 **สถานะปัจจุบัน:** เอกสารออกแบบ + สถาปัตยกรรม (blueprint ก่อนเขียนโค้ด)

## 📚 เอกสารออกแบบ
อ่านตามลำดับใน [`docs/`](docs/):

| # | เอกสาร | เนื้อหา |
|---|--------|--------|
| 00 | [Overview](docs/00-overview.md) | ภาพรวม, **tech stack**, roadmap, โครงสร้างโปรเจกต์ |
| 01 | [Tech Architecture](docs/01-tech-architecture.md) | client/server, การซิงก์สถานะ, proximity ↔ media |
| 02 | [Asset & Tiled Pipeline](docs/02-asset-and-tiled-pipeline.md) | ⭐ ผนัง autotile, prefab room, workflow กับ Tiled |
| 03 | [Office Sizes](docs/03-office-sizes.md) | ออฟฟิศ 4 ขนาด (S/M/L/XL) |
| 04 | [Realtime Features](docs/04-realtime-features.md) | การเดิน, proximity chat, mic/cam, screen share |
| 05 | [Avatar System](docs/05-avatar-system.md) | สร้างตัวละคร layered sprite |
| 06 | [Pixel Art & AI Prompts](docs/06-pixel-art-style-and-ai-prompts.md) | สไตล์ pixel art + เครื่องมือ AI + prompt Gemini |

> 🎨 สไตล์งานศิลป์ = **pixel art** (Stardew Valley / Gather Town)

## 🧱 Tech Stack (สรุป)
- **Client:** React 18 + Phaser 3 (TypeScript, Vite)
- **Multiplayer:** Colyseus (authoritative room state)
- **Audio/Video:** LiveKit (WebRTC SFU) — proximity-based selective subscribe
- **Data:** PostgreSQL + Prisma, Object storage (S3-compatible)
- **Maps:** Tiled → JSON, data-driven (collision/zone/spawn อยู่ใน map ไม่ใช่โค้ด)

## ✨ ฟีเจอร์หลัก
- 🚶 เดินแบบ Gather (grid + client prediction ให้ลื่น)
- 💬 Proximity chat — เข้าใกล้เห็นกรอบสนทนา + ได้ยินกัน
- 🎤📷 เปิด/ปิด ไมค์ & กล้อง
- 🖥️ แชร์หน้าจอ (ในกลุ่ม + ขึ้นจอใหญ่ในฉาก)
- 🧑‍🎨 สร้าง avatar เอง (ผิว/ผม/เสื้อผ้า/accessory)

## 🗺️ ขั้นต่อไป
ดู [roadmap](docs/00-overview.md#4-roadmap-แบ่งเฟส) — เริ่มที่ **Phase 1: Foundation**
(tileset spec + แมพออฟฟิศเล็ก + การเดิน + collision)
