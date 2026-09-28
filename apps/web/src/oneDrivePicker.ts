// Choosing a file out of OneDrive, in Microsoft's own picker.
//
// A page hosted by Microsoft, opened in a popup by POSTing a form to it, that
// then talks back over a MessageChannel. Nothing like Google's picker, which is
// a script you call a builder on — so this is its own file, following the
// documented v8 flow step for step.
//
// Two things about it are worth knowing before reading:
//
//   · It wants a token for *itself*, not for Graph. The audience is the
//     OneDrive or SharePoint host the picker is served from, so the Graph token
//     the rest of this app uses cannot be reused here. That is why the sign-in
//     below takes a resource.
//   · A picked item comes back as ids only — no name, no link. Those are
//     fetched afterwards from the endpoint the picker names.
import { oneDriveConfig, signInForOneDrive, oneDriveToken } from "./oneDrive";

export interface PickedFromOneDrive {
  fileId: string;
  title: string;
  url: string;
  mime: string;
  kind: "file" | "folder";
}

/**
 * Where this person's picker lives, and which resource its token is for.
 *
 * A work account's picker is served from their own SharePoint host; a personal
 * one from onedrive.live.com. Rather than guess from the tenant setting — which
 * is "common" and so says nothing — this asks Graph where their drive actually
 * is and reads the answer.
 */
async function whereIsTheirPicker(): Promise<{ baseUrl: string; resource: string }> {
  const token = await oneDriveToken();
  const r = await fetch("https://graph.microsoft.com/v1.0/me/drive?$select=webUrl", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("could not find your OneDrive");
  const webUrl = String((await r.json())?.webUrl || "");
  const host = (() => { try { return new URL(webUrl).origin; } catch { return ""; } })();

  // A personal account's drive is on onedrive.live.com, and its picker has its
  // own address rather than being a page on that host.
  if (!host || /onedrive\.live\.com|1drv\.ms/.test(host)) {
    return { baseUrl: "https://onedrive.live.com/picker", resource: "https://onedrive.live.com" };
  }
  return { baseUrl: host, resource: host };
}

/**
 * Open the picker and resolve with what was chosen — an empty list if it was
 * closed. Rejects only when something is actually broken.
 */
export async function pickFromOneDrive(): Promise<PickedFromOneDrive[]> {
  const cfg = await oneDriveConfig();
  if (!cfg.available) throw new Error("OneDrive is not configured");

  const { baseUrl, resource } = await whereIsTheirPicker();
  const channelId = crypto.randomUUID();

  // Opened before anything is awaited: a popup opened later is a popup the
  // browser blocks, because it is no longer inside the click that asked for it.
  const win = window.open("", "nexspace-onedrive-picker", "width=1080,height=680");
  if (!win) throw new Error("the picker window was blocked");

  try {
    const token = await signInForOneDrive(resource);
    const options = {
      sdk: "8.0",
      entry: { oneDrive: {} },
      // Empty but present: without it the picker returns ids and nothing else,
      // and will not run in an iframe at all.
      authentication: {},
      messaging: { origin: window.location.origin, channelId },
      typesAndSources: { mode: "all", pivots: { oneDrive: true, recent: true } },
      selection: { mode: "multiple" },
    };
    const url = `${baseUrl}/_layouts/15/FilePicker.aspx?`
      + new URLSearchParams({ filePicker: JSON.stringify(options), locale: "th-th" });

    const form = win.document.createElement("form");
    form.setAttribute("action", url);
    form.setAttribute("method", "POST");
    const field = win.document.createElement("input");
    field.setAttribute("type", "hidden");
    field.setAttribute("name", "access_token");
    field.setAttribute("value", token);
    form.appendChild(field);
    win.document.body.append(form);
    form.submit();

    return await listen(win, channelId, resource);
  } catch (e) {
    try { win.close(); } catch { /* already gone */ }
    throw e;
  }
}

/** the conversation with the picker, from "initialize" to "pick" or "close" */
function listen(win: Window, channelId: string, resource: string): Promise<PickedFromOneDrive[]> {
  return new Promise((done, fail) => {
    let port: MessagePort | null = null;

    const stop = () => {
      clearInterval(watch);
      window.removeEventListener("message", hello);
      try { port?.close(); } catch { /* never opened */ }
    };
    const finish = (out: PickedFromOneDrive[]) => {
      stop();
      try { win.close(); } catch { /* already gone */ }
      done(out);
    };
    const watch = setInterval(() => {
      if (win.closed) { stop(); done([]); }
    }, 500);

    const hello = (e: MessageEvent) => {
      if (e.source !== win) return;
      const said = e.data;
      if (said?.type !== "initialize" || said.channelId !== channelId) return;
      port = e.ports[0];
      port.addEventListener("message", talk);
      port.start();
      port.postMessage({ type: "activate" });
    };

    const talk = async (e: MessageEvent) => {
      const payload = e.data;
      if (payload?.type !== "command") return;
      // Every command is acknowledged, whether or not it is one we know.
      port!.postMessage({ type: "acknowledge", id: payload.id });
      const command = payload.data;

      const answer = (data: unknown) => port!.postMessage({ type: "result", id: payload.id, data });
      const refuse = (code: string, message: string) =>
        answer({ result: "error", error: { code, message } });

      switch (command?.command) {
        case "authenticate":
          try {
            answer({ result: "token", token: await signInForOneDrive(command.resource || resource) });
          } catch (err) {
            refuse("unableToObtainToken", (err as Error).message);
          }
          return;
        case "close":
          answer({ result: "success" });
          finish([]);
          return;
        case "pick":
          try {
            const picked = await describe(command.items ?? []);
            answer({ result: "success" });
            finish(picked);
          } catch (err) {
            refuse("unusableItem", (err as Error).message);
          }
          return;
        default:
          refuse("unsupportedCommand", String(command?.command ?? "unknown"));
      }
    };

    window.addEventListener("message", hello);
    setTimeout(() => { if (!port) { stop(); try { win.close(); } catch { /* gone */ } fail(new Error("the picker did not start")); } }, 60_000);
  });
}

/**
 * Turn what the picker returns into something a cabinet can hold.
 *
 * It hands back ids and an endpoint and nothing else — no name, no link — so
 * each one is fetched. Written as one request per item rather than a batch
 * because a picker selection is a handful of files, and a failure that names
 * the file it happened on is worth more than one round trip saved.
 */
async function describe(items: {
  id: string;
  parentReference?: { driveId?: string };
  "@sharePoint.endpoint"?: string;
}[]): Promise<PickedFromOneDrive[]> {
  const out: PickedFromOneDrive[] = [];
  for (const it of items) {
    const endpoint = it["@sharePoint.endpoint"];
    const driveId = it.parentReference?.driveId;
    if (!endpoint || !driveId) continue;
    const token = await signInForOneDrive(new URL(endpoint).origin);
    const r = await fetch(`${endpoint}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(it.id)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`could not read "${it.id}" back`);
    const d = await r.json();
    out.push({
      fileId: d.id,
      title: d.name,
      url: d.webUrl || "",
      mime: d.file?.mimeType || (d.folder ? "application/vnd.microsoft.folder" : "application/octet-stream"),
      kind: d.folder ? "folder" : "file",
    });
  }
  return out;
}
