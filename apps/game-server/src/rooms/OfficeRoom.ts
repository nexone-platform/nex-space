import { Room, Client } from "colyseus";
import { OfficeState, Player, Sticker } from "../schema";
import { AREAS, canHear, type PrivateArea } from "../areas";

const TILE = 32;
const SPAWN = { x: 15 * TILE + TILE / 2, y: 18 * TILE + TILE / 2 };
const NEAR_PX = 5 * TILE; // proximity radius (5 tiles)
// "busy" is the one a person chooses; the rest are observed. It is also the
// only one this server acts on rather than merely relaying, because a request
// to come over is exactly what somebody on do-not-disturb is asking not to get.
const STATUSES = ["online", "afk", "muted", "meeting", "busy"];
const DEFAULT_WORKSPACE = "main";

// The gestures and stickers a browser may ask for. An allow-list rather than
// "any short string": these are drawn in everybody's window, and an open text
// field there is a way to write on somebody else's screen.
const EMOTES = ["wave", "dance", "clap", "thumbs", "party", "think"];
const STICKERS = ["\u2764\ufe0f", "\ud83d\udc4d", "\ud83c\udf89", "\u2b50", "\u2757", "\u2753", "\ud83d\udca1", "\ud83d\udd25", "\u2615", "\ud83c\udf55", "\ud83c\udf3f", "\ud83d\udea7"];

/** how long a sticker stays before the room sweeps it */
const STICKER_TTL_MS = 4 * 60 * 60 * 1000;
/** and how many there may be at once — a floor nobody can see is not decorated */
const STICKERS_PER_ROOM = 80;
const STICKERS_PER_PERSON = 12;
const API_URL = process.env.API_URL || "http://localhost:3001";

type MoveMsg = { x: number; y: number; dir: string; moving: boolean };
type ChatMsg = { text?: string };

export class OfficeRoom extends Room<OfficeState> {
  maxClients = 50;
  autoDispose = false; // keep a single persistent office so everyone joinOrCreate's the SAME room
                       // (rooms auto-disposing while momentarily empty caused clients to split across instances)

  private workspace = "main";
  /** the private areas of each map in this space — empty until the API answers */
  private areas = new Map<string, PrivateArea[]>();
  private areasAt = 0;
  /** the map new arrivals land on, so a client that names none still matches them */
  private landing = "";
  /**
   * Who has been let into each locked room, keyed "map/areaId".
   *
   * Held here rather than trusted from the browser, because this is what earshot
   * turns on: a client that put itself inside a locked room without being
   * admitted still hears nothing and is heard by nobody.
   */
  private admits = new Map<string, Set<string>>();
  /**
   * The attendance line open for each person here, and where their time is
   * going. `at` is the moment they arrived in the room they are standing in;
   * `spent` is the seconds already banked against the rooms they have left.
   */
  private visits = new Map<string, { id?: string; where: string; at: number; spent: Record<string, number> }>();
  private visitWarned = false;
  private chatStoreWarned = false;
  private dmStoreWarned = false;
  /** last gesture per sender-to-target pair, keyed by kind, so no button can be leaned on */
  private pingedAt = new Map<string, number>();
  /** who placed each sticker, so only they can pick it up again */
  private stickerBy = new Map<string, string>();
  private stickerSeq = 0;

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
    void this.loadAreas();
    // The room outlives everybody in it, so the sweep is on a clock rather than
    // on somebody arriving to trigger it.
    this.clock.setInterval(() => this.sweepStickers(), 10 * 60 * 1000);

    // client-authoritative position for Phase 2 MVP (server relays to others).
    // Hardening (server-side simulation/anti-cheat) is a later phase.
    this.onMessage("move", (client, data: MoveMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof data.x === "number") p.x = data.x;
      if (typeof data.y === "number") p.y = data.y;
      if (typeof data.dir === "string") p.dir = data.dir;
      p.moving = !!data.moving;
      this.maybeAdmit(client.sessionId, p);
      this.bankTime(client.sessionId, p);
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

    // Which map of the space this player is on. Client-authoritative like the
    // position it goes with — a browser that lies about its floor can already
    // lie about standing next to you.
    this.onMessage("map", (client, slug: string) => {
      const p = this.state.players.get(client.sessionId);
      const clean = String(slug ?? "").slice(0, 32);
      if (p && /^[a-z0-9-]*$/.test(clean)) { p.map = clean; this.bankTime(client.sessionId, p); }
    });

    /**
     * Ask to be let into the locked room you are standing at.
     *
     * Throttled per person, not per pair: a knock goes to everybody inside, so
     * leaning on the button is a way to interrupt a whole room at once.
     */
    this.onMessage("knock", (client) => {
      const me = this.state.players.get(client.sessionId);
      if (!me) return;
      const a = this.standingIn(me);
      if (!a?.locked) return;
      const key = this.key(me, a);
      if (this.admits.get(key)?.has(client.sessionId)) return; // already inside

      const gate = `knock:${client.sessionId}`;
      const last = this.pingedAt.get(gate) ?? 0;
      if (Date.now() - last < 8000) return;
      this.pingedAt.set(gate, Date.now());

      const inside = this.occupantsOf(key);
      if (!inside.length) {
        // nobody to answer: the door was never really shut
        this.admit(key, client.sessionId);
        return;
      }
      for (const sid of inside) {
        this.clients.find((c) => c.sessionId === sid)
          ?.send("knock", { from: client.sessionId, name: me.name, area: a.id, label: a.label });
      }
      client.send("knocked", { area: a.id, label: a.label, waiting: inside.length });
    });

    /** somebody inside opens the door, or does not */
    this.onMessage("admit", (client, msg: { to?: string; ok?: boolean }) => {
      const me = this.state.players.get(client.sessionId);
      const them = msg?.to ? this.state.players.get(msg.to) : undefined;
      if (!me || !them) return;
      const a = this.standingIn(me);
      // Only somebody who is in the room, and allowed to be, may open its door.
      if (!a?.locked || !this.isAdmitted(client.sessionId, me, a)) return;

      const target = this.clients.find((c) => c.sessionId === msg.to);
      if (!target) return;
      if (msg.ok === false) {
        target.send("admitted", { area: a.id, label: a.label, ok: false, by: me.name });
        return;
      }
      this.admit(this.key(me, a), msg.to!, me.name, a);
    });

    /**
     * A gesture, played on the avatar.
     *
     * Sent to everybody who can SEE you rather than everybody who can hear you:
     * a wave across a room is the whole point of waving, and the earshot rule
     * would swallow it. Another map is out of sight, so that is where it stops.
     */
    this.onMessage("emote", (client, kind: string) => {
      const me = this.state.players.get(client.sessionId);
      if (!me || EMOTES.indexOf(String(kind)) < 0) return;

      const gate = `emote:${client.sessionId}`;
      if (Date.now() - (this.pingedAt.get(gate) ?? 0) < 1500) return;
      this.pingedAt.set(gate, Date.now());

      const payload = { from: client.sessionId, kind: String(kind) };
      client.send("emote", payload);
      for (const c of this.clients) {
        if (c.sessionId === client.sessionId) continue;
        const p = this.state.players.get(c.sessionId);
        if (p && this.sameMap(me, p)) c.send("emote", payload);
      }
    });

    /**
     * Leave a sticker on the floor.
     *
     * It goes into room state rather than out as a message, so it is still
     * there for somebody who walks past in an hour — which is the only reason
     * to leave one.
     */
    this.onMessage("sticker", (client, msg: { emoji?: string; x?: number; y?: number }) => {
      const me = this.state.players.get(client.sessionId);
      if (!me) return;
      const emoji = String(msg?.emoji ?? "");
      if (STICKERS.indexOf(emoji) < 0) return;
      if (typeof msg?.x !== "number" || typeof msg?.y !== "number") return;
      if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;

      const gate = `sticker:${client.sessionId}`;
      if (Date.now() - (this.pingedAt.get(gate) ?? 0) < 1000) return;
      this.pingedAt.set(gate, Date.now());

      // one person cannot paper the whole floor, and the room as a whole has a
      // ceiling too — the oldest goes rather than the newest being refused,
      // because a button that silently does nothing is worse than a short memory
      const mine = [...this.stickerBy].filter(([, sid]) => sid === client.sessionId).map(([id]) => id);
      if (mine.length >= STICKERS_PER_PERSON) this.dropSticker(this.oldestOf(mine));
      if (this.state.stickers.size >= STICKERS_PER_ROOM) this.dropSticker(this.oldestOf([...this.state.stickers.keys()]));

      const st = new Sticker();
      st.emoji = emoji;
      st.x = Math.round(msg.x);
      st.y = Math.round(msg.y);
      st.map = me.map || this.landing;
      st.by = me.name;
      st.at = Date.now();
      const id = `s${++this.stickerSeq}`;
      this.state.stickers.set(id, st);
      this.stickerBy.set(id, client.sessionId);
    });

    /** pick one back up — yours, or anybody's if you run the place */
    this.onMessage("unsticker", (client, id: string) => {
      const key = String(id ?? "");
      if (!this.state.stickers.has(key)) return;
      const role = (client.auth as { role?: string } | undefined)?.role;
      const mine = this.stickerBy.get(key) === client.sessionId;
      if (!mine && role !== "owner" && role !== "admin") return;
      this.dropSticker(key);
    });

    /**
     * Show somebody the door.
     *
     * For the case a space that is open to visitors eventually has: a person
     * nobody can talk over. It ends this visit and nothing more — there is no
     * list of the banned, so somebody with a live pass or a membership can come
     * straight back. That is a deliberate stopping point rather than an
     * oversight: a ban is a record about a person, it outlives the afternoon it
     * was made in, and it deserves more thought than a button in a roster.
     *
     * The rule is here rather than in the browser because the browser asking to
     * be disconnected is a browser that can decline to ask.
     */
    this.onMessage("kick", (client, msg: { to?: string }) => {
      const role = (client.auth as { role?: string } | undefined)?.role;
      if (role !== "owner" && role !== "admin") return;
      const target = this.clients.find((c) => c.sessionId === msg?.to);
      const them = msg?.to ? this.state.players.get(msg.to) : undefined;
      if (!target || !them || target.sessionId === client.sessionId) return;

      // An admin cannot remove the owner or another admin, the same rule the
      // API applies to changing somebody's role — otherwise one admin can
      // clear the room of everybody who could stop them.
      const theirRole = (target.auth as { role?: string } | undefined)?.role;
      if (role === "admin" && (theirRole === "owner" || theirRole === "admin")) return;

      const me = this.state.players.get(client.sessionId);
      console.log(`[office:${this.workspace}] ${me?.name ?? client.sessionId} removed ${them.name}`);
      target.send("kicked", { by: me?.name ?? "" });
      // a moment for the message to land before the socket goes
      this.clock.setTimeout(() => { try { target.leave(4000); } catch { /* already gone */ } }, 250);
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

    /**
     * A wave.
     *
     * The lightest thing one person can send another: it asks for nothing, so
     * unlike a call to come over it is delivered even to somebody on
     * do-not-disturb — their client decides whether to make a sound about it.
     *
     * It also shows up in the room. A wave nobody can see is a notification;
     * the bubble over the waver is what makes it a gesture, so the people near
     * them get it the same way they get any other reaction.
     */
    this.onMessage("wave", (client, msg: { to?: string }) => {
      const me = this.state.players.get(client.sessionId);
      const to = String(msg?.to ?? "");
      const target = this.state.players.get(to);
      if (!me || !target || to === client.sessionId) return;

      const key = `wave:${client.sessionId}->${to}`;
      const now = Date.now();
      if (now - (this.pingedAt.get(key) ?? 0) < 8_000) return;
      this.pingedAt.set(key, now);

      this.clients.find((c) => c.sessionId === to)?.send("wave", { from: client.sessionId, name: me.name });
      client.send("waveSent", { to, name: target.name });

      // the same fan-out a reaction gets, so the gesture is visible where it happened
      const bubble = { from: client.sessionId, name: me.name, text: "👋" };
      client.send("chat", bubble);
      for (const c of this.nearbyClients(client.sessionId)) c.send("chat", bubble);
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

  /** the area a player is standing in, whether or not they may be there */
  private standingIn(p: Player): PrivateArea | undefined {
    const here = this.areas.get(p.map || this.landing);
    if (!here) return undefined;
    const tx = Math.floor(p.x / TILE), ty = Math.floor(p.y / TILE);
    for (const a of here) {
      if (tx >= a.x0 && tx <= a.x1 && ty >= a.y0 && ty <= a.y1) return a;
    }
    return undefined;
  }

  private key(p: Player, a: PrivateArea) { return `${p.map || this.landing}/${a.id}`; }

  /** may this session be in that locked room? */
  private isAdmitted(sessionId: string, p: Player, a: PrivateArea) {
    return !a.locked || !!this.admits.get(this.key(p, a))?.has(sessionId);
  }

  /** everyone currently standing in a locked room who is allowed to be */
  private occupantsOf(key: string): string[] {
    const allowed = this.admits.get(key);
    if (!allowed) return [];
    const out: string[] = [];
    for (const [sid, p] of this.state.players) {
      if (!allowed.has(sid)) continue;
      const a = this.standingIn(p);
      if (a && this.key(p, a) === key) out.push(sid);
    }
    return out;
  }

  /**
   * The area that counts for earshot.
   *
   * A locked room you have not been let into is not a room you are in — you
   * hear nothing from it and it hears nothing from you, which is what makes
   * the lock mean anything rather than merely draw a different outline.
   */
  private areaOf(p: Player, sessionId: string): PrivateArea | undefined {
    const a = this.standingIn(p);
    if (!a) return undefined;
    return this.isAdmitted(sessionId, p, a) ? a : undefined;
  }

  /** two players are within earshot only if they are on the same map at all */
  private sameMap(a: Player, b: Player) {
    return (a.map || this.landing) === (b.map || this.landing);
  }

  /**
   * Where somebody's time is being spent: "map/areaId", with an empty area id
   * meaning that map's open floor.
   *
   * The unlocked area is what counts even for a room they were never admitted
   * to, because this measures where people are, not who could hear them. A
   * dashboard that under-reported the busiest room because somebody was
   * standing outside its door would be answering a different question.
   */
  private whereabouts(p: Player) {
    const a = this.standingIn(p);
    return `${p.map || this.landing}/${a?.id ?? ""}`;
  }

  /**
   * Bank the time since they last changed room.
   *
   * Called on every move, which is often — but it only writes when the room
   * actually changed, so the common case is one string comparison.
   */
  private bankTime(sessionId: string, p: Player, force = false) {
    const v = this.visits.get(sessionId);
    if (!v) return;
    const now = this.whereabouts(p);
    if (!force && now === v.where) return;
    const secs = Math.max(0, Math.round((Date.now() - v.at) / 1000));
    if (secs) v.spent[v.where] = (v.spent[v.where] ?? 0) + secs;
    v.where = now;
    v.at = Date.now();
  }

  /**
   * Attendance, written with the credential that opened the door.
   *
   * Best effort on purpose: a space whose API is briefly unreachable should
   * lose a line in a report, not refuse to let anybody in. The warning is said
   * once per room rather than once per arrival.
   */
  private async openVisit(client: Client) {
    const auth = client.auth as { token?: string; guest?: string } | undefined;
    const qs = auth?.guest ? `?guest=${encodeURIComponent(auth.guest)}` : "";
    try {
      const r = await fetch(`${API_URL}/workspaces/${encodeURIComponent(this.workspace)}/visits${qs}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth?.token ? { authorization: `Bearer ${auth.token}` } : {}),
        },
        body: "{}",
      });
      if (!r.ok) throw new Error(`API answered ${r.status}`);
      const d: any = await r.json();
      const v = this.visits.get(client.sessionId);
      // they may have left again while this was in flight
      if (v && d?.id) v.id = d.id;
      else if (d?.id) void this.closeVisit(client, d.id, {});
    } catch (e) {
      if (!this.visitWarned) {
        this.visitWarned = true;
        console.warn(`[office:${this.workspace}] attendance is not being recorded:`, e);
      }
    }
  }

  private async closeVisit(client: Client, id: string, spent: Record<string, number>) {
    const auth = client.auth as { token?: string; guest?: string } | undefined;
    const qs = auth?.guest ? `?guest=${encodeURIComponent(auth.guest)}` : "";
    try {
      await fetch(`${API_URL}/workspaces/${encodeURIComponent(this.workspace)}/visits/${encodeURIComponent(id)}${qs}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          ...(auth?.token ? { authorization: `Bearer ${auth.token}` } : {}),
        },
        body: JSON.stringify({ areas: spent }),
      });
    } catch (e) {
      if (!this.visitWarned) {
        this.visitWarned = true;
        console.warn(`[office:${this.workspace}] a visit could not be closed:`, e);
      }
    }
  }

  private dropSticker(id: string | undefined) {
    if (!id) return;
    this.state.stickers.delete(id);
    this.stickerBy.delete(id);
  }

  private oldestOf(ids: string[]) {
    let best: string | undefined;
    let when = Infinity;
    for (const id of ids) {
      const at = this.state.stickers.get(id)?.at ?? 0;
      if (at < when) { when = at; best = id; }
    }
    return best;
  }

  /** stickers do not last forever, or a space is eventually only its doodles */
  private sweepStickers() {
    const cutoff = Date.now() - STICKER_TTL_MS;
    for (const [id, st] of this.state.stickers) if (st.at < cutoff) this.dropSticker(id);
  }

  /** let somebody into a locked room, and tell them so */
  private admit(key: string, sessionId: string, by = "", area?: PrivateArea) {
    let set = this.admits.get(key);
    if (!set) this.admits.set(key, (set = new Set()));
    set.add(sessionId);
    this.clients.find((c) => c.sessionId === sessionId)
      ?.send("admitted", { area: area?.id ?? key.split("/")[1], label: area?.label ?? "", ok: true, by });
  }

  /**
   * Walking into a locked room that nobody is in.
   *
   * The alternative is a room that can never be entered: with nobody inside
   * there is nobody to knock to, and the first person through the door is the
   * one who will answer everybody else.
   */
  private maybeAdmit(sessionId: string, p: Player) {
    const a = this.standingIn(p);
    if (!a?.locked) return;
    const key = this.key(p, a);
    if (this.admits.get(key)?.has(sessionId)) return;
    if (this.occupantsOf(key).length) return;
    this.admit(key, sessionId);
  }

  /**
   * The private areas on this space's map.
   *
   * Read from the same endpoint the browsers read, so the two cannot disagree
   * about where a room's walls are. A space on a stored map carries its own
   * areas; one on a stock layout is named by id and the copied table supplies
   * them.
   *
   * Until the answer lands the list is empty, and an empty list is plain
   * proximity — today's behaviour. So the worst a slow or unreachable API can
   * do is cost this room its private areas for a moment. It can never put
   * somebody in the wrong room.
   */
  private async loadAreas() {
    this.areasAt = Date.now();
    const base = `${API_URL}/workspaces/${encodeURIComponent(this.workspace)}`;
    try {
      const list: any = await (await fetch(`${base}/maps`)).json();

      // No stored maps: the space is on one of the layouts compiled into the
      // client, and the copied table has its areas.
      if (!list?.maps?.length) {
        const id = String(list?.builtin || "");
        if (!AREAS[id]) return;
        this.landing = id;
        this.areas = new Map([[id, AREAS[id]]]);
        console.log(`[office:${this.workspace}] built-in map "${id}", ${AREAS[id].length} private areas`);
        return;
      }

      const next = new Map<string, PrivateArea[]>();
      for (const m of list.maps) {
        const one: any = await (await fetch(`${base}/map/${encodeURIComponent(m.slug)}`)).json();
        // The API validated this before storing it; take only the shape this
        // room actually uses rather than trusting the rest of the document.
        const from = Array.isArray(one?.map?.areas) ? one.map.areas : [];
        next.set(m.slug, from
          .filter((a: any) => a && typeof a.id === "string"
            && [a.x0, a.x1, a.y0, a.y1].every((n: any) => typeof n === "number"))
          .map((a: any) => ({ ...a, locked: a.locked === true })));
      }
      this.areas = next;
      this.landing = String(list.landing || list.maps[0].slug);
      const total = [...next.values()].reduce((n, v) => n + v.length, 0);
      console.log(`[office:${this.workspace}] ${next.size} stored map(s), landing "${this.landing}", ${total} private areas`);
    } catch (e) {
      console.warn(`[office:${this.workspace}] could not read the maps — proximity only for now:`, e);
    }
  }

  /**
   * Other clients who can hear this one.
   *
   * Inside a private area that is everyone else inside it, however far off, and
   * nobody outside it — including whoever is standing one tile the other side of
   * the line. Out on the open floor it is the radius, as it always was.
   */
  private nearbyClients(sessionId: string): Client[] {
    const me = this.state.players.get(sessionId);
    if (!me) return [];
    const mine = this.areaOf(me, sessionId);
    const out: Client[] = [];
    for (const c of this.clients) {
      if (c.sessionId === sessionId) continue;
      const p = this.state.players.get(c.sessionId);
      if (!p) continue;
      // Another floor is not "far away", it is somewhere else — no radius and no
      // shared area can reach across one.
      if (!this.sameMap(me, p)) continue;
      const dx = p.x - me.x, dy = p.y - me.y;
      if (canHear(mine, this.areaOf(p, c.sessionId), dx * dx + dy * dy <= NEAR_PX * NEAR_PX)) out.push(c);
    }
    return out;
  }

  onJoin(client: Client, options: { name?: string; avatar?: string } = {}) {
    // the room is persistent, so one failed fetch at boot must not cost this
    // space its private areas for the rest of the day
    if (!this.areas.size && Date.now() - this.areasAt > 30_000) void this.loadAreas();

    const p = new Player();
    p.x = SPAWN.x;
    p.y = SPAWN.y;
    p.name = options.name?.slice(0, 24) || `Guest-${client.sessionId.slice(0, 4)}`;
    p.avatar = options.avatar || "1";
    // guests keep "", which is what makes them un-addressable in a private thread
    p.userId = (client.auth as { userId?: string } | undefined)?.userId || "";
    this.state.players.set(client.sessionId, p);
    // The attendance line is opened here and closed in onLeave. It is kept
    // locally first so the clock starts at the door rather than whenever the
    // API gets round to answering.
    this.visits.set(client.sessionId, { where: this.whereabouts(p), at: Date.now(), spent: {} });
    void this.openVisit(client);
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
    // banked before the player is dropped, or the last room they stood in is
    // the one thing the visit forgets
    const p = this.state.players.get(client.sessionId);
    const visit = this.visits.get(client.sessionId);
    if (p && visit) this.bankTime(client.sessionId, p, true);
    this.visits.delete(client.sessionId);
    if (visit?.id) void this.closeVisit(client, visit.id, visit.spent);

    this.state.players.delete(client.sessionId);
    // their throttle entries are dead weight the moment they are gone
    for (const key of this.pingedAt.keys()) {
      if (key.includes(`${client.sessionId}->`) || key.endsWith(`->${client.sessionId}`)
        || key === `knock:${client.sessionId}`) this.pingedAt.delete(key);
    }
    // Being let into a locked room lasts as long as the visit. A session id is
    // reused by nobody, but leaving these behind would let a reconnecting
    // browser walk back into a room it was admitted to an hour ago.
    for (const [key, set] of this.admits) {
      if (set.delete(client.sessionId) && !set.size) this.admits.delete(key);
    }
    console.log(`[office:${this.workspace}] leave ${client.sessionId} (${this.state.players.size} online)`);
  }
}
