import { createHmac } from "crypto";

/**
 * Where browsers should look for a way through to each other.
 *
 * STUN only tells a browser its own public address; it cannot help when both
 * ends sit behind a NAT that refuses unsolicited packets, which is the normal
 * state of a corporate network. Then the only route left is a relay — a TURN
 * server both sides can reach outbound — and without one the call fails with no
 * error anyone can see: the peer connection simply never leaves "checking".
 *
 * The relay costs bandwidth, so it must not be open to the world. It is not
 * given a fixed password either: a password shipped to every browser is a
 * password published. Instead coturn is run with a shared secret it never hands
 * out, and this file mints credentials from it that stop working on their own —
 * the username IS the expiry time, and the password is that username signed with
 * the secret. coturn recomputes the same signature to check it, so no state and
 * no accounts are needed on either side.
 *
 * (RFC draft "A REST API For Access To TURN Services", the scheme coturn calls
 * `use-auth-secret`.)
 */

const SECRET = process.env.TURN_SECRET || "";
const HOST = process.env.TURN_HOST || "";
const PORT = Number(process.env.TURN_PORT || 3478);
/** 0 turns the TLS entry off — it needs a certificate the plain port does not */
const TLS_PORT = Number(process.env.TURN_TLS_PORT || 0);
/**
 * Long by default. A credential is checked when the relay is allocated AND on
 * every refresh that keeps it alive, so one that expires mid-meeting takes the
 * call down with it. Twelve hours outlasts any working day; the secret, not the
 * clock, is what keeps the relay closed to strangers.
 */
const TTL = Number(process.env.TURN_TTL || 43200);
const STUN = process.env.STUN_URL || "stun:stun.l.google.com:19302";

/** Whether this deployment has a relay at all. Without it calls still work for
 *  everyone whose network allows a direct path — which is most home networks. */
export const turnEnabled = !!(SECRET && HOST);

export interface IceConfig {
  iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  /** seconds until the credential above stops being accepted */
  ttl: number;
  /** so the client can say "no relay configured" rather than guess */
  relay: boolean;
}

/**
 * @param who anything that identifies the caller in the TURN log. It is not
 *            checked by coturn — the signature is — but it makes an abusive
 *            session traceable back to an account.
 */
export function iceConfig(who: string): IceConfig {
  const servers: IceConfig["iceServers"] = [{ urls: STUN }];
  if (!turnEnabled) return { iceServers: servers, ttl: 0, relay: false };

  const expiry = Math.floor(Date.now() / 1000) + TTL;
  const username = `${expiry}:${who}`;
  const credential = createHmac("sha1", SECRET).update(username).digest("base64");

  // Both transports, because they fail in different places: UDP is refused by
  // firewalls that block anything but TCP, and TCP is the slower path nobody
  // wants unless UDP is gone. The browser tries them in parallel and keeps
  // whichever answers first.
  const urls = [`turn:${HOST}:${PORT}?transport=udp`, `turn:${HOST}:${PORT}?transport=tcp`];
  if (TLS_PORT) urls.push(`turns:${HOST}:${TLS_PORT}?transport=tcp`);

  servers.push({ urls, username, credential });
  return { iceServers: servers, ttl: TTL, relay: true };
}
