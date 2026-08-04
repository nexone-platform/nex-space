# NexSpace Game Server — Phase 2 (Multiplayer)

Colyseus authoritative room server. ห้อง `office` เก็บสถานะผู้เล่น (ตำแหน่ง/ทิศ/เดิน/ชื่อ) และ broadcast ให้ทุก client

## รัน
```bash
cd apps/game-server
npm install
npm run dev        # tsx watch, ws://localhost:2567
```

## โครงสร้าง
```
src/
├─ index.ts            # Colyseus Server + WebSocketTransport (port 2567)
├─ schema.ts           # Player + OfficeState (@colyseus/schema)
└─ rooms/OfficeRoom.ts # onJoin/onLeave + onMessage("move")
```

## สถานะที่ sync
`Player { x, y, dir, moving, name, avatar }` ต่อ sessionId ใน `MapSchema`

## โมเดล authority (Phase 2 = MVP)
**client-authoritative position** — client ส่งตำแหน่งตัวเอง (`move`) server relay ให้คนอื่น
เหมาะกับ social/office app, ทำงานได้จริงวันนี้
> Hardening (server simulation + collision + anti-cheat) = Phase 5 ตาม [docs/01 §3](../../docs/01-tech-architecture.md)

## ต้องรันคู่กับ client
```bash
# terminal 1
cd apps/game-server && npm run dev
# terminal 2
cd apps/web && npm run dev      # http://localhost:5173
```
เปิด 2 แท็บ/2 เครื่อง → เห็นกันเดิน + ป้ายชื่อลอยหัว

## Phase 3 (ทำแล้ว ✅)
- **3a proximity + chat:** `nearbyClients()` (รัศมี 5 tiles) + `onMessage("chat")` ส่งเฉพาะคนใกล้
- **3b WebRTC P2P:** `onMessage("signal")` relay offer/answer/ICE ระหว่าง peer → client ทำ P2P mesh เอง (voice/video/screen) โดย proximity สั่ง connect/disconnect

> **Production note:** P2P ใช้ STUN ฟรีของ Google อยู่ — บางเครือข่าย (NAT เข้ม/องค์กร) ต้องมี **TURN server** ด้วยถึงจะทะลุได้ · ห้องใหญ่ (>8 คนในกลุ่มเดียว) mesh จะหนัก → ค่อยเปลี่ยนเป็น **LiveKit SFU** ([docs/01](../../docs/01-tech-architecture.md))

## Phase 5 — LiveKit SFU (ทางเลือก, สำหรับห้องใหญ่)
เปิด SFU ได้โดยตั้ง env (ถ้าไม่ตั้ง = ใช้ P2P mesh เหมือนเดิม):

```bash
# 1) รัน LiveKit server (dev) ด้วย Docker — ได้ devkey/secret อัตโนมัติ
docker run --rm -p 7880:7880 -p 7881:7881 -p 7882:7882/udp livekit/livekit-server --dev
# 2) ตั้ง env ให้ game-server (คัดลอกจาก .env.example)
#    LIVEKIT_URL=ws://localhost:7880  LIVEKIT_API_KEY=devkey  LIVEKIT_API_SECRET=secret
cp .env.example .env
npm run dev
```
- game-server จะ mint JWT ที่ **GET `/livekit/token?room=office&identity=<sid>&name=<name>`** (identity = Colyseus sessionId)
- client เช็ค **GET `/livekit/config`** → ถ้า `enabled:true` ใช้ **LiveKitManager** (SFU), ไม่งั้น **WebRTCManager** (P2P) อัตโนมัติ

**ข้อดี SFU vs P2P:**
| | P2P mesh (default) | LiveKit SFU |
|---|---|---|
| media server | ไม่ต้อง | ต้องมี (Docker/Cloud) |
| จอแชร์/เสียง | เฉพาะคนที่เชื่อมกัน (ใกล้) | **ทั้งห้องเห็น/ได้ยินได้** (จอแชร์ room-wide) |
| ห้องใหญ่ | หนักเมื่อ >6–8 คนในกลุ่ม | รองรับ 50+ (adaptive/dynacast) |
| proximity | คุม connect ตามระยะ | **spatial**: subscribe วิดีโอเฉพาะคนใกล้ + เสียงดัง/เบาตามระยะ (setVolume) |

> production ใช้ **LiveKit Cloud** (มี TURN ในตัว) หรือ self-host + TURN; ตั้ง `LIVEKIT_URL=wss://...`

## ถัดไป
หน้าเลือกตัวละคร/ใส่ชื่อ · แมพเป็นไฟล์ Tiled · persistence (DB)
