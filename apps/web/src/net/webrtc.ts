// WebRTC P2P mesh for proximity voice/video/screen.
// Signaling is relayed through Colyseus ("signal" messages). Uses the standard
// "perfect negotiation" pattern to avoid offer glare. No media server needed.
import type { Room } from "colyseus.js";
import type { MediaManager } from "./media";

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
}

type SignalMsg = { from: string; kind: "desc" | "ice"; payload: any };

// RTCSessionDescription's fields live on the prototype (getters), so it serializes
// to {} over msgpack. Copy to a PLAIN object before sending over Colyseus.
const plainDesc = (d: RTCSessionDescription | null) =>
  d ? { type: d.type, sdp: d.sdp } : null;

export class WebRTCManager implements MediaManager {
  private peers = new Map<string, Peer>();
  private local?: MediaStream;   // mic + cam
  private camTrack?: MediaStreamTrack;
  private screenStream?: MediaStream;
  micOn = false;
  camOn = false;
  screenOn = false;
  onState?: () => void;          // notify UI to refresh button styles
  onPeerStream?: (peerId: string) => void; // fired when a peer's media track arrives
  onScreenEnd?: () => void;      // fired when the OS/browser stops the screen share ("Stop sharing")
  selMic?: string;               // selected device ids (device picker)
  selCam?: string;
  selSpk?: string;

  constructor(private room: Room, private myId: string, private tilesEl: HTMLElement) {
    room.onMessage("signal", (m: SignalMsg) => void this.onSignal(m));
  }

  // ---- media acquisition -------------------------------------------------
  private async ensureLocal(): Promise<MediaStream> {
    if (this.local) return this.local;
    const audio: MediaTrackConstraints | boolean = this.selMic ? { deviceId: { exact: this.selMic } } : true;
    const video: MediaTrackConstraints | boolean = this.selCam ? { deviceId: { exact: this.selCam } } : true;
    this.local = await navigator.mediaDevices.getUserMedia({ audio, video });
    this.local.getAudioTracks().forEach((t) => (t.enabled = false));
    this.camTrack = this.local.getVideoTracks()[0];
    if (this.camTrack) this.camTrack.enabled = false;
    // add current tracks to any existing peers
    for (const { pc } of this.peers.values()) {
      this.local.getTracks().forEach((t) => {
        if (!pc.getSenders().some((s) => s.track === t)) pc.addTrack(t, this.local!);
      });
    }
    this.renderSelfTile();
    return this.local;
  }

  async toggleMic() {
    try {
      const s = await this.ensureLocal();
      this.micOn = !this.micOn;
      s.getAudioTracks().forEach((t) => (t.enabled = this.micOn));
    } catch (e) { console.warn("mic error", e); }
    this.onState?.();
  }

  async toggleCam() {
    try {
      await this.ensureLocal();
      this.camOn = !this.camOn;
      if (this.camTrack) this.camTrack.enabled = this.camOn;
      this.renderSelfTile();
    } catch (e) { console.warn("cam error", e); }
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
    if (!this.local) return;
    const ns = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id } } });
    const nt = ns.getAudioTracks()[0]; nt.enabled = this.micOn;
    this.local.getAudioTracks().forEach((t) => { this.local!.removeTrack(t); t.stop(); });
    this.local.addTrack(nt);
    for (const { pc } of this.peers.values()) {
      const s = pc.getSenders().find((se) => se.track?.kind === "audio");
      if (s) await s.replaceTrack(nt);
    }
    this.onState?.();
  }

  async setCam(id: string) {
    this.selCam = id;
    if (!this.local) return;
    const ns = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } });
    const nt = ns.getVideoTracks()[0]; nt.enabled = this.camOn;
    this.local.getVideoTracks().forEach((t) => { this.local!.removeTrack(t); t.stop(); });
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

    if (this.local) this.local.getTracks().forEach((t) => pc.addTrack(t, this.local!));
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
    pc.ontrack = ({ streams }) => {
      video.srcObject = streams[0] ?? null;
      video.style.display = "block";
      tile.style.display = "block"; // reveal the tile only once real media arrives
      this.onPeerStream?.(peerId);
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) this.disconnect(peerId);
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
    this.local?.getTracks().forEach((t) => t.stop());
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
    v.srcObject = this.screenOn ? this.screenStream! : this.local!;
  }
}
