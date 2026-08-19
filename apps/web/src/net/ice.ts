import { API, authHeaders } from "../api";

/**
 * Where this browser should look for a route to the others.
 *
 * The relay's password is minted per session and expires, so it cannot be baked
 * into the bundle — it has to be asked for. That makes it arrive late: a peer
 * two tiles away may connect before the answer does. So this module always has
 * an answer ready (STUN alone, which is enough on most home networks) and hands
 * out the better one as soon as it lands. WebRTCManager applies the upgrade to
 * connections that are already open.
 */

const FALLBACK: RTCConfiguration = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

let current: RTCConfiguration = FALLBACK;
let goodUntil = 0;      // epoch ms; 0 = nothing fetched yet
let inFlight: Promise<RTCConfiguration> | null = null;
let hasRelay = false;

/** Refresh this long before the credential actually dies, so a call in progress
 *  never has to find out the hard way. */
const EARLY = 30 * 60 * 1000;

/** The configuration to build a peer connection with, right now. Never null. */
export const iceConfig = () => current;

/** Whether the answer we hold includes a relay. Used for the "why can nobody
 *  hear me" message, which is otherwise a mystery to the person it happens to. */
export const iceHasRelay = () => hasRelay;

/**
 * Fetch credentials, or return the ones already held if they are still fresh.
 * Failure is not an error worth showing: it leaves STUN in place, which is what
 * this app ran on before there was a relay at all.
 */
export function loadIce(force = false): Promise<RTCConfiguration> {
  if (!force && goodUntil && Date.now() < goodUntil - EARLY) return Promise.resolve(current);
  if (inFlight) return inFlight;

  // A guest holds no session — the code in their link is their credential, the
  // same one the room itself checks.
  const guest = new URLSearchParams(location.search).get("g") || "";
  const url = `${API}/ice${guest ? `?guest=${encodeURIComponent(guest)}` : ""}`;

  inFlight = fetch(url, { headers: authHeaders() })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`ice ${r.status}`))))
    .then((d: { iceServers?: RTCIceServer[]; ttl?: number; relay?: boolean }) => {
      if (!d.iceServers?.length) throw new Error("ice: empty answer");
      current = { iceServers: d.iceServers };
      hasRelay = !!d.relay;
      // ttl 0 means "no relay, nothing here expires" — ask again in an hour
      // anyway, in case one is configured while the tab is still open.
      goodUntil = Date.now() + (d.ttl ? d.ttl * 1000 : 3600_000);
      if (!hasRelay) console.warn("[ice] no relay configured on the server — a strict firewall will block calls");
      return current;
    })
    .catch((e) => {
      console.warn("[ice] falling back to STUN only:", e);
      goodUntil = Date.now() + 60_000; // retry soon, but do not hammer
      return current;
    })
    .finally(() => { inFlight = null; });

  return inFlight;
}
