// Reaching this person's OneDrive, from the browser.
//
// The same shape as drivePicker/driveMake and deliberately a separate file:
// Microsoft and Google disagree about nearly everything that matters here —
// how a token is got, what a folder is called, how a file is uploaded, what a
// share link is — and a module that tried to say both would say each badly.
//
// No Microsoft library. The sign-in is the authorization-code flow with PKCE,
// written out, which is about sixty lines and costs the bundle nothing; MSAL is
// two hundred kilobytes to do the same thing. PKCE is what a public client uses
// instead of a secret: the code that comes back is worthless without the
// verifier this tab kept, and the verifier never leaves it.
//
// As with Drive, the server holds no OneDrive token and never reads a file.
// NexSpace keeps the name and the way back; the document stays in the OneDrive
// its owner put it in, under that OneDrive's own sharing.
import { API, authHeaders } from "./api";

const GRAPH = "https://graph.microsoft.com/v1.0";

interface Config {
  available: boolean;
  clientId: string | null;
  tenant: string;
  scope: string;
  redirectUri: string;
}

let config: Config | null = null;

export async function oneDriveConfig(): Promise<Config> {
  if (config) return config;
  try {
    const r = await fetch(API + "/me/onedrive", { headers: authHeaders() });
    config = (await r.json()) as Config;
  } catch {
    config = { available: false, clientId: null, tenant: "common", scope: "", redirectUri: "" };
  }
  return config;
}

// ---- signing in ------------------------------------------------------------------

const b64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const randomish = () => {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b64url(b.buffer);
};

let held: { token: string; until: number } | null = null;

/**
 * An access token for this person's OneDrive.
 *
 * Held for the tab with a minute shaved off the life Microsoft gives it, so a
 * call never goes out with one that expires on the way. Without this, making a
 * folder and then filing it would be two sign-in windows for one action.
 */
export async function oneDriveToken(): Promise<string> {
  if (held && held.until > Date.now()) return held.token;
  const cfg = await oneDriveConfig();
  if (!cfg.available || !cfg.clientId) throw new Error("OneDrive is not configured");

  const verifier = randomish();
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = randomish();

  const url = new URL(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/authorize`);
  for (const [k, v] of Object.entries({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: cfg.redirectUri,
    // The code comes back in the fragment, which no server ever sees.
    response_mode: "fragment",
    scope: cfg.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })) url.searchParams.set(k, v);

  const code = await throughAPopup(url.toString(), state);

  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
      code_verifier: verifier,
    }),
  });
  const said = await r.json().catch(() => ({}));
  if (!r.ok || !said.access_token) {
    throw new Error(said.error_description || said.error || `Microsoft answered ${r.status}`);
  }
  held = { token: said.access_token, until: Date.now() + (Number(said.expires_in) || 3600) * 1000 - 60_000 };
  return said.access_token;
}

/**
 * Open the sign-in window and wait for the code it sends back.
 *
 * Two things are checked before the code is believed: that the message came
 * from this origin, and that the state is the one this call generated. Without
 * the first, any page could post a code in; without the second, a code from
 * another attempt could be replayed into this one.
 */
function throughAPopup(url: string, state: string): Promise<string> {
  return new Promise((done, fail) => {
    const win = window.open(url, "nexspace-onedrive", "width=520,height=680");
    if (!win) { fail(new Error("the sign-in window was blocked")); return; }

    const watch = setInterval(() => {
      if (win.closed) { stop(); fail(new Error("the sign-in window was closed")); }
    }, 500);
    const stop = () => {
      clearInterval(watch);
      clearTimeout(giveUp);
      window.removeEventListener("message", hear);
    };
    const giveUp = setTimeout(() => {
      stop();
      try { win.close(); } catch { /* already gone */ }
      fail(new Error("signing in took too long"));
    }, 5 * 60_000);

    const hear = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const said = e.data as { nexspaceOneDrive?: boolean; code?: string; state?: string; error?: string };
      if (!said?.nexspaceOneDrive) return;
      if (said.state !== state) return;
      stop();
      if (said.code) done(said.code);
      else fail(new Error(said.error || "no code came back"));
    };
    window.addEventListener("message", hear);
  });
}

// ---- making things ---------------------------------------------------------------

export interface Made {
  fileId: string;
  title: string;
  url: string;
  mime: string;
  kind: "file" | "folder";
}

const asMade = (d: {
  id: string; name: string; webUrl?: string; folder?: unknown;
  file?: { mimeType?: string };
}): Made => ({
  fileId: d.id,
  title: d.name,
  mime: d.file?.mimeType || (d.folder ? "application/vnd.microsoft.folder" : "application/octet-stream"),
  kind: d.folder ? "folder" : "file",
  url: d.webUrl || `https://onedrive.live.com/?id=${encodeURIComponent(d.id)}`,
});

const inside = (parentId?: string | null) =>
  parentId ? `/me/drive/items/${encodeURIComponent(parentId)}` : "/me/drive/root";

/**
 * Make a folder.
 *
 * Only a folder. Graph has no way to create a blank Word or Excel document the
 * way Drive does — an empty file with the right extension is a file Office
 * refuses to open — so that part of the menu is Google's alone rather than a
 * button here that produces something broken.
 *
 * conflictBehavior: rename, because two people making "สัญญา" on the same day
 * should get two folders, not an error neither of them expected.
 */
export async function createFolderInOneDrive(name: string, parentId?: string | null): Promise<Made> {
  const token = await oneDriveToken();
  const r = await fetch(`${GRAPH}${inside(parentId)}/children`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "rename" }),
  });
  if (!r.ok) throw new Error(await graphSaid(r));
  return asMade(await r.json());
}

/**
 * Put a file from this computer into their OneDrive.
 *
 * A plain PUT to the content endpoint, which Graph takes up to 250 MB — far
 * past anything a cabinet holds, and two requests fewer than an upload session.
 * Drive needed the resumable dance; this one does not.
 */
export async function uploadToOneDrive(file: File, parentId?: string | null): Promise<Made> {
  const token = await oneDriveToken();
  const path = `${inside(parentId)}:/${encodeURIComponent(file.name)}:/content`;
  const r = await fetch(`${GRAPH}${path}?@microsoft.graph.conflictBehavior=rename`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": file.type || "application/octet-stream",
    },
    body: file,
  });
  if (!r.ok) throw new Error(await graphSaid(r));
  return asMade(await r.json());
}

/** a folder from this computer, kept as one folder and one row */
export async function uploadFolderToOneDrive(
  files: File[],
  name: string,
  say: (done: number, all: number) => void,
  parentId?: string | null,
): Promise<{ folder: Made; uploaded: number; failed: number }> {
  const folder = await createFolderInOneDrive(name, parentId);
  let uploaded = 0, failed = 0;
  for (const f of files) {
    say(uploaded + failed, files.length);
    try { await uploadToOneDrive(f, folder.fileId); uploaded++; } catch { failed++; }
  }
  say(files.length, files.length);
  return { folder, uploaded, failed };
}

/**
 * Let everyone with the link read it.
 *
 * Never done without somebody pressing something, the same as Drive. Microsoft
 * calls the audience "anonymous"; some tenants forbid it outright, and then
 * this says so rather than appearing to have worked.
 */
export async function shareOneDriveByLink(fileId: string): Promise<string> {
  const token = await oneDriveToken();
  const r = await fetch(`${GRAPH}/me/drive/items/${encodeURIComponent(fileId)}/createLink`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ type: "view", scope: "anonymous" }),
  });
  if (!r.ok) throw new Error(await graphSaid(r));
  const said = await r.json();
  return said?.link?.webUrl || "";
}

/** whether this person's OneDrive still has the folder a drawer points at */
export async function canReachInOneDrive(fileId: string): Promise<boolean> {
  const token = await oneDriveToken();
  const r = await fetch(`${GRAPH}/me/drive/items/${encodeURIComponent(fileId)}?$select=id`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return r.ok;
}

/** whatever Graph actually said, rather than "request failed" */
async function graphSaid(r: Response): Promise<string> {
  const body = await r.json().catch(() => null);
  const said = body?.error?.message;
  return said ? `OneDrive: ${said}` : `OneDrive answered ${r.status}`;
}
