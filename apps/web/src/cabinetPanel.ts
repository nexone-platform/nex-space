// The filing cabinet: what is inside, and who may open it.
//
// Opened by walking up to the cabinet in the room and pressing E, so the panel
// is built around a place rather than an id — the browser knows where the
// furniture stands and nothing else, and an id in a URL is an id somebody can
// try changing.
//
// Nothing here decides access. Every list the panel draws is the list the
// server sent, already filtered; the level and the reason come back with each
// row. A browser that filtered for itself would be a second copy of the rule,
// and the day the two disagreed it would be the wrong one that people saw.
import { API, authHeaders } from "./api";
import { t } from "./i18n";
import { pickerConfig, pickFromDrive } from "./drivePicker";
import { createInDrive, uploadToDrive, shareByLink, type DriveKind } from "./driveMake";

interface Doc {
  id: string;
  title: string;
  /** the provider's own id, for a file this app can still reach in Drive */
  fileId: string | null;
  /** file | folder — a Drive folder is an entry too, it just opens a folder */
  kind: string;
  /** the drawer it is filed in, or null for one lying loose in the cabinet */
  folderId: string | null;
  provider: string;
  url: string;
  mime: string | null;
  openTo: string | null;
  addedAt: string;
  addedBy: string | null;
  level: "none" | "read" | "file";
  why: string;
  mayManage: boolean;
}

interface Cab {
  id: string;
  label: string;
  openTo: string;
  at: { map: string; x: number; y: number };
  level: "none" | "read" | "file";
  mayManage: boolean;
}

interface Folder {
  id: string;
  name: string;
  openTo: string | null;
  level: "none" | "read" | "file";
  why: string;
  docs: number;
  mayManage: boolean;
}

interface Member { id: string; name: string; email: string; role: string }

/** why somebody can see a row, in words rather than a rule */
const WHY: Record<string, string> = {
  "runs-the-space": "คุณดูแล Space นี้",
  "named-on-document": "คุณถูกระบุชื่อบนเอกสารนี้",
  "document-open": "เอกสารนี้เปิดให้ทุกคนในทีม",
  "named-on-folder": "คุณถูกระบุชื่อบนโฟลเดอร์นี้",
  "folder-open": "โฟลเดอร์นี้เปิดให้ทุกคนในทีม",
  "named-on-cabinet": "คุณถูกระบุชื่อบนตู้นี้",
  "cabinet-open": "ตู้นี้เปิดให้ทุกคนในทีม",
};

const PROVIDER: Record<string, string> = {
  google: "Google Drive", microsoft: "OneDrive", link: "ลิงก์",
};

export interface CabinetPanel {
  open(map: string, x: number, y: number): void;
  close(): void;
}

export function setupCabinetPanel(slug: string): CabinetPanel {
  const modal = document.getElementById("cab-modal");
  if (!modal) return { open() {}, close() {} };

  const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T | null;

  let cab: Cab | null = null;
  let folders: Folder[] = [];
  /** which drawers are standing open, so a redraw does not shut them */
  const opened = new Set<string>();
  let docs: Doc[] = [];
  let members: Member[] = [];
  let where = { map: "", x: 0, y: 0 };

  const say = (text: string, bad = false) => {
    const el = $("cab-msg");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("err", bad);
  };

  const close = () => { modal.style.display = "none"; };

  const ask = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(API + path, {
      method, headers: authHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, ...data };
  };

  // ---- the cabinet itself ----------------------------------------------------------

  const load = async () => {
    say(t("กำลังเปิด…"));
    const got = await ask("GET", `/workspaces/${slug}/cabinets/at/${encodeURIComponent(where.map)}/${where.x}/${where.y}`);
    if (got.status === 404) {
      // The refusal a shut cabinet gives. Said the same way here as the server
      // says it, because "you may not" and "there is nothing here" are the same
      // sentence to somebody who was never meant to know which.
      cab = null; docs = []; folders = [];
      draw();
      say(t("ตู้นี้ไม่ได้เปิดให้คุณ"), true);
      return;
    }
    if (got.status !== 200) { say(t("เปิดตู้ไม่สำเร็จ"), true); return; }
    cab = got.cabinet; docs = got.docs ?? []; folders = got.folders ?? [];
    say("");
    draw();
    if (cab?.mayManage) void loadMembers();
  };

  const loadMembers = async () => {
    if (members.length) return;
    const got = await ask("GET", `/workspaces/${slug}/members`);
    members = (got.members ?? [])
      .map((m: { id: string; name?: string; email: string; role: string }) => ({
        id: m.id, name: m.name || m.email, email: m.email, role: m.role,
      }))
      .filter((m: Member) => m.role !== "guest");
  };

  // ---- drawing ---------------------------------------------------------------------

  const draw = () => {
    const title = $("cab-title");
    if (title) title.textContent = cab ? t(cab.label) : t("ตู้เก็บเอกสาร");

    const tools = $("cab-tools");
    if (tools) {
      tools.innerHTML = "";
      tools.hidden = !cab?.mayManage;
      if (cab?.mayManage) tools.append(renameBox(), openToBox(), grantsButton());
    }

    const list = $("cab-list");
    if (!list) return;
    list.innerHTML = "";
    if (!cab) return;

    if (!docs.length && !folders.length) {
      const none = document.createElement("p");
      none.className = "cab-none";
      none.textContent = cab.mayManage
        ? t("ยังไม่มีเอกสารในตู้นี้")
        : t("ยังไม่มีเอกสารที่คุณเปิดได้ในตู้นี้");
      list.appendChild(none);
    }

    /**
     * Drawers first, each holding its own, then whatever is lying loose.
     *
     * A drawer somebody cannot open still appears when it holds one document
     * that is theirs — the server sends it for exactly that reason, and hiding
     * it here would leave that document with nowhere to be shown.
     */
    for (const f of folders) {
      list.appendChild(folderRow(f));
      if (!opened.has(f.id)) continue;
      const inside = docs.filter((d) => d.folderId === f.id);
      if (!inside.length) {
        const none = document.createElement("p");
        none.className = "cab-none cab-in";
        none.textContent = t("โฟลเดอร์นี้ว่าง");
        list.appendChild(none);
      }
      for (const d of inside) {
        const row = docRow(d);
        row.classList.add("cab-in");
        list.appendChild(row);
      }
    }
    for (const d of docs.filter((x) => !x.folderId)) list.appendChild(docRow(d));

    const mayFile = cab.level === "file" || folders.some((f) => f.level === "file");
    const adder = $("cab-add");
    if (adder) adder.hidden = !mayFile;
    const ways = $("cab-add-ways");
    if (ways) ways.hidden = !mayFile || !$("cab-pick") || $("cab-pick")!.hidden;
    const newFolder = $("cab-newfolder");
    // Making a drawer is filing into the cabinet itself, not into a drawer.
    if (newFolder) newFolder.hidden = cab.level !== "file";
    const make = $("cab-make-row");
    if (make) make.hidden = !mayFile || !$("cab-make") || !$("cab-make")!.childNodes.length;
    drawFolderChoice();
  };

  /** the drawers this person may actually put something into */
  const drawFolderChoice = () => {
    const sel = $<HTMLSelectElement>("cab-add-folder");
    if (!sel) return;
    const was = sel.value;
    sel.innerHTML = "";
    const loose = document.createElement("option");
    loose.value = "";
    loose.textContent = t("ไม่อยู่ในโฟลเดอร์");
    sel.appendChild(loose);
    for (const f of folders) {
      if (f.level !== "file") continue;
      const o = document.createElement("option");
      o.value = f.id;
      o.textContent = f.name;
      sel.appendChild(o);
    }
    sel.value = was;
    // Only worth showing when there is somewhere else to put it.
    sel.hidden = sel.options.length < 2 || cab?.level !== "file";
    if (sel.hidden && cab?.level === "file") sel.hidden = sel.options.length < 2;
  };

  const folderRow = (f: Folder) => {
    const row = document.createElement("div");
    row.className = "cab-folder";

    const toggle = document.createElement("button");
    toggle.className = "cab-open";
    toggle.textContent = opened.has(f.id) ? "▾" : "▸";
    toggle.onclick = () => {
      opened.has(f.id) ? opened.delete(f.id) : opened.add(f.id);
      draw();
    };

    const name = document.createElement("b");
    name.className = "cab-folder-name";
    name.textContent = f.name;

    const meta = document.createElement("small");
    meta.className = "cab-doc-meta";
    const bits = [t("{n} รายการ").replace("{n}", String(f.docs))];
    if (WHY[f.why]) bits.push(t(WHY[f.why]));
    meta.textContent = bits.join(" · ");

    const left = document.createElement("div");
    left.className = "cab-doc-t";
    left.append(name, meta);
    row.append(toggle, left);

    if (f.openTo === "listed") {
      const shut = document.createElement("i");
      shut.className = "cab-tag";
      shut.textContent = t("เฉพาะที่ระบุชื่อ");
      row.appendChild(shut);
    }

    if (cab?.mayManage) {
      const who = document.createElement("button");
      who.className = "cab-mini";
      who.textContent = t("สิทธิ์เข้าถึง");
      who.onclick = () => openFolderGrants(f);
      row.appendChild(who);

      const rename = document.createElement("button");
      rename.className = "cab-mini";
      rename.textContent = t("เปลี่ยนชื่อ");
      rename.onclick = async () => {
        const next = prompt(t("ชื่อโฟลเดอร์"), f.name);
        if (next === null) return;
        const said = await ask("PATCH", `/workspaces/${slug}/cabinets/${cab!.id}/folders/${f.id}`,
          { name: next });
        if (said.status !== 200) { say(t("เปลี่ยนชื่อไม่สำเร็จ"), true); return; }
        void load();
      };
      row.appendChild(rename);

      const out = document.createElement("button");
      out.className = "cab-mini danger";
      out.textContent = t("ลบโฟลเดอร์");
      out.onclick = async () => {
        const said = await ask("DELETE", `/workspaces/${slug}/cabinets/${cab!.id}/folders/${f.id}`);
        if (said.status !== 200) { say(t("ลบโฟลเดอร์ไม่สำเร็จ"), true); return; }
        // Said out loud, because "delete" beside a folder full of contracts is
        // the word people are most afraid of here.
        say(t("ลบโฟลเดอร์แล้ว — เอกสาร {n} รายการกลับไปอยู่ในตู้")
          .replace("{n}", String(said.loosened ?? 0)));
        opened.delete(f.id);
        void load();
      };
      row.appendChild(out);
    }
    return row;
  };

  const docRow = (d: Doc) => {
    const row = document.createElement("div");
    row.className = "cab-doc";

    const a = document.createElement("a");
    a.className = "cab-doc-name";
    a.href = d.url;
    a.target = "_blank";
    // A link to somewhere else in a list anybody can add to: no referrer, and
    // no handle on this window from the page that opens.
    a.rel = "noopener noreferrer";
    a.textContent = d.title;

    const meta = document.createElement("small");
    meta.className = "cab-doc-meta";
    const bits = [t(d.kind === "folder" ? "โฟลเดอร์" : (PROVIDER[d.provider] ?? d.provider))];
    if (d.addedBy) bits.push(t("โดย {name}").replace("{name}", d.addedBy));
    if (WHY[d.why]) bits.push(t(WHY[d.why]));
    meta.textContent = bits.join(" · ");

    const left = document.createElement("div");
    left.className = "cab-doc-t";
    left.append(a, meta);
    row.appendChild(left);

    if (d.openTo === "listed") {
      const shut = document.createElement("i");
      shut.className = "cab-tag";
      shut.textContent = t("เฉพาะที่ระบุชื่อ");
      row.appendChild(shut);
    }

    if (cab?.mayManage) {
      const who = document.createElement("button");
      who.className = "cab-mini";
      who.textContent = t("สิทธิ์เข้าถึง");
      who.onclick = () => openGrants(d);
      row.appendChild(who);
    }
    if (d.mayManage) {
      const out = document.createElement("button");
      out.className = "cab-mini danger";
      out.textContent = t("นำออก");
      out.onclick = async () => {
        const said = await ask("DELETE", `/workspaces/${slug}/cabinets/${cab!.id}/docs/${d.id}`);
        if (said.status !== 200) { say(t("นำออกไม่สำเร็จ"), true); return; }
        docs = docs.filter((x) => x.id !== d.id);
        countShift(d.folderId, -1);
        draw();
      };
      row.appendChild(out);
    }
    return row;
  };

  const renameBox = () => {
    const wrap = document.createElement("label");
    wrap.className = "cab-field";
    const b = document.createElement("b");
    b.textContent = t("ชื่อตู้");
    const input = document.createElement("input");
    input.type = "text";
    input.value = cab!.label;
    input.maxLength = 60;
    input.onchange = async () => {
      const said = await ask("PATCH", `/workspaces/${slug}/cabinets/${cab!.id}`,
        { label: input.value });
      if (said.status !== 200) { say(t("เปลี่ยนชื่อไม่สำเร็จ"), true); return; }
      cab!.label = said.cabinet.label;
      draw();
      say(t("บันทึกแล้ว"));
    };
    wrap.append(b, input);
    return wrap;
  };

  const openToBox = () => {
    const wrap = document.createElement("label");
    wrap.className = "cab-field";
    const b = document.createElement("b");
    b.textContent = t("ใครเปิดตู้นี้ได้");
    const sel = document.createElement("select");
    for (const [value, label] of [
      ["members", t("ทุกคนในทีม")],
      ["listed", t("เฉพาะคนที่ระบุชื่อ")],
    ] as const) {
      const o = document.createElement("option");
      o.value = value; o.textContent = label;
      sel.appendChild(o);
    }
    sel.value = cab!.openTo;
    sel.onchange = async () => {
      const said = await ask("PATCH", `/workspaces/${slug}/cabinets/${cab!.id}`,
        { openTo: sel.value });
      if (said.status !== 200) { say(t("เปลี่ยนไม่สำเร็จ"), true); return; }
      cab!.openTo = said.cabinet.openTo;
      say(t("บันทึกแล้ว"));
      void load();
    };
    wrap.append(b, sel);
    return wrap;
  };

  const grantsButton = () => {
    const b = document.createElement("button");
    b.className = "cab-mini";
    b.textContent = t("รายชื่อที่เปิดตู้ได้");
    b.onclick = () => openGrants(null);
    return b;
  };

  // ---- the access list -------------------------------------------------------------

  /**
   * One editor for both, because they are the same question asked about
   * different things — and a second screen that looked almost the same would be
   * the one where the rule quietly differed.
   *
   * `doc` null means the cabinet.
   */
  /**
   * The same editor, pointed at a drawer.
   *
   * Written as a wrapper rather than a third copy: a folder answers the same
   * question as a cabinet and a document, and a screen that looked almost the
   * same would be the one where the rule quietly differed.
   */
  const openFolderGrants = (f: Folder) => openGrants(null, f);

  const openGrants = async (doc: Doc | null, folder: Folder | null = null) => {
    await loadMembers();
    const box = $("cab-grants");
    const body = $("cab-grants-body");
    const head = $("cab-grants-title");
    if (!box || !body || !head) return;

    head.textContent = doc
      ? t("ใครเปิดเอกสารนี้ได้ — {name}").replace("{name}", doc.title)
      : folder
        ? t("ใครเปิดโฟลเดอร์นี้ได้ — {name}").replace("{name}", folder.name)
        : t("ใครเปิดตู้นี้ได้");

    const path = doc
      ? `/workspaces/${slug}/cabinets/${cab!.id}/docs/${doc.id}/grants`
      : folder
        ? `/workspaces/${slug}/cabinets/${cab!.id}/folders/${folder.id}/grants`
        : `/workspaces/${slug}/cabinets/${cab!.id}/grants`;

    const current = new Map<string, string>();
    if (!doc) {
      const got = await ask("GET", path);
      for (const g of got.grants ?? []) current.set(g.userId, g.level);
    }

    body.innerHTML = "";

    if (doc || folder) {
      const wrap = document.createElement("label");
      wrap.className = "cab-field";
      const b = document.createElement("b");
      b.textContent = doc ? t("เอกสารนี้") : t("โฟลเดอร์นี้");
      const sel = document.createElement("select");
      for (const [value, label] of [
        ["", t("ตามการตั้งค่าของตู้")],
        ["members", t("เปิดให้ทุกคนในทีม")],
        ["listed", t("เฉพาะคนที่ระบุชื่อ")],
      ] as const) {
        const o = document.createElement("option");
        o.value = value; o.textContent = label;
        sel.appendChild(o);
      }
      sel.value = (doc ? doc.openTo : folder!.openTo) ?? "";
      sel.onchange = async () => {
        const where = doc
          ? `/workspaces/${slug}/cabinets/${cab!.id}/docs/${doc.id}`
          : `/workspaces/${slug}/cabinets/${cab!.id}/folders/${folder!.id}`;
        const said = await ask("PATCH", where,
          { openTo: sel.value === "" ? null : sel.value });
        if (said.status !== 200) { say(t("เปลี่ยนไม่สำเร็จ"), true); return; }
        void load();
      };
      wrap.append(b, sel);
      body.appendChild(wrap);
    }

    /**
     * Everybody in the space, each with a level — rather than a search box that
     * adds one name at a time. A list of who has access is the thing being
     * decided, and it should be readable in one look; "who else can see this"
     * is not a question anybody should have to assemble from a search.
     */
    for (const m of members) {
      const row = document.createElement("div");
      row.className = "cab-grant";
      const who = document.createElement("span");
      who.textContent = m.name;
      const sel = document.createElement("select");
      for (const [value, label] of [
        ["", t("ตามค่าเริ่มต้น")],
        ["read", t("เปิดอ่านได้")],
        ["file", t("อ่านและเพิ่มเอกสารได้")],
        ["none", t("ไม่ให้เข้าถึง")],
      ] as const) {
        const o = document.createElement("option");
        o.value = value; o.textContent = label;
        sel.appendChild(o);
      }
      sel.value = current.get(m.id) ?? "";
      sel.dataset.user = m.id;
      if (m.role === "owner" || m.role === "admin") {
        // Saying so beats letting somebody set a level that will be ignored.
        sel.disabled = true;
        const note = document.createElement("i");
        note.className = "cab-tag";
        note.textContent = t("ดูแล Space — เห็นทุกอย่างเสมอ");
        row.append(who, note);
        body.appendChild(row);
        continue;
      }
      row.append(who, sel);
      body.appendChild(row);
    }

    const save = $("cab-grants-save");
    if (save) {
      save.onclick = async () => {
        const grants: { userId: string; level: string }[] = [];
        body.querySelectorAll<HTMLSelectElement>("select[data-user]").forEach((s) => {
          if (s.value) grants.push({ userId: s.dataset.user!, level: s.value });
        });
        const said = await ask("PUT", path, { grants });
        if (said.status !== 200) {
          say(said.error ? String(said.error) : t("บันทึกสิทธิ์ไม่สำเร็จ"), true);
          return;
        }
        box.style.display = "none";
        say(t("บันทึกแล้ว"));
        void load();
      };
    }
    box.style.display = "grid";
  };

  // ---- putting one in --------------------------------------------------------------

  /**
   * The button that opens Google's own picker.
   *
   * Shown only where it can work — a deployment with no key gets the paste-a-link
   * field alone, and no button that fails when pressed. Everything the picker
   * returns is posted to the same route a pasted link goes through, so there is
   * one way in and one set of checks on it.
   */
  const wirePicker = async () => {
    const button = $<HTMLButtonElement>("cab-pick");
    if (!button) return;
    const cfg = await pickerConfig();
    button.hidden = !cfg.available;
    const or = $("cab-or");
    if (or) or.hidden = !cfg.available;
    const ways = $("cab-add-ways");
    if (ways && cfg.available && cab?.level === "file") ways.hidden = false;
    if (!cfg.available) return;
    button.onclick = async () => {
      button.disabled = true;
      say(t("กำลังเปิด Google Drive…"));
      try {
        const picked = await pickFromDrive();
        if (!picked) { say(""); return; }
        const said = await ask("POST", `/workspaces/${slug}/cabinets/${cab!.id}/docs`, {
          title: picked.title, url: picked.url, provider: "google",
          fileId: picked.fileId, mime: picked.mime, kind: picked.kind,
          folderId: chosenFolder(),
        });
        if (said.status !== 201) {
          say(said.error ? String(said.error) : t("เพิ่มเอกสารไม่สำเร็จ"), true);
          return;
        }
        // Whatever was half-typed in the paste fields is gone: the document is
        // in, and leaving the other way in loaded invites pressing its button.
        $<HTMLInputElement>("cab-add-title")!.value = "";
        $<HTMLInputElement>("cab-add-url")!.value = "";
        docs.unshift(said.doc);
        countShift(said.doc.folderId, 1);
        draw();
        say(t("เพิ่มแล้ว"));
      } catch (e) {
        // Google blocked, offline, or the person closed the consent window.
        // One sentence beside the button; the paste field still works.
        say(t("เปิด Google Drive ไม่ได้ — วางลิงก์แทนได้"), true);
        console.warn("[picker]", e);
      } finally {
        button.disabled = false;
      }
    };
  };

  /**
   * Drive's own "New" menu, as far as this scope reaches.
   *
   * Uploading a whole folder is deliberately not here: the browser can hand
   * over a directory, but every file in it would be a separate upload and a
   * separate row, and a cabinet entry per holiday photo is not what anybody
   * means by it. A folder is made, and files go in it.
   */
  const MAKE: { kind: DriveKind; label: string }[] = [
    { kind: "folder", label: "โฟลเดอร์ใหม่ใน Drive" },
    { kind: "document", label: "Google เอกสาร" },
    { kind: "spreadsheet", label: "Google ชีต" },
    { kind: "presentation", label: "Google สไลด์" },
  ];

  /**
   * Keep a drawer's count honest without a round trip.
   *
   * The number beside a folder comes from the server, so filing into one left
   * it reading "0 รายการ" beside the document that had just gone in — which
   * looks like the filing not having worked.
   */
  const countShift = (folderId: string | null, by: number) => {
    if (!folderId) return;
    const f = folders.find((x) => x.id === folderId);
    if (f) f.docs = Math.max(0, f.docs + by);
  };

  /** which drawer the next document goes into, or null for loose in the cabinet */
  const chosenFolder = () => {
    const sel = $<HTMLSelectElement>("cab-add-folder");
    return sel && !sel.hidden && sel.value ? sel.value : null;
  };

  /**
   * File something that was just made in Drive, and offer to let the team read
   * it.
   *
   * A file made here belongs to the person who made it and starts private,
   * which is the right default — but a document in a shared cabinet that only
   * its author can open is half a thing. So the offer is a button they press,
   * never something done on their behalf, and Drive can take it back.
   */
  const fileWhatWasMade = async (made: {
    fileId: string; title: string; url: string; mime: string; kind: "file" | "folder";
  }) => {
    const said = await ask("POST", `/workspaces/${slug}/cabinets/${cab!.id}/docs`, {
      title: made.title, url: made.url, provider: "google",
      fileId: made.fileId, mime: made.mime, kind: made.kind,
      folderId: chosenFolder(),
    });
    if (said.status !== 201) {
      say(said.error ? String(said.error) : t("เพิ่มเอกสารไม่สำเร็จ"), true);
      return;
    }
    docs.unshift(said.doc);
    countShift(said.doc.folderId, 1);
    draw();

    const msg = $("cab-msg");
    if (!msg) return;
    msg.textContent = t("สร้างแล้ว — ตอนนี้เปิดได้เฉพาะคุณ");
    msg.classList.remove("err");
    const share = document.createElement("button");
    share.className = "cab-mini";
    share.style.marginInlineStart = "8px";
    share.textContent = t("ให้คนที่มีลิงก์เปิดได้");
    share.onclick = async () => {
      share.disabled = true;
      try {
        await shareByLink(made.fileId);
        say(t("แชร์แล้ว — คนที่มีลิงก์เปิดอ่านได้"));
      } catch (e) {
        say(t("แชร์ไม่สำเร็จ — เปิดใน Drive แล้วแชร์เองได้"), true);
        console.warn("[drive]", e);
      }
    };
    msg.appendChild(share);
  };

  const wireMake = async () => {
    const menu = $<HTMLSelectElement>("cab-make");
    const upload = $<HTMLInputElement>("cab-upload");
    const uploadButton = $<HTMLButtonElement>("cab-upload-go");
    if (!menu || !upload || !uploadButton) return;
    const cfg = await pickerConfig();
    if (!cfg.available) return;

    if (!menu.options.length) {
      const head = document.createElement("option");
      head.value = "";
      head.textContent = t("＋ สร้างใน Google Drive");
      menu.appendChild(head);
      for (const m of MAKE) {
        const o = document.createElement("option");
        o.value = m.kind;
        o.textContent = t(m.label);
        menu.appendChild(o);
      }
    }
    menu.onchange = async () => {
      const kind = menu.value as DriveKind;
      menu.value = "";
      if (!kind) return;
      const name = prompt(t("ตั้งชื่อ"), "");
      if (name === null) return;
      if (!name.trim()) { say(t("ต้องมีชื่อ"), true); return; }
      say(t("กำลังสร้างใน Google Drive…"));
      try {
        await fileWhatWasMade(await createInDrive(kind, name.trim(), driveParent()));
      } catch (e) {
        say(t("สร้างใน Google Drive ไม่สำเร็จ"), true);
        console.warn("[drive]", e);
      }
    };

    uploadButton.onclick = () => upload.click();
    upload.onchange = async () => {
      const file = upload.files?.[0];
      upload.value = "";
      if (!file) return;
      say(t("กำลังอัปโหลดขึ้น Google Drive…"));
      try {
        await fileWhatWasMade(await uploadToDrive(file, driveParent()));
      } catch (e) {
        say(t("อัปโหลดไม่สำเร็จ"), true);
        console.warn("[drive]", e);
      }
    };
  };

  /**
   * Where in Drive a new thing goes.
   *
   * If the drawer chosen in the form is one whose entries are a Drive folder we
   * already have access to, the new file goes inside that folder — which is
   * what somebody picking it expects. Otherwise it lands at the top of their
   * Drive, because a parent this app has never touched is not addressable under
   * drive.file, and quietly putting it somewhere else would be worse than
   * putting it somewhere obvious.
   */
  const driveParent = (): string | null => {
    const into = chosenFolder();
    if (!into) return null;
    const holder = docs.find((d) =>
      d.folderId === into && d.kind === "folder" && d.provider === "google" && !!d.fileId);
    return holder?.fileId ?? null;
  };

  const wireNewFolder = () => {
    const button = $<HTMLButtonElement>("cab-newfolder");
    if (!button) return;
    button.onclick = async () => {
      const name = prompt(t("ชื่อโฟลเดอร์"), "");
      if (name === null) return;
      if (!name.trim()) { say(t("โฟลเดอร์ต้องมีชื่อ"), true); return; }
      const said = await ask("POST", `/workspaces/${slug}/cabinets/${cab!.id}/folders`,
        { name });
      if (said.status !== 201) {
        say(said.error ? String(said.error) : t("สร้างโฟลเดอร์ไม่สำเร็จ"), true);
        return;
      }
      opened.add(said.folder.id);
      say(t("สร้างโฟลเดอร์แล้ว"));
      void load();
    };
  };

  const wireAdder = () => {
    const form = $<HTMLFormElement>("cab-add");
    if (!form) return;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const title = $<HTMLInputElement>("cab-add-title")!.value.trim();
      const url = $<HTMLInputElement>("cab-add-url")!.value.trim();
      // Said one at a time, and about the field that is actually empty. "Put in
      // a name and a link" next to a filled-in name is a sentence that reads as
      // the app not having noticed.
      if (!title) { say(t("ใส่ชื่อของเอกสาร"), true); return; }
      if (!url) { say(t("ใส่ลิงก์ของเอกสาร"), true); return; }
      const said = await ask("POST", `/workspaces/${slug}/cabinets/${cab!.id}/docs`,
        { title, url, provider: guessProvider(url), folderId: chosenFolder() });
      if (said.status !== 201) {
        say(said.error ? String(said.error) : t("เพิ่มเอกสารไม่สำเร็จ"), true);
        return;
      }
      $<HTMLInputElement>("cab-add-title")!.value = "";
      $<HTMLInputElement>("cab-add-url")!.value = "";
      docs.unshift(said.doc);
      countShift(said.doc.folderId, 1);
      draw();
      say(t("เพิ่มแล้ว"));
    };
  };

  /**
   * Which service a pasted link belongs to, from the link itself.
   *
   * A label, not a permission: it decides the word shown beside the row and
   * nothing else. Getting it wrong shows "ลิงก์" next to a Drive file, which is
   * a cosmetic mistake — so this stays a guess and never a claim about access.
   */
  const guessProvider = (url: string) => {
    let host = "";
    try { host = new URL(url).hostname.toLowerCase(); } catch { return "link"; }
    if (host.endsWith("google.com") || host.endsWith("googleusercontent.com")) return "google";
    if (host.endsWith("sharepoint.com") || host.endsWith("onedrive.live.com")
      || host.endsWith("live.com") || host.endsWith("office.com")) return "microsoft";
    return "link";
  };

  // ---- wiring ----------------------------------------------------------------------

  $("cab-close")?.addEventListener("click", close);
  $("cab-grants-close")?.addEventListener("click", () => {
    const box = $("cab-grants");
    if (box) box.style.display = "none";
  });
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  wireAdder();
  wireNewFolder();
  void wirePicker();
  void wireMake();

  return {
    open(map, x, y) {
      where = { map, x, y };
      cab = null; docs = [];
      draw();
      modal.style.display = "grid";
      void load();
    },
    close,
  };
}
