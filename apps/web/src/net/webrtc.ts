// WebRTC P2P mesh for proximity voice/video/screen.
// Signaling is relayed through Colyseus ("signal" messages). Uses the standard
// "perfect negotiation" pattern to avoid offer glare. No media server needed.
import type { Room } from "colyseus.js";
import type { MediaManager } from "./media";
import { micTreatment } from "../appearance";
import { t } from "../i18n";
import { iceConfig, loadIce } from "./ice";

/**
 * Is there a picture here, or only the promise of one?
 *
 * A transceiver made before its track exists still produces a receiver and a
 * track on the far side — muted, carrying nothing. Counting tracks would call
 * that a camera, so everything that asks "are they on video" has to ask whether
 * media is actually flowing.
 */
export const hasLiveVideo = (s?: MediaStream | null) =>
  !!s?.getVideoTracks().some((tr) => tr.readyState === "live" && !tr.muted);

interface Peer {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  tile: HTMLElement;
  video: HTMLVideoElement;
  /**
   * The element that actually makes the sound, kept apart from the picture.
   *
   * A <video> fed a stream whose video track never produces a frame does not
   * play the audio in it either: it sits at readyState 0 with play() unsettled,
   * for good. Measured — and it has nothing to do with the element being
   * hidden, which works fine. Since a slot is now opened before anybody
   * switches a camera on, every peer with their camera off sends exactly such a
   * track, so one <video> for both would be silent for almost everybody. An
   * <audio> element ignores video tracks entirely.
   */
  sound: HTMLAudioElement;
  /** everything the far side sends, which is what the scene asks for */
  remote: MediaStream;
  /** the two outgoing slots. One side makes them, the other adopts the ones
   *  that side's offer creates — see openSlots/adoptSlots. */
  micSender?: RTCRtpSender;
  vidSender?: RTCRtpSender;
  /** the scene routed this peer's picture to an in-world screen instead */
  hidden?: boolean;
  /** the answerer's "nobody opened, so I will" fallback */
  openTimer?: number;
  /** wall clock and element clock at the moment playback started, so lag that
   *  builds up afterwards can be measured — see the latency guard */
  playedAt?: number;
  playedFrom?: number;
  lastFix?: number;
  /** outbound audio packets at the previous check, to notice a sender going nowhere */
  lastSent?: number;
  droppedAt?: number;   // when ICE first said "disconnected"
  retried?: boolean;    // an ICE restart has already been spent on this peer
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
    void this.refreshIce();
  }

  /**
   * Ask for relay credentials and give them to connections that are already up.
   *
   * setConfiguration takes effect on the next gathering, so an existing
   * connection keeps whatever route it found — which is right, a working direct
   * path should not be torn down for a relay it does not need. What changes is
   * what it can reach for if that path later breaks.
   */
  private async refreshIce() {
    const cfg = await loadIce();
    for (const peer of this.peers.values()) {
      try { peer.pc.setConfiguration(cfg); } catch { /* closing, or an older browser */ }
    }
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
      const c: MediaTrackConstraints | boolean =
        kind === "audio" ? { ...micTreatment(), ...(id ? { deviceId: { exact: id } } : {}) }
        : id ? { deviceId: { exact: id } } : true;
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
    for (const peer of this.peers.values()) {
      if (kind === "audio") void peer.micSender?.replaceTrack(track);
      // a camera opened mid-share does not get to take the screen's slot
      else if (!this.screenOn) void peer.vidSender?.replaceTrack(track);
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
        // The picture slot already exists on every peer, so the screen goes into
        // it. Nothing is added, so nothing renegotiates and nothing changes what
        // stream the far side is playing — the voice keeps flowing throughout.
        for (const peer of this.peers.values()) await peer.vidSender?.replaceTrack(screen);
        this.screenOn = true;
      } else {
        this.screenStream?.getTracks().forEach((t) => t.stop());
        for (const peer of this.peers.values()) await peer.vidSender?.replaceTrack(this.camTrack ?? null);
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

  /**
   * Reopen the microphone with the current treatment settings.
   *
   * Noise suppression and the rest are decided when a track is created, not
   * afterwards — `applyConstraints` is honoured for some of them by some
   * browsers and quietly ignored by others. Taking a fresh track is the only
   * way to be sure the switch did what it says.
   */
  async refreshMic() {
    if (!this.micTrack) return; // the next open will pick the setting up
    const ns = await navigator.mediaDevices.getUserMedia({
      audio: { ...micTreatment(), ...(this.selMic ? { deviceId: { exact: this.selMic } } : {}) },
    });
    const nt = ns.getAudioTracks()[0];
    nt.enabled = this.micOn;
    this.local.getAudioTracks().forEach((tr) => { this.local.removeTrack(tr); tr.stop(); });
    this.local.addTrack(nt);
    this.micTrack = nt;
    for (const peer of this.peers.values()) await peer.micSender?.replaceTrack(nt);
  }

  async setMic(id: string) {
    this.selMic = id;
    // nothing to swap yet: the choice is remembered and used when the mic opens
    if (!this.micTrack) return;
    const ns = await navigator.mediaDevices.getUserMedia({
      audio: { ...micTreatment(), deviceId: { exact: id } },
    });
    const nt = ns.getAudioTracks()[0]; nt.enabled = this.micOn;
    this.local.getAudioTracks().forEach((tr) => { this.local.removeTrack(tr); tr.stop(); });
    this.local.addTrack(nt);
    this.micTrack = nt;
    for (const peer of this.peers.values()) await peer.micSender?.replaceTrack(nt);
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
      for (const peer of this.peers.values()) await peer.vidSender?.replaceTrack(nt);
    }
    this.renderSelfTile();
  }

  /** what our own camera is producing, if it is on at all */
  get cameraStream(): MediaStream | undefined {
    return this.camTrack && this.camOn ? new MediaStream([this.camTrack]) : undefined;
  }

  /** current local screen-share stream (for rendering onto an in-scene screen) */
  get screenMediaStream(): MediaStream | undefined { return this.screenStream; }

  /** a connected peer's incoming media stream (undefined if not connected yet) */
  getPeerStream(peerId: string): MediaStream | undefined {
    return this.peers.get(peerId)?.remote;
  }

  hasPeer(peerId: string) { return this.peers.has(peerId); }

  /** hide/show a peer's small tile (used when their video is routed to the in-scene screen) */
  hidePeerTile(peerId: string, hidden: boolean) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.hidden = hidden;
    this.paintTile(peerId);
  }

  /**
   * Show the thumbnail only while there is a picture in it.
   *
   * The element stays in the document either way — audio plays perfectly well
   * out of a display:none video, and that is how a presenter's voice keeps
   * coming through while their picture is routed to the screen on the wall.
   */
  private paintTile(peerId: string) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const show = !peer.hidden && hasLiveVideo(peer.video.srcObject as MediaStream | null);
    if (show) void peer.video.play().catch(() => { /* it is muted; nothing to hear either way */ });
    peer.video.style.display = show ? "block" : "none";
    peer.tile.style.display = show ? "block" : "none";
  }

  /** set a peer's playback volume 0..1 (spatial audio by distance) */
  setPeerVolume(peerId: string, vol: number) {
    const peer = this.peers.get(peerId);
    if (peer) peer.sound.volume = Math.max(0, Math.min(1, vol));
  }

  async setSpeaker(id: string) {
    this.selSpk = id;
    for (const { sound } of this.peers.values()) {
      const a = sound as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (a.setSinkId) await a.setSinkId(id).catch(() => {});
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
    // Whatever we hold at this moment: the relay if its credentials have arrived,
    // STUN alone if they have not. loadIce() keeps the answer fresh in the
    // background, so a call that starts before it lands still gets the upgrade.
    void loadIce();
    const pc = new RTCPeerConnection(iceConfig());
    const polite = this.myId > peerId;                 // deterministic role
    const { tile, video, sound } = this.makeTile(peerId);

    /**
     * One slot for the voice and one for the picture, opened now and kept for
     * the life of the connection — empty if there is nothing to put in them yet.
     *
     * Two things follow from that, and both were bugs.
     *
     * The connection negotiates immediately instead of waiting for somebody to
     * turn a device on. A peer with no track fires no negotiationneeded, so a
     * person who walked back into the room and then reached for the microphone
     * was starting ICE, DTLS and an SDP exchange at the moment they began
     * talking — seconds of it, with the room hearing nothing. Now all of that is
     * finished while they are still walking, and turning the microphone on is
     * `replaceTrack` on a live connection: no renegotiation at all.
     *
     * And everything leaves under one stream id. addTrack was tagging the screen
     * share with the screen's own MediaStream, so the far side got a SECOND
     * stream and `srcObject = streams[0]` replaced the one carrying the voice.
     * Anybody who shared their screen with the camera off went silent — which is
     * everybody, because sharing a screen is when you stop pointing a camera at
     * yourself.
     */
    const peer: Peer = {
      pc, polite, makingOffer: false, ignoreOffer: false,
      tile, video, sound, remote: new MediaStream(),
    };
    this.peers.set(peerId, peer);

    const offer = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.signal(peerId, "desc", plainDesc(pc.localDescription));
      } catch (e) { console.warn("negotiation", e); }
      finally { peer.makingOffer = false; }
    };
    pc.onnegotiationneeded = () => void offer();

    /**
     * One side opens the conversation; the other answers into the same slots.
     *
     * Both sides making their own pair meant both offered at the same instant on
     * every connection, and Chrome never reuses a slot that was waiting when an
     * offer arrives — measured, every arrangement of it: two slots in, four
     * slots out. So the connection carried two pairs, each side sending on its
     * own and receiving on the other's, and the settling was racy: three runs of
     * the probe, two of which took longer than twelve seconds to pass audio.
     *
     * Adopting instead gives one pair. The opener is the impolite peer, which is
     * already the deterministic role perfect negotiation needs, so the two can
     * never disagree about who goes first.
     */
    if (polite) {
      // Proximity is symmetric, so somebody is already offering. A connection
      // forced open for a screen share need not be, so the wait has an end.
      peer.openTimer = window.setTimeout(() => {
        peer.openTimer = undefined;
        this.openSlots(peer);
      }, 1500);
    } else {
      this.openSlots(peer);
    }
    pc.onsignalingstatechange = () => {
      if (pc.signalingState === "stable") this.reconcileSlots(peer);
    };
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.signal(peerId, "ice", candidate.toJSON()); };
    pc.ontrack = ({ track, streams, receiver }) => {
      // Ask for the shortest playout the link allows. Chrome grows this delay
      // after a rough patch and does not shrink it again, which is how a
      // conversation ends up running a long way behind the room.
      const live = receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null; playoutDelayHint?: number | null };
      try { if ("jitterBufferTarget" in live) live.jitterBufferTarget = 0; } catch { /* not supported */ }
      try { if ("playoutDelayHint" in live) live.playoutDelayHint = 0; } catch { /* not supported */ }
      /**
       * Group by the stream the far side named, and fall back to gathering the
       * tracks ourselves when it named none.
       *
       * setStreams is what puts the stream id on an adopted slot, and it is not
       * everywhere — Safari only got it in 15.4. Without it the answer carries
       * no msid, `streams` arrives empty, and assigning streams[0] would blank
       * the element that was already playing this person's voice. Collecting the
       * tracks into one stream of our own is the same end result by another
       * route, and costs nothing when the msid is there.
       */
      const carrier = streams[0] ?? peer.remote;
      if (!carrier.getTracks().includes(track)) carrier.addTrack(track);
      peer.remote = carrier;                     // what the scene reads

      // Sorted by kind, because the two elements must not share a stream: the
      // picture stalls on a video track with no frames, and would take the
      // voice with it.
      const target: HTMLMediaElement = track.kind === "audio" ? sound : video;
      const own = target.srcObject instanceof MediaStream ? target.srcObject : new MediaStream();
      if (!own.getTracks().includes(track)) own.addTrack(track);
      if (target.srcObject !== own) target.srcObject = own;
      // Both slots arrive the moment the connection is made, empty and muted, so
      // "a track exists" no longer means "there is something to look at" — and
      // mute/unmute is how a camera or a screen now starts and stops, since the
      // slot itself never goes away. Everything that draws has to follow that.
      const changed = () => {
        this.paintTile(peerId);
        this.play(peerId);
        this.onPeerStream?.(peerId);
      };
      track.onunmute = changed;
      track.onmute = changed;
      track.onended = changed;
      changed();
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      // A first attempt can fail because it was made before the relay
      // credentials arrived, or on a route that has since died. Restarting ICE
      // re-gathers with whatever we know now — including the relay — and costs
      // one round trip. Only once: a second failure is a real one, and retrying
      // forever would rebuild the connection the audio has to catch up from.
      if (st === "failed" && !peer.retried) {
        peer.retried = true;
        try { peer.pc.setConfiguration(iceConfig()); } catch { /* older browser */ }
        try { pc.restartIce(); return; } catch { /* fall through to teardown */ }
      }
      if (st === "failed" || st === "closed") return this.disconnect(peerId);
      // "disconnected" is usually a blip that ICE recovers from on its own.
      // Tearing the connection down here meant a lost packet cost a rebuild, and
      // a rebuild is what the audio has to catch up from.
      if (st === "disconnected") { peer.droppedAt = Date.now(); return; }
      if (st === "connected") {
        peer.droppedAt = undefined;
        this.play(peerId);
        console.log(`[webrtc] ${peerId} connected —`,
          pc.getTransceivers().map((tx) => `${tx.receiver.track.kind}:${tx.currentDirection}`).join(" "));
      }
    };
  }

  /** make our own pair of outgoing slots, which is what produces the offer */
  private openSlots(peer: Peer) {
    if (peer.micSender) return;
    peer.micSender = peer.pc.addTransceiver("audio", { direction: "sendrecv", streams: [this.local] }).sender;
    peer.vidSender = peer.pc.addTransceiver("video", { direction: "sendrecv", streams: [this.local] }).sender;
    this.fillSlots(peer);
  }

  /**
   * Take over the slots the other side's offer just created, rather than
   * answering into them recvonly and then opening a second pair of our own.
   *
   * Flipping the direction has to happen between setRemoteDescription and
   * setLocalDescription: it is the answer that tells the far side we intend to
   * send, and setStreams is what puts our stream id on it — without that the
   * far side gets `streams: []` and has nothing to attach.
   */
  private adoptSlots(peer: Peer) {
    if (peer.micSender) return;
    for (const tx of peer.pc.getTransceivers()) {
      const kind = tx.receiver.track.kind;
      if (kind === "audio" && !peer.micSender) { tx.direction = "sendrecv"; peer.micSender = tx.sender; }
      else if (kind === "video" && !peer.vidSender) { tx.direction = "sendrecv"; peer.vidSender = tx.sender; }
    }
    peer.micSender?.setStreams?.(this.local);
    peer.vidSender?.setStreams?.(this.local);
    this.fillSlots(peer);
  }

  /**
   * Point the two slots at transceivers that can actually send.
   *
   * A slot is only worth anything while the m-line under it is negotiated, and
   * that is not guaranteed by having created it. If both sides open at once —
   * which the wait below is meant to prevent and cannot promise, since a
   * backgrounded tab stops running the proximity pass altogether — the rollback
   * that resolves the collision leaves a transceiver attached to nothing.
   * `currentDirection` reads null, `replaceTrack` still succeeds, the level
   * meter still moves, and not one packet leaves. That is a person talking to a
   * room that cannot hear them, with nothing on their screen to say so.
   *
   * So the senders are re-derived every time the connection settles rather than
   * trusted from when they were made. A slot that went nowhere is swapped for
   * one that goes somewhere; if the only ones left are receive-only, one is
   * turned around, which costs a renegotiation and is worth it.
   */
  private reconcileSlots(peer: Peer) {
    const sends = (tx: RTCRtpTransceiver) =>
      tx.currentDirection === "sendrecv" || tx.currentDirection === "sendonly";
    const all = peer.pc.getTransceivers();
    let repaired = false;

    for (const kind of ["audio", "video"] as const) {
      const key = kind === "audio" ? "micSender" : "vidSender";
      const held = all.find((tx) => tx.sender === peer[key]);
      if (held && sends(held)) continue;                       // still carries

      const working = all.find((tx) => tx.receiver.track.kind === kind && sends(tx));
      if (working) { peer[key] = working.sender; repaired = true; continue; }

      const listening = all.find((tx) => tx.receiver.track.kind === kind && tx.currentDirection === "recvonly");
      if (listening) {
        listening.direction = "sendrecv";                      // renegotiates
        listening.sender.setStreams?.(this.local);
        peer[key] = listening.sender;
        repaired = true;
      }
    }
    // Unconditional, not only when a slot moved: a sender can also simply have
    // lost its track. replaceTrack with the track already in place resolves
    // without renegotiating, so this is free when there is nothing wrong.
    void repaired;
    this.fillSlots(peer);
  }

  /** put whatever this person currently has switched on into the slots */
  private fillSlots(peer: Peer) {
    if (this.micTrack) void peer.micSender?.replaceTrack(this.micTrack);
    const picture = this.screenOn ? this.screenStream?.getVideoTracks()[0] : this.camTrack;
    if (picture) void peer.vidSender?.replaceTrack(picture);
  }

  private disconnect(peerId: string) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    if (peer.openTimer) clearTimeout(peer.openTimer);
    peer.pc.close();
    peer.sound.srcObject = null;
    peer.sound.remove();
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
    let peer = this.peers.get(from);
    /**
     * An offer from someone we have not connected to yet is an invitation, not
     * noise — accept it.
     *
     * Dropping it cost a returning speaker their voice for good. Whoever walks
     * owns their position, so they notice the distance closing a frame or two
     * before the other side does, and their offer arrives first. It used to land
     * on nothing. The other side then built its own connection but never
     * negotiated, because a peer with no track of its own — anyone whose mic is
     * off — has nothing to trigger negotiation with. So the speaker sat in
     * have-local-offer waiting for an answer nobody was going to send.
     *
     * That is also why it only happened one way round: when the listener was the
     * one walking, they built their connection first, and the speaker's later
     * offer had somewhere to land.
     *
     * Connecting here cannot pull in someone out of range: the proximity pass
     * runs every frame and drops anyone it does not want.
     */
    if (!peer && kind === "desc" && (payload as RTCSessionDescriptionInit)?.type === "offer") {
      this.connect(from);
      peer = this.peers.get(from);
    }
    if (!peer) return; // ice or an answer for a peer that is gone: nothing to apply it to
    const { pc } = peer;
    try {
      if (kind === "desc") {
        const offerCollision = payload.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(payload);
        if (peer.openTimer) { clearTimeout(peer.openTimer); peer.openTimer = undefined; }
        if (payload.type === "offer") {
          this.adoptSlots(peer);
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
    const { sound } = peer;
    sound.play().then(() => {
      peer.playedAt = performance.now();
      peer.playedFrom = sound.currentTime;
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
  /**
   * Is the voice we think we are sending actually leaving?
   *
   * Nothing on screen tells the difference between a microphone that is on and
   * a microphone that is on and heard. The level meter moves either way, and so
   * does replaceTrack. This is the only place that can tell, and it asks the
   * connection itself: with the microphone open and unmuted, outbound packets
   * must keep climbing.
   *
   * When they do not, the slots are re-derived. That repairs the case this was
   * written for — a sender left pointing at a transceiver that a rollback
   * detached — and costs nothing in every other case, because reconcileSlots
   * does nothing at all when the slots are sound. It is deliberately blind to
   * WHY the packets stopped: the point is to recover without needing to have
   * predicted the reason.
   */
  private async guardSending(id: string, peer: Peer) {
    if (!this.micOn || !this.micTrack?.enabled) { peer.lastSent = undefined; return; }
    let sent = 0;
    try {
      (await peer.pc.getStats()).forEach((r: any) => {
        if (r.type === "outbound-rtp" && r.kind === "audio") sent += r.packetsSent || 0;
      });
    } catch { return; }                       // closing
    const before = peer.lastSent;
    peer.lastSent = sent;
    if (before === undefined || sent > before) return;
    console.warn(`[webrtc] ${id}: microphone is open but nothing is leaving (${sent} packets) — repairing`);
    this.reconcileSlots(peer);
  }

  private guardLatency() {
    const now = performance.now();
    for (const [id, peer] of this.peers) {
      void this.guardSending(id, peer);
      // ICE said "disconnected" and never came back: give it a few seconds to
      // recover on its own, then rebuild rather than leaving a dead connection in
      // place. The next proximity pass reconnects if they are still in range.
      if (peer.droppedAt && Date.now() - peer.droppedAt > 8000) {
        console.warn(`[webrtc] ${id} stayed disconnected — rebuilding`);
        this.disconnect(id);
        continue;
      }
      const { sound } = peer;
      if (!(sound.srcObject instanceof MediaStream)) continue;
      // A connection that is up and carrying nothing — nobody has switched
      // anything on yet — has no playout to be behind on. Its element's clock
      // does not advance, so measuring it reports the whole idle period as lag
      // and re-attaches the stream every ten seconds for as long as the two
      // stand there saying nothing.
      if (!sound.srcObject.getTracks().some((tr) => tr.readyState === "live" && !tr.muted)) {
        peer.playedAt = peer.playedFrom = undefined;
        continue;
      }
      if (sound.paused) { this.play(id); continue; }
      if (peer.playedAt == null || peer.playedFrom == null) continue;
      const behind = (now - peer.playedAt) / 1000 - (sound.currentTime - peer.playedFrom);
      if (behind < 1.5) continue;
      // once every 10s at most: re-attaching is a small click in the audio, and a
      // link that is genuinely struggling should not be clicked at every check
      if (peer.lastFix && now - peer.lastFix < 10_000) continue;
      peer.lastFix = now;
      console.warn(`[webrtc] ${id} audio was ${behind.toFixed(1)}s behind — dropping the backlog`);
      const stream = sound.srcObject;
      sound.srcObject = null;
      sound.srcObject = stream;
      this.play(id);
    }
  }

  private makeTile(peerId: string): { tile: HTMLElement; video: HTMLVideoElement; sound: HTMLAudioElement } {
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
    // Outside the tile, not inside it: the tile is hidden whenever there is no
    // picture, and the sound must not depend on anything the layout does.
    const sound = document.createElement("audio");
    sound.autoplay = true;
    this.tilesEl.append(sound);
    const a = sound as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (this.selSpk && a.setSinkId) a.setSinkId(this.selSpk).catch(() => {});
    // The picture never carries sound, so the two can never both play it.
    video.muted = true;
    return { tile, video, sound };
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
