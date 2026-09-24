// Making something new in your own Google Drive, from inside the cabinet.
//
// The same scope the picker uses, and the reason it is enough: `drive.file`
// grants an app access to the files it *creates* as well as the ones somebody
// picks. Everything made here is therefore ours to name, move and link to —
// and nothing else in that Drive is, which is exactly the boundary wanted.
//
// All of it happens in the browser with a token that lives only as long as the
// tab. The server never holds a Drive token, because it never reads or writes
// a file: NexSpace keeps the name and the way back, and the document belongs to
// the person who made it, in their Drive, under their sharing.
import { driveToken } from "./drivePicker";

const FILES = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

/** what Drive calls the kinds of thing its "New" menu makes */
export const DRIVE_KINDS = {
  folder: "application/vnd.google-apps.folder",
  document: "application/vnd.google-apps.document",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
  presentation: "application/vnd.google-apps.presentation",
  form: "application/vnd.google-apps.form",
} as const;

export type DriveKind = keyof typeof DRIVE_KINDS;

export interface Made {
  fileId: string;
  title: string;
  url: string;
  mime: string;
  /** file | folder, in the cabinet's words rather than Drive's */
  kind: "file" | "folder";
}

const asMade = (d: { id: string; name: string; mimeType: string; webViewLink?: string }): Made => ({
  fileId: d.id,
  title: d.name,
  mime: d.mimeType,
  kind: d.mimeType === DRIVE_KINDS.folder ? "folder" : "file",
  // webViewLink is what Drive itself links to, and the only address that
  // respects that file's own sharing. The fallback is the same page by id.
  url: d.webViewLink || `https://drive.google.com/open?id=${encodeURIComponent(d.id)}`,
});

/**
 * Make an empty document, sheet, deck or folder.
 *
 * `parentId` is a folder this app already has access to — one somebody picked,
 * or one made here. Left out, it lands at the top of their Drive. A parent we
 * have never touched is not addressable under this scope, which is the point of
 * the scope and not a gap in this function.
 */
export async function createInDrive(
  kind: DriveKind,
  name: string,
  parentId?: string | null,
): Promise<Made> {
  const token = await driveToken();
  const r = await fetch(`${FILES}?fields=id,name,mimeType,webViewLink&supportsAllDrives=true`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: DRIVE_KINDS[kind],
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  });
  if (!r.ok) throw new Error(await drivesSaid(r));
  return asMade(await r.json());
}

/**
 * Put a file from this computer into their Drive.
 *
 * Resumable rather than multipart, for one reason: multipart is documented for
 * small payloads and a cabinet is where people put the forty-megabyte scan of a
 * signed contract. Resumable is two requests instead of one and has no such
 * ceiling — the session URL comes back in a header, the bytes go to it.
 */
export async function uploadToDrive(file: File, parentId?: string | null): Promise<Made> {
  const token = await driveToken();
  const start = await fetch(`${UPLOAD}?uploadType=resumable&supportsAllDrives=true`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-upload-content-type": file.type || "application/octet-stream",
      "x-upload-content-length": String(file.size),
    },
    body: JSON.stringify({ name: file.name, ...(parentId ? { parents: [parentId] } : {}) }),
  });
  if (!start.ok) throw new Error(await drivesSaid(start));
  const session = start.headers.get("location");
  if (!session) throw new Error("Drive did not give an upload address");

  const put = await fetch(session, {
    method: "PUT",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!put.ok) throw new Error(await drivesSaid(put));
  const made = await put.json();

  // The upload answers with the bare file; ask for the link separately rather
  // than guessing it, because a guessed URL that happens to work today is a
  // link that breaks silently later.
  const r = await fetch(`${FILES}/${encodeURIComponent(made.id)}?fields=id,name,mimeType,webViewLink`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(await drivesSaid(r));
  return asMade(await r.json());
}

/**
 * Let everyone with the link read it.
 *
 * Never done on somebody's behalf without them pressing something. A file made
 * here belongs to the person who made it and starts private, which is the right
 * default — but a document in a shared cabinet that only its author can open is
 * half a thing, so the offer is there, in one press, and reversible in Drive.
 */
export async function shareByLink(fileId: string): Promise<void> {
  const token = await driveToken();
  const r = await fetch(`${FILES}/${encodeURIComponent(fileId)}/permissions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });
  if (!r.ok) throw new Error(await drivesSaid(r));
}

/** whatever Drive actually said, rather than "request failed" */
async function drivesSaid(r: Response): Promise<string> {
  const body = await r.json().catch(() => null);
  const said = body?.error?.message;
  return said ? `Drive: ${said}` : `Drive answered ${r.status}`;
}
