// Choosing a file out of your own Google Drive, using Google's own picker.
//
// Why the picker and not a listing of our own: `drive.readonly`, and even
// `drive.metadata.readonly`, are **restricted** scopes — Google requires a paid
// security assessment before an app using one may go past a hundred users.
// `drive.file` is non-sensitive and needs none of that, and it grants access to
// exactly the files somebody chose in Google's window and nothing else.
//
// That limitation is the feature here. A cabinet is a place people put a few
// documents on purpose; "let this app read my entire Drive" is a much larger
// thing to ask for the same result.
//
// Two scripts are fetched from Google, and only when somebody presses the
// button — never on page load. Nothing about this is needed to open a cabinet,
// read one, or paste a link into one.
import { API, authHeaders } from "./api";

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient(opts: {
            client_id: string; scope: string; prompt?: string;
            callback(r: { access_token?: string; expires_in?: number; error?: string }): void;
          }): { requestAccessToken(): void };
        };
      };
      picker?: unknown;
    };
    gapi?: {
      load(what: string, cb: () => void): void;
    };
  }
}

/** what the picker hands back, reduced to the parts a cabinet keeps */
export interface Picked {
  fileId: string;
  title: string;
  url: string;
  mime: string | null;
  /** file | folder — a Drive folder can go in a cabinet as an entry of its own */
  kind: "file" | "folder";
}

interface Config {
  available: boolean;
  key: string | null;
  clientId: string | null;
  scope: string;
}

let config: Config | null = null;

/**
 * Whether this deployment can offer the picker at all.
 *
 * Asked of the server rather than baked into the bundle: the key lives in .env
 * beside every other setting, and a value built into the bundle would need a
 * rebuild and a deploy to change.
 */
export async function pickerConfig(): Promise<Config> {
  if (config) return config;
  try {
    const r = await fetch(API + "/me/drive-picker", { headers: authHeaders() });
    config = (await r.json()) as Config;
  } catch {
    config = { available: false, key: null, clientId: null, scope: "" };
  }
  return config;
}

const loaded = new Map<string, Promise<void>>();

/** fetch a script once, and remember the attempt rather than the result */
function script(src: string): Promise<void> {
  const had = loaded.get(src);
  if (had) return had;
  const p = new Promise<void>((done, fail) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = () => done();
    // A blocked or offline Google is not an exception anybody needs to see as a
    // stack trace — the caller turns it into one sentence beside the button.
    el.onerror = () => fail(new Error(`could not load ${src}`));
    document.head.appendChild(el);
  });
  loaded.set(src, p);
  return p;
}

/**
 * An access token for this person's Drive.
 *
 * Kept in memory for this tab and never sent anywhere: the server stores no
 * Drive token at all, because it never reads or writes a file. NexSpace keeps
 * the name and the link; the document stays in the Drive its owner put it in,
 * under that Drive's own sharing.
 *
 * Held rather than asked for each time, with a minute shaved off the life
 * Google gives it so a call never goes out with one that expires on the way.
 * Without this, making a folder and then filing it would be two consent
 * windows for one action.
 */
let held: { token: string; until: number } | null = null;

function ask(cfg: Config): Promise<string> {
  return new Promise((done, fail) => {
    const oauth = window.google?.accounts?.oauth2;
    if (!oauth) { fail(new Error("Google sign-in did not load")); return; }
    const client = oauth.initTokenClient({
      client_id: cfg.clientId!,
      scope: cfg.scope,
      callback: (r) => {
        if (r.access_token) {
          held = { token: r.access_token, until: Date.now() + (Number(r.expires_in) || 3600) * 1000 - 60_000 };
          done(r.access_token);
        } else fail(new Error(r.error || "no access token"));
      },
    });
    client.requestAccessToken();
  });
}

/**
 * The token, for anything else that needs to reach this person's Drive.
 *
 * Loads Google's sign-in script if it is not there yet, so a caller that never
 * opened the picker still works.
 */
export async function driveToken(): Promise<string> {
  if (held && held.until > Date.now()) return held.token;
  const cfg = await pickerConfig();
  if (!cfg.available || !cfg.clientId) throw new Error("Google Drive is not configured");
  await script("https://accounts.google.com/gsi/client");
  return ask(cfg);
}

/**
 * Open Google's picker and resolve with what was chosen, or null if the person
 * closed it. Rejects only when something is actually broken.
 */
export async function pickFromDrive(): Promise<Picked | null> {
  const cfg = await pickerConfig();
  if (!cfg.available || !cfg.key || !cfg.clientId) {
    throw new Error("the Drive picker is not configured");
  }

  await Promise.all([
    script("https://accounts.google.com/gsi/client"),
    script("https://apis.google.com/js/api.js"),
  ]);
  const access = await driveToken();
  await new Promise<void>((done) => window.gapi!.load("picker", () => done()));

  const picker = (window.google as unknown as { picker: any }).picker;
  return new Promise<Picked | null>((done) => {
    // Folders are selectable as well as browsable: a cabinet entry can be a
    // whole Drive folder, which is often what somebody means by "put the
    // contracts in there".
    const view = new picker.DocsView(picker.ViewId.DOCS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true);
    const built = new picker.PickerBuilder()
      .setDeveloperKey(cfg.key!)
      .setOAuthToken(access)
      .addView(view)
      .setCallback((data: { action: string; docs?: Record<string, string>[] }) => {
        if (data.action === picker.Action.CANCEL) { done(null); return; }
        if (data.action !== picker.Action.PICKED) return;
        const d = data.docs?.[0];
        if (!d) { done(null); return; }
        const isFolder = d.mimeType === "application/vnd.google-apps.folder";
        done({
          kind: isFolder ? "folder" : "file",
          fileId: d.id,
          title: d.name || d.id,
          // The picker gives a viewer link; a Drive file id always has one, and
          // this is the only address that respects Drive's own sharing.
          url: d.url || `https://drive.google.com/open?id=${encodeURIComponent(d.id)}`,
          mime: d.mimeType || null,
        });
      })
      .build();
    built.setVisible(true);
  });
}
