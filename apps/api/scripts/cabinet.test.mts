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
  levelForCabinet, levelForFolder, levelForDoc, whyForDoc, whyForFolder,
  atLeast, isLevel, isOpenTo, isCabinetOpenTo,
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
      levelForDoc(shutCabinet, null, { openTo: "listed", grants: [] }, boss) === "file");
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
    whyForDoc(spite, null, plain, admin) === "runs-the-space");
}

// ---- guests ------------------------------------------------------------------------
{
  ok("a guest gets nothing from a cabinet open to the space",
    levelForCabinet(openCabinet, guest) === "none");
  const invited = { openTo: "members", grants: [{ userId: "u_guest", level: "file" as const }] };
  ok("  · and nothing from being named on one", levelForCabinet(invited, guest) === "none",
    "a visitor's pass opens doors, not drawers");
  ok("  · with no explanation offered, because there is nothing to explain",
    whyForDoc(invited, null, plain, guest) === "no");
}

// ---- the cabinet, when the document says nothing ------------------------------------
{
  ok("a cabinet open to the space is open to a member",
    levelForCabinet(openCabinet, member) === "read");
  ok("  · to read, not to file in", !atLeast(levelForCabinet(openCabinet, member), "file"));
  ok("a cabinet open to nobody is shut to a member",
    levelForCabinet(shutCabinet, member) === "none");
  ok("  · and its documents with it", levelForDoc(shutCabinet, null, plain, member) === "none");
  ok("  · because the document said nothing and followed it",
    whyForDoc(shutCabinet, null, plain, member) === "no");

  const listed = { openTo: "listed", grants: [{ userId: "u_member", level: "read" as const }] };
  ok("a name on a shut cabinet opens it", levelForCabinet(listed, member) === "read");
  ok("  · for that person and not the one beside them",
    levelForCabinet(listed, other) === "none");
  ok("  · and says which of the two reasons it was",
    whyForDoc(listed, null, plain, member) === "named-on-cabinet"
    && whyForDoc(openCabinet, null, plain, member) === "cabinet-open");
}

// ---- the document's own word -------------------------------------------------------
{
  const shutDoc = { openTo: "listed", grants: [] };
  ok("one document can be shut inside an open cabinet",
    levelForDoc(openCabinet, null, shutDoc, member) === "none",
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
    levelForDoc(shutCabinet, null, mineOnly, member) === "read");
  ok("  · without opening the cabinet itself",
    levelForCabinet(shutCabinet, member) === "none",
    "they see that one document and no other");
  ok("  · and the reason given is the document, not the cabinet",
    whyForDoc(shutCabinet, null, mineOnly, member) === "named-on-document");

  const openDoc = { openTo: "members", grants: [] };
  ok("a document opened to the space does so inside a shut cabinet",
    levelForDoc(shutCabinet, null, openDoc, member) === "read");
  ok("  · said as the document's doing", whyForDoc(shutCabinet, null, openDoc, member) === "document-open");
}

// ---- a name beats the setting beside it ---------------------------------------------
{
  const barred = { openTo: null, grants: [{ userId: "u_member", level: "none" as const }] };
  ok("a name saying 'none' shuts a document inside an open cabinet",
    levelForDoc(openCabinet, null, barred, member) === "none",
    "one person left off one file");
  ok("  · and the others are unaffected", levelForDoc(openCabinet, null, barred, other) === "read");
  ok("  · with 'no' as the reason, not a reason that sounds like yes",
    whyForDoc(openCabinet, null, barred, member) === "no");

  const filer = { openTo: "listed", grants: [{ userId: "u_member", level: "file" as const }] };
  ok("somebody can be given filing rights without being an admin",
    levelForDoc(shutCabinet, null, filer, member) === "file");
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

// ---- the drawer in between ----------------------------------------------------------
{
  const plainFolder = { openTo: null, grants: [] };
  const shutFolder = { openTo: "listed", grants: [] };
  const openFolder = { openTo: "members", grants: [] };

  ok("a folder that says nothing follows its cabinet",
    levelForFolder(openCabinet, plainFolder, member) === "read"
    && levelForFolder(shutCabinet, plainFolder, member) === "none");
  ok("  · and so does a document that says nothing, through it",
    levelForDoc(openCabinet, plainFolder, plain, member) === "read"
    && levelForDoc(shutCabinet, plainFolder, plain, member) === "none");

  /**
   * The drawer everybody was actually asking for: one folder of contracts
   * inside a cabinet the whole space uses.
   */
  ok("a folder can be shut inside an open cabinet",
    levelForFolder(openCabinet, shutFolder, member) === "none");
  ok("  · taking the documents in it with it",
    levelForDoc(openCabinet, shutFolder, plain, member) === "none",
    "they said nothing, so the folder spoke for them");
  ok("  · while a document lying loose in the same cabinet is still open",
    levelForDoc(openCabinet, null, plain, member) === "read");
  ok("  · and the reason names the folder, not the cabinet",
    whyForDoc(openCabinet, shutFolder, plain, member) === "no"
    && whyForFolder(openCabinet, shutFolder, member) === "no");

  ok("a folder can be opened inside a shut cabinet",
    levelForFolder(shutCabinet, openFolder, member) === "read");
  ok("  · said as the folder doing it",
    whyForFolder(shutCabinet, openFolder, member) === "folder-open"
    && whyForDoc(shutCabinet, openFolder, plain, member) === "folder-open");

  const mine = { openTo: "listed", grants: [{ userId: "u_member", level: "file" as const }] };
  ok("a name on a folder opens it and everything in it",
    levelForFolder(shutCabinet, mine, member) === "file"
    && levelForDoc(shutCabinet, mine, plain, member) === "file");
  ok("  · for that person and not the one beside them",
    levelForFolder(shutCabinet, mine, other) === "none");
  ok("  · named as the folder, which is where they would go to change it",
    whyForDoc(shutCabinet, mine, plain, member) === "named-on-folder");

  /**
   * And the step that makes the order matter: one document inside a drawer
   * that is shut to somebody, opened to them by name. Without the document
   * being asked first, this is unreachable.
   */
  const oneOfThem = { openTo: null, grants: [{ userId: "u_member", level: "read" as const }] };
  ok("one document reaches out of a folder that is shut",
    levelForDoc(openCabinet, shutFolder, oneOfThem, member) === "read");
  ok("  · without opening the folder around it",
    levelForFolder(openCabinet, shutFolder, member) === "none",
    "they see that one document and no other in the drawer");
  ok("  · and the other way: one document shut inside an open folder",
    levelForDoc(shutCabinet, openFolder, { openTo: "listed", grants: [] }, member) === "none");

  ok("an admin opens a folder shut to everyone",
    levelForFolder(shutCabinet, shutFolder, admin) === "file"
    && whyForFolder(shutCabinet, shutFolder, admin) === "runs-the-space");
  ok("  · and a guest opens none of it, however the drawer is written",
    levelForFolder(openCabinet, openFolder, guest) === "none"
    && whyForFolder(openCabinet, openFolder, guest) === "no");
}

// ---- only me -------------------------------------------------------------------------
{
  const mine = { openTo: "private", grants: [], ownerId: "u_member" };
  const theirs = { openTo: "private", grants: [], ownerId: "u_other" };

  ok("a private drawer is open to whoever made it",
    levelForFolder(openCabinet, mine, member) === "file",
    "read and file — a private drawer nobody can put anything in is a locked empty box");
  ok("  · and shut to everybody else in the space",
    levelForFolder(openCabinet, theirs, member) === "none");
  ok("  · inside a cabinet that is open to all of them",
    levelForCabinet(openCabinet, member) === "read");
  ok("  · with its documents following it",
    levelForDoc(openCabinet, theirs, plain, member) === "none"
    && levelForDoc(openCabinet, mine, plain, member) === "file");

  ok("a private document is the same, one document wide",
    levelForDoc(openCabinet, null, mine, member) === "file"
    && levelForDoc(openCabinet, null, theirs, member) === "none");

  /**
   * The exception that makes "only me" a half-truth, and the reason the panel
   * says so where the word is chosen. Somebody handing out access has to be
   * able to see what they are handing out; that was true before this setting
   * existed and is not quietly changed by it.
   */
  ok("whoever runs the space still sees a private drawer",
    levelForFolder(openCabinet, theirs, admin) === "file"
    && levelForFolder(openCabinet, theirs, owner) === "file",
    "said out loud in the panel rather than hidden behind the word");
  ok("  · and is told it is the role, not the drawer",
    whyForFolder(openCabinet, theirs, admin) === "runs-the-space");

  ok("the person it belongs to is told it is theirs",
    whyForFolder(openCabinet, mine, member) === "yours"
    && whyForDoc(openCabinet, null, mine, member) === "yours");
  ok("  · and everybody else is told nothing at all",
    whyForFolder(openCabinet, theirs, member) === "no"
    && whyForDoc(openCabinet, theirs, plain, member) === "no");

  ok("a guest gets nothing from one, even if the ids somehow lined up",
    levelForFolder(openCabinet, { openTo: "private", grants: [], ownerId: "u_guest" }, guest)
      === "none");

  /**
   * A row with nobody recorded against it — written before this setting
   * existed, or by somebody since removed from the space. It must not become
   * readable by whoever asks; "nobody made it" is not "everybody owns it".
   */
  const orphan = { openTo: "private", grants: [], ownerId: null };
  ok("a private thing with nobody recorded belongs to nobody",
    levelForFolder(openCabinet, orphan, member) === "none"
    && levelForFolder(openCabinet, orphan, other) === "none");

  const named = { openTo: "private", grants: [{ userId: "u_other", level: "read" as const }], ownerId: "u_member" };
  ok("a name on a private drawer still beats the setting",
    levelForFolder(shutCabinet, named, other) === "read",
    "the list is asked first, whatever the setting says");
  ok("  · and the person it belongs to keeps it",
    levelForFolder(shutCabinet, named, member) === "file");

  ok("private is a word the system knows, and 'me' is not",
    isOpenTo("private") && !isOpenTo("me") && !isOpenTo("owner"));
  ok("  · but a cabinet will not take it", isCabinetOpenTo("members")
    && isCabinetOpenTo("listed") && !isCabinetOpenTo("private"),
    "a cabinet is made by whoever walked up to it first, which is nobody's decision");
}


console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
