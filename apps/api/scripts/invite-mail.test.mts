/**
 * What an invitation actually puts on the wire.
 *
 * The first invitation this deployment ever sent authenticated perfectly — SPF,
 * DKIM and DMARC all passed — and Gmail filed it as spam anyway, saying it
 * resembled mail that had been reported before. Nothing in DNS could answer
 * that; the shape of the message could. So these are assertions about the
 * request body, which is the part that was wrong:
 *
 *   - a button reading "join" over an opaque tokened href, with the destination
 *     shown nowhere, is the shape of every phishing mail ever sent
 *   - a no-reply address with no Reply-To gives the reader nobody to answer
 *
 * No network: fetch is replaced, so this runs anywhere, needs no dev server and
 * no API key, and cannot email a made-up address by accident.
 *
 *   npm run test:invitemail -w @nexspace/api
 */
process.env.RESEND_API_KEY = "test-key-not-real";
process.env.MAIL_FROM = "NexSpace <no-reply@mail.example.test>";

import { pathToFileURL } from "url";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

type Payload = {
  html: string; text: string; subject: string;
  reply_to?: string[]; from: string; to: string[];
};

let sent: Payload | null = null;
(globalThis as { fetch: unknown }).fetch = async (_url: string, init: { body: string }) => {
  sent = JSON.parse(init.body) as Payload;
  return { ok: true, status: 200, text: async () => "" };
};

const HERE = dirname(fileURLToPath(import.meta.url));
const { sendInvite } = await import(pathToFileURL(resolve(HERE, "../src/mailer.ts")).href);

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  PASS" : "! FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
const out = () => sent as Payload;

const LINK = "https://nexspace.example.test/?invite=abc123def456";

console.log("\nwhat an invitation puts on the wire\n");

await sendInvite({
  to: "them@example.test", space: "Test", invitedBy: "ชาลิสา ยศราวาส",
  invitedByEmail: "chalisa@company.test", link: LINK, days: 14,
});

ok("the reader can reply to a real person",
  JSON.stringify(out().reply_to) === '["chalisa@company.test"]', JSON.stringify(out().reply_to));
ok("the destination is not hidden behind the button",
  out().html.includes(`>${LINK}</a>`));
ok("  · which means the link appears twice: as a button and as itself",
  (out().html.match(/invite=abc123def456/g) || []).length >= 2,
  `${(out().html.match(/invite=abc123def456/g) || []).length} occurrences`);
ok("the inviter's address is on the face of it", out().html.includes("chalisa@company.test"));
ok("a footer says who sent this and why", out().html.includes("ส่งอัตโนมัติเพราะมีคนกรอกอีเมลนี้"));
ok("the plain-text part carries the link too", out().text.includes(LINK));
ok("  · and names the inviter with their address", out().text.includes("(chalisa@company.test)"));

// The address is optional — an older caller, or a user record without one.
sent = null;
await sendInvite({ to: "them@example.test", space: "Test", invitedBy: "somebody", link: LINK, days: 14 });
ok("with no inviter address there is no Reply-To at all",
  !("reply_to" in out()), JSON.stringify(out().reply_to));
ok("  · and no empty brackets left in the text", !out().text.includes("()"));
ok("  · but the visible link survives", out().html.includes(`>${LINK}</a>`));

// Both of these are typed by hand and both go into HTML.
sent = null;
await sendInvite({
  to: "them@example.test", space: "<img src=x onerror=alert(1)>", invitedBy: '"><script>bad()</script>',
  invitedByEmail: "a@b.test", link: LINK, days: 14,
});
ok("a space named like markup cannot become markup", !out().html.includes("<img src=x"));
ok("  · nor can the inviter's name", !out().html.includes("<script>"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
