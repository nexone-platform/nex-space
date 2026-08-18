// WebRTC P2P mesh for proximity voice/video/screen.
// Signaling is relayed through Colyseus ("signal" messages). Uses the standard
// "perfect negotiation" pattern to avoid offer glare. No media server needed.
import type { Room } from "colyseus.js";
import type { MediaManager } from "./media";
import { t } from "../i18n";

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

interface Peer {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  tile: HTMLElement;
  video: HTMLVideoElement;
  /** wall clock and element clock at the moment playback started, so lag that
   *  builds up afterwards can be measured — see the latency guard */
  playedAt?: number;
  playedFrom?: number;
  lastFix?: number;
  droppedAt?: number;   // when ICE first said "disconnected"
}

type SignalMsg = { from: string; kind: "desc" | "ice"; payload: any };

// RTCSessionDescription's fields live on the prototype (getters), so it serializes
// to {} over msgpack. Copy to a PLAIN object before sending over Colyseus.
const plainDesc = (d: RTCSessionDescription | null) =>
  d ? { type: d.type, sdp: d.sdp } : null;

export class WebRTCManager implements MediaManager {
  private peers = new Map<string, Peer>();
  // Whatever we have actually been given so far. It starts empty and gains a
  // track when the person turns that device on — see acquire().
  private local = new MediaStream();
  private micTrack?: MediaStreamTrack;
  private camTrack?: MediaStreamTrack;
  private screenStream?: MediaStream;
  micOn = false;
  camOn = false;
  screenOn = false;
  onState?: () => void;          // notify UI to refresh button styles
  onPeerStream?: (peerId: string) => void; // fired when a peer's media track arrives
  onScreenEnd?: () => void;      // fired when the OS/browser stops the screen share ("Stop sharing")
  onError?: (message: string) => void; // a device refused to open, in words for the user
  selMic?: string;               // selected device ids (device picker)
  selCam?: string;
  selSpk?: string;

  private guardTimer?: number;

  constructor(private room: Room, private myId: string, private tilesEl: HTMLElement) {
    room.onMessage("signal", (m: SignalMsg) => void this.onSignal(m));
    this.guardTimer = window.setInterval(() => this.guardLatency(), 3000);
  }

  // ---- media acquisition -------------------------------------------------
  /**
   * One device at a time. Asking for the microphone and the camera in a single
   * getUserMedia call fails outright when either is absent, so a desktop with a
   * microphone and no webcam could not turn its microphone on at all. Asking
   * separately also means the camera light stays off while someone is only
   * talking, and a refused camera does not cost them their voice.
   */
  private async acquire(kind: "audio" | "video"): Promise<MediaStreamTrack> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new DOMException("getUserMedia is unavailable", "SecurityError");
    }
    const sel = kind === "audio" ? this.selMic : this.selCam;
    const ask = (id?: string): MediaStreamConstraints => {
      const c: MediaTrackConstraints | boolean = id ? { deviceId: { exact: id } } : true;
      return kind === "audio" ? { audio: c } : { video: c };
    };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(ask(sel));
    } catch (e) {
      // A remembered device that has since been unplugged fails as
      // OverconstrainedError. Whatever is still attached will do.
      if (!sel || (e as DOMException)?.name !== "OverconstrainedError") throw e;
      if (kind === "audio") this.selMic = undefined; else this.selCam = undefined;
      stream = await navigator.mediaDevices.getUserMedia(ask());
    }

    const track = stream.getTracks()[0];
    if (!track) throw new DOMException("no track", "NotFoundError");
    track.enabled = false;
    // a device unplugged mid-call ends its track; forget it so the next toggle
    // asks for a fresh one instead of flipping a dead switch
    track.onended = () => {
      if (kind === "audio") { this.micTrack = undefined; this.micOn = false; }
      else { this.camTrack = undefined; this.camOn = false; }
      this.onState?.();
    };
    this.local.addTrack(track);
    if (kind === "audio") this.micTrack = track; else this.camTrack = track;
    for (const { pc } of this.peers.values()) {
      if (!pc.getSenders().some((s) => s.track === track)) pc.addTrack(track, this.local);
    }
    this.renderSelfTile();
    return track;
  }

  /** why a device would not open, in words the person can act on */
  private explain(kind: "audio" | "video", e: unknown): string {
    const name = (e as DOMException)?.name ?? "";
    const device = kind === "audio" ? t("ไมโครโฟน") : t("กล้อง");
    if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
      return kind === "audio" ? t("ไม่พบไมโครโฟนบนเครื่องนี้") : t("ไม่พบกล้องบนเครื่องนี้");
    }
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      return t("เบราว์เซอร์ไม่อนุญาตให้ใช้{device} — กดไอคอนหน้าช่อง URL แล้วอนุญาต", { device });
    }
    if (name === "NotReadableError" || name === "TrackStartError") {
      return t("{device}ถูกโปรแกรมอื่นใช้อยู่ — ปิดโปรแกรมนั้นแล้วลองใหม่", { device });
    }
    if (name === "SecurityError") return t("ต้องเปิดผ่าน HTTPS จึงจะใช้ไมค์และกล้องได้");
    return t("เปิด{device}ไม่สำเร็จ ({error})", { device, error: name || String(e) });
  }

  async toggleMic() {
    try {
      if (!this.micTrack) await this.acquire("audio");
      this.micOn = !this.micOn;
      this.micTrack!.enabled = this.micOn;
    } catch (e) {
      console.warn("mic error", e);
      this.micOn = false;
      this.onError?.(this.explain("audio", e));
    }
    this.onState?.();
  }

  async toggleCam() {
    try {
      if (!this.camTrack) await this.acquire("video");
      this.camOn = !this.camOn;
      this.camTrack!.enabled = this.camOn;
      this.renderSelfTile();
    } catch (e) {
      console.warn("cam error", e);
      this.camOn = false;
      this.onError?.(this.explain("video", e));
    }
    this.onState?.();
  }

  async toggleScreen() {
    try {
      if (!this.screenOn) {
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screen = this.screenStream.getVideoTracks()[0];
        screen.onended = async () => { if (this.screenOn) await this.toggleScreen(); this.onScreenEnd?.(); };
        // replace the outgoing video track with the screen on every peer
        for (const { pc } of this.peers.values()) {
          const sender = pc.getSenders().find((s) => s.track?.kind === "video");
          if (sender) await sender.replaceTrack(screen);
          else pc.addTrack(screen, this.screenStream);
        }
        this.screenOn = true;
      } else {
        this.screenStream?.getTracks().forEach((t) => t.stop());
        for (const { pc } of this.peers.values()) {
          const sender = pc.getSenders().find((s) => s.track?.kind === "video");
          if (sender) await sender.replaceTrack(this.camTrack ?? null);
        }
        this.screenStream = undefined;
        this.screenOn = false;
      }
      this.renderSelfTile();
    } catch (e) { console.warn("screen error", e); }
    this.onState?.();
  }

  // ---- device picker -----------------------------------------------------
  async devices() {
    const list = await navigator.mediaDevices.enumerateDevices();
    return {
      mics: list.filter((d) => d.kind === "audioinput"),
      cams: list.filter((d) => d.kind === "videoinput"),
      speakers: list.filter((d) => d.kind === "audiooutput"),
    };
  }

  async setMic(id: string) {
    this.selMic = id;
    // nothing to swap yet: the choice is remembered and used when the mic opens
    if (!this.micTrack) return;
    const ns = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id } } });
    const nt = ns.getAudioTracks()[0]; nt.enabled = this.micOn;
    this.local.getAudioTracks().forEach((tr) => { this.local.removeTrack(tr); tr.stop(); });
    this.local.addTrack(nt);
    this.micTrack = nt;
    for (const { pc } of this.peers.values()) {
      const s = pc.getSenders().find((se) => se.track?.kind === "audio");
      if (s) await s.replaceTrack(nt);
    }
    this.onState?.();
  }

  async setCam(id: string) {
    this.selCam = id;
    if (!this.camTrack) return;
    const ns = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } });
    const nt = ns.getVideoTracks()[0]; nt.enabled = this.camOn;
    this.local.getVideoTracks().forEach((tr) => { this.local.removeTrack(tr); tr.stop(); });
    this.local.addTrack(nt);
    this.camTrack = nt;
    if (!this.screenOn) {
      for (const { pc } of this.peers.values()) {
        const s = pc.getSenders().find((se) => se.track?.kind === "video");
        if (s) await s.replaceTrack(nt);
      }
    }
    this.renderSelfTile();
  }

  /** current local screen-share stream (for rendering onto an in-scene screen) */
  get screenMediaStream(): MediaStream | undefined { return this.screenStream; }

  /** a connected peer's incoming media stream (undefined if not connected yet) */
  getPeerStream(peerId: string): MediaStream | undefined {
    const s = this.peers.get(peerId)?.video.srcObject;
    return s instanceof MediaStream ? s : undefined;
  }

  /** hide/show a peer's small tile (used when their video is routed to the in-scene screen) */
  hidePeerTile(peerId: string, hidden: boolean) {
    const peer = this.peers.get(peerId);
    if (peer) peer.tile.style.display = hidden ? "none" : (peer.video.srcObject ? "block" : "none");
  }

  /** set a peer's playback volume 0..1 (spatial audio by distance) */
  setPeerVolume(peerId: string, vol: number) {
    const peer = this.peers.get(peerId);
    if (peer) peer.video.volume = Math.max(0, Math.min(1, vol));
  }

  async setSpeaker(id: string) {
    this.selSpk = id;
    for (const { video } of this.peers.values()) {
      const v = video as HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> };
      if (v.setSinkId) await v.setSinkId(id).catch(() => {});
    }
  }

  // ---- proximity-driven connections --------------------------------------
  /** reconcile active peer connections. `nearby` = proximity (voice/cam);
   *  `forced` = keep connected regardless of distance (room-wide screen share). */
  syncPeers(nearby: Set<string>, forced?: Set<string>) {
    const want = forced ? new Set([...nearby, ...forced]) : nearby;
    for (const id of want) if (!this.peers.has(id)) this.connect(id);
    for (const id of [...this.peers.keys()]) if (!want.has(id)) this.disconnect(id);
  }

  private connect(peerId: string) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const polite = this.myId > peerId;                 // deterministic role
    const { tile, video } = this.makeTile(peerId);
    const peer: Peer = { pc, polite, makingOffer: false, ignoreOffer: false, tile, video };
    this.peers.set(peerId, peer);

    this.local.getTracks().forEach((tr) => pc.addTrack(tr, this.local));
    // if we're already screen-sharing, make sure this newly-connected peer gets it too
    if (this.screenOn && this.screenStream) {
      const screen = this.screenStream.getVideoTracks()[0];
      const vsender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (screen) { if (vsender) void vsender.replaceTrack(screen); else pc.addTrack(screen, this.screenStream); }
    }

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.signal(peerId, "desc", plainDesc(pc.localDescription));
      } catch (e) { console.warn("negotiation", e); }
      finally { peer.makingOffer = false; }
    };
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.signal(peerId, "ice", candidate.toJSON()); };
    pc.ontrack = ({ streams, receiver }) => {
      // Ask for the shortest playout the link allows. Chrome grows this delay
      // after a rough patch and does not shrink it again, which is how a
      // conversation ends up running a long way behind the room.
      const live = receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null; playoutDelayHint?: number | null };
      try { if ("jitterBufferTarget" in live) live.jitterBufferTarget = 0; } catch { /* not supported */ }
      try { if ("playoutDelayHint" in live) live.playoutDelayHint = 0; } catch { /* not supported */ }
      video.srcObject = streams[0] ?? null;
      video.style.display = "block";
      tile.style.display = "block"; // reveal the tile only once real media arrives
      this.play(peerId);
      this.onPeerStream?.(peerId);
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "failed" || st === "closed") return this.disconnect(peerId);
      // "disconnected" is usually a blip that ICE recovers from on its own.
      // Tearing the connection down here meant a lost packet cost a rebuild, and
      // a rebuild is what the audio has to catch up from.
      if (st === "disconnected") { peer.droppedAt = Date.now(); return; }
      if (st === "connected") { peer.droppedAt = undefined; this.play(peerId); }
    };
  }

  private disconnect(peerId: string) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.pc.close();
    peer.tile.remove();
    this.peers.delete(peerId);
  }

  /** stop all media + peer connections (used when leaving the room) */
  dispose() {
    if (this.guardTimer) window.clearInterval(this.guardTimer);
    this.local.getTracks().forEach((tr) => tr.stop());
    this.screenStream?.getTracks().forEach((t) => t.stop());
    for (const id of [...this.peers.keys()]) this.disconnect(id);
    document.getElementById("tile-self")?.remove();
    this.micOn = this.camOn = this.screenOn = false;
  }

  private async onSignal({ from, kind, payload }: SignalMsg) {
    const peer = this.peers.get(from);
    if (!peer) return; // only handle peers we're proximity-connected to
    const { pc } = peer;
    try {
      if (kind === "desc") {
        const offerCollision = payload.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(payload);
        if (payload.type === "offer") {
          await pc.setLocalDescription();
          this.signal(from, "desc", plainDesc(pc.localDescription));
        }
      } else if (kind === "ice") {
        try { await pc.addIceCandidate(payload); } catch (e) { if (!peer.ignoreOffer) throw e; }
      }
    } catch (e) { console.warn("signal handling", e); }
  }

  private signal(to: string, kind: "desc" | "ice", payload: unknown) {
    try { this.room.send("signal", { to, kind, payload }); }
    catch (e) { console.warn("signal send skipped", e); } // ws mid-close: don't crash the negotiation
  }

  // ---- tiles UI ----------------------------------------------------------
  /**
   * Start (or restart) playback of a peer's element and remember the clocks.
   *
   * autoplay alone is not enough: a blocked play() leaves the element paused
   * while the stream keeps arriving, and a paused element queues that audio
   * rather than dropping it — which is heard, on resume, as the conversation
   * running a minute behind.
   */
  private play(peerId: string) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const { video } = peer;
    video.play().then(() => {
      peer.playedAt = performance.now();
      peer.playedFrom = video.currentTime;
    }).catch(() => {
      // blocked until the page is interacted with; take the next gesture
      const retry = () => { document.removeEventListener("pointerdown", retry); this.play(peerId); };
      document.addEventListener("pointerdown", retry, { once: true });
    });
  }

  /**
   * Live audio has no business being seconds behind, so any lag that builds up
   * after playback started is dropped by re-attaching the stream: a media element
   * fed by a MediaStream cannot be seeked to the live edge, but a fresh
   * attachment starts there.
   *
   * Measured from when playback began, not from when the track arrived, so
   * ordinary setup time is not mistaken for lag.
   */
  private guardLatency() {
    const now = performance.now();
    for (const [id, peer] of this.peers) {
      // ICE said "disconnected" and never came back: give it a few seconds to
      // recover on its own, then rebuild rather than leaving a dead connection in
      // place. The next proximity pass reconnects if they are still in range.
      if (peer.droppedAt && Date.now() - peer.droppedAt > 8000) {
        console.warn(`[webrtc] ${id} stayed disconnected — rebuilding`);
        this.disconnect(id);
        continue;
      }
      const { video } = peer;
      if (!(video.srcObject instanceof MediaStream)) continue;
      if (video.paused) { this.play(id); continue; }
      if (peer.playedAt == null || peer.playedFrom == null) continue;
      const behind = (now - peer.playedAt) / 1000 - (video.currentTime - peer.playedFrom);
      if (behind < 1.5) continue;
      // once every 10s at most: re-attaching is a small click in the audio, and a
      // link that is genuinely struggling should not be clicked at every check
      if (peer.lastFix && now - peer.lastFix < 10_000) continue;
      peer.lastFix = now;
      console.warn(`[webrtc] ${id} audio was ${behind.toFixed(1)}s behind — dropping the backlog`);
      const stream = video.srcObject;
      video.srcObject = null;
      video.srcObject = stream;
      this.play(id);
    }
  }

  private makeTile(peerId: string): { tile: HTMLElement; video: HTMLVideoElement } {
    const tile = document.createElement("div");
    // hidden until this peer actually sends media (avoids empty black boxes for
    // idle/forced connections such as a screen-share target that isn't sending)
    tile.style.cssText = "display:none;position:relative;border-radius:8px;overflow:hidden;background:#2b303b;aspect-ratio:4/3;box-shadow:0 2px 8px #0003;";
    const video = document.createElement("video");
    video.autoplay = true; video.playsInline = true;
    video.style.cssText = "width:100%;height:100%;object-fit:cover;display:none;";
    const name = document.createElement("div");
    name.textContent = peerId.slice(0, 6);
    name.style.cssText = "position:absolute;left:6px;bottom:4px;color:#fff;font:11px sans-serif;text-shadow:0 1px 2px #000;";
    tile.append(video, name);
    this.tilesEl.append(tile);
    const v = video as HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> };
    if (this.selSpk && v.setSinkId) v.setSinkId(this.selSpk).catch(() => {});
    return { tile, video };
  }

  private renderSelfTile() {
    let self = document.getElementById("tile-self") as HTMLElement | null;
    const active = this.camOn || this.screenOn;
    if (!active) { self?.remove(); return; }
    if (!self) {
      self = document.createElement("div");
      self.id = "tile-self";
      self.style.cssText = "position:relative;border-radius:8px;overflow:hidden;background:#2b303b;aspect-ratio:4/3;border:2px solid #2bb3a3;";
      const v = document.createElement("video");
      v.autoplay = true; v.playsInline = true; v.muted = true;
      v.style.cssText = "width:100%;height:100%;object-fit:cover;transform:scaleX(-1);";
      const n = document.createElement("div");
      n.textContent = "You"; n.style.cssText = "position:absolute;left:6px;bottom:4px;color:#fff;font:11px sans-serif;text-shadow:0 1px 2px #000;";
      self.append(v, n);
      this.tilesEl.prepend(self);
    }
    const v = self.querySelector("video") as HTMLVideoElement;
    v.srcObject = this.screenOn ? this.screenStream! : this.local;
  }
}
