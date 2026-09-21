/**
 * Who may open which drawer.
 *
 * Pure arithmetic over roles and lists, and the half of the feature where being
 * wrong leaves nothing behind: no error, no log line, just somebody reading a
 * contract that was not theirs. Every question worth asking is asked here,
 * including the ones that sound like they could not happen.
 *
 *   npm run test:cabinet -w @nexspace/api
 */
import {
  levelForCabinet, levelForDoc, whyForDoc, atLeast, isLevel, isOpenTo,
} from "../src/cabinet.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x = "") => {
  c ? pass++ : fail++;
  console.log(`${c ? "  PASS" : "! FAIL"}  ${n}${x ? "  " + x : ""}`);
};

const owner = { userId: "u_owner", role: "owner" };
const admin = { userId: "u_admin", role: "admin" };
const member = { userId: "u_member", role: "member" };
const other = { userId: "u_other", role: "member" };
const guest = { userId: "u_guest", role: "guest" };

const openCabinet = { openTo: "members", grants: [] };
const shutCabinet = { openTo: "listed", grants: [] };
/** a document that says nothing of its own — the ordinary case */
const plain = { openTo: null, grants: [] };

console.log("\nwho may open which drawer\n");

// ---- the space's own ---------------------------------------------------------------
{
  for (const boss of [owner, admin]) {
    ok(`an ${boss.role} may file in a cabinet shut to everyone`,
      levelForCabinet(shutCabinet, boss) === "file");
    ok(`  · and read a document shut to everyone`,
      levelForDoc(shutCabinet, { openTo: "listed", grants: [] }, boss) === "file");
  }
  /**
   * The one that has to hold however the lists are written. Somebody handing
   * out access cannot be locked out of the thing they are handing out — and a
   * grant of "none" against an admin is either a mistake or an attempt.
   */
  const spite = { openTo: "listed", grants: [{ userId: "u_admin", level: "none" as const }] };
  ok("an admin named as 'none' is still an admin", levelForCabinet(spite, admin) === "file",
    "the list does not outrank the role");
  ok("  · and is told plainly why they can see it",
    whyForDoc(spite, plain, admin) === "runs-the-space");
}

// ---- guests ------------------------------------------------------------------------
{
  ok("a guest gets nothing from a cabinet open to the space",
    levelForCabinet(openCabinet, guest) === "none");
  const invited = { openTo: "members", grants: [{ userId: "u_guest", level: "file" as const }] };
  ok("  · and nothing from being named on one", levelForCabinet(invited, guest) === "none",
    "a visitor's pass opens doors, not drawers");
  ok("  · with no explanation offered, because there is nothing to explain",
    whyForDoc(invited, plain, guest) === "no");
}

// ---- the cabinet, when the document says nothing ------------------------------------
{
  ok("a cabinet open to the space is open to a member",
    levelForCabinet(openCabinet, member) === "read");
  ok("  · to read, not to file in", !atLeast(levelForCabinet(openCabinet, member), "file"));
  ok("a cabinet open to nobody is shut to a member",
    levelForCabinet(shutCabinet, member) === "none");
  ok("  · and its documents with it", levelForDoc(shutCabinet, plain, member) === "none");
  ok("  · because the document said nothing and followed it",
    whyForDoc(shutCabinet, plain, member) === "no");

  const listed = { openTo: "listed", grants: [{ userId: "u_member", level: "read" as const }] };
  ok("a name on a shut cabinet opens it", levelForCabinet(listed, member) === "read");
  ok("  · for that person and not the one beside them",
    levelForCabinet(listed, other) === "none");
  ok("  · and says which of the two reasons it was",
    whyForDoc(listed, plain, member) === "named-on-cabinet"
    && whyForDoc(openCabinet, plain, member) === "cabinet-open");
}

// ---- the document's own word -------------------------------------------------------
{
  const shutDoc = { openTo: "listed", grants: [] };
  ok("one document can be shut inside an open cabinet",
    levelForDoc(openCabinet, shutDoc, member) === "none",
    "the payroll in the cabinet everybody uses");
  ok("  · while the cabinet around it stays open",
    levelForCabinet(openCabinet, member) === "read");

  /**
   * And the other way, which is the one people forget: naming somebody on a
   * single document in a cabinet they may not open. The alternative is a second
   * cabinet holding one file, which is worse for everybody.
   */
  const mineOnly = { openTo: null, grants: [{ userId: "u_member", level: "read" as const }] };
  ok("a name on one document reaches into a cabinet that is shut",
    levelForDoc(shutCabinet, mineOnly, member) === "read");
  ok("  · without opening the cabinet itself",
    levelForCabinet(shutCabinet, member) === "none",
    "they see that one document and no other");
  ok("  · and the reason given is the document, not the cabinet",
    whyForDoc(shutCabinet, mineOnly, member) === "named-on-document");

  const openDoc = { openTo: "members", grants: [] };
  ok("a document opened to the space does so inside a shut cabinet",
    levelForDoc(shutCabinet, openDoc, member) === "read");
  ok("  · said as the document's doing", whyForDoc(shutCabinet, openDoc, member) === "document-open");
}

// ---- a name beats the setting beside it ---------------------------------------------
{
  const barred = { openTo: null, grants: [{ userId: "u_member", level: "none" as const }] };
  ok("a name saying 'none' shuts a document inside an open cabinet",
    levelForDoc(openCabinet, barred, member) === "none",
    "one person left off one file");
  ok("  · and the others are unaffected", levelForDoc(openCabinet, barred, other) === "read");
  ok("  · with 'no' as the reason, not a reason that sounds like yes",
    whyForDoc(openCabinet, barred, member) === "no");

  const filer = { openTo: "listed", grants: [{ userId: "u_member", level: "file" as const }] };
  ok("somebody can be given filing rights without being an admin",
    levelForDoc(shutCabinet, filer, member) === "file");
  ok("  · which is more than read", atLeast("file", "read") && !atLeast("read", "file"));
}

// ---- the words themselves ----------------------------------------------------------
{
  ok("only the three levels are levels",
    isLevel("read") && isLevel("none") && isLevel("file")
    && !isLevel("write") && !isLevel("") && !isLevel(undefined));
  ok("only the two openTo words are openTo",
    isOpenTo("members") && isOpenTo("listed")
    && !isOpenTo("everyone") && !isOpenTo("public") && !isOpenTo(null),
    "'everyone' is the word that would have to mean guests too");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
