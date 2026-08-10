// End-to-end test of the authenticator flow against a running API.
//
//   npm run dev -w apps/api      # in one terminal
//   npm run test:totp -w apps/api
//
// It creates a throwaway account and walks enrolment, sign-in, replay refusal,
// recovery codes, lockout, clock drift and disabling. Takes ~90s because some
// assertions genuinely have to wait for the next 30s TOTP step.
import { generate } from "otplib";

// TOTP moves in 30s steps. Replay protection rejects any step already spent, so
// the tests have to wait for a genuinely new one rather than reuse a code.
const stepNow = () => Math.floor(Date.now() / 30000);
const codeForStep = (secret, step) => generate({ secret, epoch: step * 30 }); // otplib epoch is seconds
async function waitForStep(target) {
  if (stepNow() < target) process.stdout.write(`  … waiting for 30s step ${target}`);
  while (stepNow() < target) {
    await new Promise((r) => setTimeout(r, 1000));
    process.stdout.write(".");
  }
  if (process.stdout.columns) console.log("");
}

const API = "http://localhost:3001";
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  PASS" : "! FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

async function call(method, path, body, token) {
  const r = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, body: j ?? {} };
}

const email = `totp-${Date.now()}@test.local`;
const PW = "hunter2pw";
console.log(`account: ${email}\n`);

// ---- 1. plain account, no 2FA yet ----
const reg = await call("POST", "/auth/register", { email, name: "TOTP Tester", password: PW });
ok("register returns a usable token", reg.status === 200 && !!reg.body.token);
ok("new account reports totpEnabled=false", reg.body.user?.totpEnabled === false);
let token = reg.body.token;

const login0 = await call("POST", "/auth/login", { email, password: PW });
ok("login without 2FA hands over a session directly", !!login0.body.token && !login0.body.totpRequired);

// ---- 2. enrolment ----
const setup = await call("POST", "/me/totp/setup", {}, token);
ok("setup returns a base32 secret", /^[A-Z2-7]{32}$/.test(setup.body.secret || ""), setup.body.secret);
ok("setup returns an otpauth URI", (setup.body.uri || "").startsWith("otpauth://totp/NexSpace:"));
ok("setup returns an inline QR image", (setup.body.qr || "").startsWith("data:image/png;base64,"));
const secret = setup.body.secret;

ok("2FA is not active until confirmed",
  (await call("GET", "/me", undefined, token)).body.user?.totpEnabled === false);

const badEnable = await call("POST", "/me/totp/enable", { code: "000000" }, token);
ok("enable rejects a wrong code", badEnable.status === 401);

const enrolStep = stepNow();
const enrolCode = await codeForStep(secret, enrolStep);
const enable = await call("POST", "/me/totp/enable", { code: enrolCode }, token);
ok("enable accepts a real code", enable.status === 200 && enable.body.ok === true);
ok("enable returns 8 recovery codes", enable.body.recoveryCodes?.length === 8);
ok("recovery codes look like xxxxx-xxxxx",
  (enable.body.recoveryCodes || []).every((c) => /^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/.test(c)),
  enable.body.recoveryCodes?.[0]);
ok("/me now reports 2FA on with 8 codes left",
  enable.body.user?.totpEnabled === true && enable.body.user?.recoveryLeft === 8);
const recovery = [...enable.body.recoveryCodes];

ok("the old session keeps working (no forced re-login)",
  (await call("GET", "/me", undefined, token)).status === 200);

// ---- 3. login now needs the second factor ----
// the code just spent on enrolment must not double as a sign-in
const early = await call("POST", "/auth/login", { email, password: PW });
const enrolReplay = await call("POST", "/auth/totp/verify", { token: early.body.pendingToken, code: enrolCode });
ok("the enrolment code cannot be reused to sign in",
  enrolReplay.status === 401 && enrolReplay.body.reused === true, JSON.stringify(enrolReplay.body));

await waitForStep(enrolStep + 1);
const login1 = await call("POST", "/auth/login", { email, password: PW });
ok("password login returns totpRequired", login1.body.totpRequired === true && !!login1.body.pendingToken);
ok("no profile data leaks before the second factor", login1.body.user === undefined);
const pending = login1.body.pendingToken;

ok("a pending token authorises nothing",
  (await call("GET", "/me", undefined, pending)).status === 401);
ok("a pending token cannot save an avatar",
  (await call("PUT", "/me/avatar", { skin: 1 }, pending)).status === 401);

const wrong = await call("POST", "/auth/totp/verify", { token: pending, code: "123456" });
ok("verify rejects a wrong code and counts down", wrong.status === 401 && wrong.body.attemptsLeft === 4);

const code1 = await codeForStep(secret, stepNow());
const v1 = await call("POST", "/auth/totp/verify", { token: pending, code: code1 });
ok("verify accepts the app code", v1.status === 200 && v1.body.token === pending);
ok("the promoted token works everywhere",
  (await call("GET", "/me", undefined, v1.body.token)).status === 200);
ok("verify reports it was not a recovery code", v1.body.usedRecoveryCode === false);

// ---- 4. replay protection ----
const login2 = await call("POST", "/auth/login", { email, password: PW });
const replay = await call("POST", "/auth/totp/verify", { token: login2.body.pendingToken, code: code1 });
ok("the same code cannot be replayed", replay.status === 401 && replay.body.reused === true,
  JSON.stringify(replay.body));

// ---- 5. recovery code as the way back in ----
const rc = recovery[0];
const v2 = await call("POST", "/auth/totp/verify", { token: login2.body.pendingToken, code: rc });
ok("a recovery code signs in", v2.status === 200 && !!v2.body.token, rc);
ok("verify flags the recovery code path", v2.body.usedRecoveryCode === true);
ok("one code is spent, 7 left", v2.body.user?.recoveryLeft === 7);

const login3 = await call("POST", "/auth/login", { email, password: PW });
const reuse = await call("POST", "/auth/totp/verify", { token: login3.body.pendingToken, code: rc });
ok("a spent recovery code is dead", reuse.status === 401);
ok("formatting of recovery codes is forgiving",
  (await call("POST", "/auth/totp/verify",
    { token: login3.body.pendingToken, code: ` ${recovery[1].toUpperCase().replace("-", "")} ` })).status === 200);

// ---- 6. brute-force lockout ----
const login4 = await call("POST", "/auth/login", { email, password: PW });
const pt = login4.body.pendingToken;
let last;
for (let i = 0; i < 5; i++) last = await call("POST", "/auth/totp/verify", { token: pt, code: "000000" });
ok("the 5th wrong code leaves 0 attempts", last.body.attemptsLeft === 0);
const locked = await call("POST", "/auth/totp/verify", { token: pt, code: await generate({ secret }) });
ok("a locked-out pending token is thrown away, even for a right code", locked.status === 429,
  JSON.stringify(locked.body));

// ---- 7. clock drift ----
// A phone a few seconds behind shows the previous step's code. That is accepted,
// as long as the step is still newer than the last one spent — the two rules
// (±1 step tolerance, never reuse a spent step) have to coexist.
await waitForStep(stepNow() + 2);
const drift = await call("POST", "/auth/login", { email, password: PW });
const behind = await codeForStep(secret, stepNow() - 1);
const dv = await call("POST", "/auth/totp/verify", { token: drift.body.pendingToken, code: behind });
ok("a code from the previous 30s step is accepted (slow phone clock)",
  dv.status === 200, `code=${behind} -> ${dv.status} ${JSON.stringify(dv.body.error ?? "")}`);

const ahead = await call("POST", "/auth/login", { email, password: PW });
const av = await call("POST", "/auth/totp/verify",
  { token: ahead.body.pendingToken, code: await codeForStep(secret, stepNow() + 1) });
ok("a code from the next 30s step is accepted (fast phone clock)", av.status === 200);

const tooOld = await call("POST", "/auth/login", { email, password: PW });
const ov = await call("POST", "/auth/totp/verify",
  { token: tooOld.body.pendingToken, code: await codeForStep(secret, stepNow() - 4) });
ok("a code from four steps ago is refused", ov.status === 401);

// ---- 8. turning it off ----
const session = av.status === 200 ? av.body.token : v2.body.token;
ok("disable refuses a wrong code",
  (await call("POST", "/me/totp/disable", { code: "111111" }, session)).status === 401);

const regen = await call("POST", "/me/totp/recovery", { code: recovery[2] }, session);
ok("recovery codes can be reissued", regen.status === 200 && regen.body.recoveryCodes?.length === 8);
ok("reissuing resets the count to 8", regen.body.user?.recoveryLeft === 8);
ok("the previous batch stops working",
  (await call("POST", "/me/totp/disable", { code: recovery[3] }, session)).status === 401);

const off = await call("POST", "/me/totp/disable", { code: regen.body.recoveryCodes[0] }, session);
ok("disable accepts a current recovery code", off.status === 200 && off.body.user?.totpEnabled === false);
const after = await call("POST", "/auth/login", { email, password: PW });
ok("login goes back to one step", !!after.body.token && !after.body.totpRequired);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
