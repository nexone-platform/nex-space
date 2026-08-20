import { Room, Client } from "colyseus";
import { OfficeState, Player } from "../schema";

const TILE = 32;
const SPAWN = { x: 15 * TILE + TILE / 2, y: 18 * TILE + TILE / 2 };
const NEAR_PX = 5 * TILE; // proximity radius (5 tiles)
// "busy" is the one a person chooses; the rest are observed. It is also the
// only one this server acts on rather than merely relaying, because a request
// to come over is exactly what somebody on do-not-disturb is asking not to get.
const STATUSES = ["online", "afk", "muted", "meeting", "busy"];
const DEFAULT_WORKSPACE = "main";
const API_URL = process.env.API_URL || "http://localhost:3001";

type MoveMsg = { x: number; y: number; dir: string; moving: boolean };
type ChatMsg = { text?: string };

export class OfficeRoom extends Room<OfficeState> {
  maxClients = 50;
  autoDispose = false; // keep a single persistent office so everyone joinOrCreate's the SAME room
                       // (rooms auto-disposing while momentarily empty caused clients to split across instances)

  private workspace = "main";
  private chatStoreWarned = false;
  private dmStoreWarned = false;
  /** last "come here" per sender-to-target pair, so the button cannot be leaned on */
  private pingedAt = new Map<string, number>();

  /**
   * Gate the room on workspace membership. The API is the source of truth:
   * it answers whether this token is a member, or whether the workspace lets
   * guests in. Without this the permission model would be advisory only —
   * anyone could open a socket straight to another company's room.
   */
  async onAuth(_client: Client, options: { workspace?: string; token?: string; guest?: string } = {}) {
    const slug = String(options.workspace || "main").slice(0, 32);
    // Whatever comes back becomes client.auth, and the chat handler posts with
    // it: the credential that opened the door is the one that signs what is
    // said through it.
    const creds = { token: options.token || "", guest: options.guest || "" };
    if (slug === DEFAULT_WORKSPACE) return { role: "member", ...creds }; // the shared public space
    try {
      // `guest` is a guest-pass code from the visitor's ?g= link — the API
      // decides whether it is still live
      const url = `${API_URL}/workspaces/${encodeURIComponent(slug)}/access`
        + `?token=${encodeURIComponent(options.token || "")}`
        + `&guest=${encodeURIComponent(options.guest || "")}`;
      const r = await fetch(url);
      const d = (await r.json()) as { allowed?: boolean; reason?: string; role?: string; userId?: string };
      // the returned object becomes client.auth — the room reads the role from it
      if (d.allowed) return { role: d.role || "member", userId: d.userId || "", ...creds };
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

    // renamed themselves in their profile — the name tag over their head, the
    // roster and every future message all read from this one field
    this.onMessage("name", (client, name: string) => {
      const p = this.state.players.get(client.sessionId);
      const clean = String(name ?? "").trim().slice(0, 24);
      if (p && clean) p.name = clean;
    });

    // presence status shown as the dot on each player's name tag
    this.onMessage("status", (client, status: string) => {
      const p = this.state.players.get(client.sessionId);
      if (p && STATUSES.includes(status)) p.status = status;
    });

    // mic on/off, shown as the crossed-mic badge on the meeting-room tiles
    this.onMessage("mic", (client, on: boolean) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.micOn = !!on;
    });

    // a raised hand, shown on the meeting tiles until it is lowered
    this.onMessage("hand", (client, on: boolean) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.handUp = !!on;
    });

    // claim / release a desk. "" releases. Refuse if another online player owns it.
    this.onMessage("claimDesk", (client, deskId: string) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const id = String(deskId ?? "").slice(0, 32);
      if (id) {
        // desks are staff seating; the API refuses guests too, this stops a
        // client that talks to the socket directly
        if ((client.auth as { role?: string } | undefined)?.role === "guest") {
          client.send("deskDenied", { reason: "guest" });
          return;
        }
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

    // room-wide chat: broadcast to EVERYONE in the room (not proximity-limited)
    this.onMessage("roomchat", (client, msg: ChatMsg) => {
      const me = this.state.players.get(client.sessionId);
      const text = (msg?.text ?? "").toString().slice(0, 300).trim();
      if (!me || !text) return;
      // Sent first, stored second. The people in the room are waiting for the
      // message; the record can be a moment behind, and a database that is slow
      // or down should cost history rather than conversation.
      this.broadcast("roomchat", { from: client.sessionId, name: me.name, text });
      void this.remember(client, text);
    });

    /**
     * A message for one person.
     *
     * Delivered to whichever sockets that account has open right now, echoed to
     * the sender so their own thread updates, and stored either way — the point
     * of a private message is that it waits for someone who is not here.
     *
     * The recipient is named by account, not by session: they may be in the room
     * twice, or not at all, and the message means the same thing in every case.
     */
    this.onMessage("dm", (client, msg: { to?: string; text?: string }) => {
      const me = this.state.players.get(client.sessionId);
      const to = String(msg?.to ?? "");
      const text = (msg?.text ?? "").toString().slice(0, 300).trim();
      const mine = (client.auth as { userId?: string } | undefined)?.userId || "";
      // a guest has no account to be answered at, so they cannot start a thread
      if (!me || !to || !text || !mine || to === mine) return;

      const payload = { from: mine, to, name: me.name, text, at: new Date().toISOString() };
      client.send("dm", payload);
      for (const [sessionId, p] of this.state.players) {
        if (p.userId === to && sessionId !== client.sessionId) {
          this.clients.find((c) => c.sessionId === sessionId)?.send("dm", payload);
        }
      }
      void this.rememberDm(client, to, text);
    });

    /**
     * "Come and find me."
     *
     * A request, not a command: it arrives as an invitation the other person
     * can refuse, and only their own client ever moves them. Anything else
     * would let one player drag another across the map, which is a griefing
     * tool rather than a feature.
     *
     * Throttled per pair, because a button that moves someone else is exactly
     * the button people press twelve times.
     */
    this.onMessage("ping", (client, msg: { to?: string }) => {
      const me = this.state.players.get(client.sessionId);
      const to = String(msg?.to ?? "");
      const target = this.state.players.get(to);
      if (!me || !target || to === client.sessionId) return;

      // Refused here rather than ignored on their machine: the person asking
      // deserves to know it did not arrive, and the person working deserves
      // not to be asked.
      if (target.status === "busy") {
        client.send("pingRefused", { to, name: target.name });
        return;
      }

      const key = `${client.sessionId}->${to}`;
      const now = Date.now();
      if (now - (this.pingedAt.get(key) ?? 0) < 10_000) return;
      this.pingedAt.set(key, now);

      this.clients.find((c) => c.sessionId === to)?.send("ping", {
        from: client.sessionId, name: me.name, x: me.x, y: me.y,
      });
      client.send("pingSent", { to, name: target.name });
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
    // guests keep "", which is what makes them un-addressable in a private thread
    p.userId = (client.auth as { userId?: string } | undefined)?.userId || "";
    this.state.players.set(client.sessionId, p);
    console.log(`[office:${this.workspace}] join ${client.sessionId} (${this.state.players.size} online)`);
  }

  /**
   * Write one line to the API, in the speaker's own name.
   *
   * Failure is deliberately quiet in the room and loud in the log: the person
   * has already seen their message appear, and telling them it was not archived
   * would be noise they can do nothing about. It is worth knowing on the server,
   * though — a space whose history silently stops is worse than one that never
   * had any.
   */
  private async remember(client: Client, text: string) {
    const auth = client.auth as { token?: string; guest?: string } | undefined;
    const qs = auth?.guest ? `?guest=${encodeURIComponent(auth.guest)}` : "";
    try {
      const r = await fetch(
        `${API_URL}/workspaces/${encodeURIComponent(this.workspace)}/messages${qs}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(auth?.token ? { authorization: `Bearer ${auth.token}` } : {}),
          },
          body: JSON.stringify({ text }),
        },
      );
      if (!r.ok && !this.chatStoreWarned) {
        // once per room, not once per message: a misconfigured space would
        // otherwise fill the log with the same line at conversation speed
        this.chatStoreWarned = true;
        console.warn(`[office:${this.workspace}] chat history is not being stored (API answered ${r.status})`);
      }
    } catch (e) {
      if (!this.chatStoreWarned) {
        this.chatStoreWarned = true;
        console.warn(`[office:${this.workspace}] chat history is not being stored:`, e);
      }
    }
  }

  /** the same write as a room line, addressed to one person */
  private async rememberDm(client: Client, to: string, text: string) {
    const auth = client.auth as { token?: string } | undefined;
    try {
      const r = await fetch(
        `${API_URL}/workspaces/${encodeURIComponent(this.workspace)}/dm/${encodeURIComponent(to)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(auth?.token ? { authorization: `Bearer ${auth.token}` } : {}),
          },
          body: JSON.stringify({ text }),
        },
      );
      if (!r.ok && !this.dmStoreWarned) {
        this.dmStoreWarned = true;
        console.warn(`[office:${this.workspace}] private messages are not being stored (API answered ${r.status})`);
      }
    } catch (e) {
      if (!this.dmStoreWarned) {
        this.dmStoreWarned = true;
        console.warn(`[office:${this.workspace}] private messages are not being stored:`, e);
      }
    }
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    // their throttle entries are dead weight the moment they are gone
    for (const key of this.pingedAt.keys()) {
      if (key.startsWith(`${client.sessionId}->`) || key.endsWith(`->${client.sessionId}`)) this.pingedAt.delete(key);
    }
    console.log(`[office:${this.workspace}] leave ${client.sessionId} (${this.state.players.size} online)`);
  }
}
