import "dotenv/config";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { createServer } from "http";
import express, { Request, Response } from "express";
import cors from "cors";
import { AccessToken } from "livekit-server-sdk";
import { OfficeRoom } from "./rooms/OfficeRoom";

const port = Number(process.env.PORT) || 2567;

// LiveKit SFU config (optional). If unset, clients fall back to P2P mesh.
const LK_URL = process.env.LIVEKIT_URL || "";
const LK_KEY = process.env.LIVEKIT_API_KEY || "";
const LK_SECRET = process.env.LIVEKIT_API_SECRET || "";
const lkEnabled = !!(LK_URL && LK_KEY && LK_SECRET);

const app = express();
app.use(cors());

// tell the client which media mode to use
app.get("/livekit/config", (_req: Request, res: Response) => {
  res.json({ enabled: lkEnabled, url: LK_URL });
});

// mint a LiveKit access token for a participant
app.get("/livekit/token", async (req: Request, res: Response) => {
  if (!lkEnabled) return res.status(501).json({ error: "livekit not configured" });
  const room = String(req.query.room || "office");
  const identity = String(req.query.identity || "");
  const name = String(req.query.name || identity);
  if (!identity) return res.status(400).json({ error: "identity required" });
  const at = new AccessToken(LK_KEY, LK_SECRET, { identity, name, ttl: "1h" });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
  res.json({ token: await at.toJwt(), url: LK_URL });
});

const httpServer = createServer(app);
// maxPayload must be large enough for WebRTC SDP offers relayed via "signal" —
// screen-share offers carry a long video codec list and exceed the small default,
// which otherwise drops the sharer's connection ("Max payload size exceeded").
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer, maxPayload: 4 * 1024 * 1024 }),
});
// one room instance per workspace: joinOrCreate("office", { workspace }) only
// matches a room created with the same workspace, so spaces stay separate
gameServer.define("office", OfficeRoom).filterBy(["workspace"]);
gameServer.listen(port);
console.log(`[game-server] NexSpace on ws://localhost:${port}  |  LiveKit SFU: ${lkEnabled ? "ON (" + LK_URL + ")" : "OFF → P2P mesh"}`);
