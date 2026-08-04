// Common interface implemented by both media backends:
//   WebRTCManager (P2P mesh, no media server)  and  LiveKitManager (SFU).
// The scene talks to whichever one via this shape, so switching is transparent.
export interface MediaManager {
  micOn: boolean;
  camOn: boolean;
  screenOn: boolean;
  selMic?: string;
  selCam?: string;
  selSpk?: string;
  onState?: () => void;
  onPeerStream?: (peerId: string) => void;
  onScreenEnd?: () => void;

  /** hide/show a peer's small tile (when their video is routed to the in-scene screen) */
  hidePeerTile(peerId: string, hidden: boolean): void;

  toggleMic(): Promise<void> | void;
  toggleCam(): Promise<void> | void;
  toggleScreen(): Promise<void> | void;

  /** reconcile who we should be connected to / hear. `nearby` = proximity peers;
   *  `forced` = peers to stay connected to regardless of distance (screen-share). */
  syncPeers(nearby: Set<string>, forced?: Set<string>): void;
  /** 0..1 playback volume for a peer (spatial audio by distance) */
  setPeerVolume(peerId: string, vol: number): void;
  /** a peer's incoming stream (e.g. their screen-share) for the in-scene screen */
  getPeerStream(peerId: string): MediaStream | undefined;
  readonly screenMediaStream: MediaStream | undefined;

  devices(): Promise<{ mics: MediaDeviceInfo[]; cams: MediaDeviceInfo[]; speakers: MediaDeviceInfo[] }>;
  setMic(id: string): Promise<void> | void;
  setCam(id: string): Promise<void> | void;
  setSpeaker(id: string): Promise<void> | void;

  dispose(): void;
}
