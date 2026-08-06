import { Room, Client } from "colyseus";
import { OfficeState, Player } from "../schema";

const TILE = 32;
const SPAWN = { x: 15 * TILE + TILE / 2, y: 18 * TILE + TILE / 2 };
const NEAR_PX = 5 * TILE; // proximity radius (5 tiles)
const STATUSES = ["online", "afk", "muted", "meeting"];
const DEFAULT_WORKSPACE = "main";
const API_URL = process.env.API_URL || "http://localhost:3001";

type MoveMsg = { x: number; y: number; dir: string; moving: boolean };
type ChatMsg = { text?: string };

export class OfficeRoom extends Room<OfficeState> {
  maxClients = 50;
  autoDispose = false; // keep a single persistent office so everyone joinOrCreate's the SAME room
                       // (rooms auto-disposing while momentarily empty caused clients to split across instances)

  private workspace = "main";

  /**
   * Gate the room on workspace membership. The API is the source of truth:
   * it answers whether this token is a member, or whether the workspace lets
   * guests in. Without this the permission model would be advisory only —
   * anyone could open a socket straight to another company's room.
   */
  async onAuth(_client: Client, options: { workspace?: string; token?: string } = {}) {
    const slug = String(options.workspace || "main").slice(0, 32);
    if (slug === DEFAULT_WORKSPACE) return true; // the shared public space
    try {
      const url = `${API_URL}/workspaces/${encodeURIComponent(slug)}/access`
        + `?token=${encodeURIComponent(options.token || "")}`;
      const r = await fetch(url);
      const d = (await r.json()) as { allowed?: boolean; reason?: string };
      if (d.allowed) return true;
      throw new Error(d.reason === "members-only" ? "members-only" : "workspace-not-found");
    } catch (e) {
      // a thrown auth error must reach the client; only network faults land here
      if (e instanceof Error && (e.message === "members-only" || e.message === "workspace-not-found")) throw e;
      console.error(`[office:${slug}] access check failed:`, e);
      throw new Error("access-check-failed");
    }
  }

  onCreate(options: { workspace?: string } = {}) {
    this.workspace = String(options.workspace || "main").slice(0, 32);
    this.setState(new OfficeState());
    console.log(`[office] room created for workspace "${this.workspace}"`);

    // client-authoritative position for Phase 2 MVP (server relays to others).
    // Hardening (server-side simulation/anti-cheat) is a later phase.
    this.onMessage("move", (client, data: MoveMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof data.x === "number") p.x = data.x;
      if (typeof data.y === "number") p.y = data.y;
      if (typeof data.dir === "string") p.dir = data.dir;
      p.moving = !!data.moving;
    });

    // player changed their avatar mid-session -> update state so peers re-render
    this.onMessage("avatar", (client, avatar: string) => {
      const p = this.state.players.get(client.sessionId);
      if (p && typeof avatar === "string" && avatar.length <= 2000) p.avatar = avatar;
    });

    // presence status shown as the dot on each player's name tag
    this.onMessage("status", (client, status: string) => {
      const p = this.state.players.get(client.sessionId);
      if (p && STATUSES.includes(status)) p.status = status;
    });

    // claim / release a desk. "" releases. Refuse if another online player owns it.
    this.onMessage("claimDesk", (client, deskId: string) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const id = String(deskId ?? "").slice(0, 32);
      if (id) {
        for (const [sid, other] of this.state.players) {
          if (sid !== client.sessionId && other.desk === id) return; // already taken
        }
      }
      p.desk = id;
    });


    // proximity text chat: only players within NEAR_PX (+ sender) receive it
    this.onMessage("chat", (client, msg: ChatMsg) => {
      const me = this.state.players.get(client.sessionId);
      const text = (msg?.text ?? "").toString().slice(0, 140).trim();
      if (!me || !text) return;
      const payload = { from: client.sessionId, name: me.name, text };
      client.send("chat", payload); // echo to sender
      for (const c of this.nearbyClients(client.sessionId)) c.send("chat", payload);
    });

    // room-wide chat: everyone in the room receives it
    this.onMessage("roomchat", (client, msg: ChatMsg) => {
      const me = this.state.players.get(client.sessionId);
      const text = (msg?.text ?? "").toString().slice(0, 140).trim();
      if (!me || !text) return;
      this.broadcast("roomchat", { from: client.sessionId, name: me.name, text });
    });

    // room-wide chat: broadcast to EVERYONE in the room (not proximity-limited)
    this.onMessage("roomchat", (client, msg: ChatMsg) => {
      const me = this.state.players.get(client.sessionId);
      const text = (msg?.text ?? "").toString().slice(0, 300).trim();
      if (!me || !text) return;
      this.broadcast("roomchat", { from: client.sessionId, name: me.name, text });
    });

    // sit pose: relay to peers so they render the seated sprite
    this.onMessage("sit", (client, msg: { on: boolean; dir: string }) => {
      this.broadcast("sit", { from: client.sessionId, on: !!msg?.on, dir: String(msg?.dir ?? "down") }, { except: client });
    });

    // screen-share presence: who is presenting on which in-scene screen (broadcast to all)
    this.onMessage("screenshare", (client, msg: { on: boolean; screenId: string }) => {
      if (!msg || typeof msg.screenId !== "string") return;
      this.broadcast("screenshare", { from: client.sessionId, on: !!msg.on, screenId: msg.screenId });
    });

    // WebRTC signaling relay (P2P mesh) — forward offer/answer/ICE to the target peer
    this.onMessage("signal", (client, msg: { to: string; kind: string; payload: unknown }) => {
      if (!msg?.to) return;
      const target = this.clients.find((c) => c.sessionId === msg.to);
      if (target) target.send("signal", { from: client.sessionId, kind: msg.kind, payload: msg.payload });
    });
  }

  /** other clients whose player is within NEAR_PX of the given session */
  private nearbyClients(sessionId: string): Client[] {
    const me = this.state.players.get(sessionId);
    if (!me) return [];
    const out: Client[] = [];
    for (const c of this.clients) {
      if (c.sessionId === sessionId) continue;
      const p = this.state.players.get(c.sessionId);
      if (!p) continue;
      const dx = p.x - me.x, dy = p.y - me.y;
      if (dx * dx + dy * dy <= NEAR_PX * NEAR_PX) out.push(c);
    }
    return out;
  }

  onJoin(client: Client, options: { name?: string; avatar?: string } = {}) {
    const p = new Player();
    p.x = SPAWN.x;
    p.y = SPAWN.y;
    p.name = options.name?.slice(0, 24) || `Guest-${client.sessionId.slice(0, 4)}`;
    p.avatar = options.avatar || "1";
    this.state.players.set(client.sessionId, p);
    console.log(`[office:${this.workspace}] join ${client.sessionId} (${this.state.players.size} online)`);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    console.log(`[office:${this.workspace}] leave ${client.sessionId} (${this.state.players.size} online)`);
  }
}
