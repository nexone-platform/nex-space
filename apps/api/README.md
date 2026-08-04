# NexSpace API — Persistence + Auth

Express + Prisma. เก็บ **user, avatar config, saved maps** + auth (email/password + session token)

## รัน (dev, ใช้ SQLite — ไม่ต้องมี DB server)
```bash
cd apps/api
npm install
npx prisma db push      # สร้าง dev.db + ตาราง
npm run dev             # http://localhost:3001
```

## เปลี่ยนเป็น PostgreSQL (production)
1. `prisma/schema.prisma` → `provider = "postgresql"`
2. `.env` → `DATABASE_URL="postgresql://user:pass@host:5432/nexspace"`
3. `npx prisma migrate deploy` (หรือ `db push`)

ฟิลด์เก็บ JSON เป็น String อยู่แล้ว จึงพอร์ตข้าม SQLite↔Postgres ได้โดยไม่ต้องแก้ schema

## Endpoints
| Method | Path | Auth | ทำอะไร |
|--------|------|:----:|--------|
| POST | `/auth/register` | – | `{email,name,password}` → `{token, user}` |
| POST | `/auth/login` | – | `{email,password}` → `{token, user}` |
| POST | `/auth/logout` | ✓ | ลบ session |
| GET | `/me` | ✓ | user + avatar (JSON) |
| PUT | `/me/avatar` | ✓ | บันทึก avatar config (body = JSON) |
| GET | `/maps` | ✓ | รายการแมพของฉัน (id,name,updatedAt) |
| POST | `/maps` | ✓ | `{name,data}` → `{id}` |
| GET | `/maps/:id` | ✓ | แมพ + data |
| PUT | `/maps/:id` | ✓ | อัปเดต name/data |

Auth = `Authorization: Bearer <token>` (session 7 วัน) · รหัสผ่าน hash ด้วย **bcrypt** (ไม่เก็บ plain text)

## Data model (Prisma)
- **User** `{ id, email(unique), name, passwordHash, avatar?, createdAt }`
- **Session** `{ token(id), userId, expiresAt }`
- **SavedMap** `{ id, name, ownerId, data, createdAt, updatedAt }`

## ทดสอบแล้ว (curl)
register → me → save avatar → me (persisted) → create map → get map → login (session ใหม่) → 401 เมื่อไม่มี token/รหัสผิด ✅

## ถัดไป
เชื่อม client: หน้า login/register + โหลด avatar เข้าเกม + save/load แมพจาก editor · OAuth (Google) เพิ่มภายหลัง
