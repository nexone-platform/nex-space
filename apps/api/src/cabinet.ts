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
 *   4. Otherwise the cabinet decides the same way.
 *
 * A document that says nothing follows its cabinet. That is what "ทั้งตู้ แล้ว
 * ยกเว้นรายเอกสารได้" means: the cabinet is the setting, and a document is an
 * exception only where somebody wrote one.
 */

/** what somebody may do, from least to most */
export type Level = "none" | "read" | "file";

/** every level, weakest first — the order is the comparison */
export const LEVELS: Level[] = ["none", "read", "file"];

export const atLeast = (has: Level, want: Level) =>
  LEVELS.indexOf(has) >= LEVELS.indexOf(want);

/**
 * Who a cabinet or a document stands open to when no name is listed.
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

export interface DocLike {
  /** null means "whatever the cabinet says" — the ordinary case */
  openTo: string | null;
  grants: Grant[];
}

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
 * What this person may do with one document in it.
 *
 * Note what is *not* here: a document's own setting is not capped by the
 * cabinet's. Naming somebody on a single contract inside a cabinet they cannot
 * otherwise open is a real thing to want, and the alternative — a second
 * cabinet holding one document — is worse for everybody.
 *
 * The listing is what keeps that honest: a cabinet nobody may open still shows
 * the documents inside it that they may, and nothing else.
 */
export function levelForDoc(
  cabinet: CabinetLike,
  doc: DocLike,
  who: { userId: string; role: string },
): Level {
  if (who.role === "guest") return "none";
  if (runsTheSpace(who.role)) return "file";

  const own = named(doc.grants, who.userId);
  if (own) return own;
  if (doc.openTo !== null) return fromOpenTo(doc.openTo);
  return levelForCabinet(cabinet, who);
}

/**
 * Why somebody may see this, in one word, for showing back to them.
 *
 * A permission screen that only says yes or no is a permission screen nobody
 * trusts. This is the difference between "you are an admin", "you were named on
 * this document" and "the cabinet is open to the space" — three answers that
 * look identical until the day one of them is wrong.
 */
export type Because = "runs-the-space" | "named-on-document" | "document-open"
  | "named-on-cabinet" | "cabinet-open" | "no";

export function whyForDoc(
  cabinet: CabinetLike,
  doc: DocLike,
  who: { userId: string; role: string },
): Because {
  if (who.role === "guest") return "no";
  if (runsTheSpace(who.role)) return "runs-the-space";
  if (named(doc.grants, who.userId)) {
    return named(doc.grants, who.userId) === "none" ? "no" : "named-on-document";
  }
  if (doc.openTo !== null) return doc.openTo === "members" ? "document-open" : "no";
  if (named(cabinet.grants, who.userId)) {
    return named(cabinet.grants, who.userId) === "none" ? "no" : "named-on-cabinet";
  }
  return cabinet.openTo === "members" ? "cabinet-open" : "no";
}
