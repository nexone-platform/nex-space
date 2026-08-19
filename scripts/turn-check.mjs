#!/usr/bin/env node
/**
 * Prove the relay works, rather than that it was configured.
 *
 * A misconfigured TURN server fails silently in exactly the way a working one
 * succeeds quietly: the container is up, the port answers a ping, and calls
 * still drop. The difference only shows in whether a browser can actually
 * ALLOCATE a relay address — which needs the credential to verify, the UDP port
 * range to be open, and the server to know its own public address. This script
 * does what the browser does, from the outside, and says which of those failed.
 *
 * It speaks enough STUN (RFC 5389) and TURN (RFC 5766) by hand to do three
 * things, no dependencies:
 *
 *   1. Binding      — is anything there, and what does it think our address is
 *   2. Allocate     — mint a credential the way the API does, and get a relay
 *   3. Permission   — ask to reach 127.0.0.1 and check it is REFUSED
 *
 * The third one matters as much as the second. A relay that forwards packets to
 * private addresses is a hole straight into the machine it runs on.
 *
 *   node scripts/turn-check.mjs                       # reads .env
 *   node scripts/turn-check.mjs --host=turn.example --secret=... --port=3478
 */
import { createSocket } from "dgram";
import { resolve4 } from "dns/promises";
import { createHmac, createHash, randomBytes } from "crypto";
import { readFileSync } from "fs";

// ---- settings ---------------------------------------------------------------

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, "").split("="); return [k, v.join("=") || "true"]; }),
);

const dotenv = (() => {
  try {
    return Object.fromEntries(
      readFileSync(new URL("../.env", import.meta.url), "utf8")
        .split("\n")
        .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
        .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
    );
  } catch { return {}; }
})();

const HOST = args.host || process.env.TURN_HOST || dotenv.TURN_HOST || "";
const PORT = Number(args.port || process.env.TURN_PORT || dotenv.TURN_PORT || 3478);
const SECRET = args.secret || process.env.TURN_SECRET || dotenv.TURN_SECRET || "";
const TTL = Number(args.ttl || 600);
const TIMEOUT = Number(args.timeout || 4000);

// A relay run the other way — with named users rather than a shared secret — can
// be checked by handing the pair over directly. It is also how this script gets
// pointed at somebody else's relay to prove the flow itself is right.
const FIXED_USER = args.username || "";
const FIXED_PASS = args.password || "";

if (!HOST || (!SECRET && !FIXED_PASS)) {
  console.error("turn-check: need a host, and either a secret or a username and password.\n" +
    "  put TURN_HOST and TURN_SECRET in .env, or pass --host= --secret=\n" +
    "  or, for a relay with fixed users:  --host= --username= --password=");
  process.exit(2);
}

// ---- STUN/TURN wire format --------------------------------------------------

const COOKIE = 0x2112a442;
const M = { BINDING: 0x0001, ALLOCATE: 0x0003, PERMISSION: 0x0008 };
const A = {
  ERROR_CODE: 0x0009, LIFETIME: 0x000d, XOR_PEER: 0x0012, REALM: 0x0014, NONCE: 0x0015,
  XOR_RELAYED: 0x0016, REQUESTED_TRANSPORT: 0x0019, XOR_MAPPED: 0x0020,
  USERNAME: 0x0006, MESSAGE_INTEGRITY: 0x0008,
};

const pad4 = (n) => (n + 3) & ~3;

function attr(type, value) {
  const b = Buffer.alloc(4 + pad4(value.length));
  b.writeUInt16BE(type, 0);
  b.writeUInt16BE(value.length, 2);   // length excludes the padding, per the RFC
  value.copy(b, 4);
  return b;
}

/** address attribute value, XORed with the cookie the way STUN requires */
function xorAddr(ip, port) {
  const v = Buffer.alloc(8);
  v.writeUInt8(0, 0);
  v.writeUInt8(1, 1);                                   // family: IPv4
  v.writeUInt16BE(port ^ (COOKIE >>> 16), 2);
  const octets = ip.split(".").map(Number);
  for (let i = 0; i < 4; i++) v.writeUInt8(octets[i] ^ ((COOKIE >>> (8 * (3 - i))) & 0xff), 4 + i);
  return v;
}

function message(method, txn, attrs = []) {
  const body = Buffer.concat(attrs);
  const head = Buffer.alloc(20);
  head.writeUInt16BE(method, 0);
  head.writeUInt16BE(body.length, 2);
  head.writeUInt32BE(COOKIE, 4);
  txn.copy(head, 8);
  return Buffer.concat([head, body]);
}

/**
 * Sign a message the long-term way: the key is a digest of the credential and
 * the realm, and the signature covers the message as if the signature attribute
 * were already on the end — so the length field is written forward before the
 * bytes it describes exist. Getting that order wrong is the classic reason a
 * hand-written STUN client is rejected with 401 forever.
 */
function withIntegrity(method, txn, attrs, username, realm, password) {
  const key = createHash("md5").update(`${username}:${realm}:${password}`).digest();
  const body = Buffer.concat(attrs);
  const head = Buffer.alloc(20);
  head.writeUInt16BE(method, 0);
  head.writeUInt16BE(body.length + 24, 2);      // + the MESSAGE-INTEGRITY attribute
  head.writeUInt32BE(COOKIE, 4);
  txn.copy(head, 8);
  const mac = createHmac("sha1", key).update(Buffer.concat([head, body])).digest();
  return Buffer.concat([head, body, attr(A.MESSAGE_INTEGRITY, mac)]);
}

function parse(buf) {
  const out = { type: buf.readUInt16BE(0), attrs: {} };
  let i = 20;
  const end = 20 + buf.readUInt16BE(2);
  while (i + 4 <= end && i + 4 <= buf.length) {
    const type = buf.readUInt16BE(i);
    const len = buf.readUInt16BE(i + 2);
    out.attrs[type] = buf.subarray(i + 4, i + 4 + len);
    i += 4 + pad4(len);
  }
  return out;
}

const readXorAddr = (v) => {
  if (!v || v.length < 8) return null;
  const port = v.readUInt16BE(2) ^ (COOKIE >>> 16);
  const ip = [...v.subarray(4, 8)].map((b, i) => b ^ ((COOKIE >>> (8 * (3 - i))) & 0xff)).join(".");
  return `${ip}:${port}`;
};

const readError = (v) => (v && v.length >= 4 ? { code: v.readUInt8(2) * 100 + v.readUInt8(3), reason: v.subarray(4).toString() } : null);

// ---- transport --------------------------------------------------------------

const sock = createSocket("udp4");
const pending = new Map();

sock.on("message", (buf) => {
  if (buf.length < 20) return;
  const txn = buf.subarray(8, 20).toString("hex");
  const waiter = pending.get(txn);
  if (waiter) { pending.delete(txn); waiter.resolve({ msg: parse(buf), at: Date.now() }); }
});

function send(buf, txn) {
  return new Promise((resolve, reject) => {
    const key = txn.toString("hex");
    const timer = setTimeout(() => { pending.delete(key); reject(new Error("no answer within " + TIMEOUT + "ms")); }, TIMEOUT);
    pending.set(key, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
    sock.send(buf, PORT, HOST, (e) => { if (e) { clearTimeout(timer); pending.delete(key); reject(e); } });
  });
}

// ---- the three questions ----------------------------------------------------

let failures = 0;
const say = (ok, label, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "! FAIL"}  ${label}${detail ? "  —  " + detail : ""}`);
};

/**
 * Ranges that answer for a website but never forward a relay.
 *
 * A domain behind a CDN resolves to the CDN, which proxies HTTP and drops
 * everything else — so the site loads perfectly while TURN gets no answer at
 * all. It is the most confusing way this can fail, because every other sign
 * says the host is fine. The list is short and not exhaustive; it exists to
 * name the usual suspect, not to police the internet.
 */
const PROXIES = [
  { name: "Cloudflare", nets: ["104.16.", "104.17.", "104.18.", "104.19.", "104.20.", "104.21.", "104.22.", "104.23.", "104.24.", "104.25.", "104.26.", "104.27.", "172.64.", "172.65.", "172.66.", "172.67.", "162.159.", "198.41."] },
  { name: "Fastly", nets: ["151.101."] },
];
const proxyFor = (ip) => PROXIES.find((p) => p.nets.some((n) => ip.startsWith(n)))?.name;

async function main() {
  console.log(`\nturn-check  ${HOST}:${PORT}\n`);

  // 0. where does that name actually point
  let addresses = [];
  try {
    addresses = /^[\d.]+$/.test(HOST) ? [HOST] : await resolve4(HOST);
    const proxied = addresses.map(proxyFor).find(Boolean);
    say(!proxied, "the name points at a machine that can relay",
      proxied
        ? `${HOST} → ${addresses.join(", ")} — that is ${proxied}, which proxies web traffic and drops the rest`
        : addresses.join(", "));
    if (proxied) {
      console.log(`
  A relay has to be reached directly. ${proxied} answers for the website, so the
  site works and this does not — nothing here is wrong except the address.

  Give the relay a name of its own that points straight at the server, with the
  proxy turned OFF for that record (a grey cloud, not an orange one):

      turn.${HOST.split(".").slice(-2).join(".")}   A   <the server's own public address>

  then set TURN_HOST to it and restart the API.
`);
      sock.close();
      process.exit(1);
    }
  } catch (e) {
    say(false, "the name resolves", `${HOST}: ${e.code || e.message}`);
    sock.close();
    process.exit(1);
  }

  // 1. is it there
  let reflexive = null;
  try {
    const txn = randomBytes(12);
    const t0 = Date.now();
    const { msg } = await send(message(M.BINDING, txn), txn);
    reflexive = readXorAddr(msg.attrs[A.XOR_MAPPED]);
    say(msg.type === 0x0101 && !!reflexive, "answers STUN", `${Date.now() - t0}ms, sees us as ${reflexive}`);
  } catch (e) {
    say(false, "answers STUN", e.message);
    console.log("\n  Nothing is listening, or the port is closed on the way in.\n" +
      `  Check:  docker compose ps nexspace-turn   and that UDP ${PORT} is open.\n`);
    sock.close();
    process.exit(1);
  }

  // 2. the credential, minted exactly as the API mints it
  const username = FIXED_USER || `${Math.floor(Date.now() / 1000) + TTL}:turn-check`;
  const password = FIXED_PASS || createHmac("sha1", SECRET).update(username).digest("base64");
  const transport = Buffer.from([17, 0, 0, 0]); // UDP

  let realm, nonce;
  try {
    const txn = randomBytes(12);
    const { msg } = await send(message(M.ALLOCATE, txn, [attr(A.REQUESTED_TRANSPORT, transport)]), txn);
    const err = readError(msg.attrs[A.ERROR_CODE]);
    realm = msg.attrs[A.REALM]?.toString();
    nonce = msg.attrs[A.NONCE];
    // 401 with a realm and a nonce is the correct answer to an unsigned request:
    // it means the relay is closed to anyone without a credential.
    say(err?.code === 401 && !!realm && !!nonce, "refuses an unauthenticated allocation",
      err ? `${err.code} ${err.reason}, realm "${realm}"` : "no error attribute");
    if (!realm || !nonce) { sock.close(); process.exit(1); }
  } catch (e) {
    // It answered a Binding but not an Allocate: something is listening here,
    // but it is a plain STUN server rather than a relay.
    say(false, "refuses an unauthenticated allocation", e.message + " — is this a STUN-only server?");
    sock.close();
    process.exit(1);
  }

  let relayed = null;
  {
    const txn = randomBytes(12);
    const attrs = [
      attr(A.REQUESTED_TRANSPORT, transport),
      attr(A.USERNAME, Buffer.from(username)),
      attr(A.REALM, Buffer.from(realm)),
      attr(A.NONCE, nonce),
    ];
    const { msg } = await send(withIntegrity(M.ALLOCATE, txn, attrs, username, realm, password), txn);
    const err = readError(msg.attrs[A.ERROR_CODE]);
    relayed = readXorAddr(msg.attrs[A.XOR_RELAYED]);
    const lifetime = msg.attrs[A.LIFETIME]?.readUInt32BE(0);
    say(msg.type === 0x0103 && !!relayed, "allocates a relay with a minted credential",
      relayed ? `relay at ${relayed}, ${lifetime}s` : `${err?.code} ${err?.reason}`);
    if (!relayed) {
      console.log("\n  The credential was rejected. The secret here and the one coturn was\n" +
        "  started with must be the same string — check TURN_SECRET in .env and\n" +
        "  restart the relay after changing it.\n");
      sock.close();
      process.exit(1);
    }
    // The relayed address must be routable from outside. A private one here means
    // coturn is announcing an address only this machine can reach.
    const priv = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(relayed);
    say(!priv, "relay address is reachable from the internet",
      priv ? `${relayed} is private — set TURN_EXTERNAL_IP to the public address` : relayed);
  }

  // 3. the guard rail
  {
    const txn = randomBytes(12);
    const attrs = [
      attr(A.XOR_PEER, xorAddr("127.0.0.1", 9)),
      attr(A.USERNAME, Buffer.from(username)),
      attr(A.REALM, Buffer.from(realm)),
      attr(A.NONCE, nonce),
    ];
    const { msg } = await send(withIntegrity(M.PERMISSION, txn, attrs, username, realm, password), txn);
    const err = readError(msg.attrs[A.ERROR_CODE]);
    // 403 Forbidden IP is coturn saying the deny list is doing its job.
    say(err?.code === 403, "refuses to relay to a private address",
      err ? `${err.code} ${err.reason}` : "PERMITTED — the denied-peer-ip rules are missing");
  }

  sock.close();
  console.log(failures ? `\n${failures} check(s) failed\n` : "\nrelay is working\n");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("turn-check:", e.message); sock.close(); process.exit(1); });
