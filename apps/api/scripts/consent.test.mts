/**
 * Asking, or telling — and the rules that do not change between them.
 *
 * A workspace that has settled the consent question elsewhere can set
 * RECORDING_CONSENT=notice: the room is told, and every microphone in it
 * records without a sheet in the way. What this file exists for is the part
 * that must survive that switch — `no` still means no, an unanswered sheet
 * still records nothing, and the notice still describes what the code does.
 *
 * Both modes are loaded in one run, which ESM will not do twice for the same
 * specifier: the query string on the second import is what makes it a separate
 * module rather than the cached first one.
 *
 *   npm run test:consent -w @nexspace/api
 */
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x = "") => {
  c ? pass++ : fail++;
  console.log(`${c ? "  PASS" : "! FAIL"}  ${n}${x ? "  " + x : ""}`);
};

console.log("\nasking, or telling\n");

// ---- asking, which is the default ----------------------------------------------
process.env.RECORDING_CONSENT = "";
const asking = await import("../src/recordings.js");

ok("with nothing set, each person is asked", asking.CONSENT_MODE === "ask", asking.CONSENT_MODE);
ok("  · a new track starts unanswered", asking.startingConsent() === "asked", asking.startingConsent());
ok("  · and an unanswered track records nothing", !asking.mayRecord("asked"));
ok("  · a yes records", asking.mayRecord("yes"));
ok("  · a no does not", !asking.mayRecord("no"));
ok("  · and the notice says which mode it is", asking.noticeFacts().mode === "ask", asking.noticeFacts().mode);
ok("  · offering to withdraw, which is a thing that was given",
  asking.noticeFacts().rights.includes("ถอนความยินยอม"), asking.noticeFacts().rights);

// ---- telling --------------------------------------------------------------------
process.env.RECORDING_CONSENT = "notice";
const telling = await import("../src/recordings.js?mode=notice");

ok("set to notice, the room is told", telling.CONSENT_MODE === "notice", telling.CONSENT_MODE);
ok("  · a new track records from the start", telling.startingConsent() === "auto", telling.startingConsent());
ok("  · which is a thing that may be recorded", telling.mayRecord("auto"));
ok("  · but a no is still a no", !telling.mayRecord("no"),
  "somebody who has taken their voice out does not get put back in by a setting");
ok("  · and an unanswered row still records nothing", !telling.mayRecord("asked"),
  "nothing about this mode should resurrect a row from the other one");
ok("  · the notice says so, so the browser can skip the sheet honestly",
  telling.noticeFacts().mode === "notice", telling.noticeFacts().mode);
ok("  · and it stops claiming a consent nobody gave",
  !telling.noticeFacts().rights.includes("ถอนความยินยอม")
  && telling.noticeFacts().rights.includes("ลบเสียง"),
  telling.noticeFacts().rights);

// ---- what neither mode changes ---------------------------------------------------
for (const [name, m] of [["ask", asking], ["notice", telling]] as const) {
  ok(`in ${name} mode, the notice still says only your own microphone is recorded`,
    m.noticeFacts().what.includes("ไมโครโฟนของคุณเท่านั้น"), m.noticeFacts().what);
  ok(`  · and still says nothing leaves the country`, m.noticeFacts().abroad === false);
  ok(`  · and the audio still expires before the text does`,
    m.AUDIO_KEEP_DAYS < m.TEXT_KEEP_DAYS, `${m.AUDIO_KEEP_DAYS} < ${m.TEXT_KEEP_DAYS}`);
}

// ---- anything else is asking ------------------------------------------------------
process.env.RECORDING_CONSENT = "NOTICE ";
const shouty = await import("../src/recordings.js?mode=shouty");
ok("the setting is read forgivingly", shouty.CONSENT_MODE === "notice", shouty.CONSENT_MODE);
process.env.RECORDING_CONSENT = "yes please";
const nonsense = await import("../src/recordings.js?mode=nonsense");
ok("  · and anything it does not understand asks rather than records",
  nonsense.CONSENT_MODE === "ask", nonsense.CONSENT_MODE);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
