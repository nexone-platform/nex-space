/**
 * Who may open which drawer.
 *
 * All of it pure, and separate from the routes on purpose. Access control is
 * the one part of a filing cabinet where being wrong is silent: nothing throws,
 * nobody is told, somebody simply reads a document that was not theirs — or
 * cannot find one that was. A function over plain values can be asked every
 * awkward question in a test without a server, a session or a database.
 *
 * The rule the space was asked for, in order:
 *
 *   1. An owner or an admin may read everything and file anything. Not a
 *      default that can be overridden — a grant saying otherwise is ignored,
 *      because the person who hands out access has to be able to see what they
 *      are handing out.
 *   2. A guest never has any. Cabinets are not part of what a visitor's pass
 *      opens, and there is no setting that makes them so.
 *   3. Otherwise the document decides, if it says anything: its own list of
 *      names first, then its own openTo.
 *   4. Otherwise the folder it is filed in decides, the same way.
 *   5. Otherwise the cabinet does.
 *
 * Each step is only reached because the one before it said nothing. That is
 * what "ทั้งตู้ แล้วยกเว้นรายเอกสารได้" means, with a drawer in between: the
 * cabinet is the setting, and a folder or a document is an exception only
 * where somebody wrote one.
 */

/** what somebody may do, from least to most */
export type Level = "none" | "read" | "file";

/** every level, weakest first — the order is the comparison */
export const LEVELS: Level[] = ["none", "read", "file"];

export const atLeast = (has: Level, want: Level) =>
  LEVELS.indexOf(has) >= LEVELS.indexOf(want);

/**
 * Who a cabinet, a folder or a document stands open to when no name is listed.
 *
 * `members` is everybody in the space who is not a guest. `listed` is nobody
 * but the names on it — which is what a cabinet of contracts wants, and why it
 * is a separate word rather than the absence of one: an empty list read as
 * "everyone" is the failure that hands the payroll to the floor.
 */
export type OpenTo = "members" | "listed";

export const OPEN_TO: OpenTo[] = ["members", "listed"];

export const isOpenTo = (v: unknown): v is OpenTo =>
  typeof v === "string" && (OPEN_TO as string[]).includes(v);

export const isLevel = (v: unknown): v is Level =>
  typeof v === "string" && (LEVELS as string[]).includes(v);

/** a role as Membership stores it */
export type Role = "owner" | "admin" | "member" | "guest";

export const runsTheSpace = (role: string) => role === "owner" || role === "admin";

export interface Grant { userId: string; level: Level }

export interface CabinetLike {
  openTo: string;
  grants: Grant[];
}

/**
 * A drawer inside the cabinet, and a document in it.
 *
 * Deliberately the same shape, because they answer exactly the same question
 * and there was no reason to invent a second one. null openTo means "whatever
 * the thing I am filed in says" — the ordinary case for both.
 */
export interface FolderLike {
  openTo: string | null;
  grants: Grant[];
}

export type DocLike = FolderLike;

const named = (grants: Grant[], userId: string): Level | null =>
  grants.find((g) => g.userId === userId)?.level ?? null;

const fromOpenTo = (openTo: string): Level => (openTo === "members" ? "read" : "none");

/** what this person may do with the cabinet itself */
export function levelForCabinet(
  cabinet: CabinetLike,
  who: { userId: string; role: string },
): Level {
  if (who.role === "guest") return "none";
  if (runsTheSpace(who.role)) return "file";
  return named(cabinet.grants, who.userId) ?? fromOpenTo(cabinet.openTo);
}

/**
 * What this person may do with one drawer of it.
 *
 * The same three steps as a document: a name on the folder, then the folder's
 * own setting, then whatever the cabinet says. A folder is a document-sized
 * exception that happens to contain things.
 */
export function levelForFolder(
  cabinet: CabinetLike,
  folder: FolderLike,
  who: { userId: string; role: string },
): Level {
  if (who.role === "guest") return "none";
  if (runsTheSpace(who.role)) return "file";

  const own = named(folder.grants, who.userId);
  if (own) return own;
  if (folder.openTo !== null) return fromOpenTo(folder.openTo);
  return levelForCabinet(cabinet, who);
}

/**
 * What this person may do with one document.
 *
 * The second argument is the drawer it is filed in, or null for one lying
 * loose in the cabinet.
 *
 * Note what is *not* here: a document's own setting is not capped by its
 * folder's or its cabinet's. Naming somebody on a single contract inside a
 * drawer they cannot otherwise open is a real thing to want, and the
 * alternative — a second cabinet holding one document — is worse for everybody.
 *
 * The listing is what keeps that honest: a cabinet nobody may open still shows
 * the documents inside it that they may, and nothing else.
 */
export function levelForDoc(
  cabinet: CabinetLike,
  folder: FolderLike | null,
  doc: DocLike,
  who: { userId: string; role: string },
): Level {
  if (who.role === "guest") return "none";
  if (runsTheSpace(who.role)) return "file";

  const own = named(doc.grants, who.userId);
  if (own) return own;
  if (doc.openTo !== null) return fromOpenTo(doc.openTo);
  return folder ? levelForFolder(cabinet, folder, who) : levelForCabinet(cabinet, who);
}

/**
 * Why somebody may see this, in one word, for showing back to them.
 *
 * A permission screen that only says yes or no is a permission screen nobody
 * trusts. This is the difference between "you are an admin", "you were named on
 * this document" and "the cabinet is open to the space" — answers that look
 * identical until the day one of them is wrong.
 */
export type Because = "runs-the-space" | "named-on-document" | "document-open"
  | "named-on-folder" | "folder-open"
  | "named-on-cabinet" | "cabinet-open" | "no";

/** the cabinet half of the answer, shared by a folder and a loose document */
function whyFromCabinet(cabinet: CabinetLike, who: { userId: string }): Because {
  const own = named(cabinet.grants, who.userId);
  if (own) return own === "none" ? "no" : "named-on-cabinet";
  return cabinet.openTo === "members" ? "cabinet-open" : "no";
}

export function whyForFolder(
  cabinet: CabinetLike,
  folder: FolderLike,
  who: { userId: string; role: string },
): Because {
  if (who.role === "guest") return "no";
  if (runsTheSpace(who.role)) return "runs-the-space";
  const own = named(folder.grants, who.userId);
  if (own) return own === "none" ? "no" : "named-on-folder";
  if (folder.openTo !== null) return folder.openTo === "members" ? "folder-open" : "no";
  return whyFromCabinet(cabinet, who);
}

export function whyForDoc(
  cabinet: CabinetLike,
  folder: FolderLike | null,
  doc: DocLike,
  who: { userId: string; role: string },
): Because {
  if (who.role === "guest") return "no";
  if (runsTheSpace(who.role)) return "runs-the-space";
  const own = named(doc.grants, who.userId);
  if (own) return own === "none" ? "no" : "named-on-document";
  if (doc.openTo !== null) return doc.openTo === "members" ? "document-open" : "no";
  return folder ? whyForFolder(cabinet, folder, who) : whyFromCabinet(cabinet, who);
}
