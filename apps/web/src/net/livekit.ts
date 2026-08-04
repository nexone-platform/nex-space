// LiveKit SFU backend. Everyone joins one media room; audio is spatial (volume by
// distance), camera is proximity-gated (subscribe only nearby), and screen-share is
// room-wide (everyone subscribes -> the in-scene screen is visible to all).
import {
  Room, RoomEvent, Track,
  type RemoteTrack, type RemoteParticipant,
} from "livekit-client";
import type { MediaManager } from "./media";

export class LiveKitManager implements MediaManager {
  private room: Room;
  micOn = false; camOn = false; screenOn = false;
  selMic?: string; selCam?: string; selSpk?: string;
  onState?: () => void;
  onPeerStream?: (peerId: string) => void;
  onScreenEnd?: () => void;
  private tiles = new Map<string, HTMLElement>();      // identity -> camera tile
  private audios = new Map<string, HTMLAudioElement>(); // identity -> hidden audio el

  constructor(private tilesEl: HTMLElement) {
    this.room = new Room({ adaptiveStream: true, dynacast: true });
    this.room
      .on(RoomEvent.TrackSubscribed, (t, _p, participant) => this.onSub(t, participant as RemoteParticipant))
      .on(RoomEvent.TrackUnsubscribed, (t, _p, participant) => this.onUnsub(t, participant as RemoteParticipant))
      .on(RoomEvent.ParticipantDisconnected, (p) => this.cleanup(p.identity));
  }

  async connect(url: string, token: string) { await this.room.connect(url, token); }

  private onSub(track: RemoteTrack, p: RemoteParticipant) {
    const id = p.identity;
    if (track.kind === "audio") {
      const el = track.attach() as HTMLAudioElement;
      el.style.display = "none"; document.body.appendChild(el);
      this.audios.set(id, el);
      const s = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (this.selSpk && s.setSinkId) s.setSinkId(this.selSpk).catch(() => {});
    } else if (track.source === Track.Source.ScreenShare) {
      this.onPeerStream?.(id); // scene pulls getPeerStream() onto the in-scene screen (room-wide)
    } else {
      this.showCamTile(id, p, track);
    }
  }

  private onUnsub(track: RemoteTrack, p: RemoteParticipant) {
    const id = p.identity;
    if (track.kind === "audio") { this.audios.get(id)?.remove(); this.audios.delete(id); }
    else if (track.source === Track.Source.ScreenShare) this.onPeerStream?.(id);
    else this.removeCamTile(id);
  }

  private showCamTile(id: string, p: RemoteParticipant, track: RemoteTrack) {
    this.removeCamTile(id);
    const tile = document.createElement("div");
    tile.style.cssText = "position:relative;border-radius:8px;overflow:hidden;background:#2b303b;aspect-ratio:4/3;box-shadow:0 2px 8px #0003;";
    const video = track.attach() as HTMLVideoElement;
    video.style.cssText = "width:100%;height:100%;object-fit:cover;";
    const name = document.createElement("div");
    name.textContent = p.name || id.slice(0, 6);
    name.style.cssText = "position:absolute;left:6px;bottom:4px;color:#fff;font:11px sans-serif;text-shadow:0 1px 2px #000;";
    tile.append(video, name); this.tilesEl.append(tile);
    this.tiles.set(id, tile);
  }
  private removeCamTile(id: string) { this.tiles.get(id)?.remove(); this.tiles.delete(id); }
  private cleanup(id: string) { this.removeCamTile(id); this.audios.get(id)?.remove(); this.audios.delete(id); }

  // ---- MediaManager ----
  async toggleMic() { this.micOn = !this.micOn; await this.room.localParticipant.setMicrophoneEnabled(this.micOn); this.onState?.(); }
  async toggleCam() { this.camOn = !this.camOn; await this.room.localParticipant.setCameraEnabled(this.camOn); this.renderSelf(); this.onState?.(); }
  async toggleScreen() { this.screenOn = !this.screenOn; await this.room.localParticipant.setScreenShareEnabled(this.screenOn); this.renderSelf(); this.onState?.(); }

  // `forced` is unused: the SFU auto-subscribes screen-share tracks room-wide already
  syncPeers(nearby: Set<string>, _forced?: Set<string>) {
    this.room.remoteParticipants.forEach((p) => {
      const near = nearby.has(p.identity);
      p.getTrackPublication(Track.Source.Camera)?.setSubscribed(near); // pull video only when near
      if (!near) { p.setVolume(0); this.removeCamTile(p.identity); }   // far = silent, no video
    });
  }
  setPeerVolume(id: string, vol: number) {
    this.room.remoteParticipants.get(id)?.setVolume(Math.max(0, Math.min(1, vol)));
  }
  hidePeerTile(id: string, hidden: boolean) {
    const t = this.tiles.get(id);
    if (t) t.style.display = hidden ? "none" : "block";
  }
  getPeerStream(id: string): MediaStream | undefined {
    const t = this.room.remoteParticipants.get(id)?.getTrackPublication(Track.Source.ScreenShare)?.track?.mediaStreamTrack;
    return t ? new MediaStream([t]) : undefined;
  }
  get screenMediaStream(): MediaStream | undefined {
    const t = this.room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track?.mediaStreamTrack;
    return t ? new MediaStream([t]) : undefined;
  }

  async devices() {
    const list = await navigator.mediaDevices.enumerateDevices();
    return {
      mics: list.filter((d) => d.kind === "audioinput"),
      cams: list.filter((d) => d.kind === "videoinput"),
      speakers: list.filter((d) => d.kind === "audiooutput"),
    };
  }
  async setMic(id: string) { this.selMic = id; await this.room.switchActiveDevice("audioinput", id); }
  async setCam(id: string) { this.selCam = id; await this.room.switchActiveDevice("videoinput", id); this.renderSelf(); }
  async setSpeaker(id: string) { this.selSpk = id; await this.room.switchActiveDevice("audiooutput", id).catch(() => {}); }

  dispose() {
    this.tiles.forEach((t) => t.remove());
    this.audios.forEach((a) => a.remove());
    document.getElementById("tile-self")?.remove();
    void this.room.disconnect();
  }

  private renderSelf() {
    let self = document.getElementById("tile-self") as HTMLElement | null;
    if (!(this.camOn || this.screenOn)) { self?.remove(); return; }
    if (!self) {
      self = document.createElement("div"); self.id = "tile-self";
      self.style.cssText = "position:relative;border-radius:8px;overflow:hidden;background:#2b303b;aspect-ratio:4/3;border:2px solid #2bb3a3;";
      const n = document.createElement("div"); n.textContent = "You";
      n.style.cssText = "position:absolute;left:6px;bottom:4px;color:#fff;font:11px sans-serif;text-shadow:0 1px 2px #000;";
      self.append(n); this.tilesEl.prepend(self);
    }
    self.querySelector("video")?.remove();
    const src = this.screenOn ? Track.Source.ScreenShare : Track.Source.Camera;
    const track = this.room.localParticipant.getTrackPublication(src)?.track;
    if (track) {
      const v = track.attach() as HTMLVideoElement; v.muted = true;
      v.style.cssText = "width:100%;height:100%;object-fit:cover;" + (this.screenOn ? "" : "transform:scaleX(-1);");
      self.prepend(v);
    }
  }
}
