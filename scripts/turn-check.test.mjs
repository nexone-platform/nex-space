#!/usr/bin/env node
/**
 * Test the relay checker against a relay that is not real.
 *
 * turn-check.mjs writes STUN messages forward — header, attributes, then a
 * signature over what came before. This mock reads them backwards: it finds the
 * signature attribute in what arrived, rebuilds the bytes that were signed, and
 * recomputes the digest. The two directions are separate implementations of the
 * same rule, so agreement between them is evidence the rule is right, not two
 * copies of one mistake.
 *
 * Then it lies, in four different ways, to prove each check can actually fail:
 * a relay that never answers, one that rejects the credential, one that hands
 * back a private address, and one that happily agrees to relay into localhost.
 * A check that cannot fail is not a check.
 *
 *   node scripts/turn-check.test.mjs
 */
import { createSocket } from "dgram";
import { createHmac, createHash } from "crypto";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

// fileURLToPath, not URL.pathname: this repo lives under a directory with spaces
// in its name, and pathname hands them back percent-encoded — a path that exists
// nowhere.
const CHECKER = fileURLToPath(new URL("./turn-check.mjs", import.meta.url));

const COOKIE = 0x2112a442;
const A = {
  ERROR_CODE: 0x0009, LIFETIME: 0x000d, XOR_PEER: 0x0012, REALM: 0x0014, NONCE: 0x0015,
  XOR_RELAYED: 0x0016, XOR_MAPPED: 0x0020, USERNAME: 0x0006, MESSAGE_INTEGRITY: 0x0008,
};
const REALM = "nexspace-test";
const NONCE = "0123456789abcdef";

const pad4 = (n) => (n + 3) & ~3;

function attr(type, value) {
  const b = Buffer.alloc(4 + pad4(value.length));
  b.writeUInt16BE(type, 0);
  b.writeUInt16BE(value.length, 2);
  value.copy(b, 4);
  return b;
}
function pack(type, txn, attrs) {
  const body = Buffer.concat(attrs);
  const head = Buffer.alloc(20);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(body.length, 2);
  head.writeUInt32BE(COOKIE, 4);
  txn.copy(head, 8);
  return Buffer.concat([head, body]);
}
function xorAddr(ip, port) {
  const v = Buffer.alloc(8);
  v.writeUInt8(1, 1);
  v.writeUInt16BE(port ^ (COOKIE >>> 16), 2);
  ip.split(".").map(Number).forEach((o, i) => v.writeUInt8(o ^ ((COOKIE >>> (8 * (3 - i))) & 0xff), 4 + i));
  return v;
}
const errCode = (code, reason) => {
  const b = Buffer.alloc(4 + Buffer.byteLength(reason));
  b.writeUInt8(Math.floor(code / 100), 2);
  b.writeUInt8(code % 100, 3);
  b.write(reason, 4);
  return b;
};

/** attributes, plus where in the buffer each one's value started */
function readAttrs(buf) {
  const attrs = {}, at = {};
  let i = 20;
  const end = Math.min(20 + buf.readUInt16BE(2), buf.length);
  while (i + 4 <= end) {
    const type = buf.readUInt16BE(i), len = buf.readUInt16BE(i + 2);
    attrs[type] = buf.subarray(i + 4, i + 4 + len);
    at[type] = i;
    i += 4 + pad4(len);
  }
  return { attrs, at };
}

/**
 * Verify from the receiving end: cut the message off where the signature starts,
 * write the length the sender must have used (everything up to there, plus the
 * 24 bytes of the signature attribute itself), and digest that.
 */
function integrityOk(buf, at, attrs, secret) {
  const start = at[A.MESSAGE_INTEGRITY];
  if (start === undefined) return false;
  const username = attrs[A.USERNAME]?.toString() ?? "";
  const realm = attrs[A.REALM]?.toString() ?? "";
  const password = createHmac("sha1", secret).update(username).digest("base64");
  const key = createHash("md5").update(`${username}:${realm}:${password}`).digest();

  const signed = Buffer.from(buf.subarray(0, start));
  signed.writeUInt16BE(start - 20 + 24, 2);
  const expect = createHmac("sha1", key).update(signed).digest();
  return expect.equals(attrs[A.MESSAGE_INTEGRITY]);
}

/** @param {{secret?: string, relayIp?: string, denyPrivate?: boolean, deaf?: boolean, rejectAuth?: boolean}} opts */
function mockRelay(opts = {}) {
  const { secret = "s3cret", relayIp = "203.0.113.9", denyPrivate = true, deaf = false, rejectAuth = false } = opts;
  const sock = createSocket("udp4");
  sock.on("message", (buf, rinfo) => {
    if (buf.length < 20) return;
    const method = buf.readUInt16BE(0);
    const txn = buf.subarray(8, 20);
    const { attrs, at } = readAttrs(buf);
    const reply = (b) => sock.send(b, rinfo.port, rinfo.address);

    if (method === 0x0001) return reply(pack(0x0101, txn, [attr(A.XOR_MAPPED, xorAddr(rinfo.address, rinfo.port))]));
    if (deaf) return;                                    // answers STUN, is not a relay

    const signed = at[A.MESSAGE_INTEGRITY] !== undefined;
    const challenge = () => reply(pack(method | 0x0110, txn, [
      attr(A.ERROR_CODE, errCode(401, "Unauthorized")),
      attr(A.REALM, Buffer.from(REALM)),
      attr(A.NONCE, Buffer.from(NONCE)),
    ]));

    if (!signed) return challenge();
    if (rejectAuth || !integrityOk(buf, at, attrs, secret)) return challenge();

    if (method === 0x0003) {
      return reply(pack(0x0103, txn, [
        attr(A.XOR_RELAYED, xorAddr(relayIp, 49170)),
        attr(A.LIFETIME, Buffer.from([0, 0, 2, 88])),
      ]));
    }
    if (method === 0x0008) {
      const peer = attrs[A.XOR_PEER];
      const ip = peer ? [...peer.subarray(4, 8)].map((b, i) => b ^ ((COOKIE >>> (8 * (3 - i))) & 0xff)).join(".") : "";
      const priv = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
      if (denyPrivate && priv) return reply(pack(0x0118, txn, [attr(A.ERROR_CODE, errCode(403, "Forbidden IP"))]));
      return reply(pack(0x0108, txn, []));
    }
  });
  return new Promise((res) => sock.bind(0, "127.0.0.1", () => res({ port: sock.address().port, close: () => sock.close() })));
}

// ---- run the checker against it ---------------------------------------------

const run = (port, extra = []) =>
  new Promise((res) => {
    const p = spawn(process.execPath, [
      CHECKER,
      "--host=127.0.0.1", `--port=${port}`, "--secret=s3cret", "--timeout=1500", ...extra,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => res({ code, out }));
  });

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "  PASS" : "! FAIL"}  ${name}${extra ? "  " + extra : ""}`); };
const passed = (out, label) => out.includes(`  ok    ${label}`);
const failed = (out, label) => out.includes(`! FAIL  ${label}`);

console.log("\nturn-check against a mock relay\n");

{
  const relay = await mockRelay();
  const { code, out } = await run(relay.port);
  relay.close();
  ok("a healthy relay passes every check", code === 0, `exit ${code}`);
  ok("  · answers STUN", passed(out, "answers STUN"));
  ok("  · refuses an unsigned allocation", passed(out, "refuses an unauthenticated allocation"));
  ok("  · allocates with a minted credential", passed(out, "allocates a relay with a minted credential"));
  ok("  · the signature is accepted by an independent verifier", passed(out, "allocates a relay with a minted credential"));
  ok("  · relay address is public", passed(out, "relay address is reachable"));
  ok("  · private peers are refused", passed(out, "refuses to relay to a private address"));
}

{
  const relay = await mockRelay({ deaf: true });
  const { code, out } = await run(relay.port);
  relay.close();
  ok("a STUN-only server is caught", code === 1 && failed(out, "refuses an unauthenticated allocation"), `exit ${code}`);
  ok("  · and says so in words", out.includes("STUN-only"));
}

{
  const relay = await mockRelay({ rejectAuth: true });
  const { code, out } = await run(relay.port);
  relay.close();
  ok("a rejected credential is caught", code === 1 && failed(out, "allocates a relay"), `exit ${code}`);
  ok("  · and names the secret as the suspect", out.includes("TURN_SECRET"));
}

{
  const relay = await mockRelay({ relayIp: "10.1.2.3" });
  const { code, out } = await run(relay.port);
  relay.close();
  ok("a private relay address is caught", failed(out, "relay address is reachable"), `exit ${code}`);
  ok("  · and names the setting that fixes it", out.includes("TURN_EXTERNAL_IP"));
}

{
  const relay = await mockRelay({ denyPrivate: false });
  const { code, out } = await run(relay.port);
  relay.close();
  ok("an open relay into localhost is caught", code === 1 && failed(out, "refuses to relay to a private address"), `exit ${code}`);
  ok("  · and names the missing rules", out.includes("denied-peer-ip"));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
